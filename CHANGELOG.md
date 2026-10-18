# Changelog

Versions follow [semantic versioning](https://semver.org/). The version is shown in the tool's top bar and recorded in every export.

## 0.4.0 — 2026-10-18

First release.

**Annotation**
- Outline by clicks or freehand (`Shift` + drag); close on the first vertex, with `Enter` or a double-click.
- Draw, Subtract and Edit modes: overlapping outlines merge, subtracted areas and holes are cut out, vertices can be moved, added and deleted; undo/redo per image.
- Zoom at the cursor, pan, display-only brightness, contrast and invert (also in Safari).
- Per-image *unusable* flag with a reason; annotator ID, scale (µm/px) and time per image recorded.

**Measurement**
- `area_px_polygon`: exact area of the region the outlines cover (overlaps once, holes subtracted, self-intersecting outlines resolved).
- `area_px_mask`: pixel count of the exported mask, rasterised by pixel centre from the same region.
- Areas in mm² from the scale; areas per part label.

**Data**
- Export CSV, JSON (all vertices; re-importable) and a ZIP of PNG masks; image sizes are reported also for images not opened.
- Autosave in the browser, with a persistent warning and an export button if it fails.

**Quality**
- Keyboard access, screen-reader announcements and colour-independent cues (axe-core WCAG 2.1 AA).
- Tested automatically in Chromium, Firefox and WebKit (`tests/run-all.sh`, GitHub Actions).
