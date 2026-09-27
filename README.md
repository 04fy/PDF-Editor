# HTML PDF Modifier

A professional PDF editor that runs **entirely inside the browser**. Open a PDF, change
its text, images, shapes, form fields and page layout, and save a new PDF. Nothing is
uploaded to a server — the file never leaves the device, and the application works
offline.

Built for documents in **every writing system**: Latin, Greek, Cyrillic, Arabic,
Hebrew, Persian, Urdu, Devanagari, Tamil, Thai, Lao, Khmer, Burmese, Ethiopic,
Hangul, Kana, Han (CJK), emoji, Brahmic scripts and more.

---

## Running it

The editor is a static site, so any static file server works:

```bash
python3 -m http.server 8080     # then open http://localhost:8080
npx serve .                     # or any other static server
```

No build step, no bundler, no network access needed: PDF.js, pdf-lib and fontkit
are vendored in `js/vendor/`.

---

## Editing

### Text
* **Double-click any text on the page** to edit it in place. The colour is sampled
  from the pixels underneath, the original position, size and line structure are
  kept, and the surrounding paragraph is detected automatically.
* Replace, recolour, re-align, re-flow, rotate, set letter/line spacing, or hide
  the original behind a cover of any colour.
* **Full Unicode input**: Arabic, Hebrew, Devanagari, Thai, CJK, emoji… The browser
  shapes the text, so joining, mark positioning and bidi order are all correct.
* Fonts: the 14 standard PDF fonts (real vector text), every system font, or any
  **TTF you add** (embedded and subsetted, so the text stays selectable). One click
  installs Noto Sans/Serif, Amiri, Scheherazade, Cairo, Vazirmatn and Noto Sans
  Hebrew/Arabic/Devanagari/Tamil/Thai/Lao/Khmer/Myanmar/Ethiopic/SC/JP.
* Right-to-left text is detected automatically, or forced per block, with
  `start / centre / end` alignment.
* Line breaking handles space-delimited scripts **and** scripts without spaces
  (Chinese, Japanese, Korean) in the same paragraph.

### Images
* Every embedded raster image is detected — including images inside form XObjects.
* Insert your own picture, replace a detected one in place, resize with the frame,
  `fit inside` / `fill box` / `stretch`, opacity, rotation, blend mode.
* PNG and JPEG are embedded losslessly; anything else is converted automatically.

### Shapes
* Rectangles (with corner radius), ellipses and lines.
* Fill, border, width, dash pattern, opacity and blend modes.
* **Redaction tool** — black bars that are rasterised into the page on export, so
  the covered content is removed for good instead of merely hidden.

### Interactive form fields
* Text field, check box, radio group and drop-down list, with name, default value,
  options, read-only and multi-line settings.
* Fields are written as real AcroForm widgets: they stay fillable in the exported
  PDF, or can be flattened with one switch.

### Pages
* Rotate, delete, duplicate, **drag to re-order**, insert blank pages.
* Change the page size (A3–A5, Letter, Legal, Tabloid) — the content is scaled
  uniformly and centred, never stretched.
* Background colour painted **behind** the existing content.
* **Flatten** a page (rasterise everything) — useful before heavy editing or for
  damaged files.
* Edits are applied additively, so annotations, form fields, links, bookmarks and
  metadata of the original file are preserved.

### Layout and organisation
* Multi-select (shift-click, rubber band), group move and proportional group scale.
* Align left/centre/right/top/middle/bottom, distribute horizontally/vertically.
* Z-order: bring to front, forward, backward, send to back.
* Copy / cut / paste / duplicate, lock, hide, delete.
* Layers panel, **history panel** with undo labels, search & replace over the whole
  document, snapping to guides, rulers-free but unit-aware measurements
  (pt / mm / cm / in).
* Project files (`.pmproj.json`) carry the source PDF plus every edit, so a job can
  be closed on one machine and continued on another. An interrupted session is
  offered for restore the next time the same document is opened.

### Interface
* English, Español, Français, Deutsch, Русский, العربية, עברית, فارسی, हिन्दी,
  中文, 日本語. The layout mirrors automatically for right-to-left languages.
* Light and dark themes, resizable panels, zoom slider, print output, context menus,
  and a shortcut sheet (`?`).

