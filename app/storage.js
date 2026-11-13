// Local storage for books: everything stays in this browser on this computer.
//
// IndexedDB (a database every browser has, one per website) holds
//   books   {id, name, created, modified, ...the book's layout, text and settings}
//   photos  {key: "<bookId>/<photoId>", book, blob}   the original photo files
//   thumbs  {key: "<bookId>/<photoId>", book, blob}   small copies for the editor
//
// A "book file" (.photobook) is a zip of book.json plus photos/, for backups and for moving
// a book to another computer. Nothing is uploaded anywhere.

const DB_NAME = "photobook-studio";
const DB_VERSION = 1;
let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("books", { keyPath: "id" });
      for (const name of ["photos", "thumbs"]) d.createObjectStore(name, { keyPath: "key" }).createIndex("book", "book");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Run `fn(stores)` in one transaction; resolves when it has been written to disk.
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
  await tx(["books", "photos", "thumbs"], "readwrite", async s => {
    s.books.delete(id);
    for (const name of ["photos", "thumbs"]) {
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
  const rec = await tx(thumb ? "thumbs" : "photos", "readonly", s => done(s[thumb ? "thumbs" : "photos"].get(`${bookId}/${photoId}`)));
  return rec?.blob || null;
}

// ---------- how much room, and keeping it ----------
// Browsers may clear a website's data when the disk gets very full, unless the site asks to
// keep it ("persistent storage"). Chrome usually says yes once the site is installed or bookmarked.
export async function storageInfo() {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  return { used: est.usage || 0, quota: est.quota || 0, persisted };
}
export const askToKeep = async () => (navigator.storage?.persist ? navigator.storage.persist() : false);

// ---------- book files (.photobook = zip) ----------
// JSZip is loaded by the page (window.JSZip).
export async function bookToFile(bookId, onProgress = () => {}) {
  const book = await getBook(bookId);
  const zip = new window.JSZip();
  zip.file("book.json", JSON.stringify({ format: "photobook-studio", version: 1, book }, null, 1));
  const ids = Object.keys(book.photos || {});
  for (const [n, pid] of ids.entries()) {
    const blob = await getPhoto(bookId, pid);
    if (blob) zip.file(`photos/${pid}`, blob, { compression: "STORE" }); // JPEGs don't shrink further
    onProgress(n + 1, ids.length);
  }
  return zip.generateAsync({ type: "blob" });
}

// Opens a book file as a new book (a copy, if this browser already has it).
export async function bookFromFile(file, makeThumb, onProgress = () => {}) {
  const zip = await window.JSZip.loadAsync(file);
  const meta = JSON.parse(await zip.file("book.json").async("string"));
  if (meta.format !== "photobook-studio") throw new Error("This isn't a Photobook Studio book file.");
  const book = meta.book;
  const existing = await getBook(book.id);
  if (existing) { book.id = newId(); book.name += " (copy)"; }
  const ids = Object.keys(book.photos || {});
  for (const [n, pid] of ids.entries()) {
    const entry = zip.file(`photos/${pid}`);
    if (!entry) continue;
    const blob = await entry.async("blob");
    await putPhoto(book.id, pid, blob, await makeThumb(blob));
    onProgress(n + 1, ids.length);
  }
  book.created ??= Date.now();
  await saveBook(book);
  return book;
}
