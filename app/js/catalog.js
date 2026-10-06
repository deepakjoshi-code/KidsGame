// Pure data: characters, places, game kinds and keyword lists. No DOM here so it runs in tests too.

// faces: which way the emoji artwork looks on Apple devices ("left", "right" or "front").
export const CAST = [
  { key: "mouse", emoji: "🐁", label: "Mouse", words: ["mouse", "mousie", "mousey", "mice"], faces: "left" },
  { key: "bird", emoji: "🐦", label: "Bird", words: ["bird", "birdie", "birdy", "robin", "bluebird"], faces: "left" },
  { key: "cat", emoji: "🐈", label: "Cat", words: ["cat", "kitty", "kitten"], faces: "left" },
  { key: "dog", emoji: "🐕", label: "Dog", words: ["dog", "puppy", "doggy", "pup"], faces: "left" },
  { key: "bunny", emoji: "🐇", label: "Bunny", words: ["bunny", "rabbit"], faces: "left" },
  { key: "fox", emoji: "🦊", label: "Fox", words: ["fox"], faces: "front" },
  { key: "bear", emoji: "🐻", label: "Bear", words: ["bear", "teddy"], faces: "front" },
  { key: "lion", emoji: "🦁", label: "Lion", words: ["lion"], faces: "front" },
  { key: "tiger", emoji: "🐅", label: "Tiger", words: ["tiger"], faces: "left" },
  { key: "elephant", emoji: "🐘", label: "Elephant", words: ["elephant"], faces: "left" },
  { key: "monkey", emoji: "🐒", label: "Monkey", words: ["monkey"], faces: "left" },
  { key: "turtle", emoji: "🐢", label: "Turtle", words: ["turtle", "tortoise"], faces: "left" },
  { key: "frog", emoji: "🐸", label: "Frog", words: ["frog", "toad"], faces: "front" },
  { key: "penguin", emoji: "🐧", label: "Penguin", words: ["penguin"], faces: "front" },
  { key: "owl", emoji: "🦉", label: "Owl", words: ["owl"], faces: "front" },
  { key: "horse", emoji: "🐎", label: "Horse", words: ["horse", "pony"], faces: "left" },
  { key: "unicorn", emoji: "🦄", label: "Unicorn", words: ["unicorn"], faces: "left" },
  { key: "dolphin", emoji: "🐬", label: "Dolphin", words: ["dolphin"], faces: "left" },
  { key: "fish", emoji: "🐠", label: "Fish", words: ["fish"], faces: "left" },
  { key: "octopus", emoji: "🐙", label: "Octopus", words: ["octopus"], faces: "front" },
  { key: "snake", emoji: "🐍", label: "Snake", words: ["snake"], faces: "left" },
  { key: "dino", emoji: "🦕", label: "Dino", words: ["brontosaurus", "longneck", "diplodocus"], faces: "left" },
  { key: "raptor", emoji: "🦖", label: "Velociraptor", words: ["velociraptor", "raptor"], faces: "left", villain: true },
  { key: "trex", emoji: "🦖", label: "T-Rex", words: ["t-rex", "trex", "tyrannosaurus", "dinosaur"], faces: "left", villain: true, big: true },
  { key: "dragon", emoji: "🐉", label: "Dragon", words: ["dragon"], faces: "left", villain: true, big: true },
  { key: "shark", emoji: "🦈", label: "Shark", words: ["shark"], faces: "left", villain: true, big: true },
  { key: "spider", emoji: "🕷️", label: "Spider", words: ["spider"], faces: "front", villain: true },
  { key: "ghost", emoji: "👻", label: "Ghost", words: ["ghost"], faces: "front", villain: true },
  { key: "monster", emoji: "👾", label: "Monster", words: ["monster", "alien"], faces: "front", villain: true },
  { key: "ogre", emoji: "👹", label: "Ogre", words: ["ogre", "troll", "giant"], faces: "front", villain: true, big: true },
  { key: "zombie", emoji: "🧟", label: "Zombie", words: ["zombie"], faces: "front", villain: true },
  { key: "witch", emoji: "🧙‍♀️", label: "Witch", words: ["witch"], faces: "front", villain: true },
  { key: "robot", emoji: "🤖", label: "Robot", words: ["robot"], faces: "front" },
  { key: "wizard", emoji: "🧙", label: "Wizard", words: ["wizard"], faces: "front" },
  { key: "fairy", emoji: "🧚", label: "Fairy", words: ["fairy"], faces: "front" },
  { key: "superhero", emoji: "🦸", label: "Superhero", words: ["superhero", "hero"], faces: "front" },
  { key: "princess", emoji: "👸", label: "Princess", words: ["princess", "queen"], faces: "front" },
  { key: "prince", emoji: "🤴", label: "Prince", words: ["prince", "king"], faces: "front" },
  { key: "mermaid", emoji: "🧜‍♀️", label: "Mermaid", words: ["mermaid"], faces: "front" },
  { key: "boy", emoji: "👦", label: "Boy", words: ["boy", "brother"], faces: "front" },
  { key: "girl", emoji: "👧", label: "Girl", words: ["girl", "sister"], faces: "front" },
  { key: "dad", emoji: "👨", label: "Dad", words: ["daddy", "dad", "father", "papa"], faces: "front" },
  { key: "mom", emoji: "👩", label: "Mom", words: ["mommy", "mom", "mum", "mother", "mama"], faces: "front" },
  { key: "firetruck", emoji: "🚒", label: "Fire truck", words: ["fire truck", "firetruck", "fire engine"], faces: "left" },
  { key: "car", emoji: "🚗", label: "Car", words: ["car"], faces: "left" },
  { key: "rocket", emoji: "🚀", label: "Rocket", words: ["rocket", "spaceship"], faces: "right" },
];
export const CAST_BY_KEY = Object.fromEntries(CAST.map((c) => [c.key, c]));
export const FALLBACK_EMOJI = ["🧒", "🐱", "🐶", "🐰", "🐻", "🐼", "🐨", "🐯"];

