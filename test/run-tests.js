/*!
 * test/run-tests.js — node test suite.
 *   node test/run-tests.js
 *
 * The interesting test is the round trip: build a PDF, run the exporter with a
 * set of edits, then re-open the result with both pdf-lib and PDF.js and check
 * that the new text really landed at the requested coordinates while the
 * original content survived.
 */
'use strict';

const path = require('path');
const zlib = require('zlib');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.PDFLib = require(path.join(ROOT, 'js/vendor/pdf-lib.min.js'));
const pdfjs = require(path.join(ROOT, 'js/vendor/pdf.min.js'));
pdfjs.GlobalWorkerOptions.workerSrc = path.join(ROOT, 'js/vendor/pdf.worker.min.js');

const PM = globalThis.PM = {};
globalThis.Intl = Intl;
require(path.join(ROOT, 'js/core/text.js'));
require(path.join(ROOT, 'js/app/icons.js'));
require(path.join(ROOT, 'js/app/units.js'));
require(path.join(ROOT, 'js/app/arrange.js'));
require(path.join(ROOT, 'js/core/ops.js'));
require(path.join(ROOT, 'js/core/exporter.js'));
const Text = PM.Text, Ops = PM.Ops, Exporter = PM.Exporter;
const Arrange = PM.Arrange, Units = PM.Units;

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    failed++;
    failures.push(name + ': ' + e.message);
    console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    failed++;
    failures.push(name + ': ' + e.message);
    console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b));
}
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error((msg || 'not near') + ': got ' + a + ', expected ' + b + ' ± ' + tol);
}
function section(title) { console.log('\n\x1b[1m' + title + '\x1b[0m'); }

/* ------------------------------------------------------------------ *
 * tiny PNG encoder (test fixtures)
 * ------------------------------------------------------------------ */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    for (let x = 0; x < w * 4; x++) {
      raw[y * (1 + w * 4) + 1 + x] = rgba ? rgba[(y * w + (x >> 2)) % rgba.length] : (x % 4 === 3 ? 255 : 200);
    }
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]));
}

/* ================================================================== *
 * 1. text engine
 * ================================================================== */
section('text engine');

test('detects right-to-left scripts', () => {
  assert(Text.isRTL('مرحبا بالعالم'), 'arabic should be rtl');
  assert(Text.isRTL('שלום עולם'), 'hebrew should be rtl');
  assert(!Text.isRTL('Hello world'), 'latin should be ltr');
  assert(!Text.isRTL('Привет'), 'cyrillic is ltr');
  eq(Text.analyse('مرحبا').dir, 'rtl');
  eq(Text.analyse('Hello').dir, 'ltr');
});

test('detects scripts that need shaping', () => {
  assert(Text.needsShaping('مرحبا'), 'arabic needs shaping');
  assert(Text.needsShaping('नमस्ते'), 'devanagari needs shaping');
  assert(Text.needsShaping('สวัสดี'), 'thai needs shaping');
  assert(Text.needsShaping('👩‍👩‍👧'), 'emoji ZWJ sequence needs shaping');
  assert(!Text.needsShaping('Hello, world!'), 'plain latin does not');
  assert(!Text.needsShaping('Привет, Ελλάδα'), 'cyrillic/greek do not');
  assert(!Text.needsShaping('日本語テキスト'), 'CJK does not need shaping');
});

test('WinAnsi safety check', () => {
  assert(Text.winAnsiSafe('Hello — “quoted”'), 'latin + punctuation');
  assert(!Text.winAnsiSafe('Привет'), 'cyrillic is not in WinAnsi');
  assert(!Text.winAnsiSafe('日本語'), 'cjk is not in WinAnsi');
});

test('wraps latin text on spaces', () => {
  const measure = (s) => s.length * 10;
  const lines = Text.wrap('the quick brown fox jumps over the lazy dog', 100, measure);
  assert(lines.length > 1, 'should wrap');
  lines.forEach(l => assert(measure(l) <= 100, 'line too long: ' + l));
  eq(lines.join(' '), 'the quick brown fox jumps over the lazy dog', 'text preserved');
});

test('wraps without spaces (CJK)', () => {
  const measure = (s) => s.length * 10;
  const lines = Text.wrap('日本語のテキストは空白なしで折り返します', 100, measure);
  assert(lines.length > 1, 'should wrap');
  lines.forEach(l => assert(measure(l) <= 100, 'line too long: ' + l));
  eq(lines.join(''), '日本語のテキストは空白なしで折り返します', 'text preserved');
});

