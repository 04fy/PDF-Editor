/*!
 * app/arrange.js — pure geometry helpers for multi-selection editing:
 * alignment, distribution, z-order, duplication and clipboard operations.
 * Everything works on plain op objects, so it is unit-testable in node.
 */
(function (root) {
  'use strict';
  var PM = (root.PM = root.PM || {});

  function round(v) { return Math.round((Number(v) || 0) * 100) / 100; }

  function bounds(op) {
    return { x: op.x, y: op.y, w: op.w, h: op.h, right: op.x + op.w, bottom: op.y + op.h,
      cx: op.x + op.w / 2, cy: op.y + op.h / 2 };
  }

  function union(ops) {
    if (!ops.length) return null;
    var b = ops.map(bounds);
    var x = Math.min.apply(null, b.map(v => v.x));
    var y = Math.min.apply(null, b.map(v => v.y));
    var right = Math.max.apply(null, b.map(v => v.right));
    var bottom = Math.max.apply(null, b.map(v => v.bottom));
    return { x: x, y: y, w: right - x, h: bottom - y, right: right, bottom: bottom,
      cx: (x + right) / 2, cy: (y + bottom) / 2 };
  }

  /**
   * Aligns the given ops.  `mode`:
   *   left | center-h | right | top | middle | bottom
   * `to` may be a page box {width, height} to align against the page as well.
   */
  function align(ops, mode, page) {
    if (!ops.length) return [];
    var pageBox = page ? { x: 0, y: 0, w: page.width, h: page.height } : null;
    // a single object aligns to the page (when known), several align to each other
    var frame = ops.length > 1 ? union(ops) : null;
    var out = [];
    ops.forEach(function (op) {
      var b = bounds(op);
      var dx = 0, dy = 0;
      switch (mode) {
        case 'left': dx = (frame ? frame.x : pageBox ? 0 : b.x) - b.x; break;
        case 'center-h': dx = (frame ? frame.cx : pageBox ? pageBox.w / 2 : b.cx) - b.cx; break;
        case 'right': dx = (frame ? frame.right : pageBox ? pageBox.w : b.right) - b.right; break;
        case 'top': dy = (frame ? frame.y : pageBox ? 0 : b.y) - b.y; break;
        case 'middle': dy = (frame ? frame.cy : pageBox ? pageBox.h / 2 : b.cy) - b.cy; break;
        case 'bottom': dy = (frame ? frame.bottom : pageBox ? pageBox.h : b.bottom) - b.bottom; break;
        default: return;
      }
      out.push({ op: op, x: round(b.x + dx), y: round(b.y + dy) });
    });
    return out;
  }

  /**
   * Even spacing along an axis.  The outer objects keep their position.
   * axis: 'h' | 'v'
   */
  function distribute(ops, axis) {
    if (ops.length < 3) return [];
    var horizontal = axis !== 'v';
    var list = ops.map(function (op) {
      var b = bounds(op);
      return { op: op, start: horizontal ? b.x : b.y, size: horizontal ? b.w : b.h };
    }).sort(function (a, b) { return a.start - b.start; });

    var first = list[0];
    var last = list[list.length - 1];
    var span = (last.start + last.size) - first.start;
    var used = list.reduce(function (s, v) { return s + v.size; }, 0);
    var gap = (span - used) / (list.length - 1);
    var out = [];
    var cursor = first.start;
    list.forEach(function (v, i) {
      var start = round(i === 0 ? first.start : i === list.length - 1 ? last.start : cursor);
      if (i > 0 && i < list.length - 1) out.push({ op: v.op, start: start });
      cursor = v.start + v.size + gap;
    });
    return out.map(function (item) {
      var b = bounds(item.op);
      return horizontal
        ? { op: item.op, x: item.start, y: b.y }
        : { op: item.op, x: b.x, y: item.start };
    });
  }

  /** Same size on the given axis for every object. */
  function makeSameSize(ops, axis, page) {
    if (!ops.length) return [];
    var horizontal = axis !== 'v';
    var size = ops.length > 1 && page
      ? null
      : (horizontal ? Math.min.apply(null, ops.map(o => o.w)) : Math.min.apply(null, ops.map(o => o.h)));
    if (ops.length > 1) {
      size = horizontal ? Math.max.apply(null, ops.map(o => o.w)) : Math.max.apply(null, ops.map(o => o.h));
    }
    return ops.map(function (op) {
      var b = bounds(op);
      var out = { op: op, x: b.x, y: b.y };
      if (horizontal) out.w = size; else out.h = size;
      return out;
    });
  }

  /** Moves every object by the same delta. */
  function translate(ops, dx, dy) {
    return ops.map(function (op) {
      return { op: op, x: round(op.x + dx), y: round(op.y + dy) };
    });
  }

  /* ----------------------------- z-order ----------------------------- */

  function restack(ops, pageOps, mode) {
    var order = pageOps.slice();
    var inPage = ops.filter(function (o) { return order.indexOf(o) >= 0; });
    if (!inPage.length) return [];
    if (mode === 'front' || mode === 'back') {
      var rest = order.filter(function (o) { return inPage.indexOf(o) < 0; });
      return (mode === 'front' ? rest.concat(inPage) : inPage.concat(rest)).map(function (op, i) {
        return { op: op, index: i };
      });
    }
    var step = mode === 'forward' ? 1 : -1;
    var seq = inPage.slice();
    if (step === -1) seq.reverse();
    seq.forEach(function (op) {
      var i = order.indexOf(op);
      var j = i + step;
      if (j < 0 || j >= order.length) return;
      order[i] = order[j];
      order[j] = op;
    });
    return order.map(function (op, i) { return { op: op, index: i }; });
  }

  /* --------------------------- clipboard ---------------------------- */

  function clone(op, dx, dy) {
    var copy = JSON.parse(JSON.stringify(op));
    delete copy.id;
    copy.x = round(op.x + (dx || 0));
    copy.y = round(op.y + (dy || 0));
    return copy;
  }

  function cloneMany(ops, dx, dy) {
    return ops.map(function (op) { return clone(op, dx, dy); });
  }

  /** Snaps a rectangle to the page and to the other objects. */
  function snapMove(target, others, page, threshold) {
    threshold = threshold || 4;
    var t = threshold;
    var px = [0, page ? page.width / 2 : 0, page ? page.width : 0];
    var py = [0, page ? page.height / 2 : 0, page ? page.height : 0];
    var ox = [], oy = [];
    (others || []).forEach(function (o) {
      var b = bounds(o);
      ox.push(b.x, b.cx, b.right);
      oy.push(b.y, b.cy, b.bottom);
    });
    var nx = target.x, ny = target.y, guides = [];
    [[target.x, px, 'x'], [target.x + target.w / 2, px, 'x'], [target.x + target.w, px, 'x']].forEach(function (e) {
      for (var i = 0; i < e[1].length; i++) {
        if (Math.abs(e[1][i] - e[0]) < t) { nx += e[1][i] - e[0]; guides.push({ axis: e[2], at: e[1][i] }); break; }
      }
    });
    [[target.y, py, 'y'], [target.y + target.h / 2, py, 'y'], [target.y + target.h, py, 'y']].forEach(function (e) {
      for (var i = 0; i < e[1].length; i++) {
        if (Math.abs(e[1][i] - e[0]) < t) { ny += e[1][i] - e[0]; guides.push({ axis: e[2], at: e[1][i] }); break; }
      }
    });
    return { x: nx, y: ny, guides: guides };
  }

  PM.Arrange = {
    bounds: bounds,
    union: union,
    align: align,
    distribute: distribute,
    makeSameSize: makeSameSize,
    translate: translate,
    restack: restack,
    clone: clone,
    cloneMany: cloneMany,
    snapMove: snapMove
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
