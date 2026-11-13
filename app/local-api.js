// The editor was written against the Mac build's web server. This module answers the same
// requests (same URLs, same JSON) from the browser's own storage, so the editor code barely
// changed. Long jobs (analyzing photos, starter text) run here and report progress through
// GET /api/projects/<id>/job, as before.

import * as store from "./storage.js?v=de51fd1302";
import { analyzePhoto, collectImages, makeThumb } from "./analyze.js?v=de51fd1302";
import { layoutPage, captionFor, titleFor, monthBackground } from "./layout.js?v=de51fd1302";
import * as speller from "./spell.js?v=de51fd1302";

const STYLES = { // text defaults; sizes in points
  title: { font: "Playfair Display", size: 22, weight: 600, color: "#3a3631", align: "center", valign: "middle" },
  caption: { font: "Patrick Hand", size: 9, weight: 400, color: "#3a3631", align: "center", valign: "top" },
  text: { font: "Caveat", size: 18, weight: 500, color: "#3a3631", align: "center", valign: "middle" },
};
const DEFAULTS = { page: 8.0, margin: 0.3, title: 0.7, gap: 0.06, caption: 0.28, caption_gap: 0.02,
  border: 0.02, border_color: "#ffffff", per_page: 20, styles: STYLES };
const BACKUP_EVERY = 90_000; // ms between History copies while editing
const copy = o => JSON.parse(JSON.stringify(o));

const jobs = new Map(); // book id -> {kind, done, total, error, result, finished}

// ---------- images the editor shows ----------
// The editor needs plain URLs for thumbnails and backgrounds; these are object URLs for what's
// in storage, made when a book opens.
const thumbURLs = new Map(), assetURLs = new Map();
export const thumbUrl = pid => thumbURLs.get(pid) || "";
export const bgUrl = (name, thumb = false) => assetURLs.get(name)
  || `assets/backgrounds/${thumb ? "thumbs/" : ""}${encodeURIComponent(name)}`;

async function loadBookImages(id) {
  for (const u of [...thumbURLs.values(), ...assetURLs.values()]) URL.revokeObjectURL(u);
  thumbURLs.clear(); assetURLs.clear();
  for (const [pid, blob] of await store.allThumbs(id)) thumbURLs.set(pid, URL.createObjectURL(blob));
  for (const [name, blob] of await store.bookAssets(id)) assetURLs.set(name, URL.createObjectURL(blob));
}

let sharedBackgrounds = null;
const sharedBackgroundNames = async () => (sharedBackgrounds ??= await fetch("assets/backgrounds/index.json").then(r => r.json()));

// ---------- helpers ----------
async function load(id) {
  const book = await store.getBook(id);
  if (!book) throw httpError(404, "That book isn't in this browser.");
  return book;
}
const httpError = (status, message) => Object.assign(new Error(message), { status });

async function pageBackground(photos, background) {
  if (background === "auto") return monthBackground(photos, await sharedBackgroundNames()) || "paper-cream.jpg";
  return background;
}

async function autoPages(book, orderedIds, background = null, captions = {}) {
  const s = book.settings, n = s.per_page, pages = [];
  let rowH = null;
  for (let i = 0; i < orderedIds.length; i += n) {
    const chunk = orderedIds.slice(i, i + n).map(pid => book.photos[pid]);
    const [items, h] = layoutPage(chunk, s, { rowH, short: chunk.length < n });
    rowH ??= h;
    const used = [];
    for (const item of items) {
      if (captions[item.photo]) Object.assign(item, captions[item.photo]);
      else { item.caption = captionFor(book.photos[item.photo], used); item.caption_auto = true; }
      used.push(item.caption || "");
    }
    pages.push({ items, background: await pageBackground(chunk, background), color: "#ffffff",
      title: { text: titleFor(chunk), auto: true }, texts: [] });
  }
  return pages.length ? pages : [{ items: [], background: await pageBackground([], background), color: "#ffffff", title: { text: "", auto: true }, texts: [] }];
}

const byTaken = book => (a, b) => {
  const pa = book.photos[a], pb = book.photos[b];
  return (pa.taken || "").localeCompare(pb.taken || "") || (pa.name || "").localeCompare(pb.name || "");
};

// Changes to one book happen one at a time (an import adding photos and the editor saving
// must not overwrite each other): load, change, save, inside withBook.
const locks = new Map();
function withBook(id, fn) {
  const run = (locks.get(id) || Promise.resolve()).then(async () => fn(await load(id)));
  locks.set(id, run.catch(() => {}));
  return run;
}

async function save(book, { backup = true } = {}) {
  book.rev = (book.rev || 0) + 1;
  book.saved_at = new Date().toISOString();
  await store.saveBook(book);
  if (backup && Date.now() - await store.lastBackupTime(book.id) > BACKUP_EVERY) await store.addBackup(book);
}

