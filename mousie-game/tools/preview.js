// Film one cartoon scene as screenshots and report errors.
// Usage: NODE_PATH=$(npm root -g) node tools/preview.js <built.html> <sceneName> <outDir> [seconds=14] [every=1.5]
const { chromium } = require("playwright");
(async () => {
  const [file, sceneName, outDir, secs = "14", every = "1.5"] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto("file://" + require("path").resolve(file));
  const idx = await p.evaluate((n) => { settings.read = false; settings.sound = false; return STEPS.findIndex((s) => s.scene === n); }, sceneName);
  if (idx < 0) { console.log("no such scene:", sceneName); process.exit(1); }
  await p.evaluate((i) => goStep(i), idx);
  let n = 0;
  for (let t = 0; t <= +secs; t += +every) {
    await p.waitForTimeout(+every * 1000);
    const info = await p.evaluate(() => ({ step: game.step, beat: cut ? cut.beat : null, bubble: cut && cut.bubble ? cut.bubble.who + ": " + cut.bubble.text : "" }));
    await p.locator("#cv").screenshot({ path: `${outDir}/${sceneName}-${String(n++).padStart(2, "0")}.png` });
    console.log(`t=${(t + +every).toFixed(1)}s step=${info.step} beat=${info.beat} ${info.bubble}`);
    if (info.step !== idx) { console.log("scene finished → moved to step", info.step, JSON.stringify(STEPS_NAME(info.step))); break; }
  }
  console.log("errors:", JSON.stringify(errs));
  await b.close();
  function STEPS_NAME(i) { return i; }
})();
