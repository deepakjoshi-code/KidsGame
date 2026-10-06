// Sound effects (synthesised, no files) and read-aloud with the device's own voices.

// Sound and read-aloud switches. They are non-identifying UI preferences, so (as the contract
// allows) they persist in localStorage under "wc.sound" / "wc.read".
const PREF_KEYS = { sound: "wc.sound", read: "wc.read" };
function loadPref(k) {
  try { const v = localStorage.getItem(PREF_KEYS[k]); if (v === "0") return false; } catch { /* storage blocked */ }
  return true;
}
export const settings = { sound: loadPref("sound"), read: loadPref("read") };
export function setSetting(k, on) {
  if (!(k in PREF_KEYS)) return;
  settings[k] = !!on;
  try { localStorage.setItem(PREF_KEYS[k], on ? "1" : "0"); } catch { /* storage blocked */ }
  if (k === "read" && !on) stopSpeech();
}
let ac = null;
export function audio() {
  if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { ac = null; } }
  if (ac && ac.state === "suspended") ac.resume();
  return ac;
}
// iPhone only allows sound after a tap.
function unlockAudio() {
  const a = audio();
  if (a) { const b = a.createBuffer(1, 1, 22050), s = a.createBufferSource(); s.buffer = b; s.connect(a.destination); s.start(0); }
  ["touchend", "click", "keydown"].forEach((ev) => document.removeEventListener(ev, unlockAudio, true));
}
["touchend", "click", "keydown"].forEach((ev) => document.addEventListener(ev, unlockAudio, true));

function tone(f, dur, type = "sine", vol = 0.15, f2 = null, delay = 0) {
  if (!settings.sound) return;
  const a = audio(); if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol = 0.3, freq = 1000, delay = 0) {
  if (!settings.sound) return;
  const a = audio(); if (!a) return;
  const t = a.currentTime + delay;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = a.createBufferSource(); s.buffer = buf;
  const f = a.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = freq;
  const g = a.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f).connect(g).connect(a.destination); s.start(t);
}
export const sfx = {
  jump() { tone(380, 0.18, "square", 0.08, 760); },
  coin() { tone(880, 0.08, "square", 0.07); tone(1320, 0.14, "square", 0.07, null, 0.08); },
  bonk() { tone(220, 0.25, "triangle", 0.3, 90); },
  shoot() { noise(0.15, 0.25, 4000); tone(1200, 0.12, "sine", 0.05, 600); },
  hit() { tone(320, 0.14, "square", 0.12, 140); },
  roar() { tone(120, 0.9, "sawtooth", 0.2, 55); noise(0.9, 0.35, 500); },
  boom() { noise(1.4, 0.9, 700); tone(90, 1.0, "sine", 0.6, 30); },
  zoom() { noise(0.8, 0.4, 1500); tone(300, 0.8, "sawtooth", 0.06, 900); },
  chirp() { [0, 0.15, 0.3, 0.5].forEach((d, i) => tone(2000 + i * 300, 0.1, "sine", 0.1, 2800 + i * 200, d)); },
  hehe() { [0, 0.18, 0.36].forEach((d) => tone(620, 0.12, "triangle", 0.15, 500, d)); },
  squeak() { tone(1500, 0.12, "sine", 0.12, 2200); tone(1700, 0.12, "sine", 0.1, 2400, 0.13); },
  pop() { tone(500 + Math.random() * 600, 0.15, "triangle", 0.15, 1400); noise(0.3, 0.2, 2500, 0.05); },
  fanfare() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i === 3 ? 0.5 : 0.16, "square", 0.08, null, i * 0.14)); },
  note(i) { const sc = [262, 294, 330, 349, 392, 440, 494, 523, 587, 659, 698, 784]; tone(sc[i % sc.length], 0.2, "triangle", 0.18); },
  click() { tone(660, 0.05, "square", 0.05); },
  bigboom() { noise(2.2, 1, 900); tone(70, 1.6, "sine", 0.7, 25); noise(1.2, 0.5, 300, 0.3); },
  siren() { for (let i = 0; i < 3; i++) { tone(950, 0.3, "triangle", 0.12, null, i * 0.6); tone(700, 0.3, "triangle", 0.12, null, i * 0.6 + 0.3); } },
  whistle() { tone(500, 0.7, "sine", 0.08, 1800); noise(0.6, 0.08, 3000); },
  crackle() { noise(0.9, 0.5, 1800); for (let i = 0; i < 6; i++) noise(0.05, 0.25, 6000, 0.25 + i * 0.09); },
  boing() { tone(180, 0.35, "sine", 0.25, 520); },
  cheer() { [523, 659, 784].forEach((f, i) => tone(f, 0.22, "triangle", 0.12, f * 1.5, i * 0.09)); },
};

