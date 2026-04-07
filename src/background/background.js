/**
 * In-memory store of detected sourcemaps, keyed by tabId.
 * Structure: { [tabId]: { url: string, entries: Array } }
 */
const tabData = {};

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

    // Listen for response headers on script/stylesheet requests
    api.webRequest.onHeadersReceived.addListener(
      (details) => this.onHeadersReceived(details),
      { urls: ['<all_urls>'], types: SOURCEMAP_CONSTANTS.RESOURCE_TYPES },
      ['responseHeaders']
    );

    // Listen for messages from content script and popup
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      return this.onMessage(message, sender, sendResponse);
    });

    // Reset data on page navigation
    api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'loading') {
        tabData[tabId] = { url: tab.url || '', entries: [] };
        this.updateBadge(tabId, 0);
      }
    });

    // Clean up on tab close
    api.tabs.onRemoved.addListener((tabId) => {
      delete tabData[tabId];
      if (this.opts.useSessionStorage && api.storage?.session) {
        api.storage.session.remove(`tab_${tabId}`);
      }
    });
  },

  onHeadersReceived(details) {
    const { tabId, url, responseHeaders } = details;
    if (tabId < 0) return;

    const headerResults = SourcemapDetector.scanHeaders(responseHeaders, url);
    if (headerResults.length > 0) {
      this.addEntries(tabId, headerResults);
    }
  },

  onMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'CONTENT_SOURCEMAPS_FOUND': {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          this.addEntries(tabId, message.entries);
        }
        break;
      }
      case 'GET_TAB_DATA': {
        const data = tabData[message.tabId] || { url: '', entries: [] };
        sendResponse(data);
        return true;
      }
    }
  },

  addEntries(tabId, newEntries) {
    if (!tabData[tabId]) {
      tabData[tabId] = { url: '', entries: [] };
    }
    tabData[tabId].entries.push(...newEntries);
    tabData[tabId].entries = SourcemapUtils.deduplicateEntries(
      tabData[tabId].entries
    );

    const count = tabData[tabId].entries.length;
    this.updateBadge(tabId, count);

    if (this.opts.useSessionStorage && this.api.storage?.session) {
      this.api.storage.session.set({ [`tab_${tabId}`]: tabData[tabId] });
    }
  },

  updateBadge(tabId, count) {
    const text = count > 0 ? String(count) : '';
    this.badgeApi.setBadgeText({ text, tabId });
    if (count > 0) {
      this.badgeApi.setBadgeBackgroundColor({
        color: SOURCEMAP_CONSTANTS.BADGE_COLOR_FOUND,
        tabId,
      });
    }
  },
};
