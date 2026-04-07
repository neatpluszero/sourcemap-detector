const SourcemapUtils = {
  /**
   * Resolve a sourcemap URL relative to the resource that referenced it.
   */
  resolveUrl(sourcemapUrl, baseResourceUrl) {
    if (!sourcemapUrl || sourcemapUrl.startsWith('data:')) {
      return sourcemapUrl;
    }
    try {
      return new URL(sourcemapUrl, baseResourceUrl).href;
    } catch (e) {
      return sourcemapUrl;
    }
  },

  /**
   * Check if a URL is a data URI (inline sourcemap).
   */
  isDataUri(url) {
    return url && url.startsWith('data:');
  },

  /**
   * Create a concise display label from a URL.
   */
  getDisplayLabel(url) {
    if (!url) return '';
    if (SourcemapUtils.isDataUri(url)) {
      return '[inline data URI]';
    }
    try {
      const parsed = new URL(url);
      return parsed.pathname.split('/').pop() || url;
    } catch (e) {
      return url;
    }
  },

  /**
   * Deduplicate sourcemap entries by sourcemapUrl.
   */
  deduplicateEntries(entries) {
    const seen = new Map();
    for (const entry of entries) {
      const key = entry.sourcemapUrl;
      if (!seen.has(key)) {
        seen.set(key, entry);
      }
    }
    return Array.from(seen.values());
  },
};
