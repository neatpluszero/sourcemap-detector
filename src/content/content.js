(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  /**
   * Guess the resource type of a performance entry, or null if it isn't a
   * script or stylesheet. CSS-initiated entries also include fonts and images.
   */
  function resourceTypeOf(entry) {
    if (entry.initiatorType === 'script') return 'script';
    let pathname;
    try {
      pathname = new URL(entry.name).pathname;
    } catch (e) {
      return null;
    }
    if (/\.css$/i.test(pathname)) return 'stylesheet';
    if (/\.m?js$/i.test(pathname)) return 'script';
    return null;
  }

  /**
   * Whether a <script src> element is one the browser actually runs: not a
   * data block (type="application/json" etc.), not nomodule in a browser
   * with module support, and not an empty src resolving to the page itself.
   */
  function isExecutedScript(el) {
    if (el.noModule || el.src === location.href) return false;
    const type = (el.getAttribute('type') || '').trim().toLowerCase();
    return (
      type === '' ||
      type === 'module' ||
      /^(text|application)\/(x-)?(java|ecma)script$/.test(type)
    );
  }

  /**
   * External scripts and stylesheets the page uses. The background fetches and
   * scans them; it also sees them through webRequest, except for those served
   * from the renderer's memory cache.
   */
  function collectResources(performanceEntries) {
    const resources = [];
    for (const el of document.querySelectorAll('script[src]')) {
      if (isExecutedScript(el)) resources.push({ url: el.src, type: 'script' });
    }
    for (const el of document.querySelectorAll('link[rel="stylesheet"][href]')) {
      resources.push({ url: el.href, type: 'stylesheet' });
    }
    for (const entry of performanceEntries) {
      const type = resourceTypeOf(entry);
      if (type) resources.push({ url: entry.name, type });
    }
    return resources;
  }

  /**
   * Scan inline scripts and styles on the page.
   */
  function scanInline() {
    const allEntries = [];

    const inlineBlocks = [
      ...Array.from(document.querySelectorAll('script:not([src])'), (el) => [
        el,
        'script',
      ]),
      ...Array.from(document.querySelectorAll('style'), (el) => [
        el,
        'stylesheet',
      ]),
    ];

    for (const [el, type] of inlineBlocks) {
      if (el.textContent) {
        const entries = SourcemapDetector.scanContent(
          el.textContent,
          window.location.href,
          type
        );
        // Inline blocks can't be fetched again later, e.g. by the explorer
        for (const entry of entries) entry.inline = true;
        allEntries.push(...entries);
      }
    }
    return allEntries;
  }

  let observer = null;

  function report(entries, resources) {
    if (entries.length === 0 && resources.length === 0) return;
    try {
      const sent = api.runtime.sendMessage({
        type: 'CONTENT_SCAN',
        pageUrl: location.href,
        entries,
        resources,
      });
      if (sent && sent.catch) sent.catch(() => {});
    } catch (e) {
      // The extension was reloaded or updated; this script is orphaned
      if (observer) observer.disconnect();
    }
  }

  function scanPage() {
    report(
      scanInline(),
      collectResources(performance.getEntriesByType('resource'))
    );
  }

  scanPage();

  // Resources loaded later, e.g. lazily imported chunks
  observer = new PerformanceObserver((list) => {
    const resources = [];
    for (const entry of list.getEntries()) {
      const type = resourceTypeOf(entry);
      if (type) resources.push({ url: entry.name, type });
    }
    report([], resources);
  });
  observer.observe({ type: 'resource' });

  // A back/forward cache restore resets the tab's results in the background
  // without reloading anything, so scan again
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) scanPage();
  });
})();
