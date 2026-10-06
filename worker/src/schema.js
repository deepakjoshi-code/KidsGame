// What Claude must return when it reads a comic (structured output), and the limits the Worker
// enforces on the way in and out. Keys for places, characters, weapons and treasure come from the
// app's own catalog, so the plan only ever names things the game knows how to draw.
import { z } from "zod";
import { PLACE_KEYS, PLACES, CAST, WEAPONS, ITEMS } from "../../app/js/catalog.js";

export const MODEL = "claude-opus-5-5";
export const MAX_PANELS = 60;
export const MAX_BODY_BYTES = 12 * 1024 * 1024; // the whole JSON request body
export const MAX_SIDE = 1024; // each panel's long side, in pixels
export const MIN_SIDE = 16;
export const MAX_CAST = 8;
export const MAX_LEVELS = 6;
export const MAX_APPEARANCES = 3;

export { PLACE_KEYS, PLACES };
export const CAST_KEYS = CAST.map((c) => c.key);
export const WEAPON_EMOJI = [...WEAPONS.map((w) => w.emoji), "⭐"];
export const ITEM_EMOJI = ITEMS.map((i) => i.emoji);
export const LEVEL_KINDS = ["journey", "battle", "friends", "climb", "collect"];
export const LINE_KINDS = ["speech", "caption", "sfx"];
export const PARTS = ["cover", "story", "extra"];
export const ROLES = ["hero", "friend", "villain"];
export const FACES = ["left", "right", "front"];

const id = z.string().describe("A cast id: lowercase letters, digits and hyphens, e.g. \"hoppy\" or \"big-dragon\".");
const panelNo = z.number().int().describe("A panel number exactly as labelled in the input (\"Panel N\").");

export const Appearance = z.object({
  panel: panelNo,
  box: z.array(z.number()).describe("[x0, y0, x1, y1] in that panel's own pixels (the size given in its label), tight around the character's whole body."),
  faces: z.enum(FACES).describe("Which way the character looks or moves in this panel."),
});

export const Character = z.object({
  id,
  name: z.string().describe("The name as written in the comic (\"Hoppy\", \"Dragon\", \"Rocket\")."),
  role: z.enum(ROLES),
  big: z.boolean().describe("true only for a huge villain (a dinosaur, a dragon, a giant)."),
  kind: z.enum(CAST_KEYS).nullable().describe("The closest catalog character key, or null if none fits."),
  emoji: z.string().describe("One emoji that stands for this character (used if no cut-out works)."),
  appearances: z.array(Appearance).describe("Up to 3 panels where the character is shown biggest, clearest and least covered, best first."),
});

export const Line = z.object({
  speaker: id.nullable().describe("Cast id of who says it (follow the bubble's tail), or null for captions and sound effects nobody says."),
  text: z.string().describe("Exactly as written in the comic."),
  kind: z.enum(LINE_KINDS),
});

export const Panel = z.object({
  panel: panelNo,
  part: z.enum(PARTS).describe("cover = the cover or title page; story = part of the story; extra = credits, about the author, blank or a sliver with nothing in it."),
  place: z.enum(PLACE_KEYS),
  chapter: z.string().describe("Short chapter title (2-5 words) for the stretch of story this panel belongs to."),
  characters: z.array(id).describe("Cast ids of everyone visible in this panel."),
  lines: z.array(Line).describe("Every bubble, caption and sound effect in reading order."),
  narration: z.string().describe("Only for a story panel with no words at all: one short read-aloud sentence. Otherwise empty."),
});

export const Level = z.object({
  after_panel: panelNo.describe("The level plays right after this story panel."),
  kind: z.enum(LEVEL_KINDS),
  name: z.string().describe("Short level name, e.g. \"Forest Run\", \"Spider\", \"The Mighty Dragon\", \"Play with Friends\", \"Climb Home\"."),
  from: z.enum(PLACE_KEYS).nullable().describe("journey/climb: the place they set off from."),
  to: z.enum(PLACE_KEYS).nullable().describe("journey: the place they reach; \"home\" for the way home."),
  villain: id.nullable().describe("battle: the villain's cast id."),
  weapon: z.enum(WEAPON_EMOJI).nullable().describe("battle: the weapon the story uses; ⭐ when it names none."),
  super_weapon: z.enum(["💣"]).nullable().describe("battle: 💣 when bombs are mentioned for this fight, else null."),
  friends: z.array(id).describe("friends: cast ids of the friends newly introduced or showing off in that stretch (max 4). Empty for other kinds."),
  item: z.enum(ITEM_EMOJI).nullable().describe("collect: what they gather."),
  home: z.enum(["treehouse", "tower"]).nullable().describe("climb home: what they climb."),
});

export const ComicReading = z.object({
  title: z.string(),
  cast: z.array(Character),
  panels: z.array(Panel),
  levels: z.array(Level),
});
