/*!
 * test/dom-smoke.js — boots the real index.html inside jsdom, opens a PDF,
 * edits it and exports it, failing on any uncaught error.
 *
 *   node test/dom-smoke.js
 *
 * jsdom has no canvas implementation, so a recording stub is installed before
 * the application scripts run.  The point of this test is the wiring (DOM,
 * events, module boundaries), not the pixels.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function loadJsdom() {
  for (const c of ['jsdom', path.join(__dirname, '../test-tools/node_modules/jsdom')]) {
    try { return require(c); } catch (e) { /* next */ }
  }
  console.error('jsdom is required for this test:  npm install');
  process.exit(2);
}
const { JSDOM, VirtualConsole } = loadJsdom();

const L = require(path.join(ROOT, 'js/vendor/pdf-lib.min.js'));
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVQoz2P8//8/AzZgYkAD' +
  'YphqM4h4mPgB4kJDUQOJAxUGBj+M/1c1aJnU0nVYtAAAAAElFTkSuQmCC', 'base64');

/* ------------------------------------------------------------------ *
 * a forgiving 2D canvas stub
 * ------------------------------------------------------------------ */
function makeCtx2D(canvas) {
  const noop = () => { };
  const state = {
    canvas, font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000',
    lineWidth: 1, globalAlpha: 1, direction: 'ltr', textAlign: 'start',
    textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    globalCompositeOperation: 'source-over', filter: 'none', imageSmoothingEnabled: true,
    shadowBlur: 0, shadowColor: 'transparent', letterSpacing: '0px', wordSpacing: '0px',
    fontKerning: 'auto', displayOperation: 'source-over'
  };
  const handlers = {
    measureText(text) {
      const size = parseFloat((state.font.match(/(\d+(\.\d+)?)px/) || [0, 10])[1]) || 10;
      const ls = parseFloat(state.letterSpacing) || 0;
      return {
        width: String(text).length * size * 0.5 + ls * String(text).length,
        fontBoundingBoxAscent: size * 0.8, fontBoundingBoxDescent: size * 0.2,
        actualBoundingBoxAscent: size * 0.7, actualBoundingBoxDescent: size * 0.2,
        actualBoundingBoxLeft: 0, actualBoundingBoxRight: String(text).length * size * 0.5
      };
    },
    getImageData(x, y, w, h) {
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)).fill(210), width: w, height: h };
    },
    createImageData(w, h) { return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }; },
    getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
    createLinearGradient() { return { addColorStop() { } }; },
    createPattern() { return null; },
    getLineDash() { return []; },
    isPointInPath() { return false; },
    isPointInStroke() { return false; }
  };
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop in handlers) return handlers[prop];
      if (typeof prop === 'string' && /^(webkit|moz|ms|o)[A-Z]/.test(prop)) return undefined;
      return noop;
    },
    set(target, prop, value) { target[prop] = value; return true; }
  });
}

async function buildSample() {
  const d = await L.PDFDocument.create();
  const helv = await d.embedFont(L.StandardFonts.Helvetica);
  const p1 = d.addPage([595.28, 841.89]);
  p1.drawText('QUARTERLY REPORT', { x: 60, y: 760, size: 24, font: helv });
  p1.drawText('Prepared for the board of directors', { x: 60, y: 730, size: 12, font: helv });
  p1.drawText('Revenue grew by 12% compared with the previous year.', { x: 60, y: 690, size: 11, font: helv });
  p1.drawRectangle({ x: 60, y: 400, width: 200, height: 120, color: L.rgb(0.85, 0.9, 1) });
  const pic = await d.embedPng(new Uint8Array(SAMPLE_PNG));
  p1.drawImage(pic, { x: 60, y: 500, width: 120, height: 120 });
  const p2 = d.addPage([595.28, 841.89]);
  p2.drawText('Appendix', { x: 60, y: 760, size: 18, font: helv });
  const p3 = d.addPage([595.28, 841.89]);
  p3.drawText('Thank you', { x: 60, y: 760, size: 14, font: helv });
  return new Uint8Array(await d.save());
}

