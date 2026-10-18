// End-to-end walk through MorphoTrace's main functions, meant to be run in Chromium, Firefox and WebKit.
// Self-contained (test images are generated in the page). Serve the repository, then for each browser:
//   playwright-cli -s=ff open --browser=firefox http://localhost:8765/
//   playwright-cli -s=ff run-code --filename=tests/e2e/core.e2e.js
// Returns {browser, passed, failed, results:[{check, ok, detail}]}; it does not stop at the first failure.
async (page) => {
  const results = [];
  const check = (check, ok, detail = "") => results.push({ check, ok: !!ok, detail: String(detail) });
  const wait = (ms) => page.waitForTimeout(ms);
  const KEY = "a_200x150.png";

  // ---------- helpers ----------
  await page.addInitScript(() => {
    if (sessionStorage.getItem("mt.reset")) { sessionStorage.removeItem("mt.reset"); localStorage.clear(); }
  });
  const fresh = async () => { await page.evaluate(() => sessionStorage.setItem("mt.reset", "1")); await page.reload(); };
  const dropFixtures = () => page.evaluate(async () => {
    const make = async (name, w, h, grey) => {
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const g = c.getContext("2d"); g.fillStyle = `rgb(${grey},${grey},${grey})`; g.fillRect(0, 0, w, h);
      return new File([await new Promise((r) => c.toBlob(r, "image/png"))], name, { type: "image/png" });
    };
    const dt = new DataTransfer();
    dt.items.add(await make("a_200x150.png", 200, 150, 200));
    dt.items.add(await make("b_120x90.png", 120, 90, 100));
    document.getElementById("wrap").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }).then(() => wait(500));
  const polys = async (key = KEY) => { await wait(400); return page.evaluate((k) => (JSON.parse(localStorage.getItem("morphotrace.v1") || "{}").annotations || {})[k]?.polygons || [], key); };
  const text = (id) => page.evaluate((id) => document.getElementById(id).textContent, id);
  const statusArea = async () => parseFloat(((await text("stArea")).match(/Area: ([\d.]+) px²/) || [])[1]);
  const shoelace = (p) => Math.abs(p.reduce((a, [x1, y1], i) => { const [x2, y2] = p[(i + 1) % p.length]; return a + x1 * y2 - x2 * y1; }, 0)) / 2;
  const net = (ps) => ps.reduce((t, p) => t + (p.hole ? -1 : 1) * shoelace(p.points), 0);
  const near = (a, b, rel = 0.01, abs = 0.5) => Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b));
  const box = await page.locator("#cv").boundingBox();
  const O = { x: box.x + box.width / 2, y: box.y + box.height / 2 }; // screen centre of the canvas
  const at = (dx, dy) => [O.x + dx, O.y + dy];
  const clickAt = async (dx, dy, opts) => { await page.mouse.click(...at(dx, dy), opts); await wait(40); };
  const square = async (cx, cy, half, close = "Enter") => {
    const pts = [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]];
    for (const [x, y] of pts) await clickAt(x, y);
    if (close === "Enter") await page.keyboard.press("Enter");
    else if (close === "first") await clickAt(pts[0][0], pts[0][1]);
    else if (close === "dblclick") { await page.mouse.dblclick(...at(pts[3][0], pts[3][1])); }
    await wait(150);
  };
  // native dialogs are replaced in the page (playwright-cli holds real ones as a modal state)
  const answerPrompt = (v) => page.evaluate((v) => { window.prompt = () => v; }, v);
  const download = async (selector) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click(selector)]);
    // run-code has no require/TextDecoder: use the Buffer class the stream chunks come in
    const chunks = []; for await (const c of await dl.createReadStream()) chunks.push(c);
    const bytes = chunks[0].constructor.concat(chunks);
    return { name: dl.suggestedFilename(), bytes, text: () => bytes.toString("utf8") };
  };
  const unzipStored = (b) => { // ZipWriter uses the STORE method: read local file headers directly
    const files = {}, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let p = 0; p + 30 <= b.length && dv.getUint32(p, true) === 0x04034b50;) {
      const size = dv.getUint32(p + 18, true), nl = dv.getUint16(p + 26, true), xl = dv.getUint16(p + 28, true);
      const name = b.subarray(p + 30, p + 30 + nl).toString("utf8"), start = p + 30 + nl + xl;
      files[name] = b.subarray(start, start + size); p = start + size;
    }
    return files;
  };
  const b64 = (buf) => buf.toString("base64");
  const canvasPixel = (dx, dy) => page.evaluate(([x, y]) => { const c = document.getElementById("cv"), r = c.getBoundingClientRect(), k = c.width / r.width;
    return Array.from(c.getContext("2d").getImageData(Math.round((r.width / 2 + x) * k), Math.round((r.height / 2 + y) * k), 1, 1).data); }, [dx, dy]);

  // ---------- 1. loading ----------
  await fresh(); await dropFixtures();
  check("images load from a drop", (await text("navPos")).trim() === "1 / 2", await text("navPos"));
  check("status shows file and size", /200×150/.test(await text("stFile")), await text("stFile"));
  const statusH = await page.evaluate(() => document.querySelector(".statusbar").getBoundingClientRect().height);

  // ---------- 2. drawing by clicks (Enter) and scale ----------
  await square(-60, 0, 30, "Enter");
  let P = await polys();
  check("click polygon closed with Enter", P.length === 1 && P[0].points.length === 4, JSON.stringify(P.map((p) => p.points.length)));
  const side = Math.abs(P[0]?.points[1][0] - P[0]?.points[0][0]);
  const s = 60 / side; // screen px per image px
  const zoomShown = parseFloat(await text("zoomPct")) / 100;
  check("image scale matches the zoom shown", near(s, zoomShown, 0.01, 0.006), `s=${s.toFixed(4)} shown=${zoomShown}`);
  check("status-bar area = polygon area", near(await statusArea(), net(P), 0, 0.06), `${await statusArea()} vs ${net(P).toFixed(3)}`);
  const toScr = ([x, y]) => [(x - P[0].points[0][0]) * s - 90, (y - P[0].points[0][1]) * s - 30]; // relative to O

  // ---------- 3. undo / redo ----------
  await page.keyboard.press("ControlOrMeta+z"); P = await polys();
  check("undo (Ctrl/⌘+Z) removes the polygon", P.length === 0, P.length);
  await page.keyboard.press("ControlOrMeta+Shift+z"); P = await polys();
  check("redo (Ctrl/⌘+Shift+Z) restores it", P.length === 1, P.length);
  await page.click("#undoBtn"); P = await polys(); const undoBtnOk = P.length === 0;
  await page.click("#redoBtn"); P = await polys();
  check("Undo / Redo buttons", undoBtnOk && P.length === 1);

  // ---------- 4. merge (close on first vertex) ----------
  const a = 60 / s, d = 30 / s;
  await square(-30, 30, 30, "first");
  P = await polys();
  check("closing on the first vertex + overlap merges into one area", P.length === 1, P.length);
  check("merged area = union of both squares", near(net(P), 2 * a * a - (a - d) * (a - d), 0.01), `${net(P).toFixed(1)} vs ${(2 * a * a - (a - d) * (a - d)).toFixed(1)}`);
  const merged = net(P);

  // ---------- 5. subtract mode (close by double-click) → hole ----------
  await page.keyboard.press("s");
  await square(-70, -10, 8, "dblclick");
  P = await polys();
  check("subtract inside an area creates a hole (closed by double-click)", P.filter((p) => p.hole).length === 1, JSON.stringify(P.map((p) => p.hole)));
  check("hole area removed", near(net(P), merged - (16 / s) ** 2, 0.02), `${net(P).toFixed(1)} vs ${(merged - (16 / s) ** 2).toFixed(1)}`);
  const withHole = net(P);

  // ---------- 6. Alt + first click subtracts from Draw mode ----------
  await page.keyboard.press("d");
  await page.keyboard.down("Alt"); await clickAt(-50, 45); await page.keyboard.up("Alt");
  await clickAt(-35, 45); await clickAt(-35, 70); await clickAt(-50, 70); await page.keyboard.press("Enter"); await wait(150);
  P = await polys();
  check("Alt + first click makes a subtraction in Draw mode", near(net(P), withHole - (15 / s) ** 2, 0.02), `${net(P).toFixed(1)} vs ${(withHole - (15 / s) ** 2).toFixed(1)}`);

  // ---------- 7. right-click removes the last vertex; Esc cancels ----------
  const nBefore = (await polys()).length;
  await clickAt(60, -40); await clickAt(80, -40); await clickAt(80, -20); await clickAt(70, -5);
  await page.mouse.click(...at(70, -5), { button: "right" }); await wait(80);
  await page.keyboard.press("Enter"); await wait(150);
  let Q = await polys();
  check("right-click removes the last vertex while drawing", Q.length === nBefore + 1 && Q[Q.length - 1].points.length === 3, JSON.stringify(Q.map((p) => p.points.length)));
  await page.keyboard.press("ControlOrMeta+z");
  await clickAt(60, -40); await clickAt(80, -40); await clickAt(80, -20);
  await page.keyboard.press("Escape"); await page.keyboard.press("Enter"); await wait(150);
  Q = await polys();
  check("Esc cancels the polygon being drawn", Q.length === nBefore, `${Q.length} vs ${nBefore}`);

  // ---------- 8. freehand (Shift + drag) ----------
  await page.keyboard.down("Shift");
  await page.mouse.move(...at(70 + 25, -40)); await page.mouse.down();
  for (let k = 1; k <= 24; k++) { const t = (2 * Math.PI * k) / 24; await page.mouse.move(...at(70 + 25 * Math.cos(t), -40 + 25 * Math.sin(t))); }
  await page.mouse.up(); await page.keyboard.up("Shift"); await page.keyboard.press("Enter"); await wait(150);
  P = await polys();
  const free = P.filter((p) => !p.hole).sort((a, b) => b.points.length - a.points.length)[0]; // the trace has the most vertices
  check("freehand trace (Shift + drag) adds a separate polygon", P.filter((p) => !p.hole).length === 2 && free.points.length > 15, JSON.stringify(P.map((p) => p.points.length)));
  check("freehand area ≈ circle of radius 25 screen px", free && near(shoelace(free.points), Math.PI * (25 / s) ** 2, 0.05), free && shoelace(free.points).toFixed(1));

  // ---------- 9. edit mode: select + delete, drag a vertex ----------
  await page.keyboard.press("e");
  await clickAt(70, -40); await wait(80);
  const delEnabled = await page.evaluate(() => !document.getElementById("delBtn").disabled);
  await page.keyboard.press("Delete"); P = await polys();
  check("Edit: click selects an area and Delete removes it", delEnabled && P.filter((p) => !p.hole).length === 1, `delBtn enabled=${delEnabled}, solids=${P.filter((p) => !p.hole).length}`);
  const area0 = net(P), corner = toScr([P[0].points[0][0], P[0].points[0][1]]);
  const outer = P.find((p) => !p.hole), vtx = outer.points.reduce((b, q) => (q[0] + q[1] < b[0] + b[1] ? q : b)); // top-left vertex
  const [vx, vy] = toScr(vtx);
  await page.mouse.move(...at(vx, vy)); await wait(60); await page.mouse.down(); await page.mouse.move(...at(vx - 15, vy - 15), { steps: 5 }); await page.mouse.up();
  P = await polys();
  check("Edit: dragging a vertex changes the area", net(P) > area0 + 1, `${area0.toFixed(1)} → ${net(P).toFixed(1)} (corner ${corner.map((v) => v.toFixed(0))})`);

  // ---------- 10. zoom ----------
  await page.keyboard.press("0"); await wait(80); const z0 = parseFloat(await text("zoomPct"));
  await page.keyboard.press("+"); await wait(80); const z1 = parseFloat(await text("zoomPct"));
  await page.keyboard.press("1"); await wait(80); const z2 = parseFloat(await text("zoomPct"));
  await page.keyboard.press("0"); await wait(80); const z3 = parseFloat(await text("zoomPct"));
  check("zoom keys: + zooms in, 1 = 100 %, 0 = fit", z1 > z0 && z2 === 100 && z3 === z0, `${z0} → ${z1} → ${z2} → ${z3}`);

  // ---------- 11. navigation ----------
  await page.keyboard.press("ArrowRight"); await wait(200); const n1 = (await text("navPos")).trim();
  await page.keyboard.press("ArrowLeft"); await wait(200); const n2 = (await text("navPos")).trim();
  await answerPrompt("2");
  await page.keyboard.press("g"); await wait(300); const n3 = (await text("navPos")).trim();
  check("navigation: arrows and G (go to number)", n1 === "2 / 2" && n2 === "1 / 2" && n3 === "2 / 2", `${n1}, ${n2}, ${n3}`);

  // ---------- 12. display filters (image 2 has no polygons) ----------
  const px0 = await canvasPixel(0, 0);
  await page.evaluate(() => { const b = document.getElementById("bright"); b.value = 200; b.dispatchEvent(new Event("input", { bubbles: true })); });
  await wait(150); const px1 = await canvasPixel(0, 0);
  check("brightness slider changes the displayed image", px1[0] > px0[0] + 20, `${px0[0]} → ${px1[0]}`);
  // grey 100 → brightness 150 % → contrast 150 % → invert: 255·(1 − ((100/255·1.5 − 0.5)·1.5 + 0.5)) ≈ 94
  await page.evaluate(() => { const set = (id, v) => { const e = document.getElementById(id); if (e.type === "checkbox") e.checked = v; else e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); };
    set("bright", 150); set("contr", 150); set("invert", true); });
  await wait(150); const px2 = await canvasPixel(0, 0);
  check("brightness + contrast + invert give the CSS-filter value", Math.abs(px2[0] - 94) <= 3, `${px2[0]} (expected ≈ 94)`);
  await page.click("#resetView"); await wait(150);
  check("Reset display restores it", Math.abs((await canvasPixel(0, 0))[0] - px0[0]) <= 2, (await canvasPixel(0, 0))[0]);

  // ---------- 13. mark unusable ----------
  await answerPrompt("out of focus");
  await page.keyboard.press("x"); await wait(200);
  check("X marks the image unusable with a reason", /UNUSABLE \(out of focus\)/.test(await text("stArea")), await text("stArea"));
  await page.keyboard.press("ArrowLeft"); await wait(200);

  // ---------- 14. theme, help, side panel ----------
  await page.click('[data-theme-choice="dark"]');
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('[data-theme-choice="auto"]');
  check("theme switch sets dark theme", theme === "dark", theme);
  await page.keyboard.press("?"); await wait(100);
  const helpOpen = await page.evaluate(() => document.getElementById("help").open);
  await page.keyboard.press("Escape"); await wait(100);
  check("? opens help, Esc closes it", helpOpen && !(await page.evaluate(() => document.getElementById("help").open)));
  const vp = page.viewportSize(); await page.setViewportSize({ width: 390, height: 760 }); await wait(150); // the toggle shows on narrow screens
  const expOf = () => page.evaluate(() => [document.getElementById("panelBtn").getAttribute("aria-expanded"), !document.getElementById("sidebar").classList.contains("collapsed")]);
  const e0 = await expOf(); await page.click("#panelBtn"); const e1 = await expOf();
  await page.click("#panelBtn"); const e2 = await expOf(); await page.setViewportSize(vp); await wait(150);
  check("side panel toggles on a narrow screen (aria-expanded follows it)", e0[0] !== e1[0] && e0[0] === e2[0] && e1[0] === String(e1[1]), JSON.stringify([e0, e1, e2]));
  check("status bar keeps its height whatever the hint", (await page.evaluate(() => document.querySelector(".statusbar").getBoundingClientRect().height)) === statusH, statusH);

  // ---------- 15. exports ----------
  P = await polys(); const areaNow = net(P);
  const J = await download("#exportJson"), obj = JSON.parse(J.text());
  const imA = obj.images.find((r) => r.file === KEY), imB = obj.images.find((r) => r.file === "b_120x90.png");
  check("JSON export: both images, statuses", imA?.status === "annotated" && imB?.status === "unusable" && imB.unusable_reason === "out of focus", `${imA?.status}, ${imB?.status}`);
  check("JSON export: area matches the polygons", near(imA?.area_px_polygon, areaNow, 0, 0.06), `${imA?.area_px_polygon} vs ${areaNow.toFixed(3)}`);
  const C = (await download("#exportCsv")).text().trim().split("\n");
  check("CSV export: header + one row per image", C.length === 4 && C[1].startsWith("rel_path,"), C.length);
  const Z = unzipStored((await download("#exportZip")).bytes), zj = Z["annotations.json"] && JSON.parse(Z["annotations.json"].toString("utf8"));
  const maskName = Object.keys(Z).find((n) => n.endsWith("_mask.png")), zA = zj?.images.find((r) => r.file === KEY);
  check("ZIP export: annotations.json, areas.csv and one mask", zj && Z["areas.csv"] && maskName && Object.keys(Z).length === 3, Object.keys(Z).join(", "));
  const maskPx = maskName ? await page.evaluate(async (src) => {
    const bmp = await createImageBitmap(await (await fetch(src)).blob());
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height; const g = c.getContext("2d"); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 127) n++;
    return { n, w: c.width, h: c.height };
  }, "data:image/png;base64," + b64(Z[maskName])) : null;
  check("mask PNG decodes at image size with area_px_mask white pixels", maskPx && maskPx.w === 200 && maskPx.h === 150 && maskPx.n === zA?.area_px_mask, JSON.stringify(maskPx) + ` vs ${zA?.area_px_mask}`);
  check("mask pixel count ≈ polygon area", zA && Math.abs(zA.area_px_mask - zA.area_px_polygon) <= 0.5 * (zA.perimeter_px + 4 * 16 / s) + 2, `${zA?.area_px_mask} vs ${zA?.area_px_polygon}`);

  // ---------- 16. persistence across a reload ----------
  await page.reload(); await dropFixtures();
  P = await polys();
  check("annotations restored after reload", near(net(P), areaNow, 0, 0.01), `${net(P).toFixed(3)} vs ${areaNow.toFixed(3)}`);

  // ---------- 17. import JSON into a fresh session ----------
  await fresh(); await dropFixtures();
  const early = JSON.parse((await download("#exportJson")).text()).images.find((r) => r.file === "b_120x90.png");
  check("export gives the size of images not opened yet", early?.width === 120 && early?.height === 90, `${early?.width}×${early?.height}`);
  await page.evaluate(() => { window.__alert = ""; window.alert = (m) => { window.__alert = String(m); }; });
  await page.evaluate((txt) => {
    const dt = new DataTransfer(); dt.items.add(new File([txt], "annotations.json", { type: "application/json" }));
    const inp = document.getElementById("jsonInput"); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true }));
  }, J.text());
  await wait(300); const msg = await page.evaluate(() => window.__alert); P = await polys();
  check("Import JSON restores annotations", /Imported annotations for 2 images/.test(msg) && near(net(P), areaNow, 0, 0.01), `${msg}; ${net(P).toFixed(3)}`);

  await fresh();
  const browser = await page.evaluate(() => navigator.userAgent);
  return { browser, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}
