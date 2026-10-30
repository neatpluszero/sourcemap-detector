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
    return !!url && url.startsWith('data:');
  },

  /**
   * Shorten a data URI to its media type prefix, e.g. "data:application/json;base64,".
   */
  truncateDataUri(url) {
    const comma = url.indexOf(',');
    return comma === -1 ? url.slice(0, 64) : url.slice(0, comma + 1);
  },

  /**
   * FNV-1a hash of a string, as 8 hex digits.
   */
  hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
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
   * Inspect a fetched sourcemap body.
   * @returns {object} { status: 'exposed', sourceCount, hasSourcesContent } or { status: 'invalid' }
   */
  inspectSourcemap(text) {
    const map = SourcemapUtils.parseSourcemap(text);
    if (!map) return { status: 'invalid' };
    const maps = Array.isArray(map.sections)
      ? map.sections.map((s) => s.map)
      : [map];

    let sourceCount = 0;
    let hasSourcesContent = false;
    for (const m of maps) {
      sourceCount += m.sources.length;
      if (Array.isArray(m.sourcesContent) && m.sourcesContent.some((c) => c)) {
        hasSourcesContent = true;
      }
    }
    return { status: 'exposed', sourceCount, hasSourcesContent };
  },

  /**
   * Parse a sourcemap body.
   * @returns {object|null} The parsed map, or null if it isn't a valid sourcemap
   */
  parseSourcemap(text) {
    let map;
    try {
      map = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, ''));
    } catch (e) {
      return null;
    }
    if (!map || typeof map !== 'object') return null;

    const isMap = (m) =>
      !!m &&
      typeof m === 'object' &&
      Array.isArray(m.sources) &&
      typeof m.mappings === 'string';

    // Index maps nest regular maps under sections[].map
    if (Array.isArray(map.sections)) {
      return map.sections.length > 0 &&
        map.sections.every((s) => s && isMap(s.map))
        ? map
        : null;
    }
    return isMap(map) ? map : null;
  },

  /**
   * Label and style class for an entry's verification status.
   * @returns {object} { className, text }
   */
  statusBadge(entry) {
    switch (entry.status) {
      case 'exposed': {
        let text =
          (entry.isDataUri ? 'Embedded · ' : 'Exposed · ') +
          entry.sourceCount + ' sources';
        if (entry.hasSourcesContent) text += ' + code';
        return { className: 'status--exposed', text };
      }
      case 'unreachable':
        return { className: 'status--safe', text: 'HTTP ' + entry.httpStatus };
      case 'invalid':
        return { className: 'status--safe', text: 'Not a sourcemap' };
      case 'redirect':
        return { className: 'status--safe', text: 'Redirects (not followed)' };
      case 'toolarge':
        return { className: 'status--safe', text: 'Too large to check' };
      case 'skipped':
        return { className: 'status--pending', text: 'Not checked (private host)' };
      case 'error':
        return { className: 'status--safe', text: 'Fetch failed' };
      default:
        return { className: 'status--pending', text: 'Checking…' };
    }
  },

  /**
   * Decode and inspect an inline data URI sourcemap.
   * @returns {object} inspectSourcemap result plus dataUriLength and dataUriHash
   */
  inspectDataUri(url) {
    const info = {
      dataUriLength: url.length,
      dataUriHash: SourcemapUtils.hash(url),
    };
    const text = SourcemapUtils.decodeDataUri(url);
    return Object.assign(
      info,
      text === null ? { status: 'invalid' } : SourcemapUtils.inspectSourcemap(text)
    );
  },

  /**
   * Text of a base64 or percent-encoded data URI, or null if it can't be decoded.
   */
  decodeDataUri(url) {
    const comma = url.indexOf(',');
    if (comma === -1) return null;
    const meta = url.slice(5, comma);
    const payload = url.slice(comma + 1);
    try {
      if (!/;base64$/i.test(meta)) return decodeURIComponent(payload);
      // atob gives one character per byte; decode those bytes as UTF-8
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (e) {
      return null;
    }
  },

  /**
   * The original source files in a parsed sourcemap, including those nested
   * in an index map's sections.
   * @returns {Array} [{ source, path, content }] where path is safe to use as
   *   a file path and content is null when the map doesn't include it
   */
  listSources(map) {
    const maps = Array.isArray(map.sections)
      ? map.sections.map((s) => s && s.map).filter(Boolean)
      : [map];
    const files = [];
    for (const m of maps) {
      if (!Array.isArray(m.sources)) continue;
      const root = typeof m.sourceRoot === 'string' ? m.sourceRoot : '';
      const contents = Array.isArray(m.sourcesContent) ? m.sourcesContent : [];
      m.sources.forEach((source, i) => {
        if (typeof source !== 'string' || source === '') return;
        // sourceRoot applies only to relative sources
        const full =
          root && !/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith('/')
            ? root.replace(/\/?$/, '/') + source
            : source;
        const content = contents[i];
        files.push({
          source: full,
          path: SourcemapUtils.sanitizeSourcePath(full),
          content: typeof content === 'string' ? content : null,
        });
      });
    }
    return files;
  },

  /**
   * Turn a source path from a sourcemap into a relative file path that can't
   * escape its folder, e.g. "webpack://app/./src/../a.vue?4c2f" becomes
   * "webpack/app/a.vue". Sourcemaps come from untrusted sites.
   */
  sanitizeSourcePath(source) {
    const path = String(source || '')
      // Keep the scheme as a folder: webpack://app/x -> webpack/app/x
      .replace(/^([a-z][a-z0-9+.-]*):\/*/i, '$1/')
      // Webpack appends ?hash to some module ids
      .replace(/[?#].*$/, '');

    const parts = [];
    for (const raw of path.split(/[\\/]+/)) {
      if (raw === '' || raw === '.') continue;
      if (raw === '..') {
        parts.pop();
        continue;
      }
      const part = raw
        .replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_')
        // Windows drops trailing dots and spaces from names
        .replace(/[. ]+$/, '')
        .slice(0, 200);
      if (part) parts.push(part);
    }
    return parts.length ? parts.join('/') : 'unnamed';
  },

  /**
   * Fetch a URL without cookies and read it as text, stopping at maxBytes.
   * Aborts the controller to stop an oversized download.
   * @returns {Promise<object>} { response, text }; text is null when the
   *   response isn't OK or exceeds maxBytes
   */
  async fetchLimited(url, init, maxBytes, controller) {
    const response = await fetch(url, {
      ...init,
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) return { response, text: null };

    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) {
      controller.abort();
      return { response, text: null };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        controller.abort();
        return { response, text: null };
      }
      text += decoder.decode(value, { stream: true });
    }
    return { response, text: text + decoder.decode() };
  },

  /**
   * Whether a hostname points at this machine or a private network.
   */
  isPrivateHost(hostname) {
    // Trailing dots are equivalent ("localhost."), so strip them first
    const host = hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      // Single-label names resolve on the local network
      (!host.includes('.') && !host.includes(':'))
    ) {
      return true;
    }

    const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
      const a = Number(ipv4[1]);
      const b = Number(ipv4[2]);
      return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
      );
    }

    if (host.includes(':')) {
      return (
        host === '::' ||
        host === '::1' ||
        host.startsWith('::ffff:') ||
        host.startsWith('64:ff9b:') ||
        /^ff/.test(host) ||
        /^f[cd]/.test(host) ||
        /^fe[89ab]/.test(host)
      );
    }
    return false;
  },

  /**
   * Whether the extension may fetch a URL found on a page. Only http(s) is
   * allowed, and private-network targets only from pages that are themselves
   * on a private network, so a page can't make the extension send requests
   * into the user's local network. This checks hostnames only: a public DNS
   * name that resolves to a private address still passes.
   */
  canFetch(url, pageUrl) {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      return false;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return false;
    }
    if (!SourcemapUtils.isPrivateHost(target.hostname)) return true;

    // The page must itself be an http(s) page on a private host. about:blank
    // and blob: pages have an empty hostname, which would otherwise count as
    // private, and a public page can create either.
    try {
      const page = new URL(pageUrl);
      return (
        (page.protocol === 'http:' || page.protocol === 'https:') &&
        page.hostname !== '' &&
        SourcemapUtils.isPrivateHost(page.hostname)
      );
    } catch (e) {
      return false;
    }
  },

  /**
   * Hostname of a URL, or '' if it has none.
   */
  hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return '';
    }
  },

  /**
   * The rule that skips a host: the host itself, or "*.parent" for the host
   * or any domain above it. Returns null when nothing skips it.
   * @param {string} host
   * @param {Set<string>} rules
   */
  skipRuleFor(host, rules) {
    if (!host) return null;
    if (rules.has(host)) return host;
    const labels = host.split('.');
    for (let i = 0; i < labels.length; i++) {
      const rule = '*.' + labels.slice(i).join('.');
      if (rules.has(rule)) return rule;
    }
    return null;
  },

  isHostSkipped(host, rules) {
    return SourcemapUtils.skipRuleFor(host, rules) !== null;
  },

  /**
   * The domain a host belongs to: its last two labels, or three for names
   * like example.co.uk. A guess without a public suffix list, so show the
   * result to the user before acting on it. Returns '' for IP addresses.
   */
  siteOf(host) {
    if (!host || host.includes(':') || /^[\d.]+$/.test(host)) return '';
    if (host.startsWith('[')) return '';
    const labels = host.split('.');
    const [second, tld] = labels.slice(-2);
    const count = tld && tld.length === 2 && second.length <= 3 ? 3 : 2;
    return labels.slice(-count).join('.');
  },

  /**
   * Rough same-site check on the last two hostname labels, e.g.
   * cdn.example.com and www.example.com. Not public-suffix aware, so it is
   * only used for labelling.
   */
  isSameSite(hostA, hostB) {
    const site = (host) => host.split('.').slice(-2).join('.');
    return !!hostA && !!hostB && site(hostA) === site(hostB);
  },

  /**
   * Group entries by the hostname of the resource that references each map.
   * Groups on the page's own site come first, then by size and name.
   * @returns {Array} [{ host, firstParty, entries }]
   */
  groupByHost(entries, pageUrl) {
    const pageHost = SourcemapUtils.hostOf(pageUrl);
    const groups = new Map();
    for (const entry of entries) {
      const host = SourcemapUtils.hostOf(entry.resourceUrl);
      if (!groups.has(host)) {
        groups.set(host, {
          host,
          firstParty: SourcemapUtils.isSameSite(host, pageHost),
          entries: [],
        });
      }
      groups.get(host).entries.push(entry);
    }
    return Array.from(groups.values()).sort(
      (a, b) =>
        b.firstParty - a.firstParty ||
        b.entries.length - a.entries.length ||
        a.host.localeCompare(b.host)
    );
  },

  /**
   * Deduplicate sourcemap entries, keeping the first occurrence.
   * Inline maps are keyed by the resource that embeds them and their content.
   */
  deduplicateEntries(entries) {
    const seen = new Map();
    for (const entry of entries) {
      const key = entry.isDataUri
        ? entry.resourceUrl + '#' + entry.dataUriHash
        : entry.sourcemapUrl;
      if (!seen.has(key)) {
        seen.set(key, entry);
      }
    }
    return Array.from(seen.values());
  },
};
