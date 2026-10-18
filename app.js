// MorphoTrace — dependency-free polygon annotation for projected-area ground truth.
// Coordinates are stored in continuous image-pixel space: pixel (i, j) spans [i, i+1) x [j, j+1).
(function () {
  "use strict";

  const TOOL = { name: "MorphoTrace", version: "0.2.4" };
  const STORE_KEY = "morphotrace.v1";
  const HIT_PX = 8;          // screen-space hit tolerance
  const FREEHAND_STEP = 3;   // screen px between freehand samples

  const $ = (id) => document.getElementById(id);
  const cv = $("cv"), ctx = cv.getContext("2d"), wrap = $("wrap");

  // ---------- state ----------
  const images = [];               // {key, name, cls, url, img, w, h}
  let annotations = {};            // key -> {polygons, skip, skipReason, timeMs, w, h}
  let settings = { annotator: "", umpp: 7.38, label: "organism", merge: true };
  let cur = -1;
  let mode = "draw";               // "draw" (add area), "subtract" (remove area) or "edit" (select / vertices)
  let drawing = null;              // {pts: [[x,y], ...]}
  let selected = -1;
  let view = { s: 1, tx: 0, ty: 0 };
  let display = { bright: 100, contr: 100, invert: false, fill: true };
  let pointer = { x: 0, y: 0, inside: false };
  let drag = null;                 // {kind: 'pan'|'vertex'|'free', ...}
  let hoverV = null;               // {pi, vi}: vertex under the cursor in edit mode
  let hoverP = -1;                 // polygon under the cursor in edit mode
  let spaceDown = false;
  let shownAt = 0;
  const undoStacks = {}, redoStacks = {};

  // ---------- persistence ----------
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.settings) settings = Object.assign(settings, data.settings);
      if (data.annotations) annotations = data.annotations;
    } catch (e) { /* storage unavailable: run without autosave */ }
  }
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ settings, annotations })); } catch (e) { /* ignore */ }
    }, 300);
  }

  // ---------- geometry ----------
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
  function stats(ann) {
    let area = 0, per = 0, nHoles = 0;
    for (const p of ann.polygons) {
      const a = shoelace(p.points);
      if (p.hole) { area -= a; nHoles++; } else { area += a; per += perimeter(p.points); }
    }
    const mm2 = area * Math.pow(Number(settings.umpp) || 0, 2) / 1e6;
    return { area, mm2, per, nHoles, nPolys: ann.polygons.length - nHoles };
  }
  const toImg = (sx, sy) => [(sx - view.tx) / view.s, (sy - view.ty) / view.s];
  const toScr = (x, y) => [x * view.s + view.tx, y * view.s + view.ty];

  // ---------- images ----------
  function annFor(key, name) {
    if (annotations[key]) return annotations[key];
    const alt = Object.keys(annotations).find((k) => k.split("/").pop() === name);
    if (alt) { annotations[key] = annotations[alt]; if (alt !== key) delete annotations[alt]; return annotations[key]; }
    annotations[key] = { polygons: [], skip: false, skipReason: "", timeMs: 0, w: 0, h: 0 };
    return annotations[key];
  }
  function addFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|tiff?|bmp|webp|gif)$/i.test(f.name));
    files.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
    for (const f of files) {
      const key = f.webkitRelativePath || f.name;
      if (images.some((im) => im.key === key)) continue;
      const parts = key.split("/");
      images.push({ key, name: f.name, cls: parts.length > 1 ? parts[parts.length - 2] : "", url: URL.createObjectURL(f), img: null, w: 0, h: 0 });
      annFor(key, f.name);
    }
    renderList();
    if (cur < 0 && images.length) go(0);
    save();
  }
  function ensureImage(im) {
    return new Promise((resolve, reject) => {
      if (im.img) return resolve(im.img);
      const img = new Image();
      img.onload = () => { im.img = img; im.w = img.naturalWidth; im.h = img.naturalHeight; const a = annotations[im.key]; a.w = im.w; a.h = im.h; if (clipAnnotation(a)) save(); resolve(img); };
      img.onerror = reject;
      img.src = im.url;
    });
  }
  function flushTime() {
    if (cur >= 0 && shownAt && document.visibilityState === "visible") {
      annotations[images[cur].key].timeMs += performance.now() - shownAt;
    }
    shownAt = performance.now();
  }
  async function go(i) {
    if (i < 0 || i >= images.length) return;
    if (drawing && drawing.pts.length) {
      if (!confirm("Discard the unfinished polygon?")) return;
    }
    flushTime();
    drawing = null; selected = -1; cur = i;
    await ensureImage(images[cur]);
    shownAt = performance.now();
    fit();
    renderList();
    $("empty").style.display = "none";
    save();
  }

  // ---------- undo ----------
  function snapshot() { return JSON.stringify(annotations[images[cur].key].polygons); }
  function snapshotNow() { return snapshot(); }
  function commitUndo(snap) {
    const k = images[cur].key;
    (undoStacks[k] = undoStacks[k] || []).push(snap);
    if (undoStacks[k].length > 200) undoStacks[k].shift();
    redoStacks[k] = [];
  }
  function pushUndo() {
    const k = images[cur].key;
    (undoStacks[k] = undoStacks[k] || []).push(snapshot());
    if (undoStacks[k].length > 200) undoStacks[k].shift();
    redoStacks[k] = [];
  }
  function undo() {
    if (cur < 0) return;
    if (drawing) { drawing.pts.pop(); if (!drawing.pts.length) drawing = null; return draw(); }
    const k = images[cur].key, st = undoStacks[k];
    if (!st || !st.length) return;
    (redoStacks[k] = redoStacks[k] || []).push(snapshot());
    annotations[k].polygons = JSON.parse(st.pop());
    selected = -1; changed();
  }
  function redo() {
    if (cur < 0) return;
    const k = images[cur].key, st = redoStacks[k];
    if (!st || !st.length) return;
    undoStacks[k].push(snapshot());
    annotations[k].polygons = JSON.parse(st.pop());
    selected = -1; changed();
  }
  function changed() { save(); renderList(); draw(); }

  // ---------- polygon operations ----------
  function closeDrawing() {
    if (!drawing || drawing.pts.length < 3) return;
    const polys = annotations[images[cur].key].polygons;
    const poly = { label: settings.label || "organism", hole: false, points: clipToImage(drawing.pts.map(([x, y]) => [round3(x), round3(y)]), images[cur].w, images[cur].h) };
    const subtract = !!drawing.subtract;
    drawing = null;
    if (poly.points.length < 3) return draw();
    const snapshot = snapshotNow();
    if (subtract) {
      const r = applyBoolean(polys, poly, "difference");
      if (!r) { flash("The subtraction polygon does not overlap any area: nothing removed."); return draw(); }
      commitUndo(snapshot); changed(); flash("Area subtracted (Ctrl/⌘+Z to undo)."); return;
    }
    const r = settings.merge !== false ? applyBoolean(polys, poly, "union") : 0;
    if (!r) { polys.push(poly); selected = polys.length - 1; }
    commitUndo(snapshot); changed();
    if (r) flash("Merged with the overlapping area (Ctrl/⌘+Z to undo).");
  }
  // Boolean operation between a new polygon and the existing geometry of the same label.
  // The existing geometry is (union of non-hole polygons) minus (union of hole polygons); the result
  // replaces those polygons, and enclosed gaps become hole polygons. Returns 1 if the new polygon
  // overlapped the existing geometry (and the operation was applied), 0 otherwise.
  function applyBoolean(polys, poly, op) {
    const PC = window.polygonClipping;
    if (!PC) return 0;
    const ring = (pts) => [...pts, pts[0]];
    const open = (r) => r.slice(0, -1).map(([x, y]) => [round3(x), round3(y)]);
    const area = (mp) => mp.reduce((t, pg) => t + pg.reduce((u, r, k) => u + (k ? -1 : 1) * shoelace(r.slice(0, -1)), 0), 0);
    const mine = polys.map((q, i) => i).filter((i) => (polys[i].label || "") === (poly.label || ""));
    const solids = mine.filter((i) => !polys[i].hole), holes = mine.filter((i) => polys[i].hole);
    if (!solids.length) return 0;
    try {
      let G = PC.union(...solids.map((i) => [ring(polys[i].points)]));
      if (holes.length) G = PC.difference(G, ...holes.map((i) => [ring(polys[i].points)]));
      const P = [ring(poly.points)];
      if (area(PC.intersection(G, P)) <= 0.5) return 0;
      const R = op === "union" ? PC.union(G, P) : PC.difference(G, P);
      for (const i of mine.sort((a, b) => b - a)) polys.splice(i, 1);
      let first = -1;
      for (const pg of R) pg.forEach((r, k) => {
        const pts = open(r);
        if (pts.length < 3) return;
        polys.push({ label: poly.label, hole: k > 0, points: pts });
        if (first < 0 && k === 0) first = polys.length - 1;
      });
      selected = op === "union" ? first : -1;
      return 1;
    } catch (err) { return 0; }
  }
  const round3 = (v) => Math.round(v * 1000) / 1000;
  function deleteSelected() {
    if (cur < 0 || selected < 0) return;
    pushUndo();
    annotations[images[cur].key].polygons.splice(selected, 1);
    selected = -1; changed();
  }
  function toggleHole() {
    if (cur < 0 || selected < 0) return;
    pushUndo();
    const p = annotations[images[cur].key].polygons[selected];
    p.hole = !p.hole; changed();
  }
  function toggleSkip() {
    if (cur < 0) return;
    const a = annotations[images[cur].key];
    if (a.skip) { a.skip = false; a.skipReason = ""; }
    else {
      const r = prompt("Reason this image is unusable (e.g. truncated, out of focus, multiple organisms):", "truncated");
      if (r === null) return;
      a.skip = true; a.skipReason = r;
    }
    changed();
  }
  function hitVertex(sx, sy, polyIdx) {
    const polys = annotations[images[cur].key].polygons;
    const order = polyIdx >= 0 ? [polyIdx] : polys.map((_, i) => i).reverse();
    for (const pi of order) {
      const pts = polys[pi].points;
      for (let vi = 0; vi < pts.length; vi++) {
        const [x, y] = toScr(pts[vi][0], pts[vi][1]);
        if (Math.hypot(x - sx, y - sy) <= HIT_PX) return { pi, vi };
      }
    }
    return null;
  }
  // nearest polygon edge within HIT_PX (selected polygon first); returns {pi, i, x, y} with (x, y) the
  // projection of the cursor onto that edge in image coordinates
  function hitEdge(sx, sy) {
    const polys = annotations[images[cur].key].polygons;
    const order = selected >= 0 ? [selected, ...polys.map((_, i) => i).filter((i) => i !== selected)] : polys.map((_, i) => i).reverse();
    for (const pi of order) {
      const pts = polys[pi].points;
      let best = -1, bd = HIT_PX, bt = 0;
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = toScr(...pts[i]), [x2, y2] = toScr(...pts[(i + 1) % pts.length]);
        const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((sx - x1) * dx + (sy - y1) * dy) / l2)) : 0;
        const d = Math.hypot(sx - (x1 + t * dx), sy - (y1 + t * dy));
        if (d < bd) { bd = d; best = i; bt = t; }
      }
      if (best >= 0) {
        const [ax, ay] = pts[best], [bx, by] = pts[(best + 1) % pts.length];
        return { pi, i: best, x: ax + bt * (bx - ax), y: ay + bt * (by - ay) };
      }
    }
    return null;
  }
  function hitPoly(ix, iy) {
    const polys = annotations[images[cur].key].polygons;
    let best = -1, bestA = Infinity;
    polys.forEach((p, i) => {
      if (pointInPoly(ix, iy, p.points)) { const a = shoelace(p.points); if (a < bestA) { bestA = a; best = i; } }
    });
    return best;
  }

  // ---------- view ----------
  function resize() {
    const dpr = window.devicePixelRatio || 1, r = wrap.getBoundingClientRect();
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  function fit() {
    if (cur < 0) return;
    const im = images[cur], r = wrap.getBoundingClientRect(), pad = 24;
    view.s = Math.min((r.width - pad * 2) / im.w, (r.height - pad * 2) / im.h);
    if (!isFinite(view.s) || view.s <= 0) view.s = 1;
    view.tx = (r.width - im.w * view.s) / 2; view.ty = (r.height - im.h * view.s) / 2;
    draw();
  }
  function zoomAt(sx, sy, factor) {
    const ns = Math.max(0.05, Math.min(80, view.s * factor));
    const [ix, iy] = toImg(sx, sy);
    view.s = ns; view.tx = sx - ix * ns; view.ty = sy - iy * ns;
    draw();
  }

  // ---------- rendering ----------
  function pathPoly(pts, close) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => { const [sx, sy] = toScr(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    if (close) ctx.closePath();
  }
  function draw() {
    const r = wrap.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    if (cur < 0) return updateStatus();
    const im = images[cur];
    ctx.save();
    ctx.imageSmoothingEnabled = view.s < 2;
    if ("filter" in ctx) ctx.filter = `brightness(${display.bright}%) contrast(${display.contr}%)${display.invert ? " invert(1)" : ""}`;
    ctx.drawImage(im.img, view.tx, view.ty, im.w * view.s, im.h * view.s);
    ctx.restore();

    const polys = annotations[im.key].polygons;
    // Fill: one path with solids wound one way and holes the other, filled with the nonzero rule, so holes
    // are cut out (the image shows through) while overlapping solids still fill.
    const signedArea = (pts) => { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n]; a += x1 * y2 - x2 * y1; } return a / 2; };
    const addRing = (pts, positive) => {
      const ring = (signedArea(pts) > 0) === positive ? pts : [...pts].reverse();
      ring.forEach(([x, y], k) => { const [sx, sy] = toScr(x, y); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.closePath();
    };
    const fillArea = (solidIdx, alpha) => {
      ctx.beginPath();
      solidIdx.forEach((i) => addRing(polys[i].points, true));
      polys.forEach((p) => { if (p.hole) addRing(p.points, false); });
      ctx.fillStyle = `rgba(0,229,255,${alpha})`; ctx.fill("nonzero");
    };
    const solids = polys.map((p, i) => i).filter((i) => !polys[i].hole);
    if (display.fill && solids.length) fillArea(solids, 0.16);
    const hotSolid = [hoverP, selected].filter((i) => i >= 0 && polys[i] && !polys[i].hole);
    if (hotSolid.length) fillArea([...new Set(hotSolid)], 0.20);
    // Outlines: solids and holes share the contour colour (a hole reads as the inner edge of the area);
    // the selected polygon is yellow and the hovered one is drawn thicker.
    polys.forEach((p, i) => {
      const col = i === selected ? "#ffd400" : "#00e5ff";
      pathPoly(p.points, true);
      ctx.lineWidth = i === selected || i === hoverP ? 2.5 : 1.5; ctx.strokeStyle = col;
      ctx.stroke();
      if (mode === "edit" && (i === selected || selected < 0)) drawVertices(p.points, col, hoverV && hoverV.pi === i ? hoverV.vi : -1);
    });

    if (drawing && drawing.pts.length) {
      const pts = drawing.pts;
      pathPoly(pts, false);
      if (pointer.inside && !(drag && drag.kind === "free")) {
        const [ix, iy] = toImg(pointer.x, pointer.y); const [sx, sy] = toScr(ix, iy); ctx.lineTo(sx, sy);
      }
      const dcol = drawing.subtract ? "#ff4d4d" : "#7CFC00";
      ctx.strokeStyle = dcol; ctx.lineWidth = 1.5; ctx.stroke();
      drawVertices(pts, dcol);
      const [fx, fy] = toScr(pts[0][0], pts[0][1]);
      if (pts.length >= 3 && Math.hypot(fx - pointer.x, fy - pointer.y) <= HIT_PX) {
        ctx.beginPath(); ctx.arc(fx, fy, HIT_PX, 0, Math.PI * 2); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    updateStatus();
  }
  function drawVertices(pts, col, hi = -1) {
    const step = pts.length > 400 && view.s < 3 ? Math.ceil(pts.length / 400) : 1;
    ctx.fillStyle = col;
    for (let i = 0; i < pts.length; i += step) {
      const [sx, sy] = toScr(pts[i][0], pts[i][1]);
      ctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);
    }
    if (hi >= 0 && hi < pts.length) {
      // hovered vertex: larger square with a white outline (right-click or Alt+click deletes it)
      const [sx, sy] = toScr(pts[hi][0], pts[hi][1]);
      ctx.fillRect(sx - 6, sy - 6, 12, 12);
      ctx.lineWidth = 2; ctx.strokeStyle = "#ffffff"; ctx.strokeRect(sx - 6, sy - 6, 12, 12);
    }
  }
  function deleteVertex(pi, vi) {
    const pts = annotations[images[cur].key].polygons[pi].points;
    if (pts.length <= 3) { flash("A polygon needs at least 3 vertices; delete the polygon instead (Del)."); return; }
    pushUndo(); pts.splice(vi, 1); hoverV = null; changed();
  }
  let flashTimer = 0, flashUntil = 0;
  function flash(msg) {
    flashUntil = performance.now() + 2500;
    $("stHint").textContent = msg; $("stHint").style.color = "#e0a030";
    clearTimeout(flashTimer); flashTimer = setTimeout(() => { flashUntil = 0; $("stHint").style.color = ""; draw(); }, 2500);
  }
  function updateStatus() {
    if (cur < 0) { $("stFile").textContent = "—"; $("stArea").textContent = "Area: —"; $("stHint").textContent = ""; $("clsChip").textContent = ""; return; }
    const im = images[cur], a = annotations[im.key], st = stats(a);
    $("stFile").textContent = `${cur + 1}/${images.length} · ${im.key}${im.cls ? "  [" + im.cls + "]" : ""} · ${im.w}×${im.h}`;
    $("clsChip").textContent = `Class: ${im.cls || "—"}  ·  ${im.name}`;
    $("stArea").textContent = a.skip ? `UNUSABLE (${a.skipReason})` :
      `Area: ${st.area.toFixed(1)} px² · ${st.mm2.toFixed(4)} mm² · ${st.nPolys} poly${st.nHoles ? ` − ${st.nHoles} hole` : ""}`;
    if (pointer.inside) {
      const [ix, iy] = toImg(pointer.x, pointer.y);
      $("stCursor").textContent = `x ${ix.toFixed(1)}  y ${iy.toFixed(1)}  zoom ${(view.s * 100).toFixed(0)}%`;
    }
    const drawHint = drawing ? `${drawing.subtract ? "SUBTRACT · " : ""}${drawing.pts.length} vertices · click first vertex / Enter to close · right-click or Backspace: undo vertex · Esc cancel` : null;
    const hint = mode === "draw" ? (drawHint || "DRAW · click to add vertices (also inside an area: overlapping polygons merge) · Shift+drag to trace · Alt+first click subtracts one polygon")
      : mode === "subtract" ? (drawHint || "SUBTRACT · draw over the part to remove; a polygon fully inside an area makes a hole")
      : (selected >= 0 ? "EDIT · drag vertices · double-click a line to add a vertex · right-click a highlighted vertex to delete it · Del deletes the polygon" : "EDIT · click an area to select it");
    if (performance.now() >= flashUntil) $("stHint").textContent = hint;
    $("zoomPct").textContent = `${Math.round(view.s * 100)}%`;
    $("modeDraw").classList.toggle("active", mode === "draw");
    $("modeSub").classList.toggle("active", mode === "subtract"); $("modeSub").classList.toggle("danger", mode === "subtract");
    $("modeEdit").classList.toggle("active", mode === "edit");
    $("delBtn").disabled = !(mode === "edit" && selected >= 0);
  }
  function renderList() {
    const ul = $("imageList"); ul.textContent = "";
    let done = 0, skip = 0;
    images.forEach((im, i) => {
      const a = annotations[im.key];
      const state = a.skip ? "skip" : a.polygons.length ? "done" : "";
      if (state === "done") done++; if (state === "skip") skip++;
      const li = document.createElement("li");
      if (i === cur) li.className = "current";
      const dot = document.createElement("span"); dot.className = "dot " + state;
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = im.key; nm.title = im.key;
      li.append(dot, nm); li.onclick = () => go(i);
      ul.append(li);
    });
    $("progress").textContent = images.length ? `${done}/${images.length} done · ${skip} unusable` : "";
    const curLi = ul.children[cur]; if (curLi) curLi.scrollIntoView({ block: "nearest" });
  }

  // ---------- pointer ----------
  function localXY(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("pointerdown", (e) => {
    if (cur < 0) return;
    cv.setPointerCapture(e.pointerId);
    const [sx, sy] = localXY(e), [ix, iy] = toImg(sx, sy);
    if (e.button === 1 || e.button === 2 || spaceDown) { drag = { kind: "pan", sx, sy, tx: view.tx, ty: view.ty, button: e.button, moved: false }; return; }
    if (e.button !== 0) return;
    if (mode === "draw" || mode === "subtract") {
      if (drawing && drawing.pts.length >= 3) {
        const [fx, fy] = toScr(drawing.pts[0][0], drawing.pts[0][1]);
        if (Math.hypot(fx - sx, fy - sy) <= HIT_PX) return closeDrawing();
      }
      // Draw and Subtract always draw, also inside existing areas; Alt on the first click of a Draw
      // trace makes that single polygon a subtraction
      if (!drawing) { drawing = { pts: [], subtract: mode === "subtract" || e.altKey }; selected = -1; hoverP = -1; }
      drawing.pts.push(clampPt([ix, iy], images[cur].w, images[cur].h));
      if (e.shiftKey) drag = { kind: "free", lx: sx, ly: sy };
      draw();
    } else {
      const hv = hitVertex(sx, sy, selected) || hitVertex(sx, sy, -1);
      if (hv) {
        const polys = annotations[images[cur].key].polygons;
        selected = hv.pi;
        if (e.altKey) { deleteVertex(hv.pi, hv.vi); return; }
        pushUndo();
        drag = { kind: "vertex", pi: hv.pi, vi: hv.vi };
      } else {
        const he = hitEdge(sx, sy);
        selected = he ? he.pi : hitPoly(ix, iy);
      }
      draw();
    }
  });
  cv.addEventListener("pointermove", (e) => {
    const [sx, sy] = localXY(e);
    pointer = { x: sx, y: sy, inside: true };
    if (!drag) {
      if (mode !== "edit" || cur < 0) { hoverP = -1; hoverV = null; cv.style.cursor = "crosshair"; return draw(); }
      const hv = hitVertex(sx, sy, selected) || hitVertex(sx, sy, -1);
      hoverV = hv;
      if (hv) hoverP = -1;
      else { const he = hitEdge(sx, sy); const [ix, iy] = toImg(sx, sy); hoverP = he ? he.pi : hitPoly(ix, iy); }
      cv.style.cursor = hv || hoverP >= 0 ? "pointer" : "default";
      return draw();
    }
    if (drag.kind === "pan") {
      if (Math.hypot(sx - drag.sx, sy - drag.sy) > 4) drag.moved = true;
      view.tx = drag.tx + sx - drag.sx; view.ty = drag.ty + sy - drag.sy;
    }
    else if (drag.kind === "free") {
      if (Math.hypot(sx - drag.lx, sy - drag.ly) >= FREEHAND_STEP) { drawing.pts.push(clampPt(toImg(sx, sy), images[cur].w, images[cur].h)); drag.lx = sx; drag.ly = sy; }
    } else if (drag.kind === "vertex") {
      const [ix, iy] = toImg(sx, sy);
      const [cx, cy] = clampPt([ix, iy], images[cur].w, images[cur].h);
      annotations[images[cur].key].polygons[drag.pi].points[drag.vi] = [round3(cx), round3(cy)];
    }
    draw();
  });
  cv.addEventListener("pointerup", () => {
    if (drag && drag.kind === "vertex") changed();
    // a right-click without dragging removes the last vertex of the polygon being drawn (right-drag still pans)
    if (drag && drag.kind === "pan" && drag.button === 2 && !drag.moved && drawing) {
      drawing.pts.pop(); if (!drawing.pts.length) drawing = null; draw();
    } else if (drag && drag.kind === "pan" && drag.button === 2 && !drag.moved && mode === "edit" && hoverV) {
      // right-click on the highlighted vertex of a closed polygon deletes it; its neighbours are joined
      deleteVertex(hoverV.pi, hoverV.vi);
    }
    drag = null;
  });
  cv.addEventListener("pointerleave", () => { pointer.inside = false; hoverV = null; draw(); });
  cv.addEventListener("dblclick", (e) => {
    if (cur < 0) return;
    const [sx, sy] = localXY(e);
    if ((mode === "draw" || mode === "subtract") && drawing) {
      // the two clicks of a double-click added two near-identical vertices
      const p = drawing.pts;
      while (p.length >= 2) {
        const [ax, ay] = toScr(...p[p.length - 1]), [bx, by] = toScr(...p[p.length - 2]);
        if (Math.hypot(ax - bx, ay - by) < 4) p.pop(); else break;
      }
      return closeDrawing();
    }
    if (mode === "edit") {
      if (hitVertex(sx, sy, -1)) return;            // double-click on an existing vertex: nothing to split
      const he = hitEdge(sx, sy);
      if (he) {
        // split the edge at the clicked spot: the new vertex sits exactly on the line between its neighbours
        pushUndo();
        annotations[images[cur].key].polygons[he.pi].points.splice(he.i + 1, 0, [round3(he.x), round3(he.y)]);
        selected = he.pi; hoverV = { pi: he.pi, vi: he.i + 1 };
        changed();
      }
    }
  });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (cur < 0) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? wrap.clientHeight : 1;  // lines/pages -> px
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      // Shift+wheel zooms (macOS turns Shift+wheel into horizontal deltas, so use whichever axis moved);
      // ctrlKey is also what trackpad pinch gestures report.
      const [sx, sy] = localXY(e);
      const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
      zoomAt(sx, sy, Math.exp(-d * (e.ctrlKey ? 0.01 : 0.0015)));
    } else {
      // plain wheel pans: vertical wheel moves up/down, horizontal wheel (or tilt) moves left/right
      view.tx -= dx; view.ty -= dy;
      draw();
    }
  }, { passive: false });

  // ---------- keyboard ----------
  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea") || $("help").open) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.code === "Space") { spaceDown = true; e.preventDefault(); return; }
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); return redo(); }
    if (mod) return;
    switch (e.key) {
      case "Enter": closeDrawing(); break;
      case "Escape": drawing = null; selected = -1; draw(); break;
      case "Backspace": if (drawing) { e.preventDefault(); drawing.pts.pop(); if (!drawing.pts.length) drawing = null; draw(); } else if (mode === "edit") deleteSelected(); break;
      case "Delete": if (mode === "edit") deleteSelected(); break;
      case "d": case "D": setMode("draw"); break;
      case "s": case "S": setMode("subtract"); break;
      case "e": case "E": setMode("edit"); break;
      case "h": case "H": if (mode === "edit") toggleHole(); break;
      case "f": case "F": case "0": fit(); break;
      case "1": zoomTo100(); break;
      case "+": case "=": zoomCentre(1.25); break;
      case "-": case "_": zoomCentre(1 / 1.25); break;
      case "x": case "X": toggleSkip(); break;
      case "ArrowRight": case "n": case "N": go(cur + 1); break;
      case "ArrowLeft": case "p": case "P": go(cur - 1); break;
      case "?": $("help").showModal(); break;
    }
  });
  window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceDown = false; });

  // ---------- export ----------
  async function rasterMask(key) {
    const a = annotations[key];
    const c = document.createElement("canvas"); c.width = a.w; c.height = a.h;
    const g = c.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, a.w, a.h);
    const fillPolys = (hole) => {
      g.fillStyle = hole ? "#000" : "#fff";
      for (const p of a.polygons.filter((q) => !!q.hole === hole)) {
        g.beginPath(); p.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
      }
    };
    fillPolys(false); fillPolys(true);
    const id = g.getImageData(0, 0, a.w, a.h), d = id.data;
    let count = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] >= 128 ? 255 : 0; if (v) count++;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), count };
  }
  function exportObject(maskCounts) {
    flushTime();
    for (const a of Object.values(annotations)) clipAnnotation(a);
    const keys = images.length ? images.map((im) => im.key) : Object.keys(annotations);
    return {
      tool: TOOL, exported: new Date().toISOString(), annotator: settings.annotator,
      um_per_px: Number(settings.umpp), coordinate_convention: "continuous image-pixel coordinates; pixel (i,j) spans [i,i+1)x[j,j+1); origin top-left",
      images: keys.map((k) => {
        const a = annotations[k], st = stats(a), im = images.find((x) => x.key === k);
        const o = {
          file: k.split("/").pop(), rel_path: k, class: im ? im.cls : (k.includes("/") ? k.split("/").slice(-2, -1)[0] : ""),
          width: a.w, height: a.h, status: a.skip ? "unusable" : a.polygons.length ? "annotated" : "todo",
          unusable_reason: a.skipReason || "", time_s: Math.round(a.timeMs / 100) / 10,
          area_px_polygon: round3(st.area), area_mm2_polygon: st.mm2, perimeter_px: round3(st.per),
          area_px_by_label: byLabel(a),
          polygons: a.polygons,
        };
        if (maskCounts && k in maskCounts) { o.area_px_mask = maskCounts[k]; o.area_mm2_mask = maskCounts[k] * Math.pow(Number(settings.umpp), 2) / 1e6; }
        return o;
      }),
    };
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
  function toCsv(obj) {
    const cols = ["rel_path", "file", "class", "status", "unusable_reason", "width", "height", "n_polygons", "n_holes", "area_px_polygon", "area_mm2_polygon", "area_px_mask", "area_mm2_mask", "area_px_by_label", "perimeter_px", "time_s"];
    const esc = (v) => { const s = v === undefined || v === null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = obj.images.map((r) => {
      const ext = Object.assign({}, r, { n_polygons: r.polygons.filter((p) => !p.hole).length, n_holes: r.polygons.filter((p) => p.hole).length,
        area_px_by_label: Object.entries(r.area_px_by_label || {}).map(([k, v]) => `${k}=${v}`).join(";") });
      return cols.map((c) => esc(ext[c])).join(",");
    });
    return `# ${TOOL.name} ${TOOL.version} | annotator=${obj.annotator} | um_per_px=${obj.um_per_px} | ${obj.exported}\n` + cols.join(",") + "\n" + rows.join("\n") + "\n";
  }
  function download(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  $("exportJson").onclick = () => download(new Blob([JSON.stringify(exportObject(), null, 1)], { type: "application/json" }), `annotations_${stamp()}.json`);
  $("exportCsv").onclick = () => download(new Blob([toCsv(exportObject())], { type: "text/csv" }), `areas_${stamp()}.csv`);
  $("exportZip").onclick = async () => {
    const z = new ZipWriter(), counts = {};
    for (const [k, a] of Object.entries(annotations)) {
      if (a.skip || !a.polygons.length || !a.w) continue;
      const { bytes, count } = await rasterMask(k);
      counts[k] = count;
      z.add("masks/" + k.replace(/\.[^.\/]+$/, "") + "_mask.png", bytes);
    }
    const obj = exportObject(counts);
    z.add("annotations.json", JSON.stringify(obj, null, 1));
    z.add("areas.csv", toCsv(obj));
    download(z.blob(), `morphotrace_${stamp()}.zip`);
  };

  // ---------- import ----------
  $("jsonInput").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      let n = 0;
      for (const r of obj.images || []) {
        const key = images.find((im) => im.key === r.rel_path)?.key || images.find((im) => im.name === r.file)?.key || r.rel_path;
        annotations[key] = { polygons: r.polygons || [], skip: r.status === "unusable", skipReason: r.unusable_reason || "", timeMs: (r.time_s || 0) * 1000, w: r.width || 0, h: r.height || 0 };
        n++;
      }
      if (obj.um_per_px) { settings.umpp = obj.um_per_px; $("umpp").value = obj.um_per_px; }
      if (obj.annotator && !settings.annotator) { settings.annotator = obj.annotator; $("annotator").value = obj.annotator; }
      for (const a of Object.values(annotations)) clipAnnotation(a);
      changed();
      alert(`Imported annotations for ${n} images.`);
    } catch (err) { alert("Could not read JSON: " + err.message); }
    e.target.value = "";
  };

  // ---------- wiring ----------
  $("fileInput").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
  $("dirInput").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
  wrap.addEventListener("dragover", (e) => { e.preventDefault(); wrap.classList.add("dragover"); });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("dragover"));
  wrap.addEventListener("drop", (e) => { e.preventDefault(); wrap.classList.remove("dragover"); addFiles(e.dataTransfer.files); });
  function setMode(m) {
    if (m === mode) return;
    // switching mode closes a valid trace in progress (as a polygon of the mode it was started in)
    if (drawing && drawing.pts.length >= 3) closeDrawing();
    drawing = null; selected = -1; hoverP = -1; hoverV = null;
    mode = m; cv.style.cursor = m === "edit" ? "default" : "crosshair";
    draw();
  }
  // side panel toggle (shown on narrow screens; collapsed by default on phones)
  const sidebar = $("sidebar");
  const setPanel = (open) => { sidebar.classList.toggle("collapsed", !open); $("panelBtn").setAttribute("aria-expanded", String(open)); resize(); };
  $("panelBtn").onclick = () => setPanel(sidebar.classList.contains("collapsed"));
  if (window.matchMedia("(max-width: 760px)").matches) setPanel(false);
  window.matchMedia("(max-width: 760px)").addEventListener("change", (e) => setPanel(!e.matches));
  $("modeDraw").onclick = () => setMode("draw");
  $("modeSub").onclick = () => setMode("subtract");
  $("modeEdit").onclick = () => setMode("edit");
  $("delBtn").onclick = deleteSelected;
  $("undoBtn").onclick = undo;
  $("redoBtn").onclick = redo;
  const zoomCentre = (f) => { const r = wrap.getBoundingClientRect(); if (cur >= 0) zoomAt(r.width / 2, r.height / 2, f); };
  const zoomTo100 = () => { if (cur >= 0) zoomCentre(1 / view.s); };
  $("zoomIn").onclick = () => zoomCentre(1.25);
  $("zoomOut").onclick = () => zoomCentre(1 / 1.25);
  $("zoomPct").onclick = fit;
  $("zoomPct").ondblclick = zoomTo100;
  $("skipBtn").onclick = toggleSkip;
  $("prevBtn").onclick = () => go(cur - 1);
  $("nextBtn").onclick = () => go(cur + 1);
  $("helpBtn").onclick = () => $("help").showModal();
  $("mergePolys").addEventListener("change", (e) => { settings.merge = e.target.checked; save(); });
  for (const id of ["annotator", "umpp", "label"]) {
    $(id).addEventListener("input", (e) => { settings[id] = e.target.value; save(); draw(); });
  }
  const bindDisplay = (id, key, prop = "value") => $(id).addEventListener("input", (e) => { display[key] = prop === "checked" ? e.target.checked : Number(e.target.value); draw(); });
  bindDisplay("bright", "bright"); bindDisplay("contr", "contr"); bindDisplay("invert", "invert", "checked"); bindDisplay("fillPolys", "fill", "checked");
  $("resetView").onclick = () => { display = { bright: 100, contr: 100, invert: false, fill: display.fill }; $("bright").value = 100; $("contr").value = 100; $("invert").checked = false; draw(); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { flushTime(); save(); } else shownAt = performance.now(); });
  window.addEventListener("beforeunload", () => { flushTime(); try { localStorage.setItem(STORE_KEY, JSON.stringify({ settings, annotations })); } catch (e) { /* ignore */ } });
  new ResizeObserver(resize).observe(wrap);

  // colour theme: "light", "dark" or "auto" (follow the system); stored per browser
  function applyTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const sw = document.querySelector(".theme-switch");
    sw.dataset.value = t;
    sw.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeChoice === t)));
    try { localStorage.setItem("morphotrace.theme", t); } catch (e) { /* ignore */ }
    draw();
  }
  document.querySelectorAll(".theme-switch button").forEach((b) => (b.onclick = () => applyTheme(b.dataset.themeChoice)));
  let storedTheme = "auto";
  try { storedTheme = localStorage.getItem("morphotrace.theme") || "auto"; } catch (e) { /* ignore */ }
  applyTheme(storedTheme);

  loadStore();
  $("annotator").value = settings.annotator; $("umpp").value = settings.umpp; $("label").value = settings.label;
  $("mergePolys").checked = settings.merge !== false;
  resize();

  // exposed for automated tests
  window.__morphotrace = { shoelace, stats, get annotations() { return annotations; }, get view() { return view; } };
})();
