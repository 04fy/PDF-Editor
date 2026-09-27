/*!
 * app/units.js — measurement units.  Everything inside the document model is
 * stored in PDF points; this module converts for display only.
 */
(function (root) {
  'use strict';
  var PM = (root.PM = root.PM || {});

  var UNITS = {
    pt: { id: 'pt', factor: 1, decimals: 1, suffix: ' pt' },
    mm: { id: 'mm', factor: 25.4 / 72, decimals: 1, suffix: ' mm' },
    cm: { id: 'cm', factor: 2.54 / 72, decimals: 2, suffix: ' cm' },
    in: { id: 'in', factor: 1 / 72, decimals: 2, suffix: '"' }
  };

  function create(initial) {
    var current = UNITS[initial] ? initial : 'pt';
    var listeners = [];

    function unit() { return UNITS[current]; }

    return {
      get id() { return current; },
      unit: unit,
      list: Object.keys(UNITS).map(function (k) { return { id: k, label: k, decimals: UNITS[k].decimals }; }),
      /** points -> display value */
      to: function (pt) {
        if (pt == null || isNaN(pt)) return 0;
        return Number((pt * unit().factor).toFixed(unit().decimals));
      },
      /** display value -> points */
      from: function (v) {
        var n = parseFloat(v);
        if (isNaN(n)) return 0;
        return n / unit().factor;
      },
      /** formatted, e.g. "12.5 mm" */
      format: function (pt) { return this.to(pt) + unit().suffix; },
      set: function (id) {
        if (!UNITS[id]) return current;
        current = id;
        listeners.forEach(function (fn) { try { fn(id); } catch (e) { console.error(e); } });
        return current;
      },
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      }
    };
  }

  PM.Units = { create: create, UNITS: UNITS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
