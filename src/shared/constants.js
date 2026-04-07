const SOURCEMAP_CONSTANTS = {
  // HTTP response headers that indicate a sourcemap (matched case-insensitively)
  HEADERS: ['sourcemap', 'x-sourcemap'],

  // Regex for JS sourceMappingURL comments
  // Matches: //# sourceMappingURL=<url>  and  //@ sourceMappingURL=<url>
  JS_SOURCEMAP_REGEX: /\/\/[#@]\s*sourceMappingURL=(\S+)/g,

  // Regex for CSS sourceMappingURL comments
  // Matches: /*# sourceMappingURL=<url> */  and  /*@ sourceMappingURL=<url> */
  CSS_SOURCEMAP_REGEX: /\/\*[#@]\s*sourceMappingURL=(\S+?)\s*\*\//g,

  // Resource types to monitor via webRequest
  RESOURCE_TYPES: ['script', 'stylesheet'],

  // Badge color when sourcemaps are detected
  BADGE_COLOR_FOUND: '#e53e3e',
};
