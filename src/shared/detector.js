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
   * Scan text content for a sourceMappingURL directive.
   * Only the last directive counts, since it is always at the end of a file.
   * @param {string} content - The file content
   * @param {string} resourceUrl - The URL of the resource
   * @param {string} type - 'script' or 'stylesheet'
   * @returns {Array} Detected sourcemap entries
   */
  scanContent(content, resourceUrl, type) {
    const rawUrl = this.findDirectiveUrl(content, type);
    return rawUrl === null
      ? []
      : [this.createCommentEntry(rawUrl, resourceUrl, type)];
  },

  /**
   * Find the last sourceMappingURL directive in a file.
   * @returns {string|null} The raw URL, untruncated, or null if there is none
   */
  findDirectiveUrl(content, type) {
    if (!content) return null;

    const regex = new RegExp(
      '^' +
        (type === 'stylesheet'
          ? SOURCEMAP_CONSTANTS.CSS_SOURCEMAP_REGEX
          : SOURCEMAP_CONSTANTS.JS_SOURCEMAP_REGEX
        ).source
    );

    // Search back from the end for the directive itself rather than scanning
    // a fixed-size tail: inline data URI maps are often far longer than any
    // tail window. Try earlier occurrences when a later one isn't a comment,
    // e.g. sourcemap tooling bundled into the file.
    let from = content.length;
    for (let i = 0; i < SOURCEMAP_CONSTANTS.MAX_DIRECTIVE_CANDIDATES; i++) {
      const index = content.lastIndexOf('sourceMappingURL=', from);
      if (index === -1) break;

      const commentStart = Math.max(
        content.lastIndexOf('//', index),
        content.lastIndexOf('/*', index)
      );
      const match =
        commentStart === -1 ? null : regex.exec(content.slice(commentStart));
      if (match) return match[1];

      if (index === 0) break;
      from = index - 1;
    }
    return null;
  },

  createCommentEntry(rawUrl, resourceUrl, type) {
    const isDataUri = SourcemapUtils.isDataUri(rawUrl);
    const entry = {
      // Inline maps can be megabytes long, so keep only the media type prefix
      sourcemapUrl: isDataUri
        ? SourcemapUtils.truncateDataUri(rawUrl)
        : SourcemapUtils.resolveUrl(rawUrl, resourceUrl),
      resourceUrl,
      source: 'comment',
      type,
      isDataUri,
      timestamp: Date.now(),
    };
    // Inline maps are inspected now, while the payload is still available
    if (isDataUri) Object.assign(entry, SourcemapUtils.inspectDataUri(rawUrl));
    return entry;
  },
};