// Analyze photos, then lay them out (new book) or put them in the tray (added to a book).
// Each photo is recorded in the book as soon as it's analyzed (in book.importing until the end),
// so if the page is closed partway, reopening the book finishes with the photos that made it.
async function analyzeJob(id, images, thenLayout) {
  const job = { kind: "analyze", done: 0, total: images.length, error: null };
  jobs.set(id, job);
  try {
    await withBook(id, book => { book.importing = { layout: thenLayout, photos: [] }; return save(book, { backup: false }); });
    for (const img of images) {
      try {
        const { id: pid, blob, thumb, info } = await analyzePhoto(img);
        await store.putPhoto(id, pid, blob, thumb);
        thumbURLs.set(pid, URL.createObjectURL(thumb));
        await withBook(id, book => { book.photos[pid] = info; book.importing.photos.push(pid); return store.saveBook(book); });
      } catch (e) {
        console.warn(`Skipped ${img.name}:`, e);
        (job.skipped ??= []).push(img.name);
      }
      job.done += 1;
    }
    const placed = await finishImport(id);
    if (!placed) throw new Error("None of those files could be opened as photos.");
  } catch (e) {
    job.error = e.message;
  } finally {
    job.finished = true;
  }
}

// Lay out (new book) or tray (added photos) whatever an import recorded. Returns how many.
function finishImport(id) {
  return withBook(id, async book => {
    if (!book.importing) return 0;
    const ids = book.importing.photos.filter(pid => book.photos[pid]).sort(byTaken(book));
    if (book.importing.layout && !book.pages.some(pg => pg.items.length)) book.pages = await autoPages(book, ids, book.default_background);
    else book.unplaced.push(...ids.filter(pid => !book.unplaced.includes(pid)));
    delete book.importing;
    await save(book, { backup: false });
    await store.addBackup(book); // the first layout, or the book before these photos arrived
    return ids.length;
  });
}

async function suggestJob(id, pages) {
  const job = { kind: "suggest", done: 0, total: 1, error: null };
  jobs.set(id, job);
  try {
    const book = await load(id);
    const captions = {}, titles = [], backgrounds = [];
    for (const pg of pages) {
      const used = [];
      for (const item of pg.items) {
        const text = captionFor(book.photos[item.photo], used);
        captions[item.photo] = text;
        used.push(text);
      }
      const photos = pg.items.map(i => book.photos[i.photo]);
      titles.push(titleFor(photos));
      backgrounds.push(await pageBackground(photos, "auto"));
    }
    job.result = { captions, titles, backgrounds };
    job.done = 1;
  } catch (e) {
    job.error = e.message;
  } finally {
    job.finished = true;
  }
}

