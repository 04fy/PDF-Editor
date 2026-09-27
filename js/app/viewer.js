/*!
 * app/viewer.js — the page canvas plus the interactive overlay.
 *
 * Page space (see pdfsource.js) is mapped onto the screen with the very same
 * matrix PDF.js uses for rendering, so what you see is what gets exported:
 *   .page-overlay  transform: matrix(...)   ← page rotation + zoom
 *   .op            positioned in page points, rotated about its centre
 */
(function (root) {
  'use strict';
  var PM = (root.PM = root.PM || {});
  var Text = PM.Text;
  var Ops = PM.Ops;
  var Arrange = PM.Arrange;
  var Icons = PM.Icons;

  var MIN_ZOOM = 0.1, MAX_ZOOM = 8;
  var TOOL_DEFAULTS = {
    text: { w: 220, h: 36 },
    rect: { w: 160, h: 100 },
    ellipse: { w: 140, h: 100 },
    line: { w: 180, h: 0.5 },
    redact: { w: 120, h: 18 }
  };

  function create(opts) {
    var container = opts.container;
    var store = opts.store;
    var source = opts.source;
    var fonts = opts.fonts;
    var onSelect = opts.onSelect || function () { };
    var onStatus = opts.onStatus || function () { };
    var onContextMenu = opts.onContextMenu || function () { };
    var onRequestImage = opts.onRequestImage || function () { };
    var t = opts.t || function (k) { return k; };

    var zoom = 1;
    var fitMode = 'width';
    var tool = 'select';
    var selection = [];               // op ids, in selection order
    var editingId = null;
    var editorEl = null;
    var showTextBoxes = true;
    var snapEnabled = true;
    var wraps = new Map();
    var textIndex = new Map();
    var renderQueue = [];
    var rendering = 0;
    var io = null;
    var drag = null;
    var guideEls = [];
    var panning = null;
    var spaceDown = false;
    var currentPage = null;

    /* ---------------------------------------------------------------- *
     * geometry
     * ---------------------------------------------------------------- */

    function livePages() { return store.livePages(); }

    function pageInfo(pageId) {
      var p = store.getPage(pageId);
      if (!p) return null;
      var info = source.pageInfo(p.sourceIndex);
      if (!info) return null;
      return {
        model: p,
        width: info.width,
        height: info.height,
        rotation: ((p.rotation || 0) % 360 + 360) % 360,
        index: p.sourceIndex
      };
    }

    function displaySize(pi) {
      var p = source.pageSync(pi.index);
      if (p) {
        try {
          var vp = p.getViewport({ scale: 1, rotation: pi.rotation });
          return { w: vp.width, h: vp.height };
        } catch (e) { void e; }
      }
      return (pi.rotation === 90 || pi.rotation === 270)
        ? { w: pi.height, h: pi.width }
        : { w: pi.width, h: pi.height };
    }

    /**
     * CSS matrix mapping unrotated page points (multiplied by the zoom) onto
     * screen pixels — derived from the matrix PDF.js itself uses for rendering.
     */
    function pageMatrix(pi, scale) {
      var p = source.pageSync(pi.index);
      if (p) {
        try {
          var t2 = p.getViewport({ scale: scale, rotation: pi.rotation }).transform;
          return [t2[0], -t2[1], t2[2], -t2[3], t2[4] + pi.x0, -t2[5] + pi.y1];
        } catch (e) { void e; }
      }
      var r = pi.rotation, a, b, c, d, e, f, W = pi.width, H = pi.height;
      if (r === 90) { a = 0; b = 1; c = -1; d = 0; e = H; f = 0; }
      else if (r === 180) { a = -1; b = 0; c = 0; d = -1; e = W; f = H; }
      else if (r === 270) { a = 0; b = -1; c = 1; d = 0; e = 0; f = W; }
      else { a = 1; b = 0; c = 0; d = 1; e = 0; f = 0; }
      return [a * scale, b * scale, c * scale, d * scale, e * scale, f * scale];
    }

    function toPage(pi, sx, sy) {
      var inv = Text.matInvert(pageMatrix(pi, zoom));
      return inv ? Text.matApply(inv, sx, sy) : { x: 0, y: 0 };
    }

    function eventToPage(wrap, ev) {
      var rect = wrap.el.getBoundingClientRect();
      return toPage(wrap.info, ev.clientX - rect.left, ev.clientY - rect.top);
    }

    /* ---------------------------------------------------------------- *
     * structure
     * ---------------------------------------------------------------- */

    function build() {
      var scroller = container;
      var before = scrollAnchor(scroller);
      container.innerHTML = '';
      wraps.clear();
      livePages().forEach(function (p, i) {
        var pi = pageInfo(p.id);
        if (!pi) return;
        var size = displaySize(pi);
        var el = document.createElement('div');
        el.className = 'page-wrap';
        el.dataset.pageId = p.id;
        el.style.width = (size.w * zoom) + 'px';
        el.style.height = (size.h * zoom) + 'px';

        var canvas = document.createElement('canvas');
        canvas.className = 'page-canvas';

        var textlayer = document.createElement('div');
        textlayer.className = 'text-layer';

        var overlay = document.createElement('div');
        overlay.className = 'page-overlay';
        overlay.style.width = pi.width + 'px';
        overlay.style.height = pi.height + 'px';
        overlay.style.transform = 'matrix(' + pageMatrix(pi, zoom).join(',') + ')';
        overlay.appendChild(textlayer);

        el.appendChild(canvas);
        el.appendChild(overlay);
        container.appendChild(el);

        var wrap = {
          id: p.id, index: i, el: el, canvas: canvas, overlay: overlay, textlayer: textlayer,
          info: pi, rendered: null, opsEl: null
        };
        wraps.set(p.id, wrap);
        renderOverlay(wrap);
        queueRender(wrap);
      });
      if (io) io.disconnect();
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var wrap = wraps.get(e.target.dataset.pageId);
          if (wrap) queueRender(wrap);
        });
      }, { root: container, rootMargin: '700px' });
      wraps.forEach(function (w) { io.observe(w.el); });
      selection = selection.filter(function (id) { return !!store.getOp(id); });
      if (before) restoreAnchor(scroller, before);
      highlightCurrent();
    }

    function ensureOpsLayer(wrap) {
      if (!wrap.opsEl) {
        wrap.opsEl = document.createElement('div');
        wrap.opsEl.className = 'ops-layer';
        wrap.overlay.appendChild(wrap.opsEl);
      }
      return wrap.opsEl;
    }

    /* ---------------------------------------------------------------- *
     * rendering
     * ---------------------------------------------------------------- */

    function queueRender(wrap) {
      if (!wrap || wrap.queued) return;
      wrap.queued = true;
      renderQueue.push(wrap);
      pump();
    }

    function pump() {
      while (rendering < 2 && renderQueue.length) {
        var wrap = renderQueue.shift();
        if (!wraps.has(wrap.id)) continue;
        wrap.queued = false;
        rendering++;
        doRender(wrap).then(function () { rendering--; pump(); }, function (e) {
          rendering--; pump();
          console.warn('render failed', e);
        });
      }
    }

    function blankCanvas(wrap) {
      var size = displaySize(wrap.info);
      wrap.canvas.width = Math.max(1, Math.round(size.w * zoom));
      wrap.canvas.height = Math.max(1, Math.round(size.h * zoom));
      wrap.canvas.style.width = (size.w * zoom) + 'px';
      wrap.canvas.style.height = (size.h * zoom) + 'px';
      var ctx = wrap.canvas.getContext('2d');
      if (ctx) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, wrap.canvas.width, wrap.canvas.height); }
      return { width: size.w * zoom, height: size.h * zoom, rotation: wrap.info.rotation, scale: zoom };
    }

    async function doRender(wrap) {
      var key = wrap.info.index + '|' + zoom + '|' + wrap.info.rotation;
      if (wrap.rendered === key) return;
      wrap.el.classList.add('loading');
      try {
        var res = wrap.info.model.blank ? blankCanvas(wrap) : await source.render(wrap.info.index, wrap.canvas, {
          scale: zoom, rotation: wrap.info.rotation
        });
        wrap.rendered = key;
        wrap.displayWidth = res.width;
        wrap.displayHeight = res.height;
      } catch (e) {
        wrap.el.classList.add('render-error');
      }
      wrap.el.classList.remove('loading');
      updateTextLayer(wrap);
    }

    function renderAll() {
      wraps.forEach(function (wrap) {
        wrap.overlay.style.width = wrap.info.width + 'px';
        wrap.overlay.style.height = wrap.info.height + 'px';
        wrap.overlay.style.transform = 'matrix(' + pageMatrix(wrap.info, zoom).join(',') + ')';
        var size = displaySize(wrap.info);
        wrap.el.style.width = (size.w * zoom) + 'px';
        wrap.el.style.height = (size.h * zoom) + 'px';
        wrap.rendered = null;
        queueRender(wrap);
        renderOverlay(wrap);
      });
      onStatus();
    }

    /* ---------------------------------------------------------------- *
     * overlay
     * ---------------------------------------------------------------- */

    function wrapLines(op) {
      return Text.wrap(op.text || '', op.w, function (s) {
        return fonts.measure(s, op.fontId, op.size || 12, op.letterSpacing || 0);
      });
    }

    function textMetrics(op) { return fonts.metrics(op.fontId); }

    function isRTLText(op) {
      return op.dir === 'rtl' || (op.dir !== 'ltr' && Text.isRTL(op.text || ''));
    }

    function updateTextLayer(wrap) {
      if (!showTextBoxes) { wrap.textlayer.innerHTML = ''; return; }
      var idx = textIndex.get(wrap.id);
      if (!idx || !idx.blocks) { wrap.textlayer.innerHTML = ''; return; }
      var frag = document.createDocumentFragment();
      idx.blocks.forEach(function (b) {
        var el = document.createElement('div');
        el.className = 'detected-box';
        el.style.left = b.rect.x + 'px';
        el.style.top = b.rect.y + 'px';
        el.style.width = b.rect.w + 'px';
        el.style.height = b.rect.h + 'px';
        el.dataset.blockId = b.id;
        frag.appendChild(el);
      });
      wrap.textlayer.innerHTML = '';
      wrap.textlayer.appendChild(frag);
    }

    function opElement(op) {
      var el = document.createElement('div');
      el.className = 'op op-' + op.type + (op.redaction ? ' op-redaction' : '');
      el.dataset.opId = op.id;
      el.style.left = op.x + 'px';
      el.style.top = op.y + 'px';
      el.style.width = op.w + 'px';
      el.style.height = op.h + 'px';
      el.style.transform = 'rotate(' + (op.rotate || 0) + 'deg)';
      el.style.opacity = op.opacity == null ? 1 : op.opacity;
      if (op.locked) el.classList.add('locked');
      if (op.visible === false) el.classList.add('hidden-op');
      if (selection.indexOf(op.id) >= 0) el.classList.add('selected');
      el.style.zIndex = String(10 + (op.z || 0));

      if (op.type === 'text') {
        el.appendChild(textBody(op));
      } else if (op.type === 'image') {
        var asset = op.assetId ? store.getAsset(op.assetId) : null;
        var src = (asset && asset.dataUrl) || op.dataUrl;
        if (src) {
          var img = document.createElement('img');
          img.src = src;
          img.alt = '';
          img.draggable = false;
          if (op.fit && op.fit !== 'stretch') img.style.objectFit = op.fit === 'cover' ? 'cover' : 'contain';
          else { img.style.width = '100%'; img.style.height = '100%'; }
          el.appendChild(img);
        }
      } else if (op.type === 'field') {
        el.appendChild(fieldBody(op));
      } else {
        el.style.background = op.fill && op.fill !== 'none' ? op.fill : 'transparent';
        el.style.backgroundOpacity = op.fillOpacity == null ? 1 : op.fillOpacity;
        if (op.stroke && op.stroke !== 'none') el.style.border = (op.strokeWidth || 1) + 'px solid ' + op.stroke;
        if (op.shape === 'ellipse') el.style.borderRadius = '50%';
        if (op.dash && op.dash.length) el.style.borderStyle = 'dashed';
      }
      if (selection.length === 1 && selection[0] === op.id && tool === 'select') el.appendChild(handles(op));
      return el;
    }

    function textBody(op) {
      var body = document.createElement('div');
      body.className = 'op-text';
      var f = fonts.get(op.fontId);
      body.style.fontFamily = fonts.family(op.fontId);
      body.style.fontWeight = (f.weight || 'normal');
      body.style.fontStyle = (f.style || 'normal');
      body.style.fontSize = (op.size || 12) + 'px';
      body.style.lineHeight = (op.lineHeight || 1.2) + 'em';
      body.style.color = op.color || '#000';
      var rtl = isRTLText(op);
      body.style.textAlign = op.align === 'start' || !op.align
        ? (rtl ? 'right' : 'left')
        : op.align === 'end' ? (rtl ? 'left' : 'right') : op.align;
      body.style.direction = rtl ? 'rtl' : 'ltr';
      if (op.letterSpacing) body.style.letterSpacing = op.letterSpacing + 'px';
      if (op.valign && op.valign !== 'top') {
        body.style.display = 'flex';
        body.style.flexDirection = 'column';
        body.style.justifyContent = op.valign === 'middle' ? 'center' : 'flex-end';
      }
      body.textContent = op.text || '';
      return body;
    }

    function fieldBody(op) {
      var f = op.field || {};
      var el = document.createElement('div');
      el.className = 'op-field ' + (f.kind === 'checkbox' ? 'check' : f.kind === 'radio' ? 'radio' : f.kind === 'dropdown' ? 'dropdown' : 'text');
      el.style.fontSize = (f.fontSize || 10) + 'px';
      if (f.backgroundColor) el.style.background = f.backgroundColor;
      el.style.borderColor = f.borderColor || '#2f5fe0';
      el.style.borderWidth = (f.borderWidth == null ? 1 : f.borderWidth) + 'px';
      if (f.kind === 'checkbox' && f.value) el.classList.add('checked');
      if (f.kind === 'radio' && f.value) el.classList.add('checked');
      if (f.kind === 'text' || f.kind === 'dropdown') {
        var span = document.createElement('span');
        span.textContent = f.value || '';
        span.dir = isRTLText({ dir: f.dir, text: f.value }) ? 'rtl' : 'ltr';
        el.appendChild(span);
      }
      if (f.readOnly) el.style.opacity = '.75';
      return el;
    }

    function handles(op) {
      var box = document.createElement('div');
      box.className = 'handles';
      if (op.locked) return box;
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (n) {
        var h = document.createElement('div');
        h.className = 'handle h-' + n;
        h.dataset.handle = n;
        box.appendChild(h);
      });
      var rot = document.createElement('div');
      rot.className = 'handle rotate';
      rot.dataset.handle = 'rotate';
      box.appendChild(rot);
      return box;
    }

    function renderOverlay(wrap) {
      var layer = ensureOpsLayer(wrap);
      var frag = document.createDocumentFragment();
      store.opsForPage(wrap.id).forEach(function (op) {
        frag.appendChild(opElement(op));
      });
      var editor = (editingId && editorEl && editorEl.isConnected) ? editorEl : null;
      layer.innerHTML = '';
      layer.appendChild(frag);
      if (editor) layer.appendChild(editor);
      if (selection.length > 1) renderGroupBox(wrap);
      updateTextLayer(wrap);
    }

    /** Outline around a multi-selection. */
    function renderGroupBox(wrap) {
      var ops = selectionOps().filter(function (o) { return o.pageId === wrap.id; });
      if (ops.length < 2) return;
      var b = Arrange.union(ops);
      var el = document.createElement('div');
      el.className = 'group-box';
      el.style.left = b.x + 'px';
      el.style.top = b.y + 'px';
      el.style.width = b.w + 'px';
      el.style.height = b.h + 'px';
      ['nw', 'ne', 'se', 'sw'].forEach(function (n) {
        var h = document.createElement('div');
        h.className = 'handle h-' + n;
        h.dataset.handle = 'group-' + n;
        el.appendChild(h);
      });
      wrap.opsEl.appendChild(el);
    }

    function refreshOps(opId) {
      var op = opId ? store.getOp(opId) : null;
      var ids = new Set();
      if (op) ids.add(op.pageId);
      if (!ids.size) wraps.forEach(function (w, id) { ids.add(id); });
      ids.forEach(function (id) {
        var wrap = wraps.get(id);
        if (wrap) renderOverlay(wrap);
      });
    }

    /* ---------------------------------------------------------------- *
     * selection
     * ---------------------------------------------------------------- */

    function selectOne(opId, opts) {
      opts = opts || {};
      var ids = opts.additive ? selection.slice() : [];
      var i = ids.indexOf(opId);
      if (i >= 0 && opts.additive) ids.splice(i, 1);
      else if (i < 0) ids.push(opId);
      setSelection(ids, opts);
    }

    function setSelection(ids, opts) {
      var prev = selection;
      selection = ids.filter(function (id) { return !!store.getOp(id); });
      var pages = new Set();
      prev.concat(selection).forEach(function (id) {
        var o = store.getOp(id);
        if (o) pages.add(o.pageId);
      });
      pages.forEach(function (id) {
        var wrap = wraps.get(id);
        if (wrap) renderOverlay(wrap);
      });
      onSelect(selectionOps(), selection.length === 1 ? store.getOp(selection[0]) : null, opts || {});
    }

    function selectionOps() {
      return selection.map(function (id) { return store.getOp(id); }).filter(Boolean);
    }

    function select(id, opts) { setSelection(id ? [id] : [], opts); }
    function selectIds(ids, opts) { setSelection((ids || []).slice(), opts); }
    function toggle(id, opts) { selectOne(id, opts); }
    function clearSelection() { setSelection([]); }
    function has(id) { return selection.indexOf(id) >= 0; }

    function opAtPoint(pageId, x, y) {
      var ops = store.opsForPage(pageId).filter(function (o) { return o.visible !== false; });
      for (var i = ops.length - 1; i >= 0; i--) {
        if (Text.pointInRect(x, y, ops[i])) return ops[i];
      }
      return null;
    }

    function opsInRect(pageId, rect) {
      return store.opsForPage(pageId).filter(function (o) {
        if (o.visible === false || o.locked) return false;
        var b = Arrange.bounds(o);
        return !(b.right < rect.x || rect.x + rect.w < b.x || b.bottom < rect.y || rect.y + rect.h < b.y);
      }).map(function (o) { return o.id; });
    }

    function blockAtPoint(pageId, x, y) {
      var idx = textIndex.get(pageId);
      if (!idx || !idx.blocks) return null;
      for (var i = 0; i < idx.blocks.length; i++) {
        if (Text.pointInRect(x, y, idx.blocks[i].rect)) return idx.blocks[i];
      }
      return null;
    }

    /* ---------------------------------------------------------------- *
     * editing
     * ---------------------------------------------------------------- */

    function startEditing(opId) {
      var op = store.getOp(opId);
      if (!op || op.type !== 'text' || op.locked) return;
      var wrap = wraps.get(op.pageId);
      if (!wrap) return;
      setSelection([opId], { editing: true });
      editingId = opId;
      var ta = document.createElement('textarea');
      ta.className = 'op-editor';
      editorEl = ta;
      ta.value = op.text || '';
      var rtl = isRTLText(op);
      ta.dir = rtl ? 'rtl' : 'ltr';
      ta.style.left = op.x + 'px';
      ta.style.top = op.y + 'px';
      ta.style.width = op.w + 'px';
      ta.style.transform = 'rotate(' + (op.rotate || 0) + 'deg)';
      ta.style.fontFamily = fonts.family(op.fontId);
      ta.style.fontSize = (op.size || 12) + 'px';
      ta.style.lineHeight = (op.lineHeight || 1.2) + 'em';
      ta.style.color = op.color || '#000';
      ta.style.textAlign = (op.align === 'start' || !op.align)
        ? (rtl ? 'right' : 'left')
        : op.align === 'end' ? (rtl ? 'left' : 'right') : op.align;
      if (op.letterSpacing) ta.style.letterSpacing = op.letterSpacing + 'px';
      ta.spellcheck = false;
      wrap.opsEl.appendChild(ta);
      ta.focus();
      ta.select();

      var original = op.text;

      function autosize() {
        ta.style.height = 'auto';
        var lines = Math.max(1, ta.value.split('\n').length);
        var lh = (op.lineHeight || 1.2) * (op.size || 12) * zoom;
        ta.style.height = Math.max(op.h * zoom, lines * lh * 1.35) + 'px';
      }
      autosize();

      ta.addEventListener('input', function () {
        op.text = ta.value;
        autosize();
        store.update({ live: true, text: true });
      });
      function finish(save) {
        if (editingId !== opId) return;
        editingId = null;
        editorEl = null;
        ta.remove();
        var finalText = save ? ta.value : original;
        if (finalText !== original) {
          op.text = original;               // so the snapshot records the pre-edit state
          store.commit('edit-text', function () { op.text = finalText; });
        } else {
          op.text = original;
          store.update({});
        }
        refreshOps(opId);
      }
      ta.addEventListener('blur', function () { finish(true); });
      ta.addEventListener('keydown', function (ev) {
        ev.stopPropagation();
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
        else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); finish(true); }
      });
    }

    /* ---------------------------------------------------------------- *
     * creation
     * ---------------------------------------------------------------- */

    function createOpAt(toolName, pageId, x, y) {
      var pi = pageInfo(pageId);
      var def = TOOL_DEFAULTS[toolName] || TOOL_DEFAULTS.rect;
      var rect = { x: x, y: y, w: def.w, h: def.h };
      if (pi) {
        rect.x = Math.min(Math.max(x, 0), Math.max(0, pi.width - 10));
        rect.y = Math.min(Math.max(y, 0), Math.max(0, pi.height - 10));
      }
      var op = null;
      switch (toolName) {
        case 'text':
          op = Ops.textOp(pageId, rect, { text: t('prop.text'), fontId: 'sys-sans', size: 14, cover: false });
          break;
        case 'redact':
          op = Ops.shapeOp(pageId, rect, { shape: 'rect', fill: '#000000', fillOpacity: 1, stroke: null, strokeWidth: 0 });
          op.redaction = true;
          break;
        case 'image':
          onRequestImage(pageId, rect);
          return null;
        case 'form-text': case 'checkbox': case 'radio': case 'dropdown': {
          var kind = toolName === 'form-text' ? 'text' : toolName;
          var r = kind === 'checkbox' || kind === 'radio'
            ? { x: rect.x, y: rect.y, w: 16, h: 16 }
            : { x: rect.x, y: rect.y, w: 160, h: 22 };
          op = Ops.fieldOp(pageId, r, {
            field: {
              kind: kind,
              name: kind + (kind === 'text' ? 'Field' : kind === 'checkbox' ? 'Box' : kind === 'radio' ? 'Group' : 'List') + Math.floor(Math.random() * 900 + 100),
              value: kind === 'checkbox' || kind === 'radio' ? true : '',
              options: kind === 'dropdown' ? ['Option 1', 'Option 2', 'Option 3'] : []
            }
          });
          break;
        }
        default:
          op = Ops.shapeOp(pageId, rect, {
            shape: toolName === 'ellipse' ? 'ellipse' : toolName === 'line' ? 'line' : 'rect',
            fill: toolName === 'line' ? null : '#dbeafe',
            stroke: toolName === 'line' ? '#1d4ed8' : null,
            strokeWidth: toolName === 'line' ? 2 : 0
          });
      }
      store.commit('add-object', function (s) { s.addOp(op); });
      setSelection([op.id]);
      if (op.type === 'text') startEditing(op.id);
      return op;
    }

    /* ---------------------------------------------------------------- *
     * pointer interaction
     * ---------------------------------------------------------------- */

    function onPointerDown(wrap, ev) {
      if (ev.button === 1 || spaceDown) { startPan(ev); return; }
      if (ev.button !== 0) return;
      var p = eventToPage(wrap, ev);
      var handleEl = ev.target.closest ? ev.target.closest('.handle') : null;
      var opEl = ev.target.closest ? ev.target.closest('.op') : null;
      var groupEl = ev.target.closest ? ev.target.closest('.group-box') : null;

      if (tool !== 'select') {
        createOpAt(tool, wrap.id, p.x, p.y);
        setTool('select');
        ev.preventDefault();
        return;
      }

      // group scale handle
      if (groupEl && handleEl) {
        var groupOps = selectionOps().filter(function (o) { return o.pageId === wrap.id; });
        if (groupOps.length > 1) {
          var gb = Arrange.union(groupOps);
          drag = {
            mode: 'group-scale', handle: handleEl.dataset.handle.replace('group-', ''),
            start: p, origin: gb, ops: groupOps,
            snapshot: groupOps.map(function (o) { return { op: o, x: o.x, y: o.y, w: o.w, h: o.h }; })
          };
          store.beginGesture('scale');
          wrap.el.setPointerCapture(ev.pointerId);
          ev.preventDefault();
          return;
        }
      }

      if (handleEl && opEl) {
        var op = store.getOp(opEl.dataset.opId);
        if (op && !op.locked) {
          drag = {
            mode: 'transform', handle: handleEl.dataset.handle, start: p,
            op: op, center: { x: op.x + op.w / 2, y: op.y + op.h / 2 },
            origin: { x: op.x, y: op.y, w: op.w, h: op.h, rotate: op.rotate },
            moved: false
          };
          store.beginGesture('transform');
          wrap.el.setPointerCapture(ev.pointerId);
          ev.preventDefault();
          return;
        }
      }

      if (opEl) {
        var op2 = store.getOp(opEl.dataset.opId);
        if (op2) {
          if (ev.shiftKey || ev.ctrlKey || ev.metaKey) toggle(op2.id);
          else if (!has(op2.id)) setSelection([op2.id]);
          if (!op2.locked && has(op2.id)) {
            var ops = selectionOps();
            drag = {
              mode: 'move', start: p, moved: false,
              snapshot: ops.map(function (o) { return { op: o, x: o.x, y: o.y }; }),
              anchor: ops[0]
            };
            store.beginGesture('move');
            wrap.el.setPointerCapture(ev.pointerId);
          }
          ev.preventDefault();
          return;
        }
      }

      // empty area: rubber band selection.  Detected text blocks are only a
      // hint — editing them takes a double click, so a stray click never
      // creates an object.
      var clickedBlock = blockAtPoint(wrap.id, p.x, p.y);
      if (clickedBlock) { flashBlock(wrap.id, clickedBlock.rect); }
      var additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
      drag = { mode: 'marquee', start: p, additive: additive, base: selection.slice() };
      if (!additive) setSelection([]);
      var marquee = document.createElement('div');
      marquee.className = 'marquee';
      wrap.overlay.appendChild(marquee);
      drag.el = marquee;
      wrap.el.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    }

    /** Brief highlight, used when a single click lands on detected text. */
    function flashBlock(pageId, rect) {
      var wrap = wraps.get(pageId);
      if (!wrap) return;
      var node = document.createElement('div');
      node.className = 'flash';
      node.style.left = rect.x + 'px';
      node.style.top = rect.y + 'px';
      node.style.width = rect.w + 'px';
      node.style.height = rect.h + 'px';
      wrap.overlay.appendChild(node);
      setTimeout(function () { node.remove(); }, 900);
    }

    function editBlock(pageId, block) {
      var wrap = wraps.get(pageId);
      var colour = sampleTextColor(wrap, block.rect);
      var op = Ops.textOp(pageId, block.rect, {
        text: block.text,
        size: Math.max(4, block.size),
        color: colour,
        fontId: 'sys-sans',
        cover: true,
        coverColor: sampleBackgroundColor(wrap, block.rect),
        sourceRect: block.rect,
        lineHeight: 1.2
      });
      store.commit('edit-text', function (s) { s.addOp(op); });
      return op;
    }

    /** The colour of the paper behind a text block (used for the cover). */
    function sampleBackgroundColor(wrap, rect) {
      if (!wrap) return '#ffffff';
      try {
        var z = wrap.displayWidth ? wrap.displayWidth / (wrap.info.width || 1) : 1;
        var x = Math.round(rect.x * z), w = Math.max(1, Math.round(rect.w * z));
        var y = Math.round((rect.y + rect.h + 1) * z);
        var h = Math.max(1, Math.round(Math.max(2, rect.h * 0.25) * z));
        var data = wrap.canvas.getContext('2d').getImageData(Math.max(0, x), Math.max(0, y), w, h).data;
        var r = 0, g = 0, b = 0, n = 0;
        for (var i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
        return n ? Text.rgb01ToHex([r / n / 255, g / n / 255, b / n / 255]) : '#ffffff';
      } catch (e) { return '#ffffff'; }
    }

    function sampleTextColor(wrap, rect) {
      if (!wrap) return '#000000';
      try {
        var ctx = wrap.canvas.getContext('2d');
        var z = wrap.displayWidth ? wrap.displayWidth / (wrap.info.width || 1) : 1;
        var x = Math.round(rect.x * z), y = Math.round(rect.y * z);
        var w = Math.max(1, Math.round(rect.w * z)), h = Math.max(1, Math.round(rect.h * z));
        var data = ctx.getImageData(Math.max(0, x), Math.max(0, y), w, h).data;
        var buckets = {};
        for (var i = 0; i < data.length; i += 4) {
          var key = (data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4);
          buckets[key] = (buckets[key] || 0) + 1;
        }
        var best = null, bestScore = -1;
        Object.keys(buckets).forEach(function (k) {
          var parts = k.split(',');
          var mid = [(parseInt(parts[0], 16) << 4) + 8, (parseInt(parts[1], 16) << 4) + 8, (parseInt(parts[2], 16) << 4) + 8];
          var lum = mid[0] * 0.299 + mid[1] * 0.587 + mid[2] * 0.114;
          var score = buckets[k] * Math.abs(lum - 90) / 255;
          if (score > bestScore) { bestScore = score; best = mid; }
        });
        return best ? Text.rgb01ToHex(best.map(function (v) { return v / 255; })) : '#000000';
      } catch (e) { return '#000000'; }
    }

    function onPointerMove(wrap, ev) {
      if (panning) {
        container.scrollTop = panning.top - (ev.clientY - panning.y);
        container.scrollLeft = panning.left - (ev.clientX - panning.x);
        return;
      }
      clearGuides();
      if (!drag) return;
      var p = eventToPage(wrap, ev);
      drag.moved = true;

      if (drag.mode === 'marquee') {
        var r = normalizeRect(drag.start, p);
        drag.el.style.left = r.x + 'px';
        drag.el.style.top = r.y + 'px';
        drag.el.style.width = r.w + 'px';
        drag.el.style.height = r.h + 'px';
        return;
      }
      if (drag.mode === 'move') {
        var dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if (snapEnabled && drag.snapshot.length === 1) {
          var first = drag.snapshot[0].op;
          var snapped = Arrange.snapMove(
            { x: first.x + dx, y: first.y + dy, w: first.w, h: first.h },
            store.opsForPage(wrap.id).filter(function (o) { return o.id !== first.id; }),
            { width: wrap.info.width, height: wrap.info.height },
            4 / Math.max(0.2, zoom));
          dx += snapped.x - (first.x + dx);
          dy += snapped.y - (first.y + dy);
          showGuides(snapped.guides, wrap);
        }
        drag.snapshot.forEach(function (item) {
          item.op.x = Ops.round(item.x + dx);
          item.op.y = Ops.round(item.y + dy);
        });
      } else if (drag.mode === 'transform') {
        var op = drag.op, o = drag.origin;
        if (drag.handle === 'rotate') {
          var a = Math.atan2(p.y - drag.center.y, p.x - drag.center.x) * 180 / Math.PI + 90;
          if (ev.shiftKey) a = Math.round(a / 15) * 15;
          op.rotate = Ops.round(((a % 360) + 360) % 360);
        } else {
          var rect = resizeRect(o, drag.handle, p.x - drag.start.x, p.y - drag.start.y, ev.shiftKey, op);
          op.x = Ops.round(rect.x); op.y = Ops.round(rect.y);
          op.w = Math.max(2, Ops.round(rect.w)); op.h = Math.max(2, Ops.round(rect.h));
        }
      } else if (drag.mode === 'group-scale') {
        scaleGroup(drag, p, ev.shiftKey);
      }
      store.update({ live: true });
      renderOverlay(wrap);
      if (selection.length === 1) updateInspector();
    }

    function scaleGroup(d, p, keepRatio) {
      var o = d.origin, dx = p.x - d.start.x, dy = p.y - d.start.y;
      var w = o.w, h = o.h, x = o.x, y = o.y;
      if (d.handle.indexOf('e') >= 0) w = o.w + dx;
      if (d.handle.indexOf('w') >= 0) { w = o.w - dx; x = o.x + dx; }
      if (d.handle.indexOf('s') >= 0) h = o.h + dy;
      if (d.handle.indexOf('n') >= 0) { h = o.h - dy; y = o.y + dy; }
      if (keepRatio && o.w > 0 && o.h > 0) {
        if (d.handle === 'ne' || d.handle === 'sw') {
          var k = Math.abs(w / o.w) > Math.abs(h / o.h) ? w / o.w : h / o.h;
          w = o.w * k; h = o.h * k;
          if (d.handle === 'ne') y = o.y + (o.h - h);
          else x = o.x + (o.w - w);
        } else { w = o.h * (w / o.w); }
      }
      w = Math.max(4, w); h = Math.max(4, h);
      var sx = w / o.w, sy = h / o.h;
      d.snapshot.forEach(function (item) {
        item.op.x = Ops.round(x + (item.x - o.x) * sx);
        item.op.y = Ops.round(y + (item.y - o.y) * sy);
        item.op.w = Math.max(2, Ops.round(item.w * sx));
        item.op.h = Math.max(2, Ops.round(item.h * sy));
      });
    }

    function updateInspector() {
      var op = selectionOps()[0];
      if (op) onSelect([op], op, { refresh: true });
    }

    function resizeRect(o, handle, dx, dy, keepAspect, op) {
      var x = o.x, y = o.y, w = o.w, h = o.h;
      var right = o.x + o.w, bottom = o.y + o.h;
      if (handle.indexOf('e') >= 0) w = o.w + dx;
      if (handle.indexOf('w') >= 0) { w = o.w - dx; x = o.x + dx; }
      if (handle.indexOf('s') >= 0) h = o.h + dy;
      if (handle.indexOf('n') >= 0) { h = o.h - dy; y = o.y + dy; }
      w = Math.max(2, w); h = Math.max(2, h);
      if (keepAspect && op.type === 'image' && o.w > 0 && o.h > 0) {
        var ratio = o.h / o.w;
        if (handle === 'e' || handle === 'w') h = w * ratio;
        else { w = h / ratio; if (handle.indexOf('w') >= 0) x = right - w; }
      }
      return { x: x, y: y, w: w, h: h };
    }

    function normalizeRect(a, b) {
      return {
        x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y)
      };
    }

    function onPointerUp(wrap, ev) {
      if (panning) { panning = null; container.classList.remove('panning'); return; }
      if (!drag) return;
      var d = drag;
      drag = null;
      clearGuides();
      try { wrap.el.releasePointerCapture(ev.pointerId); } catch (e) { void e; }

      if (d.mode === 'marquee') {
        d.el.remove();
        if (d.moved) {
          var r = normalizeRect(d.start, eventToPage(wrap, ev));
          var ids = opsInRect(wrap.id, r);
          setSelection(d.additive ? d.base.concat(ids.filter(function (id) {
            return d.base.indexOf(id) < 0;
          })) : ids);
        }
        return;
      }

      d.snapshot && d.snapshot.forEach(function (item) {
        if (item.op.type === 'text' && item.op.autoFit !== false) fitTextHeight(item.op);
      });
      if (d.op && d.op.type === 'text' && d.op.autoFit !== false) fitTextHeight(d.op);
      store.endGesture();
      renderOverlay(wrap);
      if (d.moved) onSelect(selectionOps(), selectionOps()[0], { changed: true });
    }

    function fitTextHeight(op) {
      var lines = wrapLines(op);
      var m = textMetrics(op);
      op.h = Ops.round(Math.max(
        (Number(op.lineHeight) || 1.2) * (op.size || 12),
        lines.length * (Number(op.lineHeight) || 1.2) * (op.size || 12)
      ));
      void m;
    }

    /* ---------------------------------------------------------------- *
     * guides + panning
     * ---------------------------------------------------------------- */

    function clearGuides() {
      guideEls.forEach(function (el) { el.remove(); });
      guideEls = [];
    }

    function showGuides(list, wrap) {
      if (!list || !list.length || !wrap) return;
      list.forEach(function (g) {
        var el = document.createElement('div');
        el.className = 'guide guide-' + g.axis;
        if (g.axis === 'x') { el.style.left = g.at + 'px'; el.style.top = '0'; el.style.height = '100%'; }
        else { el.style.top = g.at + 'px'; el.style.left = '0'; el.style.width = '100%'; }
        wrap.overlay.appendChild(el);
        guideEls.push(el);
      });
    }

    function startPan(ev) {
      panning = { x: ev.clientX, y: ev.clientY, top: container.scrollTop, left: container.scrollLeft };
      container.classList.add('panning');
      ev.preventDefault();
    }

    /* ---------------------------------------------------------------- *
     * events
     * ---------------------------------------------------------------- */

    container.addEventListener('pointerdown', function (ev) {
      var wrapEl = ev.target.closest ? ev.target.closest('.page-wrap') : null;
      if (!wrapEl) return;
      var wrap = wraps.get(wrapEl.dataset.pageId);
      if (!wrap) return;
      currentPage = wrap.id;
      onPointerDown(wrap, ev);
    });
    container.addEventListener('pointermove', function (ev) {
      var wrapEl = ev.target.closest ? ev.target.closest('.page-wrap') : null;
      if (!wrapEl) return;
      onPointerMove(wraps.get(wrapEl.dataset.pageId), ev);
    });
    container.addEventListener('pointerup', function (ev) {
      var wrapEl = ev.target.closest ? ev.target.closest('.page-wrap') : null;
      if (!wrapEl) return;
      onPointerUp(wraps.get(wrapEl.dataset.pageId), ev);
    });
    container.addEventListener('dblclick', function (ev) {
      var wrapEl = ev.target.closest ? ev.target.closest('.page-wrap') : null;
      if (!wrapEl) return;
      var wrap = wraps.get(wrapEl.dataset.pageId);
      if (!wrap) return;
      var p = eventToPage(wrap, ev);
      var op = opAtPoint(wrap.id, p.x, p.y);
      if (op && op.type === 'text') { setSelection([op.id]); startEditing(op.id); return; }
      if (op) { setSelection([op.id]); return; }
      var block = blockAtPoint(wrap.id, p.x, p.y);
      if (block) {
        var created = editBlock(wrap.id, block);
        setSelection([created.id]);
        startEditing(created.id);
      }
    });
    container.addEventListener('contextmenu', function (ev) {
      var wrapEl = ev.target.closest ? ev.target.closest('.page-wrap') : null;
      if (!wrapEl) return;
      ev.preventDefault();
      var wrap = wraps.get(wrapEl.dataset.pageId);
      if (!wrap) return;
      var p = eventToPage(wrap, ev);
      var op = opAtPoint(wrap.id, p.x, p.y);
      if (op && !has(op.id)) setSelection([op.id]);
      onContextMenu(ev.clientX, ev.clientY, op, selectionOps(), wrap.id);
    });
    container.addEventListener('wheel', function (ev) {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      setZoom(zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    /* ---------------------------------------------------------------- *
     * public API
     * ---------------------------------------------------------------- */

    function scrollAnchor(scroller) {
      var wrapEl = scroller.querySelector('.page-wrap');
      if (!wrapEl) return null;
      var r = wrapEl.getBoundingClientRect();
      return { top: r.top, left: r.left };
    }
    function restoreAnchor(scroller, a) {
      var wrapEl = scroller.querySelector('.page-wrap');
      if (!wrapEl) return;
      var r = wrapEl.getBoundingClientRect();
      scroller.scrollTop += (r.top - a.top);
      scroller.scrollLeft += (r.left - a.left);
    }

    function setZoom(z, keepFit) {
      var before = scrollAnchor(container);
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
      if (!keepFit) fitMode = null;
      renderAll();
      if (before) restoreAnchor(container, before);
    }

    function fitWidth() { fitMode = 'width'; applyFit(); }
    function fitPage() { fitMode = 'page'; applyFit(); }
    function applyFit() {
      var pages = livePages();
      if (!pages.length) return;
      var pi = pageInfo(pages[0].id);
      if (!pi) return;
      var size = displaySize(pi);
      var availW = container.clientWidth - 48;
      var availH = container.clientHeight - 48;
      var z = fitMode === 'page'
        ? Math.min(availW / size.w, availH / size.h)
        : availW / size.w;
      setZoom(z, true);
      onStatus();
    }

    function setTool(name) {
      tool = name;
      container.classList.toggle('tool-draw', name !== 'select');
      wraps.forEach(renderOverlay);
      onStatus();
    }

    function selectedPageId() {
      if (currentPage && wraps.has(currentPage)) return currentPage;
      var pages = livePages();
      if (!pages.length) return null;
      var best = null, bestDist = Infinity;
      var mid = container.getBoundingClientRect().top + container.clientHeight / 2;
      pages.forEach(function (p) {
        var wrap = wraps.get(p.id);
        if (!wrap) return;
        var r = wrap.el.getBoundingClientRect();
        var d = Math.abs((r.top + r.bottom) / 2 - mid);
        if (d < bestDist) { bestDist = d; best = p.id; }
      });
      return best;
    }

    function highlightCurrent() {
      var id = selectedPageId();
      wraps.forEach(function (wrap) {
        wrap.el.classList.toggle('selected', wrap.id === id);
      });
    }

    function scrollToPage(pageId) {
      var wrap = wraps.get(pageId);
      if (!wrap) return;
      currentPage = pageId;
      container.scrollTop = wrap.el.offsetTop - 16;
      highlightCurrent();
    }

    return {
      build: build,
      renderAll: renderAll,
      refreshOps: refreshOps,
      select: select,
      selectIds: selectIds,
      toggle: toggle,
      clearSelection: clearSelection,
      selection: selectionOps,
      selectionIds: function () { return selection.slice(); },
      has: has,
      selected: function () { return selectionOps()[0] || null; },
      startEditing: startEditing,
      setZoom: setZoom,
      zoom: function () { return zoom; },
      zoomIn: function () { setZoom(zoom * 1.2); },
      zoomOut: function () { setZoom(zoom / 1.2); },
      fitWidth: fitWidth,
      fitPage: fitPage,
      setTool: setTool,
      tool: function () { return tool; },
      setTextIndex: function (pageId, data) { textIndex.set(pageId, data); },
      getTextIndex: function (pageId) { return textIndex.get(pageId); },
      setShowTextBoxes: function (v) { showTextBoxes = !!v; wraps.forEach(updateTextLayer); },
      setSnap: function (v) { snapEnabled = !!v; },
      setSpace: function (v) { spaceDown = !!v; },
      selectedPageId: selectedPageId,
      scrollToPage: scrollToPage,
      highlightCurrent: highlightCurrent,
      pageInfo: pageInfo,
      displaySize: displaySize,
      toPage: toPage,
      toScreen: function (pi, x, y) { return { x: 0, y: 0 }; },
      wrapFor: function (id) { return wraps.get(id); },
      fitTextHeight: fitTextHeight,
      wrapLines: wrapLines,
      pageMatrix: pageMatrix,
      allWraps: function () { return wraps; },
      opElement: opElement,
      isToolDraw: function () { return tool !== 'select'; }
    };
  }

  PM.Viewer = { create: create, MIN_ZOOM: MIN_ZOOM, MAX_ZOOM: MAX_ZOOM, TOOL_DEFAULTS: TOOL_DEFAULTS, Icons: Icons };
})(typeof globalThis !== 'undefined' ? globalThis : this);
