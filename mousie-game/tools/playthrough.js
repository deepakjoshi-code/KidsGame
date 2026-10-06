// Play the whole game start to finish (skipping through scenes, playing each level) and report errors.
// Usage: NODE_PATH=$(npm root -g) node tools/playthrough.js <built.html> [outDir]
const { chromium } = require("playwright");
(async () => {
  const [file, outDir] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto("file://" + require("path").resolve(file));
  await p.evaluate(() => { settings.read = false; settings.sound = false; });
  const press = async (k, n = 1, wait = 150) => { for (let i = 0; i < n; i++) { await p.keyboard.press(k); await p.waitForTimeout(wait); } };
  await press(" ");
  const seen = [];
  for (let guard = 0; guard < 600; guard++) {
    const st = await p.evaluate(() => ({ step: game.step, lvl: scene && scene.id, won: scene && scene.won, cut: cut && cut.id, end: !document.getElementById("end").hidden }));
    if (st.end) { seen.push("END"); break; }
    if (st.cut) { if (!seen.includes(st.cut)) { seen.push(st.cut); outDir && await p.screenshot({ path: `${outDir}/scene-${st.cut}.png` }); } await press(" ", 1, 400); continue; }
    if (!st.lvl) { await p.waitForTimeout(200); continue; }
    if (!seen.includes(st.lvl)) seen.push(st.lvl);
    if (st.won) { await p.waitForTimeout(1000); await press(" "); continue; }
    if (st.lvl === "run") { await p.evaluate(() => { scene.dist = scene.goal - 900; }); await p.waitForTimeout(4000); continue; }
    if (st.lvl === "raptor") { await press(" ", 12, 250); await p.waitForTimeout(1500); continue; }
    if (st.lvl === "trex") { await press("b"); await press(" ", 30, 220); await p.waitForTimeout(2500); continue; }
    if (st.lvl === "parade") { for (const k of ["1", "2", "3", "4"]) await press(k, 1, 300); await p.waitForTimeout(500); await press(" "); continue; }
    if (st.lvl === "climb") { await press(" ", 10, 200); await p.waitForTimeout(1500); continue; }
  }
  console.log("visited:", seen.join(" → "));
  console.log("errors:", JSON.stringify(errs));
  await b.close();
})();