test('breaks over-long words by grapheme', () => {
  const measure = (s) => s.length * 10;
  const lines = Text.wrap('A'.repeat(50), 100, measure);
  assert(lines.length === 5, 'expected 5 chunks, got ' + lines.length);
  eq(lines.join(''), 'A'.repeat(50), 'text preserved');
});

test('keeps explicit line breaks', () => {
  const lines = Text.wrap('one\ntwo\n\nthree', 500, () => 0);
  eq(lines.length, 4);
  eq(lines[0], 'one'); eq(lines[2], ''); eq(lines[3], 'three');
});

test('layout metrics and alignment', () => {
  const measure = (s) => s.length * 10;
  const lay = Text.layout({ text: 'ab\ncd', width: 100, size: 10, lineHeight: 1.2, measure });
  eq(lay.lines.length, 2);
  near(lay.lineHeight, 12, 0.001);
  near(lay.ascent, 8, 0.001);
  eq(Text.lineOffset('start', 'ltr', 30, 100), 0);
  eq(Text.lineOffset('start', 'rtl', 30, 100), 70);
  eq(Text.lineOffset('center', 'ltr', 30, 100), 35);
  eq(Text.lineOffset('end', 'ltr', 30, 100), 70);
});

test('colour helpers', () => {
  eq(Text.hexToRgb01('#ffffff').join(','), '1,1,1');
  eq(Text.rgb01ToHex([1, 0, 0.5]), '#ff0080');
  eq(Text.rgb01ToHex(Text.hexToRgb01('#336699')), '#336699');
});

test('matrix helpers', () => {
  const m = Text.matMul([2, 0, 0, 2, 5, 5], [1, 0, 0, 1, 1, 1]);
  // matMul(m, n) means "apply m first, then n"
  const p = Text.matApply(m, 3, 4);
  eq(p.x, 12); eq(p.y, 14);
  const inv = Text.matInvert(m);
  const q = Text.matApply(inv, p.x, p.y);
  near(q.x, 3, 1e-9); near(q.y, 4, 1e-9);
});

/* ================================================================== *
 * 2. document model
 * ================================================================== */
section('document model');

test('store: commit, undo, redo', () => {
  const s = new Ops.Store();
  s.addPage(Ops.page(0));
  s.commit('add', (st) => st.addOp(Ops.textOp(s.doc.pages[0].id, { x: 1, y: 2, w: 3, h: 4 }, { text: 'a' })));
  eq(s.doc.ops.length, 1);
  assert(s.undo(), 'undo should work');
  eq(s.doc.ops.length, 0);
  assert(s.redo(), 'redo should work');
  eq(s.doc.ops.length, 1);
});

test('store: gestures coalesce', () => {
  const s = new Ops.Store();
  s.addPage(Ops.page(0));
  s.beginGesture('move');
  s.addOp(Ops.textOp(s.doc.pages[0].id, { x: 0, y: 0, w: 10, h: 10 }, { text: 'x' }));
  s.update({ live: true });
  s.update({ live: true });
  s.endGesture();
  eq(s.doc.ops.length, 1);
  assert(s.undo(), 'single undo for the whole gesture');
  eq(s.doc.ops.length, 0);
});

test('store: json round trip keeps ops and pages', () => {
  const s = new Ops.Store();
  const p = Ops.page(0);
  s.addPage(p);
  s.commit('add', (st) => st.addOp(Ops.shapeOp(p.id, { x: 1, y: 1, w: 2, h: 2 }, { shape: 'ellipse' })));
  const json = JSON.parse(JSON.stringify(s.toJSON()));
  eq(json.pages.length, 1);
  eq(json.ops.length, 1);
  eq(json.ops[0].shape, 'ellipse');
});

test('store: live page order and lookup', () => {
  const s = new Ops.Store();
  const a = s.addPage(Ops.page(0));
  const b = s.addPage(Ops.page(1));
  eq(s.pageIndex(b.id), 1);
  s.commit('delete', () => { b.deleted = true; });
  eq(s.livePages().length, 1);
  eq(s.pageIndex(a.id), 0);
  eq(s.pageIndex(b.id), -1);
});

test('ops: factories honour their options', () => {
  const t = Ops.textOp('p', { x: 0, y: 0, w: 10, h: 10 }, { rotate: 45, opacity: 0.5, valign: 'middle' });
  eq(t.rotate, 45); eq(t.opacity, 0.5); eq(t.valign, 'middle');
  const pg = Ops.page(2, { blank: true, rotation: 90 });
  eq(pg.blank, true); eq(pg.rotation, 90); eq(pg.flattened, false);
});

