// Scene: Mousie and Birdie find a cave, tiptoe inside and meet a Velociraptor.
const CAVE_MOUTH_START = 1250; // where the cave mouth starts (screen x at scroll 0)
const CAVE_MOUTH_STOP = 640; // screen x where the camera stops in front of it

function caveMouthX(c) { return CAVE_MOUTH_START - c.scroll; }

SCENES.cave = {
  setup(c) {
    c.actors.mousie = actor(drawMouse, 280, GROUND, 1, { head: 115, walkScroll: true, z: 1 });
    c.actors.birdie = actor(drawBird, 390, GROUND - 250, 1, { head: 30, fly: true, z: 2 });
    c.inside = false;
    c.entering = false;
    c.tremble = false;
  },
  bg(c) {
    if (c.inside) { drawCave(c.scroll, false); return; }
    drawForest(c.scroll);
    const mx = caveMouthX(c);
    if (mx < W + 200) drawCaveMouth(mx);
  },
  update(c, dt) {
    const m = c.actors.mousie, b = c.actors.birdie;
    // camera stops when the cave mouth is in front of them
    if (!c.inside && !c.entering && c.scrollSpeed > 0 && caveMouthX(c) <= CAVE_MOUTH_STOP) {
      c.scroll = CAVE_MOUTH_START - CAVE_MOUTH_STOP;
      c.scrollSpeed = 0;
    }
    // walking into the dark mouth: get smaller and fade into the shadow
    if (c.entering) {
      for (const a of [m, b]) {
        const k = Math.max(0, Math.min(1, (CAVE_MOUTH_STOP + 30 - a.x) / 220)); // 1 = outside, 0 = deep in the dark
        a.s = 0.5 + 0.5 * k;
        a.alpha = k;
      }
      m.y = GROUND - (1 - m.s) * 60; // a little further away = a little higher
      b.y = Math.min(GROUND - 110, b.y + dt * 110);
    }
    if (c.eyes > 0) c.eyes = Math.min(1, c.eyes + dt * 1.5);
    // nervous tiptoe: little bouncy steps
    if (c.inside && c.scrollSpeed > 0) m.y = GROUND - Math.abs(Math.sin(c.t * 7)) * 7;
    else if (c.inside) m.y = GROUND;
    // trembling with fright
    if (c.tremble) m.x = c.mx0 + Math.sin(c.t * 70) * 3.5;
  },
  front(c) {
    if (!c.inside) drawJungleFront(c.scroll);
    // the raptor's glowing eyes in the dark before it steps out
    if (c.eyes > 0) {
      ctx.globalAlpha = Math.min(1, c.eyes);
      const blink = Math.sin(c.t * 3) > 0.92 ? 0.2 : 1;
      ell(880, 300, 9, 7 * blink, "#ffd75e", 0, false);
      ell(910, 296, 9, 7 * blink, "#ffd75e", 0, false);
      ctx.globalAlpha = 1;
    }
  },
  beats: [
    // walking through the jungle until the cave scrolls into view
    { do(c) { c.scrollSpeed = 220; }, wait: 1, until: (c) => c.scrollSpeed === 0 },
    { say: ["Mousie", "Look! A cave!"], do(c) { hop(c.actors.mousie, 420); sfx.squeak(); addText("!", c.actors.mousie.x + 30, GROUND - 150, "#ffd75e", 60, 1); } },
    { say: ["Birdie", "Let's go inside!", "chirp"], do(c) { hop(c.actors.birdie, 300); } },
    // into the dark mouth
    { do(c) {
        c.entering = true;
        moveTo(c.actors.mousie, CAVE_MOUTH_STOP + 30, 150);
        moveTo(c.actors.birdie, CAVE_MOUTH_STOP + 30, 150);
      }, wait: 1, until: (c) => arrived(c.actors.mousie, c.actors.birdie) },
    { do(c) { c.fadeTo = 1; }, wait: 0.6 },
    // inside the cave
    { do(c) {
        const m = c.actors.mousie, b = c.actors.birdie;
        c.inside = true; c.entering = false; c.scroll = 0;
        Object.assign(m, { x: 250, y: GROUND, s: 1, alpha: 1, flip: false, tx: null });
        Object.assign(b, { x: 360, y: GROUND - 250, s: 1, alpha: 1, flip: false, tx: null });
        c.fade = 1; c.fadeTo = 0;
        c.scrollSpeed = 70;
      }, wait: 1 },
    { say: ["Narrator", "Mousie and Birdie tiptoe into the dark cave."], wait: 1.5 },
    // something is watching...
    { do(c) { c.eyes = 0.01; }, wait: 1.2 },
    // the Velociraptor stalks in
    { do(c) {
        c.scrollSpeed = 0;
        c.eyes = 0;
        c.actors.velociraptor = actor(drawRaptor, 1180, GROUND, 1.35, { head: 128, flip: true, z: 0 });
        moveTo(c.actors.velociraptor, 880, 120);
        sfx.hit();
      }, until: (c) => arrived(c.actors.velociraptor) },
    { do(c) { moveTo(c.actors.velociraptor, 800, 50); }, wait: 0.4 },
    { say: ["Birdie", "Look, a Velociraptor!", "chirp"], do(c) {
        const b = c.actors.birdie;
        hop(b, 380);
        addText("!!", b.x + 70, b.y, "#ffd75e", 56, 1.1);
      } },
    { say: ["Mousie", "Oh no! What do we do?", "squeak"], do(c) {
        c.mx0 = c.actors.mousie.x; c.tremble = true;
        moveTo(c.actors.velociraptor, 760, 40);
      } },
    { say: ["Birdie", "I think we should fight it."], do(c) { hop(c.actors.birdie, 250); } },
    { say: ["Mousie", "Ok."], do(c) {
        c.tremble = false; c.actors.mousie.x = c.mx0;
        hop(c.actors.mousie, 360);
      } },
    // Birdie gets the bow ready
    { do(c) {
        const b = c.actors.birdie;
        b.o.bow = true; b.flip = false;
        hop(b, 300);
        sfx.cheese();
        burst(b.x + 30, b.y, 14, ["#ffd75e", "#fff", "#f0a040"], 220, 5, 0.7);
        addText("Ready!", b.x, b.y - 60, "#ffd75e", 44, 1.4);
        c.actors.velociraptor.o.hurt = 0;
      }, wait: 1.4 },
    { do(c) { sfx.roar(); shake = 8; addText("GRRR!", c.actors.velociraptor.x - 40, GROUND - 230, "#fff", 48, 1.2); }, wait: 1.4 },
  ],
};
