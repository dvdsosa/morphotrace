// MorphoTrace — dependency-free polygon annotation for projected-area ground truth.
// Coordinates are stored in continuous image-pixel space: pixel (i, j) spans [i, i+1) x [j, j+1).
(function () {
  "use strict";

  const TOOL = { name: "MorphoTrace", version: "0.1.0" };
  const STORE_KEY = "morphotrace.v1";
  const HIT_PX = 8;          // screen-space hit tolerance
  const FREEHAND_STEP = 3;   // screen px between freehand samples

  const $ = (id) => document.getElementById(id);
  const cv = $("cv"), ctx = cv.getContext("2d"), wrap = $("wrap");

  // ---------- state ----------
  const images = [];               // {key, name, cls, url, img, w, h}
  let annotations = {};            // key -> {polygons, skip, skipReason, timeMs, w, h}
  let settings = { annotator: "", umpp: 7.38, label: "organism" };
  let cur = -1;
  let mode = "draw";
  let drawing = null;              // {pts: [[x,y], ...]}
  let selected = -1;
  let view = { s: 1, tx: 0, ty: 0 };
  let display = { bright: 100, contr: 100, invert: false, fill: true };
  let pointer = { x: 0, y: 0, inside: false };
  let drag = null;                 // {kind: 'pan'|'vertex'|'free', ...}
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
      img.onload = () => { im.img = img; im.w = img.naturalWidth; im.h = img.naturalHeight; const a = annotations[im.key]; a.w = im.w; a.h = im.h; resolve(img); };
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
    pushUndo();
    const polys = annotations[images[cur].key].polygons;
    polys.push({ label: settings.label || "organism", hole: false, points: drawing.pts.map(([x, y]) => [round3(x), round3(y)]) });
    selected = polys.length - 1;
    drawing = null;
    changed();
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
    polys.forEach((p, i) => {
      const col = i === selected ? "#ffd400" : p.hole ? "#ff4fd8" : "#00e5ff";
      pathPoly(p.points, true);
      if (display.fill) { ctx.fillStyle = p.hole ? "rgba(255,79,216,0.18)" : "rgba(0,229,255,0.16)"; ctx.fill(); }
      ctx.lineWidth = i === selected ? 2 : 1.5; ctx.strokeStyle = col;
      if (p.hole) ctx.setLineDash([5, 4]);
      ctx.stroke(); ctx.setLineDash([]);
      if (mode === "edit" && (i === selected || selected < 0)) drawVertices(p.points, col);
    });

    if (drawing && drawing.pts.length) {
      const pts = drawing.pts;
      pathPoly(pts, false);
      if (pointer.inside && !(drag && drag.kind === "free")) {
        const [ix, iy] = toImg(pointer.x, pointer.y); const [sx, sy] = toScr(ix, iy); ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = "#7CFC00"; ctx.lineWidth = 1.5; ctx.stroke();
      drawVertices(pts, "#7CFC00");
      const [fx, fy] = toScr(pts[0][0], pts[0][1]);
      if (pts.length >= 3 && Math.hypot(fx - pointer.x, fy - pointer.y) <= HIT_PX) {
        ctx.beginPath(); ctx.arc(fx, fy, HIT_PX, 0, Math.PI * 2); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    updateStatus();
  }
  function drawVertices(pts, col) {
    const step = pts.length > 400 && view.s < 3 ? Math.ceil(pts.length / 400) : 1;
    ctx.fillStyle = col;
    for (let i = 0; i < pts.length; i += step) {
      const [sx, sy] = toScr(pts[i][0], pts[i][1]);
      ctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);
    }
  }
  function updateStatus() {
    if (cur < 0) { $("stFile").textContent = "—"; $("stArea").textContent = "Area: —"; $("stHint").textContent = ""; return; }
    const im = images[cur], a = annotations[im.key], st = stats(a);
    $("stFile").textContent = `${cur + 1}/${images.length} · ${im.key}${im.cls ? "  [" + im.cls + "]" : ""} · ${im.w}×${im.h}`;
    $("stArea").textContent = a.skip ? `UNUSABLE (${a.skipReason})` :
      `Area: ${st.area.toFixed(1)} px² · ${st.mm2.toFixed(4)} mm² · ${st.nPolys} poly${st.nHoles ? ` − ${st.nHoles} hole` : ""}`;
    if (pointer.inside) {
      const [ix, iy] = toImg(pointer.x, pointer.y);
      $("stCursor").textContent = `x ${ix.toFixed(1)}  y ${iy.toFixed(1)}  zoom ${(view.s * 100).toFixed(0)}%`;
    }
    $("stHint").textContent = mode === "draw"
      ? (drawing ? `${drawing.pts.length} vertices · click first vertex / Enter to close · Backspace undo vertex · Esc cancel` : "Click to start a polygon · Shift+drag to trace")
      : (selected >= 0 ? "Drag vertices · double-click edge to insert · Alt+click vertex to delete · H hole · Del delete" : "Click a polygon to select it");
    $("modeDraw").classList.toggle("active", mode === "draw");
    $("modeEdit").classList.toggle("active", mode === "edit");
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
    $("progress").textContent = images.length ? `${done} done · ${skip} unusable · ${images.length}` : "";
    const curLi = ul.children[cur]; if (curLi) curLi.scrollIntoView({ block: "nearest" });
  }

  // ---------- pointer ----------
  function localXY(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("pointerdown", (e) => {
    if (cur < 0) return;
    cv.setPointerCapture(e.pointerId);
    const [sx, sy] = localXY(e), [ix, iy] = toImg(sx, sy);
    if (e.button === 1 || e.button === 2 || spaceDown) { drag = { kind: "pan", sx, sy, tx: view.tx, ty: view.ty }; return; }
    if (e.button !== 0) return;
    if (mode === "draw") {
      if (drawing && drawing.pts.length >= 3) {
        const [fx, fy] = toScr(drawing.pts[0][0], drawing.pts[0][1]);
        if (Math.hypot(fx - sx, fy - sy) <= HIT_PX) return closeDrawing();
      }
      if (!drawing) { drawing = { pts: [] }; selected = -1; }
      drawing.pts.push([ix, iy]);
      if (e.shiftKey) drag = { kind: "free", lx: sx, ly: sy };
      draw();
    } else {
      const hv = hitVertex(sx, sy, selected) || hitVertex(sx, sy, -1);
      if (hv) {
        const polys = annotations[images[cur].key].polygons;
        selected = hv.pi;
        if (e.altKey) {
          if (polys[hv.pi].points.length > 3) { pushUndo(); polys[hv.pi].points.splice(hv.vi, 1); changed(); }
          return;
        }
        pushUndo();
        drag = { kind: "vertex", pi: hv.pi, vi: hv.vi };
      } else {
        selected = hitPoly(ix, iy);
      }
      draw();
    }
  });
  cv.addEventListener("pointermove", (e) => {
    const [sx, sy] = localXY(e);
    pointer = { x: sx, y: sy, inside: true };
    if (!drag) return draw();
    if (drag.kind === "pan") { view.tx = drag.tx + sx - drag.sx; view.ty = drag.ty + sy - drag.sy; }
    else if (drag.kind === "free") {
      if (Math.hypot(sx - drag.lx, sy - drag.ly) >= FREEHAND_STEP) { drawing.pts.push(toImg(sx, sy)); drag.lx = sx; drag.ly = sy; }
    } else if (drag.kind === "vertex") {
      const [ix, iy] = toImg(sx, sy);
      annotations[images[cur].key].polygons[drag.pi].points[drag.vi] = [round3(ix), round3(iy)];
    }
    draw();
  });
  cv.addEventListener("pointerup", () => { if (drag && drag.kind === "vertex") changed(); drag = null; });
  cv.addEventListener("pointerleave", () => { pointer.inside = false; draw(); });
  cv.addEventListener("dblclick", (e) => {
    if (cur < 0) return;
    const [sx, sy] = localXY(e);
    if (mode === "draw" && drawing) {
      // the two clicks of a double-click added two near-identical vertices
      const p = drawing.pts;
      while (p.length >= 2) {
        const [ax, ay] = toScr(...p[p.length - 1]), [bx, by] = toScr(...p[p.length - 2]);
        if (Math.hypot(ax - bx, ay - by) < 4) p.pop(); else break;
      }
      return closeDrawing();
    }
    if (mode === "edit" && selected >= 0) {
      const pts = annotations[images[cur].key].polygons[selected].points;
      let best = -1, bd = HIT_PX;
      for (let i = 0; i < pts.length; i++) {
        const d = distToSeg(sx, sy, toScr(...pts[i]), toScr(...pts[(i + 1) % pts.length]));
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) { pushUndo(); const [ix, iy] = toImg(sx, sy); pts.splice(best + 1, 0, [round3(ix), round3(iy)]); changed(); }
    }
  });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [sx, sy] = localXY(e);
    zoomAt(sx, sy, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
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
      case "Backspace": if (drawing) { e.preventDefault(); drawing.pts.pop(); if (!drawing.pts.length) drawing = null; draw(); } else deleteSelected(); break;
      case "Delete": deleteSelected(); break;
      case "d": case "D": mode = "draw"; selected = -1; draw(); break;
      case "e": case "E": if (drawing && drawing.pts.length >= 3) closeDrawing(); drawing = null; mode = "edit"; draw(); break;
      case "h": case "H": toggleHole(); break;
      case "f": case "F": fit(); break;
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
  $("modeDraw").onclick = () => { mode = "draw"; selected = -1; draw(); };
  $("modeEdit").onclick = () => { if (drawing && drawing.pts.length >= 3) closeDrawing(); drawing = null; mode = "edit"; draw(); };
  $("holeBtn").onclick = toggleHole;
  $("delBtn").onclick = deleteSelected;
  $("undoBtn").onclick = undo;
  $("redoBtn").onclick = redo;
  $("fitBtn").onclick = fit;
  $("skipBtn").onclick = toggleSkip;
  $("prevBtn").onclick = () => go(cur - 1);
  $("nextBtn").onclick = () => go(cur + 1);
  $("helpBtn").onclick = () => $("help").showModal();
  for (const id of ["annotator", "umpp", "label"]) {
    $(id).addEventListener("input", (e) => { settings[id] = e.target.value; save(); draw(); });
  }
  const bindDisplay = (id, key, prop = "value") => $(id).addEventListener("input", (e) => { display[key] = prop === "checked" ? e.target.checked : Number(e.target.value); draw(); });
  bindDisplay("bright", "bright"); bindDisplay("contr", "contr"); bindDisplay("invert", "invert", "checked"); bindDisplay("fillPolys", "fill", "checked");
  $("resetView").onclick = () => { display = { bright: 100, contr: 100, invert: false, fill: display.fill }; $("bright").value = 100; $("contr").value = 100; $("invert").checked = false; draw(); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { flushTime(); save(); } else shownAt = performance.now(); });
  window.addEventListener("beforeunload", () => { flushTime(); try { localStorage.setItem(STORE_KEY, JSON.stringify({ settings, annotations })); } catch (e) { /* ignore */ } });
  new ResizeObserver(resize).observe(wrap);

  loadStore();
  $("annotator").value = settings.annotator; $("umpp").value = settings.umpp; $("label").value = settings.label;
  resize();

  // exposed for automated tests
  window.__morphotrace = { shoelace, stats, get annotations() { return annotations; }, get view() { return view; } };
})();
