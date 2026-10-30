'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The shared modules are plain scripts declaring globals, as loaded by the
// extension, so evaluate them together and pull the objects out.
const source = ['constants.js', 'utils.js', 'detector.js', 'zip.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', f), 'utf-8'))
  .join('\n');
const { SourcemapDetector, SourcemapUtils, SourceZip } = vm.runInNewContext(
  source + '\n({ SourcemapDetector, SourcemapUtils, SourceZip });',
  { URL, atob, TextDecoder, TextEncoder, Blob, Response, CompressionStream }
);

// Objects from the vm context have a different Object prototype
const plain = (value) => JSON.parse(JSON.stringify(value));

const JS_URL = 'https://cdn.example.com/assets/app.js';
const CSS_URL = 'https://cdn.example.com/assets/app.css';
const MAP = { version: 3, sources: ['a.ts', 'b.ts'], sourcesContent: ['x', null], mappings: 'AAAA' };
const dataUri = (map) =>
  'data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64');

test('detects a JS sourceMappingURL comment and resolves it', () => {
  const [entry] = SourcemapDetector.scanContent(
    'console.log(1);\n//# sourceMappingURL=app.js.map\n',
    JS_URL,
    'script'
  );
  assert.strictEqual(entry.sourcemapUrl, 'https://cdn.example.com/assets/app.js.map');
  assert.strictEqual(entry.source, 'comment');
  assert.strictEqual(entry.isDataUri, false);
});

test('accepts the legacy //@ form and wide whitespace', () => {
  const entries = SourcemapDetector.scanContent('x\n//@ sourceMappingURL=/m.map', JS_URL, 'script');
  assert.strictEqual(entries[0].sourcemapUrl, 'https://cdn.example.com/m.map');

  const spaced = ' '.repeat(40);
  assert.strictEqual(
    SourcemapDetector.scanContent('x\n//#' + spaced + 'sourceMappingURL=a.map', JS_URL, 'script').length,
    1
  );
  assert.strictEqual(
    SourcemapDetector.scanContent('a{}\n/*#' + spaced + 'sourceMappingURL=a.map */', CSS_URL, 'stylesheet').length,
    1
  );
});

test('detects a CSS sourceMappingURL comment', () => {
  const [entry] = SourcemapDetector.scanContent(
    'a{color:red}\n/*# sourceMappingURL=app.css.map */',
    CSS_URL,
    'stylesheet'
  );
  assert.strictEqual(entry.sourcemapUrl, 'https://cdn.example.com/assets/app.css.map');
});

test('only the last directive counts, even when both are near the end', () => {
  const content = 'a();\n//# sourceMappingURL=old.map\nb();\n//# sourceMappingURL=new.map';
  const entries = SourcemapDetector.scanContent(content, JS_URL, 'script');
  assert.strictEqual(entries.length, 1);
  assert.match(entries[0].sourcemapUrl, /new\.map$/);
});

test('a later occurrence inside a string does not hide the real directive', () => {
  const content =
    'x();\n//# sourceMappingURL=real.map\nvar s = "a // " + "sourceMappingURL=" + url;';
  const entries = SourcemapDetector.scanContent(content, JS_URL, 'script');
  assert.strictEqual(entries.length, 1);
  assert.match(entries[0].sourcemapUrl, /real\.map$/);
});

test('returns nothing without a directive', () => {
  assert.deepStrictEqual(plain(SourcemapDetector.scanContent('var a = 1;', JS_URL, 'script')), []);
  assert.deepStrictEqual(plain(SourcemapDetector.scanContent('', JS_URL, 'script')), []);
  assert.deepStrictEqual(
    plain(SourcemapDetector.scanContent('var s = "sourceMappingURL=x";', JS_URL, 'script')),
    []
  );
});

test('detects, validates and truncates inline data URI maps longer than 1 KB', () => {
  const uri = dataUri({ ...MAP, sourcesContent: ['x'.repeat(50000)] });
  const [entry] = SourcemapDetector.scanContent('code();\n//# sourceMappingURL=' + uri, JS_URL, 'script');
  assert.strictEqual(entry.isDataUri, true);
  assert.strictEqual(entry.sourcemapUrl, 'data:application/json;base64,');
  assert.strictEqual(entry.dataUriLength, uri.length);
  assert.strictEqual(entry.status, 'exposed');
  assert.strictEqual(entry.sourceCount, 2);
  assert.strictEqual(entry.hasSourcesContent, true);
});

