// End-to-end check that autosave failures are never silent. Self-contained (the test image is generated
// in the page). Serve the repository (python3 -m http.server 8765), then run with playwright-cli:
//   playwright-cli open http://localhost:8765/
//   playwright-cli run-code --filename=tests/e2e/storage.e2e.js
// Returns a list of passed checks, or throws at the first failure.
async (page) => {
  const passed = [];
  const check = (ok, what) => { if (!ok) throw new Error("FAILED: " + what); passed.push(what); };
  const banner = () => page.evaluate(() => { const b = document.getElementById("saveWarn"); return b.hidden ? "" : b.textContent.trim(); });
  const loadFixture = () => page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 200; c.height = 150;
    const g = c.getContext("2d"); g.fillStyle = "#ddd"; g.fillRect(0, 0, 200, 150);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer(); dt.items.add(new File([blob], "fixture_200x150.png", { type: "image/png" }));
    document.getElementById("wrap").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }).then(() => page.waitForTimeout(400));
  const drawSquare = async (dx) => {
    const b = await page.locator("#cv").boundingBox(), cx = b.x + b.width / 2 + dx, cy = b.y + b.height / 2;
    for (const [x, y] of [[-30, -30], [30, -30], [30, 30], [-30, 30]]) await page.mouse.click(cx + x, cy + y);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500); // autosave is debounced by 300 ms
  };
  const leaveBlocked = () => page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });

  // Fault injection, active only when flagged in sessionStorage so a reload can turn it on or off.
  await page.addInitScript(() => {
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (this === window.localStorage && sessionStorage.getItem("mt.full") && k.startsWith("morphotrace.v1")) throw new DOMException("quota", "QuotaExceededError");
      return realSet.call(this, k, v);
    };
    // reset before the app starts: clearing from the test would be undone by the app's save on unload
    if (sessionStorage.getItem("mt.reset")) { sessionStorage.removeItem("mt.reset"); localStorage.clear(); }
    if (sessionStorage.getItem("mt.block")) Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } });
  });
  const flag = (k, on) => page.evaluate(([k, on]) => (on ? sessionStorage.setItem(k, "1") : sessionStorage.removeItem(k)), [k, on]);

  // 1. normal autosave
  await page.evaluate(() => { sessionStorage.clear(); sessionStorage.setItem("mt.reset", "1"); });
  await page.reload(); await loadFixture();
  await drawSquare(-60);
  check((await banner()) === "", "no warning while autosave works");
  check(await page.evaluate(() => JSON.parse(localStorage.getItem("morphotrace.v1")).annotations["fixture_200x150.png"].polygons.length === 1), "polygon autosaved");

  // 2. storage full → persistent warning, leaving asks for confirmation, export clears that
  await flag("mt.full", true);
  await drawSquare(60);
  check(/storage is full/.test(await banner()), "quota error shows the 'storage is full' warning");
  await page.waitForTimeout(3000);
  check(/storage is full/.test(await banner()), "warning persists (not a 2.5 s flash)");
  check(await leaveBlocked(), "closing the tab asks for confirmation with unexported changes");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#saveWarnExport")]);
  let txt = ""; for await (const c of await dl.createReadStream()) txt += c;
  check(JSON.parse(txt).images[0].polygons.length === 2, "'Export JSON now' downloads all work, including the unsaved polygon");
  check(!(await leaveBlocked()), "no confirmation once the work is exported");

  // 3. storage recovers → warning disappears
  await flag("mt.full", false);
  await drawSquare(0);
  check((await banner()) === "", "warning disappears when autosave works again");

  // 4. storage blocked at start-up (private window, blocked site data)
  await flag("mt.block", true);
  await page.reload();
  check(/blocks local storage/.test(await banner()), "blocked storage is reported at start-up");
  await flag("mt.block", false);
  await page.reload();

  // 5. unreadable autosave is kept, not overwritten
  // write the corrupt value from an init script, after the app's unload save
  await page.evaluate(() => sessionStorage.setItem("mt.corrupt", "1"));
  await page.addInitScript(() => { if (sessionStorage.getItem("mt.corrupt")) { sessionStorage.removeItem("mt.corrupt"); localStorage.setItem("morphotrace.v1", "{not json"); } });
  await page.reload();
  check(/could not be read/.test(await banner()), "unreadable autosave is reported");
  check(await page.evaluate(() => localStorage.getItem("morphotrace.v1.unreadable") === "{not json" && localStorage.getItem("morphotrace.v1") === null), "unreadable autosave kept under .unreadable");

  await page.evaluate(() => sessionStorage.setItem("mt.reset", "1"));
  await page.reload();
  return passed;
}
