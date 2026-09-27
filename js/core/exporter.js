/*!
 * core/exporter.js — turns the editable document model into a real PDF with
 * pdf-lib.  Everything is done additively: the original page content, fonts,
 * annotations, forms and metadata are preserved and the edits are painted on
 * top.  Pure logic — all browser-only work is delegated through `ctx`.
 */
(function (root, factory) {
  var ns = (root.PM = root.PM || {});
  var mod = factory(ns.Text);
  ns.Exporter = mod;
  if (typeof module === 'object' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Text) {
  'use strict';

  var PAGE_SIZES = {
    a3: [841.89, 1190.55],
    a4: [595.28, 841.89],
    a5: [419.53, 595.28],
    letter: [612, 792],
    legal: [612, 1008],
    tabloid: [792, 1224]
  };

  var gsCounter = 0;

  function createCtx(opts) {
    opts = opts || {};
    var L = opts.PDFLib || (typeof PDFLib !== 'undefined' ? PDFLib : null);
    if (!L) throw new Error('pdf-lib is not available');
    return {
      PDFLib: L,
      fontkit: opts.fontkit || (typeof fontkit !== 'undefined' ? fontkit : null),
      getFontBytes: opts.getFontBytes || function () { return Promise.resolve(null); },
      getAsset: opts.getAsset || function () { return null; },
      resolveFont: opts.resolveFont || function () { return { kind: 'system' }; },
      metrics: opts.metrics || function () { return { ascent: Text.DEFAULT_ASCENT, descent: Text.DEFAULT_DESCENT }; },
      measureCanvas: opts.measureCanvas || function () { return 0; },
      textToImage: opts.textToImage || null,
      renderPage: opts.renderPage || null,
      password: opts.password || '',
      warn: opts.warn || function () { },
      dpr: opts.dpr || 4
    };
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function base64ToBytes(dataUrl) {
    var str = String(dataUrl);
    var i = str.indexOf(',');
    var b64 = i < 0 ? str : str.slice(i + 1);
    if (typeof atob === 'function') {
      var bin = atob(b64);
      var out = new Uint8Array(bin.length);
      for (var k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
      return out;
    }
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    throw new Error('No base64 decoder available');
  }

  function bytesFromAsset(asset, op) {
    if (asset && asset.bytes && asset.bytes.length) return asset.bytes;
    var url = (op && op.dataUrl) || (asset && asset.dataUrl);
    return url ? base64ToBytes(url) : null;
  }

  function colorOf(L, hex) { return L.rgb.apply(L, Text.hexToRgb01(hex)); }

  function toBytes(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
    if (typeof Buffer !== 'undefined') return Buffer.from(text, 'latin1');
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  /** Wraps operator lists in a graphics state carrying fill/stroke alpha. */
  function alphaGroup(L, pdfDoc, page, alpha, blendMode, inner) {
    var a = alpha == null ? 1 : Math.max(0, Math.min(1, Number(alpha)));
    if (a >= 1 && !blendMode) return inner();
    var node = page.node.Resources();
    if (!node) {
      node = pdfDoc.context.obj({});
      page.node.set(L.PDFName.of('Resources'), pdfDoc.context.register(node));
    }
    var gs = node.lookup(L.PDFName.of('ExtGState'));
    if (!gs) { gs = pdfDoc.context.obj({}); node.set(L.PDFName.of('ExtGState'), gs); }
    var name = 'PMGS' + (++gsCounter);
    var dict = { Type: 'ExtGState', ca: a, CA: a };
    if (blendMode) dict.BM = L.PDFName.of(blendMode);
    gs.set(L.PDFName.of(name), pdfDoc.context.register(pdfDoc.context.obj(dict)));
    return [L.pushGraphicsState(), L.setGraphicsState(name)]
      .concat(inner())
      .concat([L.popGraphicsState()]);
  }

  /**
   * Maps "box space" (origin at the centre of the box, x right, y DOWN) onto
   * PDF user space, rotating around the centre of the box.
   */
  function withTransform(L, box, angleDeg, inner) {
    var cx = box.x0 + box.x + box.w / 2;
    var cy = box.y1 - (box.y + box.h / 2);
    var phi = -(Number(angleDeg) || 0) * Math.PI / 180;
    return [
      L.pushGraphicsState(),
      L.translate(cx, cy),
      L.rotateRadians(phi),
      L.scale(1, -1),
      L.translate(-box.w / 2, -box.h / 2)
    ].concat(inner()).concat([L.popGraphicsState()]);
  }

  function pageBox(page) {
    var crop = page.getCropBox ? page.getCropBox() : page.getMediaBox();
    return { x0: crop.x, y1: crop.y + crop.height };
  }

  /* ------------------------------------------------------------------ *
   * Main entry point
   * ------------------------------------------------------------------ */

  async function apply(bytes, doc, ctx) {
    var L = ctx.PDFLib;
    var warnings = [];
    var warn = function (m) { warnings.push(String(m)); ctx.warn(String(m)); };

    var pdfDoc = await loadDoc(bytes, ctx, warn);
    if (ctx.fontkit) {
      try { pdfDoc.registerFontkit(ctx.fontkit); }
      catch (e) { warn('Font embedding is unavailable: ' + e.message); }
    }
    var srcPages = pdfDoc.getPages();
    var modelPages = doc.pages || [];

    /* ---- duplicate pages (before deletions so the indices stay valid) --- */
    var pageById = {};
    var i, j;
    for (i = 0; i < modelPages.length; i++) {
      var mp = modelPages[i];
      if (mp.blank) {
        var ref = modelPages[i - 1];
        var refSize = ref ? pageSizeOf(ref, srcPages) : null;
        pageById[mp.id] = pdfDoc.addPage(refSize || [595.28, 841.89]);
      } else if (!mp.duplicate && srcPages[mp.sourceIndex]) {
        pageById[mp.id] = srcPages[mp.sourceIndex];
      }
    }
    for (i = 0; i < modelPages.length; i++) {
      var dup = modelPages[i];
      if (!dup.duplicate) continue;
      var originIdx = dup.sourceIndex;
      for (j = 0; j < i; j++) {
        if (modelPages[j].id === dup.sourceOf) { originIdx = modelPages[j].sourceIndex; break; }
      }
      try {
        var copies = await pdfDoc.copyPages(pdfDoc, [originIdx]);
        pageById[dup.id] = pdfDoc.addPage(copies[0]);
      } catch (e) {
        warn('Could not duplicate the page: ' + e.message);
        pageById[dup.id] = srcPages[originIdx] || pdfDoc.addPage([595.28, 841.89]);
      }
    }

    /* ---- flatten / secure redaction: rebuild the page as a bitmap ------- */
    for (i = 0; i < modelPages.length; i++) {
      var fm = modelPages[i];
      var target = pageById[fm.id];
      var redactions = redactionRects(fm.id, doc.ops);
      if ((!fm.flattened && !redactions.length) || !ctx.renderPage || !target) continue;
      try {
        var shot = await ctx.renderPage({
          sourceIndex: fm.sourceIndex, rotation: 0,
          dpi: (redactions.length ? (fm.redactDpi || 300) : (fm.flattenDpi || 150)),
          redactions: redactions
        });
        if (!shot || !shot.bytes) throw new Error('no bitmap produced');
        var box = target.getSize();
        var fresh = pdfDoc.addPage([box.width, box.height]);
        if (fm.background) {
          var bc = Text.hexToRgb01(fm.background);
          fresh.drawRectangle({ x: 0, y: 0, width: box.width, height: box.height, color: L.rgb(bc[0], bc[1], bc[2]) });
        }
        var flatImg = await embedImage(pdfDoc, shot.bytes, shot.mime || 'image/png');
        if (flatImg) drawImage(L, fresh, flatImg, 0, 0, box.width, box.height, 'stretch', 0);
        pageById[fm.id] = fresh;
        warn(redactions.length
          ? 'Page ' + (i + 1) + ' was rasterised to remove the redacted content for good.'
          : 'Page flattened — annotations, form fields and selectable text on that page are rasterised.');
      } catch (e) {
        warn('Flatten failed on a page: ' + e.message);
      }
    }

    /* ---- deletions and page order --------------------------------------
     * The page tree is rewritten in one go: pdf-lib's removePage() leaves the
     * /Kids array and /Count stale, which produces broken files.            */
    var ordered = [];
    for (i = 0; i < modelPages.length; i++) {
      var m = modelPages[i];
      if (m.deleted) continue;
      var pg = pageById[m.id];
      if (pg) ordered.push({ model: m, page: pg });
    }
    if (ordered.length) {
      try {
        var tree = pdfDoc.catalog.Pages();
        var refs = ordered.map(function (e) { return e.page.ref; });
        tree.set(L.PDFName.of('Kids'), pdfDoc.context.obj(refs));
        tree.set(L.PDFName.of('Count'), L.PDFNumber.of(refs.length));
      } catch (e) {
        warn('Page re-ordering failed: ' + e.message);
      }
      var keep = {};
      ordered.forEach(function (e) { keep[e.page.ref.toString()] = true; });
      pdfDoc.getPages().forEach(function (p) {
        if (p.ref && !keep[p.ref.toString()]) {
          try { pdfDoc.context.delete(p.ref); } catch (e) { /* harmless orphan */ }
        }
      });
    }

    /* ---- page geometry, background, operations ------------------------- */
    var fontCache = new Map();
    var imageCache = new Map();

    for (i = 0; i < ordered.length; i++) {
      var entry = ordered[i];
      var page = entry.page;
      applyPageGeometry(L, page, entry.model, warn);

      if (entry.model.background && !entry.model.flattened) {
        try {
          var size = page.getSize();
          var col = Text.hexToRgb01(entry.model.background);
          prependContent(L, pdfDoc, page,
            'q ' + col[0] + ' ' + col[1] + ' ' + col[2] + ' rg 0 0 ' + size.width + ' ' + size.height + ' re f Q\n');
        } catch (e) { warn('Page background failed: ' + e.message); }
      }

      var ops = (doc.ops || []).filter(function (o) { return o.pageId === entry.model.id && o.visible !== false; });
      for (j = 0; j < ops.length; j++) {
        try { await drawOp(ctx, pdfDoc, page, ops[j], fontCache, imageCache, warn); }
        catch (e) { warn('An operation failed (' + ops[j].type + '): ' + (e && e.message)); }
      }
    }

    if (ctx.flattenForm) {
      try {
        pdfDoc.getForm().flatten({ updateFieldAppearances: true });
      } catch (e) { warn('The form could not be flattened: ' + e.message); }
    }

    try {
      pdfDoc.setProducer('HTML PDF Modifier');
      pdfDoc.setModificationDate(new Date());
    } catch (e) { void e; }

    var out = await pdfDoc.save({ useObjectStreams: true });
    return { bytes: out, warnings: warnings, pageCount: ordered.length };
  }

  /** Bounding boxes of the redaction marks on a page. */
  function redactionRects(pageId, ops) {
    var out = [];
    (ops || []).forEach(function (op) {
      if (op.pageId !== pageId || op.type !== 'shape' || !op.redaction) return;
      if (op.visible === false) return;
      out.push({ x: op.x, y: op.y, w: op.w, h: op.h, color: op.fill || '#000000' });
    });
    return out;
  }

  function pageSizeOf(modelPage, srcPages) {
    var ref = srcPages[modelPage.sourceIndex];
    if (!ref) return null;
    var s = ref.getSize();
    return [s.width, s.height];
  }

  async function loadDoc(bytes, ctx, warn) {
    var opts = { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false };
    try {
      return await ctx.PDFLib.PDFDocument.load(bytes, opts);
    } catch (e) {
      if (/encrypted|password/i.test(e.message || '')) {
        try {
          return await ctx.PDFLib.PDFDocument.load(Object.assign({}, opts, { password: ctx.password || '' }));
        } catch (e2) {
          warn('The PDF could not be opened — it may be password protected.');
          throw e2;
        }
      }
      warn('The PDF could not be parsed: ' + e.message);
      throw e;
    }
  }

  /* ------------------------------------------------------------------ *
   * Page geometry
   * ------------------------------------------------------------------ */

  function applyPageGeometry(L, page, m, warn) {
    try { page.setRotation(L.degrees(((Number(m.rotation) || 0) % 360 + 360) % 360)); } catch (e) { void e; }

    if (m.sizeMode && m.sizeMode !== 'keep') {
      var target = PAGE_SIZES[m.sizeMode] || (m.sizeMode === 'custom' ? m.customSize : null);
      if (target && target[0] > 0 && target[1] > 0) {
        var cur = page.getSize();
        if (cur.width > 0 && cur.height > 0 &&
            (Math.abs(cur.width - target[0]) > 0.5 || Math.abs(cur.height - target[1]) > 0.5)) {
          // scale uniformly so nothing is distorted, then centre the result
          var k = Math.min(target[0] / cur.width, target[1] / cur.height);
          var dx = (target[0] - cur.width * k) / 2;
          var dy = (target[1] - cur.height * k) / 2;
          try { page.scaleContent(k, k, { translateX: dx, translateY: dy }); }
          catch (e) {
            try { page.scaleContent(k, k); }
            catch (e2) { warn('Content could not be rescaled to the new page size.'); }
          }
        }
        try { page.setSize(target[0], target[1]); } catch (e) { void e; }
      }
    }

    if (m.crop && m.crop.width > 0 && m.crop.height > 0) {
      try { page.setCropBox(m.crop.x, m.crop.y, m.crop.width, m.crop.height); }
      catch (e) { warn('Crop box could not be applied.'); }
    }
  }

  function prependContent(L, pdfDoc, page, text) {
    var stream = pdfDoc.context.flateStream(toBytes(text));
    var ref = pdfDoc.context.register(stream);
    var contents = page.node.Contents();
    var arr;
    if (!contents) arr = pdfDoc.context.obj([ref]);
    else if (typeof contents.asArray === 'function') arr = pdfDoc.context.obj([ref].concat(contents.asArray()));
    else arr = pdfDoc.context.obj([ref, contents]);
    page.node.set(L.PDFName.of('Contents'), arr);
  }

  /* ------------------------------------------------------------------ *
   * Images
   * ------------------------------------------------------------------ */

  async function embedImage(pdfDoc, bytes, mime) {
    if (!bytes || !bytes.length) return null;
    if (/jp(e|g)/.test(String(mime || '').toLowerCase())) return pdfDoc.embedJpg(bytes);
    return pdfDoc.embedPng(bytes);
  }

  /**
   * Places an image so that its top-left corner sits at (x, y) in page space,
   * rotating around the centre of the placed rectangle.
   */
  function drawImage(L, page, image, x, y, w, h, fit, angle, opacity) {
    var tw = w, th = h, tx = x, ty = y;
    var nat = { w: image.width, h: image.height };
    if (fit && fit !== 'stretch' && nat.w > 0 && nat.h > 0) {
      var s = fit === 'cover' ? Math.max(w / nat.w, h / nat.h) : Math.min(w / nat.w, h / nat.h);
      tw = nat.w * s; th = nat.h * s;
      tx = x + (w - tw) / 2; ty = y + (h - th) / 2;
    }
    var deg = Number(angle) || 0;
    var th2 = deg * Math.PI / 180;
    var cx = tx + tw / 2, cy = ty + th / 2;
    // bottom-left corner of the rectangle after rotating it about its centre
    var rx = (-tw / 2) * Math.cos(th2) - (th / 2) * Math.sin(th2);
    var ry = (-tw / 2) * Math.sin(th2) + (th / 2) * Math.cos(th2);
    var pb = pageBox(page);
    var opts = {
      x: pb.x0 + cx + rx,
      y: pb.y1 - cy - ry,
      width: tw,
      height: th,
      rotate: L.degrees(-deg)
    };
    if (opacity != null && opacity < 1) opts.opacity = opacity;
    page.drawImage(image, opts);
  }

  function push(L, page, ops) { page.pushOperators.apply(page, ops); }

  /* ------------------------------------------------------------------ *
   * Shapes
   * ------------------------------------------------------------------ */

  function rectPath(L, w, h, r) {
    r = Math.max(0, Math.min(Number(r) || 0, Math.min(w, h) / 2));
    if (!r) return [L.moveTo(0, 0), L.lineTo(w, 0), L.lineTo(w, h), L.lineTo(0, h), L.closePath()];
    var k = r * 0.5523;
    return [
      L.moveTo(r, 0), L.lineTo(w - r, 0),
      L.appendBezierCurve(w - r + k, 0, w, r - k, w, r),
      L.lineTo(w, h - r),
      L.appendBezierCurve(w, h - r + k, w - r + k, h, w - r, h),
      L.lineTo(r, h),
      L.appendBezierCurve(r - k, h, 0, h - r + k, 0, h - r),
      L.lineTo(0, r),
      L.appendBezierCurve(0, r - k, r - k, 0, r, 0),
      L.closePath()
    ];
  }

  /** Ellipse inscribed in the box, as four cubic beziers (box space, y down). */
  function ellipsePath(L, w, h) {
    var cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
    var k = 0.5523;
    return [
      L.moveTo(cx + rx, cy),
      L.appendBezierCurve(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry),
      L.appendBezierCurve(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy),
      L.appendBezierCurve(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry),
      L.appendBezierCurve(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy),
      L.closePath()
    ];
  }

  /** A line of thickness `t` running along the diagonal of the box. */
  function linePath(L, w, h, t) {
    var len = Math.sqrt(w * w + h * h) || 1;
    var ux = w / len, uy = h / len;          // along the diagonal (box space, y down)
    var nx = -uy, ny = ux;                  // normal
    var ht = t / 2, he = t / 2;
    function P(alongU, alongN) {
      return [ux * alongU + nx * alongN, uy * alongU + ny * alongN];
    }
    var a = P(-he, ht), b = P(len + he, ht), c = P(len + he, -ht), d = P(-he, -ht);
    return [
      L.moveTo(a[0], a[1]), L.lineTo(b[0], b[1]),
      L.lineTo(c[0], c[1]), L.lineTo(d[0], d[1]), L.closePath()
    ];
  }

  function drawShape(L, page, op) {
    var w = Math.abs(op.w), h = Math.abs(op.h);
    if (!w || !h) return;
    var alpha = op.opacity == null ? 1 : op.opacity;
    var fillAlpha = alpha * (op.fillOpacity == null ? 1 : op.fillOpacity);
    var isLine = op.shape === 'line';
    var hasFill = !isLine && op.fill && op.fill !== 'none' && fillAlpha > 0.004;
    var hasStroke = (isLine || (op.stroke && op.stroke !== 'none' && op.strokeWidth > 0)) && alpha > 0.004;
    var box = { x0: pageBox(page).x0, y1: pageBox(page).y1, x: op.x, y: op.y, w: w, h: h };

    push(L, page, withTransform(L, box, op.rotate, function () {
      return alphaGroup(L, page.doc, page, hasFill ? fillAlpha : alpha, op.blendMode, function () {
        var list = [];
        if (op.shape === 'ellipse') {
          list = list.concat(ellipsePath(L, w, h));
        } else if (isLine) {
          list = list.concat(linePath(L, w, h, Math.max(0.1, Number(op.strokeWidth) || 1)));
        } else {
          list = list.concat(rectPath(L, w, h, op.radius));
        }
        if (hasFill) list.push(L.setFillingColor(colorOf(L, op.fill)));
        if (hasStroke) {
          list.push(L.setLineWidth(Math.max(0.1, Number(op.strokeWidth) || 1)));
          list.push(L.setStrokingColor(colorOf(L, op.stroke)));
          if (op.dash && op.dash.length) list.push(L.setDashPattern(op.dash, 0));
        }
        if (hasFill && hasStroke) list.push(L.fillAndStroke ? L.fillAndStroke() : L.fill());
        else if (hasFill) list.push(L.fill());
        else if (hasStroke) list.push(L.stroke());
        else list.push(L.closePath());
        return list;
      });
    }));
  }

  /* ------------------------------------------------------------------ *
   * Text
   * ------------------------------------------------------------------ */

  function resolveRenderMode(ctx, op) {
    if (op.render === 'vector') return 'vector';
    if (op.render === 'shape') return 'shape';
    var font = ctx.resolveFont(op.fontId) || { kind: 'system' };
    if (font.kind === 'system') return 'shape';
    if (Text.needsShaping(op.text || '')) return 'shape';
    if (font.kind === 'builtin' && !Text.winAnsiSafe(op.text || '')) return 'shape';
    return 'vector';
  }

  function getPdfFont(ctx, pdfDoc, fontId, cache, warn) {
    var key = 'f:' + fontId;
    if (cache.has(key)) return cache.get(key);
    var promise = (async function () {
      var font = ctx.resolveFont(fontId) || { kind: 'system' };
      if (font.kind === 'builtin') {
        return await pdfDoc.embedFont(ctx.PDFLib.StandardFonts[font.standard || 'Helvetica']);
      }
      if (font.kind === 'file') {
        var bytes = await ctx.getFontBytes(fontId);
        if (!bytes) return null;
        if (!ctx.fontkit) throw new Error('fontkit is required to embed custom fonts');
        return await pdfDoc.embedFont(bytes, { subset: true });
      }
      return null;
    })().catch(function (e) {
      warn('Font "' + fontId + '" could not be embedded (' + e.message + '); the text is drawn as a picture instead.');
      return null;
    });
    cache.set(key, promise);
    return promise;
  }

  function vectorMeasure(font, op, size) {
    return function (str) {
      var w = font.widthOfTextAtSize(str, size);
      if (op.letterSpacing) w += op.letterSpacing * Text.graphemes(str).length;
      return w;
    };
  }

  function coverRectOf(op) {
    var mode = op.coverMode || 'auto';
    if (mode === 'none' || op.cover === false) return null;
    var pad = Number(op.coverPadding) || 0;
    var r = { x: op.x, y: op.y, w: op.w, h: op.h };
    var src = op.sourceRect;
    if (src && src.w > 0) {
      if (mode === 'source') r = { x: src.x, y: src.y, w: src.w, h: src.h };
      else if (mode === 'auto') {
        var x0 = Math.min(r.x, src.x), y0 = Math.min(r.y, src.y);
        var x1 = Math.max(r.x + r.w, src.x + src.w), y1 = Math.max(r.y + r.h, src.y + src.h);
        r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
    }
    return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
  }

  function drawCover(L, page, op) {
    var r = coverRectOf(op);
    if (!r) return;
    drawShape(L, page, {
      shape: 'rect', x: r.x, y: r.y, w: r.w, h: r.h, rotate: op.rotate,
      fill: op.coverColor || '#ffffff', fillOpacity: 1, stroke: null, strokeWidth: 0,
      radius: 0, dash: null, opacity: 1, blendMode: op.blendMode
    });
  }

  async function drawOp(ctx, pdfDoc, page, op, fontCache, imageCache, warn) {
    var L = ctx.PDFLib;

    if (op.type === 'shape') { drawShape(L, page, op); return; }

    if (op.type === 'image') {
      var asset = op.assetId ? ctx.getAsset(op.assetId) : null;
      var bytes = bytesFromAsset(asset, op);
      if (!bytes) { warn('Image data missing for "' + (op.name || op.id) + '".'); return; }
      var key = 'i:' + (op.assetId || op.id) + ':' + bytes.length;
      if (!imageCache.has(key)) {
        imageCache.set(key, embedImage(pdfDoc, bytes, op.mime).catch(function (e) {
          warn('Image could not be embedded: ' + e.message); return null;
        }));
      }
      var img = await imageCache.get(key);
      if (img) drawImage(L, page, img, op.x, op.y, op.w, op.h, op.fit || 'contain', op.rotate, op.opacity);
      return;
    }

    if (op.type === 'field') {
      await drawField(ctx, pdfDoc, page, op, fontCache, warn);
      return;
    }

    if (op.type !== 'text') return;
    if (!op.text) { drawCover(L, page, op); return; }

    var mode = resolveRenderMode(ctx, op);

    if (mode === 'vector') {
      var font = await getPdfFont(ctx, pdfDoc, op.fontId, fontCache, warn);
      if (!font) mode = 'shape';
      else {
        var m = ctx.metrics(op.fontId) || {};
        var size = Number(op.size) || 12;
        var base = {
          text: op.text, width: op.w, lineHeight: op.lineHeight || 1.2,
          align: op.align, dir: op.dir, metrics: m
        };
        var lay = Text.layout(Object.assign({ size: size, measure: vectorMeasure(font, op, size) }, base));
        if (op.autoFit && lay.lines.length) {
          var widest = lay.lines.reduce(function (a, l) { return Math.max(a, l.width); }, 0);
          if (widest > op.w && op.w > 4) {
            size = size * (op.w / widest);
            lay = Text.layout(Object.assign({ size: size, measure: vectorMeasure(font, op, size) }, base));
          }
        }
        drawCover(L, page, op);
        try {
          drawTextLines(L, page, op, lay, font, size, colorOf(L, op.color), op.opacity);
          if (op.searchLayer) drawTextLines(L, page, op, lay, font, size, colorOf(L, op.color), 0);
        } catch (e) {
          warn('Vector text failed (' + e.message + '); switching to shaped text.');
          mode = 'shape';
        }
      }
    }

    if (mode === 'shape') {
      if (!ctx.textToImage) {
        warn('No text rasteriser is available for script "' + Text.analyse(op.text).script + '".');
        return;
      }
      drawCover(L, page, op);
      var spec = {
        lines: Text.wrap(op.text, op.w, ctx.measureCanvas(op)),
        metrics: ctx.metrics(op.fontId) || {},
        scale: ctx.dpr,
        fontId: op.fontId,
        cssFont: ctx.fontCss ? ctx.fontCss(op.fontId, op) : null,
        size: Number(op.size) || 12,
        width: op.w,
        height: op.h,
        lineHeight: Number(op.lineHeight) || 1.2,
        color: op.color,
        align: op.align,
        dir: op.dir,
        letterSpacing: op.letterSpacing || 0
      };
      var shot;
      try { shot = await ctx.textToImage(spec); }
      catch (e) { warn('Text rendering failed: ' + e.message); return; }
      if (!shot || !shot.bytes) return;
      var tImg = await embedImage(pdfDoc, shot.bytes, shot.mime || 'image/png');
      if (!tImg) return;
      var ph = shot.height / spec.scale;
      var offY = op.valign === 'middle' ? (op.h - ph) / 2 : op.valign === 'bottom' ? op.h - ph : 0;
      drawImage(L, page, tImg, op.x, op.y + Math.max(0, offY), op.w, ph, 'stretch', op.rotate, 1);

      if (op.searchLayer) {
        var sfont = await getPdfFont(ctx, pdfDoc, op.fontId, fontCache, function () { });
        if (sfont) {
          try {
            var sm = ctx.metrics(op.fontId) || {};
            var sz = Number(op.size) || 12;
            var slay = Text.layout({
              text: op.text, width: op.w, size: sz, lineHeight: spec.lineHeight,
              align: op.align, dir: op.dir, metrics: sm, measure: vectorMeasure(sfont, op, sz)
            });
            drawTextLines(L, page, Object.assign({}, op, { h: ph, y: op.y + Math.max(0, offY) }),
              slay, sfont, sz, colorOf(L, op.color), 0);
          } catch (e) { void e; }
        }
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Interactive form fields
   * ------------------------------------------------------------------ */

  async function drawField(ctx, pdfDoc, page, op, fontCache, warn) {
    var L = ctx.PDFLib;
    var f = op.field || {};
    var form;
    try { form = pdfDoc.getForm(); }
    catch (e) { warn('Form fields are not supported for this document: ' + e.message); return; }

    var pb = pageBox(page);
    var name = String(f.name || ('field' + op.id)).replace(/[^A-Za-z0-9._-]/g, '_');
    var base = {
      x: pb.x0 + op.x,
      y: pb.y1 - (op.y + op.h),
      width: Math.max(3, op.w),
      height: Math.max(3, op.h),
      rotate: L.degrees(-(Number(op.rotate) || 0)),
      borderWidth: f.borderWidth == null ? 1 : f.borderWidth,
      textColor: f.textColor ? colorOf(L, f.textColor) : L.rgb(0, 0, 0)
    };
    if (f.borderColor) base.borderColor = colorOf(L, f.borderColor);
    if (f.backgroundColor) base.backgroundColor = colorOf(L, f.backgroundColor);

    // the appearance font is resolved up front: a text field needs its /DA
    // entry before the size and the widget can be written
    var font = await getPdfFont(ctx, pdfDoc, op.fontId || 'std-helvetica', fontCache, function () { });

    try {
      if (f.kind === 'checkbox') {
        var cb = form.createCheckBox(name);
        f.value ? cb.check() : cb.uncheck();
        if (f.readOnly) cb.enableReadOnly();
        cb.addToPage(page, base);
      } else if (f.kind === 'radio') {
        var rg = form.createRadioGroup(name);
        rg.addOptionToPage(f.value || 'Option', page, base);
        if (f.readOnly) rg.enableReadOnly();
      } else if (f.kind === 'dropdown') {
        var dd = form.createDropdown(name);
        if (f.options && f.options.length) dd.setOptions(f.options.map(String));
        if (f.value != null && f.value !== '') dd.select(String(f.value));
        if (f.readOnly) dd.enableReadOnly();
        dd.addToPage(page, base);
      } else {
        var tf = form.createTextField(name);
        // pdf-lib refuses to set a size or a value before the field carries a
        // default appearance, so the /DA is written first
        var size = f.fontSize || Math.max(6, Math.min(24, op.h * 0.6));
        try { tf.acroField.setDefaultAppearance('/Helv ' + size + ' Tf 0 g'); }
        catch (e) { void e; }
        if (font) tf.updateAppearances(font);
        tf.setFontSize(size);
        tf.setText(f.value == null ? '' : String(f.value));
        if (f.multiline) tf.enableMultiline();
        if (f.maxLen) tf.setMaxLength(f.maxLen);
        if (f.readOnly) tf.enableReadOnly();
        tf.addToPage(page, base);
      }
      if (!font) {
        // nothing to embed: make sure pdf-lib still writes a default appearance
        try { form.updateFieldAppearances(); } catch (e) { void e; }
      }
    } catch (e) {
      warn('Form field "' + name + '" could not be created: ' + e.message);
    }
  }

  /**
   * Paints laid-out lines.  pdf-lib rotates the text matrix around the origin,
   * so every baseline start is rotated around the centre of the block here.
   */
  function drawTextLines(L, page, op, lay, font, size, color, opacity) {
    var dir = op.dir === 'rtl' || (op.dir !== 'ltr' && Text.isRTL(op.text)) ? 'rtl' : 'ltr';
    var align = Text.resolveAlign(op.align, dir);
    var blockH = lay.lines.length * lay.lineHeight;
    var vAlign = op.valign || 'top';
    var blockY = vAlign === 'middle' ? op.y + (op.h - blockH) / 2
      : vAlign === 'bottom' ? op.y + (op.h - blockH) : op.y;
    var cx = op.x + op.w / 2, cy = op.y + op.h / 2;
    var pb = pageBox(page);
    var pxc = pb.x0 + cx, pyc = pb.y1 - cy;
    var angle = Number(op.rotate) || 0;
    var phi = -angle * Math.PI / 180;          // PDF space rotates counter-clockwise
    var cos = Math.cos(phi), sin = Math.sin(phi);

    for (var i = 0; i < lay.lines.length; i++) {
      var line = lay.lines[i];
      if (!line.text) continue;
      var lx = op.x + Text.lineOffset(align, dir, line.width, op.w);
      var baseline = blockY + (lay.lineHeight - (lay.ascent + lay.descent)) / 2 + lay.ascent + i * lay.lineHeight;
      // offset from the centre of the box, in page space (y down)
      var dx = lx - cx, dy = baseline - cy;
      // page space -> PDF space (flip y) -> rotate by phi
      var ox = dx * cos + dy * sin;
      var oy = dx * sin - dy * cos;
      page.drawText(line.text, {
        x: pxc + ox,
        y: pyc + oy,
        size: size,
        font: font,
        color: color,
        rotate: L.degrees(-angle),
        opacity: opacity == null ? 1 : opacity
      });
    }
  }

  return {
    apply: apply,
    createCtx: createCtx,
    PAGE_SIZES: PAGE_SIZES,
    base64ToBytes: base64ToBytes,
    drawShape: drawShape,
    withTransform: withTransform
  };
});
