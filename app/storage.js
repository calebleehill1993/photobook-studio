// Local storage for books: everything stays in this browser on this computer.
//
// IndexedDB (a database every browser has, one per website) holds
//   books    {id, name, created, modified, rev, saved_at, settings, photos, pages, unplaced, ...}
//   photos   {key: "<bookId>/<photoId>", book, blob}     original photo files
//   thumbs   {key: "<bookId>/<photoId>", book, blob}     editor-sized copies
//   assets   {key: "<bookId>/bg/<name>", book, blob}     backgrounds uploaded for one book
//   backups  {key: "<bookId>/<stamp>", book, time, data}  earlier versions (History)
//   settings {key, value}                                 e.g. words added to the dictionary
//
// A "book file" (.photobook) is a zip of book.json, photos/ and backgrounds/, for backups and for
// moving a book to another computer. Nothing is uploaded anywhere.

import * as zip from "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.52/+esm";

zip.configure({ useWebWorkers: false });

const DB_NAME = "photobook-studio";
const DB_VERSION = 2;
const BY_BOOK = ["photos", "thumbs", "assets", "backups"];
let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("books")) d.createObjectStore("books", { keyPath: "id" });
      for (const name of BY_BOOK) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: "key" }).createIndex("book", "book");
      }
      if (!d.objectStoreNames.contains("settings")) d.createObjectStore("settings", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Close other Photobook Studio tabs and reload."));
  });
  return dbPromise;
}

// Run `fn(stores)` in one transaction; resolves once it's written to disk.
async function tx(names, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(names, mode, { durability: "strict" });
    const stores = Object.fromEntries([].concat(names).map(n => [n, t.objectStore(n)]));
    let result;
    Promise.resolve(fn(stores)).then(r => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Saving was cancelled (the disk may be full)."));
  });
}
const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

// ---------- books ----------
export async function listBooks() {
  const all = await tx("books", "readonly", s => done(s.books.getAll()));
  return all.sort((a, b) => b.modified - a.modified);
}
export const getBook = id => tx("books", "readonly", s => done(s.books.get(id)));
export async function saveBook(book) {
  book.modified = Date.now();
  await tx("books", "readwrite", s => done(s.books.put(book)));
  return book;
}
export async function deleteBook(id) {
  await tx(["books", ...BY_BOOK], "readwrite", async s => {
    s.books.delete(id);
    for (const name of BY_BOOK) {
      const keys = await done(s[name].index("book").getAllKeys(id));
      keys.forEach(k => s[name].delete(k));
    }
  });
}

// ---------- photos ----------
export async function putPhoto(bookId, photoId, blob, thumb) {
  const key = `${bookId}/${photoId}`;
  await tx(["photos", "thumbs"], "readwrite", s => {
    s.photos.put({ key, book: bookId, blob });
    if (thumb) s.thumbs.put({ key, book: bookId, blob: thumb });
  });
}
export async function getPhoto(bookId, photoId, { thumb = false } = {}) {
  const store = thumb ? "thumbs" : "photos";
  const rec = await tx(store, "readonly", s => done(s[store].get(`${bookId}/${photoId}`)));
  return rec?.blob || null;
}
export async function allThumbs(bookId) {
  const recs = await tx("thumbs", "readonly", s => done(s.thumbs.index("book").getAll(bookId)));
  return new Map(recs.map(r => [r.key.slice(bookId.length + 1), r.blob]));
}
export async function deletePhoto(bookId, photoId) {
  const key = `${bookId}/${photoId}`;
  await tx(["photos", "thumbs"], "readwrite", s => { s.photos.delete(key); s.thumbs.delete(key); });
}

// ---------- backgrounds uploaded for one book ----------
export async function putAsset(bookId, name, blob) {
  await tx("assets", "readwrite", s => done(s.assets.put({ key: `${bookId}/bg/${name}`, book: bookId, blob })));
}
export async function bookAssets(bookId) {
  const recs = await tx("assets", "readonly", s => done(s.assets.index("book").getAll(bookId)));
  return new Map(recs.map(r => [r.key.slice(bookId.length + 4), r.blob]));
}