function run() {
  const errors = [];
  global.__smokeErrors = errors;
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    if (/Could not load img|Not implemented/.test(e.message)) return;
    errors.push('jsdomError: ' + (e.stack || e.message));
  });
  virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.map(a =>
    (a && a.stack) ? a.stack : String(a)).join(' ')));
  virtualConsole.on('warn', (...args) => console.log('  [warn] ' + args.join(' ')));

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'file://' + path.join(ROOT, 'index.html') + '?file=sample.pdf',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      const proto = window.HTMLCanvasElement.prototype;
      proto.getContext = function (kind) {
        if (kind !== '2d') return null;
        if (!this._ctx2d) this._ctx2d = makeCtx2D(this);
        return this._ctx2d;
      };
      proto.toDataURL = function () { return TINY_PNG; };
      proto.toBlob = function (cb) { cb(new window.Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })); };

      class IO {
        constructor(cb) { this.cb = cb; }
        observe(el) { this.cb([{ target: el, isIntersecting: true, intersectionRatio: 1 }], this); }
        unobserve() { } disconnect() { } takeRecords() { return []; }
      }
      window.IntersectionObserver = IO;
      window.ResizeObserver = IO;
      window.matchMedia = window.matchMedia || function () {
        return { matches: false, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { } };
      };
      ['ReadableStream', 'WritableStream', 'TransformStream', 'TextDecoder', 'TextEncoder',
        'structuredClone', 'AbortController', 'DOMException', 'queueMicrotask'].forEach(name => {
        if (typeof window[name] === 'undefined' && typeof global[name] !== 'undefined') window[name] = global[name];
      });
      window.URL.createObjectURL = (blob) => { global.__lastBlob = blob; return 'blob:stub'; };
      window.URL.revokeObjectURL = () => { };
      window.scrollTo = () => { };
      window.HTMLElement.prototype.scrollIntoView = function () { };
      window.requestAnimationFrame = window.requestAnimationFrame || (cb => setTimeout(() => cb(Date.now()), 0));
      window.onerror = (msg, src, line, col, err) => {
        errors.push('window.onerror: ' + msg + (err && err.stack ? '\n' + err.stack : ''));
      };
      window.addEventListener('unhandledrejection', (ev) => {
        errors.push('unhandled rejection: ' + (ev.reason && (ev.reason.stack || ev.reason.message) || ev.reason));
      });
    }
  });
  return { dom, window: dom.window, errors };
}

