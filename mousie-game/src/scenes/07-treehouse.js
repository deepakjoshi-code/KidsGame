// Scene: Mousie reaches the top of the ladder, Birdie flies up, and Daddy pops out of the
// treehouse door to welcome them home. The End... for now!
const TREEHOUSE_CONFETTI = ["#ffd75e", "#f07a8a", "#3d7fd6", "#7cb35a", "#e0574f", "#fff6c9"];
// Up on the platform a normal bubble would sit on top of the speaker's head, so lines up there
// are drawn by this scene instead: a bubble beside the head, or a caption lower down.
function treehouseSideBubble(text, ax, ay, side) {
  const lines = wrapText(text, side === "left" ? 300 : 220);
  ctx.font = BUBBLE_FONT;
  const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 40, bh = lines.length * 32 + 26;
  const bx = side === "left" ? Math.max(16, ax - 36 - bw) : Math.min(W - bw - 16, ax + 36);
  const by = Math.max(34, Math.min(H - bh - 60, ay - bh / 2 - 20));
  const edge = side === "left" ? bx + bw - 2 : bx + 2, my = Math.min(by + bh - 24, Math.max(by + 24, ay));
  ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 22); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(edge, my - 13); ctx.lineTo(ax, ay); ctx.lineTo(edge, my + 13); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillRect(side === "left" ? edge - 6 : edge, my - 11, 6, 22);
  ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  lines.forEach((l, i) => ctx.fillText(l, bx + bw / 2, by + 29 + i * 32));
  ctx.textBaseline = "alphabetic";
}
function treehouseCaption(text, y) {
  const lines = wrapText(text, 520);
  ctx.font = BUBBLE_FONT;
  const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 40, bh = lines.length * 32 + 26, bx = (W - bw) / 2;
  ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.fillStyle = "#fff6c9";
  ctx.fillRect(bx, y, bw, bh); ctx.strokeRect(bx, y, bw, bh);
  ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y + 29 + i * 32));
  ctx.textBaseline = "alphabetic";
}
// Daddy's raised arm, waving hello.
function treehouseDrawWave(a, t) {
  const s = a.s, x = a.x + 22 * s, y = a.y + a.jy - 62 * s;
  ctx.save(); ctx.lineWidth = 3;
  ell(x, y, 6 * s, 14 * s, a.o.color, 0.5 + Math.sin(t * 10) * 0.45);
  ctx.restore();
}
SCENES.treehouse = {
  setup(c) {
    c.climbStep = 0; c.climbT = 0; c.party = 0; c.own = null;
    c.actors.mousie = actor(drawMouse, 555, 310, 1, { head: 115, z: 3 });
    c.actors.birdie = actor(drawBird, 340, 640, 1, { head: 30, fly: true, z: 4 });
    c.actors.daddy = actor(drawMouse, 622, 160, 0.2, { head: 115, z: 2, flip: true, visible: false, o: { color: "#8a6440" } });
  },
  bg() { drawTreeHouse(10); },
  front(c) {
    // take over the bubble for the speakers standing on the platform (and the narrator);
    // front() runs just before the engine draws bubbles, so it never flashes in the wrong place
    if (c.bubble && c.bubble.who !== "Birdie") { c.own = { ...c.bubble, beat: c.beat }; c.bubble = null; }
    const d = c.actors.daddy;
    d.o.wave = !!c.wave; // painted Daddy wiggles happily (photo.js)
    if (d.visible && c.wave && !photoHas("daddy")) treehouseDrawWave(d, c.t);
    // lines spoken up on the platform
    const b = c.own;
    if (!b || b.beat !== c.beat || uprightPhone.matches) return; // upright phones show the words in the caption
    if (b.who === "Mousie") { const m = c.actors.mousie; treehouseSideBubble(b.text, m.x - 22, m.y + m.jy - 80, "left"); }
    else if (b.who === "Daddy") treehouseSideBubble(b.text, d.x + 30 * d.s, d.y + d.jy - 82 * d.s, "right");
    else treehouseCaption(b.text, 300);
  },
  update(c, dt) {
    const m = c.actors.mousie, b = c.actors.birdie, d = c.actors.daddy;
    // climbing the last rungs, one rung at a time
    if (c.climbing && m.y > 160) {
      c.climbT -= dt;
      if (c.climbT <= 0) { c.climbT = 0.42; m.ty = Math.max(160, m.y - 30); sfx.climb(7 + c.climbStep++); }
      m.y += (m.ty - m.y) * Math.min(1, dt * 14);
      if (m.y - 160 < 0.6) m.y = 160;
    }
    if (c.birdieTY !== undefined) b.y += (c.birdieTY - b.y) * Math.min(1, dt * 2.5);
    // Daddy pops out of the door with a springy grow
    if (d.visible && d.s < 1.1) d.s = Math.min(1.1, d.s + dt * 4);
    if (c.party > 0) {
      c.party -= dt;
      if (Math.random() < dt * 12) burst(60 + Math.random() * 840, 50 + Math.random() * 60, 6, TREEHOUSE_CONFETTI, 150, 5, 1.6);
    }
  },
  beats: [
    { wait: 0.7 },
    { do(c) { c.climbing = true; c.climbT = 0; }, until: (c) => c.actors.mousie.y <= 160 },
    { do(c) { c.climbing = false; moveTo(c.actors.mousie, 500, 110); }, until: (c) => arrived(c.actors.mousie) },
    { do(c) {
      const m = c.actors.mousie;
      m.flip = false; hop(m, 520); sfx.squeak();
      addText("Yay!", m.x - 120, 115, "#ffd75e", 48, 1.1);
      burst(m.x, m.y - 60, 16, ["#fff6c9", "#ffd75e"], 240, 5, 0.9);
    }, wait: 1 },
    { do(c) { c.birdieTY = 240; moveTo(c.actors.birdie, 360, 60); sfx.chirp(); }, until: (c) => c.actors.birdie.y < 260 },
    { say: ["Mousie", "It's perfect! Safe and wonderful."], do(c) { hop(c.actors.mousie, 300); } },
    { say: ["Birdie", "Hooray! We made it!", "fanfare"], do(c) {
      hop(c.actors.birdie, 300); hop(c.actors.mousie, 500);
      [240, 520, 780].forEach((x) => burst(x, 120, 28, TREEHOUSE_CONFETTI, 380, 6, 1.4));
      c.party = 1.4;
    } },
    { wait: 0.5 },
    { do(c) {
      const d = c.actors.daddy;
      d.visible = true; hop(d, 380); c.wave = true; sfx.squeak();
      addText("!", d.x, 40, "#e0574f", 56, 0.9);
      hop(c.actors.mousie, 420);
    }, wait: 1 },
    { say: ["Daddy", "Welcome home, my brave little Mousie!"], do(c) { hop(c.actors.daddy, 220); } },
    { do(c) {
      hop(c.actors.mousie, 460); c.wave = false;
      addText("♥", 562, 80, "#e0574f", 60, 1.6);
      sfx.squeak();
    }, wait: 1.3 },
    { say: ["Narrator", "The End... for now!", "fanfare"], do(c) { c.party = 3.5; c.wave = true; hop(c.actors.mousie, 400); hop(c.actors.birdie, 260); } },
    { wait: 2.2 },
  ],
};
