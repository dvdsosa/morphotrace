// MorphoTrace — pure geometry and export helpers (no DOM, no state).
// Loaded as a plain <script> in the browser (exposes window.MorphoGeom) and with require() in Node,
// where the tests in tests/ exercise it. Coordinates are continuous image-pixel space.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MorphoGeom = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const round3 = (v) => Math.round(v * 1000) / 1000;

  function shoelace(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  }
  function perimeter(pts) {
    let p = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
      p += Math.hypot(x2 - x1, y2 - y1);
    }
    return p;
  }
  function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function distToSeg(px, py, [x1, y1], [x2, y2]) {
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  // Sutherland–Hodgman clip of a polygon to the image rectangle [0,w]x[0,h]
  function clipToImage(pts, w, h) {
    if (!w || !h) return pts;
    const edges = [
      [(p) => p[0] >= 0, (a, b) => [0, a[1] + (b[1] - a[1]) * (0 - a[0]) / (b[0] - a[0])]],
      [(p) => p[0] <= w, (a, b) => [w, a[1] + (b[1] - a[1]) * (w - a[0]) / (b[0] - a[0])]],
      [(p) => p[1] >= 0, (a, b) => [a[0] + (b[0] - a[0]) * (0 - a[1]) / (b[1] - a[1]), 0]],
      [(p) => p[1] <= h, (a, b) => [a[0] + (b[0] - a[0]) * (h - a[1]) / (b[1] - a[1]), h]],
    ];
    let out = pts;
    for (const [inside, cross] of edges) {
      const input = out; out = [];
      for (let i = 0; i < input.length; i++) {
        const cur = input[i], prev = input[(i + input.length - 1) % input.length];
        if (inside(cur)) { if (!inside(prev)) out.push(cross(prev, cur)); out.push(cur); }
        else if (inside(prev)) out.push(cross(prev, cur));
      }
      if (!out.length) break;
    }
    return out.map(([x, y]) => [round3(x), round3(y)]);
  }
  const clampPt = ([x, y], w, h) => [Math.max(0, Math.min(w || x, x)), Math.max(0, Math.min(h || y, y))];
  // Clips every polygon of an annotation to its image; drops polygons left with < 3 vertices.
  // Mutates ann.polygons and returns true if anything changed.
  function clipAnnotation(ann) {
    if (!ann.w) return false;
    let changed = false;
    ann.polygons = ann.polygons.map((p) => {
      const out = p.points.some(([x, y]) => x < 0 || y < 0 || x > ann.w || y > ann.h);
      if (!out) return p;
      changed = true;
      return Object.assign({}, p, { points: clipToImage(p.points, ann.w, ann.h) });
    }).filter((p) => p.points.length >= 3);
    return changed;
  }
  // ---------- region geometry ----------
  // A region is a polygon-clipping MultiPolygon: [[outerRing, holeRing, ...], ...], rings closed.
  const ring = (pts) => [...pts, pts[0]];
  const openRing = (r) => r.slice(0, -1).map(([x, y]) => [round3(x), round3(y)]);
  const regionArea = (mp) => mp.reduce((t, pg) => t + pg.reduce((u, r, k) => u + (k ? -1 : 1) * shoelace(r.slice(0, -1)), 0), 0);
  const regionOuterPerimeter = (mp) => mp.reduce((t, pg) => t + perimeter(pg[0].slice(0, -1)), 0);
  // The region an annotation covers: (union of solid polygons) minus (union of hole polygons), optionally
  // for one label only. Self-intersecting rings are resolved with the nonzero rule, as the canvas fills
  // them. Returns null if PC (polygon-clipping) is unavailable or fails.
  function region(polygons, PC, label) {
    if (!PC) return null;
    const mine = label === undefined ? polygons : polygons.filter((p) => (p.label || "unlabelled") === label);
    const solids = mine.filter((p) => !p.hole && p.points.length >= 3), holes = mine.filter((p) => p.hole && p.points.length >= 3);
    if (!solids.length) return [];
    try {
      const S = PC.union(...solids.map((p) => [ring(p.points)]));
      return holes.length ? PC.difference(S, ...holes.map((p) => [ring(p.points)])) : S;
    } catch (err) { return null; }
  }
  // Region → stored polygons: one solid per outer ring, one hole polygon per inner ring.
  function regionToPolygons(mp, label) {
    const out = [];
    for (const pg of mp) pg.forEach((r, k) => {
      const pts = openRing(r);
      if (pts.length >= 3 && shoelace(pts) > 0) out.push({ label, hole: k > 0, points: pts });
    });
    return out;
  }
  // Cleans a newly drawn (solid) polygon: a self-intersecting outline becomes simple pieces (plus holes where it
  // encloses a gap). Returns the input unchanged when it is already simple or PC is unavailable.
  function normalizePolygon(poly, PC) {
    const mp = region([Object.assign({}, poly, { hole: false })], PC);
    if (!mp) return [poly];
    if (mp.length === 1 && mp[0].length === 1 && Math.abs(regionArea(mp) - shoelace(poly.points)) < 1e-6) return [poly];
    return regionToPolygons(mp, poly.label);
  }

  // Pixel-centre scanline rasteriser: pixel (i, j) gets `value` when its centre (i+0.5, j+0.5) is inside
  // the rings under the even-odd rule (for a region: inside an outer ring and outside its holes).
  // Same inside test as pointInPoly, so an edge through a centre is decided the same way.
  function rasterizeRings(rings, w, h, out, value) {
    for (let j = 0; j < h; j++) {
      const y = j + 0.5, xs = [];
      for (const r of rings) for (let a = 0, n = r.length, b = n - 1; a < n; b = a++) {
        const [xa, ya] = r[a], [xb, yb] = r[b];
        if ((ya > y) !== (yb > y)) xs.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(w, Math.ceil(xs[k + 1] - 0.5));
        for (let i = i0; i < i1; i++) out[j * w + i] = value;
      }
    }
    return out;
  }
  // Binary mask (1 = organism) of the annotation's region, w×h row-major, and its pixel count.
  // Without PC: each solid polygon painted on its own, then each hole cleared.
  function maskFromPolygons(polygons, w, h, PC) {
    const mask = new Uint8Array(w * h), mp = region(polygons, PC);
    if (mp) rasterizeRings([].concat(...mp), w, h, mask, 1);
    else {
      for (const p of polygons) if (!p.hole) rasterizeRings([p.points], w, h, mask, 1);
      for (const p of polygons) if (p.hole) rasterizeRings([p.points], w, h, mask, 0);
    }
    let count = 0;
    for (let i = 0; i < mask.length; i++) count += mask[i];
    return { mask, count };
  }

  // Area of the region covered (overlaps count once, holes outside a solid remove nothing). The
  // perimeter is the length of the outer boundaries. Without PC, falls back to summing polygons.
  function stats(ann, umpp, PC) {
    const nHoles = ann.polygons.filter((p) => p.hole).length;
    let area = 0, per = 0;
    const mp = region(ann.polygons, PC);
    if (mp) { area = regionArea(mp); per = regionOuterPerimeter(mp); }
    else for (const p of ann.polygons) {
      const a = shoelace(p.points);
      if (p.hole) area -= a; else { area += a; per += perimeter(p.points); }
    }
    const mm2 = area * Math.pow(Number(umpp) || 0, 2) / 1e6;
    return { area, mm2, per, nHoles, nPolys: ann.polygons.length - nHoles };
  }
  function byLabel(ann, PC) {
    // region area per label (holes subtract from the label they carry)
    const out = {};
    for (const k of [...new Set(ann.polygons.map((p) => p.label || "unlabelled"))]) {
      const mp = region(ann.polygons, PC, k);
      out[k] = round3(mp ? regionArea(mp)
        : ann.polygons.filter((p) => (p.label || "unlabelled") === k).reduce((t, p) => t + (p.hole ? -1 : 1) * shoelace(p.points), 0));
    }
    return out;
  }

  // Boolean operation between a new polygon and the existing geometry of the same label.
  // The existing geometry is (union of non-hole polygons) minus (union of hole polygons); the result
  // replaces those polygons in place, and enclosed gaps become hole polygons. PC is the
  // polygon-clipping library. Returns {applied, first}: applied is false (and polys untouched) when the
  // new polygon does not overlap the existing geometry; first is the index of the first new outer ring.
  function applyBoolean(polys, poly, op, PC) {
    const none = { applied: false, first: -1 };
    if (!PC) return none;
    const mine = polys.map((q, i) => i).filter((i) => (polys[i].label || "") === (poly.label || ""));
    if (!mine.some((i) => !polys[i].hole)) return none;
    try {
      const G = region(mine.map((i) => polys[i]), PC), P = region([Object.assign({}, poly, { hole: false })], PC);
      if (!G || !P || regionArea(PC.intersection(G, P)) <= 0.5) return none;
      const R = op === "union" ? PC.union(G, P) : PC.difference(G, P);
      for (const i of mine.sort((a, b) => b - a)) polys.splice(i, 1);
      let first = -1;
      for (const p of regionToPolygons(R, poly.label)) {
        polys.push(p);
        if (first < 0 && !p.hole) first = polys.length - 1;
      }
      return { applied: true, first };
    } catch (err) { return none; }
  }

  const csvEscape = (v) => { const s = v === undefined || v === null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function toCsv(obj, tool) {
    const cols = ["rel_path", "file", "class", "status", "unusable_reason", "width", "height", "n_polygons", "n_holes", "area_px_polygon", "area_mm2_polygon", "area_px_mask", "area_mm2_mask", "area_px_by_label", "perimeter_px", "time_s"];
    const rows = obj.images.map((r) => {
      const ext = Object.assign({}, r, { n_polygons: r.polygons.filter((p) => !p.hole).length, n_holes: r.polygons.filter((p) => p.hole).length,
        area_px_by_label: Object.entries(r.area_px_by_label || {}).map(([k, v]) => `${k}=${v}`).join(";") });
      return cols.map((c) => csvEscape(ext[c])).join(",");
    });
    return `# ${tool.name} ${tool.version} | annotator=${obj.annotator} | um_per_px=${obj.um_per_px} | ${obj.exported}\n` + cols.join(",") + "\n" + rows.join("\n") + "\n";
  }

  return { round3, shoelace, perimeter, pointInPoly, distToSeg, clipToImage, clampPt, clipAnnotation, region, regionArea, regionToPolygons, normalizePolygon, rasterizeRings, maskFromPolygons, stats, byLabel, applyBoolean, csvEscape, toCsv };
});
