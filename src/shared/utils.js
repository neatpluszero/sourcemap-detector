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
    let map;
    try {
      map = JSON.parse(text.replace(/^\)\]\}'[^\n]*\n/, ''));
    } catch (e) {
      return { status: 'invalid' };
    }
    if (!map || typeof map !== 'object') return { status: 'invalid' };

    const isMap = (m) =>
      !!m &&
      typeof m === 'object' &&
      Array.isArray(m.sources) &&
      typeof m.mappings === 'string';

    // Index maps nest regular maps under sections[].map
    const maps = Array.isArray(map.sections)
      ? map.sections.map((s) => s && s.map).filter(Boolean)
      : [map];
    if (maps.length === 0 || !maps.every(isMap)) {
      return { status: 'invalid' };
    }

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
   * Decode and inspect an inline data URI sourcemap.
   * @returns {object} inspectSourcemap result plus dataUriLength and dataUriHash
   */
  inspectDataUri(url) {
    const info = {
      dataUriLength: url.length,
      dataUriHash: SourcemapUtils.hash(url),
    };
    const comma = url.indexOf(',');
    let text = null;
    if (comma !== -1) {
      const meta = url.slice(5, comma);
      const payload = url.slice(comma + 1);
      try {
        text = /;base64$/i.test(meta)
          ? atob(payload)
          : decodeURIComponent(payload);
      } catch (e) {}
    }
    return Object.assign(
      info,
      text === null ? { status: 'invalid' } : SourcemapUtils.inspectSourcemap(text)
    );
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