// ---------- routes ----------
const routes = [
  ["GET", /^\/api\/projects$/, async () => {
    const books = await store.listBooks();
    return books.map(b => ({ slug: b.id, name: b.name, pages: b.pages.length, photos: Object.keys(b.photos).length,
      cover: b.pages.flatMap(p => p.items)[0]?.photo || null, modified: b.modified / 1000 }));
  }],

  ["POST", /^\/api\/projects$/, async (_, fd) => {
    const name = (fd.get("name") || "").trim() || "Untitled book";
    const images = await collectImages(fd.getAll("files"));
    if (!images.length) throw httpError(400, "No photos found in what you chose.");
    const settings = copy(DEFAULTS);
    settings.per_page = parseInt(fd.get("per_page"), 10) || DEFAULTS.per_page;
    const book = { id: store.newId(), name, created: Date.now(), settings, photos: {}, pages: [], unplaced: [],
      caption_memory: {}, default_background: fd.get("background") || null };
    await save(book, { backup: false });
    thumbURLs.clear();
    analyzeJob(book.id, images, true); // runs in the background; the page polls /job
    return { slug: book.id };
  }],

  ["GET", /^\/api\/projects\/(\w+)$/, async ([id]) => {
    const running = jobs.get(id) && !jobs.get(id).finished;
    if (!running && (await load(id)).importing) await finishImport(id); // an import cut short (page closed)
    const book = await load(id);
    book.settings.styles ??= {};
    for (const [role, style] of Object.entries(STYLES)) book.settings.styles[role] = { ...style, ...(book.settings.styles[role] || {}) };
    await loadBookImages(id);
    return book;
  }],

  ["PUT", /^\/api\/projects\/(\w+)$/, async ([id], incoming) => withBook(id, async book => {
    for (const key of ["name", "settings", "pages", "unplaced", "caption_memory"]) if (key in incoming) book[key] = incoming[key];
    // Any photo the editor didn't place or list goes to the tray (not ones an import is still adding).
    const seen = new Set([...book.pages.flatMap(pg => pg.items.map(i => i.photo)), ...book.unplaced, ...(book.importing?.photos || [])]);
    book.unplaced.push(...Object.keys(book.photos).filter(pid => !seen.has(pid)));
    await save(book);
    return { ok: true, rev: book.rev, saved_at: book.saved_at };
  })],

  ["DELETE", /^\/api\/projects\/(\w+)$/, async ([id]) => { await store.deleteBook(id); return { ok: true }; }],

  ["GET", /^\/api\/projects\/(\w+)\/backups$/, async ([id]) => (await store.listBackups(id)).map(b => ({
    name: b.name, time: b.time, pages: b.pages.length, photos: b.pages.reduce((t, pg) => t + pg.items.length, 0),
    captions: b.pages.reduce((t, pg) => t + pg.items.filter(i => i.caption).length, 0),
  }))],

  ["POST", /^\/api\/projects\/(\w+)\/backups\/([\w-]+)\/restore$/, async ([id, name]) => withBook(id, async book => {
    const old = (await store.listBackups(id)).find(b => b.name === name);
    if (!old) throw httpError(404, "That version is gone.");
    await store.addBackup(book); // so the restore itself can be undone
    for (const key of ["name", "settings", "pages", "unplaced", "caption_memory"]) if (key in old) book[key] = old[key];
    book.unplaced = book.unplaced.filter(pid => book.photos[pid]);
    for (const pg of book.pages) pg.items = pg.items.filter(i => book.photos[i.photo]); // photos deleted since
    await save(book, { backup: false });
    return { ok: true };
  })],

  ["POST", /^\/api\/projects\/(\w+)\/suggest-text$/, async ([id], body) => { suggestJob(id, body.pages); return { ok: true }; }],

  ["GET", /^\/api\/projects\/(\w+)\/job$/, async ([id]) => jobs.get(id) || {}],

  ["POST", /^\/api\/projects\/(\w+)\/photos$/, async ([id], fd) => {
    await load(id);
    const images = await collectImages(fd.getAll("files"));
    if (!images.length) throw httpError(400, "No photos found in what you chose.");
    analyzeJob(id, images, false);
    return { ok: true, count: images.length };
  }],

  ["DELETE", /^\/api\/projects\/(\w+)\/photos\/(\w+)$/, async ([id, pid]) => withBook(id, async book => {
    delete book.photos[pid];
    book.unplaced = book.unplaced.filter(i => i !== pid);
    for (const pg of book.pages) pg.items = pg.items.filter(i => i.photo !== pid);
    await save(book);
    await store.deletePhoto(id, pid);
    return { ok: true };
  })],

  ["POST", /^\/api\/projects\/(\w+)\/autolayout$/, async ([id], body) => {
    const book = await load(id);
    book.settings = body.settings || book.settings;
    const s = book.settings;
    if (body.all) {
      const ids = [...body.pages.flatMap(pg => pg.items.map(i => i.photo)), ...(body.unplaced || [])].sort(byTaken(book));
      const captions = {};
      for (const pg of body.pages) for (const i of pg.items) {
        if (i.caption == null) continue;
        captions[i.photo] = Object.fromEntries(["caption", "caption_auto", "caption_style", "caption_frame", "caption_off"].filter(k => k in i).map(k => [k, i[k]]));
      }
      const background = body.background || body.pages[0]?.background || null;
      const pages = await autoPages(book, ids, background, captions);
      pages.forEach((pg, i) => { // keep hand-written titles and extra text where pages still exist
        const old = body.pages[i];
        if (!old) return;
        if (old.title && !old.title.auto) pg.title = old.title;
        pg.texts = old.texts || [];
        for (const key of ["border_color", "caption_style", "caption_frame"]) if (old[key]) pg[key] = old[key];
        if (background !== "auto") { pg.background = old.background; pg.color = old.color; }
      });
      return { pages, unplaced: [] };
    }
    const page = body.pages[body.page];
    const chunk = page.items.map(i => book.photos[i.photo]);
    const [items] = layoutPage(chunk, s, { short: chunk.length < s.per_page });
    return { items };
  }],

  ["GET", /^\/api\/backgrounds$/, sharedBackgroundNames],

  ["GET", /^\/api\/projects\/(\w+)\/backgrounds$/, async ([id]) => ({
    book: [...(await store.bookAssets(id)).keys()].sort(), shared: await sharedBackgroundNames(),
  })],

  ["POST", /^\/api\/projects\/(\w+)\/backgrounds$/, async ([id], fd) => {
    const f = fd.get("file");
    const name = (f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "background") + ".jpg";
    const blob = await makeThumb(f, 3000); // upright JPEG, at most 3000 px
    await store.putAsset(id, name, blob);
    assetURLs.set(name, URL.createObjectURL(blob));
    return { name };
  }],

  ["POST", /^\/api\/spell$/, async (_, body) => ({ misspelled: await speller.check(body.words || []) })],
  ["POST", /^\/api\/dictionary$/, async (_, body) => { await speller.learn(body.word); return { ok: true }; }],
];

// Same shape as fetch-based api() in the Mac build: resolves with the JSON, throws on errors.
export async function api(method, url, body) {
  const path = url.split("?")[0];
  for (const [m, re, handler] of routes) {
    if (m !== method) continue;
    const match = path.match(re);
    if (match) return handler(match.slice(1), body);
  }
  throw httpError(404, `Not found: ${method} ${path}`);
}

// Whether a job is still running for any book (to warn before leaving the page).
export const busy = () => [...jobs.values()].some(j => !j.finished);
