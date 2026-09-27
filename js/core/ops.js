/*!
 * core/ops.js — document model (pages, edit operations, assets) with
 * undo/redo history and JSON (project) serialisation.  Pure logic.
 */
(function (root, factory) {
  var ns = (root.PM = root.PM || {});
  var mod = factory();
  ns.Ops = mod;
  if (typeof module === 'object' && module.exports) module.exports = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var Text = (typeof PM !== 'undefined' && PM.Text) || null;

  var uidCounter = 0;
  function uid(prefix) {
    uidCounter++;
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + uidCounter.toString(36) +
      Math.floor(Math.random() * 1e6).toString(36);
  }

  function clone(v) {
    if (v == null || typeof v !== 'object') return v;
    return JSON.parse(JSON.stringify(v));
  }

  /* ------------------------------------------------------------------ *
   * Factories
   * ------------------------------------------------------------------ */

  function baseOp(type, pageId, rect, opts) {
    opts = opts || {};
    return {
      id: uid('op'),
      type: type,
      pageId: pageId,
      x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h),
      rotate: round(opts.rotate) || 0,
      opacity: opts.opacity == null ? 1 : opts.opacity,
      visible: opts.visible !== false,
      locked: !!opts.locked,
      label: opts.label || ''
    };
  }

  function textOp(pageId, rect, opts) {
    opts = opts || {};
    var op = baseOp('text', pageId, rect, opts);
    op.text = opts.text == null ? '' : String(opts.text);
    op.fontId = opts.fontId || 'sys-sans';
    op.size = opts.size == null ? 12 : opts.size;
    op.color = opts.color || '#000000';
    op.align = opts.align || 'start';       // start | center | end
    op.dir = opts.dir || 'auto';            // auto | ltr | rtl
    op.lineHeight = opts.lineHeight || 1.2;
    op.letterSpacing = opts.letterSpacing || 0;
    op.render = opts.render || 'auto';      // auto | vector | shape
    op.autoFit = opts.autoFit !== false;    // shrink text to fit the box width
    op.cover = opts.cover === undefined ? true : !!opts.cover;
    op.coverColor = opts.coverColor || '#ffffff';
    op.coverPadding = opts.coverPadding == null ? 1 : opts.coverPadding;
    op.searchLayer = !!opts.searchLayer;
    op.valign = opts.valign || 'top';
    op.coverMode = opts.coverMode || 'auto';
    op.blendMode = opts.blendMode || null;
    op.lang = opts.lang || 'auto';
    op.renderResolved = null;               // filled in by the layout pass
    return op;
  }

  function imageOp(pageId, rect, opts) {
    opts = opts || {};
    var op = baseOp('image', pageId, rect, opts);
    op.assetId = opts.assetId || null;
    op.dataUrl = opts.dataUrl || null;
    op.fit = opts.fit || 'contain';         // contain | cover | stretch
    op.mime = opts.mime || 'image/png';
    op.name = opts.name || 'image';
    op.naturalWidth = opts.naturalWidth || 0;
    op.naturalHeight = opts.naturalHeight || 0;
    return op;
  }

  function shapeOp(pageId, rect, opts) {
    opts = opts || {};
    var op = baseOp('shape', pageId, rect, opts);
    op.shape = opts.shape || 'rect';        // rect | ellipse | line
    op.fill = opts.fill === undefined ? '#ffffff' : opts.fill;
    op.fillOpacity = opts.fillOpacity == null ? 1 : opts.fillOpacity;
    op.stroke = opts.stroke === undefined ? null : opts.stroke;
    op.strokeWidth = opts.strokeWidth == null ? 1 : opts.strokeWidth;
    op.dash = opts.dash || null;
    op.radius = opts.radius || 0;
    return op;
  }

  /** Interactive form field (text, checkbox, radio, dropdown). */
  function fieldOp(pageId, rect, opts) {
    opts = opts || {};
    var op = baseOp('field', pageId, rect, opts);
    op.field = Object.assign({
      kind: 'text', name: '', value: '', options: [], readOnly: false,
      multiline: false, fontSize: 10, maxLen: 0, borderWidth: 1,
      borderColor: '#9aa4b2', backgroundColor: null, textColor: '#101828'
    }, opts.field || {});
    if (!op.field.name) op.field.name = 'field' + (uidCounter++);
    op.fontId = opts.fontId || 'sys-sans';
    return op;
  }

  function page(sourceIndex, opts) {
    opts = opts || {};
    return {
      id: uid('pg'),
      sourceIndex: sourceIndex == null ? 0 : sourceIndex,
      sourceOf: opts.sourceOf || null,
      rotation: opts.rotation || 0,
      deleted: !!opts.deleted,
      duplicate: !!opts.duplicate,
      blank: !!opts.blank,
      flattened: !!opts.flattened,
      flattenDpi: opts.flattenDpi || 150,
      background: opts.background || null,
      sizeMode: opts.sizeMode || 'keep',    // keep | a3 | a4 | a5 | letter | legal | tabloid | custom
      customSize: opts.customSize || null,
      crop: opts.crop || null
    };
  }

  function round(v) { return Math.round((Number(v) || 0) * 100) / 100; }

  /* ------------------------------------------------------------------ *
   * Store
   * ------------------------------------------------------------------ */

  function Store() {
    this.doc = {
      version: 1,
      tool: 'HTML PDF Modifier',
      source: { name: '', size: 0, numPages: 0, fingerprint: '' },
      pages: [],
      ops: [],
      meta: { created: new Date().toISOString(), modified: new Date().toISOString() }
    };
    this.assets = {};                 // id -> {id, name, mime, dataUrl, width, height}
    this.fonts = [];                  // metadata only (bytes live in the font registry)
    this._undo = [];
    this._redo = [];
    this._listeners = [];
    this._label = '';
    this._muted = false;
    this.maxHistory = 60;
  }

  Store.prototype.subscribe = function (fn) {
    this._listeners.push(fn);
    var self = this;
    return function () {
      var i = self._listeners.indexOf(fn);
      if (i >= 0) self._listeners.splice(i, 1);
    };
  };

  Store.prototype.emit = function (reason, detail) {
    if (this._muted) return;
    for (var i = 0; i < this._listeners.length; i++) {
      try { this._listeners[i](reason, detail, this); } catch (e) { console.error(e); }
    }
  };

  Store.prototype.snapshot = function () {
    return JSON.stringify({ doc: this.doc, fonts: this.fonts });
  };

  Store.prototype.restore = function (json) {
    var parsed = JSON.parse(json);
    this.doc = parsed.doc;
    this.fonts = parsed.fonts || [];
    this.doc.meta = this.doc.meta || {};
  };

  /**
   * Run a mutation as a single undoable step.
   * @param {string} label
   * @param {function} fn  receives the store
   */
  Store.prototype.commit = function (label, fn) {
    var before = this.snapshot();
    var result;
    this._muted = true;
    try {
      result = fn(this);
    } finally {
      this._muted = false;
    }
    var after = this.snapshot();
    if (before === after) return result;
    this._undo.push({ label: label, state: before });
    if (this._undo.length > this.maxHistory) this._undo.shift();
    this._redo.length = 0;
    this.touch();
    this.emit('change', { label: label });
    return result;
  };

  /** Coalescing commit for continuous gestures (dragging, sliders). */
  Store.prototype.beginGesture = function (label) {
    if (this._gesture) return;
    this._gesture = { label: label, state: this.snapshot() };
  };
  Store.prototype.endGesture = function () {
    if (!this._gesture) return;
    var g = this._gesture;
    this._gesture = null;
    if (g.state === this.snapshot()) return;
    this._undo.push({ label: g.label, state: g.state });
    if (this._undo.length > this.maxHistory) this._undo.shift();
    this._redo.length = 0;
    this.emit('change', { label: g.label });
  };
  Store.prototype.update = function (detail) {
    this.touch();
    this.emit('change', detail || { live: true });
  };

  Store.prototype.undo = function () {
    if (!this._undo.length) return false;
    var entry = this._undo.pop();
    this._redo.push({ label: entry.label, state: this.snapshot() });
    this.restore(entry.state);
    this.emit('change', { undo: true, label: entry.label });
    return true;
  };

  Store.prototype.redo = function () {
    if (!this._redo.length) return false;
    var entry = this._redo.pop();
    this._undo.push({ label: entry.label, state: this.snapshot() });
    this.restore(entry.state);
    this.emit('change', { redo: true, label: entry.label });
    return true;
  };

  Store.prototype.canUndo = function () { return this._undo.length > 0; };
  Store.prototype.canRedo = function () { return this._redo.length > 0; };
  Store.prototype.historyLabels = function () {
    return this._undo.map(function (e) { return e.label; });
  };

  Store.prototype.touch = function () {
    this.doc.meta.modified = new Date().toISOString();
  };

  /* --------------------------- pages -------------------------------- */

  Store.prototype.reset = function (source) {
    this.commit('open', function (s) {
      s.doc.source = source;
      s.doc.pages = [];
      s.doc.ops = [];
    });
  };

  Store.prototype.addPage = function (p) {
    this.doc.pages.push(p);
    return p;
  };

  Store.prototype.getPage = function (id) {
    for (var i = 0; i < this.doc.pages.length; i++) if (this.doc.pages[i].id === id) return this.doc.pages[i];
    return null;
  };

  Store.prototype.livePages = function () {
    return this.doc.pages.filter(function (p) { return !p.deleted; });
  };

  Store.prototype.pageIndex = function (id) {   // index among live pages, -1 if none
    var live = this.livePages();
    for (var i = 0; i < live.length; i++) if (live[i].id === id) return i;
    return -1;
  };

  Store.prototype.movePage = function (fromIndex, toIndex) {
    this.commit('reorder-page', function (s) {
      var live = s.doc.pages;
      var ids = live.map(function (p) { return p.id; });
      var moved = ids.splice(fromIndex, 1)[0];
      ids.splice(toIndex, 0, moved);
      var map = {};
      live.forEach(function (p) { map[p.id] = p; });
      s.doc.pages = ids.map(function (id) { return map[id]; });
    });
  };

  /* ----------------------------- ops -------------------------------- */

  Store.prototype.addOp = function (op) {
    this.doc.ops.push(op);
    return op;
  };

  Store.prototype.getOp = function (id) {
    for (var i = 0; i < this.doc.ops.length; i++) if (this.doc.ops[i].id === id) return this.doc.ops[i];
    return null;
  };

  Store.prototype.removeOp = function (id) {
    var i = this.doc.ops.indexOf(this.getOp(id));
    if (i >= 0) this.doc.ops.splice(i, 1);
  };

  Store.prototype.opsForPage = function (pageId) {
    return this.doc.ops.filter(function (o) { return o.pageId === pageId; });
  };

  Store.prototype.opAt = function (pageId, x, y) {
    var ops = this.opsForPage(pageId).filter(function (o) {
      return o.visible !== false && x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h;
    });
    return ops.length ? ops[ops.length - 1] : null;   // topmost wins
  };

  /* --------------------------- assets ------------------------------- */

  Store.prototype.addAsset = function (asset) {
    var id = asset.id || uid('as');
    asset.id = id;
    this.assets[id] = asset;
    return asset;
  };

  Store.prototype.getAsset = function (id) { return this.assets[id] || null; };

  /* ------------------------ serialisation --------------------------- */

  Store.prototype.toJSON = function (includeAssets) {
    return {
      version: 1,
      tool: 'HTML PDF Modifier',
      savedAt: new Date().toISOString(),
      source: this.doc.source,
      meta: this.doc.meta,
      pages: this.doc.pages,
      ops: this.doc.ops,
      fonts: this.fonts,
      assets: includeAssets === false ? [] : Object.keys(this.assets).map(function (k) { return this.assets[k]; }, this)
    };
  };

  Store.prototype.loadJSON = function (data) {
    if (!data || !data.pages || !data.ops) throw new Error('Not a valid project file');
    this.commit('load-project', function (s) {
      s.doc.pages = data.pages;
      s.doc.ops = data.ops;
      s.doc.source = data.source || { name: '', size: 0, numPages: data.pages.length, fingerprint: '' };
      s.doc.meta = data.meta || s.doc.meta;
      s.fonts = data.fonts || [];
      s.assets = {};
      (data.assets || []).forEach(function (a) { s.assets[a.id] = a; });
    });
  };

  return {
    uid: uid,
    clone: clone,
    round: round,
    Store: Store,
    textOp: textOp,
    imageOp: imageOp,
    fieldOp: fieldOp,
    shapeOp: shapeOp,
    page: page
  };
});
