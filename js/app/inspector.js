/*!
 * app/inspector.js — property panel.  Renders the shared properties of a
 * multi-selection, the arrange tools, and the type-specific properties of the
 * primary object.
 */
(function (root) {
  'use strict';
  var PM = (root.PM = root.PM || {});
  var Ops = PM.Ops;
  var Icons = PM.Icons;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function create(opts) {
    var rootEl = opts.root;
    var store = opts.store;
    var fonts = opts.fonts;
    var units = opts.units;
    var t = opts.t;
    var onChange = opts.onChange || function () { };
    var onAction = opts.onAction || function () { };

    var current = { ops: [], primary: null };

    /* ---------------------------- builders --------------------------- */

    function field(label, control, cls) {
      var row = el('div', 'field' + (cls ? ' ' + cls : ''));
      if (label) {
        var lab = el('label', 'field-label', label);
        row.appendChild(lab);
        var box = el('div', 'field-control');
        box.appendChild(control);
        row.appendChild(box);
      } else {
        var box2 = el('div', 'field-control');
        box2.style.gridColumn = '1 / -1';
        box2.appendChild(control);
        row.appendChild(box2);
      }
      return row;
    }

    function numberInput(value, o) {
      o = o || {};
      var input = el('input', 'num');
      input.type = 'number';
      if (o.step) input.step = o.step;
      if (o.min != null) input.min = o.min;
      if (o.max != null) input.max = o.max;
      input.value = value == null ? '' : value;
      return input;
    }

    /** Value is expressed in the user's unit, stored in points. */
    function unitNumber(pointValue, o) {
      var input = numberInput(units.to(pointValue), o);
      input.dataset.unit = '1';
      return input;
    }

    function bindNumber(input, obj, key, o) {
      o = o || {};
      var factor = o.unit ? 1 / units.unit().factor : 1;
      var original = obj[key];
      input.addEventListener('focus', function () {
        original = obj[key];
        store.beginGesture(o.label || 'change-property');
      });
      input.addEventListener('input', function () {
        var v = parseFloat(input.value);
        if (isNaN(v)) return;
        v *= factor;
        if (o.min != null) v = Math.max(o.min, v);
        if (o.max != null) v = Math.min(o.max, v);
        obj[key] = o.round ? Ops.round(v) : v;
        onChange({ live: true, key: key });
      });
      input.addEventListener('change', function () {
        if (obj[key] === original) { store.endGesture(); input.blur(); return; }
        var value = obj[key];
        obj[key] = original;
        store.commit(o.label || 'change-property', function () { obj[key] = value; });
        onChange({ rebuild: true });
        input.blur();
      });
      return input;
    }

    function colorInput(value, obj, key) {
      var wrap = el('div', 'color-wrap');
      var input = el('input', 'color');
      input.type = 'color';
      input.value = value || '#000000';
      var none = el('button', 'btn-sm', '—');
      none.type = 'button';
      none.title = t('cover.none');
      var original = obj[key];
      input.addEventListener('focus', function () { original = obj[key]; store.beginGesture('change-colour'); });
      input.addEventListener('input', function () { obj[key] = input.value; onChange({ live: true, key: key }); });
      input.addEventListener('change', function () {
        if (obj[key] === original) { store.endGesture(); input.blur(); return; }
        var value = obj[key];
        obj[key] = original;
        store.commit('change-colour', function () { obj[key] = value; });
        onChange({ rebuild: true });
        input.blur();
      });
      none.addEventListener('click', function () {
        store.commit('clear-colour', function () { obj[key] = null; });
        onChange({ rebuild: true });
      });
      wrap.appendChild(input);
      wrap.appendChild(none);
      return wrap;
    }

    function selectInput(options, value, onPick) {
      var s = el('select');
      options.forEach(function (o) {
        var opt = el('option', null, o.label);
        opt.value = o.value;
        if (String(o.value) === String(value)) opt.selected = true;
        s.appendChild(opt);
      });
      s.addEventListener('change', function () { onPick(s.value); });
      return s;
    }

    function segmented(options, value, onPick) {
      var wrap = el('div', 'segmented');
      options.forEach(function (o) {
        var b = el('button', 'seg' + (String(o.value) === String(value) ? ' active' : ''));
        b.type = 'button';
        b.title = o.title || o.label;
        if (o.icon) b.innerHTML = Icons.use(o.icon);
        else b.textContent = o.label;
        if (!o.icon) b.setAttribute('aria-label', o.label);
        b.addEventListener('click', function () { onPick(o.value); });
        wrap.appendChild(b);
      });
      return wrap;
    }

    function iconGrid(items) {
      var wrap = el('div', 'icon-grid');
      items.forEach(function (item) {
        var b = Icons.button(item.icon, {
          title: item.title,
          label: item.title,
          className: 'btn-sm icon' + (item.disabled ? ' disabled' : '')
        });
        b.disabled = !!item.disabled;
        b.addEventListener('click', function () { item.action(); });
        wrap.appendChild(b);
      });
      return wrap;
    }

    function callout(icon, text) {
      var box = el('div', 'callout');
      box.innerHTML = Icons.use(icon);
      box.appendChild(el('span', null, text));
      return box;
    }

    function checkbox(label, value, onPick) {
      var wrap = el('label', 'check');
      var input = el('input');
      input.type = 'checkbox';
      input.checked = !!value;
      input.addEventListener('change', function () { onPick(input.checked); });
      wrap.appendChild(input);
      wrap.appendChild(el('span', null, label));
      return wrap;
    }

    function section(title, icon) {
      var s = el('section', 'insp-section');
      var h = el('h3');
      if (icon) h.innerHTML = Icons.use(icon);
      h.appendChild(el('span', null, title));
      s.appendChild(h);
      return s;
    }

    function commit(label, fn) {
      store.commit(label, fn);
      onChange({ rebuild: true });
    }

    /* ------------------------------ render --------------------------- */

    function render(ops, primary) {
      current = { ops: ops || [], primary: primary || (ops && ops[0]) || null };
      rootEl.innerHTML = '';
      var list = current.ops;
      if (!list.length) {
        rootEl.appendChild(el('div', 'insp-empty', t('prop.none')));
        return;
      }
      if (list.length > 1) {
        rootEl.appendChild(selectionSection(list));
        return;
      }
      var op = list[0];
      rootEl.appendChild(geometrySection(op));
      if (op.type === 'text') rootEl.appendChild(textSection(op));
      else if (op.type === 'image') rootEl.appendChild(imageSection(op));
      else if (op.type === 'field') rootEl.appendChild(fieldSection(op));
      else if (op.type === 'shape') rootEl.appendChild(shapeSection(op));
      rootEl.appendChild(commonSection(op));
    }

    function selectionSection(list) {
      var s = section(t('selection.count', { n: list.length }), 'select-all');
      s.appendChild(el('div', 'hint', t('selection.hint')));
      s.appendChild(field('', iconGrid([
        { icon: 'align-left', title: t('arrange.left'), action: function () { onAction('align', 'left'); } },
        { icon: 'align-center-h', title: t('arrange.centerH'), action: function () { onAction('align', 'center-h'); } },
        { icon: 'align-right', title: t('arrange.right'), action: function () { onAction('align', 'right'); } },
        { icon: 'align-top', title: t('arrange.top'), action: function () { onAction('align', 'top'); } },
        { icon: 'align-middle', title: t('arrange.middle'), action: function () { onAction('align', 'middle'); } },
        { icon: 'align-bottom', title: t('arrange.bottom'), action: function () { onAction('align', 'bottom'); } },
        { icon: 'distribute-h', title: t('arrange.distributeH'), disabled: list.length < 3, action: function () { onAction('distribute', 'h'); } },
        { icon: 'distribute-v', title: t('arrange.distributeV'), disabled: list.length < 3, action: function () { onAction('distribute', 'v'); } },
        { icon: 'front', title: t('arrange.front'), action: function () { onAction('stack', 'front'); } }
      ]), 'wide'));
      s.appendChild(field('', iconGrid([
        { icon: 'forward', title: t('arrange.forward'), action: function () { onAction('stack', 'forward'); } },
        { icon: 'backward', title: t('arrange.backward'), action: function () { onAction('stack', 'backward'); } },
        { icon: 'back', title: t('arrange.back'), action: function () { onAction('stack', 'back'); } },
        { icon: 'copy', title: t('edit.copy'), action: function () { onAction('copy'); } },
        { icon: 'paste', title: t('edit.paste'), action: function () { onAction('paste'); } },
        { icon: 'duplicate', title: t('edit.duplicate'), action: function () { onAction('duplicate'); } },
        { icon: 'group', title: t('edit.group'), disabled: true, action: function () { } },
        { icon: 'trash', title: t('edit.delete'), action: function () { onAction('delete'); } },
        { icon: 'lock', title: t('layers.locked'), action: function () { onAction('lock'); } }
      ]), 'wide'));
      return s;
    }

    function geometrySection(op) {
      var s = section(t('prop.geometry'), 'settings');
      var grid = el('div', 'grid2');
      var x = bindNumber(unitNumber(op.x, { step: 0.5 }), op, 'x', { unit: true, label: 'move' });
      var y = bindNumber(unitNumber(op.y, { step: 0.5 }), op, 'y', { unit: true, label: 'move' });
      var w = bindNumber(unitNumber(op.w, { step: 0.5, min: 1 }), op, 'w', { unit: true, label: 'resize' });
      var h = bindNumber(unitNumber(op.h, { step: 0.5, min: 1 }), op, 'h', { unit: true, label: 'resize' });
      grid.appendChild(field('X', x));
      grid.appendChild(field('Y', y));
      grid.appendChild(field('W', w));
      grid.appendChild(field('H', h));
      s.appendChild(grid);
      s.appendChild(field(t('prop.size'), selectInput([
        { value: '', label: t('prop.sizeAuto') },
        { value: 'h', label: t('prop.sizeByHeight') }
      ], op.sizeMode || '', function (v) {
        commit('size-mode', function () { op.sizeMode = v || null; });
      })));
      return s;
    }

    function commonSection(op) {
      var s = section(t('prop.rotation'), 'rotate-right');
      var grid = el('div', 'grid2');
      var rot = bindNumber(numberInput(op.rotate, { step: 1 }), op, 'rotate', { label: 'rotate' });
      grid.appendChild(field(t('prop.rotation'), rot));
      var proxy = { get p() { return op.opacity * 100; }, set p(v) { op.opacity = v / 100; } };
      var opac = bindNumber(numberInput(Math.round((op.opacity == null ? 1 : op.opacity) * 100), { step: 1, min: 0, max: 100 }),
        proxy, 'p', { label: 'opacity' });
      opac.addEventListener('input', function () { onChange({ live: true }); });
      grid.appendChild(field(t('prop.opacity') + ' %', opac));
      s.appendChild(grid);

      s.appendChild(field('', iconGrid([
        { icon: 'copy', title: t('edit.copy'), action: function () { onAction('copy', op); } },
        { icon: 'paste', title: t('edit.paste'), action: function () { onAction('paste', op); } },
        { icon: 'duplicate', title: t('edit.duplicate'), action: function () { onAction('duplicate', op); } },
        { icon: 'front', title: t('arrange.front'), action: function () { onAction('stack', 'front', op); } },
        { icon: 'forward', title: t('arrange.forward'), action: function () { onAction('stack', 'forward', op); } },
        { icon: 'backward', title: t('arrange.backward'), action: function () { onAction('stack', 'backward', op); } },
        { icon: 'back', title: t('arrange.back'), action: function () { onAction('stack', 'back', op); } },
        { icon: op.locked ? 'unlock' : 'lock', title: t('layers.locked'), action: function () { onAction('lock', op); } },
        { icon: 'trash', title: t('edit.delete'), action: function () { onAction('delete', op); } }
      ]), 'wide'));
      return s;
    }

    function textSection(op) {
      var s = section(t('prop.text'), 'text');
      var ta = el('textarea', 'text-area');
      ta.value = op.text || '';
      ta.rows = 4;
      ta.dir = (op.dir === 'rtl' || (op.dir !== 'ltr' && PM.Text.isRTL(op.text || ''))) ? 'rtl' : 'ltr';
      ta.addEventListener('focus', function () { store.beginGesture('edit-text'); });
      ta.addEventListener('input', function () { op.text = ta.value; onChange({ live: true, text: true }); });
      ta.addEventListener('change', function () {
        if (editing(ta, op)) return;
        store.endGesture();
      });
      function editing(input, o) {
        var value = input.value;
        if (value === o.text) { return true; }
        return false;
      }
      s.appendChild(field(t('prop.text'), ta));

      var analysis = PM.Text.analyse(op.text || '');
      s.appendChild(el('div', 'hint', analysis.script + ' · ' + (analysis.rtl ? t('dir.rtl') : t('dir.ltr')) +
        (PM.Text.needsShaping(op.text || '') ? ' · ' + t('render.shape') : ' · ' + t('render.vector'))));

      var fontOpts = fonts.list().map(function (f) {
        return { value: f.id, label: f.label + (f.kind === 'builtin' ? ' (PDF)' : f.kind === 'file' ? ' ✓' : '') };
      });
      s.appendChild(field(t('prop.font'), selectInput(fontOpts, op.fontId, function (v) {
        commit('change-font', function () { op.fontId = v; });
      })));

      var grid = el('div', 'grid2');
      var size = bindNumber(numberInput(op.size, { step: 0.5, min: 1 }), op, 'size', { label: 'font-size' });
      grid.appendChild(field(t('prop.fontSize'), size));
      var lh = bindNumber(numberInput(op.lineHeight, { step: 0.05, min: 0.5 }), op, 'lineHeight', { label: 'line-height' });
      grid.appendChild(field(t('prop.lineHeight'), lh));
      var ls = bindNumber(numberInput(op.letterSpacing || 0, { step: 0.1 }), op, 'letterSpacing', { label: 'letter-spacing' });
      grid.appendChild(field(t('prop.letterSpacing'), ls));
      s.appendChild(grid);

      s.appendChild(field(t('prop.color'), colorInput(op.color, op, 'color')));
      s.appendChild(field(t('prop.align'), segmented([
        { value: 'start', label: t('align.left') },
        { value: 'center', label: t('align.center') },
        { value: 'end', label: t('align.right') }
      ], op.align, function (v) { commit('align', function () { op.align = v; }); })));
      s.appendChild(field(t('prop.valign'), segmented([
        { value: 'top', label: t('valign.top') },
        { value: 'middle', label: t('valign.middle') },
        { value: 'bottom', label: t('valign.bottom') }
      ], op.valign || 'top', function (v) { commit('valign', function () { op.valign = v; }); })));
      s.appendChild(field(t('prop.direction'), segmented([
        { value: 'auto', label: t('dir.auto') },
        { value: 'ltr', label: t('dir.ltr') },
        { value: 'rtl', label: t('dir.rtl') }
      ], op.dir || 'auto', function (v) { commit('direction', function () { op.dir = v; }); })));
      s.appendChild(field(t('prop.render'), segmented([
        { value: 'auto', label: t('render.auto') },
        { value: 'vector', label: t('render.vector') },
        { value: 'shape', label: t('render.shape') }
      ], op.render || 'auto', function (v) { commit('render-mode', function () { op.render = v; }); })));
      s.appendChild(field('', checkbox(t('prop.searchText'), op.searchLayer, function (v) {
        commit('search-layer', function () { op.searchLayer = v; });
      })));

      var coverSec = section(t('prop.cover'), 'redact');
      coverSec.appendChild(field('', checkbox(t('prop.cover'), op.cover !== false, function (v) {
        commit('cover', function () { op.cover = v; });
      })));
      coverSec.appendChild(field(t('prop.coverColor'), colorInput(op.coverColor || '#ffffff', op, 'coverColor')));
      var pad = bindNumber(numberInput(op.coverPadding == null ? 1 : op.coverPadding, { step: 0.5, min: 0 }),
        op, 'coverPadding', { label: 'cover-padding' });
      coverSec.appendChild(field(t('prop.coverPad'), pad));
      coverSec.appendChild(field(t('prop.coverMode'), selectInput([
        { value: 'auto', label: t('cover.auto') },
        { value: 'box', label: t('cover.box') },
        { value: 'source', label: t('cover.original') },
        { value: 'none', label: t('cover.none') }
      ], op.coverMode || 'auto', function (v) { commit('cover-mode', function () { op.coverMode = v; }); })));
      s.appendChild(coverSec);
      return s;
    }

    function imageSection(op) {
      var s = section(t('prop.image'), 'image');
      var file = el('input');
      file.type = 'file';
      file.accept = 'image/*';
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (f) onAction('replace-image', op, f);
      });
      var btn = el('button', 'btn-sm', t('edit.replaceImage'));
      btn.type = 'button';
      btn.addEventListener('click', function () { file.click(); });
      s.appendChild(field(t('prop.image'), btn));
      s.appendChild(field(t('prop.fit'), segmented([
        { value: 'contain', label: t('fit.contain') },
        { value: 'cover', label: t('fit.cover') },
        { value: 'stretch', label: t('fit.stretch') }
      ], op.fit || 'contain', function (v) { commit('image-fit', function () { op.fit = v; }); })));
      s.appendChild(field(t('prop.blend'), selectInput([
        { value: '', label: t('blend.normal') },
        { value: 'Multiply', label: t('blend.multiply') },
        { value: 'Screen', label: t('blend.screen') },
        { value: 'Darken', label: t('blend.darken') },
        { value: 'Lighten', label: t('blend.lighten') }
      ], op.blendMode || '', function (v) { commit('blend', function () { op.blendMode = v || null; }); })));
      return s;
    }

    function fieldSection(op) {
      var f = op.field || (op.field = {});
      var s = section(t('prop.field'), 'form-text');
      s.appendChild(field(t('prop.fieldKind'), selectInput([
        { value: 'text', label: t('tool.formText') },
        { value: 'checkbox', label: t('tool.checkbox') },
        { value: 'radio', label: t('tool.radio') },
        { value: 'dropdown', label: t('tool.dropdown') }
      ], f.kind, function (v) { commit('field-kind', function () { f.kind = v; }); })));
      var name = el('input', 'text-input');
      name.type = 'text';
      name.value = f.name || '';
      name.addEventListener('focus', function () { store.beginGesture('field-name'); });
      name.addEventListener('input', function () { f.name = name.value; });
      name.addEventListener('change', function () {
        var v = f.name; f.name = '';
        store.commit('field-name', function () { f.name = v; });
        onChange({ rebuild: true });
      });
      s.appendChild(field(t('prop.fieldName'), name));

      if (f.kind === 'checkbox' || f.kind === 'radio') {
        s.appendChild(field('', checkbox(t('prop.fieldChecked'), f.value, function (v) {
          commit('field-checked', function () { f.value = v; });
        })));
      } else {
        var value = el('input', 'text-input');
        value.type = 'text';
        value.value = f.value == null ? '' : f.value;
        value.dir = 'auto';
        value.addEventListener('focus', function () { store.beginGesture('field-value'); });
        value.addEventListener('input', function () { f.value = value.value; onChange({ live: true, text: true }); });
        value.addEventListener('change', function () {
          var v = f.value; f.value = '';
          store.commit('field-value', function () { f.value = v; });
        });
        s.appendChild(field(t('prop.fieldValue'), value));
      }

      if (f.kind === 'dropdown') {
        var opts = el('input', 'text-input');
        opts.value = (f.options || []).join(', ');
        opts.addEventListener('focus', function () { store.beginGesture('field-options'); });
        opts.addEventListener('change', function () {
          var list = opts.value.split(',').map(function (v) { return v.trim(); }).filter(Boolean);
          store.commit('field-options', function () { f.options = list; });
          onChange({ rebuild: true });
        });
        s.appendChild(field(t('prop.fieldOptions'), opts));
      }

      if (f.kind === 'text') {
        var grid = el('div', 'grid2');
        var fs = bindNumber(numberInput(f.fontSize || 10, { step: 0.5, min: 4 }), f, 'fontSize', { label: 'font-size' });
        grid.appendChild(field(t('prop.fontSize'), fs));
        s.appendChild(grid);
        s.appendChild(field('', checkbox(t('prop.fieldMultiline'), f.multiline, function (v) {
          commit('field-multiline', function () { f.multiline = v; });
        })));
        var fontOpts = fonts.list().map(function (x) { return { value: x.id, label: x.label }; });
        s.appendChild(field(t('prop.font'), selectInput(fontOpts, op.fontId, function (v) {
          commit('change-font', function () { op.fontId = v; });
        })));
      }
      s.appendChild(field('', checkbox(t('prop.fieldReadOnly'), f.readOnly, function (v) {
        commit('field-readonly', function () { f.readOnly = v; });
      })));
      s.appendChild(field(t('prop.fieldBorder'), colorInput(f.borderColor || '#9aa4b2', f, 'borderColor')));
      s.appendChild(field(t('prop.fieldBg'), colorInput(f.backgroundColor || '#ffffff', f, 'backgroundColor')));
      s.appendChild(callout('info', t('form.note')));
      return s;
    }

    function shapeSection(op) {
      var s = section(t('prop.shape'), op.redaction ? 'redact' : 'rect');
      s.appendChild(field(t('prop.shape'), segmented([
        { value: 'rect', label: t('tool.rect') },
        { value: 'ellipse', label: t('tool.ellipse') },
        { value: 'line', label: t('tool.line') }
      ], op.shape, function (v) { commit('shape', function () { op.shape = v; }); })));
      s.appendChild(field(t('prop.fill'), colorInput(op.fill, op, 'fill')));
      if (op.shape !== 'line') {
        var fo = bindNumber(numberInput(Math.round((op.fillOpacity == null ? 1 : op.fillOpacity) * 100), { min: 0, max: 100 }),
          { get p() { return op.fillOpacity * 100; }, set p(v) { op.fillOpacity = v / 100; } }, 'p', { label: 'fill-opacity' });
        fo.addEventListener('input', function () { onChange({ live: true }); });
        s.appendChild(field(t('prop.opacity') + ' %', fo));
        var r = bindNumber(numberInput(op.radius || 0, { step: 1, min: 0 }), op, 'radius', { label: 'radius' });
        s.appendChild(field(t('prop.radius'), r));
      }
      s.appendChild(field(t('prop.stroke'), colorInput(op.stroke, op, 'stroke')));
      var sw = bindNumber(numberInput(op.strokeWidth || 1, { step: 0.5, min: 0 }), op, 'strokeWidth', { label: 'stroke-width' });
      s.appendChild(field(t('prop.strokeWidth'), sw));
      s.appendChild(field(t('prop.blend'), selectInput([
        { value: '', label: t('blend.normal') },
        { value: 'Multiply', label: t('blend.multiply') },
        { value: 'Screen', label: t('blend.screen') },
        { value: 'Darken', label: t('blend.darken') },
        { value: 'Lighten', label: t('blend.lighten') }
      ], op.blendMode || '', function (v) { commit('blend', function () { op.blendMode = v || null; }); })));
      if (op.redaction) s.appendChild(callout('warn', t('redact.note')));
      return s;
    }

    /* ------------------------------ page ----------------------------- */

    function renderPage(pageId) {
      current = { ops: [], primary: null };
      rootEl.innerHTML = '';
      var p = store.getPage(pageId);
      if (!p) { rootEl.appendChild(el('div', 'insp-empty', t('prop.none'))); return; }
      var info = opts.viewer ? opts.viewer.pageInfo(pageId) : null;
      var s = section(t('status.page') + ' ' + (store.pageIndex(pageId) + 1), 'pages');
      if (info) {
        s.appendChild(el('div', 'hint', units.format(info.width) + ' × ' + units.format(info.height) +
          ' · ' + t('status.rotation') + ' ' + (p.rotation || 0) + '°'));
      }
      var rot = bindNumber(numberInput(p.rotation, { step: 90 }), p, 'rotation', { label: 'rotate-page' });
      s.appendChild(field(t('pages.rotateR'), rot));
      s.appendChild(field(t('pages.size'), selectInput([
        { value: 'keep', label: t('pages.keep') },
        { value: 'a3', label: t('size.a3') },
        { value: 'a4', label: t('size.a4') },
        { value: 'a5', label: t('size.a5') },
        { value: 'letter', label: t('size.letter') },
        { value: 'legal', label: t('size.legal') },
        { value: 'tabloid', label: t('size.tabloid') }
      ], p.sizeMode || 'keep', function (v) {
        commit('page-size', function () { p.sizeMode = v; });
        onAction('page-changed', p);
      })));
      s.appendChild(field(t('pages.background'), colorInput(p.background || '#ffffff', p, 'background')));
      s.appendChild(field('', checkbox(t('pages.flatten'), p.flattened, function (v) {
        commit('flatten', function () { p.flattened = v; });
      })));
      if (p.flattened) {
        var dpi = bindNumber(numberInput(p.flattenDpi || 150, { step: 10, min: 60, max: 600 }), p, 'flattenDpi', { label: 'flatten-dpi' });
        s.appendChild(field('DPI', dpi));
      }
      s.appendChild(field('', iconGrid([
        { icon: 'rotate-left', title: t('pages.rotateL'), action: function () { onAction('rotate-page', p, -90); } },
        { icon: 'rotate-right', title: t('pages.rotateR'), action: function () { onAction('rotate-page', p, 90); } },
        { icon: 'duplicate', title: t('pages.duplicate'), action: function () { onAction('duplicate-page', p); } },
        { icon: 'flatten', title: t('pages.flatten'), action: function () { onAction('flatten-page', p); } },
        { icon: 'plus', title: t('pages.add'), action: function () { onAction('add-page-after', p); } },
        { icon: 'trash', title: t('pages.delete'), action: function () { onAction('delete-page', p); } }
      ]), 'wide'));
      rootEl.appendChild(s);
    }

    return {
      render: render,
      renderPage: renderPage,
      rebuild: function () { render(current.ops, current.primary); },
      current: function () { return current; }
    };
  }

  PM.Inspector = { create: create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
