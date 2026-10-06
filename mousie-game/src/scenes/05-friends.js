// Scene: the T-Rex is beaten! Smoke settles in the cave, Mousie and Birdie cheer and walk out
// into the sunny jungle, where a friendly red snake shows off a pet lion and a fire truck.
function friendsPuff(c, x, y, r) { c.smoke.push({ x, y, r, life: 2.2 + Math.random(), max: 3, vx: (Math.random() - 0.5) * 40 }); }
function friendsDrawSmoke(c) {
  for (const p of c.smoke) {
    ctx.globalAlpha = Math.max(0, Math.min(0.55, p.life / p.max));
    ctx.fillStyle = "#cfc6bb";
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function friendsDrawFlock(c) {
  for (const b of c.flock) drawBird(b.x, b.y, 0.42, { t: c.t + b.x * 0.01, flip: b.flip, still: !b.fly, legs: !b.fly });
}
SCENES.friends = {
  setup(c) {
    c.inJungle = false;
    c.smoke = []; c.flock = [];
    c.actors.mousie = actor(drawMouse, 420, GROUND, 1, { head: 115, z: 2 });
    c.actors.birdie = actor(drawBird, 560, GROUND - 190, 1, { head: 30, fly: true, z: 3 });
    for (let i = 0; i < 9; i++) friendsPuff(c, 200 + Math.random() * 640, 200 + Math.random() * 240, 50 + Math.random() * 60);
    burst(480, 260, 40, ["#ffd75e", "#fff6c9", "#f0a040"], 380, 6, 1.4);
    shake = 14;
  },
  bg(c) {
    if (c.inJungle) {
      drawForest(c.scroll);
      friendsDrawFlock(c);
    } else drawCave(0);
  },
  front(c) {
    if (c.inJungle) drawJungleFront(c.scroll);
    else friendsDrawSmoke(c);
  },
  update(c, dt) {
    for (const p of c.smoke) { p.life -= dt; p.r += 14 * dt; p.y -= 10 * dt; p.x += p.vx * dt; }
    c.smoke = c.smoke.filter((p) => p.life > 0);
    // twinkly sparkles settle while still in the cave
    if (!c.inJungle && c.t < 5 && Math.random() < dt * 6) burst(120 + Math.random() * 720, 120 + Math.random() * 200, 4, ["#fff6c9", "#ffd75e"], 90, 4, 1);
    // little birds: peck on the ground, then scatter when the lion zooms past
    const lion = c.actors.lion;
    for (const b of c.flock) {
      if (!b.fly && lion && lion.x > b.x - 260) { b.fly = true; b.vx = 160 + Math.random() * 200; b.vy = -260 - Math.random() * 160; sfx.chirp(); }
      if (b.fly) { b.x += b.vx * dt; b.y += b.vy * dt; }
      else b.y = GROUND - 14 - Math.abs(Math.sin(c.t * 5 + b.x)) * 6;
    }
    // dust behind the speeding lion and the fire truck
    if (lion && lion.tx !== null && Math.random() < dt * 30) burst(lion.x - 70, lion.y - 6, 2, ["#d9c49a", "#c8a46b"], 120, 7, 0.5);
    const ft = c.actors.firetruck;
    if (ft && ft.tx !== null && Math.random() < dt * 20) burst(ft.x - 110 * ft.s * (ft.flip ? -1 : 1), ft.y - 6, 2, ["#d9c49a", "#c8a46b"], 90, 6, 0.5);
  },
  beats: [
    // ---- in the cave: the smoke clears ----
    { wait: 1.4 },
    { do(c) { hop(c.actors.mousie, 560); hop(c.actors.birdie, 300); sfx.squeak(); addText("Hooray!", 480, 170, "#ffd75e", 64, 1.4); burst(c.actors.mousie.x, GROUND - 120, 24, ["#ffd75e", "#f07a8a", "#3d7fd6", "#7cb35a"], 320, 6, 1.1); }, wait: 1.1 },
    { say: ["Mousie", "We won the day!"], do(c) { hop(c.actors.mousie, 620); } },
    { do(c) { hop(c.actors.birdie, 350); hop(c.actors.mousie, 450); sfx.chirp(); burst(c.actors.birdie.x, c.actors.birdie.y, 18, ["#fff6c9", "#ffd75e"], 260, 5, 0.9); }, wait: 0.9 },
    // walk out of the cave toward the daylight on the left
    { do(c) { moveTo(c.actors.mousie, -120, 260); moveTo(c.actors.birdie, -60, 280); }, until: (c) => c.actors.mousie.x < 140 },
    { do(c) { c.fadeTo = 1; }, wait: 0.7 },
    // ---- out in the bright jungle ----
    { do(c) {
      const m = c.actors.mousie, b = c.actors.birdie;
      c.inJungle = true; c.smoke = []; parts = [];
      m.x = 300; m.tx = null; m.flip = false; m.walkScroll = true;
      b.x = 420; b.y = GROUND - 285; b.tx = null; b.flip = false;
      c.flock = [0, 1, 2, 3].map((i) => ({ x: 760 + i * 52, y: GROUND - 14, fly: false, flip: i % 2 === 1 }));
      c.scrollSpeed = 200; c.fadeTo = 0;
    }, wait: 2.2 },
    { do(c) {
      c.actors.snake = actor(drawSnake, 1080, GROUND, 1, { head: 70, z: 2, o: { wiggle: true } });
      moveTo(c.actors.snake, 620, 230);
    }, until: (c) => c.actors.snake.x < 760 },
    { do(c) { c.scrollSpeed = 0; }, until: (c) => arrived(c.actors.snake) },
    { say: ["Mousie", "Hi Snake!! Why are you here??"], do(c) { c.actors.snake.o.wiggle = false; hop(c.actors.mousie, 420); } },
    { say: ["Snake", "Your daddy sent me to see if you need any help."], do(c) { hop(c.actors.snake, 260); } },
    { say: ["Snake", "Guys!! Look at my pet lion!"], do(c) { c.actors.snake.o.wiggle = true; } },
    // the lion zooms past in the front lane
    { do(c) {
      c.actors.snake.o.wiggle = false;
      c.actors.lion = actor(drawLion, -260, GROUND + 38, 1.05, { head: 95, z: 6, o: { run: true } });
      moveTo(c.actors.lion, 1260, 1150);
      sfx.zoom(); shake = 6;
      addText("ZOOOOM!", 600, 130, "#f0a040", 84, 1.6);
    }, until: (c) => arrived(c.actors.lion) },
    { do(c) { hop(c.actors.mousie, 520); hop(c.actors.birdie, 300); hop(c.actors.snake, 300); addText("Wow!", c.actors.mousie.x, GROUND - 170, "#ffd75e", 50, 1.1); }, wait: 1 },
    { say: ["Snake", "Guys!! Look at my fire truck!!"], do(c) { c.actors.lion.visible = false; c.actors.snake.o.wiggle = true; } },
    // the fire truck drives in and stops to say hello
    { do(c) {
      c.actors.snake.o.wiggle = false;
      c.actors.firetruck = actor(drawTruck, -300, GROUND + 40, 0.9, { head: 120, z: 6 });
      moveTo(c.actors.firetruck, 440, 520);
    }, until: (c) => arrived(c.actors.firetruck) },
    { say: ["Fire truck", "NEEE-NAW, NEEE-NAW!", "siren"], do(c) { hop(c.actors.firetruck, 240); hop(c.actors.mousie, 420); hop(c.actors.birdie, 250); } },
    { do(c) { moveTo(c.actors.firetruck, 1300, 560); }, until: (c) => arrived(c.actors.firetruck) },
    { do(c) { hop(c.actors.mousie, 500); hop(c.actors.snake, 300); sfx.hehe(); addText("So cool!", 560, 330, "#ffd75e", 56, 1.4); }, wait: 1.6 },
  ],
};
