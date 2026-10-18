// Unit and property tests for geometry.js. Run from the repository root with:  node --test tests/
// No dependencies: node:test, node:assert and the vendored polygon-clipping build.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../geometry.js");
const PC = require("../vendor/polygon-clipping-0.15.7.umd.min.js");

const UMPP = 7.38; // DYB-PlanktonNet scale (µm / pixel)
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const solid = (points, label = "organism") => ({ label, hole: false, points });
const hole = (points, label = "organism") => ({ label, hole: true, points });
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);

// Deterministic PRNG (mulberry32) so property tests are reproducible.
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Random simple (non-self-intersecting) star-shaped polygon: vertices at increasing angles.
function star(rand, cx, cy, rMin, rMax, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * (i + 0.2 + 0.6 * rand())) / n, r = rMin + (rMax - rMin) * rand();
    pts.push([G.round3(cx + r * Math.cos(t)), G.round3(cy + r * Math.sin(t))]);
  }
  return pts;
}
// Reference rasteriser mirroring the exported mask: a pixel is foreground when its centre is inside a
// solid polygon and not inside a hole polygon (the canvas fill thresholded at 50 %).
function rasterCount(polys, w, h) {
  let n = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = i + 0.5, y = j + 0.5;
    if (polys.some((p) => !p.hole && G.pointInPoly(x, y, p.points)) && !polys.some((p) => p.hole && G.pointInPoly(x, y, p.points))) n++;
  }
  return n;
}
const netArea = (polys) => G.stats({ polygons: polys }, UMPP).area;

// ---------- basic measures ----------
test("shoelace: known shapes, independent of orientation", () => {
  close(G.shoelace(rect(0, 0, 50, 40)), 2000);
  close(G.shoelace(rect(0, 0, 50, 40).reverse()), 2000);
  close(G.shoelace([[0, 0], [10, 0], [0, 10]]), 50);
  close(G.shoelace([[0, 0], [5, 5], [10, 10]]), 0); // collinear
  close(G.shoelace(rect(2.5, 3.25, 7.5, 4.75)), 7.5);
});

test("perimeter of a rectangle", () => {
  close(G.perimeter(rect(0, 0, 50, 40)), 180);
});

test("stats: area in px and mm², holes subtract, counts", () => {
  const st = G.stats({ polygons: [solid(rect(0, 0, 10, 20))] }, UMPP);
  close(st.area, 200);
  close(st.mm2, (200 * UMPP * UMPP) / 1e6);
  assert.equal(st.nPolys, 1);
  assert.equal(st.nHoles, 0);

  const withHole = G.stats({ polygons: [solid(rect(0, 0, 10, 10)), hole(rect(3, 3, 7, 7))] }, UMPP);
  close(withHole.area, 84);
  close(withHole.per, 40); // perimeter counts outer boundaries only
  assert.equal(withHole.nHoles, 1);
  assert.equal(withHole.nPolys, 1);

  close(G.stats({ polygons: [solid(rect(0, 0, 1, 1))] }, "").mm2, 0); // missing scale → 0, not NaN
});

test("byLabel: net area per label", () => {
  const out = G.byLabel({ polygons: [solid(rect(0, 0, 10, 10), "body"), hole(rect(1, 1, 3, 3), "body"), solid(rect(20, 20, 22, 25), "appendage"), { hole: false, points: rect(0, 0, 1, 1) }] });
  assert.deepEqual(out, { body: 96, appendage: 10, unlabelled: 1 });
});

test("pointInPoly and distToSeg", () => {
  const sq = rect(0, 0, 10, 10);
  assert.equal(G.pointInPoly(5, 5, sq), true);
  assert.equal(G.pointInPoly(15, 5, sq), false);
  close(G.distToSeg(5, 3, [0, 0], [10, 0]), 3);
  close(G.distToSeg(13, 4, [0, 0], [10, 0]), 5); // beyond the end → distance to endpoint
  close(G.distToSeg(1, 1, [0, 0], [0, 0]), Math.SQRT2); // degenerate segment
});

