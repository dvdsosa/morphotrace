# PolyArea Annotator

A dependency-free, browser-based polygon annotation tool for producing **projected-area ground truth** in scientific imaging (e.g. plankton biometry). Click vertices around an object (or Shift-drag to trace), mark interior holes, and export exact polygon areas, binary masks and per-image CSV.

**Live version:** https://dvdsosa.github.io/polyarea-annotator/ · **Archive:** Zenodo DOI (see `CITATION.cff`)

Images never leave your computer: they're opened with the browser's File API and nothing is uploaded. The tool also runs offline. Download the repository and open `index.html`.

## Features
- Polygon drawing by clicks, freehand tracing (Shift + drag), multiple polygons per image, holes (subtracted).
- Vertex editing: drag, insert (double-click an edge), delete (Alt + click); undo/redo.
- Zoom at cursor, pan, nearest-neighbour rendering at high zoom for pixel-level work.
- Display-only brightness/contrast/invert to see translucent boundaries (never alters exported data).
- Per-image "unusable" flag with reason (e.g. truncated specimen).
- Per-image annotation time, annotator ID and physical scale (µm/pixel) recorded in the export.
- Autosave in the browser; JSON import to resume or to review someone else's annotations.
- Export: `annotations.json` (all vertices), `areas.csv`, and a ZIP with binary PNG masks.

## Measurement definitions
- Vertices are stored in continuous image-pixel coordinates; pixel *(i, j)* covers [i, i+1) × [j, j+1), origin top-left.
- `area_px_polygon`: exact shoelace area of all non-hole polygons minus hole polygons. Overlapping non-hole polygons are counted twice, so don't overlap them.
- `area_px_mask`: number of foreground pixels in the exported binary mask (rasterised at 50 % pixel coverage). It's comparable with pixel-count areas from segmentation pipelines.
- `area_mm2_* = area_px × (µm/px)² / 10⁶`.

## Keyboard
`D` draw · `E` edit · `Enter` close polygon · `Backspace` remove last vertex · `Esc` cancel · `H` hole · `Del` delete · `F` fit · `←/→` previous/next · `X` unusable · `Ctrl/⌘+Z` undo · `?` help.

## Deploy
Static files only (`index.html`, `app.js`, `zip.js`, `style.css`). Any static host works: GitHub Pages (Settings → Pages → branch `main`, root), Vercel, Netlify, or a local `python3 -m http.server`.

## Citation
If you use this tool, please cite it using `CITATION.cff` (Zenodo DOI).

## Authorship note
Developed by D. Sosa-Trejo with AI coding assistance (Claude, Anthropic); the author tested the tool and is responsible for it.

## License
MIT