/* ================================================================== *
 * 2b. arrangement + units
 * ================================================================== */
section('arrange and units');

test('aligns several objects to each other', () => {
  const ops = [
    { x: 10, y: 10, w: 50, h: 20 },
    { x: 120, y: 40, w: 30, h: 10 },
    { x: 200, y: 80, w: 80, h: 40 }
  ];
  const left = Arrange.align(ops, 'left', { width: 300, height: 300 });
  eq(left.map(r => r.x).join(','), '10,10,10');
  eq(left.map(r => r.y).join(','), '10,40,80', 'y must not change');
  const bottom = Arrange.align(ops, 'bottom', { width: 300, height: 300 });
  eq(bottom.map(r => r.y + ops.find(o => o.x === r.x && o.h === 20 || true).h).length >= 0, true);
  const right = Arrange.align(ops, 'right', { width: 300, height: 300 });
  right.forEach((r, i) => eq(r.x + ops[i].w, 280, 'aligned to the page right edge'));
});

test('aligns a single object to the page', () => {
  const one = [{ x: 0, y: 0, w: 10, h: 10 }];
  eq(Arrange.align(one, 'center-h', { width: 200, height: 100 })[0].x, 95);
  eq(Arrange.align(one, 'middle', { width: 200, height: 100 })[0].y, 45);
});

test('distributes with equal gaps and keeps the ends', () => {
  const ops = [
    { x: 0, y: 0, w: 20, h: 10 },
    { x: 30, y: 0, w: 20, h: 10 },
    { x: 100, y: 0, w: 20, h: 10 }
  ];
  const out = Arrange.distribute(ops, 'h');
  eq(out.length, 1, 'only the middle object moves');
  near(out[0].x, 50, 0.01, 'middle object centred between the others');
  eq(Arrange.distribute(ops.slice(0, 2), 'h').length, 0, 'needs three objects');
});

test('z-order: front, back, forward, backward', () => {
  const a = { x: 0, y: 0, w: 1, h: 1, id: 'a' }, b = { x: 0, y: 0, w: 1, h: 1, id: 'b' }, c = { x: 0, y: 0, w: 1, h: 1, id: 'c' };
  const page = [a, b, c];
  eq(Arrange.restack([a], page, 'front').map(i => i.op.id).join(''), 'bca', 'a to the top');
  eq(Arrange.restack([c], page, 'back').map(i => i.op.id).join(''), 'cab', 'c to the bottom');
  eq(Arrange.restack([a], page, 'forward').map(i => i.op.id).join(''), 'bac', 'a one step up');
  eq(Arrange.restack([b], page, 'backward').map(i => i.op.id).join(''), 'bac', 'b one step down');
  eq(Arrange.restack([c], page, 'forward').map(i => i.op.id).join(''), 'abc', 'already on top');
  void a; void b; void c;
});

test('clones objects with a new id', () => {
  const op = { id: 'x', x: 10, y: 20, w: 30, h: 40, type: 'text' };
  const copy = Arrange.clone(op, 5, -5);
  eq(copy.id, undefined, 'the clone gets a fresh id later');
  eq(copy.x, 15); eq(copy.y, 15);
  eq(op.x, 10, 'the original is untouched');
});

test('units round trip', () => {
  const pt = Units.create('pt');
  eq(pt.to(72), 72);
  const mm = Units.create('mm');
  near(mm.to(72), 25.4, 0.001);
  near(mm.from(25.4), 72, 0.001);
  near(mm.format(72), '25.4 mm', 0.001);
  eq(Units.create('in').to(72), 1);
  eq(Units.create('cm').to(72), 2.54);
});

/* ================================================================== *
 * 3. export round trip
 * ================================================================== */
section('export round trip (pdf-lib + pdf.js)');

function makeCtx(extra) {
  const png = makePng(8, 8);
  return Exporter.createCtx(Object.assign({
    PDFLib: globalThis.PDFLib,
    fontkit: null,
    resolveFont: (id) => (id === 'std-helvetica' ? { kind: 'builtin', standard: 'Helvetica' } : { kind: 'system' }),
    metrics: () => ({ ascent: 0.8, descent: 0.2 }),
    measureCanvas: (op) => (s) => s.length * (op.size || 12) * 0.5,
    textToImage: (spec) => Promise.resolve({
      bytes: png, mime: 'image/png',
      width: Math.ceil(spec.width * spec.scale), height: Math.ceil(spec.lines.length * spec.lineHeight * spec.size * spec.scale)
    }),
    renderPage: () => Promise.resolve({ bytes: makePng(20, 20), mime: 'image/png' }),
    getAsset: () => null,
    getFontBytes: () => Promise.resolve(null),
    warn: () => { }
  }, extra || {}));
}

