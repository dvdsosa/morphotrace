// Accessibility checks: axe-core (WCAG 2.1 A/AA + best practices) in several UI states and both themes, plus
// what axe cannot see: keyboard access, focus ring, screen-reader announcements, colour-independent cues.
// Needs network access once per run (axe-core is loaded from cdnjs). Run like the other e2e files:
//   playwright-cli run-code --filename=tests/e2e/a11y.e2e.js
// Returns {browser, passed, failed, results:[{check, ok, detail}]}.
async (page) => {
  const AXE = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";
  const results = [];
  const check = (check, ok, detail = "") => results.push({ check, ok: !!ok, detail: String(detail) });
  const wait = (ms) => page.waitForTimeout(ms);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("mt.reset")) { sessionStorage.removeItem("mt.reset"); localStorage.clear(); }
    // record file-picker openings and dashed strokes instead of opening real dialogs
    window.__clicked = []; const realClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { if (this.type === "file") { window.__clicked.push(this.id); return; } return realClick.call(this); };
    window.__dashes = []; const realDash = CanvasRenderingContext2D.prototype.setLineDash;
    CanvasRenderingContext2D.prototype.setLineDash = function (d) { if (d.length) window.__dashes.push(d.join(",")); return realDash.call(this, d); };
  });
  const fresh = async () => { await page.evaluate(() => sessionStorage.setItem("mt.reset", "1")); await page.reload(); };
  const load = () => page.evaluate(async () => {
    const dt = new DataTransfer();
    for (const n of ["Copepoda/a.png", "Copepoda/b.png", "Copepoda/c.png"]) {
      const c = document.createElement("canvas"); c.width = 200; c.height = 150; c.getContext("2d").fillRect(0, 0, 10, 10);
      dt.items.add(new File([await new Promise((r) => c.toBlob(r, "image/png"))], n, { type: "image/png" }));
    }
    document.getElementById("wrap").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
  }).then(() => wait(500));
  const axe = async (label) => {
    if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ url: AXE });
    const v = await page.evaluate(async () => (await axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] }))
      .violations.map((x) => `${x.id} (${x.impact}): ${x.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`));
    check(`axe: no violations — ${label}`, v.length === 0, v.join(" | "));
  };
  const box = async () => page.locator("#cv").boundingBox();

  // ---------- axe in several states, both themes ----------
  for (const theme of ["light", "dark"]) {
    await fresh(); await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await axe(`${theme}, empty`);
    await load(); await axe(`${theme}, images loaded`);
    const b = await box(), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    await page.keyboard.press("s");
    for (const [x, y] of [[-40, -40], [40, -40], [40, 40]]) await page.mouse.click(cx + x, cy + y);
    await axe(`${theme}, drawing in Subtract mode`);
    await page.keyboard.press("Enter"); await wait(100); // nothing to subtract → flash message
    await axe(`${theme}, flash message shown`);
    await page.evaluate(() => { document.getElementById("saveWarnMsg").textContent = "Autosave failed: test."; document.getElementById("saveWarn").hidden = false; });
    await axe(`${theme}, autosave warning shown`);
    await page.evaluate(() => { document.getElementById("saveWarn").hidden = true; document.getElementById("help").showModal(); });
    await axe(`${theme}, help dialog open`);
    await page.keyboard.press("Escape");
  }
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });

  // ---------- keyboard ----------
  await fresh(); await load();
  const tabStops = [];
  // Safari's default Tab only visits text fields; Option+Tab visits every control (as WebKit does here)
  const TAB = (await page.evaluate(() => /Version\/.*Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent))) ? "Alt+Tab" : "Tab";
  await page.evaluate(() => document.activeElement.blur());
  let first = null;
  for (let i = 0; i < 80; i++) { // one full cycle through the page's tab stops
    await page.keyboard.press(TAB);
    const el = await page.evaluateHandle(() => document.activeElement);
    if (i > 0 && await page.evaluate(([a, b]) => a === b, [el, first])) break;
    if (i === 0) first = el;
    tabStops.push(await page.evaluate((e) => e.id || e.className, el));
  }
  check("file pickers are keyboard-reachable (Open images / folder / Import JSON)", ["openFiles", "openDir", "openJson"].every((id) => tabStops.includes(id)), tabStops.join(" "));
  check("image list is one tab stop (roving tabindex)", tabStops.filter((t) => t === "imgbtn").length === 1, tabStops.filter((t) => t === "imgbtn").length);
  await page.focus("#openFiles"); await page.keyboard.press("Enter");
  await page.focus("#openJson"); await page.keyboard.press(" ");
  check("Enter / Space on the file buttons open the pickers", (await page.evaluate(() => window.__clicked.join(","))) === "fileInput,jsonInput", await page.evaluate(() => window.__clicked.join(",")));
  await page.focus("#modeEdit"); await page.keyboard.press(" "); await wait(50);
  check("Space activates a focused button (not the pan gesture)", (await page.getAttribute("#modeEdit", "aria-pressed")) === "true", await page.getAttribute("#modeEdit", "aria-pressed"));
  await page.keyboard.press("d"); await wait(50);
  check("mode buttons expose aria-pressed", (await page.getAttribute("#modeDraw", "aria-pressed")) === "true" && (await page.getAttribute("#modeEdit", "aria-pressed")) === "false");
  await page.focus(".imglist .imgbtn[tabindex='0']"); await page.keyboard.press("ArrowDown"); await wait(300);
  const nav = await page.evaluate(() => [document.getElementById("navPos").textContent.trim(), document.activeElement.getAttribute("aria-current"), document.activeElement.className]);
  check("ArrowDown in the image list opens the next image and keeps focus on it", nav[0] === "2 / 3" && nav[1] === "true" && nav[2] === "imgbtn", JSON.stringify(nav));
  check("list items state annotated / unusable in their accessible name", /a\.png/.test(await page.getAttribute(".imglist li:first-child .imgbtn", "aria-label")), await page.getAttribute(".imglist li:first-child .imgbtn", "aria-label"));
  const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return `${cs.outlineStyle} ${cs.outlineWidth}`; });
  check("focused controls show a 2 px focus ring", ring === "solid 2px", ring);

  // ---------- what screen readers and colour-blind users get ----------
  check("canvas has a text alternative that follows the image", /Image 2 of 3, (Copepoda\/)?b\.png: 0 areas/.test(await page.getAttribute("#cv", "aria-label")), await page.getAttribute("#cv", "aria-label"));
  const b = await box(), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await page.keyboard.press("s");
  for (const [x, y] of [[-40, -40], [40, -40], [40, 40]]) await page.mouse.click(cx + x, cy + y);
  check("subtract trace is dashed, not only red", (await page.evaluate(() => window.__dashes.length)) > 0);
  await page.keyboard.press("Enter"); await wait(100);
  check("flash messages are announced (aria-live)", /does not overlap/.test(await page.evaluate(() => document.getElementById("announce").textContent)), await page.evaluate(() => document.getElementById("announce").textContent));
  await page.focus('.theme-switch [aria-checked="true"]'); await page.keyboard.press("ArrowRight"); await wait(50);
  const th = await page.evaluate(() => [document.querySelector(".theme-switch").dataset.value, document.activeElement.dataset.themeChoice,
    [...document.querySelectorAll(".theme-switch button")].filter((b) => b.tabIndex === 0).length]);
  await page.keyboard.press("ArrowLeft");
  check("theme switch is a radio group: one tab stop, arrows change the theme", th[0] === "dark" && th[1] === "dark" && th[2] === 1, JSON.stringify(th));
  check("page has one h1 and html lang", await page.evaluate(() => document.querySelectorAll("h1").length === 1 && document.documentElement.lang === "en"));

  await fresh();
  const browser = await page.evaluate(() => navigator.userAgent);
  return { browser, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}
