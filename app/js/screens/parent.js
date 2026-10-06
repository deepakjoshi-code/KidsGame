// Grown-ups area (passcode-gated every time): profiles, backups, sharing books, passcode, privacy.
import { h, show, button, topbar, toast, saveFile, pickFile, dialog, confirmBox } from "../ui.js";
import * as store from "../store.js";
import { passcodeProblem } from "../crypto.js";
import { exportBookPack, importBookPack } from "../comic.js";
import { nav, screen, field, busy, prefs, AUTOLOCK_CHOICES, autolockMinutes, eraseEverything, avatarBadge, todayStamp } from "./common.js";
import { profileEditor } from "./profiles.js";
import { restoreFlow } from "./setup.js";
import { aiSettings, saveAiSettings, aiReady, testConnection, validEndpoint, DEFAULT_ENDPOINT } from "../ai.js";

export function parent() {
  const kids = store.list("profile");
  const books = store.list("book");
  const back = () => nav.picker();

  // ----- children -----
  const kidRows = kids.map((p) => {
    const n = books.filter((b) => b.profileId === p.id).length;
    return h("div", { class: "kid-row" },
      avatarBadge(p),
      h("div", { class: "who" },
        h("strong", null, p.name),
        h("span", { class: "small muted" }, [p.age ? `Age ${p.age} · ` : "", `${n} ${n === 1 ? "book" : "books"}`, p.lock ? " · 🔐 picture lock" : ""].join(""))),
      button("Edit", () => profileEditor(p, { onDone: parent }), "small ghost"));
  });
  const children = h("section", { class: "card" },
    h("h2", null, "👧 Children"),
    kidRows.length ? kidRows : h("p", { class: "muted" }, "No children yet."),
    h("div", { class: "row picker-foot" }, button("+ Add child", () => profileEditor(null, { onDone: parent }), "go")));

  // ----- backup -----
  const exportBtn = button("💾 Save encrypted backup", () => busy(exportBtn, "Packing…", async () => {
    const text = await store.exportBackup();
    await saveFile(`wishcircle-backup-${todayStamp()}.json`, text);
    prefs.set("lastBackup", Date.now());
    toast("Backup saved.");
  }), "blue");
  const restoreBtn = button("📦 Restore a backup…", async () => {
    const ok = await confirmBox("Restore a backup?", "Everything on this device will be replaced by what's in the backup file. You'll then unlock with the passcode that backup was made with.", "Choose file", "");
    if (ok) restoreFlow(() => { /* store.importBackup locks; main shows the unlock screen */ });
  }, "ghost");
  const last = Number(prefs.get("lastBackup", 0));
  const backup = h("section", { class: "card" },
    h("h2", null, "💾 Backup"),
    h("p", null, "A backup is one file with everything in it, still encrypted with your passcode. Keep it somewhere safe (Files, iCloud Drive, a USB stick). It's useless without the passcode."),
    h("p", { class: "small muted" }, last ? `Last backup from this device: ${new Date(last).toLocaleDateString()}.` : "No backup saved from this device yet."),
    h("div", { class: "row" }, exportBtn, restoreBtn));

  // ----- share books -----
  const kidSel = (id) => h("select", { class: "input", id }, kids.map((p) => h("option", { value: p.id }, `${p.avatar} ${p.name}`)));
  const bookSel = h("select", { class: "input" }, books.length
    ? books.map((b) => { const p = kids.find((k) => k.id === b.profileId); return h("option", { value: b.id }, `${b.title}${p ? " (" + p.name + ")" : ""}`); })
    : h("option", { value: "" }, "No books yet"));
  const shareBtn = button("📤 Share as .wishbook", async () => {
    const book = store.get(bookSel.value);
    if (!book) return;
    const ok = await dialog({
      title: "Share this book?",
      body: h("div", null,
        h("p", null, h("strong", null, "This file is NOT encrypted."), " Anyone who gets it can read the story and see its drawings and photos."),
        h("p", null, "Only send it to people you trust, like family. Your other books and your children's profiles are not included.")),
      choices: [{ label: "Cancel", value: false, cls: "ghost" }, { label: "Make the file", value: true, cls: "" }],
    });
    if (!ok) return;
    await busy(shareBtn, "Packing…", async () => {
      try {
        const text = await exportBookPack(book);
        const slug = (book.title || "book").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "book";
        await saveFile(`${slug}.wishbook`, text, "application/json");
      } catch { toast("Couldn't make the file."); }
    });
  }, "blue");
  shareBtn.disabled = !books.length;
  const importKid = kidSel("import-kid");
  const importBtn = button("📥 Import a .wishbook", async () => {
    const pid = importKid.value;
    if (!pid) return;
    const [f] = await pickFile(".wishbook,application/json");
    if (!f) return;
    if (f.size > 60 * 1024 * 1024) { toast("That file is too big."); return; }
    await busy(importBtn, "Importing…", async () => {
      try {
        const book = await importBookPack(await f.text(), pid);
        toast(`"${book?.title || "Book"}" was added.`);
        parent();
      } catch (x) { toast(x?.message || "That file isn't a Wish Circle book."); }
    });
  }, "ghost");
  importBtn.disabled = !kids.length;
  const share = h("section", { class: "card stack" },
    h("h2", null, "📚 Share and import books"),
    field("Book to share", bookSel, "Makes a .wishbook file you can send to family."),
    h("div", { class: "row" }, shareBtn),
    kids.length ? field("Import into the shelf of", importKid) : null,
    h("div", { class: "row" }, importBtn));

  // ----- security -----
  const lockSel = h("select", { class: "input", onchange: (e) => { prefs.set("autolock", e.target.value); toast(`Auto-lock after ${e.target.value} minutes.`); } },
    AUTOLOCK_CHOICES.map((m) => h("option", { value: String(m), selected: m === autolockMinutes() }, `${m} minutes`)));
  const security = h("section", { class: "card stack" },
    h("h2", null, "🔒 Passcode and locking"),
    field("Lock automatically after no use for", lockSel, "It also locks when the app has been in the background for more than 3 minutes."),
    h("div", { class: "row" }, button("Change passcode…", changePasscode, "ghost"), button("🔒 Lock now", () => nav.lockNow(), "ghost")));

  // ----- storage -----
  const storageBox = h("p", null, h("span", { class: "busy" }, "Checking…"));
  const storage = h("section", { class: "card stack" },
    h("h2", null, "📱 Storage on this device"),
    storageBox,
    h("ul", null,
      h("li", null, "Add Wish Circle to your Home Screen (Share → Add to Home Screen) so the device keeps its data safe."),
      h("li", null, "Save a backup now and then. If the device is lost or reset, a backup is the only way to get the books back.")));
  store.storageInfo().then(({ persisted, usage }) => {
    const mb = (usage / (1024 * 1024)).toFixed(1);
    storageBox.replaceChildren(
      persisted
        ? h("span", { class: "status-pill good" }, "✓ Kept for keeps")
        : h("span", { class: "status-pill warn" }, "⚠ Not guaranteed"),
      " ",
      persisted ? "This browser has promised not to clear Wish Circle's data." : "The browser may clear this data if the device runs low on space or the app isn't used for a while.",
      h("br"), h("span", { class: "small muted" }, `Using about ${mb} MB.`));
  });

  // ----- privacy explainer -----
  const explainer = h("section", { class: "card explainer" },
    h("h2", null, "🛡️ How your data is protected"),
    h("ul", null,
      h("li", null, h("strong", null, "It stays on this device. "), "Wish Circle has no accounts, no ads and no tracking. It never sends your children's stories, drawings or photos anywhere, unless you turn on Claude AI above: then only the comic pages of a book being added are sent to be read."),
      h("li", null, h("strong", null, "It's locked with your passcode. "), "Everything is encrypted with AES-256, a strong standard. The key is made from your passcode, and it is only kept in memory while the app is unlocked."),
      h("li", null, h("strong", null, "Wrong guesses slow down. "), "After 5 wrong passcodes, the app makes you wait longer and longer before the next try."),
      h("li", null, h("strong", null, "Photos are cleaned. "), "Hidden details in photos, such as location, are removed before saving."),
      h("li", null, h("strong", null, "The picture lock is a friendly fence. "), "It keeps brothers and sisters out of each other's shelves. It isn't strong security: the parent passcode is the real lock."),
      h("li", null, h("strong", null, "Files you make. "), "Backups stay encrypted. A shared .wishbook is not encrypted, so only send it to people you trust."),
      h("li", null, h("strong", null, "Forgotten passcode. "), "Nobody can reset it, not even us. That's what keeps the books private, so keep the passcode somewhere safe.")));

  const danger = h("section", { class: "card berry stack" },
    h("h2", null, "⚠️ Erase everything"),
    h("p", null, "Deletes all profiles, books, drawings and photos from this device. Saved backup files aren't affected."),
    h("div", { class: "row" }, button("Erase everything…", () => eraseEverything(), "danger")));

  show(
    topbar({ title: "⚙️ Grown-ups", back, actions: [] }),
    screen("parent narrow",
      h("p", { class: "small muted" }, "Only grown-ups with the passcode can see this page. Leave it with ‹ Back."),
      children, aiSection(), backup, share, security, storage, explainer, danger));
}

