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
  function stats(ann, umpp) {
    let area = 0, per = 0, nHoles = 0;
    for (const p of ann.polygons) {
      const a = shoelace(p.points);
      if (p.hole) { area -= a; nHoles++; } else { area += a; per += perimeter(p.points); }
    }
    const mm2 = area * Math.pow(Number(umpp) || 0, 2) / 1e6;
    return { area, mm2, per, nHoles, nPolys: ann.polygons.length - nHoles };
  }
  function byLabel(ann) {
    // net polygon area per label (holes subtract from the label they carry)
    const out = {};
    for (const p of ann.polygons) {
      const k = p.label || "unlabelled";
      out[k] = round3((out[k] || 0) + (p.hole ? -1 : 1) * shoelace(p.points));
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
    const ring = (pts) => [...pts, pts[0]];
    const open = (r) => r.slice(0, -1).map(([x, y]) => [round3(x), round3(y)]);
    const area = (mp) => mp.reduce((t, pg) => t + pg.reduce((u, r, k) => u + (k ? -1 : 1) * shoelace(r.slice(0, -1)), 0), 0);
    const mine = polys.map((q, i) => i).filter((i) => (polys[i].label || "") === (poly.label || ""));
    const solids = mine.filter((i) => !polys[i].hole), holes = mine.filter((i) => polys[i].hole);
    if (!solids.length) return none;
    try {
      let G = PC.union(...solids.map((i) => [ring(polys[i].points)]));
      if (holes.length) G = PC.difference(G, ...holes.map((i) => [ring(polys[i].points)]));
      const P = [ring(poly.points)];
      if (area(PC.intersection(G, P)) <= 0.5) return none;
      const R = op === "union" ? PC.union(G, P) : PC.difference(G, P);
      for (const i of mine.sort((a, b) => b - a)) polys.splice(i, 1);
      let first = -1;
      for (const pg of R) pg.forEach((r, k) => {
        const pts = open(r);
        if (pts.length < 3) return;
        polys.push({ label: poly.label, hole: k > 0, points: pts });
        if (first < 0 && k === 0) first = polys.length - 1;
      });
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

  return { round3, shoelace, perimeter, pointInPoly, distToSeg, clipToImage, clampPt, clipAnnotation, stats, byLabel, applyBoolean, csvEscape, toCsv };
});
