// Still screenshots for the README (written to playwright-cli's working directory; docs/media/build.sh
// moves them into docs/media/): overview with numbered callouts, Edit mode close-up, Subtract making a
// hole, and the exported mask ZIP.
async (page) => {
  const BASE = "docs/media/specimens/";
  const FILES = ["Copepoda/copepod_01.png", "Pisces/fish_egg_01.png", "Sagittoidea/arrow_worm_01.png"];
  const wait = (ms) => page.waitForTimeout(ms);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    if (sessionStorage.getItem("mt.reset")) { sessionStorage.removeItem("mt.reset"); localStorage.clear(); localStorage.setItem("morphotrace.theme", "light"); }
  });
  await page.evaluate(() => sessionStorage.setItem("mt.reset", "1")); await page.reload();
  await page.fill("#annotator", "DST");
  await page.evaluate(async ([base, files]) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([await (await fetch(base + f)).blob()], f, { type: "image/png" }));
    const inp = document.getElementById("dirInput"); inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true }));
  }, [BASE, FILES]);
  await wait(600);
  const paths = await page.evaluate(async (u) => (await fetch(u)).json(), BASE + "copepod_01.paths.json");
  const mapping = async () => {
    const cv = await page.locator("#cv").boundingBox();
    const read = async (x, y) => { await page.mouse.move(x, y); await wait(20); const m = (await page.textContent("#stCursor")).match(/x ([\d.-]+)\s+y ([\d.-]+)/); return [+m[1], +m[2]]; };
    const [ax, ay] = await read(cv.x + 200, cv.y + 150), [bx, by] = await read(cv.x + 700, cv.y + 450);
    return ([x, y]) => [cv.x + 200 + (x - ax) * (500 / (bx - ax)), cv.y + 150 + (y - ay) * (300 / (by - ay))];
  };
  const click = async ([x, y]) => { await page.mouse.click(x, y); };

  // ---------- annotate the copepod: clicks + freehand antennule ----------
  let toScr = await mapping();
  for (const p of paths.body) await click(toScr(p));
  await click(toScr(paths.body[0])); await wait(100);
  const ant = paths.antenna.map(toScr);
  await page.mouse.move(...ant[0]); await page.keyboard.down("Shift"); await page.mouse.down();
  for (const p of ant.slice(1)) await page.mouse.move(p[0], p[1], { steps: 2 });
  await page.mouse.up(); await page.keyboard.up("Shift"); await page.keyboard.press("Enter"); await wait(300);
  await page.mouse.move(1100, 690); await wait(3000); // let the "merged" message fade

  // ---------- 1. overview with numbered callouts ----------
  const marks = [["#annotator", 1, "right"], [".seg[aria-label='Mode']", 2, "under"], ["#cv", 3, "center"], ["#imageList", 4, "right"], ["#stArea", 5, "left"], ["#exportJson", 6, "gap"]];
  await page.evaluate((marks) => {
    for (const [sel, n, where] of marks) {
      const r = document.querySelector(sel).getBoundingClientRect(), b = document.createElement("div");
      b.className = "shot-mark"; b.textContent = n;
      const x = { right: r.right - 16, center: r.left + r.width * 0.78, under: r.left + r.width / 2, gap: r.left - 7, left: r.left - 18 }[where];
      const y = { center: r.top + r.height * 0.2, under: r.bottom + 26, gap: r.top + r.height / 2, left: r.top + r.height / 2 }[where] ?? r.top + Math.min(r.height, 28) / 2;
      Object.assign(b.style, { position: "fixed", left: x - 13 + "px", top: y - 13 + "px", width: "26px", height: "26px", borderRadius: "50%", background: "#ff8a00",
        color: "#fff", font: "700 15px/26px system-ui, sans-serif", textAlign: "center", boxShadow: "0 0 0 3px #fff, 0 2px 8px rgba(0,0,0,.35)", zIndex: 99999 });
      document.body.append(b);
    }
  }, marks);
  await page.screenshot({ path: "overview.png" });
  await page.evaluate(() => document.querySelectorAll(".shot-mark").forEach((e) => e.remove()));

  // ---------- 2. Edit mode close-up on the head ----------
  await page.keyboard.press("e");
  const head = toScr(paths.edit_vertex);
  for (let i = 0; i < 6; i++) { await page.mouse.move(head[0] + 40, head[1]); await page.keyboard.down("Shift"); await page.mouse.wheel(0, -120); await page.keyboard.up("Shift"); await wait(40); }
  await wait(200);
  toScr = await mapping();
  const hv = toScr(paths.edit_vertex), body = paths.body.map(toScr);
  await page.mouse.click(hv[0] + 60, hv[1] + 10); await wait(100);       // select the area
  await page.mouse.move(body[5][0], body[5][1]); await wait(200);       // hover a vertex: it grows
  const cvb = await page.locator("#cv").boundingBox();
  await page.screenshot({ path: "edit.png", clip: { x: cvb.x + 40, y: cvb.y + 20, width: 760, height: 470 } });
  await page.keyboard.press("0");

  // ---------- 3. Subtract making a hole (fish egg) ----------
  await page.keyboard.press("d"); await page.keyboard.press("ArrowRight"); await wait(500);
  toScr = await mapping();
  const ring = (cx, cy, r, n) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  for (const p of ring(180, 182, 125, 28)) await click(toScr(p));
  await page.keyboard.press("Enter"); await wait(200);
  await page.keyboard.press("s");
  const hole = ring(214, 220, 30, 9).map(toScr);
  for (const p of hole) await click(p);
  await page.mouse.move(hole[0][0] + 2, hole[0][1] + 1); await wait(3000); // cursor on the first vertex: close marker shows
  const cv2 = await page.locator("#cv").boundingBox();
  const c = toScr([180, 182]), half = (toScr([180 + 140, 182])[0] - c[0]);
  await page.screenshot({ path: "subtract.png", clip: { x: Math.max(cv2.x, c[0] - half * 1.35), y: Math.max(cv2.y, c[1] - half * 1.05), width: half * 2.7, height: half * 2.1 } });
  await page.mouse.click(hole[0][0], hole[0][1]); await wait(200);

  // ---------- 4. masks ----------
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportZip")]);
  await dl.saveAs("export.zip");
  await page.evaluate(() => sessionStorage.setItem("mt.reset", "1")); await page.reload();
  return "screens written";
}
