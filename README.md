# MorphoTrace

A dependency-free, browser-based polygon annotation tool for producing **projected-area ground truth** in scientific imaging (e.g. plankton biometry). Click vertices around an object (or Shift-drag to trace), mark interior holes, and export exact polygon areas, binary masks and per-image CSV.

**Live version:** https://dvdsosa.github.io/morphotrace/ · **Archive:** Zenodo DOI (see `CITATION.cff`)

Images never leave your computer: they're opened with the browser's File API and nothing is uploaded. The tool also runs offline. Download the repository and open `index.html`.

## Features
- Polygon drawing by clicks, freehand tracing (Shift + drag), multiple polygons per image, holes (subtracted).
- Vertex editing: drag, insert (double-click an edge), delete (Alt + click); undo/redo.
- Zoom at cursor (Shift + wheel), scroll with the wheel, pan, nearest-neighbour rendering at high zoom for pixel-level work.
- Display-only brightness/contrast/invert to see translucent boundaries (never alters exported data).
- Per-image "unusable" flag with reason (e.g. truncated specimen).
- Per-image annotation time, annotator ID and physical scale (µm/pixel) recorded in the export.
- Autosave in the browser; JSON import to resume or to review someone else's annotations.
- Export: `annotations.json` (all vertices), `areas.csv`, and a ZIP with binary PNG masks. Polygon labels (e.g. `body`, `appendage`) are kept and areas are also reported per label.

## Measurement definitions
- Vertices are stored in continuous image-pixel coordinates; pixel *(i, j)* covers [i, i+1) × [j, j+1), origin top-left.
- `area_px_polygon`: exact shoelace area of all non-hole polygons minus hole polygons, after clipping every polygon to the image rectangle (vertices cannot lie outside the image). Overlapping non-hole polygons are counted twice, so don't overlap them.
- `area_px_mask`: number of foreground pixels in the exported binary mask (rasterised at 50 % pixel coverage). It's comparable with pixel-count areas from segmentation pipelines.
- `area_px_by_label`: net polygon area for each polygon label (e.g. `body=2000;appendage=300` in the CSV).
- `area_mm2_* = area_px × (µm/px)² / 10⁶`.

## Keyboard and mouse

| Action | Shortcut |
|---|---|
| Draw mode | `D` |
| Edit mode | `E` |
| Add a vertex | Click (draw mode) |
| Trace freehand | `Shift` + drag (draw mode) |
| Close polygon | Click the first vertex, double-click, or `Enter` |
| Remove last vertex while drawing | Right-click (without dragging) or `Backspace` |
| Cancel polygon / deselect | `Esc` |
| Select polygon | Click it (edit mode) |
| Move vertex | Drag it (edit mode) |
| Insert vertex | Double-click an edge (edit mode) |
| Delete vertex | Hover it until it grows, then right-click (or `Alt` + click) (edit mode); its neighbours are joined |
| Toggle hole on selected polygon | `H` |
| Delete selected polygon | `Del` (or `Backspace` when not drawing) |
| Undo / redo | `Ctrl/⌘ + Z` / `Ctrl/⌘ + Shift + Z` (or `Ctrl/⌘ + Y`) |
| Zoom at cursor | `Shift` + mouse wheel (or trackpad pinch) |
| Scroll the image | Mouse wheel (vertical and horizontal) or trackpad swipe |
| Pan | `Space` + drag, or right/middle-button drag |
| Fit image to window | `F` |
| Previous / next image | `←` / `→` (or `P` / `N`) |
| Mark image unusable (with reason) | `X` |
| Help | `?` |

## Deploy
Static files only (`index.html`, `app.js`, `zip.js`, `style.css`). Any static host works: GitHub Pages (Settings → Pages → branch `main`, root), Vercel, Netlify, or a local `python3 -m http.server`.

## Contributing
Bug reports, feature requests and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report a problem and the few rules that keep the tool dependency-free.

## Citation
If you use this tool, please cite it using `CITATION.cff` (Zenodo DOI).

## Authorship note
Developed by D. Sosa-Trejo with AI coding assistance (Claude, Anthropic); the author tested the tool and is responsible for it.

## License
MIT