// ---------- clipping to the image ----------
test("clipToImage: inside unchanged, straddling clipped, outside empty", () => {
  assert.deepEqual(G.clipToImage(rect(10, 10, 20, 20), 100, 100), rect(10, 10, 20, 20));
  close(G.shoelace(G.clipToImage(rect(-5, -5, 5, 5), 100, 100)), 25);
  close(G.shoelace(G.clipToImage(rect(90, 40, 120, 60), 100, 100)), 200);
  close(G.shoelace(G.clipToImage(rect(-10, -10, 110, 110), 100, 100)), 10000);
  assert.deepEqual(G.clipToImage(rect(200, 200, 210, 210), 100, 100), []);
  assert.deepEqual(G.clipToImage(rect(-5, -5, 5, 5), 0, 0), rect(-5, -5, 5, 5)); // size unknown → untouched
});

test("clipAnnotation: clips, drops empty polygons, reports change", () => {
  const ann = { w: 100, h: 100, polygons: [solid(rect(10, 10, 20, 20)), solid(rect(-5, -5, 5, 5)), solid(rect(200, 200, 210, 210))] };
  assert.equal(G.clipAnnotation(ann), true);
  assert.equal(ann.polygons.length, 2);
  close(netArea(ann.polygons), 125);
  assert.equal(G.clipAnnotation(ann), false);
});

test("clampPt keeps points inside the image", () => {
  assert.deepEqual(G.clampPt([-3, 120], 100, 100), [0, 100]);
  assert.deepEqual(G.clampPt([50, 50], 100, 100), [50, 50]);
});

// ---------- boolean operations (merge / subtract) ----------
test("union of overlapping polygons merges into one with the right area", () => {
  const polys = [solid(rect(0, 0, 10, 10))];
  const r = G.applyBoolean(polys, solid(rect(5, 5, 15, 15)), "union", PC);
  assert.equal(r.applied, true);
  assert.equal(polys.length, 1);
  assert.equal(r.first, 0);
  close(netArea(polys), 175);
});

test("non-overlapping or merely touching polygons are not merged", () => {
  const polys = [solid(rect(0, 0, 10, 10))];
  assert.equal(G.applyBoolean(polys, solid(rect(20, 20, 30, 30)), "union", PC).applied, false);
  assert.equal(G.applyBoolean(polys, solid(rect(10, 0, 20, 10)), "union", PC).applied, false); // shared edge
  assert.equal(polys.length, 1);
});

test("subtracting inside an area creates a hole", () => {
  const polys = [solid(rect(0, 0, 10, 10))];
  assert.equal(G.applyBoolean(polys, solid(rect(4, 4, 6, 6)), "difference", PC).applied, true);
  assert.equal(polys.filter((p) => p.hole).length, 1);
  close(netArea(polys), 96);
});

test("subtracting across an area splits it in two", () => {
  const polys = [solid(rect(0, 0, 10, 10))];
  G.applyBoolean(polys, solid(rect(4, -1, 6, 11)), "difference", PC);
  assert.equal(polys.filter((p) => !p.hole).length, 2);
  close(netArea(polys), 80);
});

test("a union that encloses a gap produces a hole", () => {
  // U-shape closed by a bar on top leaves a 2×2 gap
  const polys = [solid([[0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6]])];
  G.applyBoolean(polys, solid(rect(0, 4, 6, 8)), "union", PC);
  assert.equal(polys.filter((p) => p.hole).length, 1);
  close(netArea(polys), 6 * 8 - 2 * 2);
});

test("existing holes are respected by a later union", () => {
  const polys = [solid(rect(0, 0, 10, 10)), hole(rect(4, 4, 6, 6))];
  G.applyBoolean(polys, solid(rect(8, 0, 14, 10)), "union", PC);
  close(netArea(polys), 140 - 4);
});

test("different labels are never merged", () => {
  const polys = [solid(rect(0, 0, 10, 10), "body")];
  assert.equal(G.applyBoolean(polys, solid(rect(5, 5, 15, 15), "appendage"), "union", PC).applied, false);
});

test("without polygon-clipping nothing happens", () => {
  const polys = [solid(rect(0, 0, 10, 10))];
  assert.equal(G.applyBoolean(polys, solid(rect(5, 5, 15, 15)), "union", undefined).applied, false);
  assert.equal(polys.length, 1);
});

