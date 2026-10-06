// Scene: walking through the jungle (the scenery scrolls like a camera following Mousie),
// Birdie flies in and they set off together.
SCENES.jungle = {
  setup(c) {
    c.actors.mousie = actor(drawMouse, 300, GROUND, 1, { head: 115, walkScroll: true, z: 1 });
    c.actors.birdie = actor(drawBird, 1060, GROUND - 210, 1, { head: 30, fly: true, z: 2 });
    c.butterflies = [0, 1, 2].map((i) => ({ x: 200 + i * 320, y: 150 + i * 40 }));
  },
  bg(c) { drawForest(c.scroll); },
  front(c) {
    for (const b of c.butterflies) {
      const x = ((b.x - c.scroll * 0.9) % 1100 + 1100) % 1100 - 70;
      ctx.font = '34px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      ctx.textAlign = "center";
      ctx.fillText("🦋", x, b.y + Math.sin(c.t * 4 + b.x) * 18);
    }
    drawJungleFront(c.scroll);
  },
  beats: [
    { do(c) { c.scrollSpeed = 200; }, wait: 2.6 },
    { do(c) { moveTo(c.actors.birdie, 480, 300); }, until: (c) => arrived(c.actors.birdie) },
    { say: ["Birdie", "Hi Mousie!", "chirp"], do(c) { c.scrollSpeed = 0; } },
    { say: ["Mousie", "We're going on an adventure!"], do(c) { hop(c.actors.mousie, 420); } },
    { do(c) { c.actors.birdie.flip = false; moveTo(c.actors.birdie, 420, 120); c.scrollSpeed = 260; }, wait: 1.2 },
    { say: ["Narrator", "Off they go, deep into the jungle!"] },
    { wait: 1.6 },
  ],
};
