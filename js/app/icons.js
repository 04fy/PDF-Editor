/*!
 * app/icons.js — small helper around the inline SVG sprite in index.html.
 */
(function (root) {
  'use strict';
  var PM = (root.PM = root.PM || {});

  function use(name, cls) {
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' +
      '<use href="#i-' + name + '"/></svg>';
  }

  /** Replaces the content of an element with an icon. */
  function set(node, name, cls) {
    if (!node) return node;
    node.innerHTML = use(name, cls);
    return node;
  }

  /** <button class="btn icon" title="…"><svg…></button> */
  function button(name, opts) {
    opts = opts || {};
    var b = document.createElement('button');
    b.type = 'button';
    b.className = opts.className || 'btn-sm icon';
    if (opts.title) b.title = opts.title;
    if (opts.label) b.setAttribute('aria-label', opts.label);
    b.dataset.icon = name;
    if (opts.action) b.dataset.action = opts.action;
    b.innerHTML = use(name, opts.iconClass);
    return b;
  }

  PM.Icons = { use: use, set: set, button: button, names: [
    'open', 'save', 'export', 'undo', 'redo', 'zoom-in', 'zoom-out', 'fit-width', 'fit-page',
    'cursor', 'text', 'rect', 'ellipse', 'line', 'image', 'redact', 'form-text', 'checkbox',
    'radio', 'dropdown', 'pages', 'layers', 'search', 'font', 'help', 'history', 'trash',
    'copy', 'paste', 'duplicate', 'lock', 'unlock', 'eye', 'eye-off', 'rotate-left',
    'rotate-right', 'flatten', 'align-left', 'align-center-h', 'align-right', 'align-top',
    'align-middle', 'align-bottom', 'distribute-h', 'distribute-v', 'front', 'back',
    'forward', 'backward', 'print', 'properties', 'plus', 'minus', 'close', 'check', 'warn',
    'info', 'link', 'settings', 'sun', 'moon', 'monitor', 'chevron', 'select-all',
    'folder', 'upload', 'globe'
  ] };
})(typeof globalThis !== 'undefined' ? globalThis : this);