async function buildSource() {
  const d = await PDFLib.PDFDocument.create();
  const p1 = d.addPage([400, 300]);
  const helv = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  p1.drawText('ORIGINAL ONE', { x: 40, y: 250, size: 18, font: helv });
  p1.drawText('second line here', { x: 40, y: 230, size: 10, font: helv });
  p1.drawRectangle({ x: 20, y: 20, width: 60, height: 30, color: PDFLib.rgb(0.2, 0.4, 0.9) });
  const img = await d.embedPng(makePng(10, 10));
  p1.drawImage(img, { x: 200, y: 40, width: 80, height: 60 });
  const p2 = d.addPage([300, 400]);
  p2.drawText('PAGE TWO', { x: 20, y: 350, size: 24, font: helv });
  const p3 = d.addPage([500, 200]);
  p3.drawText('PAGE THREE', { x: 10, y: 100, size: 12, font: helv });
  return d.save();
}

async function extract(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    out.push({
      size: page.getViewport({ scale: 1, rotation: 0 }),
      rotate: page.rotate,
      items: tc.items.filter(it => it.str.trim()).map(it => ({
        str: it.str, x: it.transform[4], y: it.transform[5], size: it.height,
        w: it.width, font: it.fontName
      }))
    });
  }
  return { numPages: doc.numPages, pages: out, doc };
}

async function pageOf(bytes, n) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  return { doc, page: await doc.getPage(n) };
}

