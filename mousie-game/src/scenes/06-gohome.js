// Scene: everyone cheers, Snake says goodbye, and Mousie and Birdie travel home through the
// jungle until the big tree with the treehouse slides into view.
const GOHOME_CONFETTI = ["#ffd75e", "#f07a8a", "#3d7fd6", "#7cb35a", "#e0574f", "#fff6c9"];
// Only the tree, house and ladder, slid sideways over our own scrolling forest.
function gohomeDrawTree(offsetX) {
  ctx.save(); ctx.translate(offsetX, 0);
  drawTreeHouse(10, 300, false);
  ctx.restore();
}
SCENES.gohome = {
  setup(c) {
    c.treeX = null;
    c.actors.mousie = actor(drawMouse, 250, GROUND, 1, { head: 115, z: 3 });
    c.actors.birdie = actor(drawBird, 370, GROUND - 200, 1, { head: 30, fly: true, z: 4 });
    c.actors.snake = actor(drawSnake, 560, GROUND, 1, { head: 70, z: 2, flip: true });
    c.actors.lion = actor(drawLion, 790, GROUND, 1, { head: 95, z: 1, flip: true });
  },
  bg(c) {
    const tint = c.treeX === null ? 0 : 0.12 * Math.max(0, 1 - c.treeX / 760);
    drawForest(c.scroll, tint);
    if (c.treeX !== null) gohomeDrawTree(c.treeX);
  },
  front(c) { drawJungleFront(c.scroll); },
  update(c, dt) {
    const s = c.actors.snake;
    if (c.waving && s.visible) s.rot = Math.sin(c.t * 9) * 0.12;
    if (c.party > 0) {
      c.party -= dt;
      if (Math.random() < dt * 10) burst(80 + Math.random() * 800, 60 + Math.random() * 80, 6, GOHOME_CONFETTI, 160, 5, 1.4);
    }
    // the tree is attached to the ground, so it slides at the same speed as the grass
    if (c.treeX !== null && c.treeX > 0) {
      c.treeX -= c.scrollSpeed * dt;
      if (c.treeX <= 0) { c.treeX = 0; c.scrollSpeed = 0; }
    }
  },
  beats: [
    { wait: 0.7 },
    { say: ["Everyone", "YAH!", "fanfare"], do(c) {
      for (const k of ["mousie", "birdie", "snake", "lion"]) hop(c.actors[k], k === "lion" ? 420 : 560);
      [200, 480, 760].forEach((x) => burst(x, 220, 30, GOHOME_CONFETTI, 420, 6, 1.4));
      c.party = 1.6; shake = 5;
    }, wait: 1 },
    { say: ["Mousie", "OK!!"], do(c) { hop(c.actors.mousie, 480); } },
    { say: ["Birdie", "Let's go home!!", "chirp"], do(c) { hop(c.actors.birdie, 300); } },
    { say: ["Snake", "Hehe", "hehe"], do(c) { c.actors.snake.o.wiggle = true; c.waving = true; hop(c.actors.snake, 260); }, wait: 1.3 },
    // Snake and the lion head off home too
    { do(c) {
      const s = c.actors.snake, l = c.actors.lion;
      c.waving = false; s.rot = 0;
      l.o.run = true;
      addText("Bye bye!", s.x + 60, GROUND - 120, "#e0574f", 44, 1.6);
      moveTo(s, 1150, 300); moveTo(l, 1250, 380);
      c.actors.mousie.flip = false; c.actors.birdie.flip = false;
    }, until: (c) => arrived(c.actors.snake, c.actors.lion) },
    { do(c) {
      c.actors.snake.visible = false; c.actors.lion.visible = false;
      c.actors.mousie.walkScroll = true;
      moveTo(c.actors.mousie, 300, 120); moveTo(c.actors.birdie, 400, 120);
      c.scrollSpeed = 230;
    }, wait: 2.6 },
    // the big tree comes into view and the walk stops at its foot
    { do(c) { c.treeX = 760; }, until: (c) => c.treeX <= 0 },
    { do(c) {
      c.actors.mousie.walkScroll = false;
      moveTo(c.actors.mousie, 555, 170);
      moveTo(c.actors.birdie, 440, 150);
    }, until: (c) => arrived(c.actors.mousie, c.actors.birdie) },
    { say: ["Narrator", "There's the tree house! Time to climb!"], do(c) {
      c.actors.mousie.flip = false; c.actors.mousie.rot = -0.3;
      c.actors.birdie.flip = false; c.actors.birdie.y = GROUND - 230;
      addText("Wow!", 555, 300, "#ffd75e", 52, 1.4);
    } },
    { do(c) { hop(c.actors.mousie, 380); sfx.squeak(); }, wait: 1.5 },
  ],
};
