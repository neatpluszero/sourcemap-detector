(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  const el = {
    status: document.getElementById('status'),
    statusText: document.getElementById('status-text'),
    results: document.getElementById('results'),
    list: document.getElementById('sourcemap-list'),
    emptyState: document.getElementById('empty-state'),
    actions: document.getElementById('actions'),
    countBadge: document.getElementById('count-badge'),
    btnCopy: document.getElementById('btn-copy'),
    btnExport: document.getElementById('btn-export'),
    onlyExposed: document.getElementById('only-exposed'),
    domains: document.getElementById('domains'),
    preserveLog: document.getElementById('preserve-log'),
    btnClear: document.getElementById('btn-clear'),
    btnExplorer: document.getElementById('btn-explorer'),
  };

  let cachedData = null;
  let currentTab = null;

  // ── Data fetching ──

  async function getData() {
    if (cachedData) return cachedData;
    if (!currentTab) {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) return null;
      currentTab = tabs[0];
    }

    // Promise form: Firefox's browser namespace doesn't accept callbacks
    const response = await api.runtime.sendMessage({
      type: 'GET_TAB_DATA',
      tabId: currentTab.id,
    });
    cachedData = response || { url: '', entries: [] };
    cachedData.url = cachedData.url || currentTab.url;
    return cachedData;
  }

  // ── Rendering ──

  function renderEntry(entry) {
    const li = document.createElement('li');
    li.className = 'sourcemap-item';

    let badgeClass = 'badge';
    let badgeText = entry.source;
    if (entry.source === 'header') {
      badgeClass += ' badge--header';
      badgeText = 'Header: ' + (entry.headerName || 'SourceMap');
    } else if (entry.isDataUri) {
      badgeClass += ' badge--data-uri';
      badgeText = 'Inline Data URI';
    } else {
      badgeClass += ' badge--comment';
      badgeText = 'Comment (' + (entry.type || 'js') + ')';
    }

    const displayUrl = entry.isDataUri
      ? '[inline data URI, ' + formatSize(entry.dataUriLength) + ']'
      : entry.sourcemapUrl;
    const resourceLabel = SourcemapUtils.getDisplayLabel(entry.resourceUrl);

    const badgeEl = document.createElement('span');
    badgeEl.className = badgeClass;
    badgeEl.textContent = badgeText;

    const status = SourcemapUtils.statusBadge(entry);
    const statusEl = document.createElement('span');
    statusEl.className = 'badge ' + status.className;
    statusEl.textContent = status.text;

    const urlEl = document.createElement('a');
    urlEl.className = 'sourcemap-item__url';
    urlEl.textContent = displayUrl;
    if (!entry.isDataUri) {
      urlEl.href = entry.sourcemapUrl;
      urlEl.target = '_blank';
      urlEl.rel = 'noopener';
    }

    const metaEl = document.createElement('div');
    metaEl.className = 'sourcemap-item__meta';
    metaEl.textContent = 'from: ' + resourceLabel;
    // Preserved results from an earlier page in this tab
    const otherPage = otherPageOf(entry);
    if (otherPage) metaEl.textContent += ' · on: ' + otherPage;

    li.appendChild(badgeEl);
    li.appendChild(statusEl);
    li.appendChild(urlEl);
    li.appendChild(metaEl);
    return li;
  }

  /**
   * The page an entry was found on, when that isn't the current page.
   */
  function otherPageOf(entry) {
    if (!entry.pageUrl || !cachedData || entry.pageUrl === cachedData.url) {
      return '';
    }
    try {
      const page = new URL(entry.pageUrl);
      return page.host + page.pathname;
    } catch (e) {
      return entry.pageUrl;
    }
  }

  function formatSize(length) {
    if (!length) return 'unknown size';
    return length < 1024 ? length + ' B' : Math.round(length / 1024) + ' KB';
  }

  // Groups the user opened or closed in this popup session, by host
  const expandedOverrides = new Map();

  function toggleSkipped(host) {
    if (skippedHosts.has(host)) skippedHosts.delete(host);
    else skippedHosts.add(host);
    saveSettings();
    renderResults(cachedData);
  }

  function isExpanded(group, groupCount) {
    if (expandedOverrides.has(group.host)) {
      return expandedOverrides.get(group.host);
    }
    // The page's own site starts open; third parties start closed unless
    // they are all there is
    return group.firstParty || groupCount === 1;
  }

  function countExposed(entries) {
    return entries.filter((e) => e.status === 'exposed').length;
  }

  /**
   * One toggle chip per domain, so every domain is visible without scrolling.
   */
  function renderDomainBar(groups) {
    el.domains.innerHTML = '';
    const caption = document.createElement('span');
    caption.className = 'domains__caption';
    caption.textContent = 'Click a domain to skip it:';
    el.domains.appendChild(caption);
    for (const group of groups) {
      const skipped = skippedHosts.has(group.host);
      const exposed = countExposed(group.entries);

      const chip = document.createElement('button');
      chip.className = 'chip' + (skipped ? ' chip--skipped' : '');
      chip.setAttribute('aria-pressed', String(!skipped));
      chip.title =
        (group.host || '(no host)') + ': ' +
        exposed + ' exposed of ' + group.entries.length + '. ' +
        (skipped
          ? 'Skipped from Copy and Export on every site; click to include.'
          : 'Click to skip from Copy and Export on every site.');

      const name = document.createElement('span');
      name.className = 'chip__host';
      name.textContent = group.host || '(no host)';

      const count = document.createElement('span');
      count.className = 'chip__count' + (exposed ? ' chip__count--exposed' : '');
      count.textContent = exposed || group.entries.length;

      chip.appendChild(name);
      chip.appendChild(count);
      chip.addEventListener('click', () => toggleSkipped(group.host));
      el.domains.appendChild(chip);
    }
    el.domains.classList.toggle('hidden', groups.length < 2);
  }

  function renderGroup(group, groupCount) {
    const expanded = isExpanded(group, groupCount);
    const exposed = countExposed(group.entries);

    const li = document.createElement('li');
    li.className = 'group';

    const header = document.createElement('button');
    header.className = 'group__header';
    header.setAttribute('aria-expanded', String(expanded));
    header.addEventListener('click', () => {
      expandedOverrides.set(group.host, !expanded);
      renderResults(cachedData);
    });

    const caret = document.createElement('span');
    caret.className = 'group__caret';
    caret.textContent = expanded ? '▾' : '▸';
    header.appendChild(caret);

    const nameEl = document.createElement('span');
    nameEl.className = 'group__host';
    nameEl.textContent = group.host || '(no host)';
    header.appendChild(nameEl);

    if (group.firstParty) {
      const tag = document.createElement('span');
      tag.className = 'group__tag';
      tag.textContent = 'this site';
      header.appendChild(tag);
    }

    const countEl = document.createElement('span');
    countEl.className = 'group__count';
    countEl.textContent = exposed + ' exposed / ' + group.entries.length;
    header.appendChild(countEl);

    li.appendChild(header);

    if (expanded) {
      const ul = document.createElement('ul');
      ul.className = 'sourcemap-list';
      for (const entry of group.entries) {
        ul.appendChild(renderEntry(entry));
      }
      li.appendChild(ul);
    }
    return li;
  }

  function renderResults(data) {
    el.status.classList.add('hidden');

    if (!data || !data.entries || data.entries.length === 0) {
      el.emptyState.classList.remove('hidden');
      el.results.classList.add('hidden');
      el.domains.classList.add('hidden');
      el.actions.classList.add('hidden');
      el.countBadge.classList.add('hidden');
      return;
    }

    el.emptyState.classList.add('hidden');
    el.results.classList.remove('hidden');
    el.actions.classList.remove('hidden');

    const included = getIncludedEntries(data);
    el.countBadge.textContent =
      included.length === data.entries.length
        ? data.entries.length
        : included.length + ' / ' + data.entries.length;
    el.countBadge.title = included.length + ' included in Copy and Export';
    el.countBadge.classList.remove('hidden');
    el.btnCopy.disabled = !getAllUrls(included);
    el.btnExport.disabled = included.length === 0;

    const groups = SourcemapUtils.groupByHost(data.entries, data.url);
    renderDomainBar(groups);

    const shown = groups.filter((g) => !skippedHosts.has(g.host));
    el.list.innerHTML = '';
    for (const group of shown) {
      el.list.appendChild(renderGroup(group, groups.length));
    }

    const skippedCount = groups.length - shown.length;
    if (skippedCount > 0) {
      const note = document.createElement('li');
      note.className = 'skipped-note';
      note.textContent =
        skippedCount + (skippedCount === 1 ? ' domain' : ' domains') +
        ' skipped. Click a dimmed domain above to include it.';
      el.list.appendChild(note);
    }
  }

  // ── Skipped domains ──

  // Hostnames left out of Copy and Export, kept across sites and sessions
  let skippedHosts = new Set();

  async function loadSettings() {
    try {
      const stored = await api.storage.local.get([
        'skippedHosts',
        'onlyExposed',
        'preserveLog',
      ]);
      skippedHosts = new Set(stored.skippedHosts || []);
      el.onlyExposed.checked = stored.onlyExposed !== false;
      el.preserveLog.checked = stored.preserveLog === true;
    } catch (e) {}
  }

  function saveSettings() {
    try {
      const saved = api.storage.local.set({
        skippedHosts: [...skippedHosts],
        onlyExposed: el.onlyExposed.checked,
      });
      if (saved && saved.catch) saved.catch(() => {});
    } catch (e) {}
  }

  /**
   * Entries that Copy and Export act on: not from a skipped domain, and
   * confirmed exposed when "Only exposed" is ticked.
   */
  function getIncludedEntries(data) {
    return data.entries.filter(
      (e) =>
        !skippedHosts.has(SourcemapUtils.hostOf(e.resourceUrl)) &&
        (!el.onlyExposed.checked || e.status === 'exposed')
    );
  }

  el.onlyExposed.addEventListener('change', () => {
    saveSettings();
    renderResults(cachedData);
  });

  // ── Actions ──

  function getAllUrls(entries) {
    return entries
      .filter((e) => !e.isDataUri)
      .map((e) => e.sourcemapUrl)
      .join('\n');
  }

  el.btnCopy.addEventListener('click', async () => {
    const data = await getData();
    if (!data || !data.entries) return;
    const text = getAllUrls(getIncludedEntries(data));
    if (!text) return;
    await navigator.clipboard.writeText(text);

    el.btnCopy.textContent = 'Copied!';
    el.btnCopy.classList.add('btn--copied');
    setTimeout(() => {
      el.btnCopy.textContent = 'Copy All';
      el.btnCopy.classList.remove('btn--copied');
    }, 1500);
  });

  el.btnExport.addEventListener('click', async () => {
    const data = await getData();
    if (!data || !data.entries) return;
    const included = getIncludedEntries(data);
    if (included.length === 0) return;

    const skippedHere = [
      ...new Set(
        data.entries
          .map((e) => SourcemapUtils.hostOf(e.resourceUrl))
          .filter((host) => skippedHosts.has(host))
      ),
    ];
    const header =
      '# Sourcemap Detector Report\n' +
      '# Page: ' + (data.url || 'unknown') + '\n' +
      '# Date: ' + new Date().toISOString() + '\n' +
      (skippedHere.length ? '# Skipped domains: ' + skippedHere.join(', ') + '\n' : '') +
      '\n';

    const lines = included
      .map((e) => {
        const source =
          e.source === 'header'
            ? '[header:' + (e.headerName || 'SourceMap') + ']'
            : '[comment:' + (e.type || 'js') + ']';
        const url = e.isDataUri ? '[inline-data-uri]' : e.sourcemapUrl;
        return (
          source + ' ' + url +
          '\n  Status: ' + SourcemapUtils.statusBadge(e).text +
          '\n  Resource: ' + e.resourceUrl +
          (otherPageOf(e) ? '\n  Page: ' + e.pageUrl : '')
        );
      })
      .join('\n\n');

    const blob = new Blob([header + lines + '\n'], { type: 'text/plain' });
    const blobUrl = URL.createObjectURL(blob);

    let hostname = 'unknown';
    try {
      hostname = new URL(data.url).hostname;
    } catch (e) {}

    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = 'sourcemaps-' + hostname + '-' + Date.now() + '.txt';
    a.click();
    // Revoking straight away can cancel the download in Firefox
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  });

  // ── Toolbar ──

  el.preserveLog.addEventListener('change', () => {
    try {
      const saved = api.storage.local.set({ preserveLog: el.preserveLog.checked });
      if (saved && saved.catch) saved.catch(() => {});
    } catch (e) {}
  });

  el.btnClear.addEventListener('click', async () => {
    if (!currentTab) return;
    await api.runtime.sendMessage({ type: 'CLEAR_TAB', tabId: currentTab.id });
    if (cachedData) cachedData.entries = [];
    renderResults(cachedData);
  });

  el.btnExplorer.addEventListener('click', async () => {
    if (!currentTab) return;
    await api.tabs.create({
      url: api.runtime.getURL('explorer/explorer.html?tab=' + currentTab.id),
    });
    window.close();
  });

  // ── Live updates ──

  api.runtime.onMessage.addListener((message) => {
    if (
      message.type === 'TAB_DATA_UPDATED' &&
      currentTab &&
      message.tabId === currentTab.id
    ) {
      cachedData = null;
      getData().then(renderResults);
    }
  });

  // ── Init ──
  Promise.all([getData(), loadSettings()]).then(([data]) =>
    renderResults(data)
  );
})();
