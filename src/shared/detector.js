const SourcemapDetector = {
  /**
   * Scan response headers for SourceMap or X-SourceMap headers.
   * @param {Array} headers - Array of {name, value} header objects
   * @param {string} resourceUrl - The URL of the resource
   * @returns {Array} Detected sourcemap entries
   */
  scanHeaders(headers, resourceUrl) {
    const results = [];
    if (!headers) return results;

    for (const header of headers) {
      const name = header.name.toLowerCase();
      if (SOURCEMAP_CONSTANTS.HEADERS.includes(name)) {
        const sourcemapUrl = SourcemapUtils.resolveUrl(
          header.value.trim(),
          resourceUrl
        );
        results.push({
          sourcemapUrl,
          resourceUrl,
          source: 'header',
          headerName: header.name,
          timestamp: Date.now(),
        });
      }
    }
    return results;
  },

  /**
   * Scan text content for sourceMappingURL directives.
   * Only checks the last 1KB since sourceMappingURL is always at the end.
   * @param {string} content - The file content
   * @param {string} resourceUrl - The URL of the resource
   * @param {string} type - 'script' or 'stylesheet'
   * @returns {Array} Detected sourcemap entries
   */
  scanContent(content, resourceUrl, type) {
    const results = [];
    if (!content) return results;

    // sourceMappingURL is always near the end of a file
    const tail = content.length > 1024 ? content.slice(-1024) : content;

    const regex =
      type === 'stylesheet'
        ? new RegExp(SOURCEMAP_CONSTANTS.CSS_SOURCEMAP_REGEX.source, 'g')
        : new RegExp(SOURCEMAP_CONSTANTS.JS_SOURCEMAP_REGEX.source, 'g');

    let match;
    while ((match = regex.exec(tail)) !== null) {
      const rawUrl = match[1];
      const sourcemapUrl = SourcemapUtils.resolveUrl(rawUrl, resourceUrl);
      results.push({
        sourcemapUrl,
        resourceUrl,
        source: 'comment',
        type,
        isDataUri: SourcemapUtils.isDataUri(rawUrl),
        timestamp: Date.now(),
      });
    }
    return results;
  },
};