test('marks undecodable or non-sourcemap data URIs invalid', () => {
  for (const uri of ['data:application/json;base64,!!!notbase64', 'data:application/json,%7B%7D']) {
    const [entry] = SourcemapDetector.scanContent('//# sourceMappingURL=' + uri, JS_URL, 'script');
    assert.strictEqual(entry.status, 'invalid', uri);
  }
});

test('detects SourceMap and X-SourceMap headers case-insensitively', () => {
  const entries = SourcemapDetector.scanHeaders(
    [
      { name: 'Content-Type', value: 'text/javascript' },
      { name: 'SourceMap', value: ' /maps/app.js.map ' },
      { name: 'x-sourcemap', value: 'https://other.example/app.map' },
    ],
    JS_URL
  );
  assert.deepStrictEqual(
    plain(entries.map((e) => e.sourcemapUrl)),
    ['https://cdn.example.com/maps/app.js.map', 'https://other.example/app.map']
  );
  assert.strictEqual(entries[0].headerName, 'SourceMap');
});

test('inspectSourcemap recognises regular and index maps', () => {
  assert.deepStrictEqual(plain(SourcemapUtils.inspectSourcemap(JSON.stringify(MAP))), {
    status: 'exposed',
    sourceCount: 2,
    hasSourcesContent: true,
  });
  assert.deepStrictEqual(
    plain(
      SourcemapUtils.inspectSourcemap(
        ")]}'\n" +
          JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: ['a.ts'], mappings: '' } }] })
      )
    ),
    { status: 'exposed', sourceCount: 1, hasSourcesContent: false }
  );
});

test('inspectSourcemap rejects soft 404 pages and incomplete JSON', () => {
  for (const body of [
    '<!doctype html><p>Not found',
    '{"error":"nope"}',
    'null',
    '{"sources":[]}',
    '{"version":3,"sections":[]}',
  ]) {
    assert.strictEqual(SourcemapUtils.inspectSourcemap(body).status, 'invalid', body);
  }
});

test('deduplicateEntries keeps distinct inline maps of equal length on one page', () => {
  const page = 'https://a/';
  const scan = (map) => SourcemapDetector.scanContent('//# sourceMappingURL=' + dataUri(map), page, 'script')[0];
  const first = scan({ ...MAP, mappings: 'AAAA' });
  const second = scan({ ...MAP, mappings: 'BBBB' });
  assert.strictEqual(first.dataUriLength, second.dataUriLength);

  const entries = SourcemapUtils.deduplicateEntries([
    { sourcemapUrl: 'https://a/x.map', resourceUrl: 'https://a/x.js' },
    { sourcemapUrl: 'https://a/x.map', resourceUrl: 'https://a/x.js' },
    first,
    second,
    scan({ ...MAP, mappings: 'AAAA' }),
  ]);
  assert.strictEqual(entries.length, 3);
});

test('isPrivateHost', () => {
  for (const host of ['localhost', 'app.localhost', 'printer.local', 'intranet', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', '198.18.0.1', '239.1.1.1', 'localhost.', '[::1]', '[fd00::1]', '[ff02::1]', '[64:ff9b::7f00:1]']) {
    assert.strictEqual(SourcemapUtils.isPrivateHost(host), true, host);
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '[2001:db8::1]']) {
    assert.strictEqual(SourcemapUtils.isPrivateHost(host), false, host);
  }
});

test('canFetch blocks private targets from public pages only', () => {
  assert.strictEqual(SourcemapUtils.canFetch('https://cdn.example.com/a.map', 'https://example.com/'), true);
  assert.strictEqual(SourcemapUtils.canFetch('http://127.0.0.1/a.map', 'https://example.com/'), false);
  // URL parsing normalises numeric hosts, e.g. 2130706433 -> 127.0.0.1
  assert.strictEqual(SourcemapUtils.canFetch('http://2130706433/a.map', 'https://example.com/'), false);
  assert.strictEqual(SourcemapUtils.canFetch('http://localhost:3000/a.map', 'http://localhost:3000/'), true);
  assert.strictEqual(SourcemapUtils.canFetch('ftp://example.com/a.map', 'https://example.com/'), false);
  assert.strictEqual(SourcemapUtils.canFetch('http://intranet/a.map', ''), false);
  assert.strictEqual(SourcemapUtils.canFetch('http://localhost./a.map', 'https://example.com/'), false);
  assert.strictEqual(SourcemapUtils.canFetch('http://192.168.1.1/a.map', 'about:blank'), false);
  assert.strictEqual(SourcemapUtils.canFetch('http://192.168.1.1/a.map', 'blob:https://evil.example/0b1c'), false);
  assert.strictEqual(SourcemapUtils.canFetch('http://192.168.1.1/a.map', 'http://192.168.1.10/'), true);
});

