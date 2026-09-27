/*!
 * app/pdfsource.js — everything that talks to PDF.js: loading, rendering,
 * text extraction (with paragraph grouping) and image extraction.
 *
 * Coordinate system used everywhere in this application ("page space"):
 *   origin at the top-left of the crop box, x to the right, y downwards,
 *   one unit = one PDF point (1/72 inch), page rotation NOT applied.
 */
(function (root) {
  'use strict';
  var PM = (root.PM = root.PM || {});
  var Text = PM.Text;

  function create(pdfjs) {
    var doc = null;
    var bytes = null;
    var pageCache = new Map();
    var sizes = [];

    function worker() {
      if (pdfjs.GlobalWorkerOptions.workerSrc) return pdfjs.GlobalWorkerOptions.workerSrc;
      var base = root.location && root.location.href ? root.location.href : '';
      var guess = 'js/vendor/pdf.worker.min.js';
      try { guess = new URL(guess, base).href; } catch (e) { void e; }
      pdfjs.GlobalWorkerOptions.workerSrc = guess;
      return guess;
    }

    function fingerprint(data) {
      var len = data.length;
      var step = Math.max(1, Math.floor(len / 4096));
      var h = 2166136261;
      for (var i = 0; i < len; i += step) {
        h ^= data[i];
        h = Math.imul(h, 16777619);
      }
      return (len.toString(16) + '-' + (h >>> 0).toString(16));
    }

    async function load(data, opts) {
      opts = opts || {};
      await destroy();
      bytes = data;
      var task = pdfjs.getDocument({
        data: data.slice(0),
        password: opts.password || undefined,
        isEvalSupported: false,
        useSystemFonts: true,
        disableFontFace: false,
        verbosity: 0
      });
      doc = await task.promise;
      pageCache.clear();
      sizes = [];
      var pages = [];
      for (var i = 0; i < doc.numPages; i++) {
        var p = await page(i);
        var view = p.view;                     // [x0, y0, x1, y1] of the crop box
        var info = {
          index: i,
          x0: view[0], y1: view[3],
          width: view[2] - view[0],
          height: view[3] - view[1],
          rotate: ((p.rotate % 360) + 360) % 360,
          view: view.slice(0)
        };
        sizes[i] = info;
        pages.push(info);
      }
      return { numPages: doc.numPages, pages: pages, fingerprint: fingerprint(data) };
    }

    async function destroy() {
      pageCache.clear();
      sizes = [];
      if (doc) { try { await doc.destroy(); } catch (e) { void e; } }
      doc = null; bytes = null;
    }

    async function page(index) {
      if (pageCache.has(index)) return pageCache.get(index);
      if (!doc) throw new Error('No document loaded');
      var p = await doc.getPage(index + 1);
      pageCache.set(index, p);
      return p;
    }

    /** Synchronous access — valid because load() resolves every page once. */
    function pageSync(index) { return pageCache.get(index) || null; }

    function pageInfo(index) { return sizes[index] || null; }

    function toPage(index, x, y) {
      var info = pageInfo(index);
      if (!info) return { x: x, y: y };
      return { x: x - info.x0, y: info.y1 - y };
    }

    /* ---------------------------------------------------------------- *
     * Rendering
     * ---------------------------------------------------------------- */

    /**
     * Renders a page into `canvas`.  Returns a promise that resolves once the
     * page has been painted.
     */
    async function render(index, canvas, opts) {
      opts = opts || {};
      var p = await page(index);
      var scale = opts.scale || 1;
      var rotation = opts.rotation == null ? (((p.rotate % 360) + 360) % 360) : opts.rotation;
      var viewport = p.getViewport({ scale: scale, rotation: rotation });
      var dpr = opts.dpr || 1;
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      var ctx = canvas.getContext('2d', { alpha: false });
      if (opts.background !== false) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      var task = p.render({
        canvasContext: ctx,
        viewport: viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        intent: 'display'
      });
      await task.promise;
      return { width: viewport.width, height: viewport.height, rotation: rotation, scale: scale };
    }

    /** Rasterises a whole page (used by "flatten page" and thumbnails). */
    async function rasterise(index, opts) {
      opts = opts || {};
      var p = await page(index);
      var rotation = ((opts.rotation || 0) % 360 + 360) % 360;
      var base = p.getViewport({ scale: 1, rotation: rotation });
      var scale = (opts.dpi || 150) / 72;
      var viewport = p.getViewport({ scale: scale, rotation: rotation });
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      var ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = opts.background || '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await p.render({ canvasContext: ctx, viewport: viewport, intent: 'display' }).promise;
      // paint redaction boxes straight into the bitmap: this is what makes the
      // removal irreversible, because the original text is never kept
      if (opts.redactions && opts.redactions.length) {
        ctx.save();
        opts.redactions.forEach(function (r) {
          ctx.fillStyle = r.color || '#000000';
          ctx.fillRect(r.x * scale, r.y * scale, Math.max(1, r.w * scale), Math.max(1, r.h * scale));
        });
        ctx.restore();
      }
      var type = opts.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      var dataUrl = canvas.toDataURL(type, opts.quality || 0.92);
      var bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return {
        bytes: out, mime: type, width: canvas.width, height: canvas.height,
        dataUrl: dataUrl,
        widthPt: canvas.width / scale, heightPt: canvas.height / scale,
        baseWidth: base.width, baseHeight: base.height
      };
    }

    /* ---------------------------------------------------------------- *
     * Text
     * ---------------------------------------------------------------- */

    function awaitObject(objs, name, timeout) {
      return new Promise(function (resolve) {
        var done = false;
        function finish(v) { if (!done) { done = true; resolve(v); } }
        try { objs.get(name, function (obj) { finish(obj); }); }
        catch (e) { finish(null); }
        setTimeout(function () {
          try { finish(objs.has(name) ? objs.get(name) : null); } catch (e) { finish(null); }
        }, timeout || 4000);
      });
    }

    /**
     * Extracts the text of a page as a list of "blocks" (paragraph-ish groups
     * of glyph runs) in page space.
     */
    async function extractText(index) {
      var p = await page(index);
      var info = pageInfo(index);
      var content = await p.getTextContent({ includeMarkedContent: false, disableNormalization: true });
      var raw = [];
      for (var i = 0; i < content.items.length; i++) {
        var it = content.items[i];
        if (!it.str || !it.str.trim()) continue;
        var t = it.transform;
        var size = Math.hypot(t[0], t[1]) || it.height || 0;
        if (size < 0.4) continue;
        var fobj = null;
        try { fobj = p.commonObjs.has(it.fontName) ? p.commonObjs.get(it.fontName) : null; } catch (e) { fobj = null; }
        var ascent = (fobj && fobj.ascent ? fobj.ascent : 0.8) * size;
        var descent = (fobj && fobj.descent ? -fobj.descent : 0.2) * size;
        var origin = toPage(index, t[4], t[5]);
        var angle = Math.atan2(-t[1], t[0]) * 180 / Math.PI;
        var w = it.width || 0;
        raw.push({
          str: it.str,
          x: origin.x,
          y: origin.y - ascent,            // top of the em box
          w: w,
          h: ascent + descent,
          baseline: origin.y,
          size: size,
          angle: angle,
          font: (fobj && fobj.name) || it.fontName,
          fontKey: it.fontName,
          eol: !!it.hasEOL
        });
      }
      return { items: raw, blocks: groupBlocks(raw, index), info: info };
    }

    /** Groups glyph runs into lines and then into paragraph blocks. */
    function groupBlocks(items, index) {
      var sorted = items.slice().sort(function (a, b) {
        if (Math.abs(a.baseline - b.baseline) > Math.max(1, a.size * 0.3)) return a.baseline - b.baseline;
        return a.x - b.x;
      });
      var lines = [];
      for (var i = 0; i < sorted.length; i++) {
        var it = sorted[i];
        var line = null;
        for (var j = 0; j < lines.length; j++) {
          var l = lines[j];
          var overlap = Math.min(l.bottom, it.baseline) - Math.max(l.top, it.baseline);
          var minSize = Math.min(l.size, it.size);
          if (overlap > minSize * 0.45 && Math.abs(l.size - it.size) < Math.max(l.size, it.size) * 0.35) {
            if (Math.abs(l.angle - it.angle) < 4) { line = l; break; }
          }
        }
        if (!line) {
          line = { top: it.baseline, bottom: it.baseline, size: it.size, angle: it.angle, font: it.font, parts: [], x0: it.x, x1: it.x + it.w };
          lines.push(line);
        }
        line.parts.push(it);
        line.top = Math.min(line.top, it.baseline);
        line.bottom = Math.max(line.bottom, it.baseline);
        line.x0 = Math.min(line.x0, it.x);
        line.x1 = Math.max(line.x1, it.x + it.w);
        line.size = Math.max(line.size, it.size);
      }
      lines.forEach(function (l) {
        l.parts.sort(function (a, b) { return a.x - b.x; });
        l.text = l.parts.map(function (p) { return p.str; }).join('');
        l.left = l.x0;
        l.right = l.x1;
        l.mid = (l.x0 + l.x1) / 2;
        l.gapAfter = 0;
      });

      // merge consecutive lines into blocks
      var blocks = [];
      for (i = 0; i < lines.length; i++) {
        var cur = lines[i];
        var block = null;
        for (j = blocks.length - 1; j >= 0; j--) {
          var b = blocks[j];
          var last = b.lines[b.lines.length - 1];
          if (cur.top < last.top) continue;                   // keep document order
          var vGap = cur.top - last.bottom;
          var sizeOk = Math.abs(cur.size - last.size) < Math.max(cur.size, last.size) * 0.4;
          var leftOk = Math.abs(cur.left - last.left) < Math.max(3, last.size * 0.6) ||
            Math.abs(cur.mid - last.mid) < Math.max(3, last.size * 0.6);
          var widthOk = b.lines.length === 1 || Math.abs((cur.right - cur.left) - (b.right - b.left)) < Math.max(24, (b.right - b.left) * 0.6);
          if (vGap > -last.size * 0.5 && vGap < last.size * 1.9 && sizeOk && leftOk && widthOk &&
              Math.abs(cur.angle - last.angle) < 4 && cur.font === last.font) {
            block = b; break;
          }
        }
        if (!block) {
          block = { lines: [], left: cur.left, right: cur.right, top: cur.top, bottom: cur.bottom, font: cur.font, angle: cur.angle, size: cur.size };
          blocks.push(block);
        }
        block.lines.push(cur);
        block.left = Math.min(block.left, cur.left);
        block.right = Math.max(block.right, cur.right);
        block.top = Math.min(block.top, cur.top);
        block.bottom = Math.max(block.bottom, cur.bottom);
        block.size = Math.max(block.size, cur.size);
      }

      return blocks.map(function (b, idx) {
        var pad = Math.max(0.6, b.size * 0.08);
        var x = b.left - pad;
        var y = b.top - b.size * 0.86 - pad * 0.5;
        var h = (b.bottom - b.top) + b.size * 1.02;
        return {
          id: 'tb' + index + '_' + idx,
          text: b.lines.map(function (l) { return l.text; }).join('\n'),
          rect: { x: x, y: y, w: (b.right - b.left) + pad * 2, h: h },
          size: b.size,
          angle: b.angle,
          font: b.font,
          lineCount: b.lines.length,
          lines: b.lines.map(function (l) {
            return {
              text: l.text, x: l.x0, y: l.top - l.size * 0.8, w: l.x1 - l.x0,
              h: l.size * 1.05, size: l.size, baseline: l.bottom
            };
          })
        };
      });
    }

    /* ---------------------------------------------------------------- *
     * Images
     * ---------------------------------------------------------------- */

    var IDENTITY = [1, 0, 0, 1, 0, 0];

    function collectImages(ops, args, index, ctm, state, depth) {
      var OPS = pdfjs.OPS;
      for (var i = 0; i < ops.length; i++) {
        var fn = ops[i];
        var a = args[i] || [];
        if (fn === OPS.save) state.stack.push(ctm.slice());
        else if (fn === OPS.restore) ctm = state.stack.pop() || IDENTITY.slice();
        else if (fn === OPS.transform) ctm = Text.matMul(a, ctm);
        else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject ||
          fn === OPS.paintImageXObjectRepeat || fn === OPS.paintInlineImageXObject ||
          fn === OPS.paintInlineImageXObjectGroup) {
          var name = a[0];
          if (typeof name !== 'string') continue;
          var corners = [
            Text.matApply(ctm, 0, 0), Text.matApply(ctm, 1, 0),
            Text.matApply(ctm, 1, 1), Text.matApply(ctm, 0, 1)
          ];
          var xs = corners.map(function (c) { return c.x; });
          var ys = corners.map(function (c) { return c.y; });
          var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
          var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
          var tl = toPage(index, x0, y1);
          var br = toPage(index, x1, y0);
          state.images.push({
            name: name,
            inline: fn === OPS.paintInlineImageXObject || fn === OPS.paintInlineImageXObjectGroup,
            data: a[1],
            rect: { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y },
            angle: (Math.atan2(-ctm[1], ctm[0]) * 180 / Math.PI)
          });
        } else if (fn === OPS.paintFormXObjectBegin && depth < 4) {
          var formId = a[1];
          var form = null;
          try { form = state.forms.has(formId) ? state.forms.get(formId) : null; } catch (e) { form = null; }
          if (form && form.operatorList) {
            var m = a[0] && a[0].length === 6 ? a[0] : IDENTITY;
            collectImages(form.operatorList.fnArray, form.operatorList.argsArray,
              index, Text.matMul(m, ctm), state, depth + 1);
          }
        }
      }
      return ctm;
    }

    async function extractImages(index) {
      var p = await page(index);
      var opList = await p.getOperatorList();
      var state = { images: [], forms: p.objs, stack: [] };
      collectImages(opList.fnArray, opList.argsArray, index, IDENTITY.slice(), state, 0);
      var out = [];
      for (var i = 0; i < state.images.length; i++) {
        var img = state.images[i];
        if (img.rect.w < 1 || img.rect.h < 1) continue;
        var obj = null;
        if (!img.inline) obj = await awaitObject(p.objs, img.name);
        var dataUrl = null;
        try {
          if (img.inline) dataUrl = inlineImageToDataUrl(img);
          else dataUrl = await objectToDataUrl(obj, img);
        } catch (e) { dataUrl = null; }
        out.push({
          id: 'im' + index + '_' + i,
          name: img.name,
          rect: img.rect,
          angle: img.angle,
          width: obj && obj.width || img.rect.w,
          height: obj && obj.height || img.rect.h,
          dataUrl: dataUrl,
          hasData: !!dataUrl
        });
      }
      return out;
    }

    /** Decoded PDF image object -> PNG data URL. */
    async function objectToDataUrl(obj, ref) {
      if (!obj) return null;
      var canvas = await objectToCanvas(obj);
      return canvas ? canvas.toDataURL('image/png') : null;
    }

    async function objectToCanvas(obj) {
      if (obj.bitmap) {
        var c0 = document.createElement('canvas');
        c0.width = obj.bitmap.width; c0.height = obj.bitmap.height;
        c0.getContext('2d').drawImage(obj.bitmap, 0, 0);
        return c0;
      }
      var w = obj.width, h = obj.height, data = obj.data;
      if (!w || !h || !data) return null;
      // raw JPEG stream
      if (data.length > 3 && data[0] === 0xFF && data[1] === 0xD8) {
        if (typeof createImageBitmap !== 'function') return null;
        var blob = new Blob([data], { type: 'image/jpeg' });
        var bmp = await createImageBitmap(blob);
        var cj = document.createElement('canvas');
        cj.width = bmp.width; cj.height = bmp.height;
        cj.getContext('2d').drawImage(bmp, 0, 0);
        return cj;
      }
      var rgba = new Uint8ClampedArray(w * h * 4);
      var kind = obj.kind;
      var i, px, v;
      if (kind === 3 || data.length === w * h * 4) {
        rgba.set(data.subarray(0, rgba.length));
      } else if (kind === 2 || data.length === w * h * 3) {
        for (i = 0, px = 0; i < w * h; i++, px += 4) {
          rgba[px] = data[i * 3]; rgba[px + 1] = data[i * 3 + 1]; rgba[px + 2] = data[i * 3 + 2]; rgba[px + 3] = 255;
        }
      } else if (kind === 1 || data.length === ((w * h) >> 3)) {
        for (i = 0, px = 0, v = 0; i < w * h; i++, px += 4) {
          var byte = data[i >> 3];
          var bit = (byte >> (7 - (i & 7))) & 1;
          rgba[px] = rgba[px + 1] = rgba[px + 2] = bit ? 255 : 0;
          rgba[px + 3] = 255;
        }
      } else if (kind === 1) {
        for (i = 0, px = 0; i < w * h; i++, px += 4) {
          v = data[i] ? 255 : 0;
          rgba[px] = rgba[px + 1] = rgba[px + 2] = v; rgba[px + 3] = 255;
        }
      } else {
        return null;
      }
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
      return canvas;
    }

    function inlineImageToDataUrl(img) {
      var data = img.data;
      if (!data) return null;
      if (data.length > 3 && data[0] === 0xFF && data[1] === 0xD8) {
        var bin = '';
        for (var i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
        return 'data:image/jpeg;base64,' + btoa(bin);
      }
      return null;
    }

    /* ---------------------------------------------------------------- */

    return {
      load: load,
      destroy: destroy,
      page: page,
      pageSync: pageSync,
      pageInfo: pageInfo,
      render: render,
      rasterise: rasterise,
      extractText: extractText,
      extractImages: extractImages,
      objectToCanvas: objectToCanvas,
      toPage: toPage,
      setupWorker: worker,
      get doc() { return doc; },
      get bytes() { return bytes; }
    };
  }

  PM.PdfSource = { create: create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
