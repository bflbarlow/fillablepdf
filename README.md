# FillablePDF

Create **fillable PDFs entirely in the browser**. Open an existing PDF (or start
from a blank page), drop form fields on top of it, and export a real AcroForm PDF
that can be filled in any PDF reader.

No server, no upload, no account — every byte stays on the user's device.

## Features

- **Open any PDF** via the file picker or drag & drop, or start a blank
  Letter / Legal / A4 page.
- **Field tools**: text, multiline text, date, checkbox, radio group, dropdown,
  and signature line.
- **Direct manipulation**: click to place, drag to move, eight resize handles,
  arrow-key nudging, duplicate/delete.
- **Properties pane**: field name, page, geometry (in PDF points), default value,
  dropdown options, radio group/value, required, read-only, font size, alignment,
  text/border/fill colors.
- **Fields list** (Layers tab) with jump-to and delete.
- **Undo / redo** (100 steps), multi-page documents, page rotation aware.
- **Export a fillable PDF** with pdf-lib, optionally flattening the fields.
- **Save / open projects** as a single JSON file that embeds the source PDF and
  every field (with File System Access auto-save in Chromium browsers).
- Dark / light theme, resizable & collapsible properties pane, action log.

## Running it

It is a static site. Serve the folder over HTTP (recommended so the PDF.js
worker can load):

```bash
cd fillablepdf
python3 -m http.server 8080
# then open http://localhost:8080/
```

Opening `index.html` directly via `file://` also works in most browsers; PDF.js
falls back to an in-page worker if the worker file cannot be loaded.

## Project structure

```
fillablepdf/
├── index.html      # Editor layout (toolbar, canvas, properties pane)
├── about.html      # About / help page
├── styles.css      # Free Open Tools ecosystem styles + app styles
├── ui.js           # Shared UI layer (theme, panel, autosave, toolbar hooks)
├── app.js          # FillablePDF domain logic (render, fields, export)
├── vendor/
│   ├── pdf-lib.min.js       # PDF creation / AcroForm writer
│   ├── pdf.min.js           # PDF.js renderer
│   └── pdf.worker.min.js    # PDF.js worker
└── README.md
```

## How the export works

1. The original PDF bytes are kept in memory (`Uint8Array`).
2. Fields are stored in **PDF user-space points** (origin bottom-left), so they
   are independent of the on-screen zoom. Screen ⇄ PDF conversion uses the
   PDF.js viewport, which keeps rotated pages correct.
3. On export, pdf-lib loads a fresh copy of the source PDF and creates real form
   fields (`PDFTextField`, `PDFCheckBox`, `PDFDropdown`, `PDFRadioGroup`) at the
   stored rectangles, then saves a new PDF.

> **Note on signatures:** PDF signature fields (`/FT /Sig`) require a signing
> certificate and are not creatable client-side with pdf-lib. The "signature
> line" tool therefore exports a normal text field with a "Sign here" hint, which
> is the common approach for typed signatures.

## UI hooks

`ui.js` provides a callback-based interface; `app.js` implements:

| Callback | Purpose |
|---|---|
| `onToolChange(tool)` | Field tool selected |
| `onPropChange(prop, value)` | Geometry / name inputs |
| `onSave` / `onLoad` / `onNew` | Project save / open / new |
| `onUndo` / `onRedo` / `onDuplicate` / `onDelete` | Actions |
| `onContextMenu(action, event)` | Right-click menu |
| `getAppState` / `applyAutoSavePayload` | Project serialization |
| `onReadOnlyChange` | Multi-tab coordination |

## Credits

Built on the **Free Open Tools** template, with [pdf-lib](https://pdf-lib.js.org/)
and [PDF.js](https://mozilla.github.io/pdf.js/).
# fillablepdf
