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
  };

  let cachedData = null;

  // ── Data fetching ──

  async function getData() {
    if (cachedData) return cachedData;
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) return null;

    return new Promise((resolve) => {
      api.runtime.sendMessage(
        { type: 'GET_TAB_DATA', tabId: tabs[0].id },
        (response) => {
          cachedData = response || { url: '', entries: [] };
          cachedData.url = cachedData.url || tabs[0].url;
          resolve(cachedData);
        }
      );
    });
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

    const displayUrl = entry.isDataUri ? '[inline data URI]' : entry.sourcemapUrl;
    const resourceLabel = getDisplayLabel(entry.resourceUrl);

    const badgeEl = document.createElement('span');
    badgeEl.className = badgeClass;
    badgeEl.textContent = badgeText;

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

    li.appendChild(badgeEl);
    li.appendChild(urlEl);
    li.appendChild(metaEl);
    return li;
  }

  function getDisplayLabel(url) {
    if (!url) return '';
    try {
      return new URL(url).pathname.split('/').pop() || url;
    } catch (e) {
      return url;
    }
  }

  function renderResults(data) {
    el.status.classList.add('hidden');

    if (!data || !data.entries || data.entries.length === 0) {
      el.emptyState.classList.remove('hidden');
      el.results.classList.add('hidden');
      el.actions.classList.add('hidden');
      return;
    }

    el.emptyState.classList.add('hidden');
    el.results.classList.remove('hidden');
    el.actions.classList.remove('hidden');

    el.countBadge.textContent = data.entries.length;
    el.countBadge.classList.remove('hidden');

    el.list.innerHTML = '';
    for (const entry of data.entries) {
      el.list.appendChild(renderEntry(entry));
    }
  }

  // ── Actions ──

  function getAllUrls(entries) {
    return entries
      .filter((e) => !e.isDataUri)
      .map((e) => e.sourcemapUrl)
      .join('\n');
  }

  el.btnCopy.addEventListener('click', async () => {
    const data = await getData();
    if (!data || !data.entries || data.entries.length === 0) return;

    const text = getAllUrls(data.entries);
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
    if (!data || !data.entries || data.entries.length === 0) return;

    const header =
      '# Sourcemap Detector Report\n' +
      '# Page: ' + (data.url || 'unknown') + '\n' +
      '# Date: ' + new Date().toISOString() + '\n\n';

    const lines = data.entries
      .map((e) => {
        const source =
          e.source === 'header'
            ? '[header:' + (e.headerName || 'SourceMap') + ']'
            : '[comment:' + (e.type || 'js') + ']';
        const url = e.isDataUri ? '[inline-data-uri]' : e.sourcemapUrl;
        return source + ' ' + url + '\n  Resource: ' + e.resourceUrl;
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
    URL.revokeObjectURL(blobUrl);
  });

  // ── Init ──
  getData().then(renderResults);
})();
