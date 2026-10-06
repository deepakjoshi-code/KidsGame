// Check the layout on iPhone screen sizes, upright and sideways.
// Usage: NODE_PATH=$(npm root -g) node tools/phones.js <built.html> <outDir>
const { chromium, devices } = require("playwright");
const PHONES = {
  "SE": [375, 667], "15-16": [393, 852], "16-Plus-ProMax": [430, 932], "17-ProMax": [440, 956],
};
(async () => {
  const [file, out] = process.argv.slice(2);
  const b = await chromium.launch();
  for (const [name, [w, h]] of Object.entries(PHONES)) for (const orient of ["up", "side"]) {
    const vp = orient === "up" ? { width: w, height: h } : { width: h, height: w };
    const c = await b.newContext({ ...devices["iPhone 13"], viewport: vp });
    const p = await c.newPage(); const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    await p.goto("file://" + require("path").resolve(file));
    await p.evaluate(() => { settings.read = false; settings.sound = false; });
    const tag = `${name}-${orient}`;
    await p.screenshot({ path: `${out}/${tag}-0title.png` });
    await p.evaluate(() => goStep(STEPS.findIndex((s) => s.scene === "jungle")));
    await p.waitForTimeout(6500);
    await p.screenshot({ path: `${out}/${tag}-1scene.png` });
    await p.evaluate(() => goStep(STEPS.findIndex((s) => s.level === "parade")));
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}/${tag}-2parade.png` });
    const m = await p.evaluate(() => {
      const r = document.documentElement;
      const btn = [...document.querySelectorAll("#controls .act")].map((e) => e.getBoundingClientRect());
      const cv = document.getElementById("cv").getBoundingClientRect();
      return { overflow: r.scrollWidth > innerWidth || r.scrollHeight > innerHeight, smallestBtn: Math.round(Math.min(...btn.map((x) => Math.min(x.width, x.height)))), canvas: `${Math.round(cv.width)}x${Math.round(cv.height)}`, offscreen: btn.some((x) => x.bottom > innerHeight || x.right > innerWidth) };
    });
    console.log(tag.padEnd(22), JSON.stringify(m), errs.length ? "ERR " + errs : "");
    await c.close();
  }
  await b.close();
})();
