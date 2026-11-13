// Storage demo: make a book from photos, see it survive a reload, save/open it as a file.
import * as store from "./storage.js";

const $ = s => document.querySelector(s);
const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const mb = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`;
const status = t => { $("#status").textContent = t; };
let openId = null;
const urls = [];

// A small copy for the editor (and for the book list), made in the browser.
async function makeThumb(blob, size = 400) {
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const k = Math.min(1, size / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const info = { w: bmp.width, h: bmp.height };
  bmp.close();
  const thumb = await c.convertToBlob({ type: "image/jpeg", quality: 0.82 });
  thumb.info = info;
  return thumb;
}

async function showStorage() {
  const { used, quota, persisted } = await store.storageInfo();
  $("#meter").style.width = `${quota ? Math.max(0.5, (100 * used) / quota) : 0}%`;
  $("#usage").textContent = quota ? `Using ${mb(used)} of the ${mb(quota)} this browser allows this site` : "";
  $("#persist").replaceChildren(persisted
    ? h("span", { style: "color:var(--ok)" }, "✓ Kept even if the disk gets full")
    : h("button", { onclick: async () => { await store.askToKeep(); showStorage(); }, title: "Asks the browser not to clear these books to free up space" }, "Keep my books safe"));
}

async function showBooks() {
  urls.splice(0).forEach(u => URL.revokeObjectURL(u));
  const books = await store.listBooks();
  const rows = await Promise.all(books.map(async b => {
    const first = Object.keys(b.photos || {})[0];
    const cover = h("div", { className: "cover" });
    if (first) { const t = await store.getPhoto(b.id, first, { thumb: true }); if (t) { const u = URL.createObjectURL(t); urls.push(u); cover.style.backgroundImage = `url(${u})`; } }
    const n = Object.keys(b.photos || {}).length;
    return h("div", { className: "book" + (b.id === openId ? " active" : "") }, cover,
      h("div", { className: "info" }, h("b", {}, b.name), h("br"),
        h("span", { className: "small muted" }, `${n} photo${n === 1 ? "" : "s"} · saved ${new Date(b.modified).toLocaleString()}`)),
      h("button", { onclick: () => { openId = b.id; showBooks(); } }, "Open"),
      h("button", { onclick: () => saveFile(b) }, "Save book file"),
      h("button", { className: "danger", onclick: () => remove(b) }, "Delete"));
  }));
  $("#books").replaceChildren(...(rows.length ? rows : [h("p", { className: "muted small" }, "No books yet. Choose some photos above.")]));
  await showDetail();
  showStorage();
}

async function showDetail() {
  const book = openId && await store.getBook(openId);
  if (!book) { $("#detail").replaceChildren(); return; }
  const imgs = await Promise.all(Object.keys(book.photos).map(async pid => {
    const t = await store.getPhoto(book.id, pid, { thumb: true });
    const u = t ? URL.createObjectURL(t) : ""; urls.push(u);
    return h("img", { src: u, title: book.photos[pid].name, loading: "lazy" });
  }));
  $("#detail").replaceChildren(h("p", { className: "small muted", style: "margin:14px 0 0" },
    `"${book.name}": these photos were read back from the browser's storage just now, not from your files. Reload the page and they're still here.`),
    h("div", { className: "thumbs" }, ...imgs));
}

$("#files").onchange = async e => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const book = { id: store.newId(), name: $("#name").value.trim() || "Untitled book", created: Date.now(), photos: {}, pages: [] };
  try {
    for (const [n, f] of files.entries()) {
      status(`Saving photo ${n + 1} of ${files.length}…`);
      const pid = store.newId(), thumb = await makeThumb(f);
      await store.putPhoto(book.id, pid, f, thumb);
      book.photos[pid] = { id: pid, name: f.name, ...thumb.info };
    }
    await store.saveBook(book);
    openId = book.id;
    status(`Saved "${book.name}" with ${files.length} photos in this browser.`);
  } catch (err) {
    status(`Couldn't save: ${err.message}`);
  }
  showBooks();
};

$("#open").onchange = async e => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const book = await store.bookFromFile(f, makeThumb, (n, of) => status(`Opening photo ${n} of ${of}…`));
    openId = book.id;
    status(`Opened "${book.name}" from ${f.name}.`);
  } catch (err) {
    status(`Couldn't open that file: ${err.message}`);
  }
  showBooks();
};

async function saveFile(b) {
  const blob = await store.bookToFile(b.id, (n, of) => status(`Packing photo ${n} of ${of}…`));
  const a = h("a", { href: URL.createObjectURL(blob), download: `${b.name.replace(/[^\w -]+/g, "").trim() || "book"}.photobook` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  status(`Saved a copy of "${b.name}" (${mb(blob.size)}) to your Downloads folder.`);
}

async function remove(b) {
  if (!confirm(`Delete "${b.name}" from this browser? Its photos are removed too. (Book files you've saved aren't touched.)`)) return;
  await store.deleteBook(b.id);
  if (openId === b.id) openId = null;
  status(`Deleted "${b.name}".`);
  showBooks();
}

async function showBackgrounds() {
  const names = await (await fetch("assets/backgrounds/index.json")).json();
  $("#bgs").replaceChildren(...names.map(n => h("img", { src: `assets/backgrounds/thumbs/${n}`, title: n.replace(/\.jpg$/, ""), loading: "lazy" })));
}

showBooks();
showBackgrounds();
