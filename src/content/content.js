(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  /**
   * Fetch a resource and scan it for sourcemap references.
   */
  async function scanResource(url, type) {
    try {
      const response = await fetch(url, { method: 'GET', credentials: 'omit' });
      if (!response.ok) return [];
      const text = await response.text();
      return SourcemapDetector.scanContent(text, url, type);
    } catch (e) {
      // CORS or network error — silently skip
      return [];
    }
  }

  /**
   * Scan all script and stylesheet resources on the page.
   */
  async function scanPage() {
    const allEntries = [];

    // External scripts
    const scripts = document.querySelectorAll('script[src]');
    const scriptPromises = Array.from(scripts).map((el) =>
      scanResource(el.src, 'script')
    );

    // External stylesheets
    const stylesheets = document.querySelectorAll(
      'link[rel="stylesheet"][href]'
    );
    const cssPromises = Array.from(stylesheets).map((el) =>
      scanResource(el.href, 'stylesheet')
    );

    // Inline scripts
    const inlineScripts = document.querySelectorAll('script:not([src])');
    for (const el of inlineScripts) {
      if (el.textContent) {
        const entries = SourcemapDetector.scanContent(
          el.textContent,
          window.location.href,
          'script'
        );
        allEntries.push(...entries);
      }
    }

    // Inline styles
    const inlineStyles = document.querySelectorAll('style');
    for (const el of inlineStyles) {
      if (el.textContent) {
        const entries = SourcemapDetector.scanContent(
          el.textContent,
          window.location.href,
          'stylesheet'
        );
        allEntries.push(...entries);
      }
    }

    // Await all fetches
    const results = await Promise.allSettled([
      ...scriptPromises,
      ...cssPromises,
    ]);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allEntries.push(...result.value);
      }
    }

    if (allEntries.length > 0) {
      api.runtime.sendMessage({
        type: 'CONTENT_SOURCEMAPS_FOUND',
        entries: allEntries,
      });
    }
  }

  scanPage();
})();
