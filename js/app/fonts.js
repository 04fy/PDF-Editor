/*!
 * app/fonts.js — font registry.
 *
 * Three kinds of font are supported:
 *   system  – any font already installed in the browser/OS.  Rendered through
 *             the canvas pipeline, so it works for *every* script, but the
 *             glyphs are rasterised into the PDF.
 *   builtin – the 14 standard PDF fonts.  Written as real vector text, but
 *             they only cover WinAnsi (Latin-1 + a few extras).
 *   file    – a TTF the user added.  Previewed through the CSS Font Loading
 *             API and embedded into the PDF with fontkit (subset), so the
 *             result stays selectable.  For complex scripts the shaping is done
 *             by the browser and embedded as high resolution glyph pictures.
 */
(function (root) {
  'use strict';
  var PM = (root.PM = root.PM || {});

  var SYSTEM = [
    {
      id: 'sys-sans', kind: 'system', label: 'System sans-serif', embeddable: false,
      stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Arabic", "Noto Sans Hebrew", "Noto Sans Devanagari", "Noto Sans Thai", "Microsoft YaHei", "Hiragino Sans", Arial, sans-serif'
    },
    {
      id: 'sys-serif', kind: 'system', label: 'System serif', embeddable: false,
      stack: '"Noto Serif", Georgia, "Times New Roman", "Songti SC", "Yu Mincho", serif'
    },
    {
      id: 'sys-mono', kind: 'system', label: 'System monospace', embeddable: false,
      stack: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Noto Sans Mono", monospace'
    }
  ];

  var BUILTIN = [
    { standard: 'Helvetica', label: 'Helvetica', stack: 'Helvetica, Arial, "Liberation Sans", sans-serif' },
    { standard: 'Helvetica-Bold', label: 'Helvetica Bold', stack: 'Helvetica, Arial, "Liberation Sans", sans-serif', weight: 'bold' },
    { standard: 'Helvetica-Oblique', label: 'Helvetica Oblique', stack: 'Helvetica, Arial, sans-serif', style: 'italic' },
    { standard: 'Times-Roman', label: 'Times Roman', stack: '"Times New Roman", Times, serif' },
    { standard: 'Times-Bold', label: 'Times Bold', stack: '"Times New Roman", Times, serif', weight: 'bold' },
    { standard: 'Times-Italic', label: 'Times Italic', stack: '"Times New Roman", Times, serif', style: 'italic' },
    { standard: 'Courier', label: 'Courier', stack: '"Courier New", Courier, monospace' },
    { standard: 'Courier-Bold', label: 'Courier Bold', stack: '"Courier New", Courier, monospace', weight: 'bold' },
    { standard: 'Symbol', label: 'Symbol', stack: '"Segoe UI Symbol", "Apple Symbols", sans-serif' },
    { standard: 'ZapfDingbats', label: 'ZapfDingbats', stack: '"Segoe UI Symbol", "Apple Symbols", sans-serif' }
  ].map(function (f) {
    return {
      id: 'std-' + f.standard.toLowerCase(), kind: 'builtin', embeddable: true,
      standard: f.standard, label: f.label, stack: f.stack,
      weight: f.weight || 'normal', style: f.style || 'normal'
    };
  });

  /* Curated one-click fonts (served as plain TTF from the Google Fonts repo). */
  var RAW = 'https://raw.githubusercontent.com/google/fonts/main/';
  var LIBRARY = [
    { name: 'Noto Sans', url: RAW + 'ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf', scripts: 'Latin, Greek, Cyrillic', embed: false },
    { name: 'Noto Serif', url: RAW + 'ofl/notoserif/NotoSerif%5Bwdth,wght%5D.ttf', scripts: 'Latin, Greek, Cyrillic', embed: false },
    { name: 'Gentium Book Plus', url: RAW + 'ofl/gentiumbookplus/GentiumBookPlus-Regular.ttf', scripts: 'Latin, Greek, Cyrillic', embed: true },
    { name: 'Tinos', url: RAW + 'ofl/tinos/Tinos-Regular.ttf', scripts: 'Latin, Greek, Cyrillic', embed: true },
    { name: 'Marcellus', url: RAW + 'ofl/marcellus/Marcellus-Regular.ttf', scripts: 'Latin', embed: true },
    { name: 'Amiri', url: RAW + 'ofl/amiri/Amiri-Regular.ttf', scripts: 'Arabic', embed: true },
    { name: 'Scheherazade New', url: RAW + 'ofl/scheherazadenew/ScheherazadeNew-Regular.ttf', scripts: 'Arabic', embed: true },
    { name: 'Cairo', url: RAW + 'ofl/cairo/Cairo%5Bslnt,wght%5D.ttf', scripts: 'Arabic', embed: false },
    { name: 'Vazirmatn', url: RAW + 'ofl/vazirmatn/Vazirmatn%5Bwght%5D.ttf', scripts: 'Persian, Arabic', embed: false },
    { name: 'Noto Naskh Arabic', url: RAW + 'ofl/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf', scripts: 'Arabic', embed: false },
    { name: 'Noto Sans Hebrew', url: RAW + 'ofl/notosanshebrew/NotoSansHebrew%5Bwdth,wght%5D.ttf', scripts: 'Hebrew', embed: false },
    { name: 'Noto Sans Devanagari', url: RAW + 'ofl/notosansdevanagari/NotoSansDevanagari%5Bwdth,wght%5D.ttf', scripts: 'Hindi, Marathi, Nepali', embed: false },
    { name: 'Noto Sans Tamil', url: RAW + 'ofl/notosanstamil/NotoSansTamil%5Bwdth,wght%5D.ttf', scripts: 'Tamil', embed: false },
    { name: 'Noto Sans Thai', url: RAW + 'ofl/notosansthai/NotoSansThai%5Bwdth,wght%5D.ttf', scripts: 'Thai', embed: false },
    { name: 'Noto Sans Lao', url: RAW + 'ofl/notosanslao/NotoSansLao%5Bwdth,wght%5D.ttf', scripts: 'Lao', embed: false },
    { name: 'Noto Sans Khmer', url: RAW + 'ofl/notosanskhmer/NotoSansKhmer%5Bwdth,wght%5D.ttf', scripts: 'Khmer', embed: false },
    { name: 'Noto Sans Myanmar', url: RAW + 'ofl/notosansmyanmar/NotoSansMyanmar%5Bwdth,wght%5D.ttf', scripts: 'Burmese', embed: false },
    { name: 'Noto Sans Ethiopic', url: RAW + 'ofl/notosansethiopic/NotoSansEthiopic%5Bwdth,wght%5D.ttf', scripts: 'Amharic, Tigrinya', embed: false },
    { name: 'Noto Sans SC', url: RAW + 'ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf', scripts: 'Chinese (Simplified)', embed: false, big: true },
    { name: 'Noto Sans JP', url: RAW + 'ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf', scripts: 'Japanese', embed: false, big: true }
  ].map(function (f, i) {
    return {
      id: 'lib-' + i, kind: 'library', name: f.name, url: f.url, scripts: f.scripts,
      embeddable: f.embed, big: !!f.big
    };
  });

  function create() {
    var fonts = SYSTEM.concat(BUILTIN);
    var byId = {};
    fonts.forEach(function (f) { byId[f.id] = f; });

    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    var measureCache = new Map();
    var metricsCache = new Map();
    var listeners = [];

    function emit() { listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }

    function get(id) { return byId[id] || byId['sys-sans']; }

    function family(id) {
      var f = get(id);
      return f.stack || 'sans-serif';
    }

    /** CSS font shorthand; `size` is in points and used as CSS pixels. */
    function css(id, opts) {
      opts = opts || {};
      var f = get(id);
      var weight = opts.weight || f.weight || 'normal';
      var style = opts.style || f.style || 'normal';
      return style + ' ' + weight + ' ' + (opts.size || 12) + 'px ' + family(id);
    }

    function measure(str, id, size, letterSpacing) {
      if (!str) return 0;
      var key = id + '|' + size + '|' + (letterSpacing || 0) + '|' + str;
      var hit = measureCache.get(key);
      if (hit != null) return hit;
      ctx.font = css(id, { size: size });
      if ('letterSpacing' in ctx) ctx.letterSpacing = (letterSpacing || 0) + 'px';
      var w = ctx.measureText(str).width;
      if (!('letterSpacing' in ctx) && letterSpacing) {
        w += letterSpacing * PM.Text.graphemes(str).length;
      }
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      if (measureCache.size > 8000) measureCache.clear();
      measureCache.set(key, w);
      return w;
    }

    function metrics(id) {
      var f = get(id);
      if (f.metrics) return f.metrics;
      var cached = metricsCache.get(id);
      if (cached) return cached;
      var m = { ascent: PM.Text.DEFAULT_ASCENT, descent: PM.Text.DEFAULT_DESCENT };
      try {
        var size = 100;
        ctx.font = css(id, { size: size });
        var tm = ctx.measureText('Hxlg');
        if (tm && tm.fontBoundingBoxAscent > 0) {
          m.ascent = tm.fontBoundingBoxAscent / size;
          m.descent = (tm.fontBoundingBoxDescent || 0) / size;
        } else if (tm && tm.actualBoundingBoxAscent > 0) {
          m.ascent = tm.actualBoundingBoxAscent / size;
          m.descent = (tm.actualBoundingBoxDescent || 0) / size;
        }
      } catch (e) { void e; }
      metricsCache.set(id, m);
      f.metrics = m;
      return m;
    }

    function bytesToDataUrl(bytes, mime) {
      var view = new Uint8Array(bytes);
      var bin = '';
      var chunk = 0x8000;
      for (var i = 0; i < view.length; i += chunk) {
        bin += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
      }
      return 'data:' + (mime || 'font/ttf') + ';base64,' + btoa(bin);
    }

    /** Registers a TTF/OTF/WOFF byte array. */
    async function addBytes(bytes, label, opts) {
      opts = opts || {};
      var mime = opts.mime || 'font/ttf';
      var name = (label || 'Font').replace(/\.(ttf|otf|woff2?|ttc)$/i, '');
      var id = 'file-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e5).toString(36);
      var cssFamily = 'pmfont-' + id;
      var def = {
        id: id, kind: 'file', label: name, family: cssFamily,
        stack: '"' + cssFamily + '"', embeddable: opts.embeddable !== false,
        bytes: bytes, mime: mime, dataUrl: bytesToDataUrl(bytes, mime),
        size: bytes.length
      };
      if (root.FontFace && root.document && document.fonts) {
        try {
          var face = new FontFace(cssFamily, bytes.buffer ? bytes.buffer.slice(0) : bytes);
          await face.load();
          document.fonts.add(face);
        } catch (e) {
          throw new Error('The browser refused this font file (' + e.message + ')');
        }
      }
      fonts.push(def);
      byId[id] = def;
      measureCache.clear();
      metricsCache.clear();
      emit();
      return def;
    }

    async function addFile(file) {
      var buf = await file.arrayBuffer();
      var isWoff = /\.woff2?$/i.test(file.name);
      return addBytes(new Uint8Array(buf), file.name, {
        mime: /\.otf$/i.test(file.name) ? 'font/otf' : isWoff ? 'font/' + file.name.split('.').pop() : 'font/ttf',
        // WOFF containers are not understood by fontkit, so keep them raster-only
        embeddable: !isWoff
      });
    }

    async function addUrl(url, label, opts) {
      var res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var buf = await res.arrayBuffer();
      return addBytes(new Uint8Array(buf), label || (url.split('/').pop().replace(/%5B.*%5D/, '')), opts);
    }

    function remove(id) {
      var i = fonts.indexOf(byId[id]);
      if (i >= 0) fonts.splice(i, 1);
      delete byId[id];
      measureCache.clear();
      metricsCache.clear();
      emit();
    }

    return {
      fontkit: root.fontkit || null,
      library: LIBRARY,
      list: function () { return fonts.slice(); },
      get: get,
      family: family,
      css: css,
      measure: measure,
      metrics: metrics,
      addBytes: addBytes,
      addFile: addFile,
      addUrl: addUrl,
      remove: remove,
      has: function (id) { return !!byId[id]; },
      subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
      invalidate: function () { measureCache.clear(); metricsCache.clear(); }
    };
  }

  PM.Fonts = { create: create, SYSTEM: SYSTEM, BUILTIN: BUILTIN, LIBRARY: LIBRARY };
})(typeof globalThis !== 'undefined' ? globalThis : this);