let checks = 0;
function step(name) { checks++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async function () {
  const sample = await buildSample();
  fs.mkdirSync(path.join(__dirname, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '.cache', 'sample.pdf'), Buffer.from(sample));

  const { dom, window, errors } = run();
  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];

  window.fetch = async function () {
    const buf = fs.readFileSync(path.join(__dirname, '.cache', 'sample.pdf'));
    return {
      ok: true, status: 200,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    };
  };

  const waitFor = async (fn, timeout = 20000, label = 'condition') => {
    const started = Date.now();
    for (;;) {
      let v;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() - started > timeout) throw new Error('timeout waiting for ' + label);
      await new Promise(r => setTimeout(r, 60));
    }
  };
  const pause = (ms) => new Promise(r => setTimeout(r, ms || 60));
  const click = (node) => node.dispatchEvent(new window.Event('click', { bubbles: true }));

  console.log('\n\x1b[1mdom smoke test (jsdom)\x1b[0m');

  await waitFor(() => window.PMApp && window.PMApp.store(), 25000, 'app boot');
  step('application boots');

  const store = window.PMApp.store();
  const viewer = window.PMApp.viewer();
  await waitFor(() => store.doc.pages.length === 3, 25000, 'pdf load');
  step('PDF opened: 3 pages');

  assert($('#dropzone').classList.contains('hidden'), 'dropzone should be hidden once a document is open');
  assert($$('.page-wrap').length === 3, 'three page wrappers, got ' + $$('.page-wrap').length);
  assert($('#doc-name').textContent.length > 0, 'the document name should show in the title bar');
  step('viewer built the page list');

  const firstPage = store.doc.pages[0];
  const info = viewer.pageInfo(firstPage.id);
  assert(info && Math.round(info.width) === 595 && Math.round(info.height) === 842,
    'page size should be A4, got ' + JSON.stringify(info));
  step('page geometry read from the document');

  // every sidebar panel renders
  for (const tab of ['text', 'images', 'layers', 'search', 'fonts', 'history', 'pages']) {
    click($('#side-tabs button[data-tab="' + tab + '"]'));
    await pause(40);
    assert($('.panel[data-panel="' + tab + '"]').classList.contains('active'), 'panel ' + tab + ' should be active');
  }
  step('all sidebar panels render');

  // text extraction
  await waitFor(() => viewer.getTextIndex(firstPage.id) && viewer.getTextIndex(firstPage.id).blocks.length >= 3,
    15000, 'text index');
  const blocks = viewer.getTextIndex(firstPage.id).blocks;
  assert(blocks[0].text.indexOf('QUARTERLY') === 0, 'first block text: ' + blocks[0].text);
  step('text extracted (' + blocks.length + ' blocks)');

  // images
  click($('#side-tabs button[data-tab="images"]'));
  const cell = await waitFor(() => $('.img-cell'), 15000, 'image cell');
  assert(cell, 'no image cell rendered');
  const idx = viewer.getTextIndex(firstPage.id);
  assert(idx && idx.images && idx.images.length >= 1, 'the embedded image was not detected');
  step('images detected and listed (' + idx.images.length + ')');

  // create a text operation
  const op = window.PM.Ops.textOp(firstPage.id, { x: 60, y: 700, w: 400, h: 30 }, {
    text: 'REPLACEMENT HEADLINE', size: 24, fontId: 'std-helvetica', color: '#102040', cover: true
  });
  store.commit('test', (s) => s.addOp(op));
  viewer.refreshOps();
  await pause(60);
  const box = $('.op[data-op-id="' + op.id + '"]');
  assert(box, 'the operation should be rendered in the overlay');
  assert(box.textContent.indexOf('REPLACEMENT') === 0, 'overlay should show the text');
  step('text operation created and rendered');

  // inspector
  viewer.select(op.id);
  await pause(60);
  const area = $('#inspector textarea');
  assert(area && area.value === 'REPLACEMENT HEADLINE',
    'inspector should show the text field, got: ' + (area && area.value));
  assert($$('#inspector .btn-sm').length >= 6, 'inspector should offer object actions');
  step('inspector bound to the selection');

  // units
  const unitsSel = $('#units-select');
  assert(unitsSel.options.length === 4, 'four unit choices expected');
  unitsSel.value = 'mm';
  unitsSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await pause(60);
  const numInput = $('#inspector input.num');
  assert(numInput && Math.abs(parseFloat(numInput.value) - 60 * 25.4 / 72) < 0.2,
    'geometry should switch to millimetres, got ' + (numInput && numInput.value));
  unitsSel.value = 'pt';
  unitsSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  step('unit preference switches the inspector');

  // multi-selection + arrange
  const second = window.PM.Ops.shapeOp(firstPage.id, { x: 60, y: 650, w: 100, h: 40 }, { shape: 'rect' });
  store.commit('test', (s) => s.addOp(second));
  viewer.selectIds([op.id, second.id]);
  await pause(60);
  assert(viewer.selection().length === 2, 'two objects should be selected');
  assert($('#inspector').textContent.indexOf('2') >= 0, 'the inspector should report a multi-selection');
  const alignBtn = $$('#inspector .btn-sm').find(b => b.title && /left|gauche|izquierda|_links/i.test(b.title));
  assert(alignBtn, 'align buttons should be present for a multi-selection');
  alignBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await pause(60);
  assert(store.undo(), 'the alignment must be undoable');
  step('multi-selection, alignment and undo');

  // form field creation through the tool
  viewer.setTool('form-text');
  const fieldOp = window.PM.Ops.fieldOp(firstPage.id, { x: 60, y: 600, w: 180, h: 22 }, {
    field: { kind: 'text', name: 'smokeName', value: 'Jane Doe' }
  });
  store.commit('test', (s) => s.addOp(fieldOp));
  viewer.select(fieldOp.id);
  await pause(60);
  assert($('.op-field'), 'the form field should be drawn in the overlay');
  viewer.setTool('select');
  step('form field created and rendered');

  // page rotation + undo
  store.commit('test-rotate', () => { store.doc.pages[0].rotation = 90; });
  viewer.build();
  await pause(80);
  assert($('#viewport .page-wrap').style.width !== '', 'page wrapper must be sized');
  store.undo();
  await pause(60);
  assert(store.doc.pages[0].rotation === 0, 'undo should restore the rotation');
  viewer.build();
  step('page rotation and undo/redo history');

  // context menu
  viewer.select(op.id);
  const wrapEl = $('#viewport .page-wrap');
  wrapEl.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
  await pause(60);
  assert(!$('#context-menu').hidden, 'the context menu should be open');
  assert($$('#context-menu button').length >= 4, 'the context menu should offer actions');
  step('context menu opens with object actions');

  // export dialog
  click($('[data-action="download"]'));
  await pause(80);
  assert($('#modal').classList.contains('show'), 'the export dialog should be open');
  assert($('#ex-name'), 'the export dialog should have a file name field');
  assert($('input[name=ex-range]'), 'the export dialog should offer a page range');
  let exported = null;
  const origCreate = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag) {
    const e2 = origCreate(tag);
    if (tag === 'a') e2.click = function () { exported = { href: this.href, download: this.download }; };
    return e2;
  };
  click($('#modal [data-modal-ok]'));
  await waitFor(() => exported, 25000, 'export');
  assert(/edited\.pdf$/.test(exported.download), 'download name: ' + exported.download);
  step('export dialog writes a PDF');

  const pdfjs = require(path.join(ROOT, 'js/vendor/pdf.min.js'));
  pdfjs.GlobalWorkerOptions.workerSrc = path.join(ROOT, 'js/vendor/pdf.worker.min.js');
  const exportedBytes = await new Promise((resolve, reject) => {
    const fr = new window.FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result));
    fr.onerror = reject;
    fr.readAsArrayBuffer(global.__lastBlob);
  });
  assert(exportedBytes.length > 1000, 'the exported file looks empty');
  const outDoc = await pdfjs.getDocument({ data: exportedBytes, isEvalSupported: false }).promise;
  const outPage = await outDoc.getPage(1);
  const outText = await outPage.getTextContent();
  const strings = outText.items.map(i => i.str).join('|');
  assert(strings.indexOf('REPLACEMENT') >= 0, 'the edited text is missing from the exported PDF: ' + strings.slice(0, 200));
  assert(strings.indexOf('QUARTERLY') >= 0, 'the original text was lost');
  const formFields = await (await L.PDFDocument.load(exportedBytes)).getForm().getFields();
  assert(formFields.some(f => f.getName() === 'smokeName'), 'the form field should be in the export');
  step('exported PDF verified: edits, original text and form field');

  // language switching incl. RTL
  const langSel = $('#lang-select');
  assert(langSel.options.length >= 10, 'expected at least ten interface languages');
  langSel.value = 'ar';
  langSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await pause(80);
  assert(window.document.documentElement.getAttribute('dir') === 'rtl', 'Arabic should switch the UI to RTL');
  assert($('[data-i18n="download"]').textContent.indexOf('PDF') >= 0, 'toolbar still translated');
  langSel.value = 'he';
  langSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await pause(60);
  assert(window.document.documentElement.getAttribute('dir') === 'rtl', 'Hebrew should also be RTL');
  langSel.value = 'en';
  langSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await pause(60);
  step('UI language switching (including RTL) works');

  // theme
  const themeSel = $('#theme-select');
  themeSel.value = 'dark';
  themeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await pause(40);
  assert(window.document.documentElement.getAttribute('data-theme') === 'dark', 'dark theme should apply');
  themeSel.value = 'light';
  themeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  step('theme switching works');

  if (errors.length) {
    console.log('\n\x1b[31muncaught errors:\x1b[0m');
    errors.forEach(e => console.log('  ' + e));
    process.exit(1);
  }
  console.log('\n\x1b[32mdOM smoke test passed (' + checks + ' checks)\x1b[0m');
  process.exit(0);
})().catch(e => {
  console.error('\n\x1b[31m✗\x1b[0m ' + (e && e.stack || e));
  if (global.__smokeErrors) {
    console.error('\ncollected errors:');
    global.__smokeErrors.forEach(x => console.error('  ' + x));
  }
  process.exit(1);
});