// ----- Claude AI: reads a finished comic and plans its game (off until a grown-up turns it on) -----
function aiSection() {
  const s = aiSettings();
  const consent = h("input", { type: "checkbox", class: "ai-check", checked: !!s.consentAt });
  const code = h("input", { class: "input", type: "password", autocomplete: "off", spellcheck: "false", value: s.familyCode, placeholder: "The family code from setting up the comic reader" });
  const endpoint = h("input", { class: "input", type: "url", autocomplete: "off", spellcheck: "false", value: s.endpoint, inputmode: "url" });
  const result = h("p", { class: "ai-result small", role: "status", "aria-live": "polite" });
  const status = h("span", { class: "status-pill" });
  const onOff = h("button", { type: "button", class: "fb-toggle ai-switch", role: "switch" },
    h("span", { class: "fb-toggle-ico", "aria-hidden": "true" }, "✨"),
    h("span", { class: "fb-toggle-text" }, h("strong", null, "Use Claude AI for finished comics"), h("span", { class: "ai-switch-sub" })),
    h("span", { class: "fb-knob", "aria-hidden": "true" }));
  const paint = (cur) => {
    const on = aiReady(cur);
    onOff.setAttribute("aria-checked", String(on));
    onOff.querySelector(".ai-switch-sub").textContent = on ? "On: finished comics are read by Claude." : "Off: finished comics are made on this device only.";
    status.className = "status-pill " + (on ? "good" : "warn");
    status.textContent = on ? "✓ On" : "Off";
  };
  paint(s);
  const say = (msg, ok) => { result.textContent = msg; result.className = "ai-result small " + (ok ? "good" : ok === false ? "bad" : ""); };

  // Saving the fields: the code and the address are kept (encrypted) as soon as they change.
  const keepFields = async () => {
    const ep = validEndpoint(endpoint.value);
    if (!ep) { say("That address doesn't look right. It should be a secure (https) address.", false); return null; }
    return saveAiSettings({ familyCode: code.value, endpoint: ep });
  };
  code.addEventListener("change", () => { keepFields().then((c) => c && paint(c)).catch(() => {}); });
  endpoint.addEventListener("change", () => { keepFields().then((c) => c && paint(c)).catch(() => {}); });
  consent.addEventListener("change", async () => {
    const c = await saveAiSettings({ consentAt: consent.checked ? Date.now() : null }).catch(() => null);
    if (c) { paint(c); if (!consent.checked) say("Claude AI is off. Nothing will be sent.", null); }
  });
  onOff.addEventListener("click", async () => {
    const cur = aiSettings();
    if (aiReady(cur)) { paint(await saveAiSettings({ enabled: false })); say("Claude AI is off. Nothing will be sent.", null); return; }
    if (!consent.checked) { say("Please tick the box to agree first.", false); consent.focus(); return; }
    if (!code.value.trim()) { say("Please type the family code first.", false); code.focus(); return; }
    const kept = await keepFields();
    if (!kept) return;
    paint(await saveAiSettings({ enabled: true, consentAt: cur.consentAt || Date.now() }));
    say("Claude AI is on. Try “Test connection” to check it works.", true);
  });
  const testBtn = button("🔌 Test connection", () => busy(testBtn, "Checking…", async () => {
    const ep = validEndpoint(endpoint.value);
    if (!ep) { say("That address doesn't look right. It should be a secure (https) address.", false); return; }
    const r = await testConnection({ ...aiSettings(), endpoint: ep, familyCode: code.value.trim() });
    say((r.ok ? "✓ " : "✗ ") + r.message, r.ok);
  }), "blue");
  const showCode = h("input", { type: "checkbox", class: "ai-check", onchange: (e) => { code.type = e.target.checked ? "text" : "password"; } });

  return h("section", { class: "card stack ai-card" },
    h("div", { class: "row ai-head" }, h("h2", null, "✨ Build games with Claude AI"), status),
    h("p", null, "When this is on and a child adds a finished comic (a PDF or photos of the pages), the comic's pages are sent to Anthropic's Claude AI. Claude reads the words in the speech bubbles, finds the characters and plans the game, so the game uses the comic's own words, drawings and adventure."),
    h("ul", { class: "ai-facts" },
      h("li", null, h("strong", null, "What is sent: "), "only the pictures of that comic's pages, made smaller. No names, profiles, passcodes or other books."),
      h("li", null, h("strong", null, "Where: "), "to your family's comic reader (", DEFAULT_ENDPOINT.replace(/^https:\/\//, ""), "), which passes them to Anthropic and sends back the answer. It stores nothing and keeps no copy of the pages or words."),
      h("li", null, h("strong", null, "Anthropic: "), "handles the pages under its API terms (by default, API data isn't used to train its models). The finished game is saved encrypted on this device, like every other book."),
      h("li", null, h("strong", null, "When it's off: "), "nothing is sent, and finished books are made on this device with a simpler game.")),
    h("label", { class: "ai-consent" }, consent, h("span", null, "I agree to send my child's comic pages to Anthropic's Claude to make their games.")),
    field("Family code", code, "The secret code you chose when setting up the comic reader. Only this family's code can use it."),
    h("label", { class: "ai-consent small" }, showCode, h("span", null, "Show the code")),
    h("details", { class: "ai-advanced" },
      h("summary", null, "Advanced"),
      field("Comic reader address", endpoint, `Normally ${DEFAULT_ENDPOINT}. The app's security settings only allow that address.`)),
    onOff,
    h("div", { class: "row" }, testBtn),
    result);
}

function changePasscode() {
  const cur = h("input", { class: "input", type: "password", autocomplete: "current-password" });
  const p1 = h("input", { class: "input", type: "password", autocomplete: "new-password" });
  const p2 = h("input", { class: "input", type: "password", autocomplete: "new-password" });
  const strength = h("p", { class: "strength", "aria-live": "polite" });
  const err = h("p", { class: "error", role: "alert" });
  p1.addEventListener("input", () => {
    const prob = p1.value ? passcodeProblem(p1.value) : "";
    strength.textContent = p1.value ? prob || "👍 Good passcode." : "";
    strength.className = "strength " + (prob ? "bad" : "good");
  });
  const go = h("button", { type: "submit", class: "btn go big" }, "Change passcode");
  const submit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    if (p1.value !== p2.value) { err.textContent = "The new passcodes don't match."; return; }
    await busy(go, "Changing…", async () => {
      const problem = await store.changePasscode(cur.value, p1.value);
      if (problem) { err.textContent = problem; return; }
      toast("Passcode changed. Old backups still open with the old passcode.");
      parent();
    });
  };
  show(
    topbar({ title: "Change passcode", back: parent }),
    screen("narrow",
      h("form", { class: "card stack", onsubmit: submit, novalidate: true },
        field("Current passcode", cur),
        field("New passcode", p1), strength,
        field("New passcode again", p2),
        h("p", { class: "small muted" }, "Backups you already saved keep the passcode they were made with."),
        err, go)));
  setTimeout(() => cur.focus(), 50);
}
