/**
 * In-memory store of detected sourcemaps, keyed by tabId.
 * Structure: { [tabId]: { url: string, entries: Array } }
 */
const tabData = {};

/**
 * Navigation counter per tab. Work records the generation when it starts and
 * drops its results if the tab has navigated (or closed) since.
 */
const tabGeneration = {};

/**
 * Chrome's documentId of each tab's current top-level document, used to
 * reject content script reports from a previous page. Firefox has no
 * document ids, so there reports are matched by origin instead.
 */
const tabDocumentId = {};

/**
 * Generation of each in-flight request, recorded when the request starts.
 */
const requestGeneration = new Map();

/**
 * Resource URLs already scanned for the tab's current page, keyed by tabId.
 */
const scannedUrls = {};

/**
 * Verification results keyed by sourcemap URL, shared across tabs.
 * Structure: { [url]: { promise, expires } }
 */
const verifyCache = new Map();

/**
 * Limits concurrent downloads made by the extension itself.
 */
const fetchSlots = { active: 0, waiting: [] };

const BackgroundController = {
  /**
   * Initialize listeners.
   * @param {object} api - The browser API namespace (browser or chrome)
   * @param {object} opts - { badgeApi: 'browserAction' | 'action', useSessionStorage: bool }
   */
  init(api, opts) {
    this.api = api;
    this.opts = opts;
    this.badgeApi = api[opts.badgeApi];
    // Keep a tab's results when it navigates, like DevTools' "Preserve log"
    this.preserveLog = false;
    // Domains the user skipped in the popup, left out of the badge count
    this.skippedHosts = new Set();

    // Every handler waits for this, so a restarted service worker never
    // answers or mutates state before session storage has been restored
    this.ready = this.restore();

    const filter = {
      urls: ['<all_urls>'],
      types: SOURCEMAP_CONSTANTS.RESOURCE_TYPES,
    };

    // Tie each request to the page that started it
    api.webRequest.onBeforeRequest.addListener(
      (details) =>
        this.ready.then(() => {
          if (details.tabId < 0) return;
          if (requestGeneration.size >= SOURCEMAP_CONSTANTS.REQUEST_TRACKING_MAX) {
            requestGeneration.delete(requestGeneration.keys().next().value);
          }
          requestGeneration.set(details.requestId, this.generationOf(details.tabId));
        }),
      filter
    );

    // Check response headers on script/stylesheet requests
    api.webRequest.onHeadersReceived.addListener(
      (details) => this.ready.then(() => this.onHeadersReceived(details)),
      filter,
      ['responseHeaders']
    );

    // Scan script/stylesheet bodies once loaded, including lazily loaded chunks
    api.webRequest.onCompleted.addListener(
      (details) => this.ready.then(() => this.onRequestCompleted(details)),
      filter
    );

    api.webRequest.onErrorOccurred.addListener(
      (details) =>
        this.ready.then(() => requestGeneration.delete(details.requestId)),
      filter
    );

    // Listen for messages from content script and popup
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.ready.then(() => this.onMessage(message, sender, sendResponse));
      return message.type === 'GET_TAB_DATA';
    });

    // Reset data when the top-level document changes. History API
    // navigations don't commit, so SPA route changes keep their results.
    // Back/forward cache restores do commit; the content script rescans then.
    api.webNavigation.onCommitted.addListener((details) => {
      if (details.frameId !== 0) return;
      this.ready.then(() =>
        this.resetTab(details.tabId, details.url, details.documentId)
      );
    });

    api.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.preserveLog) {
        this.preserveLog = changes.preserveLog.newValue === true;
      }
      if (area === 'local' && changes.skippedHosts) {
        this.skippedHosts = new Set(changes.skippedHosts.newValue || []);
        this.ready.then(() => {
          for (const tabId of Object.keys(tabData)) this.updateBadge(Number(tabId));
        });
      }
    });

    // Clean up on tab close. Bumping the generation (rather than deleting it)
    // makes any work still in flight for the tab drop its results.
    api.tabs.onRemoved.addListener((tabId) => {
      this.ready.then(() => {
        tabGeneration[tabId] = this.generationOf(tabId) + 1;
        delete tabData[tabId];
        delete tabDocumentId[tabId];
        delete scannedUrls[tabId];
        this.persist(tabId);
      });
    });
  },

  /**
   * Rehydrate tabData from session storage after a service worker restart.
   */
  async restore() {
    try {
      const settings = await this.api.storage.local.get([
        'preserveLog',
        'skippedHosts',
      ]);
      this.preserveLog = settings.preserveLog === true;
      this.skippedHosts = new Set(settings.skippedHosts || []);
    } catch (e) {}

    if (!this.opts.useSessionStorage || !this.api.storage?.session) return;
    try {
      const items = await this.api.storage.session.get(null);
      for (const [key, value] of Object.entries(items || {})) {
        if (!key.startsWith('tab_')) continue;
        const tabId = parseInt(key.replace('tab_', ''), 10);
        tabData[tabId] = value;
        tabGeneration[tabId] = 0;
        // Verification may have been cut off by the restart
        for (const entry of value.entries) {
          if (entry.status === 'pending') this.verifyEntry(tabId, entry);
        }
      }
    } catch (e) {
      // Start empty rather than leaving every handler blocked
    }
  },

  generationOf(tabId) {
    return tabGeneration[tabId] || 0;
  },

  /**
   * The generation a request started in, or the current one if the request
   * started before a service worker restart.
   */
  requestGenerationOf(details) {
    return requestGeneration.has(details.requestId)
      ? requestGeneration.get(details.requestId)
      : this.generationOf(details.tabId);
  },

  onHeadersReceived(details) {
    const { tabId, url, responseHeaders } = details;
    if (tabId < 0) return;
    if (this.requestGenerationOf(details) !== this.generationOf(tabId)) return;

    const headerResults = SourcemapDetector.scanHeaders(responseHeaders, url);
    if (headerResults.length > 0) {
      this.addEntries(tabId, headerResults);
    }
  },

  onRequestCompleted(details) {
    const { tabId, url, type, statusCode } = details;
    const generation = this.requestGenerationOf(details);
    requestGeneration.delete(details.requestId);
    if (tabId < 0 || statusCode !== 200) return;
    this.scanResource(tabId, generation, url, type);
  },

  /**
   * Fetch a resource the page loaded and scan it for a sourceMappingURL
   * comment, once per page. Runs in the background so the extension's host
   * permission applies instead of the page's CORS rules.
   */
  async scanResource(tabId, generation, url, type) {
    if (generation !== this.generationOf(tabId)) return;
    if (!SourcemapUtils.canFetch(url, tabData[tabId]?.url)) return;
    const scanned = (scannedUrls[tabId] ??= new Set());
    if (scanned.has(url)) return;
    if (scanned.size >= SOURCEMAP_CONSTANTS.MAX_SCANNED_URLS) scanned.clear();
    scanned.add(url);

    let entries = [];
    try {
      // Redirects aren't followed, so a public URL can't bounce the request
      // into the local network. URLs seen by webRequest are already final.
      const result = await this.fetchText(
        url,
        { cache: 'default', redirect: 'manual' },
        SOURCEMAP_CONSTANTS.MAX_RESOURCE_BYTES,
        () => generation === this.generationOf(tabId)
      );
      if (result && result.response.ok) {
        // Also check headers: this path covers resources webRequest missed
        entries = SourcemapDetector.scanHeaders(
          Array.from(result.response.headers, ([name, value]) => ({ name, value })),
          url
        );
        if (result.text !== null) {
          entries.push(...SourcemapDetector.scanContent(result.text, url, type));
        }
      }
    } catch (e) {
      // Network error or timeout — skip
    }

    if (entries.length > 0 && generation === this.generationOf(tabId)) {
      this.addEntries(tabId, entries);
    }
  },

  onMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'CONTENT_SCAN': {
        const tabId = sender.tab?.id;
        if (tabId == null || !this.isCurrentDocument(tabId, sender, message)) {
          break;
        }
        const generation = this.generationOf(tabId);
        if (message.entries.length > 0) {
          this.addEntries(tabId, message.entries);
        }
        // Resources served from the renderer's memory cache never reach
        // webRequest, so the content script reports what the page uses too
        for (const { url, type } of message.resources) {
          this.scanResource(tabId, generation, url, type);
        }
        break;
      }
      case 'CLEAR_TAB': {
        if (tabData[message.tabId]) tabData[message.tabId].entries = [];
        delete scannedUrls[message.tabId];
        this.onTabChanged(message.tabId);
        break;
      }
      case 'GET_TAB_DATA': {
        const data = tabData[message.tabId] || { url: '', entries: [] };
        sendResponse(data);
        break;
      }
    }
  },

  /**
   * Whether a content script report comes from the tab's current document,
   * rather than one sent just before a navigation and delivered after it.
   */
  isCurrentDocument(tabId, sender, message) {
    if (sender.documentId && tabDocumentId[tabId]) {
      return sender.documentId === tabDocumentId[tabId];
    }
    const pageUrl = tabData[tabId]?.url;
    if (!pageUrl || !message.pageUrl) return true;
    try {
      return new URL(pageUrl).origin === new URL(message.pageUrl).origin;
    } catch (e) {
      return true;
    }
  },

  resetTab(tabId, url, documentId) {
    // Work still running for the previous page is dropped either way, so
    // results are never attributed to the wrong page
    tabGeneration[tabId] = this.generationOf(tabId) + 1;
    if (documentId) tabDocumentId[tabId] = documentId;
    else delete tabDocumentId[tabId];

    if (this.preserveLog && tabData[tabId]) {
      tabData[tabId].url = url || '';
    } else {
      tabData[tabId] = { url: url || '', entries: [] };
      delete scannedUrls[tabId];
    }
    this.onTabChanged(tabId);
  },

  addEntries(tabId, newEntries) {
    if (!tabData[tabId]) {
      tabData[tabId] = { url: '', entries: [] };
    }
    const data = tabData[tabId];
    const previousCount = data.entries.length;
    // Remember which page each map was found on, as Preserve log mixes pages
    for (const entry of newEntries) entry.pageUrl = data.url;
    // Deduplication keeps first occurrences in order, so new entries end up last
    data.entries = SourcemapUtils.deduplicateEntries([
      ...data.entries,
      ...newEntries,
    ]).slice(0, SOURCEMAP_CONSTANTS.MAX_TAB_ENTRIES);

    for (const entry of data.entries.slice(previousCount)) {
      this.verifyEntry(tabId, entry);
    }
    this.onTabChanged(tabId);
  },

  /**
   * Check whether a detected sourcemap is actually downloadable, and update
   * the entry in place with the result.
   */
  async verifyEntry(tabId, entry) {
    // Inline maps were already inspected by the detector
    if (entry.isDataUri) {
      entry.status = entry.status || 'invalid';
      return;
    }
    const pageUrl = entry.pageUrl || tabData[tabId]?.url;
    if (!SourcemapUtils.canFetch(entry.sourcemapUrl, pageUrl)) {
      entry.status = 'skipped';
      return;
    }
    entry.status = 'pending';

    const result = await this.checkSourcemap(entry.sourcemapUrl);
    Object.assign(entry, result);

    // A navigation replaces the entries array unless Preserve log keeps it
    if (tabData[tabId]?.entries.includes(entry)) {
      this.onTabChanged(tabId);
    }
  },

  checkSourcemap(url) {
    const cached = verifyCache.get(url);
    if (cached && cached.expires > Date.now()) return cached.promise;
    verifyCache.delete(url);

    const promise = (async () => {
      try {
        // Redirects aren't followed, so a public URL can't bounce the
        // request into the local network
        const { response, text } = await this.fetchText(
          url,
          { cache: 'no-cache', redirect: 'manual' },
          SOURCEMAP_CONSTANTS.MAX_SOURCEMAP_BYTES
        ) || {};
        if (!response) throw new Error('Fetch queue full');
        if (response.type === 'opaqueredirect') return { status: 'redirect' };
        if (!response.ok) {
          return { status: 'unreachable', httpStatus: response.status };
        }
        if (text === null) return { status: 'toolarge' };
        return SourcemapUtils.inspectSourcemap(text);
      } catch (e) {
        // Network errors may be transient, so allow a retry next time
        verifyCache.delete(url);
        return { status: 'error' };
      }
    })();

    if (verifyCache.size >= SOURCEMAP_CONSTANTS.VERIFY_CACHE_MAX) {
      verifyCache.delete(verifyCache.keys().next().value);
    }
    verifyCache.set(url, {
      promise,
      expires: Date.now() + SOURCEMAP_CONSTANTS.VERIFY_CACHE_TTL_MS,
    });
    return promise;
  },

  /**
   * Fetch a URL without cookies, with a concurrency limit, a timeout and a
   * size cap. Resolves to { response, text }; text is null when the response
   * isn't OK or exceeds maxBytes. Resolves to null without fetching when the
   * queue is full or shouldRun() returns false once a slot is free.
   */
  async fetchText(url, init, maxBytes, shouldRun) {
    if (!(await this.acquireFetchSlot())) return null;
    if (shouldRun && !shouldRun()) {
      this.releaseFetchSlot();
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      SOURCEMAP_CONSTANTS.FETCH_TIMEOUT_MS
    );
    try {
      return await SourcemapUtils.fetchLimited(url, init, maxBytes, controller);
    } finally {
      clearTimeout(timer);
      // Cancels any unread body (e.g. of an error response) before the slot
      // is reused; a no-op once the body has been read
      controller.abort();
      this.releaseFetchSlot();
    }
  },

  /**
   * Resolves to true once a download slot is free, or false straight away
   * when too much work is already queued.
   */
  acquireFetchSlot() {
    if (fetchSlots.active < SOURCEMAP_CONSTANTS.FETCH_CONCURRENCY) {
      fetchSlots.active++;
      return Promise.resolve(true);
    }
    if (fetchSlots.waiting.length >= SOURCEMAP_CONSTANTS.FETCH_QUEUE_MAX) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => fetchSlots.waiting.push(resolve));
  },

  releaseFetchSlot() {
    const next = fetchSlots.waiting.shift();
    if (next) next(true);
    else fetchSlots.active--;
  },

  onTabChanged(tabId) {
    this.updateBadge(tabId);
    this.persist(tabId);
    this.notifyPopup(tabId);
  },

  persist(tabId) {
    if (!this.opts.useSessionStorage || !this.api.storage?.session) return;
    const key = `tab_${tabId}`;
    const data = tabData[tabId];
    // Kept even without entries: the page URL is needed after a restart
    if (data) {
      this.api.storage.session.set({ [key]: data });
    } else {
      this.api.storage.session.remove(key);
    }
  },

  /**
   * Let an open popup refresh. Rejects when no popup is listening.
   */
  notifyPopup(tabId) {
    try {
      const sent = this.api.runtime.sendMessage({
        type: 'TAB_DATA_UPDATED',
        tabId,
      });
      if (sent && sent.catch) sent.catch(() => {});
    } catch (e) {}
  },

  /**
   * Red count of confirmed reachable maps; grey count of references when
   * none are confirmed yet. Skipped domains don't count.
   */
  updateBadge(tabId) {
    const entries = (tabData[tabId]?.entries || []).filter(
      (e) =>
        !SourcemapUtils.isHostSkipped(
          SourcemapUtils.hostOf(e.resourceUrl),
          this.skippedHosts
        )
    );
    const exposed = entries.filter((e) => e.status === 'exposed').length;
    const count = exposed || entries.length;

    const text = count > 0 ? String(count) : '';
    this.badgeApi.setBadgeText({ text, tabId });
    if (count > 0) {
      this.badgeApi.setBadgeBackgroundColor({
        color: exposed
          ? SOURCEMAP_CONSTANTS.BADGE_COLOR_FOUND
          : SOURCEMAP_CONSTANTS.BADGE_COLOR_REFERENCED,
        tabId,
      });
    }
  },
};
