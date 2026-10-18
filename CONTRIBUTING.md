# Contributing to MorphoTrace

Thanks for helping improve MorphoTrace. Bug reports, ideas and pull requests are all welcome.

## Reporting a problem

Open an issue and include:

- what you did, what you expected and what happened;
- your browser and version, and your operating system;
- if possible, an exported `annotations.json` (or a small test image) that reproduces the problem.

Please do not attach images you are not allowed to share. MorphoTrace never uploads images, and issues are public.

## Proposing a change

1. Fork the repository and create a branch from `main`.
2. Keep the change focused: one fix or feature per pull request.
3. Test it in a current Chrome or Firefox, and Safari if you can. The checklist below covers the core functions.
4. Open a pull request that describes the change and how you tested it.

## Design rules

- **No build step and no package manager.** The tool is plain HTML, CSS and JavaScript, so it can be opened offline from `index.html` and archived on Zenodo as-is. Third-party code is allowed only as a single vendored, permissively licensed file under `vendor/`, listed in `THIRD_PARTY_NOTICES.md`.
- **Images stay local.** Never add code that sends images or annotations over the network.
- **Measurements must not change silently.** Any change to how areas, masks or exports are computed needs a note in the README ("Measurement definitions") and a version bump, because published results may depend on them.
- **Backward-compatible exports.** Older `annotations.json` files must still import.

## Automated tests

The measurement code (areas, clipping, merge/subtract, CSV) lives in `geometry.js`, with no DOM, so it can be tested outside the browser. Run from the repository root:

```bash
node --test tests/                                  # unit + property tests, no install needed (Node ≥ 18)
uv run tests/check_export.py annotations.json       # independent check of an export with shapely
```

`check_export.py` recomputes every area with shapely, rasterises a pixel-centre mask and flags any mismatch with the exported areas and mask counts. It also reports self-intersecting polygons, overlapping solids and holes outside a solid, which biased areas up to v0.2.x.

## Manual test checklist

- [ ] Load images (files and a folder) and navigate between them.
- [ ] Draw a polygon by clicks and by freehand; close it all three ways.
- [ ] Edit: move, insert and delete vertices; toggle a hole; undo and redo.
- [ ] The area shown matches a known shape (e.g. a 50 × 40 px rectangle = 2000 px²).
- [ ] Export JSON, CSV and the mask ZIP; the mask pixel count matches the polygon area.
- [ ] Reload the page and confirm that annotations are restored; import an exported JSON.
