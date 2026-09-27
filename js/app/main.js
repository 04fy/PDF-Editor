/*!
 * app/main.js — application wiring: files, panels, tools, selection actions,
 * export, search, keyboard shortcuts and settings.
 */
(function (root) {
  'use strict';
  var PM = (root.PM = root.PM || {});
  var Text = PM.Text;
  var Ops = PM.Ops;
  var Arrange = PM.Arrange;
  var Icons = PM.Icons;
  var Exporter = PM.Exporter;

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var els = {};
  var store, source, fonts, viewer, inspector, dialogs, i18n, units;
  var clipboard = [];
  var settings = { lang: null, theme: 'auto', units: 'pt', snap: true, boxes: true };
  var busyDepth = 0;
  var searchState = { matches: [], index: -1, term: '', replacement: '', matchCase: false, wholeWord: false };
  var currentPanel = 'pages';
  var sourceBytes = null;
  var lastPassword = '';
  var indexing = false;
  var autosaveTimer = null;
  var exportOptions = { range: 'all', from: 1, to: 1, flattenForm: false, includeSource: true, quality: 0.92 };

  function t(key, vars) { return i18n.t(key, vars); }

  /* ================================================================== *
   * boot
   * ================================================================== */

  function boot() {
    els = {
      viewport: $('#viewport'),
      dropzone: $('#dropzone'),
      inspector: $('#inspector'),
      fileInput: $('#file-input'),
      projectInput: $('#project-input'),
      fontInput: $('#font-input'),
      imageInput: $('#image-input'),
      langSelect: $('#lang-select'),
      themeSelect: $('#theme-select'),
      unitsSelect: $('#units-select'),
      zoomSlider: $('#zoom-slider'),
      docName: $('#doc-name'),
      statusState: $('#status-state'),
      statusPage: $('#status-page'),
      statusSelection: $('#status-selection'),
      statusZoom: $('#status-zoom'),
      statusHint: $('#status-hint'),
      statusSaved: $('#status-saved'),
      busy: $('#busy'),
      busyText: $('#busy-text'),
      toastStack: $('#toast-stack'),
      menu: $('#context-menu'),
      modal: $('#modal'),
      modalBody: $('#modal-body'),
      modalTitle: $('#modal-title'),
      zoomLabel: $('#zoom-label')
    };

    var saved = loadSettings();
    Object.assign(settings, saved);
    i18n = PM.I18n.create(settings.lang || null);
    settings.lang = i18n.lang;
    units = PM.Units.create(settings.units);

    store = new Ops.Store();
    source = PM.PdfSource.create(root.pdfjsLib);
    fonts = PM.Fonts.create();
    source.setupWorker();

    dialogs = PM.Dialogs.create({
      t: t, modal: els.modal, modalBody: els.modalBody, modalTitle: els.modalTitle,
      toastStack: els.toastStack, menu: els.menu
    });

    viewer = PM.Viewer.create({
      container: els.viewport, store: store, source: source, fonts: fonts, t: t,
      onSelect: onViewerSelect, onStatus: updateStatus,
      onContextMenu: showContextMenu, onRequestImage: insertImage
    });

    inspector = PM.Inspector.create({
      root: els.inspector, store: store, fonts: fonts, units: units, viewer: viewer, t: t,
      onChange: onInspectorChange, onAction: onInspectorAction
    });

    store.subscribe(onStoreChange);
    window.addEventListener('beforeunload', function (ev) {
      if (store.canUndo()) { ev.preventDefault(); ev.returnValue = ''; }
    });

    buildSelects();
    applySettings();
    applyI18n();
    bindToolbar();
    bindTabs();
    bindDropzone();
    bindSplitters();
    bindShortcuts();
    units.subscribe(function () { renderPanel(); updateStatus(); if (viewer.selected()) inspector.rebuild(); });

    var params = new URLSearchParams(location.search);
    if (params.get('file')) openUrl(params.get('file'));
    showPanel('pages');
    updateStatus();
  }

  /* ================================================================== *
   * settings / i18n
   * ================================================================== */

  function buildSelects() {
    els.langSelect.innerHTML = '';
    i18n.languages.forEach(function (l) {
      var o = el('option', null, l.label);
      o.value = l.code;
      if (l.code === i18n.lang) o.selected = true;
      els.langSelect.appendChild(o);
    });

    els.themeSelect.innerHTML = '';
    [['light', 'ui.themeLight'], ['dark', 'ui.themeDark'], ['auto', 'ui.themeAuto']].forEach(function (p) {
      var o = el('option', null, t(p[1]));
      o.value = p[0];
      o.dataset.i18n = p[1];
      if (p[0] === settings.theme) o.selected = true;
      els.themeSelect.appendChild(o);
    });

    els.unitsSelect.innerHTML = '';
    units.list.forEach(function (u) {
      var o = el('option', null, t('units.' + u.id));
      o.value = u.id;
      if (u.id === units.id) o.selected = true;
      els.unitsSelect.appendChild(o);
    });
  }

  function applySettings() {
    document.documentElement.setAttribute('lang', i18n.lang);
    document.documentElement.setAttribute('dir', i18n.dir());
    var theme = settings.theme;
    if (theme === 'auto') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    viewer.setSnap(settings.snap);
    viewer.setShowTextBoxes(settings.boxes);
  }

  function applyI18n() {
    $$('[data-i18n]').forEach(function (node) {
      var key = node.dataset.i18n;
      var target = node.tagName === 'BUTTON' && node.querySelector('span') ? node.querySelector('span') : node;
      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') node.placeholder = t(key);
      else target.textContent = t(key);
    });
    $$('[data-i18n-title]').forEach(function (node) { node.title = t(node.dataset.i18nTitle); });
    $$('[data-i18n-label]').forEach(function (node) { node.setAttribute('aria-label', t(node.dataset.i18nLabel)); });
    document.title = t('appName') + (store.doc.source.name ? ' — ' + store.doc.source.name : '');
    buildSelects();
    els.statusHint.textContent = t('ui.hint');
    showPanel(currentPanel);
    updateStatus();
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem('htmlpdf.settings');
      if (raw) return JSON.parse(raw);
    } catch (e) { void e; }
    return {};
  }
  function saveSettings() {
    try { localStorage.setItem('htmlpdf.settings', JSON.stringify(settings)); } catch (e) { void e; }
  }

  /* ================================================================== *
   * toolbar
   * ================================================================== */

  function bindToolbar() {
    bindFile(els.fileInput, openFile);
    bindFile(els.projectInput, openProject);
    bindFile(els.fontInput, addFontFile);
    bindFile(els.imageInput, insertImageFile);

    $$('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () { doAction(btn.dataset.action); });
    });
    $$('[data-tool]').forEach(function (btn) {
      btn.addEventListener('click', function () { setTool(btn.dataset.tool); });
    });
    $$('[data-setting]').forEach(function (input) {
      var key = input.dataset.setting;
      if (input.type === 'checkbox') input.checked = !!settings[key];
      input.addEventListener('change', function () {
        settings[key] = input.type === 'checkbox' ? input.checked : input.value;
        saveSettings();
        applySettings();
      });
    });
    els.langSelect.addEventListener('change', function () {
      i18n.set(this.value);
      settings.lang = i18n.lang;
      saveSettings();
      applySettings();
      applyI18n();
    });
    els.themeSelect.addEventListener('change', function () {
      settings.theme = this.value;
      saveSettings();
      applySettings();
    });
    els.unitsSelect.addEventListener('change', function () {
      settings.units = units.set(this.value);
      saveSettings();
      inspector.rebuild();
    });
    els.zoomSlider.addEventListener('input', function () { viewer.setZoom(Number(this.value) / 100); });
  }

  function bindFile(input, handler) {
    input.addEventListener('change', function () {
      if (this.files && this.files[0]) handler(this.files[0]);
      this.value = '';
    });
  }

  function doAction(name) {
    switch (name) {
      case 'open': els.fileInput.click(); break;
      case 'open-url': promptUrl(); break;
      case 'open-project': els.projectInput.click(); break;
      case 'save-project': saveProject(); break;
      case 'download': openExportDialog(); break;
      case 'undo': if (store.undo()) afterModelChange(); break;
      case 'redo': if (store.redo()) afterModelChange(); break;
      case 'zoom-in': viewer.zoomIn(); break;
      case 'zoom-out': viewer.zoomOut(); break;
      case 'fit-width': viewer.fitWidth(); break;
      case 'fit-page': viewer.fitPage(); break;
      case 'print': printDocument(); break;
      case 'properties': openProperties(); break;
      case 'shortcuts': openShortcuts(); break;
      case 'add-page': addBlankPage(); break;
      case 'insert-image': els.imageInput.click(); break;
      default: break;
    }
  }

  function setTool(name) {
    viewer.setTool(name);
    $$('[data-tool]').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === name); });
  }

  /* ================================================================== *
   * documents
   * ================================================================== */

  function busy(on, label) {
    busyDepth = Math.max(0, busyDepth + (on ? 1 : -1));
    els.busy.classList.toggle('show', busyDepth > 0);
    if (label) els.busyText.textContent = label;
  }

  function toast(message, kind) { dialogs.toast(message, kind); }

  async function openFile(file) {
    if (!file) return;
    if (/\.json$/i.test(file.name)) { openProject(file); return; }
    busy(true, t('status.loading'));
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      await loadBytes(buf, file.name, file.size);
    } catch (e) {
      console.error(e);
      toast(e.message || t('msg.exportFail'), 'error');
    } finally { busy(false); }
  }

  async function openUrl(url) {
    if (!url) return promptUrl();
    busy(true, t('status.loading'));
    try {
      var res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var buf = new Uint8Array(await res.arrayBuffer());
      var name = (url.split('/').pop() || 'document.pdf').split('?')[0];
      await loadBytes(buf, name, buf.length);
    } catch (e) {
      toast(e.message, 'error');
    } finally { busy(false); }
  }

  function promptUrl() {
    dialogs.open({
      title: t('openUrl'),
      html: '<input id="url-input" class="text-input" type="url" placeholder="https://…/file.pdf">' +
        '<p class="note">' + t('msg.urlNote') + '</p>',
      okLabel: t('open'),
      onOk: function (b) {
        var v = $('#url-input', b).value.trim();
        if (v) openUrl(v);
      }
    });
  }

  async function loadBytes(buf, name, size) {
    var info;
    try {
      info = await source.load(buf, { password: lastPassword || '' });
    } catch (e) {
      if (/password/i.test(e.message || '')) {
        var pw = await dialogs.prompt(t('msg.password'), { type: 'password', hint: t('msg.passwordNote') });
        if (pw == null) return;
        lastPassword = pw;
        info = await source.load(buf, { password: pw });
      } else { throw e; }
    }
    lastPassword = '';
    store.reset({
      name: name || 'document.pdf', size: size || buf.length,
      numPages: info.numPages, fingerprint: info.fingerprint
    });
    for (var i = 0; i < info.numPages; i++) store.addPage(Ops.page(i));
    sourceBytes = buf;
    els.docName.textContent = name;
    document.title = t('appName') + ' — ' + (name || '');
    els.dropzone.classList.add('hidden');
    viewer.build();
    viewer.fitWidth();
    store.emit('document-loaded', {});
    renderPanel();
    indexAllPages();
    autosave();
    toast(name + ' · ' + info.numPages + ' ' + t('status.pages'), 'ok');
    offerRestore(info.fingerprint, name);
  }

  /** Offers to bring back the edits of an earlier session on the same file. */
  function offerRestore(fingerprint, name) {
    var data;
    try {
      var raw = localStorage.getItem('htmlpdf.autosave');
      if (!raw) return;
      data = JSON.parse(raw);
    } catch (e) { return; }
    if (!data || !data.source || data.source.fingerprint !== fingerprint) return;
    if (!data.ops || !data.ops.length) return;
    dialogs.open({
      title: t('status.dirty'),
      html: '<p class="note">' + data.ops.length + ' ' + t('tab.layers') + ' — ' +
        (data.source.name || name) + '<br>' + t('msg.restore') + '</p>',
      okLabel: t('edit.restore'),
      onOk: function () {
        (data.assets || []).forEach(function (a) { store.assets[a.id] = a; });
        store.loadJSON(data);
        viewer.build();
        viewer.fitWidth();
        renderPanel();
        indexAllPages();
        toast(t('msg.saved'), 'ok');
      }
    });
  }

  /* ================================================================== *
   * content index
   * ================================================================== */

  async function indexAllPages() {
    if (indexing) return;
    indexing = true;
    try {
      var pages = store.livePages();
      for (var i = 0; i < pages.length; i++) {
        await indexPage(pages[i], false);
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    } finally {
      indexing = false;
      renderPanel();
      updateStatus();
    }
  }

  async function indexImages(pageId) {
    var p = store.getPage(pageId);
    if (!p) return;
    indexing = true;
    try { await indexPage(p, true); }
    finally { indexing = false; renderPanel(); }
  }

  async function indexPage(p, wantImages) {
    var current = viewer.getTextIndex(p.id) || {};
    try {
      if (!current.blocks) {
        var res = await source.extractText(p.sourceIndex);
        current.blocks = res.blocks;
        viewer.setTextIndex(p.id, current);
      }
    } catch (e) {
      console.warn('Text could not be read on page ' + (p.sourceIndex + 1) + ': ' + e.message);
      if (!current.blocks) { current.blocks = []; viewer.setTextIndex(p.id, current); }
    }
    if (wantImages && !current.images) {
      try {
        current.images = await source.extractImages(p.sourceIndex);
        viewer.setTextIndex(p.id, current);
      } catch (e) {
        console.warn('Images could not be read on page ' + (p.sourceIndex + 1) + ': ' + e.message);
        current.images = [];
        viewer.setTextIndex(p.id, current);
      }
    }
  }

  /* ================================================================== *
   * panels
   * ================================================================== */

  function bindTabs() {
    $$('#side-tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () { showPanel(btn.dataset.tab); });
    });
  }

  function showPanel(name) {
    currentPanel = name;
    $$('#side-tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    $$('.tab-panels .panel').forEach(function (p) { p.classList.toggle('active', p.dataset.panel === name); });
    renderPanel();
    if (name === 'images') {
      var pageId = viewer.selectedPageId();
      if (pageId) indexImages(pageId);
    }
  }

  var PANELS = {
    pages: renderPagesPanel, text: renderTextPanel, images: renderImagesPanel,
    layers: renderLayersPanel, search: renderSearchPanel, fonts: renderFontsPanel,
    history: renderHistoryPanel
  };

  function renderPanel() {
    if (!currentPanel) return;
    var panel = $('.panel[data-panel="' + currentPanel + '"]');
    if (!panel) return;
    var scroll = panel.scrollTop;
    panel.innerHTML = '';
    (PANELS[currentPanel] || function () { })(panel);
    panel.scrollTop = scroll;
  }

  function panelHead(title, extra) {
    var head = el('div', 'panel-head');
    head.appendChild(el('span', null, title));
    if (extra) head.appendChild(extra);
    return head;
  }
  function empty(text) { return el('div', 'empty', text); }
  function head3(text) { return el('div', 'panel-sub', text); }

  function check(label, value, onChange) {
    var w = el('label', 'check');
    var i = el('input');
    i.type = 'checkbox';
    i.checked = !!value;
    i.addEventListener('change', function () { onChange(i.checked); });
    w.appendChild(i);
    w.appendChild(el('span', null, label));
    return w;
  }

  function mini(icon, title, onClick) {
    var b = Icons.button(icon, { title: title, label: title, className: 'btn-sm icon' });
    b.addEventListener('click', function (ev) { ev.stopPropagation(); onClick(ev); });
    return b;
  }

  function thumbImage(pageId) {
    var img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    var pi = viewer.pageInfo(pageId);
    if (!pi) return img;
    var rotated = pi.rotation === 90 || pi.rotation === 270;
    img.style.aspectRatio = String(1 / (rotated ? pi.width / pi.height : pi.height / pi.width));
    var model = store.getPage(pageId);
    if (model && model.blank) { img.style.background = '#fff'; return img; }
    var width = 128;
    var scale = width / (rotated ? pi.height : pi.width);
    source.rasterise(pi.index, { dpi: Math.max(36, Math.min(300, 72 * scale)) })
      .then(function (shot) { img.src = shot.dataUrl; })
      .catch(function () { });
    return img;
  }

  function renderPagesPanel(panel) {
    var pages = store.livePages();
    if (!pages.length) { panel.appendChild(empty(t('pages.noDoc'))); return; }
    var add = Icons.button('plus', { title: t('pages.add'), className: 'btn-sm icon' });
    add.addEventListener('click', addBlankPage);
    panel.appendChild(panelHead(t('pages.count') + ' · ' + pages.length, add));

    var current = viewer.selectedPageId();
    pages.forEach(function (p, i) {
      var item = el('div', 'thumb' + (p.id === current ? ' current' : ''));
      item.dataset.pageId = p.id;
      item.draggable = true;

      var frame = el('div', 'thumb-frame');
      frame.appendChild(thumbImage(p.id));
      frame.appendChild(el('span', 'thumb-num', String(i + 1)));
      var badges = el('div', 'thumb-badges');
      if (p.rotation) badges.appendChild(el('span', 'thumb-badge', p.rotation + '°'));
      if (p.flattened) badges.appendChild(el('span', 'thumb-badge warn', t('pages.flatBadge')));
      if (p.blank) badges.appendChild(el('span', 'thumb-badge', t('pages.blankBadge')));
      frame.appendChild(badges);
      item.appendChild(frame);

      var bar = el('div', 'thumb-bar');
      [
        ['rotate-left', t('pages.rotateL'), function () { rotatePage(p, -90); }],
        ['rotate-right', t('pages.rotateR'), function () { rotatePage(p, 90); }],
        ['duplicate', t('pages.duplicate'), function () { duplicatePage(p); }],
        ['trash', t('pages.delete'), function () { deletePage(p); }]
      ].forEach(function (b) { bar.appendChild(mini(b[0], b[1], b[2])); });
      item.appendChild(bar);

      item.addEventListener('click', function () {
        viewer.scrollToPage(p.id);
        viewer.clearSelection();
        inspector.renderPage(p.id);
        renderPanel();
      });
      item.addEventListener('dragstart', function (ev) {
        item.classList.add('dragging');
        ev.dataTransfer.setData('text/plain', String(i));
        ev.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', function () {
        item.classList.remove('dragging');
        $$('.thumb').forEach(function (x) { x.classList.remove('drop-before', 'drop-after'); });
      });
      item.addEventListener('dragover', function (ev) {
        ev.preventDefault();
        var r = item.getBoundingClientRect();
        var after = ev.clientY > r.top + r.height / 2;
        item.classList.toggle('drop-after', after);
        item.classList.toggle('drop-before', !after);
      });
      item.addEventListener('dragleave', function () {
        item.classList.remove('drop-before', 'drop-after');
      });
      item.addEventListener('drop', function (ev) {
        ev.preventDefault();
        var from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
        if (isNaN(from)) return;
        var r = item.getBoundingClientRect();
        var to = ev.clientY > r.top + r.height / 2 ? i + 1 : i;
        item.classList.remove('drop-before', 'drop-after');
        if (from === to || from + 1 === to) return;
        store.movePage(from, to);
        afterModelChange(true);
      });
      panel.appendChild(item);
    });
  }

  function renderTextPanel(panel) {
    var pageId = viewer.selectedPageId();
    if (!pageId) { panel.appendChild(empty(t('pages.noDoc'))); return; }
    panel.appendChild(panelHead(t('status.page') + ' ' + (store.pageIndex(pageId) + 1)));
    var field = el('div', 'search-field');
    field.innerHTML = Icons.use('search');
    var input = el('input', 'text-input');
    input.type = 'search';
    input.placeholder = t('text.search');
    field.appendChild(input);
    panel.appendChild(field);
    var list = el('div', 'list');
    panel.appendChild(list);

    function draw(term) {
      list.innerHTML = '';
      var idx = viewer.getTextIndex(pageId);
      var blocks = (idx && idx.blocks) || [];
      var n = 0;
      blocks.forEach(function (b) {
        if (term && b.text.toLowerCase().indexOf(term.toLowerCase()) < 0) return;
        n++;
        var row = el('button', 'list-row');
        row.type = 'button';
        var label = el('span', 'list-text', b.text.replace(/\n/g, ' ⏎ '));
        label.dir = Text.isRTL(b.text) ? 'rtl' : 'ltr';
        row.appendChild(label);
        row.appendChild(el('span', 'list-meta', b.size.toFixed(1) + 'pt'));
        row.addEventListener('click', function () {
          viewer.scrollToPage(pageId);
          flashBox(pageId, b.rect);
        });
        list.appendChild(row);
      });
      if (!n) list.appendChild(empty(t('text.none')));
    }
    input.addEventListener('input', function () { draw(this.value.trim()); });
    draw('');
  }

  function flashBox(pageId, rect) {
    var wrap = viewer.wrapFor(pageId);
    if (!wrap) return;
    var node = el('div', 'flash');
    node.style.left = rect.x + 'px';
    node.style.top = rect.y + 'px';
    node.style.width = rect.w + 'px';
    node.style.height = rect.h + 'px';
    wrap.overlay.appendChild(node);
    setTimeout(function () { node.remove(); }, 1200);
  }

  function renderImagesPanel(panel) {
    var pageId = viewer.selectedPageId();
    if (!pageId) { panel.appendChild(empty(t('pages.noDoc'))); return; }
    var idx = viewer.getTextIndex(pageId);
    var images = (idx && idx.images) || [];
    panel.appendChild(panelHead(t('status.page') + ' ' + (store.pageIndex(pageId) + 1) +
      ' · ' + images.length + ' ' + t('tab.images')));
    if (!images.length) { panel.appendChild(empty(t('images.none'))); return; }
    var grid = el('div', 'img-grid');
    panel.appendChild(grid);
    images.forEach(function (im) {
      var cell = el('div', 'img-cell');
      if (im.dataUrl) {
        var img = el('img');
        img.src = im.dataUrl;
        img.alt = '';
        cell.appendChild(img);
      } else {
        cell.appendChild(empty('?'));
      }
      cell.appendChild(el('span', null, Math.round(im.width) + '×' + Math.round(im.height)));
      var act = el('div', 'img-actions');
      act.appendChild(mini('plus', t('tool.image'), function () { placeImage(pageId, im); }));
      cell.appendChild(act);
      cell.addEventListener('click', function () { flashBox(pageId, im.rect); });
      grid.appendChild(cell);
    });
  }

  function placeImage(pageId, detected) {
    if (!detected.dataUrl) { toast(t('images.none'), 'warn'); return; }
    var op = Ops.imageOp(pageId, detected.rect, {
      dataUrl: detected.dataUrl, mime: 'image/png', fit: 'fill', name: 'image'
    });
    store.commit('add-image', function (s) { s.addOp(op); });
    viewer.select(op.id);
    toast(t('msg.added'), 'ok');
  }

  function renderLayersPanel(panel) {
    var pageId = viewer.selectedPageId();
    if (!pageId) { panel.appendChild(empty(t('pages.noDoc'))); return; }
    var ops = store.opsForPage(pageId);
    panel.appendChild(panelHead(t('tab.layers') + ' · ' + ops.length));
    if (!ops.length) { panel.appendChild(empty(t('layers.none'))); return; }
    var list = el('div', 'list');
    panel.appendChild(list);
    var selected = viewer.selectionIds();
    ops.slice().reverse().forEach(function (op) {
      var row = el('div', 'list-row layer' + (selected.indexOf(op.id) >= 0 ? ' current' : ''));
      var name = el('span', 'list-text', describeOp(op));
      if (op.type === 'text' && Text.isRTL(op.text)) name.dir = 'rtl';
      row.appendChild(name);
      row.appendChild(mini(op.visible === false ? 'eye-off' : 'eye', t('layers.visible'), function () {
        store.commit('toggle-visibility', function () { op.visible = op.visible === false; });
      }));
      row.appendChild(mini(op.locked ? 'lock' : 'unlock', t('layers.locked'), function () {
        store.commit('toggle-lock', function () { op.locked = !op.locked; });
      }));
      row.appendChild(mini('trash', t('edit.delete'), function () { deleteSelection([op]); }));
      row.addEventListener('click', function (ev) {
        if (ev.shiftKey) viewer.toggle(op.id);
        else viewer.select(op.id);
      });
      list.appendChild(row);
    });
  }

  function describeOp(op) {
    if (op.type === 'text') return (op.text || '').replace(/\s+/g, ' ').trim().slice(0, 60) || t('prop.text');
    if (op.type === 'image') return t('prop.image') + ' · ' + (op.name || '');
    if (op.type === 'field') return t('prop.field') + ' · ' + (op.field.name || op.field.kind);
    if (op.redaction) return t('tool.redact');
    return t('prop.shape') + ' · ' + op.shape;
  }

  function renderSearchPanel(panel) {
    panel.appendChild(panelHead(t('tab.search')));
    var f = el('input', 'text-input');
    f.type = 'search';
    f.placeholder = t('search.find');
    f.value = searchState.term;
    f.addEventListener('input', function () { searchState.term = this.value; runSearch(); });
    panel.appendChild(f);

    var r = el('input', 'text-input');
    r.type = 'text';
    r.placeholder = t('search.replace');
    r.value = searchState.replacement;
    r.addEventListener('input', function () { searchState.replacement = this.value; });
    panel.appendChild(r);

    var opts = el('div', 'row');
    opts.appendChild(check(t('search.case'), searchState.matchCase, function (v) { searchState.matchCase = v; runSearch(); }));
    opts.appendChild(check(t('search.word'), searchState.wholeWord, function (v) { searchState.wholeWord = v; runSearch(); }));
    panel.appendChild(opts);

    var nav = el('div', 'btn-row');
    nav.appendChild(mini('backward', t('search.prev'), function () { step(-1); }));
    nav.appendChild(mini('forward', t('search.next'), function () { step(1); }));
    nav.appendChild(mini('check', t('search.replaceAll'), replaceAll));
    panel.appendChild(nav);

    var out = el('div', 'list');
    out.id = 'search-results';
    panel.appendChild(out);
    runSearch();
  }

  function runSearch() {
    var out = $('#search-results');
    if (!out) return;
    var term = searchState.term;
    searchState.matches = [];
    out.innerHTML = '';
    if (!term) { out.appendChild(empty(t('search.none'))); updateStatus(); return; }
    var needle = searchState.matchCase ? term : term.toLowerCase();
    var re = searchState.wholeWord
      ? new RegExp('(^|[^\\w])' + escapeRe(needle) + '($|[^\\w])', searchState.matchCase ? '' : 'i')
      : null;
    store.livePages().forEach(function (p) {
      var idx = viewer.getTextIndex(p.id);
      if (!idx || !idx.blocks) return;
      idx.blocks.forEach(function (b) {
        var hay = searchState.matchCase ? b.text : b.text.toLowerCase();
        if (re ? re.test(hay) : hay.indexOf(needle) >= 0) searchState.matches.push({ pageId: p.id, block: b });
      });
    });
    if (!searchState.matches.length) out.appendChild(empty(t('search.none')));
    searchState.matches.forEach(function (m, i) {
      var row = el('button', 'list-row');
      row.type = 'button';
      var label = el('span', 'list-text', m.block.text.replace(/\n/g, ' ').slice(0, 70));
      if (Text.isRTL(m.block.text)) label.dir = 'rtl';
      row.appendChild(label);
      row.appendChild(el('span', 'list-meta', t('status.page') + ' ' + (store.pageIndex(m.pageId) + 1)));
      row.addEventListener('click', function () {
        searchState.index = i;
        viewer.scrollToPage(m.pageId);
        flashBox(m.pageId, m.block.rect);
      });
      out.appendChild(row);
    });
    updateStatus();
  }

  function step(dir) {
    if (!searchState.matches.length) return;
    searchState.index = (searchState.index + dir + searchState.matches.length) % searchState.matches.length;
    var m = searchState.matches[searchState.index];
    viewer.scrollToPage(m.pageId);
    flashBox(m.pageId, m.block.rect);
  }

  function replaceInMatch(m) {
    var existing = findOpForBlock(m.pageId, m.block);
    var text = searchState.matchCase
      ? m.block.text.split(searchState.term).join(searchState.replacement)
      : m.block.text.replace(new RegExp(escapeRe(searchState.term), 'gi'), searchState.replacement);
    if (existing) {
      store.commit('replace-text', function () { existing.text = text; });
      viewer.select(existing.id);
    } else {
      var op = Ops.textOp(m.pageId, m.block.rect, {
        text: text, size: m.block.size, fontId: 'sys-sans', cover: true,
        sourceRect: m.block.rect, coverColor: '#ffffff'
      });
      store.commit('replace-text', function (s) { s.addOp(op); });
      viewer.select(op.id);
    }
  }

  function findOpForBlock(pageId, block) {
    var ops = store.opsForPage(pageId).filter(function (o) { return o.type === 'text' && o.sourceRect; });
    for (var i = 0; i < ops.length; i++) {
      var r = ops[i].sourceRect;
      if (Math.abs(r.x - block.rect.x) < 0.6 && Math.abs(r.y - block.rect.y) < 0.6) return ops[i];
    }
    return null;
  }

  function replaceAll() {
    if (!searchState.matches.length) return;
    var list = searchState.matches.slice();
    store.commit('replace-all', function () { list.forEach(replaceInMatch); });
    toast(list.length + ' ' + t('search.found'), 'ok');
  }

  function renderFontsPanel(panel) {
    panel.appendChild(panelHead(t('fonts.title')));
    panel.appendChild(el('p', 'note', t('fonts.note')));
    var addBtn = el('button', 'btn', t('fonts.add'));
    addBtn.addEventListener('click', function () { els.fontInput.click(); });
    panel.appendChild(addBtn);

    [['fonts.uploaded', fonts.list().filter(function (f) { return f.kind === 'file'; })],
     ['fonts.system', fonts.list().filter(function (f) { return f.kind === 'system' || f.kind === 'builtin'; })]]
      .forEach(function (g) {
        if (!g[1].length) return;
        panel.appendChild(head3(g[0]));
        g[1].forEach(function (f) {
          var row = el('div', 'list-row font');
          var sample = el('span', 'font-sample', f.label);
          sample.style.fontFamily = fonts.family(f.id);
          row.appendChild(sample);
          row.appendChild(el('span', 'list-meta',
            f.kind === 'file' ? t('fonts.embedded') : (f.kind === 'builtin' ? 'PDF' : t('fonts.system'))));
          if (f.kind === 'file') {
            row.appendChild(mini('close', t('fonts.remove'), function () {
              store.commit('remove-font', function () {
                fonts.remove(f.id);
                store.fonts = store.fonts.filter(function (x) { return x.id !== f.id; });
              });
              renderPanel();
            }));
          }
          panel.appendChild(row);
        });
      });

    panel.appendChild(head3(t('fonts.library')));
    var have = {};
    fonts.list().forEach(function (f) { if (f.name) have[f.name] = true; });
    fonts.library.forEach(function (lib) {
      if (have[lib.name]) return;
      var row = el('div', 'list-row font');
      row.appendChild(el('span', 'list-text', lib.name));
      row.appendChild(el('span', 'list-meta', lib.scripts));
      var add = mini('plus', t('fonts.add'), async function () {
        add.disabled = true;
        try {
          var def = await fonts.addUrl(lib.url, lib.name, { embeddable: lib.embed });
          store.commit('add-font', function () { store.fonts.push({ id: def.id, name: def.name, kind: 'file' }); });
          toast(t('msg.fontAdded'), 'ok');
        } catch (e) {
          toast(t('fonts.noNetwork') + ' — ' + e.message, 'warn');
        }
        renderPanel();
      });
      row.appendChild(add);
      panel.appendChild(row);
    });
  }

  function renderHistoryPanel(panel) {
    panel.appendChild(panelHead(t('tab.history')));
    var list = el('div', 'list');
    panel.appendChild(list);
    var labels = store.historyLabels();
    if (!labels.length) { list.appendChild(empty(t('history.empty'))); return; }
    labels.slice().reverse().forEach(function (label, i) {
      var idx = labels.length - 1 - i;
      var row = el('button', 'list-row');
      row.type = 'button';
      row.appendChild(el('span', 'list-text', label));
      row.addEventListener('click', function () {
        for (var k = 0; k <= idx; k++) store.undo();
        afterModelChange();
      });
      list.appendChild(row);
    });
  }

  /* ================================================================== *
   * page actions
   * ================================================================== */

  function rotatePage(p, delta) {
    store.commit('rotate-page', function () {
      p.rotation = (((p.rotation || 0) + delta) % 360 + 360) % 360;
    });
    toast(t('msg.rotated'), 'ok');
  }

  function duplicatePage(p) {
    var idx = store.doc.pages.indexOf(p);
    var copy = Ops.page(p.sourceIndex, {
      rotation: p.rotation, background: p.background, sizeMode: p.sizeMode,
      customSize: p.customSize, flattened: p.flattened, flattenDpi: p.flattenDpi
    });
    copy.duplicate = true;
    copy.sourceOf = p.id;
    store.commit('duplicate-page', function () {
      store.doc.pages.splice(idx + 1, 0, copy);
      store.opsForPage(p.id).forEach(function (o) {
        var clone = JSON.parse(JSON.stringify(o));
        clone.id = Ops.uid('op');
        clone.pageId = copy.id;
        store.addOp(clone);
      });
    });
    toast(t('msg.duplicated'), 'ok');
  }

  function deletePage(p) {
    if (store.livePages().length <= 1) { toast(t('pages.noDoc'), 'warn'); return; }
    store.commit('delete-page', function () {
      p.deleted = true;
      store.doc.ops = store.doc.ops.filter(function (o) { return o.pageId !== p.id; });
    });
    toast(t('msg.deleted'), 'ok');
  }

  function addBlankPage() { insertBlankAfter(null); }

  function insertBlankAfter(after) {
    var live = store.livePages();
    var ref = after || live[live.length - 1];
    var p = Ops.page(ref ? ref.sourceIndex : 0, {
      blank: true, rotation: ref ? ref.rotation : 0,
      sizeMode: ref ? ref.sizeMode : 'keep', background: ref ? ref.background : null
    });
    store.commit('add-page', function () {
      var at = ref ? store.doc.pages.indexOf(ref) + 1 : store.doc.pages.length;
      store.doc.pages.splice(at, 0, p);
    });
    setTimeout(function () {
      var wrap = viewer.wrapFor(p.id);
      if (wrap && wrap.el.scrollIntoView) wrap.el.scrollIntoView({ block: 'center' });
    }, 90);
  }

  function printDocument() {
    if (!source.bytes) { toast(t('msg.noDoc'), 'warn'); return; }
    viewer.renderAll();
    setTimeout(function () { window.print(); }, 450);
  }

  /* ================================================================== *
   * images / fonts
   * ================================================================== */

  async function addFontFile(file) {
    try {
      var def = await fonts.addFile(file);
      store.commit('add-font', function () { store.fonts.push({ id: def.id, name: def.label, kind: 'file' }); });
      toast(t('msg.fontAdded'), 'ok');
    } catch (e) {
      toast(t('msg.fontFail') + ' — ' + e.message, 'error');
    }
  }

  function fileToAsset(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var mime = /jpe?g/i.test(file.type) ? 'image/jpeg' : 'image/png';
        var canvas = el('canvas');
        canvas.width = img.naturalWidth || 1;
        canvas.height = img.naturalHeight || 1;
        var ctx = canvas.getContext('2d');
        if (mime === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        var dataUrl = canvas.toDataURL(mime, exportOptions.quality);
        var bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve({
          id: Ops.uid('as'), name: file.name, mime: mime, dataUrl: dataUrl,
          width: canvas.width, height: canvas.height, bytes: bytes, size: bytes.length
        });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Unsupported image')); };
      img.src = url;
    });
  }

  async function insertImageFile(file) {
    var pageId = viewer.selectedPageId();
    if (pageId && file) await insertImage(pageId, null, file);
  }

  async function insertImage(pageId, rect, file) {
    if (!file) { els.imageInput.click(); return; }
    try {
      var asset = await fileToAsset(file);
      var box = rect || { x: 60, y: 60, w: 200, h: 150 };
      var op = Ops.imageOp(pageId, box, {
        assetId: asset.id, mime: asset.mime, name: asset.name, fit: 'contain'
      });
      store.commit('add-image', function (s) { s.addAsset(asset); s.addOp(op); });
      viewer.select(op.id);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function replaceImage(op, file) {
    try {
      var asset = await fileToAsset(file);
      store.commit('replace-image', function () {
        op.assetId = asset.id;
        op.dataUrl = null;
        op.mime = asset.mime;
        op.name = asset.name;
        op.fit = 'fill';
        store.addAsset(asset);
      });
      toast(t('msg.added'), 'ok');
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ================================================================== *
   * selection actions
   * ================================================================== */

  function currentOps() { return viewer.selection(); }

  function applyTransforms(list, label) {
    if (!list.length) return;
    store.commit(label || 'transform', function () {
      list.forEach(function (item) {
        if (item.x != null) item.op.x = item.x;
        if (item.y != null) item.op.y = item.y;
        if (item.w != null) item.op.w = Math.max(1, item.w);
        if (item.h != null) item.op.h = Math.max(1, item.h);
        if (item.op.type === 'text' && item.op.autoFit !== false) viewer.fitTextHeight(item.op);
      });
    });
    viewer.refreshOps();
    inspector.rebuild();
  }

  function pageBoxFor(pageId) {
    var info = viewer.pageInfo(pageId);
    return info ? { width: info.width, height: info.height } : null;
  }

  function doAlign(mode) {
    var ops = currentOps();
    if (!ops.length) return;
    applyTransforms(Arrange.align(ops, mode, pageBoxFor(ops[0].pageId)), 'align');
  }

  function doDistribute(axis) {
    var ops = currentOps();
    if (ops.length < 3) return;
    applyTransforms(Arrange.distribute(ops, axis), 'distribute');
  }

  function doStack(mode) {
    var ops = currentOps();
    if (!ops.length) return;
    var pageId = ops[0].pageId;
    var pageOps = store.opsForPage(pageId);
    var order = Arrange.restack(ops, pageOps, mode);
    store.commit('stack', function () {
      store.doc.ops = store.doc.ops.filter(function (o) { return o.pageId !== pageId; })
        .concat(order.map(function (item) { return item.op; }));
    });
    viewer.refreshOps(pageId);
    renderPanel();
  }

  function copySelection() {
    var ops = currentOps();
    if (!ops.length) return;
    clipboard = ops.map(function (o) {
      var c = JSON.parse(JSON.stringify(o));
      delete c.id;
      return c;
    });
    toast(t('msg.copied', { n: ops.length }), 'ok');
  }

  function pasteSelection() {
    if (!clipboard.length) { toast(t('msg.clipboardEmpty'), 'warn'); return; }
    var ops = currentOps();
    var base = ops[0];
    var pageId = base ? base.pageId : viewer.selectedPageId();
    if (!pageId) return;
    var dx = base ? 14 : 0, dy = base ? 14 : 0;
    var created = [];
    store.commit('paste', function (s) {
      clipboard.forEach(function (c) {
        var copy = JSON.parse(JSON.stringify(c));
        copy.id = Ops.uid('op');
        copy.pageId = pageId;
        copy.x = Ops.round(c.x + dx);
        copy.y = Ops.round(c.y + dy);
        s.addOp(copy);
        created.push(copy);
      });
    });
    viewer.selectIds(created.map(function (c) { return c.id; }));
  }

  function duplicateSelection() {
    var ops = currentOps();
    if (!ops.length) return;
    var pageId = ops[0].pageId;
    var created = [];
    store.commit('duplicate', function (s) {
      Arrange.cloneMany(ops, 14, 14).forEach(function (copy) {
        copy.id = Ops.uid('op');
        copy.pageId = pageId;
        s.addOp(copy);
        created.push(copy);
      });
    });
    viewer.selectIds(created.map(function (c) { return c.id; }));
    toast(t('msg.duplicated'), 'ok');
  }

  function deleteSelection(ops) {
    ops = ops || currentOps();
    if (!ops.length) return;
    var ids = ops.map(function (o) { return o.id; });
    store.commit('delete', function () { ids.forEach(function (id) { store.removeOp(id); }); });
    viewer.clearSelection();
    toast(t('msg.deleted', { n: ids.length }), 'ok');
  }

  function toggleLock() {
    var ops = currentOps();
    if (!ops.length) return;
    var target = !ops.every(function (o) { return o.locked; });
    store.commit('toggle-lock', function () { ops.forEach(function (o) { o.locked = target; }); });
    viewer.refreshOps();
    inspector.rebuild();
  }

  function selectAllOnPage() {
    var pageId = viewer.selectedPageId();
    if (!pageId) return;
    viewer.selectIds(store.opsForPage(pageId)
      .filter(function (o) { return !o.locked && o.visible !== false; })
      .map(function (o) { return o.id; }));
  }

  /* ================================================================== *
   * context menu
   * ================================================================== */

  function showContextMenu(x, y, hit, selection) {
    var ops = selection && selection.length ? selection : [];
    var items = [];
    if (ops.length === 1) {
      items.push({ header: t('ctx.object') });
      items.push({ label: t('edit.editText'), icon: 'text', disabled: ops[0].type !== 'text',
        action: function () { viewer.startEditing(ops[0].id); } });
      items.push({ label: t('edit.duplicate'), icon: 'duplicate', action: duplicateSelection });
      items.push({ label: t('edit.copy'), icon: 'copy', action: copySelection });
      items.push({ label: t('edit.paste'), icon: 'paste', action: pasteSelection, disabled: !clipboard.length });
      items.push('-');
      items.push({ label: ops[0].locked ? t('edit.unlock') : t('edit.lock'), icon: 'lock', action: toggleLock });
      items.push({ label: t('edit.delete'), icon: 'trash', action: function () { deleteSelection(ops); } });
      return dialogs.contextMenu(x, y, items);
    }
    if (ops.length > 1) {
      items.push({ header: t('selection.count', { n: ops.length }) });
      items.push({ label: t('arrange.front'), icon: 'front', action: function () { doStack('front'); } });
      items.push({ label: t('arrange.back'), icon: 'back', action: function () { doStack('back'); } });
      items.push('-');
      items.push({ label: t('edit.duplicate'), icon: 'duplicate', action: duplicateSelection });
      items.push({ label: t('edit.delete'), icon: 'trash', action: function () { deleteSelection(ops); } });
      return dialogs.contextMenu(x, y, items);
    }
    items.push({ header: t('ctx.page') });
    items.push({ label: t('ctx.addText'), icon: 'text', action: function () { setTool('text'); } });
    items.push({ label: t('ctx.addRedact'), icon: 'redact', action: function () { setTool('redact'); } });
    items.push({ label: t('ctx.addField'), icon: 'form-text', action: function () { setTool('form-text'); } });
    items.push('-');
    items.push({ label: t('ctx.paste'), icon: 'paste', action: pasteSelection, disabled: !clipboard.length });
    items.push({ label: t('ctx.selectAll'), icon: 'select-all', action: selectAllOnPage });
    void hit;
    dialogs.contextMenu(x, y, items);
  }

  /* ================================================================== *
   * model reactions
   * ================================================================== */

  function onStoreChange(reason, detail) {
    if (detail && detail.live) {
      var op = detail.op || viewer.selected();
      if (op) viewer.refreshOps(op.id);
      return;
    }
    afterModelChange(reason === 'document-loaded' || reason === 'open');
  }

  function afterModelChange(structural) {
    if (structural) viewer.build();
    else viewer.renderAll();
    viewer.refreshOps();
    renderPanel();
    updateStatus();
    scheduleAutosave();
  }

  function onViewerSelect(ops, primary, opts) {
    if (ops && ops.length) inspector.render(ops, primary);
    else {
      var pageId = viewer.selectedPageId();
      if (pageId) inspector.renderPage(pageId);
      else inspector.render(null);
    }
    if (currentPanel === 'layers' && !opts) renderPanel();
    updateStatus();
  }

  function onInspectorChange(detail) {
    var op = viewer.selected();
    if (detail && detail.live && op) { viewer.refreshOps(op.id); return; }
    if (op) viewer.refreshOps(op.id);
    if (detail && detail.rebuild) inspector.rebuild();
    renderPanel();
    scheduleAutosave();
  }

  function onInspectorAction(action, op, extra) {
    switch (action) {
      case 'delete': deleteSelection(op ? [op] : null); break;
      case 'duplicate': duplicateSelection(); break;
      case 'copy': copySelection(); break;
      case 'paste': pasteSelection(); break;
      case 'lock': toggleLock(); break;
      case 'align': doAlign(extra); break;
      case 'distribute': doDistribute(extra); break;
      case 'stack': doStack(extra); break;
      case 'replace-image': replaceImage(op, extra); break;
      case 'delete-page': deletePage(op); break;
      case 'duplicate-page': duplicatePage(op); break;
      case 'add-page-after': insertBlankAfter(op); break;
      case 'rotate-page': rotatePage(op, extra || 90); break;
      case 'flatten-page':
        store.commit('flatten', function () { op.flattened = !op.flattened; });
        toast(t('msg.flattened'), 'ok');
        break;
      case 'page-changed': viewer.build(); break;
      default: break;
    }
  }

  /* ================================================================== *
   * export
   * ================================================================== */

  function openExportDialog() {
    if (!source.bytes) { toast(t('msg.noDoc'), 'warn'); return; }
    var live = store.livePages().length;
    var name = (store.doc.source.name || 'document').replace(/\.pdf$/i, '');
    dialogs.open({
      title: t('export.title'),
      wide: true,
      okLabel: t('export.run'),
      html:
        '<h3>' + t('export.file') + '</h3>' +
        '<div class="field"><label>' + t('export.filename') + '</label>' +
        '<input id="ex-name" class="text-input" value="' + PM.Dialogs.escapeHtml(name + '-edited.pdf') + '"></div>' +
        '<h3>' + t('export.pages') + '</h3>' +
        '<div class="row">' +
        '<label class="check"><input type="radio" name="ex-range" value="all" checked><span>' +
        t('export.all') + ' (' + live + ')</span></label>' +
        '<label class="check"><input type="radio" name="ex-range" value="range"><span>' + t('export.range') + '</span></label>' +
        '</div>' +
        '<div class="row" id="ex-range-row" style="display:none">' +
        '<input id="ex-from" class="num" type="number" min="1" max="' + live + '" value="1" style="width:78px">' +
        '<span>–</span>' +
        '<input id="ex-to" class="num" type="number" min="1" max="' + live + '" value="' + live + '" style="width:78px">' +
        '</div>' +
        '<h3>' + t('export.options') + '</h3>' +
        '<div class="row"><label class="check"><input id="ex-form" type="checkbox"><span>' +
        t('export.flattenForm') + '</span></label></div>' +
        '<div class="row"><label class="check"><input id="ex-source" type="checkbox" checked><span>' +
        t('export.projectSource') + '</span></label></div>' +
        '<p class="note">' + t('export.note') + '</p>',
      ready: function (b) {
        $$('input[name=ex-range]', b).forEach(function (r) {
          r.addEventListener('change', function () {
            $('#ex-range-row', b).style.display = r.checked && r.value === 'range' ? 'flex' : 'none';
          });
        });
      },
      onOk: function (b) {
        var picked = $('input[name=ex-range]:checked', b);
        exportOptions.range = (picked && picked.value) || 'all';
        exportOptions.from = parseInt($('#ex-from', b).value, 10) || 1;
        exportOptions.to = parseInt($('#ex-to', b).value, 10) || live;
        exportOptions.flattenForm = $('#ex-form', b).checked;
        exportOptions.includeSource = $('#ex-source', b).checked;
        runExport($('#ex-name', b).value || (name + '-edited.pdf'));
      }
    });
  }

  function exporterCtx() {
    return Exporter.createCtx({
      PDFLib: root.PDFLib,
      fontkit: root.fontkit,
      getFontBytes: function (id) {
        var f = fonts.get(id);
        return Promise.resolve(f && f.bytes ? f.bytes : null);
      },
      getAsset: function (id) { return store.getAsset(id); },
      resolveFont: function (id) { return fonts.get(id); },
      metrics: function (id) { return fonts.metrics(id); },
      fontCss: function (id, op) { return fonts.css(id, { size: op.size }); },
      measureCanvas: function (op) {
        return function (s) { return fonts.measure(s, op.fontId, op.size || 12, op.letterSpacing || 0); };
      },
      textToImage: renderTextToImage,
      renderPage: function (spec) {
        return source.rasterise(spec.sourceIndex, {
          dpi: spec.dpi, mime: 'image/jpeg', redactions: spec.redactions
        });
      },
      flattenForm: exportOptions.flattenForm,
      dpr: 4,
      warn: function (m) { console.warn(m); }
    });
  }

  /**
   * Renders a text operation through the browser's own text engine so every
   * script is shaped correctly, then embeds the result as a high resolution
   * picture (plus an optional invisible text layer for search).
   */
  function renderTextToImage(spec) {
    var scale = spec.scale || 4;
    var widthPt = spec.width || 200;
    var lh = spec.lineHeight * spec.size;
    var lines = spec.lines || [];
    var canvas = el('canvas');
    canvas.width = Math.max(1, Math.ceil(widthPt * scale));
    canvas.height = Math.max(1, Math.ceil(lines.length * lh * scale));
    var ctx = canvas.getContext('2d');
    var rtl = spec.dir === 'rtl' || (spec.dir !== 'ltr' && Text.isRTL(lines.join(' ')));
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.font = fonts.css(spec.fontId, { size: spec.size * scale });
    if ('letterSpacing' in ctx) ctx.letterSpacing = (spec.letterSpacing || 0) * scale + 'px';
    ctx.fillStyle = spec.color || '#000';
    ctx.textBaseline = 'alphabetic';
    var m = spec.metrics || {};
    var ascent = (m.ascent == null ? Text.DEFAULT_ASCENT : m.ascent) * spec.size;
    var baseline0 = (lh - (ascent + (m.descent || Text.DEFAULT_DESCENT) * spec.size)) / 2 + ascent;
    var align = spec.align === 'center' ? 'center'
      : (spec.align === 'end' || (spec.align === 'start' && rtl)) ? 'end' : 'start';
    ctx.textAlign = align === 'center' ? 'center' : align === 'end' ? 'right' : 'left';
    var x = align === 'center' ? widthPt / 2 : align === 'end' ? widthPt : 0;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i]) ctx.fillText(lines[i], x * scale, (baseline0 + i * lh) * scale);
    }
    var dataUrl = canvas.toDataURL('image/png');
    return Promise.resolve({
      bytes: Exporter.base64ToBytes(dataUrl), mime: 'image/png',
      width: canvas.width, height: canvas.height, dataUrl: dataUrl
    });
  }

  async function runExport(fileName) {
    busy(true, t('status.exporting'));
    try {
      var doc = JSON.parse(JSON.stringify(store.doc));
      if (exportOptions.range === 'range') {
        var live = store.livePages();
        var from = Math.max(1, exportOptions.from), to = Math.min(live.length, exportOptions.to);
        var keep = new Set(live.slice(from - 1, to).map(function (p) { return p.id; }));
        doc.pages = doc.pages.filter(function (p) { return keep.has(p.id); });
        doc.ops = doc.ops.filter(function (o) { return keep.has(o.pageId); });
      }
      var result = await Exporter.apply(source.bytes, doc, exporterCtx());
      var blob = new Blob([result.bytes], { type: 'application/pdf' });
      downloadBlob(blob, /\.pdf$/i.test(fileName) ? fileName : fileName + '.pdf');
      toast(t('msg.exported', { size: (result.bytes.length / 1048576).toFixed(2) }), 'ok');
      if (result.warnings.length) {
        console.warn(result.warnings.join('\n'));
        toast(result.warnings.length + ' ' + t('status.warnings'), 'warn');
      }
    } catch (e) {
      console.error(e);
      toast(t('msg.exportFail') + ' — ' + e.message, 'error');
    } finally {
      busy(false);
    }
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = el('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function saveProject() {
    var data = store.toJSON();
    if (exportOptions.includeSource && sourceBytes) {
      try {
        var bin = '';
        var chunk = 0x8000;
        for (var i = 0; i < sourceBytes.length; i += chunk) {
          bin += String.fromCharCode.apply(null, sourceBytes.subarray(i, i + chunk));
        }
        data.sourceBytes = btoa(bin);
        data.sourceMime = 'application/pdf';
      } catch (e) { void e; }
    }
    downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }),
      (store.doc.source.name || 'project').replace(/\.pdf$/i, '') + '.pmproj.json');
    toast(t('msg.saved'), 'ok');
  }

  async function openProject(file) {
    busy(true, t('status.loading'));
    try {
      var data = JSON.parse(await file.text());
      if (!data || !data.pages) throw new Error(t('msg.badProject'));
      if (data.sourceBytes) {
        var bin = atob(data.sourceBytes);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await loadBytes(bytes, (data.source && data.source.name) || file.name, bytes.length);
      } else if (source.bytes && data.source && data.source.fingerprint === store.doc.source.fingerprint) {
        store.doc.source = data.source || store.doc.source;
      } else if (!source.bytes) {
        toast(t('msg.projectNeedSource'), 'warn');
        return;
      }
      (data.assets || []).forEach(function (a) { store.assets[a.id] = a; });
      store.loadJSON(data);
      viewer.build();
      viewer.fitWidth();
      renderPanel();
      indexAllPages();
      toast(t('msg.saved'), 'ok');
    } catch (e) {
      console.error(e);
      toast(e.message, 'error');
    } finally { busy(false); }
  }

  /* ================================================================== *
   * dialogs: properties, shortcuts
   * ================================================================== */

  function openProperties() {
    dialogs.open({
      title: t('props.title'),
      okLabel: t('msg.save'),
      html:
        '<div class="field"><label>' + t('props.title') + '</label><input id="p-title" class="text-input"></div>' +
        '<div class="field"><label>' + t('props.author') + '</label><input id="p-author" class="text-input"></div>' +
        '<div class="field"><label>' + t('props.subject') + '</label><input id="p-subject" class="text-input"></div>' +
        '<div class="field"><label>' + t('props.keywords') + '</label><input id="p-keywords" class="text-input"></div>' +
        '<p class="note">' + t('props.note') + '</p>',
      ready: function (b) {
        $('#p-title', b).value = store.doc.source.title || '';
        $('#p-author', b).value = store.doc.source.author || '';
        $('#p-subject', b).value = store.doc.source.subject || '';
        $('#p-keywords', b).value = store.doc.source.keywords || '';
      },
      onOk: function (b) {
        store.commit('properties', function () {
          store.doc.source.title = $('#p-title', b).value;
          store.doc.source.author = $('#p-author', b).value;
          store.doc.source.subject = $('#p-subject', b).value;
          store.doc.source.keywords = $('#p-keywords', b).value;
        });
        toast(t('msg.saved'), 'ok');
      }
    });
  }

  function openShortcuts() {
    var rows = [
      ['V T R O L I B', t('shortcuts.tools')],
      ['F C', t('shortcuts.forms')],
      ['Ctrl/⌘ Z · ⇧Z', t('undo') + ' · ' + t('redo')],
      ['Ctrl/⌘ X C V D A', t('shortcuts.clipboard')],
      ['Ctrl/⌘ ] [', t('shortcuts.zorder')],
      ['Ctrl/⌘ S · E · P', t('msg.save') + ' · ' + t('export.title') + ' · ' + t('print')],
      ['Delete', t('edit.delete')],
      ['← ↑ → ↓', t('shortcuts.nudge')],
      ['⇧ + arrows', t('shortcuts.nudge10')],
      ['Tab', t('shortcuts.cycle')],
      ['Space + drag', t('shortcuts.pan')],
      ['Ctrl/⌘ + wheel', t('status.zoom')],
      ['⇧ + click', t('shortcuts.multi')],
      ['Esc', t('close')]
    ];
    dialogs.open({
      title: t('shortcuts.title'),
      hideOk: true,
      cancelLabel: t('close'),
      html: '<div class="list">' + rows.map(function (r) {
        return '<div class="list-row"><span class="kbd">' + PM.Dialogs.escapeHtml(r[0]) +
          '</span><span class="list-text">' + r[1] + '</span></div>';
      }).join('') + '</div>'
    });
  }

  /* ================================================================== *
   * splitters, dropzone, shortcuts, status
   * ================================================================== */

  function bindSplitters() {
    $$('.splitter').forEach(function (sp) {
      sp.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        sp.classList.add('active');
        sp.setPointerCapture(ev.pointerId);
        var which = sp.dataset.split;
        var sidebar = which === 'left' ? $('#sidebar-left') : $('#sidebar-right');
        var startX = ev.clientX;
        var startW = sidebar.getBoundingClientRect().width;
        function move(e) {
          var delta = e.clientX - startX;
          var w = Math.max(190, Math.min(520, which === 'left' ? startW + delta : startW - delta));
          document.documentElement.style.setProperty(which === 'left' ? '--panel-w' : '--inspector-w', w + 'px');
        }
        function up(e) {
          sp.classList.remove('active');
          sp.removeEventListener('pointermove', move);
          sp.removeEventListener('pointerup', up);
          try { sp.releasePointerCapture(e.pointerId); } catch (err) { void err; }
          viewer.renderAll();
        }
        sp.addEventListener('pointermove', move);
        sp.addEventListener('pointerup', up);
      });
    });
  }

  function bindDropzone() {
    ['dragenter', 'dragover'].forEach(function (type) {
      document.addEventListener(type, function (ev) {
        ev.preventDefault();
        els.dropzone.classList.remove('hidden');
        els.dropzone.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      document.addEventListener(type, function (ev) {
        ev.preventDefault();
        if (type === 'dragleave' && ev.relatedTarget) return;
        els.dropzone.classList.remove('over');
        if (source.bytes) els.dropzone.classList.add('hidden');
      });
    });
    document.addEventListener('drop', function (ev) {
      ev.preventDefault();
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) openFile(f);
    });
    els.dropzone.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-action]')) return;
      els.fileInput.click();
    });
  }

  function bindShortcuts() {
    document.addEventListener('keydown', function (ev) {
      var tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || ev.target.isContentEditable) return;
      var mod = ev.ctrlKey || ev.metaKey;
      var key = ev.key;
      var lower = key.toLowerCase();

      if (key === ' ' && !viewer.isToolDraw()) { viewer.setSpace(true); ev.preventDefault(); return; }
      if (mod && lower === 'z') { ev.preventDefault(); if (ev.shiftKey) { if (store.redo()) afterModelChange(); } else if (store.undo()) afterModelChange(); return; }
      if (mod && lower === 'y') { ev.preventDefault(); if (store.redo()) afterModelChange(); return; }
      if (mod && lower === 's') { ev.preventDefault(); saveProject(); return; }
      if (mod && lower === 'e') { ev.preventDefault(); openExportDialog(); return; }
      if (mod && lower === 'p') { ev.preventDefault(); printDocument(); return; }
      if (mod && lower === 'a') { ev.preventDefault(); selectAllOnPage(); return; }
      if (mod && lower === 'c') { ev.preventDefault(); copySelection(); return; }
      if (mod && lower === 'x') { ev.preventDefault(); copySelection(); deleteSelection(); return; }
      if (mod && lower === 'v') { ev.preventDefault(); pasteSelection(); return; }
      if (mod && lower === 'd') { ev.preventDefault(); duplicateSelection(); return; }
      if (mod && (key === ']' || key === '}')) { ev.preventDefault(); doStack(ev.shiftKey ? 'front' : 'forward'); return; }
      if (mod && (key === '[' || key === '{')) { ev.preventDefault(); doStack(ev.shiftKey ? 'back' : 'backward'); return; }

      if (key === 'Delete' || key === 'Backspace') {
        if (currentOps().length) { ev.preventDefault(); deleteSelection(); }
        return;
      }
      if (key === 'Escape') {
        if (dialogs.isOpen) dialogs.close();
        else if (viewer.isToolDraw()) setTool('select');
        else viewer.clearSelection();
        return;
      }
      if (key === 'Tab' && currentOps().length) {
        ev.preventDefault();
        var ops = store.opsForPage(viewer.selectedPageId() || '');
        if (ops.length) {
          var ids = ops.map(function (o) { return o.id; });
          var i = ids.indexOf(viewer.selectionIds()[0]);
          viewer.select(ids[(i + (ev.shiftKey ? -1 : 1) + ops.length) % ops.length]);
        }
        return;
      }
      if (key.indexOf('Arrow') === 0) {
        var sel = currentOps().filter(function (o) { return !o.locked; });
        if (!sel.length) return;
        ev.preventDefault();
        var d = ev.shiftKey ? 10 : 1;
        var dx = key === 'ArrowLeft' ? -d : key === 'ArrowRight' ? d : 0;
        var dy = key === 'ArrowUp' ? -d : key === 'ArrowDown' ? d : 0;
        store.beginGesture('nudge');
        sel.forEach(function (o) {
          o.x = Ops.round(o.x + dx);
          o.y = Ops.round(o.y + dy);
        });
        viewer.refreshOps();
        store.endGesture();
        inspector.rebuild();
        return;
      }

      var tools = { v: 'select', t: 'text', r: 'rect', o: 'ellipse', l: 'line', i: 'image', b: 'redact',
        f: 'form-text', c: 'checkbox' };
      if (!mod && tools[lower]) { setTool(tools[lower]); return; }
      if (!mod && (key === '+' || key === '=')) { viewer.zoomIn(); return; }
      if (!mod && key === '-') { viewer.zoomOut(); return; }
      if (!mod && key === '0') { viewer.fitWidth(); return; }
    });
    document.addEventListener('keyup', function (ev) {
      if (ev.key === ' ') viewer.setSpace(false);
    });
  }

  function scheduleAutosave() { autosave(); }

  function autosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () {
      try {
        var data = store.toJSON();
        if (data.assets && data.assets.length > 12) data.assets = [];
        var json = JSON.stringify(data);
        if (json.length < 4 * 1024 * 1024) localStorage.setItem('htmlpdf.autosave', json);
        else localStorage.removeItem('htmlpdf.autosave');
        els.statusSaved.textContent = t('status.saved') + ' ' + new Date().toLocaleTimeString();
      } catch (e) { void e; }
    }, 1200);
  }

  function updateStatus() {
    if (!els.statusState) return;
    var has = !!source.bytes;
    els.statusState.textContent = has ? t('status.ready') : t('msg.noDoc');
    var pageId = viewer.selectedPageId();
    var pageNo = pageId ? store.pageIndex(pageId) : -1;
    els.statusPage.textContent = has
      ? t('status.page') + ' ' + (pageNo >= 0 ? pageNo + 1 : '-') + ' / ' + store.livePages().length
      : '';
    var sel = viewer.selection();
    els.statusSelection.textContent = sel.length === 1
      ? t('prop.' + sel[0].type) + ' · ' + units.format(sel[0].w) + ' × ' + units.format(sel[0].h)
      : sel.length > 1 ? t('selection.count', { n: sel.length }) : '';
    var z = Math.round(viewer.zoom() * 100) + '%';
    els.statusZoom.textContent = z;
    if (els.zoomLabel) els.zoomLabel.textContent = z;
    if (els.zoomSlider && document.activeElement !== els.zoomSlider) els.zoomSlider.value = z;
    $$('[data-action="undo"]').forEach(function (b) { b.disabled = !store.canUndo(); });
    $$('[data-action="redo"]').forEach(function (b) { b.disabled = !store.canRedo(); });
    viewer.highlightCurrent();
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ================================================================== */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  root.PMApp = {
    store: function () { return store; },
    viewer: function () { return viewer; },
    inspector: function () { return inspector; },
    dialogs: function () { return dialogs; },
    exportNow: runExport
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
