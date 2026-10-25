const SOURCEMAP_CONSTANTS = {
  // HTTP response headers that indicate a sourcemap (matched case-insensitively)
  HEADERS: ['sourcemap', 'x-sourcemap'],

  // Regex for JS sourceMappingURL comments
  // Matches: //# sourceMappingURL=<url>  and  //@ sourceMappingURL=<url>
  JS_SOURCEMAP_REGEX: /\/\/[#@]\s*sourceMappingURL=(\S+)/g,

  // Regex for CSS sourceMappingURL comments
  // Matches: /*# sourceMappingURL=<url> */  and  /*@ sourceMappingURL=<url> */
  CSS_SOURCEMAP_REGEX: /\/\*[#@]\s*sourceMappingURL=(\S+?)\s*\*\//g,

  // How many "sourceMappingURL=" occurrences to try, from the end of a file,
  // before giving up (later ones may sit inside string literals)
  MAX_DIRECTIVE_CANDIDATES: 20,

  // Resource types to monitor via webRequest
  RESOURCE_TYPES: ['script', 'stylesheet'],

  // Badge color when at least one sourcemap is confirmed reachable
  BADGE_COLOR_FOUND: '#e53e3e',

  // Badge color when sourcemaps are referenced but none are confirmed reachable
  BADGE_COLOR_REFERENCED: '#718096',

  // Maximum number of sourcemap verification results kept in memory
  VERIFY_CACHE_MAX: 500,

  // How long a verification result is reused before checking again
  VERIFY_CACHE_TTL_MS: 5 * 60 * 1000,

  // Limits for the extension's own downloads
  FETCH_CONCURRENCY: 6,
  FETCH_QUEUE_MAX: 200,
  FETCH_TIMEOUT_MS: 15000,
  MAX_RESOURCE_BYTES: 20 * 1024 * 1024,
  MAX_SOURCEMAP_BYTES: 30 * 1024 * 1024,

  // Bound on tracked in-flight requests, in case some never complete
  REQUEST_TRACKING_MAX: 2000,

  // Bounds per tab, which matter when Preserve log keeps results across pages
  MAX_TAB_ENTRIES: 2000,
  MAX_SCANNED_URLS: 5000,
};
