// Spell check with a bundled English (US) dictionary (Hunspell format, read by Typo.js), plus
// the words added with "Add to dictionary" (kept in this browser).
import { getSetting, setSetting } from "./storage.js?v=de51fd1302";

const LIB = "https://cdn.jsdelivr.net/npm/typo-js@1.2.4/typo.js";
const DICT = "https://cdn.jsdelivr.net/npm/dictionary-en@3.2.0/index";
let typo = null, added = null;
const suggestions = new Map();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src, onload: resolve, onerror: () => reject(new Error("Couldn't load the spell checker.")) });
    document.head.append(s);
  });
}

async function ready() {
  typo ??= (async () => {
    const [, aff, dic] = await Promise.all([loadScript(LIB), fetch(`${DICT}.aff`).then(r => r.text()), fetch(`${DICT}.dic`).then(r => r.text())]);
    return new window.Typo("en_US", aff, dic);
  })();
  added ??= new Set((await getSetting("dictionary", [])).map(w => w.toLowerCase()));
  return typo;
}

const ok = (t, w) => t.check(w) || t.check(w.toLowerCase()) || /\d/.test(w) || added.has(w.toLowerCase());

// words -> {misspelled word: [up to 5 suggestions]}
export async function check(words) {
  const t = await ready();
  const bad = {};
  for (const w of words.slice(0, 2000)) {
    if (typeof w !== "string" || !w || w.length >= 60 || ok(t, w.replace(/’/g, "'"))) continue;
    if (!suggestions.has(w)) suggestions.set(w, w.length > 20 ? [] : t.suggest(w, 5));
    bad[w] = suggestions.get(w);
  }
  return bad;
}

export async function learn(word) {
  word = (word || "").trim();
  if (!word) return;
  await ready();
  const words = await getSetting("dictionary", []);
  if (!words.some(w => w.toLowerCase() === word.toLowerCase())) {
    words.push(word);
    await setSetting("dictionary", words.sort((a, b) => a.localeCompare(b)));
  }
  added.add(word.toLowerCase());
}