// ---------- property tests on random polygons ----------
test("property: union and difference areas obey set identities (500 random pairs)", () => {
  const rand = rng(2026);
  for (let k = 0; k < 500; k++) {
    const A = star(rand, 50, 50, 5, 30, 3 + Math.floor(rand() * 20));
    const B = star(rand, 40 + 20 * rand(), 40 + 20 * rand(), 5, 30, 3 + Math.floor(rand() * 20));
    const a = G.shoelace(A), b = G.shoelace(B);
    const inter = netArea([].concat(...PC.intersection([[...A, A[0]]], [[...B, B[0]]]).map((pg) => pg.map((r, i) => ({ hole: i > 0, points: r.slice(0, -1) })))));
    const U = [solid(A)];
    if (G.applyBoolean(U, solid(B), "union", PC).applied) {
      const u = netArea(U);
      assert.ok(u <= a + b + 0.05 && u >= Math.max(a, b) - 0.05, `union ${u} vs ${a}, ${b}`);
      close(u, a + b - inter, 0.05 + 1e-3 * (a + b)); // inclusion–exclusion (round3 noise)
      const D = [solid(A)];
      G.applyBoolean(D, solid(B), "difference", PC);
      const d = netArea(D);
      assert.ok(d >= -1e-6, `negative difference ${d}`);
      close(d, a - inter, 0.05 + 1e-3 * a);
    }
  }
});

// ---------- polygon area vs mask pixel count ----------
test("mask: an integer-aligned rectangle covers exactly its area in pixels", () => {
  const polys = [solid(rect(3, 4, 13, 24))];
  assert.equal(rasterCount(polys, 32, 32), 200);
  assert.equal(rasterCount([solid(rect(0, 0, 10, 10)), hole(rect(2, 2, 5, 5))], 16, 16), 91);
});

test("property: mask pixel count ≈ polygon area within half a pixel per unit perimeter (200 random shapes)", () => {
  const rand = rng(7);
  let worst = 0;
  for (let k = 0; k < 200; k++) {
    const P = star(rand, 32, 32, 4, 28, 3 + Math.floor(rand() * 30));
    const polys = [solid(P)];
    const diff = Math.abs(rasterCount(polys, 64, 64) - G.shoelace(P));
    const bound = 0.5 * G.perimeter(P) + 2;
    worst = Math.max(worst, diff / bound);
    assert.ok(diff <= bound, `|mask − polygon| = ${diff.toFixed(2)} > ${bound.toFixed(2)}`);
  }
  assert.ok(worst < 1);
});

// ---------- export ----------
test("toCsv: header, derived columns and CSV escaping", () => {
  const obj = {
    annotator: "DST", um_per_px: UMPP, exported: "2026-10-18T00:00:00.000Z",
    images: [{ rel_path: 'main/Copepoda/a, "b".jpg', file: 'a, "b".jpg', class: "Copepoda", status: "annotated", unusable_reason: "", width: 10, height: 10,
      area_px_polygon: 96, area_mm2_polygon: 0.005, area_px_by_label: { organism: 96 }, perimeter_px: 40, time_s: 12.3,
      polygons: [solid(rect(0, 0, 10, 10)), hole(rect(4, 4, 6, 6))] }],
  };
  const lines = G.toCsv(obj, { name: "MorphoTrace", version: "test" }).trim().split("\n");
  assert.match(lines[0], /^# MorphoTrace test \| annotator=DST \| um_per_px=7\.38/);
  assert.equal(lines[1].split(",")[0], "rel_path");
  assert.equal(lines[2], '"main/Copepoda/a, ""b"".jpg","a, ""b"".jpg",Copepoda,annotated,,10,10,1,1,96,0.005,,,organism=96,40,12.3');
  assert.equal(G.csvEscape("line\nbreak"), '"line\nbreak"');
  assert.equal(G.csvEscape(null), "");
});

// ---------- known limitations (documented, not failures) ----------
test("KNOWN: overlapping solids with merge disabled are double-counted in area_px_polygon", { todo: "stats() sums polygons; the mask counts their union" }, () => {
  const polys = [solid(rect(0, 0, 10, 10)), solid(rect(5, 5, 15, 15))];
  assert.equal(netArea(polys), rasterCount(polys, 20, 20));
});

test("KNOWN: a self-intersecting (figure-8) polygon has a cancelling shoelace area", { todo: "first polygon of an image is stored as drawn, without cleaning" }, () => {
  const bow = [[0, 0], [10, 10], [10, 0], [0, 10]];
  assert.equal(G.shoelace(bow), rasterCount([solid(bow)], 12, 12));
});
