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

Run everything with one command (GitHub Actions runs the same script on every push and pull request):

```bash
tests/run-all.sh                    # all checks, Chromium + Firefox + WebKit
BROWSERS=chromium tests/run-all.sh  # one browser
PERF=1 tests/run-all.sh             # also the performance benchmark
```

It needs Node ≥ 18, Python 3 and [playwright-cli](https://github.com/microsoft/playwright-cli) (`npm i -g @playwright/cli`, then `playwright-cli install-browser firefox` and `webkit`). ESLint and html-validate run through `npx`, pinned in the script; there is still no `package.json`.

| Check | What it covers |
|---|---|
| version consistency | `app.js`, `CITATION.cff` and the `?v=` cache-busting parameters in `index.html` carry the same version |
| `tests/geometry.test.js` | areas, clipping, merge/subtract, masks and CSV in `geometry.js`, with seeded property tests (`node --test tests/`) |
| ESLint, html-validate | `eslint.config.js` and `.htmlvalidate.json` |
| `tests/e2e/core.e2e.js` | drawing, editing, undo/redo, zoom, navigation, display adjustments, exports (mask PNG decoded), import, persistence |
| `tests/e2e/storage.e2e.js` | autosave failures (full, blocked, unreadable storage) are reported, never silent |
| `tests/e2e/a11y.e2e.js` | axe-core WCAG 2.1 A/AA in 12 UI states, keyboard access, announcements (loads axe from cdnjs) |
| `tests/e2e/perf.e2e.js` | 150 images of 800×600 px, a 5000-vertex outline, exports; reports timings |

The e2e files are plain functions for `playwright-cli run-code`; each returns a report with one line per check instead of stopping at the first failure. WebKit is the engine behind Safari.

To check an exported file independently of the tool:

```bash
uv run tests/check_export.py annotations.json
```

It recomputes every area with shapely, rasterises a pixel-centre mask and flags any mismatch with the exported areas and mask counts. It also reports self-intersecting polygons, overlapping solids and holes outside a solid, which biased areas up to v0.2.x.

## Releasing a version

Bump the version in `app.js` (`TOOL.version`), `CITATION.cff` and every `?v=` in `index.html` together; `tests/run-all.sh` fails if they differ. The header and the help dialog show `TOOL.version`, and every export records it.

## Manual test checklist

- [ ] Load images (files and a folder) and navigate between them.
- [ ] Draw a polygon by clicks and by freehand; close it all three ways.
- [ ] Edit: move, insert and delete vertices; toggle a hole; undo and redo.
- [ ] The area shown matches a known shape (e.g. a 50 × 40 px rectangle = 2000 px²).
- [ ] Export JSON, CSV and the mask ZIP; the mask pixel count matches the polygon area.
- [ ] Reload the page and confirm that annotations are restored; import an exported JSON.
