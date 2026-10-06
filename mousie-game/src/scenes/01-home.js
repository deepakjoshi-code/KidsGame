// Scene: Mousie asks Daddy if they can go on an adventure.
SCENES.home = {
  setup(c) {
    c.actors.daddy = actor(drawMouse, 650, GROUND, 1.45, { flip: true, head: 115, z: 1, o: { color: "#8a6440" } });
    c.actors.mousie = actor(drawMouse, -90, GROUND, 1, { head: 115 });
  },
  bg(c) { drawForest(c.scroll); },
  beats: [
    { do(c) { moveTo(c.actors.mousie, 390, 170); }, wait: 0.3, until: (c) => arrived(c.actors.mousie) },
    { say: ["Mousie", "Hi Daddy. Can I go on an adventure with Birdie?"], do(c) { c.actors.mousie.flip = false; hop(c.actors.mousie, 380); } },
    { say: ["Daddy", "Ok."], do(c) { hop(c.actors.daddy, 260); } },
    { do(c) { hop(c.actors.mousie, 650); sfx.squeak(); addText("Yay!", c.actors.mousie.x, GROUND - 170, "#ffd75e", 52, 1.2); }, wait: 1 },
    { do(c) { moveTo(c.actors.mousie, 1080, 260); }, until: (c) => arrived(c.actors.mousie) },
  ],
};
