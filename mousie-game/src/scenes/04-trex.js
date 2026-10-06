// Scene: the Velociraptor is beaten, then the Mighty T-Rex stomps in and a big bomb rolls up.
function trexDrawBomb(x, y, r, spin, t) {
  ctx.save();
  ctx.translate(x, y - r); ctx.rotate(spin);
  ctx.lineWidth = 3;
  ell(0, 0, r, r, "#222");
  ell(-r * 0.35, -r * 0.35, r * 0.25, r * 0.18, "rgba(255,255,255,.35)", -0.6, false); // shine
  ctx.fillStyle = "#555"; ctx.strokeStyle = INK; ctx.fillRect(-r * 0.25, -r - 8, r * 0.5, 12); ctx.strokeRect(-r * 0.25, -r - 8, r * 0.5, 12);
  ctx.strokeStyle = "#8a5a2b"; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(0, -r - 8); ctx.quadraticCurveTo(r * 0.3, -r - 30, r * 0.45, -r - 34); ctx.stroke();
  const fx = r * 0.45, fy = -r - 36, f = Math.random();
  ell(fx, fy, 6 + f * 5, 6 + f * 5, f < 0.5 ? "#ffd75e" : "#f0a040", 0, false);
  ell(fx, fy, 3, 3, "#fff", 0, false);
  ctx.restore();
}

SCENES.trex = {
  setup(c) {
    c.actors.mousie = actor(drawMouse, 230, GROUND, 1, { head: 115, z: 2 });
    c.actors.birdie = actor(drawBird, 370, GROUND - 290, 1, { head: 30, fly: true, z: 3, o: { bow: true } });
    // knocked out on its back, legs in the air (rot ≈ π reads as "lying down" far better than -1.45, which stands it on its tail)
    c.actors.velociraptor = actor(drawRaptor, 560, GROUND - 165, 1.35, { head: 0, flip: true, rot: Math.PI - 0.08, z: 1, o: { dead: true } });
    c.actors.trex = actor(drawTRex, 1200, GROUND, 1.15, { head: 290, flip: true, z: 0, visible: false });
    c.bomb = null;
    c.stepT = 0;
  },
  bg() { drawCave(0, true); },
  update(c, dt) {
    const tr = c.actors.trex;
    // stomp, stomp, stomp: every step is a hop with a shake and a puff of dust
    if (tr.visible && tr.tx !== null) {
      c.stepT -= dt;
      if (c.stepT <= 0) {
        c.stepT = 0.6;
        hop(tr, 260);
        shake = 12; sfx.bonk();
        burst(tr.x, GROUND, 10, ["#8a7a6a", "#a8957f"], 180, 6, 0.6);
        hop(c.actors.mousie, 200);
      }
    }
    // the bomb rolls in from the left
    const bm = c.bomb;
    if (bm && bm.x < bm.to) {
      bm.x = Math.min(bm.to, bm.x + 230 * dt);
      bm.spin = (bm.x - bm.to) / bm.r; // ends with the fuse pointing up
    }
  },
  front(c) {
    if (c.bomb) trexDrawBomb(c.bomb.x, GROUND, c.bomb.r, c.bomb.spin, c.t);
  },
  beats: [
    { wait: 0.8 },
    { say: ["Birdie", "Good, I took the arrows and fight!", "chirp"], do(c) {
        const b = c.actors.birdie;
        hop(b, 320);
        burst(b.x, b.y, 12, ["#ffd75e", "#fff", "#7fd3ff"], 220, 5, 0.7);
      } },
    { say: ["Birdie", "Hooray, Velociraptor died!", "fanfare"], do(c) {
        const b = c.actors.birdie;
        hop(b, 420); hop(c.actors.mousie, 460);
        addText("Hooray!", 560, 250, "#ffd75e", 64, 1.8);
        burst(560, 240, 30, ["#ffd75e", "#f0a040", "#d8453b", "#7fd3ff", "#ff8ad8"], 380, 7, 1.1);
      } },
    // the ground shakes...
    { do(c) {
        shake = 14; sfx.roar();
        addText("ROOR!", 760, 170, "#d8453b", 96, 1.8);
      }, wait: 1.3 },
    // ...and the Mighty T-Rex stomps in
    { do(c) {
        const tr = c.actors.trex;
        tr.visible = true; tr.o.roar = false; c.stepT = 0;
        moveTo(tr, 790, 110);
        c.actors.birdie.flip = false;
      }, until: (c) => arrived(c.actors.trex) },
    { say: ["Mousie", "Are you sure hooray? T-Rex came!", "squeak"], do(c) {
        hop(c.actors.mousie, 380);
        addText("?!", c.actors.mousie.x + 30, GROUND - 160, "#ffd75e", 56, 1.2);
      } },
    { say: ["T-Rex", "ROOR!", "roar"], do(c) {
        const tr = c.actors.trex;
        tr.o.roar = true; shake = 18;
        burst(tr.x - 150, GROUND - 260, 18, ["#fff", "#d8453b"], 320, 5, 0.6);
        moveTo(c.actors.mousie, 200, 260);
      }, wait: 1.4 },
    { say: ["Mousie", "Let's fight it!"], do(c) {
        const m = c.actors.mousie;
        c.actors.trex.o.roar = false;
        m.flip = false; hop(m, 420);
      } },
    { say: ["Birdie", "Ok, let's fight it with bombs and arrows!", "chirp"], do(c) {
        hop(c.actors.birdie, 320);
        c.bomb = { x: -80, to: 105, r: 46, spin: 0 };
        sfx.zoom();
      }, until: (c) => c.bomb.x >= c.bomb.to },
    { say: ["Mousie", "Look how big the bomb is! Let's do it!", "squeak"], do(c) {
        const m = c.actors.mousie;
        m.flip = true; hop(m, 520);
        addText("BIG!", c.bomb.x, GROUND - 150, "#ffd75e", 50, 1.2);
      } },
    { do(c) {
        const m = c.actors.mousie;
        m.flip = false; hop(m, 380);
        c.actors.trex.o.roar = true; shake = 8; sfx.roar();
      }, wait: 1 },
    { do(c) { c.actors.trex.o.roar = false; }, wait: 1 },
  ],
};
