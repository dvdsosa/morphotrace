// Performance benchmark (reports numbers; flags only clearly sluggish results). Self-contained: generates
// 150 noisy 800×600 JPEGs in the page (larger than DYB-PlanktonNet's images) and a 5000-vertex outline.
// Timings are measured inside the page around synchronously dispatched events, so they exclude test latency.
//   playwright-cli run-code --filename=tests/e2e/perf.e2e.js
async (page) => {
  const N = 150, W = 800, H = 600, NV = 5000;
  const results = [];
  const check = (check, ok, detail = "") => results.push({ check, ok: !!ok, detail: String(detail) });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("mt.reset")) { sessionStorage.removeItem("mt.reset"); localStorage.clear(); }
    // synthetic pointers have no real pointer id: Firefox would throw on capture and drop the click
    const realCapture = Element.prototype.setPointerCapture;
    Element.prototype.setPointerCapture = function (id) { try { realCapture.call(this, id); } catch (e) { /* synthetic pointer */ } };
  });
  await page.evaluate(() => sessionStorage.setItem("mt.reset", "1")); await page.reload();
  await page.evaluate(() => { window.alert = () => {}; window.confirm = () => true; window.prompt = () => null; }); // no native dialogs

  // ---------- load and navigate ----------
  const loadMs = await page.evaluate(async ([N, W, H]) => {
    const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
    const dt = new DataTransfer();
    for (let k = 0; k < N; k++) {
      const id = g.createImageData(W, H); for (let i = 0; i < id.data.length; i += 4) { const v = (Math.random() * 255) | 0; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
      g.putImageData(id, 0, 0);
      dt.items.add(new File([await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9))], `G${k % 9}/img_${String(k).padStart(3, "0")}.jpg`, { type: "image/jpeg" }));
    }
    const t0 = performance.now();
    document.getElementById("wrap").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
    for (let w = 0; document.getElementById("navPos").textContent.trim() !== `1 / ${N}`; w++) { if (w > 2000) throw new Error("images did not load"); await new Promise((r) => setTimeout(r, 5)); }
    return performance.now() - t0;
  }, [N, W, H]);
  check(`load ${N} images (${W}×${H}) until the first is shown`, loadMs < 3000, `${loadMs.toFixed(0)} ms`);

  const nav = await page.evaluate(async (N) => {
    const times = [];
    for (let k = 1; k < N; k++) {
      const t0 = performance.now();
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      for (let w = 0; document.getElementById("navPos").textContent.trim() !== `${k + 1} / ${N}`; w++) { if (w > 1000) throw new Error(`stuck at image ${k}`); await new Promise((r) => setTimeout(r, 1)); }
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { median: times[times.length >> 1], p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1] };
  }, N);
  check("next image (ArrowRight): median / p95 / max", nav.p95 < 200, `${nav.median.toFixed(1)} / ${nav.p95.toFixed(1)} / ${nav.max.toFixed(1)} ms`);

  // ---------- a 5000-vertex outline on every image (import JSON) ----------
  await page.evaluate(async ([N, W, H, NV]) => {
    const star = []; for (let i = 0; i < NV; i++) { const t = (2 * Math.PI * i) / NV, r = 200 + 40 * Math.sin(37 * t); star.push([+(W / 2 + r * Math.cos(t)).toFixed(3), +(H / 2 + r * Math.sin(t)).toFixed(3)]); }
    const images = []; for (let k = 0; k < N; k++) images.push({ rel_path: `G${k % 9}/img_${String(k).padStart(3, "0")}.jpg`, file: `img_${String(k).padStart(3, "0")}.jpg`, width: W, height: H, status: "annotated", polygons: [{ label: "organism", hole: false, points: star }] });
    const dt = new DataTransfer(); dt.items.add(new File([JSON.stringify({ um_per_px: 7.38, images })], "big.json", { type: "application/json" }));
    const inp = document.getElementById("jsonInput"); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  }, [N, W, H, NV]);
  await page.evaluate(() => { window.prompt = () => "1"; document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true })); });
  await page.waitForTimeout(300);

  const ptr = await page.evaluate(async () => {
    const cv = document.getElementById("cv"), r = cv.getBoundingClientRect();
    const fire = (type, x, y, extra = {}) => cv.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, bubbles: true, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, ...extra }));
    const key = (k) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    const time = (fn, n = 60) => { const ts = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(i); ts.push(performance.now() - t0); } ts.sort((a, b) => a - b); return ts[ts.length >> 1]; };
    const cx = r.width / 2, cy = r.height / 2;
    key("d"); const drawMove = time((i) => fire("pointermove", cx + (i % 40), cy - 100, { buttons: 0 }));
    key("e"); const editHover = time((i) => fire("pointermove", cx + 150 + (i % 40), cy, { buttons: 0 }));
    key("d");
    // union of a new square with the big outline
    const sq = [[cx + 180, cy - 30], [cx + 260, cy - 30], [cx + 260, cy + 30], [cx + 180, cy + 30]];
    for (const [x, y] of sq) { fire("pointerdown", x, y); fire("pointerup", x, y); }
    let t0 = performance.now(); key("Enter"); const unionMs = performance.now() - t0;
    key("s");
    const hole = [[cx - 20, cy - 20], [cx + 20, cy - 20], [cx + 20, cy + 20], [cx - 20, cy + 20]];
    for (const [x, y] of hole) { fire("pointerdown", x, y); fire("pointerup", x, y); }
    t0 = performance.now(); key("Enter"); const subtractMs = performance.now() - t0;
    t0 = performance.now(); document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true, bubbles: true })); const undoMs = performance.now() - t0;
    return { drawMove, editHover, unionMs, subtractMs, undoMs };
  });
  check(`redraw on pointer move, Draw mode (${NV} vertices)`, ptr.drawMove < 16, `${ptr.drawMove.toFixed(2)} ms median`);
  check(`hover hit-testing, Edit mode (${NV} vertices)`, ptr.editHover < 16, `${ptr.editHover.toFixed(2)} ms median`);
  check(`merge a new polygon into the ${NV}-vertex area`, ptr.unionMs < 200, `${ptr.unionMs.toFixed(1)} ms`);
  check(`subtract a hole from the ${NV}-vertex area`, ptr.subtractMs < 200, `${ptr.subtractMs.toFixed(1)} ms`);
  check("undo", ptr.undoMs < 100, `${ptr.undoMs.toFixed(1)} ms`);

  // ---------- exports ----------
  const exp = await page.evaluate(async () => {
    const times = {};
    const realCreate = URL.createObjectURL; let done;
    URL.createObjectURL = (b) => { done && done(b.size); return realCreate(b); };
    for (const id of ["exportJson", "exportZip"]) {
      const t0 = performance.now();
      const size = await new Promise((res) => { done = res; document.getElementById(id).click(); });
      times[id] = { ms: performance.now() - t0, mb: size / 1e6 };
    }
    URL.createObjectURL = realCreate;
    const b = document.getElementById("saveWarn");
    return { ...times, warn: b.hidden ? "" : document.getElementById("saveWarnMsg").textContent };
  });
  check(`export JSON (${N} images × ${NV} vertices)`, exp.exportJson.ms < 10000, `${exp.exportJson.ms.toFixed(0)} ms, ${exp.exportJson.mb.toFixed(1)} MB`);
  check(`export ZIP with ${N} masks (${W}×${H})`, exp.exportZip.ms < 20000, `${exp.exportZip.ms.toFixed(0)} ms, ${exp.exportZip.mb.toFixed(1)} MB`);
  // ~14 MB of outlines exceeds the ~5 MB storage quota: the autosave warning must be up
  check("over-quota session shows the autosave warning", N * NV < 200000 || /storage is full/.test(exp.warn), exp.warn || "(no warning)");

  await page.evaluate(() => sessionStorage.setItem("mt.reset", "1")); await page.reload();
  const browser = await page.evaluate(() => navigator.userAgent);
  return { browser, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}
