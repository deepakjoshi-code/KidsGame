// MOCK=1: a stand-in for Claude, for trying the app and the Worker without an API key.
// It answers with MOCK_RESPONSE (a JSON reading you supply, e.g. from a .dev.vars file that stays
// out of git) when that is set, or else a made-up reading that fits any number of panels.
// The answer goes through the same checks as a real one.

/** A plausible reading for any panels: a bunny's adventure with a run, a battle, friends, home. */
export function demoReading(input) {
  const n = input.length;
  const P = input.map((p) => p.index);
  const box = (p) => [Math.round(p.width * 0.3), Math.round(p.height * 0.35), Math.round(p.width * 0.7), Math.round(p.height * 0.95)];
  const at = (f) => P[Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))))];
  const story = n > 1 ? P.slice(1) : P;
  const placeOf = (k) => (k < 0.3 ? "forest" : k < 0.75 ? "cave" : "home");
  const panels = input.map((p, k) => {
    const f = n > 1 ? k / (n - 1) : 0;
    const cover = k === 0 && n > 1;
    return {
      panel: p.index, part: cover ? "cover" : "story", place: placeOf(f),
      chapter: cover ? "" : f < 0.3 ? "In the forest" : f < 0.55 ? "The cave" : f < 0.75 ? "The Mighty Dragon" : "Home!",
      characters: cover ? ["pip"] : f > 0.3 && f < 0.75 ? ["pip", "owl", "dragon"] : ["pip", "owl"],
      lines: cover ? [{ speaker: null, text: "PIP", kind: "caption" }] : [{ speaker: k % 2 ? "pip" : "owl", text: k === 1 ? "Let's go on an adventure!" : f > 0.4 && f < 0.6 ? "Let's fight it with snowballs!" : "Wow!", kind: "speech" }],
      narration: "",
    };
  });
  return {
    title: "Pip's Big Day",
    cast: [
      { id: "pip", name: "Pip", role: "hero", big: false, kind: "bunny", emoji: "🐇", appearances: story.slice(0, 3).map((i) => ({ panel: i, box: box(input.find((p) => p.index === i)), faces: "right" })) },
      { id: "owl", name: "Owl", role: "friend", big: false, kind: "owl", emoji: "🦉", appearances: story.slice(1, 3).map((i) => ({ panel: i, box: box(input.find((p) => p.index === i)), faces: "left" })) },
      { id: "dragon", name: "Dragon", role: "villain", big: true, kind: "dragon", emoji: "🐉", appearances: [] },
    ],
    panels,
    levels: [
      { after_panel: story[0], kind: "journey", name: "Forest Run", from: "forest", to: "cave", villain: null, weapon: null, super_weapon: null, friends: [], item: null, home: null },
      { after_panel: at(0.55), kind: "battle", name: "The Mighty Dragon", from: null, to: null, villain: "dragon", weapon: "❄️", super_weapon: null, friends: [], item: null, home: null },
      { after_panel: at(0.74), kind: "climb", name: "Climb Home", from: "cave", to: "home", villain: null, weapon: null, super_weapon: null, friends: [], item: null, home: "treehouse" },
    ],
  };
}

/** A fake Anthropic client whose beta.messages.stream() streams `reading` as JSON text. */
export function mockClient(env, input = []) {
  return {
    beta: {
      messages: {
        stream(params, { signal } = {}) {
          // MOCK_RESPONSE is passed through as Claude's text, so a broken one fails like a broken answer.
          const text = typeof env.MOCK_RESPONSE === "string" && env.MOCK_RESPONSE.trim() ? env.MOCK_RESPONSE : JSON.stringify(demoReading(input));
          const handlers = { text: [], thinking: [] };
          const delay = Math.max(0, Number(env.MOCK_DELAY_MS ?? 600));
          const done = (async () => {
            const pieces = 8;
            let sent = "";
            for (let i = 1; i <= pieces; i++) {
              if (signal?.aborted) throw new Error("aborted");
              await new Promise((r) => setTimeout(r, delay / pieces));
              const next = text.slice(0, Math.ceil((text.length * i) / pieces));
              const delta = next.slice(sent.length);
              sent = next;
              for (const fn of handlers.text) fn(delta, sent);
            }
            return {
              id: "msg_mock", type: "message", role: "assistant", model: "mock", stop_reason: "end_turn", stop_details: null,
              content: [{ type: "text", text }], usage: { input_tokens: 0, output_tokens: 0 },
            };
          })();
          return {
            on(evt, fn) { (handlers[evt] ||= []).push(fn); return this; },
            finalMessage: () => done,
            abort() {},
          };
        },
      },
    },
  };
}