test('groupByHost puts the page site first, then larger groups', () => {
  const entry = (resourceUrl) => ({ sourcemapUrl: resourceUrl + '.map', resourceUrl });
  const groups = SourcemapUtils.groupByHost(
    [
      entry('https://resources.digital-cloud.medallia.eu/a.js'),
      entry('https://resources.digital-cloud.medallia.eu/b.js'),
      entry('https://cdn.shop.example/app.js'),
      entry('https://other.example/x.js'),
      entry('https://other.example/y.js'),
      entry('https://other.example/z.js'),
    ],
    'https://www.shop.example/'
  );
  assert.deepStrictEqual(
    plain(groups.map((g) => [g.host, g.firstParty, g.entries.length])),
    [
      ['cdn.shop.example', true, 1],
      ['other.example', false, 3],
      ['resources.digital-cloud.medallia.eu', false, 2],
    ]
  );
});

test('findDirectiveUrl returns the full inline map', () => {
  const uri = dataUri({ ...MAP, sourcesContent: ['x'.repeat(5000), null] });
  const content = 'var a;\n//# sourceMappingURL=' + uri + '\n';
  assert.strictEqual(SourcemapDetector.findDirectiveUrl(content, 'script'), uri);
  assert.strictEqual(SourcemapDetector.findDirectiveUrl('var a;', 'script'), null);
});

test('decodeDataUri handles UTF-8 base64 and percent-encoding', () => {
  const text = '{"a":"héllo ✓"}';
  const b64 = 'data:application/json;base64,' + Buffer.from(text).toString('base64');
  assert.strictEqual(SourcemapUtils.decodeDataUri(b64), text);
  assert.strictEqual(
    SourcemapUtils.decodeDataUri('data:application/json,' + encodeURIComponent(text)),
    text
  );
  assert.strictEqual(SourcemapUtils.decodeDataUri('data:application/json;base64,%%%'), null);
});

test('sanitizeSourcePath keeps paths inside the export folder', () => {
  const cases = {
    'webpack://app/./src/index.ts': 'webpack/app/src/index.ts',
    'webpack:///src/App.vue?4c2f': 'webpack/src/App.vue',
    '../../../etc/passwd': 'etc/passwd',
    'src/../../secret.js': 'secret.js',
    '/abs/path.js': 'abs/path.js',
    'C:\\Users\\dev\\a.js': 'C/Users/dev/a.js',
    'https://cdn.example.com/lib/x.js': 'https/cdn.example.com/lib/x.js',
    'a/b<c>|d.js': 'a/b_c__d.js',
    'dir. /file.js': 'dir/file.js',
    '': 'unnamed',
    '..': 'unnamed',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.strictEqual(SourcemapUtils.sanitizeSourcePath(input), expected, input);
  }
});

test('listSources applies sourceRoot, reads index maps, tolerates short sourcesContent', () => {
  const files = plain(SourcemapUtils.listSources({
    sections: [
      { offset: { line: 0, column: 0 }, map: {
        version: 3, sourceRoot: 'webpack://app', sources: ['src/a.ts', 'webpack://other/b.ts', null, 'c.ts'],
        sourcesContent: ['A', null], mappings: '',
      } },
      { offset: { line: 1, column: 0 }, map: { version: 3, sources: ['d.css'], mappings: '' } },
    ],
  }));
  assert.deepStrictEqual(files, [
    { source: 'webpack://app/src/a.ts', path: 'webpack/app/src/a.ts', content: 'A' },
    { source: 'webpack://other/b.ts', path: 'webpack/other/b.ts', content: null },
    { source: 'webpack://app/c.ts', path: 'webpack/app/c.ts', content: null },
    { source: 'd.css', path: 'd.css', content: null },
  ]);
});

test('parseSourcemap accepts maps and rejects other JSON', () => {
  assert.ok(SourcemapUtils.parseSourcemap(")]}'\n" + JSON.stringify(MAP)));
  assert.strictEqual(SourcemapUtils.parseSourcemap('{"sources":[]}'), null);
  assert.strictEqual(SourcemapUtils.parseSourcemap('<html>'), null);
});

test('SourceZip crc32 matches the standard check value', () => {
  assert.strictEqual(
    SourceZip.crc32(new TextEncoder().encode('123456789')).toString(16),
    'cbf43926'
  );
});

/**
 * Read a ZIP's central directory and inflate each file, as an unzip tool would.
 */
