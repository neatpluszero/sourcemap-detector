/**
 * Minimal ZIP writer for exporting source files. Files are deflated with
 * CompressionStream where the browser has it, and stored otherwise. No ZIP64,
 * so archives are limited to 4 GB and 65,535 files.
 */
const SourceZip = {
  MAX_FILES: 0xffff,
  MAX_BYTES: 0xffffffff,

  crcTable: null,

  crc32(bytes) {
    if (!SourceZip.crcTable) {
      SourceZip.crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        SourceZip.crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = SourceZip.crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  },

  /**
   * Raw deflate, or null when the browser can't compress.
   */
  async deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([bytes])
        .stream()
        .pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      return null;
    }
  },

  /**
   * Start an archive. Add files with add(path, content), then call finish()
   * for the Blob. Duplicate paths get a ~2, ~3, ... suffix before the
   * extension.
   */
  writer(date = new Date()) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    const used = new Set();
    let offset = 0;

    const time =
      (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day =
      ((Math.max(date.getFullYear(), 1980) - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate();

    function uniquePath(path) {
      if (!used.has(path)) return path;
      const dot = path.lastIndexOf('.');
      const slash = path.lastIndexOf('/');
      const [stem, ext] =
        dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
      let n = 2;
      while (used.has(stem + '~' + n + ext)) n++;
      return stem + '~' + n + ext;
    }

    // Shared by the local header (30 bytes) and central directory entry (46)
    function header(size, signature, entry) {
      const buf = new Uint8Array(size);
      const view = new DataView(buf.buffer);
      view.setUint32(0, signature, true);
      let p = 4;
      if (signature === 0x02014b50) {
        view.setUint16(p, 20, true); // version made by
        p += 2;
      }
      view.setUint16(p, 20, true); // version needed
      view.setUint16(p + 2, 0x0800, true); // UTF-8 names
      view.setUint16(p + 4, entry.method, true);
      view.setUint16(p + 6, time, true);
      view.setUint16(p + 8, day, true);
      view.setUint32(p + 10, entry.crc, true);
      view.setUint32(p + 14, entry.compressedSize, true);
      view.setUint32(p + 18, entry.size, true);
      view.setUint16(p + 22, entry.name.length, true);
      if (signature === 0x02014b50) {
        view.setUint32(p + 36, entry.offset, true); // local header offset
      }
      buf.set(entry.name, size - entry.name.length);
      return buf;
    }

    return {
      get count() {
        return central.length;
      },

      /**
       * @returns {Promise<string>} The path the file was stored under
       */
      async add(path, content) {
        if (central.length >= SourceZip.MAX_FILES) {
          throw new Error('Too many files for a ZIP (over 65,535)');
        }
        path = uniquePath(path);
        used.add(path);

        const data = typeof content === 'string' ? encoder.encode(content) : content;
        const deflated = await SourceZip.deflate(data);
        const compressed =
          deflated && deflated.length < data.length ? deflated : data;
        const nameBytes = encoder.encode(path);
        const entry = {
          name: nameBytes,
          method: compressed === data ? 0 : 8,
          crc: SourceZip.crc32(data),
          size: data.length,
          compressedSize: compressed.length,
          offset,
        };

        const local = header(30 + nameBytes.length, 0x04034b50, entry);
        if (offset + local.length + compressed.length > SourceZip.MAX_BYTES) {
          throw new Error('ZIP would be larger than 4 GB');
        }
        parts.push(local, compressed);
        offset += local.length + compressed.length;
        central.push(entry);
        return path;
      },

      finish() {
        const directory = central.map((entry) =>
          header(46 + entry.name.length, 0x02014b50, entry)
        );
        const directorySize = directory.reduce((n, b) => n + b.length, 0);

        const end = new Uint8Array(22);
        const view = new DataView(end.buffer);
        view.setUint32(0, 0x06054b50, true);
        view.setUint16(8, central.length, true);
        view.setUint16(10, central.length, true);
        view.setUint32(12, directorySize, true);
        view.setUint32(16, offset, true);

        return new Blob([...parts, ...directory, end], { type: 'application/zip' });
      },
    };
  },
};
