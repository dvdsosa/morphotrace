// Drives MorphoTrace for the README demo: open a folder, outline a copepod by clicks, trace an antennule
// freehand (it merges), refine a vertex, read the area, go to the next image, export. Shows a cursor and a
// caption per step. Run by docs/media/build.sh, or by hand with the repository root served:
//   playwright-cli video-start demo.webm --size 1280x720
//   playwright-cli run-code --filename=docs/media/record.e2e.js
//   playwright-cli video-stop
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

  // ---------- overlay: cursor, click ripple, caption (not part of the app) ----------
  await page.evaluate(() => {
    const css = document.createElement("style");
    css.textContent = `
      #demo-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 99999; pointer-events: none; transform: translate(-3px, -2px); filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.45)); }
      .demo-ripple { position: fixed; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%; border: 2px solid #ffb000; z-index: 99998; pointer-events: none; animation: demo-r .45s ease-out forwards; }
      @keyframes demo-r { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
      #demo-caption { position: fixed; left: 50%; top: 118px; transform: translateX(-50%); z-index: 99997; pointer-events: none; background: rgba(20, 24, 31, .86); color: #fff;
        font: 600 17px/1.3 -apple-system, "Segoe UI", system-ui, sans-serif; padding: 9px 18px; border-radius: 999px; box-shadow: 0 4px 16px rgba(0,0,0,.25); transition: opacity .25s; }
      #demo-caption kbd { font: 600 14px ui-monospace, monospace; background: rgba(255,255,255,.18); border: 1px solid rgba(255,255,255,.35); border-radius: 4px; padding: 0 5px; }
      .demo-spot { outline: 3px solid #ffb000 !important; outline-offset: 3px; border-radius: 6px; transition: outline-color .3s; }`;
    document.head.append(css);
    const cur = document.createElement("div"); cur.id = "demo-cursor";
    cur.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.2 19.2 L10.2 12.8 L16.2 12.6 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    const cap = document.createElement("div"); cap.id = "demo-caption"; cap.style.opacity = "0";
    document.body.append(cur, cap);
    document.addEventListener("pointermove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
    document.addEventListener("pointerdown", (e) => {
      const r = document.createElement("div"); r.className = "demo-ripple"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
      document.body.append(r); setTimeout(() => r.remove(), 500);
    }, true);
  });
  const caption = (html) => page.evaluate((h) => { const c = document.getElementById("demo-caption"); c.innerHTML = h; c.style.opacity = h ? "1" : "0"; }, html);
  const spot = (sel, on) => page.evaluate(([s, on]) => document.querySelectorAll(s).forEach((e) => e.classList.toggle("demo-spot", on)), [sel, on]);
  let mx = 640, my = 400;
  const moveTo = async (x, y, ms = 450) => { const steps = Math.max(4, Math.round(ms / 16)); await page.mouse.move(x, y, { steps }); mx = x; my = y; };
  const clickAt = async (x, y, ms) => { await moveTo(x, y, ms); await page.mouse.down(); await page.mouse.up(); };
  const center = async (sel) => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };

  // the folder picker is replaced by the specimen files (served from the repository)
  await page.evaluate(async ([base, files]) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([await (await fetch(base + f)).blob()], f, { type: "image/png" }));
    const real = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.id !== "dirInput") return real.call(this);
      this.files = dt.files; this.dispatchEvent(new Event("change", { bubbles: true }));
    };
  }, [BASE, FILES]);
  const paths = await page.evaluate(async (u) => (await fetch(u)).json(), BASE + "copepod_01.paths.json");

  await page.mouse.move(mx, my); await wait(300);

  // ---------- 1. open a folder ----------
  await caption("Open a folder of images");
  await wait(500);
  await clickAt(...(await center("#openDir")), 700);
  await wait(900);

  // image → screen mapping from two cursor readouts in the status bar
  const readout = async (x, y) => { await page.mouse.move(x, y); await wait(30); const t = await page.textContent("#stCursor"); const m = t.match(/x ([\d.-]+)\s+y ([\d.-]+)/); return [+m[1], +m[2]]; };
  const cv = await page.locator("#cv").boundingBox();
  const [ax, ay] = await readout(cv.x + 200, cv.y + 150), [bx, by] = await readout(cv.x + 700, cv.y + 450);
  const k = 500 / (bx - ax), toScr = ([x, y]) => [cv.x + 200 + (x - ax) * k, cv.y + 150 + (y - ay) * ((450 - 150) / (by - ay))];
  await page.mouse.move(mx, my);

  // ---------- 2. outline by clicks ----------
  await caption("Click around the organism");
  const body = paths.body.map(toScr);
  for (const [i, p] of body.entries()) await clickAt(p[0], p[1], i ? 170 : 600);
  await caption("Click the first point to close");
  await wait(250);
  await clickAt(body[0][0], body[0][1], 380);
  await wait(800);

  // ---------- 3. freehand appendage, merges with the body ----------
  await caption("<kbd>Shift</kbd> + drag traces an appendage — overlaps merge");
  const ant = paths.antenna.map(toScr);
  await moveTo(ant[0][0], ant[0][1], 600);
  await wait(250);
  await page.keyboard.down("Shift"); await page.mouse.down();
  for (const p of ant.slice(1)) await page.mouse.move(p[0], p[1], { steps: 2 });
  await page.mouse.up(); await page.keyboard.up("Shift");
  await page.keyboard.press("Enter");
  await wait(1300);

  // ---------- 4. refine a vertex in Edit mode ----------
  await caption("Edit (<kbd>E</kbd>): drag a vertex to refine the outline");
  await page.keyboard.press("e"); await wait(300);
  const v = toScr(paths.edit_vertex);
  await moveTo(v[0], v[1], 700); await wait(350);
  await page.mouse.down(); await page.mouse.move(v[0] - 9, v[1] - 4, { steps: 14 }); await page.mouse.up();
  await moveTo(v[0] + 60, v[1] + 120, 500);
  await wait(500);

  // ---------- 5. area ----------
  await caption("Area in px² and mm², autosaved as you work");
  await spot("#stArea", true); await wait(1900); await spot("#stArea", false);

  // ---------- 6. next image ----------
  await caption("Next image: <kbd>→</kbd>");
  await wait(400); await page.keyboard.press("d"); await page.keyboard.press("ArrowRight"); await wait(1300);

  // ---------- 7. export ----------
  await caption("Export areas (CSV), outlines (JSON) or masks (ZIP)");
  await spot("#exportJson, #exportCsv, #exportZip", true);
  await moveTo(...(await center("#exportCsv")), 700); await wait(1400);
  await spot("#exportJson, #exportCsv, #exportZip", false);
  await caption(""); await wait(500);
  return "recorded";
}