export const PLACES = {
  forest: { label: "Forest", words: ["forest", "woods", "jungle", "trees"], sky: ["#bfe3e8", "#eaf3d6"], hill: "#a8cf8e", ground: "#7cb35a", path: "#c8a46b", props: ["🌳", "🌲", "🍄"], obstacles: ["🪵", "🪨"], goal: "🌳" },
  cave: { label: "Cave", words: ["cave", "tunnel", "underground"], sky: ["#3a2e26", "#55463a"], hill: "#4a3d33", ground: "#6b5a4a", path: "#5a4a3c", props: ["🪨", "💎", "🦇"], obstacles: ["🪨"], goal: "🕳️", dark: true },
  beach: { label: "Beach", words: ["beach", "sand", "shore", "island"], sky: ["#9fd8f5", "#fdf1c7"], hill: "#7cc6e8", ground: "#f1d58a", path: "#e6c271", props: ["🌴", "🐚", "⛱️"], obstacles: ["🦀", "🪨"], goal: "🏝️" },
  ocean: { label: "Under the sea", words: ["ocean", "sea", "underwater", "lake", "river"], sky: ["#3fa4d8", "#1d5f8f"], hill: "#2f86b8", ground: "#e2c98a", path: "#d4b874", props: ["🪸", "🐟", "🫧"], obstacles: ["🪸", "🐡"], goal: "🐚", dark: true },
  space: { label: "Space", words: ["space", "moon", "planet", "mars", "galaxy"], sky: ["#0d1030", "#2a2160"], hill: "#3a3570", ground: "#8a8aa0", path: "#77778c", props: ["⭐", "🪐", "✨"], obstacles: ["☄️", "🪨"], goal: "🪐", dark: true },
  city: { label: "City", words: ["city", "town", "street", "school", "store", "shop"], sky: ["#cfe6f7", "#f3eee2"], hill: "#b9c6d2", ground: "#9a9a9a", path: "#7d7d7d", props: ["🏢", "🏬", "🚦"], obstacles: ["🚧", "🛢️"], goal: "🏙️" },
  castle: { label: "Castle", words: ["castle", "kingdom", "palace"], sky: ["#d9c8f0", "#f6efe0"], hill: "#b8a8d8", ground: "#8fbf6f", path: "#c8a46b", props: ["🏰", "🚩", "🌲"], obstacles: ["🪨", "🛡️"], goal: "🏰" },
  sky: { label: "Sky", words: ["sky", "clouds", "rainbow", "flew", "fly"], sky: ["#8fd0ff", "#e9f7ff"], hill: "#d4ecff", ground: "#ffffff", path: "#e6f1fa", props: ["☁️", "🌈", "🎈"], obstacles: ["🌪️", "☁️"], goal: "🌈" },
  desert: { label: "Desert", words: ["desert", "dunes", "pyramid"], sky: ["#ffd9a0", "#fff1d6"], hill: "#e8b878", ground: "#e8c27a", path: "#d6ad62", props: ["🌵", "🐪", "🏜️"], obstacles: ["🌵", "🦂"], goal: "🏜️" },
  snow: { label: "Snow", words: ["snow", "ice", "winter", "igloo"], sky: ["#dbeefa", "#ffffff"], hill: "#cfe3f0", ground: "#f4f8fb", path: "#dde8f0", props: ["🌲", "⛄", "❄️"], obstacles: ["⛄", "🧊"], goal: "🏔️" },
  home: { label: "Home", words: ["home", "house", "bedroom", "kitchen", "treehouse", "tree house"], sky: ["#ffe9c7", "#fff7ea"], hill: "#f0d3a8", ground: "#c8a073", path: "#b48c60", props: ["🏠", "🌷", "🪴"], obstacles: ["🧸", "📦"], goal: "🏠" },
  park: { label: "Park", words: ["park", "garden", "playground", "farm"], sky: ["#c6ecff", "#f3fbe6"], hill: "#b2dd94", ground: "#8cc46a", path: "#d8b981", props: ["🌳", "🌻", "🛝"], obstacles: ["🪨", "🌻"], goal: "🛝" },
};
export const PLACE_KEYS = Object.keys(PLACES);