const VOICES = { hero: { pitch: 1.5, rate: 0.95 }, friend: { pitch: 1.2, rate: 0.95 }, villain: { pitch: 0.3, rate: 0.75 }, narrator: { pitch: 1, rate: 0.9 } };
let voice = null;
function pickVoice() {
  if (!("speechSynthesis" in window)) return;
  const vs = speechSynthesis.getVoices();
  voice = vs.find((v) => /Samantha/.test(v.name)) || vs.find((v) => v.lang === "en-US" && v.localService) || vs.find((v) => /^en/.test(v.lang)) || null;
}
if (typeof window !== "undefined" && "speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

export function stopSpeech() { if ("speechSynthesis" in window) speechSynthesis.cancel(); }
let token = 0;
// lines: [{ role, text }]. onLine(i) fires as each line starts.
export function speak(lines, onLine) {
  stopSpeech();
  const my = ++token;
  lines.forEach((l, i) => {
    const start = () => { if (my === token) onLine?.(i); };
    if (!settings.read || !("speechSynthesis" in window)) { setTimeout(start, i * 1400); return; }
    const u = new SpeechSynthesisUtterance(l.text.replace(/([!?])\1+/g, "$1"));
    const v = VOICES[l.role] || VOICES.narrator;
    u.pitch = v.pitch; u.rate = v.rate; if (voice) u.voice = voice;
    u.onstart = start;
    speechSynthesis.speak(u);
  });
}
// Speak one line and call done() when it has been read: when the voice finishes, or after a
// reading-time guess when read-aloud is off or no voice is available. Returns a cancel function.
export function talk(line, done) {
  stopSpeech();
  const my = ++token;
  const text = String(line?.text || "");
  const guess = 900 + text.length * 60;
  const t0 = Date.now();
  let over = false, timer = 0;
  const fin = () => { if (over) return; over = true; clearTimeout(timer); if (my === token) done?.(); };
  const voiceOn = settings.read && typeof window !== "undefined" && "speechSynthesis" in window;
  timer = setTimeout(fin, voiceOn ? guess * 2.5 + 2500 : guess);
  if (voiceOn) {
    try {
      const u = new SpeechSynthesisUtterance(text.replace(/([!?])\1+/g, "$1"));
      const v = VOICES[line.role] || VOICES.narrator;
      u.pitch = v.pitch; u.rate = v.rate; if (voice) u.voice = voice;
      // Leave the words up for a moment even if a voice ends (or fails) suspiciously fast.
      const after = (share) => () => { if (over) return; clearTimeout(timer); timer = setTimeout(fin, Math.max(0, guess * share - (Date.now() - t0))); };
      u.onend = after(0.5);
      // No voice (or interrupted): fall back to reading time so the story keeps going.
      u.onerror = after(1);
      speechSynthesis.speak(u);
    } catch { /* keep the reading-time timer */ }
  }
  return () => { over = true; clearTimeout(timer); };
}
export const say = (text) => speak([{ role: "narrator", text }]);
document.addEventListener("visibilitychange", () => { if (document.hidden) stopSpeech(); });