async function readZip(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const end = buffer.length - 22;
  assert.strictEqual(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.strictEqual(view.getUint32(p, true), 0x02014b50);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const offset = view.getUint32(p + 42, true);
    const name = buffer.subarray(p + 46, p + 46 + nameLength).toString('utf-8');
    assert.strictEqual(view.getUint32(offset, true), 0x04034b50);
    const dataStart = offset + 30 + view.getUint16(offset + 26, true);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? require('zlib').inflateRawSync(raw) : raw;
    assert.strictEqual(data.length, size, name);
    assert.strictEqual(SourceZip.crc32(data), crc, name);
    files[name] = { method, text: data.toString('utf-8') };
    p += 46 + nameLength;
  }
  return files;
}

test('SourceZip writes a valid archive with deflated, stored and duplicate files', async () => {
  const zip = SourceZip.writer(new Date(2026, 9, 25, 12, 30, 10));
  await zip.add('host/app.js.map/src/a.ts', 'export const a = 1;\n'.repeat(200));
  await zip.add('host/app.js.map/src/a.ts', 'second');
  await zip.add('host/ünï.txt', 'x');
  const buffer = Buffer.from(await zip.finish().arrayBuffer());
  const files = await readZip(buffer);
  assert.deepStrictEqual(Object.keys(files), [
    'host/app.js.map/src/a.ts',
    'host/app.js.map/src/a~2.ts',
    'host/ünï.txt',
  ]);
  assert.strictEqual(files['host/app.js.map/src/a.ts'].method, 8);
  assert.strictEqual(files['host/app.js.map/src/a.ts'].text, 'export const a = 1;\n'.repeat(200));
  assert.strictEqual(files['host/app.js.map/src/a~2.ts'].text, 'second');
  // Too small to gain from compression, so stored
  assert.strictEqual(files['host/ünï.txt'].method, 0);
});

test('isHostSkipped matches exact hosts and wildcard rules', () => {
  const rules = new Set(['tracker.example.com', '*.medallia.eu']);
  assert.ok(SourcemapUtils.isHostSkipped('tracker.example.com', rules));
  assert.ok(!SourcemapUtils.isHostSkipped('www.example.com', rules));
  assert.ok(!SourcemapUtils.isHostSkipped('a.tracker.example.com', rules));
  assert.ok(SourcemapUtils.isHostSkipped('resources.digital-cloud.medallia.eu', rules));
  assert.ok(SourcemapUtils.isHostSkipped('medallia.eu', rules));
  assert.ok(!SourcemapUtils.isHostSkipped('notmedallia.eu', rules));
  assert.ok(!SourcemapUtils.isHostSkipped('', rules));
});

test('skipRuleFor returns the rule that skips a host', () => {
  const rules = new Set(['tracker.example.com', '*.medallia.eu']);
  assert.strictEqual(SourcemapUtils.skipRuleFor('tracker.example.com', rules), 'tracker.example.com');
  assert.strictEqual(SourcemapUtils.skipRuleFor('a.b.medallia.eu', rules), '*.medallia.eu');
  assert.strictEqual(SourcemapUtils.skipRuleFor('example.org', rules), null);
});

test('siteOf finds the domain of a host', () => {
  assert.strictEqual(SourcemapUtils.siteOf('a.b.example.com'), 'example.com');
  assert.strictEqual(SourcemapUtils.siteOf('example.com'), 'example.com');
  assert.strictEqual(SourcemapUtils.siteOf('x.y.co.uk'), 'y.co.uk');
  assert.strictEqual(SourcemapUtils.siteOf('cdn.example.lt'), 'example.lt');
  assert.strictEqual(SourcemapUtils.siteOf('192.168.0.1'), '');
  assert.strictEqual(SourcemapUtils.siteOf('[::1]'), '');
  assert.strictEqual(SourcemapUtils.siteOf(''), '');
});

test('findInlineDataUri picks the block with the matching map', () => {
  const uriA = dataUri(MAP);
  const uriB = dataUri({ ...MAP, sources: ['c.ts'] });
  const blocks = [
    { text: 'console.log(1);', type: 'script' },
    { text: '//# sourceMappingURL=app.js.map', type: 'script' },
    { text: 'a{}\n/*# sourceMappingURL=' + uriA + ' */', type: 'stylesheet' },
    { text: 'x();\n//# sourceMappingURL=' + uriB, type: 'script' },
  ];
  assert.strictEqual(SourcemapDetector.findInlineDataUri(blocks, SourcemapUtils.hash(uriA)), uriA);
  assert.strictEqual(SourcemapDetector.findInlineDataUri(blocks, SourcemapUtils.hash(uriB)), uriB);
  assert.strictEqual(SourcemapDetector.findInlineDataUri(blocks, 'nope'), null);
});