---

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `V` `T` `R` `O` `L` `I` `B` | Select · Text · Rectangle · Ellipse · Line · Image · Redact |
| `F` `C` | Form field · Check box |
| `Ctrl`/`⌘` + `Z` / `⇧` + `Z` | Undo / redo |
| `Ctrl`/`⌘` + `X` `C` `V` `D` `A` | Cut · Copy · Paste · Duplicate · Select all |
| `Ctrl`/`⌘` + `]` `[` | Bring forward / send backward |
| `Ctrl`/`⌘` + `S` / `E` / `P` | Save project · Export · Print |
| `Delete` | Delete the selection |
| Arrows / `⇧` + arrows | Nudge by 1 pt / 10 pt |
| `Tab` | Cycle through the objects of the page |
| `Space` + drag, middle drag | Pan |
| `Ctrl`/`⌘` + wheel, `+` `-` `0` | Zoom, fit width |
| `Esc` | Cancel editing or deselect |

---

## How text is written into the PDF

Two output paths, chosen automatically (and overridable per block):

1. **Vector text** — for scripts that do not need shaping and for embeddable fonts.
   Written as real text operators with a subsetted font program: selectable,
   searchable, copy-pasteable, small.
2. **Shaped text** — for Arabic, Hebrew, Devanagari, Thai, CJK, emoji and anything
   else that needs complex shaping, and for fonts that cannot be embedded. The
   browser's own text engine renders the block at 4× resolution and the result is
   embedded as an image at the exact position, rotation and size. An *invisible
   text layer* with the logical character order can be added so the text stays
   findable with `Ctrl`+`F`.

Both paths share one layout engine, so the preview, the preview after export and
the exported file agree with each other.

---

## Project layout

```
index.html              the application shell + SVG icon sprite
css/app.css             design system (light/dark, RTL-ready, print styles)
js/core/text.js         script detection, bidi, line breaking, layout, geometry
js/core/ops.js          document model, undo/redo, project serialisation
js/core/exporter.js     writes the model into a PDF with pdf-lib
js/app/pdfsource.js     PDF.js: loading, rendering, text/image extraction
js/app/viewer.js        page canvas, overlay, direct manipulation
js/app/inspector.js     property panels
js/app/arrange.js       align / distribute / z-order / clipboard (pure)
js/app/units.js         pt ⇄ mm ⇄ cm ⇄ in
js/app/fonts.js         font registry, CSS font loading, measurements
js/app/dialogs.js       modals, toasts, context menu
js/app/icons.js         icon helper
js/app/i18n.js          11 interface languages
js/app/main.js          wiring: files, panels, export, search, shortcuts
js/vendor/              PDF.js 3.11, pdf-lib 1.17, fontkit 1.1 (vendored)
test/                   node test suite + jsdom smoke test
```

`js/core/*` is deliberately free of DOM access, which is what makes the round trip
testable outside a browser.

---

## Tests

```bash
npm install          # jsdom, for the DOM test only
npm test             # 41 unit + round-trip tests
npm run test:dom     # boots index.html in jsdom, edits and exports a PDF
```

`npm test` builds a PDF, applies edits, writes the result and re-opens it with both
pdf-lib and PDF.js to check that the new text really landed at the requested
coordinates, that the original content survived, and that rotation, re-ordering,
deletion, duplication, blank pages, flattening, background insertion, resizing,
form fields, secure redaction, page ranges, font embedding and shaped (RTL) text
all behave as designed.

`npm run test:dom` loads the real page, opens a sample document, exercises every
sidebar panel, creates and edits objects, aligns a multi-selection, rotates a page,
opens the context menu and the export dialog, verifies the exported bytes (text +
form field) and switches the interface to Arabic and Hebrew (RTL).

The font test downloads Tinos once into `test/.cache/`; it is skipped when offline.

---

## Browser support

Chrome/Edge 90+, Firefox 90+, Safari 15+. The only modern APIs used are 2D canvas,
`FontFace`, `Pointer Events`, `IntersectionObserver` and CSS logical properties.

## Licence

MIT. The vendored libraries keep their own licences (PDF.js: Apache-2.0,
pdf-lib: MIT, fontkit: MIT).