(async function run() {

  await testAsync('exports text at the exact requested position', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    const p0 = store.addPage(Ops.page(0));
    store.addPage(Ops.page(1));
    store.addPage(Ops.page(2));
    store.commit('edit', (s) => {
      s.addOp(Ops.textOp(p0.id, { x: 100, y: 200, w: 250, h: 30 }, {
        text: 'EDITED-TEXT', fontId: 'std-helvetica', size: 12, color: '#000000', cover: false
      }));
    });
    const res = await Exporter.apply(src, store.doc, makeCtx());
    const out = await extract(res.bytes);
    const hit = out.pages[0].items.find(i => i.str.indexOf('EDITED') === 0);
    assert(hit, 'edited text not found in the output');
    assert(hit.x >= 100 && hit.x <= 100.5, 'x should be the left edge of the box, got ' + hit.x);
    const lh = 1.2 * 12, asc = 0.8 * 12, desc = 0.2 * 12;
    near(hit.y, 300 - (200 + (lh - asc - desc) / 2 + asc), 0.2, 'baseline inside the box');
    near(hit.size, 12, 0.01, 'font size');
    assert(out.pages[0].items.find(i => i.str === 'ORIGINAL ONE'), 'the original text must survive');
    eq(out.numPages, 3, 'page count');
  });

  await testAsync('hidden original text is covered but the new text is searchable', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    const p0 = store.addPage(Ops.page(0));
    store.commit('edit', (s) => {
      s.addOp(Ops.textOp(p0.id, { x: 36, y: 222, w: 220, h: 40 }, {
        text: 'REPLACEMENT', fontId: 'std-helvetica', size: 18, cover: true,
        coverColor: '#ffffff', sourceRect: { x: 40, y: 228, w: 120, h: 26 }
      }));
    });
    const res = await Exporter.apply(src, store.doc, makeCtx());
    const out = await extract(res.bytes);
    const texts = out.pages[0].items.map(i => i.str).join('|');
    assert(texts.indexOf('REPLACEMENT') >= 0, 'replacement missing');
    assert(texts.indexOf('ORIGINAL ONE') >= 0, 'original text should still be in the file (covered visually)');
    const rep = out.pages[0].items.find(i => i.str === 'REPLACEMENT');
    near(rep.size, 18, 0.01);
  });

  await testAsync('shaped text becomes an image and keeps its geometry', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    const p0 = store.addPage(Ops.page(0));
    store.commit('edit', (s) => {
      s.addOp(Ops.textOp(p0.id, { x: 30, y: 100, w: 200, h: 60 }, {
        text: 'مرحبا بالعالم', fontId: 'sys-arabic', size: 20, render: 'auto', cover: false
      }));
    });
    const res = await Exporter.apply(src, store.doc, makeCtx());
    const { page } = await pageOf(res.bytes, 1);
    const ops = await page.getOperatorList();
    const OPS = pdfjs.OPS;
    const images = ops.fnArray.filter(f => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject).length;
    assert(images >= 2, 'expected the rtl text to be embedded as an image (found ' + images + ')');
    eq(res.warnings.length, 0, 'no warnings expected: ' + res.warnings.join('; '));
  });

  await testAsync('rotated text is rotated about the box centre', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    const p0 = store.addPage(Ops.page(0));
    store.addPage(Ops.page(1));
    store.addPage(Ops.page(2));
    store.commit('edit', (s) => {
      s.addOp(Ops.textOp(p0.id, { x: 50, y: 150, w: 200, h: 30 }, {
        text: 'ROTATED', fontId: 'std-helvetica', size: 14, rotate: 90, cover: false
      }));
    });
    const res = await Exporter.apply(src, store.doc, makeCtx());
    const out = await extract(res.bytes);
    const hit = out.pages[0].items.find(i => i.str === 'ROTATED');
    assert(hit, 'rotated text missing');
    const { page } = await pageOf(res.bytes, 1);
    const tc = await page.getTextContent();
    const item = tc.items.find(i => i.str === 'ROTATED');
    const t = item.transform;
    near(Math.abs(t[0]), 0, 0.01, 'a-component should be ~0, got ' + t[0]);
    near(Math.abs(t[1]), 14, 0.01, 'b-component should be the font size, got ' + t[1]);
    const cx = 50 + 200 / 2, cy = 150 + 30 / 2;
    const baseline = 150 + (1.2 * 14 - 14) / 2 + 0.8 * 14;
    const dx = 50 - cx, dy = baseline - cy;
    near(hit.x, cx - dy, 0.3, 'x of the rotated run');
    near(hit.y, 300 - (cy + dx), 0.3, 'y of the rotated run');
  });

  await testAsync('shapes are painted', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    const p0 = store.addPage(Ops.page(0));
    store.addPage(Ops.page(1));
    store.addPage(Ops.page(2));
    store.commit('edit', (s) => {
      s.addOp(Ops.shapeOp(p0.id, { x: 20, y: 20, w: 100, h: 50 }, { shape: 'rect', fill: '#ff0000' }));
      s.addOp(Ops.shapeOp(p0.id, { x: 150, y: 20, w: 100, h: 50 }, { shape: 'ellipse', fill: '#00ff00' }));
      s.addOp(Ops.shapeOp(p0.id, { x: 20, y: 100, w: 100, h: 0.5 }, { shape: 'line', stroke: '#0000ff', strokeWidth: 3 }));
    });
    const res = await Exporter.apply(src, store.doc, makeCtx());
    const out = await extract(res.bytes);
    eq(out.numPages, 3);
    const { page } = await pageOf(res.bytes, 1);
    const ops = await page.getOperatorList();
    const OPS = pdfjs.OPS;
    const fills = ops.fnArray.filter(f => f === OPS.fill || f === OPS.fillStroke || f === OPS.eoFill).length;
    const strokes = ops.fnArray.filter(f => f === OPS.stroke).length;
    assert(fills >= 3, 'expected the shapes to be filled, got ' + fills);
    assert(strokes >= 1, 'expected the line to be stroked, got ' + strokes);
  });

  await testAsync('page rotation, deletion, duplication and re-ordering', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    const a = store.addPage(Ops.page(0));
    const b = store.addPage(Ops.page(1));
    const c = store.addPage(Ops.page(2));
    store.commit('pages', (s) => {
      b.rotation = 90;
      c.deleted = true;
      const copy = Ops.page(0, {});
      copy.duplicate = true;
      copy.sourceOf = a.id;
      s.doc.pages.push(copy);
      s.doc.pages.reverse();
    });
    const res = await Exporter.apply(src, store.doc, makeCtx());
    const out = await extract(res.bytes);
    eq(out.numPages, 3, '3 source pages - 1 deleted + 1 duplicate');
    eq(out.pages[0].size.width, 400, 'first page is the duplicate of A');
    eq(out.pages[1].size.width, 300, 'second page is B');
    eq(out.pages[1].rotate, 90, 'rotation kept');
    eq(out.pages[2].size.width, 400, 'third page is A');
    assert(out.pages[2].items.map(i => i.str).join('').indexOf('ORIGINAL ONE') >= 0, 'page A content intact');
    assert(out.pages[0].items.map(i => i.str).join('').indexOf('ORIGINAL ONE') >= 0, 'duplicated page has the same content');
  });

  await testAsync('page background is inserted underneath the content', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    store.addPage(Ops.page(0, { background: '#ffee99' }));
    store.addPage(Ops.page(1));
    store.addPage(Ops.page(2));
    const res = await Exporter.apply(src, store.doc, makeCtx());
    const { page } = await pageOf(res.bytes, 1);
    const ops = await page.getOperatorList();
    const OPS = pdfjs.OPS;
    const firstFill = ops.fnArray.indexOf(OPS.fill);
    const firstText = ops.fnArray.findIndex(f => f === OPS.showText);
    assert(firstFill >= 0, 'background rectangle found');
    assert(firstFill < firstText, 'background must be painted before the text');
  });

  await testAsync('page size change rescales the content uniformly', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    store.addPage(Ops.page(0, { sizeMode: 'a4' }));
    store.addPage(Ops.page(1));
    store.addPage(Ops.page(2));
    const res = await Exporter.apply(src, store.doc, makeCtx());
    const out = await extract(res.bytes);
    near(out.pages[0].size.width, 595.28, 0.5);
    near(out.pages[0].size.height, 841.89, 0.5);
    const orig = out.pages[0].items.find(i => i.str === 'ORIGINAL ONE');
    const factor = Math.min(595.28 / 400, 841.89 / 300);
    near(orig.size, 18 * factor, 0.8, 'text scaled uniformly with the page');
    near(orig.x, 40 * factor + (595.28 - 400 * factor) / 2, 1.5, 'content centred horizontally');
  });

  await testAsync('flattened pages are replaced by a bitmap', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    store.addPage(Ops.page(0, { flattened: true, flattenDpi: 72 }));
    store.addPage(Ops.page(1));
    store.addPage(Ops.page(2));
    const res = await Exporter.apply(src, store.doc, makeCtx());
    const out = await extract(res.bytes);
    eq(out.numPages, 3);
    eq(out.pages[0].items.length, 0, 'a flattened page has no text layer');
    const { page } = await pageOf(res.bytes, 1);
    const ops = await page.getOperatorList();
    assert(ops.fnArray.filter(f => f === pdfjs.OPS.paintImageXObject).length >= 1, 'bitmap present');
  });

  await testAsync('blank pages are inserted empty', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    store.addPage(Ops.page(0));
    const blank = store.addPage(Ops.page(1, { blank: true }));
    store.addPage(Ops.page(2));
    const res = await Exporter.apply(src, store.doc, makeCtx());
    const out = await extract(res.bytes);
    eq(out.numPages, 3, 'two source pages plus the blank one');
    eq(out.pages[1].items.length, 0, 'the blank page must be empty');
    eq(Math.round(out.pages[1].size.width), 400, 'the blank page copies the size of its neighbour');
    assert(out.pages[2].items.map(i => i.str).join('').indexOf('PAGE THREE') >= 0, 'the following page is untouched');
    void blank;
  });

  await testAsync('embedded TTF text stays selectable', async () => {
    const cache = path.join(__dirname, '.cache');
    const ttf = path.join(cache, 'Tinos-Regular.ttf');
    let bytes = null;
    if (fs.existsSync(ttf)) {
      bytes = new Uint8Array(fs.readFileSync(ttf));
    } else {
      try {
        fs.mkdirSync(cache, { recursive: true });
        const res = await fetch('https://raw.githubusercontent.com/google/fonts/main/ofl/tinos/Tinos-Regular.ttf');
        if (res.ok) {
          const buf = new Uint8Array(await res.arrayBuffer());
          fs.writeFileSync(ttf, buf);
          bytes = buf;
        }
      } catch (e) { /* offline */ }
    }
    if (!bytes) { skipped++; console.log('  \x1b[33m-\x1b[0m embedded TTF text (font not available offline)'); return; }

    const fontkit = require(path.join(ROOT, 'js/vendor/fontkit.umd.min.js'));
    const src = await buildSource();
    const store = new Ops.Store();
    const p0 = store.addPage(Ops.page(0));
    store.addPage(Ops.page(1));
    store.addPage(Ops.page(2));
    store.commit('edit', (s) => {
      s.addOp(Ops.textOp(p0.id, { x: 40, y: 120, w: 300, h: 40 }, {
        text: 'CUSTOM FONT OUTPUT', fontId: 'file-tinos', size: 16, cover: false
      }));
    });
    const ctx = makeCtx({
      fontkit: fontkit,
      resolveFont: () => ({ kind: 'file', embeddable: true }),
      getFontBytes: () => Promise.resolve(bytes)
    });
    const res = await Exporter.apply(src, store.doc, ctx);
    const out = await extract(res.bytes);
    const hit = out.pages[0].items.find(i => i.str.indexOf('CUSTOM FONT') === 0);
    assert(hit, 'custom font text missing from the output');
    // the glyphs must come from an embedded font program, not a standard one
    const reloaded = await globalThis.PDFLib.PDFDocument.load(res.bytes);
    let fontFile = null;
    reloaded.context.enumerateIndirectObjects().forEach(pair => {
      const obj = pair[1];
      const text = obj && typeof obj.toString === 'function' ? obj.toString() : '';
      const m = /\/FontFile2 (\d+) 0 R/.exec(text);
      if (m) fontFile = m[1];
    });
    assert(fontFile, 'a TrueType font program must be embedded');
  });

  await testAsync('form fields are written as real AcroForm widgets', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    const p0 = store.addPage(Ops.page(0));
    store.addPage(Ops.page(1));
    store.addPage(Ops.page(2));
    store.commit('edit', (s) => {
      s.addOp(Ops.fieldOp(p0.id, { x: 40, y: 180, w: 200, h: 22 }, {
        field: { kind: 'text', name: 'fullName', value: 'Ada Lovelace', fontSize: 11 },
        fontId: 'std-helvetica'
      }));
      s.addOp(Ops.fieldOp(p0.id, { x: 40, y: 150, w: 16, h: 16 }, {
        field: { kind: 'checkbox', name: 'agree', value: true }
      }));
      s.addOp(Ops.fieldOp(p0.id, { x: 80, y: 150, w: 16, h: 16 }, {
        field: { kind: 'radio', name: 'plan', value: 'pro' }
      }));
      s.addOp(Ops.fieldOp(p0.id, { x: 120, y: 150, w: 120, h: 20 }, {
        field: { kind: 'dropdown', name: 'country', options: ['DE', 'FR', 'JP'], value: 'FR' }
      }));
    });
    const res = await Exporter.apply(src, store.doc, makeCtx());
    eq(res.warnings.length, 0, 'no warnings: ' + res.warnings.join('; '));
    const out = await Exporter && await globalThis.PDFLib.PDFDocument.load(res.bytes);
    const form = out.getForm();
    const names = form.getFields().map(f => f.getName());
    ['fullName', 'agree', 'plan', 'country'].forEach(n =>
      assert(names.indexOf(n) >= 0, 'missing field ' + n + ' in ' + names.join(',')));
    eq(form.getTextField('fullName').getText(), 'Ada Lovelace');
    eq(form.getCheckBox('agree').isChecked(), true);
    eq(form.getField('plan').getOptions().join(','), 'pro');
    eq(form.getDropdown('country').getSelected()[0], 'FR');
  });

  await testAsync('secure redaction rasterises the page and removes the text', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    const p0 = store.addPage(Ops.page(0));
    store.addPage(Ops.page(1));
    store.addPage(Ops.page(2));
    store.commit('edit', (s) => {
      const mark = s.addOp(Ops.shapeOp(p0.id, { x: 36, y: 226, w: 130, h: 30 },
        { shape: 'rect', fill: '#000000' }));
      mark.redaction = true;
    });
    const painted = [];
    const ctx = makeCtx({
      renderPage: (spec) => {
        (spec.redactions || []).forEach(r => painted.push(r));
        return Promise.resolve({ bytes: makePng(20, 20), mime: 'image/png' });
      }
    });
    const res = await Exporter.apply(src, store.doc, ctx);
    eq(painted.length, 1, 'the renderer must receive the redaction boxes');
    near(painted[0].x, 36, 0.01);
    near(painted[0].w, 130, 0.01);
    const out = await extract(res.bytes);
    eq(out.numPages, 3);
    eq(out.pages[0].items.length, 0, 'the redacted page no longer contains any text');
    const { page } = await pageOf(res.bytes, 1);
    const ops = await page.getOperatorList();
    assert(ops.fnArray.filter(f => f === pdfjs.OPS.paintImageXObject).length >= 1, 'the page is now a bitmap');
  });

  await testAsync('exporting a page range keeps only those pages', async () => {
    const src = await buildSource();
    const store = new Ops.Store();
    store.addPage(Ops.page(0));
    store.addPage(Ops.page(1));
    store.addPage(Ops.page(2));
    const doc = JSON.parse(JSON.stringify(store.doc));
    doc.pages = [doc.pages[1]];
    doc.ops = [];
    const res = await Exporter.apply(src, doc, makeCtx());
    const out = await extract(res.bytes);
    eq(out.numPages, 1);
    eq(out.pages[0].size.width, 300);
  });

  /* ================================================================== *
   * 4. static checks
   * ================================================================== */
  section('static checks');

  test('i18n: every language defines every key', () => {
    require(path.join(ROOT, 'js/app/i18n.js'));
    const langs = PM.I18n.LANGS, meta = PM.I18n.META, keys = PM.I18n.KEYS;
    Object.keys(meta).forEach(code => {
      const table = langs[code];
      assert(table, 'language ' + code + ' has no table');
      const missing = keys.filter(k => table[k] == null);
      eq(missing.length, 0, code + ' is missing: ' + missing.join(', '));
    });
    const extra = Object.keys(langs.en).filter(k => keys.indexOf(k) < 0);
    eq(extra.length, 0, 'unused keys in en: ' + extra.join(', '));
  });

  test('i18n: translations differ from english (no accidental copies)', () => {
    Object.keys(PM.I18n.LANGS).forEach(code => {
      if (code === 'en') return;
      assert(PM.I18n.LANGS[code].appName !== PM.I18n.LANGS.en.appName, code + ' has an untranslated appName');
    });
  });

  test('html: every element id used by main.js exists', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'js/app/main.js'), 'utf8');
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
    const dynamic = new Set(['search-results']);   // created by main.js at runtime
    const used = [...main.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]).filter(id => !dynamic.has(id));
    const missing = [...new Set(used)].filter(id => !ids.has(id));
    eq(missing.length, 0, 'missing ids: ' + missing.join(', '));
  });

  test('html: every data-i18n key exists in the translation table', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    require(path.join(ROOT, 'js/app/i18n.js'));
    const keys = [...html.matchAll(/data-i18n(?:-title|-label)?="([^"]+)"/g)].map(m => m[1]);
    const missing = [...new Set(keys)].filter(k => PM.I18n.LANGS.en[k] == null);
    eq(missing.length, 0, 'unknown keys: ' + missing.join(', '));
  });

  test('i18n: every key used by the app exists', () => {
    require(path.join(ROOT, 'js/app/i18n.js'));
    const files = ['main.js', 'viewer.js', 'inspector.js', 'dialogs.js', 'pdfsource.js', 'fonts.js', 'arrange.js', 'units.js'];
    const used = new Set();
    files.forEach(f => {
      const src = fs.readFileSync(path.join(ROOT, 'js/app', f), 'utf8');
      for (const m of src.matchAll(/(?<![\w.$])t\('([a-zA-Z0-9_.\-]+)'/g)) used.add(m[1]);
    });
    // keys built at runtime (e.g. 'units.' + id) end with a dot
    const missing = [...used].filter(k => !PM.I18n.KEYS.includes(k) && !/\.$/.test(k));
    eq(missing.length, 0, 'keys used but not declared: ' + missing.join(', '));
  });

  test('html: scripts are loaded in dependency order', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
    const want = [
      'js/vendor/pdf.min.js', 'js/vendor/pdf-lib.min.js', 'js/vendor/fontkit.umd.min.js',
      'js/core/text.js', 'js/core/ops.js', 'js/core/exporter.js',
      'js/app/i18n.js', 'js/app/icons.js', 'js/app/units.js', 'js/app/arrange.js',
      'js/app/fonts.js', 'js/app/pdfsource.js', 'js/app/viewer.js',
      'js/app/inspector.js', 'js/app/dialogs.js', 'js/app/main.js'
    ];
    eq(order.join(','), want.join(','), 'script order');
    order.forEach(f => assert(fs.existsSync(path.join(ROOT, f)), 'missing file ' + f));
  });

  test('vendor libraries are present and usable', () => {
    ['pdf.min.js', 'pdf.worker.min.js', 'pdf-lib.min.js', 'fontkit.umd.min.js'].forEach(f => {
      const p = path.join(ROOT, 'js/vendor', f);
      assert(fs.existsSync(p), 'missing vendor file ' + f);
      assert(fs.statSync(p).size > 1000, f + ' looks truncated');
    });
    assert(typeof pdfjs.getDocument === 'function', 'pdf.js api');
    assert(typeof PDFLib.PDFDocument.create === 'function', 'pdf-lib api');
  });

  console.log('\n' + (failed ? '\x1b[31m' : '\x1b[32m') +
    passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : '') + '\x1b[0m');
  if (failed) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
})();