// ---------- History: earlier versions ----------
// A copy every couple of minutes while editing; keeps the latest 40 plus the first of each day for 90 days.
const KEEP_RECENT = 40;
export async function addBackup(book) {
  const d = new Date(), pad = n => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const data = JSON.stringify({ name: book.name, settings: book.settings, pages: book.pages, unplaced: book.unplaced, caption_memory: book.caption_memory });
  await tx("backups", "readwrite", async s => {
    s.backups.put({ key: `${book.id}/${stamp}`, book: book.id, time: d.getTime(), data });
    const keys = (await done(s.backups.index("book").getAllKeys(book.id))).sort();
    const keep = new Set(keys.slice(-KEEP_RECENT));
    const cutoff = Date.now() - 90 * 864e5, seenDays = new Set();
    for (const k of keys) { // keys sort by time, so the first one seen for a day is that day's first
      const day = k.split("/")[1].slice(0, 8);
      const when = new Date(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)).getTime();
      if (!seenDays.has(day) && when >= cutoff) keep.add(k);
      seenDays.add(day);
    }
    for (const k of keys) if (!keep.has(k)) s.backups.delete(k);
  });
}
export async function listBackups(bookId) {
  const recs = await tx("backups", "readonly", s => done(s.backups.index("book").getAll(bookId)));
  return recs.sort((a, b) => b.time - a.time).map(r => ({ name: r.key.split("/")[1], time: r.time, ...JSON.parse(r.data) }));
}
export async function lastBackupTime(bookId) {
  const keys = await tx("backups", "readonly", s => done(s.backups.index("book").getAllKeys(bookId)));
  if (!keys.length) return 0;
  const k = keys.sort().at(-1).split("/")[1];
  return new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), +k.slice(9, 11), +k.slice(11, 13), +k.slice(13, 15)).getTime();
}

// ---------- small settings ----------
export const getSetting = async (key, fallback = null) => (await tx("settings", "readonly", s => done(s.settings.get(key))))?.value ?? fallback;
export const setSetting = (key, value) => tx("settings", "readwrite", s => done(s.settings.put({ key, value })));

// ---------- how much room, and keeping it ----------
// Browsers may clear a website's data when the disk gets very full, unless the site asks to
// keep it ("persistent storage"). Chrome usually agrees once the site is installed or bookmarked.
export async function storageInfo() {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  return { used: est.usage || 0, quota: est.quota || 0, persisted };
}
export const askToKeep = async () => (navigator.storage?.persist ? navigator.storage.persist() : false);

// ---------- zips ----------
// Reads a zip without loading it all into memory (Google Photos zips can be several GB).
export async function zipEntries(file) {
  const reader = new zip.ZipReader(new zip.BlobReader(file));
  const entries = await reader.getEntries();
  return {
    entries: entries.filter(e => !e.directory).map(e => ({ name: e.filename, read: (type = "") => e.getData(new zip.BlobWriter(type)) })),
    close: () => reader.close(),
  };
}

// files: [{name, blob}] -> zip Blob (stored, not compressed: photos don't shrink further)
export async function makeZip(files, onProgress = () => {}) {
  const writer = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { level: 0 });
  for (const [n, f] of files.entries()) {
    await writer.add(f.name, f.text != null ? new zip.TextReader(f.text) : new zip.BlobReader(f.blob));
    onProgress(n + 1, files.length);
  }
  return writer.close();
}

// ---------- book files (.photobook) ----------
export async function bookToFile(bookId, onProgress = () => {}) {
  const book = await getBook(bookId);
  const files = [{ name: "book.json", text: JSON.stringify({ format: "photobook-studio", version: 1, book }) }];
  for (const pid of Object.keys(book.photos || {})) {
    const blob = await getPhoto(bookId, pid);
    if (blob) files.push({ name: `photos/${pid}`, blob });
  }
  for (const [name, blob] of await bookAssets(bookId)) files.push({ name: `backgrounds/${name}`, blob });
  return makeZip(files, onProgress);
}

// Opens a book file as a new book (a copy, if this browser already has it).
// makeThumb(blob) -> editor-sized JPEG blob.
export async function bookFromFile(file, makeThumb, onProgress = () => {}) {
  const { entries, close } = await zipEntries(file);
  try {
    const byName = new Map(entries.map(e => [e.name, e]));
    const meta = byName.get("book.json");
    if (!meta) throw new Error("This isn't a Photobook Studio book file.");
    const { format, book } = JSON.parse(await (await meta.read("application/json")).text());
    if (format !== "photobook-studio") throw new Error("This isn't a Photobook Studio book file.");
    if (await getBook(book.id)) { book.id = newId(); book.name += " (copy)"; }
    const ids = Object.keys(book.photos || {});
    for (const [n, pid] of ids.entries()) {
      const e = byName.get(`photos/${pid}`);
      if (e) {
        const blob = await e.read("image/jpeg");
        await putPhoto(book.id, pid, blob, await makeThumb(blob));
      }
      onProgress(n + 1, ids.length);
    }
    for (const e of entries.filter(e => e.name.startsWith("backgrounds/"))) {
      await putAsset(book.id, e.name.slice("backgrounds/".length), await e.read("image/jpeg"));
    }
    book.created ??= Date.now();
    await saveBook(book);
    return book;
  } finally {
    await close();
  }
}
