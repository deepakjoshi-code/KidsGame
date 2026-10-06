# Mousie: The Adventure Game

A cartoon adventure game made from Samar's comic *Mousie, Part 1*. The story plays as animated scenes (Mousie and Birdie walk through the jungle, meet the dinosaurs, and so on), with speech bubbles and read-aloud, and five button games in between.

## Play on an iPhone or iPad
Open the game link in Safari and turn the phone sideways. To keep it like an app, tap Share → **Add to Home Screen**.
If there is no sound, check that the ring/silent switch is not on silent.

## Play on a Mac
1. Download `Mousie.html`.
2. Double-click it. It opens in Safari (or Chrome) and works offline.
3. Click **Play!**

Big buttons on screen do everything. The keyboard works too: **space** is the main button, **B** drops a bomb, **1–4** pick friends.
There is no way to lose. Turn off **Read to me** or **Sounds** at the top if you like.

## Levels
1. Forest Run: JUMP over logs, grab cheese
2. Velociraptor: Birdie shoots ARROWS
3. The Mighty T-Rex: ARROWS and BOMBS
4. Play with Friends: Lion, Fire truck, Snake, Birdie
5. Climb Home: CLIMB to the treehouse

## Editing
Game code and the cartoon engine are in `src/game.html`; each animated scene is its own file in `src/scenes/`. Book art used on the title and end screens is in `art/`.

### Painted characters and real photo places
Samar's characters, cut out of his comic, walk through real photos (jungle, cave, tree house). `src/photo.js` does this, and `build.py` inlines it.
- `assets/manifest.json` lists the pictures. Under `characters`, each entry has `file`, `w`, `h`, `facing`, `feet`, `credit` and optional `poses` (`dead`, `roar`, `run`, `fly`). Under `backgrounds`, each entry has `file`, `w`, `h`, `ground`, `credit` and an optional `anchor`. `ground` is how far down the photo the floor is, as a fraction of its height. `anchor` is how far across the cave opening or tree house is, as a fraction of its width (default 0.5).
- Any picture can be missing. That character or place is then drawn as the old cartoon (the Velociraptor only has a "beaten" painting, so it stays a cartoon while it is fighting).
- Sizes, poses and colour grades are at the top of `src/photo.js` (`PHOTO_SIZE`, `PHOTO_GRADE`).
- Credits for every picture appear in the ⓘ button on the title screen and the **Photo & art credits** button at the end. They are needed for CC BY / BY-SA photos.

- Rebuild: `python3 build.py` (writes `Mousie.html`; `--assets <dir>` uses another assets folder, `--out <file>` writes somewhere else)
- Film one scene as screenshots: `NODE_PATH=$(npm root -g) node tools/preview.js Mousie.html jungle /tmp/shots`
- Play the whole game automatically: `NODE_PATH=$(npm root -g) node tools/playthrough.js Mousie.html`
