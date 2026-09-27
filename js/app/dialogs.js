/*!
 * app/dialogs.js — modal dialogs, toasts and the context menu.
 * One instance is created by main.js and shared by the panels.
 */
(function (root) {
  'use strict';
  var PM = (root.PM = root.PM || {});
  var Icons = PM.Icons;

  function create(opts) {
    var t = opts.t;
    var modal = opts.modal;
    var body = opts.modalBody;
    var titleEl = opts.modalTitle;
    var stack = opts.toastStack;
    var menu = opts.menu;
    var current = null;

    /* ----------------------------- modal ----------------------------- */

    function close() {
      modal.classList.remove('show');
      current = null;
      document.removeEventListener('keydown', onKey, true);
    }

    function onKey(ev) {
      if (!current) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        var cancel = current.onCancel;
        close();
        if (cancel) cancel();
      } else if (ev.key === 'Enter' && current.acceptEnter !== false &&
                 ev.target && ev.target.tagName !== 'TEXTAREA' &&
                 !(ev.target && ev.target.classList.contains('btn'))) {
        ev.preventDefault();
        ev.stopPropagation();
        accept();
      }
    }

    function accept() {
      if (!current) return;
      var ok = current.onOk;
      close();
      if (ok) ok(body);
    }

    /**
     * open({ title, html, okLabel, cancelLabel, wide, onOk, onCancel, ready })
     * Returns a handle with close().
     */
    function open(cfg) {
      cfg = cfg || {};
      if (current) close();
      current = cfg;
      if (titleEl) titleEl.textContent = cfg.title || '';
      body.innerHTML = cfg.html || '';
      modal.classList.toggle('wide', !!cfg.wide);
      var okBtn = modal.querySelector('[data-modal-ok]');
      var cancelBtn = modal.querySelector('[data-modal-cancel]');
      if (okBtn) {
        okBtn.textContent = cfg.okLabel || t('msg.ok');
        okBtn.hidden = cfg.hideOk === true;
      }
      if (cancelBtn) cancelBtn.textContent = cfg.cancelLabel || t('msg.cancel');
      modal.classList.add('show');
      if (cfg.ready) cfg.ready(body);
      var first = body.querySelector('input, textarea, select');
      if (first) { first.focus(); if (first.select) first.select(); }
      document.addEventListener('keydown', onKey, true);
      return { close: close, body: body };
    }

    modal.addEventListener('click', function (ev) {
      if (ev.target === modal) { var c = current && current.onCancel; close(); if (c) c(); }
      if (ev.target.closest && ev.target.closest('[data-modal-ok]')) accept();
      if (ev.target.closest && ev.target.closest('[data-modal-cancel]')) {
        var c2 = current && current.onCancel;
        close();
        if (c2) c2();
      }
    });

    function confirm(title, html, okLabel) {
      return new Promise(function (resolve) {
        open({ title: title, html: html, okLabel: okLabel, onOk: () => resolve(true), onCancel: () => resolve(false) });
      });
    }

    function prompt(title, cfg) {
      cfg = cfg || {};
      return new Promise(function (resolve) {
        open({
          title: title,
          html: '<input id="dlg-input" class="text-input" type="' + (cfg.type || 'text') + '"' +
            (cfg.placeholder ? ' placeholder="' + escapeHtml(cfg.placeholder) + '"' : '') + '>' +
            (cfg.hint ? '<p class="note">' + cfg.hint + '</p>' : ''),
          onOk: function (b) { resolve($('#input', b) ? $('#input', b).value : null); },
          onCancel: function () { resolve(null); }
        });
        if (cfg.value != null) { var i = $('#dlg-input', body); if (i) i.value = cfg.value; }
      });
    }

    /* ----------------------------- toasts ---------------------------- */

    function toast(message, kind, timeout) {
      if (!stack) return;
      var node = document.createElement('div');
      node.className = 'toast' + (kind ? ' ' + kind : '');
      var icon = { ok: 'check', warn: 'warn', error: 'warn', info: 'info' }[kind] || 'info';
      node.innerHTML = Icons.use(icon) + '<span></span>';
      node.lastChild.textContent = message;
      stack.appendChild(node);
      setTimeout(function () {
        node.classList.add('out');
        setTimeout(function () { node.remove(); }, 200);
      }, timeout || (kind === 'error' ? 6000 : 3200));
      while (stack.children.length > 4) stack.firstChild.remove();
    }

    /* -------------------------- context menu ------------------------- */

    var openMenu = null;

    function contextMenu(x, y, items) {
      hideMenu();
      menu.innerHTML = '';
      items.forEach(function (item) {
        if (item === '-' || item.separator) {
          menu.appendChild(document.createElement('hr'));
          return;
        }
        if (item.header) {
          var h = document.createElement('div');
          h.className = 'menu-label';
          h.textContent = item.header;
          menu.appendChild(h);
          return;
        }
        var b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = Icons.use(item.icon || 'chevron') + '<span></span>';
        b.lastChild.textContent = item.label;
        b.disabled = !!item.disabled;
        b.addEventListener('click', function () {
          hideMenu();
          if (item.action) item.action();
        });
        menu.appendChild(b);
      });
      menu.hidden = false;
      menu.style.left = '0px';
      menu.style.top = '0px';
      var r = menu.getBoundingClientRect();
      var left = Math.min(x, root.innerWidth - r.width - 8);
      var top = Math.min(y, root.innerHeight - r.height - 8);
      menu.style.left = Math.max(8, left) + 'px';
      menu.style.top = Math.max(8, top) + 'px';
      openMenu = menu;
    }

    function hideMenu() {
      if (menu) { menu.hidden = true; menu.innerHTML = ''; }
      openMenu = null;
    }

    document.addEventListener('pointerdown', function (ev) {
      if (openMenu && !menu.contains(ev.target)) hideMenu();
    }, true);
    root.addEventListener('blur', hideMenu);
    root.addEventListener('resize', hideMenu);

    return {
      open: open, close: close, confirm: confirm, prompt: prompt,
      toast: toast, contextMenu: contextMenu, hideMenu: hideMenu,
      get isOpen() { return !!current; }
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  PM.Dialogs = { create: create, escapeHtml: escapeHtml };
})(typeof globalThis !== 'undefined' ? globalThis : this);
