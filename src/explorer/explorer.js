(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const tabId = Number(new URLSearchParams(location.search).get('tab'));

  const el = {
    page: document.getElementById('page'),
    progress: document.getElementById('progress'),
    zipAll: document.getElementById('zip-all'),
    tree: document.getElementById('tree'),
    viewerHead: document.getElementById('viewer-head'),
    viewerPath: document.getElementById('viewer-path'),
    viewerSize: document.getElementById('viewer-size'),
    viewerCode: document.getElementById('viewer-code'),
    viewerEmpty: document.getElementById('viewer-empty'),
    fileCopy: document.getElementById('file-copy'),
    fileDownload: document.getElementById('file-download'),
  };

  // Concurrent map downloads during a ZIP export
  const ZIP_CONCURRENCY = 4;
  const FETCH_TIMEOUT_MS = 60000;

  let data = { url: '', entries: [] };
  let tabClosed = false;
  let skippedHosts = new Set();
  let onlyExposed = true;

  // Loaded maps by entry key: { status: 'loading' | 'ready' | 'error',
  // promise, files, root, error }
  const maps = new Map();
  // Tree nodes the user opened or closed, by node id
  const expanded = new Map();
  // The file shown in the viewer: { key, index }
  let selected = null;
  let exporting = false;

  // ── Data ──

  async function loadData() {
    const response = await api.runtime.sendMessage({ type: 'GET_TAB_DATA', tabId });
    try {
      await api.tabs.get(tabId);
    } catch (e) {
      // Keep showing what was found before the tab was closed
      tabClosed = true;
      return;
    }
    data = response || { url: '', entries: [] };
  }

  async function loadSettings() {
    try {
      const stored = await api.storage.local.get(['skippedHosts', 'onlyExposed']);
      skippedHosts = new Set(stored.skippedHosts || []);
      onlyExposed = stored.onlyExposed !== false;
    } catch (e) {}
  }

  function entryKey(entry) {
    return entry.isDataUri
      ? entry.resourceUrl + '#' + entry.dataUriHash
      : entry.sourcemapUrl;
  }

  /**
   * Download a URL with the same limits as the background: no cookies, no
   * redirects, a size cap and a timeout.
   */
  async function fetchChecked(url, maxBytes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const { response, text } = await SourcemapUtils.fetchLimited(
        url,
        { cache: 'default', redirect: 'manual' },
        maxBytes,
        controller
      );
      if (response.type === 'opaqueredirect') {
        throw new Error('Redirects (not followed)');
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      if (text === null) throw new Error('Too large');
      return text;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Timed out');
      if (e instanceof TypeError) throw new Error('Fetch failed');
      throw e;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function fetchMapText(entry) {
    const pageUrl = entry.pageUrl || data.url;
    if (!entry.isDataUri) {
      if (!SourcemapUtils.canFetch(entry.sourcemapUrl, pageUrl)) {
        throw new Error('Not fetched (private host)');
      }
      return fetchChecked(entry.sourcemapUrl, SOURCEMAP_CONSTANTS.MAX_SOURCEMAP_BYTES);
    }

    // Only a prefix of inline maps is kept, so read the full map from the
    // file that embeds it
    if (entry.inline) throw new Error('Inline in the page, not available');
    if (!SourcemapUtils.canFetch(entry.resourceUrl, pageUrl)) {
      throw new Error('Not fetched (private host)');
    }
    const content = await fetchChecked(
      entry.resourceUrl,
      SOURCEMAP_CONSTANTS.MAX_RESOURCE_BYTES
    );
    const rawUrl = SourcemapDetector.findDirectiveUrl(content, entry.type);
    if (!rawUrl || !SourcemapUtils.isDataUri(rawUrl)) {
      throw new Error('Inline map no longer in the file');
    }
    const text = SourcemapUtils.decodeDataUri(rawUrl);
    if (text === null) throw new Error('Could not decode the inline map');
    return text;
  }

  /**
   * Fetch and parse a map once; later calls share the result. A failed map
   * is fetched again the next time it is asked for.
   */
  function loadMap(entry) {
    const key = entryKey(entry);
    const existing = maps.get(key);
    if (existing && existing.status !== 'error') return existing.promise;

    const state = { status: 'loading' };
    state.promise = (async () => {
      try {
        const map = SourcemapUtils.parseSourcemap(await fetchMapText(entry));
        if (!map) throw new Error('Not a sourcemap');
        state.files = SourcemapUtils.listSources(map);
        state.root = buildTree(state.files);
        state.status = 'ready';
      } catch (e) {
        state.status = 'error';
        state.error = e.message || 'Failed';
      }
      scheduleRender();
      return state;
    })();
    maps.set(key, state);
    return state.promise;
  }

  /**
   * Folder tree of a map's files: { folders: Map<name, node>, files: [{ name, index }] }
   */
  function buildTree(files) {
    const root = { folders: new Map(), files: [] };
    files.forEach((file, index) => {
      const parts = file.path.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.folders.has(part)) {
          node.folders.set(part, { folders: new Map(), files: [] });
        }
        node = node.folders.get(part);
      }
      node.files.push({ name: parts[parts.length - 1], index });
    });
    return root;
  }

  function countFiles(node) {
    if (node.count === undefined) {
      node.count = node.files.length;
      for (const child of node.folders.values()) node.count += countFiles(child);
    }
    return node.count;
  }

  // ── Tree rendering ──

  function isOpen(id, byDefault) {
    return expanded.has(id) ? expanded.get(id) : byDefault;
  }

  let renderPending = false;

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      render();
    });
  }

  function makeRow({ id, depth, kind, open, name, title, onClick }) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row row--' + kind;
    row.dataset.id = id;
    row.style.setProperty('--depth', depth);
    row.tabIndex = 0;
    row.setAttribute('role', 'treeitem');
    if (open !== undefined) row.setAttribute('aria-expanded', String(open));
    if (title) row.title = title;

    const caret = document.createElement('span');
    caret.className = 'row__caret';
    caret.textContent = open === undefined ? '' : open ? '▾' : '▸';
    row.appendChild(caret);

    const nameEl = document.createElement('span');
    nameEl.className = 'row__name';
    nameEl.textContent = name;
    row.appendChild(nameEl);

    row.addEventListener('click', () => onClick(row));
    row.addEventListener('keydown', (e) => {
      if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onClick(row);
      }
    });
    li.appendChild(row);
    return { li, row };
  }

  function addSpan(row, className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    row.appendChild(span);
    return span;
  }

  function addZipButton(row, title, onClick) {
    const button = document.createElement('button');
    button.className = 'row__zip';
    button.textContent = 'ZIP';
    button.title = title;
    button.disabled = exporting;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    button.addEventListener('keydown', (e) => e.stopPropagation());
    row.appendChild(button);
  }

  function toggle(id, open) {
    expanded.set(id, !open);
    render();
  }

  function render() {
    const focusedId = document.activeElement?.dataset?.id;

    el.page.textContent = (data.url || '') + (tabClosed ? ' (tab closed)' : '');
    el.page.title = el.page.textContent;
    document.title = 'Sourcemap Explorer' + (data.url ? ' · ' + SourcemapUtils.hostOf(data.url) : '');

    const included = includedEntries();
    el.zipAll.disabled = exporting || included.length === 0;
    el.zipAll.textContent =
      'Download all as ZIP' + (included.length ? ' (' + included.length + ')' : '');
    el.zipAll.title =
      'Every map except skipped domains' +
      (onlyExposed ? ', and only confirmed exposed ones' : '') +
      ', as in the popup';

    el.tree.textContent = '';
    const groups = SourcemapUtils.groupByHost(data.entries, data.url);
    if (groups.length === 0) {
      addSpan(el.tree, 'tree__empty', 'No sourcemaps detected in this tab yet.');
      return;
    }

    const ul = document.createElement('ul');
    ul.setAttribute('role', 'tree');
    for (const group of groups) renderDomain(ul, group, groups.length);
    el.tree.appendChild(ul);

    if (focusedId) {
      const row = el.tree.querySelector('[data-id="' + CSS.escape(focusedId) + '"]');
      if (row) row.focus();
    }
  }

  function renderDomain(parent, group, groupCount) {
    const id = 'd:' + group.host;
    const open = isOpen(id, group.firstParty || groupCount === 1);
    const skipped = skippedHosts.has(group.host);
    const host = group.host || '(no host)';

    const { li, row } = makeRow({
      id,
      depth: 0,
      kind: 'domain',
      open,
      name: host,
      onClick: () => toggle(id, open),
    });
    if (skipped) row.classList.add('row--dim');
    if (group.firstParty) addSpan(row, 'tag tag--site', 'this site');
    if (skipped) addSpan(row, 'tag tag--skipped', 'skipped');
    const exposed = group.entries.filter((e) => e.status === 'exposed').length;
    addSpan(row, 'row__meta', exposed + ' exposed / ' + group.entries.length);
    addZipButton(row, 'Download every map from ' + host + ' as a ZIP', () =>
      exportZip(group.entries, 'sources-' + host)
    );

    if (open) {
      const ul = document.createElement('ul');
      ul.setAttribute('role', 'group');
      for (const entry of group.entries) renderMap(ul, entry);
      li.appendChild(ul);
    }
    parent.appendChild(li);
  }

  function mapName(entry) {
    return entry.isDataUri
      ? SourcemapUtils.getDisplayLabel(entry.resourceUrl) + ' (inline map)'
      : SourcemapUtils.getDisplayLabel(entry.sourcemapUrl);
  }

  function renderMap(parent, entry) {
    const key = entryKey(entry);
    const id = 'm:' + key;
    const state = maps.get(key);
    const open = isOpen(id, false);

    const { li, row } = makeRow({
      id,
      depth: 1,
      kind: 'map',
      open,
      name: mapName(entry),
      title: (entry.isDataUri ? entry.resourceUrl : entry.sourcemapUrl) +
        '\nfrom ' + entry.resourceUrl,
      onClick: () => {
        if (!open && (!state || state.status === 'error')) loadMap(entry);
        toggle(id, open);
      },
    });
    if (entry.status !== 'exposed') row.classList.add('row--dim');

    const status = SourcemapUtils.statusBadge(entry);
    addSpan(row, 'badge ' + status.className, status.text);
    if (state && state.status === 'loading') addSpan(row, 'row__meta', 'Loading…');
    if (state && state.status === 'error') addSpan(row, 'row__error', state.error);
    if (state && state.status === 'ready') {
      addSpan(row, 'row__meta', state.files.length + ' files');
    }
    addZipButton(row, 'Download this map\'s sources as a ZIP', () =>
      exportZip([entry], 'sources-' + mapName(entry))
    );

    if (open && state && state.status === 'ready') {
      const ul = document.createElement('ul');
      ul.setAttribute('role', 'group');
      renderFolder(ul, state.root, 2, key, '');
      if (state.files.length === 0) {
        addSpan(ul, 'tree__empty', 'This map lists no source files.');
      }
      li.appendChild(ul);
    }
    parent.appendChild(li);
  }

  function renderFolder(parent, node, depth, key, prefix) {
    const byName = (a, b) => a.localeCompare(b);

    for (const name of [...node.folders.keys()].sort(byName)) {
      // Collapse chains of single folders, e.g. webpack/app/src
      let child = node.folders.get(name);
      let label = name;
      while (child.files.length === 0 && child.folders.size === 1) {
        const [nextName, next] = child.folders.entries().next().value;
        label += '/' + nextName;
        child = next;
      }
      const path = prefix + label;
      const id = 'f:' + key + ':' + path;
      const open = isOpen(id, false);
      const folderNode = child;

      const { li, row } = makeRow({
        id,
        depth,
        kind: 'folder',
        open,
        name: label,
        onClick: () => toggle(id, open),
      });
      addSpan(row, 'row__meta', String(countFiles(folderNode)));
      if (open) {
        const ul = document.createElement('ul');
        ul.setAttribute('role', 'group');
        renderFolder(ul, folderNode, depth + 1, key, path + '/');
        li.appendChild(ul);
      }
      parent.appendChild(li);
    }

    const files = [...node.files].sort((a, b) => byName(a.name, b.name));
    const state = maps.get(key);
    for (const { name, index } of files) {
      const file = state.files[index];
      const { li, row } = makeRow({
        id: 'x:' + key + ':' + index,
        depth,
        kind: 'file',
        name,
        title: file.source,
        onClick: (clicked) => selectFile(key, index, clicked),
      });
      if (file.content === null) row.classList.add('row--missing');
      if (selected && selected.key === key && selected.index === index) {
        row.classList.add('row--selected');
      }
      addSpan(row, 'row__meta', file.content === null ? 'no source' : formatSize(file.content.length));
      parent.appendChild(li);
    }
  }

  // ── Viewer ──

  function formatSize(length) {
    return length < 1024 ? length + ' B' : Math.round(length / 1024) + ' KB';
  }

  function selectedFile() {
    const state = selected && maps.get(selected.key);
    return state && state.files ? state.files[selected.index] : null;
  }

  function selectFile(key, index, row) {
    selected = { key, index };
    for (const old of el.tree.querySelectorAll('.row--selected')) {
      old.classList.remove('row--selected');
    }
    row.classList.add('row--selected');

    const file = selectedFile();
    el.viewerHead.classList.remove('hidden');
    el.viewerPath.textContent = file.source;
    el.viewerPath.title = file.source;
    const hasContent = file.content !== null;
    el.viewerSize.textContent = hasContent ? formatSize(file.content.length) : '';
    el.fileCopy.disabled = !hasContent;
    el.fileDownload.disabled = !hasContent;
    el.viewerCode.classList.toggle('hidden', !hasContent);
    el.viewerEmpty.classList.toggle('hidden', hasContent);
    if (hasContent) {
      el.viewerCode.textContent = file.content;
      el.viewerCode.scrollTop = 0;
    } else {
      el.viewerEmpty.textContent =
        'This map lists the file but doesn\'t include its source code.';
    }
  }

  el.fileCopy.addEventListener('click', async () => {
    const file = selectedFile();
    if (!file || file.content === null) return;
    await navigator.clipboard.writeText(file.content);
    el.fileCopy.textContent = 'Copied!';
    setTimeout(() => (el.fileCopy.textContent = 'Copy'), 1500);
  });

  el.fileDownload.addEventListener('click', () => {
    const file = selectedFile();
    if (!file || file.content === null) return;
    download(
      new Blob([file.content], { type: 'text/plain' }),
      file.path.split('/').pop()
    );
  });

  // ── ZIP export ──

  /**
   * Maps "Download all" exports: as in the popup's Copy and Export.
   */
  function includedEntries() {
    return data.entries.filter(
      (e) =>
        !skippedHosts.has(SourcemapUtils.hostOf(e.resourceUrl)) &&
        (!onlyExposed || e.status === 'exposed')
    );
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    // Revoking straight away can cancel the download in Firefox
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function runLimited(items, limit, fn) {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  /**
   * ZIP folder for a map: <resource host>/<map file name>, unique per archive.
   */
  function zipFolder(entry, used) {
    const host = SourcemapUtils.hostOf(entry.resourceUrl) || 'page';
    const name = entry.isDataUri
      ? SourcemapUtils.getDisplayLabel(entry.resourceUrl) + '.inline-map'
      : SourcemapUtils.getDisplayLabel(entry.sourcemapUrl);
    const base = SourcemapUtils.sanitizeSourcePath(host + '/' + name);
    let folder = base;
    for (let n = 2; used.has(folder); n++) folder = base + '~' + n;
    used.add(folder);
    return folder;
  }

  async function exportZip(entries, baseName) {
    if (exporting || entries.length === 0) return;
    exporting = true;
    render();

    const zip = SourceZip.writer();
    const used = new Set();
    const jobs = entries.map((entry) => ({ entry, folder: zipFolder(entry, used) }));
    const report = [];
    let done = 0;
    let written = 0;
    el.progress.textContent = 'Fetching 0/' + jobs.length + '…';

    try {
      await runLimited(jobs, ZIP_CONCURRENCY, async ({ entry, folder }, i) => {
        const state = await loadMap(entry);
        const lines = [
          folder + '/',
          '  Map: ' + (entry.isDataUri ? '[inline data URI]' : entry.sourcemapUrl),
          '  Resource: ' + entry.resourceUrl,
        ];
        if (state.status === 'error') {
          lines.push('  Error: ' + state.error);
        } else {
          const missing = [];
          let count = 0;
          for (const file of state.files) {
            if (file.content === null) {
              missing.push(file.source);
              continue;
            }
            await zip.add(folder + '/' + file.path, file.content);
            count++;
          }
          written += count;
          lines.push(
            '  Files: ' + count +
            (missing.length ? ', ' + missing.length + ' listed without source' : '')
          );
          for (const source of missing) lines.push('  No source: ' + source);
        }
        report[i] = lines.join('\n');
        done++;
        el.progress.textContent = 'Fetching ' + done + '/' + jobs.length + '…';
      });

      if (written === 0) {
        el.progress.textContent = 'No source files to export';
        return;
      }
      const header =
        '# Sourcemap Detector source export\n' +
        '# Page: ' + (data.url || 'unknown') + '\n' +
        '# Date: ' + new Date().toISOString() + '\n\n';
      await zip.add('index.txt', header + report.join('\n\n') + '\n');

      el.progress.textContent = 'Building ZIP…';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      download(
        zip.finish(),
        (baseName + '-' + stamp).replace(/[^\w.-]+/g, '_') + '.zip'
      );
      el.progress.textContent =
        'Saved ' + written + ' files from ' + jobs.length +
        (jobs.length === 1 ? ' map' : ' maps');
    } catch (e) {
      el.progress.textContent = 'ZIP failed: ' + e.message;
    } finally {
      exporting = false;
      render();
    }
  }

  el.zipAll.addEventListener('click', () => {
    let host = 'page';
    try {
      host = new URL(data.url).hostname || host;
    } catch (e) {}
    exportZip(includedEntries(), 'sources-' + host);
  });

  // ── Live updates ──

  let reloadTimer = null;

  api.runtime.onMessage.addListener((message) => {
    if (message.type !== 'TAB_DATA_UPDATED' || message.tabId !== tabId) return;
    // Pages can report many maps in a burst
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadData().then(render), 250);
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.skippedHosts || changes.onlyExposed)) {
      loadSettings().then(render);
    }
  });

  // ── Init ──

  if (!Number.isInteger(tabId)) {
    addSpan(el.tree, 'tree__empty', 'Open the explorer from the extension popup.');
    return;
  }
  Promise.all([loadData(), loadSettings()]).then(render);
})();