// Game kinds a page can turn into. Order = tie-break priority when detecting.
export const ACTIONS = {
  battle: { label: "Battle", icon: "⚔️", words: ["fight", "fought", "fighting", "battle", "attack", "attacked", "bomb", "bombs", "arrow", "arrows", "sword", "zap", "blast", "defeat", "defeated", "punch", "kick", "shoot", "died", "destroy", "roar", "roor"] },
  collect: { label: "Treasure hunt", icon: "💎", words: ["find", "found", "treasure", "gold", "coins", "collect", "collected", "candy", "gems", "berries", "cheese", "apples", "cookies", "picked"] },
  climb: { label: "Climb", icon: "🪜", words: ["climb", "climbed", "climbing", "ladder", "treehouse", "tree house", "stairs", "mountain", "tower"] },
  journey: { label: "Run & jump", icon: "🏃", words: ["adventure", "walk", "walked", "run", "ran", "went", "travel", "journey", "explore", "explored", "path", "road", "trip", "race", "hike", "let's go", "lets go", "go inside"] },
  friends: { label: "Meet friends", icon: "🤝", words: ["friend", "friends", "meet", "met", "pet", "play", "played", "look at my", "guys"] },
  celebrate: { label: "Fireworks party", icon: "🎆", words: ["hooray", "yay", "yah", "won", "party", "celebrate", "made it", "the end"] },
};
export const ACTION_KEYS = Object.keys(ACTIONS);

export const WEAPONS = [
  { emoji: "🏹", words: ["arrow", "arrows", "bow"] },
  { emoji: "💣", words: ["bomb", "bombs"] },
  { emoji: "🗡️", words: ["sword", "swords"] },
  { emoji: "💧", words: ["water", "hose", "splash"] },
  { emoji: "✨", words: ["magic", "wand", "spell"] },
  { emoji: "⚡", words: ["laser", "lightning", "zap"] },
  { emoji: "❄️", words: ["snowball", "snowballs"] },
];
export const ITEMS = [
  { emoji: "🧀", words: ["cheese"] }, { emoji: "🪙", words: ["gold", "coin", "coins"] },
  { emoji: "💎", words: ["gem", "gems", "diamond", "diamonds", "jewel", "jewels"] },
  { emoji: "🍬", words: ["candy", "sweets"] }, { emoji: "🍎", words: ["apple", "apples"] },
  { emoji: "🫐", words: ["berry", "berries"] }, { emoji: "🍪", words: ["cookie", "cookies"] },
  { emoji: "🥕", words: ["carrot", "carrots"] }, { emoji: "🍌", words: ["banana", "bananas"] },
  { emoji: "💰", words: ["treasure"] },
];

export const AVATARS = ["🦊", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🦄", "🐲", "🐙", "🦖", "🐬", "🐧", "🐰", "🐻", "🐱"];
export const COLORS = ["#f0a040", "#5f9e45", "#3d7fd6", "#d8453b", "#9a5fc0", "#e0679a"];
// Picture lock choices for a child profile.
export const LOCK_PICS = ["🍎", "🚗", "🐶", "⭐", "🌈", "🎈", "🍕", "🐠", "⚽"];

export function wordRegex(words) {
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
  return new RegExp(`(^|[^\\p{L}])(${esc.join("|")})(?=$|[^\\p{L}])`, "giu");
}
export function countWords(text, words) {
  return (text.match(wordRegex(words)) || []).length;
}
export function pickByWords(text, list, fallback) {
  let best = null, bestN = 0;
  for (const it of list) { const n = countWords(text, it.words); if (n > bestN) { best = it; bestN = n; } }
  return best ? best.emoji : fallback;
}
