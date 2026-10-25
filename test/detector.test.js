'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The shared modules are plain scripts declaring globals, as loaded by the
// extension, so evaluate them together and pull the objects out.
const source = ['constants.js', 'utils.js', 'detector.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', f), 'utf-8'))
  .join('\n');
const { SourcemapDetector, SourcemapUtils } = vm.runInNewContext(
  source + '\n({ SourcemapDetector, SourcemapUtils });',
  { URL, atob }
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
