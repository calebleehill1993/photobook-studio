// Photobook Studio editor (browser build). Everything is saved in this browser; local-api.js answers
// the requests the Mac build's server used to.
import { api, thumbUrl, bgUrl, busy } from "./local-api.js";
import * as store from "./storage.js";
import { makeThumb, preload, uprightBitmap } from "./analyze.js";

// Geometry is in inches (top-left origin), matching layout.py:
// an item is a frame {x, y, w, h} plus a crop {zoom, cx, cy} — the photo covers the frame,
// zoomed by `zoom`, with the point (cx, cy) of the photo (fractions) at the frame's center.
//
// Text: each item has a caption (drawn in the strip under it), each page has a title (in the
// title area unless moved) and any number of free text boxes. Text is wrapped and sized here
// (layoutText) and the export draws exactly those lines, so the printed page matches the screen.

const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, props = {}, ...kids) => {
  const el = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
};
const IS_MAC = /Mac/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl+", ALT = IS_MAC ? "Option" : "Alt";
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const round2 = v => Math.round(v * 100) / 100;
const btn = (text, fn, cls = "", title = "") => { const b = h("button", { className: cls, textContent: text, title }); b.onclick = fn; return b; };

// ---------- state ----------
// sel: null, {kind: "item" | "caption" | "title" | "text", i} (i indexes items or texts),
// or {kind: "items", list: [i, ...]} when several photos are selected (first = the reference)
let slug = null, book = null, pageIx = 0, sel = null, cropMode = false, swapMode = false, editing = null;
let showGuides = true, previewMode = false;
let history = [], future = [], saveTimer = null, saving = Promise.resolve(), dirty = false, retryTimer = null;
let backgrounds = { book: [], shared: [] }, FONTS = {};

const S = () => book.settings;
const curPage = () => book.pages[pageIx];
const isItem = () => sel?.kind === "item";
const selItem = () => (isItem() ? curPage().items[sel.i] : null);
const photoOf = item => book.photos[item.photo];
const select = (kind, i) => { sel = kind ? { kind, i } : null; cropMode = false; swapMode = false; };
const selectedItems = () => (sel?.kind === "items" ? sel.list : isItem() ? [sel.i] : []);
function selectItems(list) {
  list = [...new Set(list)];
  if (list.length > 1) { sel = { kind: "items", list }; cropMode = false; swapMode = false; }
  else select(list.length ? "item" : null, list[0]);
}

// ---------- fonts ----------
async function loadFonts() {
  FONTS = await fetch("assets/fonts/fonts.json").then(r => r.json());
  const css = Object.entries(FONTS).map(([name, f]) => {
    const face = (file, weight) => `@font-face{font-family:"${name}";src:url(assets/fonts/${file});font-weight:${weight};font-display:block}`;
    return f.variable ? face(f.file, "100 1000") : face(f.file, 400) + (f.bold ? face(f.bold, 700) : "");
  }).join("\n");
  document.head.append(h("style", { textContent: css }));
  await Promise.all(Object.entries(FONTS).flatMap(([name, f]) =>
    [400, f.variable || f.bold ? 700 : null].filter(Boolean).map(w => document.fonts.load(`${w} 20px "${name}"`))));
}
const hasBold = font => !!(FONTS[font]?.variable || FONTS[font]?.bold);

// ---------- text layout (the export draws these exact lines) ----------
const measureCtx = document.createElement("canvas").getContext("2d");
const LINE_HEIGHT = 1.2;

// A caption's look comes from the book, then its page, then the photo itself (each may override).
const captionStyleOwn = (pg, it) => ({ ...(pg.caption_style || {}), ...(it.caption_style || {}) });
const captionStyle = (pg, it) => styleFor("caption", captionStyleOwn(pg, it));
const captionFrame = (pg, it) => {
  const f = { ...(S().caption_frame || {}), ...(pg.caption_frame || {}), ...(it.caption_frame || {}) };
  return Object.keys(f).length ? f : null;
};

function styleFor(role, own) {
  const st = { ...S().styles[role], ...(own || {}) };
  if (!hasBold(st.font)) st.weight = 400;
  return st;
}

// Wrap `text` into the box (inches), shrinking the font when it doesn't fit.
function layoutText(text, st, box) {
  const fit = size => {
    const pxPerPt = 300 / 72; // measure at print resolution
    measureCtx.font = `${st.weight} ${size * pxPerPt}px "${st.font}"`;
    const maxW = box.w * 300;
    const lines = [];
    // Spaces are kept as typed (several in a row stay several); only the spaces where a line
    // wraps are dropped.
    for (const para of String(text).replace(/\t/g, "    ").split("\n")) {
      let line = "";
      for (const tok of para.match(/\S+|\s+/g) || []) {
        if (/^\s/.test(tok)) { line += tok; continue; }
        const tryLine = line + tok;
        if (measureCtx.measureText(tryLine).width <= maxW || !line.trim()) {
          if (!line.trim() && measureCtx.measureText(tryLine).width > maxW) { // a word longer than the box
            let part = line;
            for (const ch of tok) {
              if (measureCtx.measureText(part + ch).width > maxW && part.trim()) { lines.push(part.trimEnd()); part = ""; }
              part += ch;
            }
            line = part;
          } else line = tryLine;
        } else { lines.push(line.trimEnd()); line = tok; }
      }
      lines.push(line.trimEnd());
    }
    while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const tooTall = lines.length * size / 72 * LINE_HEIGHT > box.h + 1e-6;
    const tooWide = lines.some(l => measureCtx.measureText(l).width > maxW + 0.5);
    return { lines, size, fits: !tooTall && !tooWide };
  };
  let size = st.size;
  let out = fit(size);
  while (!out.fits && size > 4) { size = Math.max(4, size - 0.5); out = fit(size); }
  return out;
}

// The caption sits caption_gap below the photo's frame. The gap moves it without shrinking it,
// so a big gap can push captions toward the next row; the caption strip setting makes room.
// A photo shows a caption unless it's been switched off (e.g. one caption for a group of photos).
// Switching off keeps the text, so switching back on restores it.
const showsCaption = it => !it.caption_off;

function captionBox(item) {
  return captionPlace(item).box;
}

// ---------- rotation ----------
// Frames, text boxes and titles turn about their centers by `rotation` (degrees, clockwise).
// A caption turns with its photo (about the photo's center) unless caption_free is set; then it
// sits under the turned photo at its own caption_rotation. Inside a frame the photo itself can
// turn (crop.angle) and flip (crop.flip_x / crop.flip_y).
const rad = d => (d || 0) * Math.PI / 180;
const round1 = v => Math.round(v * 10) / 10;
const centerOf = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const normDeg = d => round1(((((d % 360) + 540) % 360) - 180)); // -180…180

function rotPt(p, c, deg) {
  const a = rad(deg), dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
}

// Upright box around `b` turned `deg` about `pivot` (its own center unless given).
function aabb(b, deg = 0, pivot = centerOf(b)) {
  if (!deg) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([fx, fy]) => rotPt({ x: b.x + fx * b.w, y: b.y + fy * b.h }, pivot, deg));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
const itemAabb = it => aabb(it, it.rotation);
const itemPlace = it => ({ box: it, deg: it.rotation || 0, pivot: centerOf(it) });

function inPlace(pt, { box, deg, pivot }) {
  const q = rotPt(pt, pivot, -deg);
  return q.x >= box.x && q.x <= box.x + box.w && q.y >= box.y && q.y <= box.y + box.h;
}

// Snap a dragged angle: Shift gives 15° steps; otherwise level/upright/sideways catch within 2°.
function snapAngle(deg, fine) {
  if (fine) return Math.round(deg / 15) * 15;
  const r = Math.round(deg / 90) * 90;
  return Math.abs(deg - r) < 2 ? r : round1(deg);
}

function captionPlace(it) {
  const s = S(), gap = s.caption_gap ?? 0.02, hgt = Math.max(0.08, s.caption - s.border - 0.03);
  if (it.caption_free) { // under the turned photo, at its own angle
    const bb = itemAabb(it), c = centerOf(it);
    const box = { x: c.x - it.w / 2, y: bb.y + bb.h + s.border + gap, w: it.w, h: hgt };
    return { box, deg: it.caption_rotation || 0, pivot: centerOf(box) };
  }
  const box = { x: it.x, y: it.y + it.h + s.border + gap, w: it.w, h: hgt };
  return { box, deg: it.rotation || 0, pivot: centerOf(it) };
}
const titlePlace = pg => { const box = titleBox(pg); return { box, deg: pg.title?.rotation || 0, pivot: centerOf(box) }; };
const textPlace = t => ({ box: t, deg: t.rotation || 0, pivot: centerOf(t) });

function titleBox(pg) {
  const s = S(), t = pg.title || {};
  return t.x != null ? { x: t.x, y: t.y, w: t.w, h: t.h } : { x: s.margin, y: s.margin, w: s.page - 2 * s.margin, h: Math.max(0.2, s.title) };
}

// ---------- box behind a text box or title ----------
// obj.frame = {fill: color|null, opacity 0–1, border: color|null, width (pt), radius (in), pad (in)}.
// The text is laid out inside the box, inset by the padding and the border.
const FRAME_DEFAULT = { fill: "#ffffff", opacity: 0.9, border: null, width: 1.5, radius: 0.06, pad: 0.08 };
const CAPTION_FRAME_DEFAULT = { fill: "#ffffff", opacity: 0.85, border: null, width: 1, radius: 0.03, pad: 0.02, hug: true };
const hasFrame = f => !!f && (!!f.fill || (!!f.border && f.width > 0));
function frameInner(box, f) {
  const k = (f.pad || 0) + (f.border ? (f.width || 0) / 72 : 0);
  return { x: box.x + k, y: box.y + k, w: Math.max(0.1, box.w - 2 * k), h: Math.max(0.05, box.h - 2 * k) };
}
function frameTarget(kind, i, pg = curPage()) {
  return kind === "title" ? pg.title : kind === "text" ? pg.texts[i] : null;
}

// Every text block on a page, laid out: what the editor draws and the export prints.
function pageTextBlocks(pg) {
  const out = [];
  const add = (kind, i, text, st, { box, deg, pivot }, frame) => {
    const framed = hasFrame(frame);
    const empty = !text || !text.trim();
    if (empty && !framed) return;
    let inner = framed ? frameInner(box, frame) : box;
    const { lines, size } = empty ? { lines: [], size: st.size } : layoutText(text, st, inner);
    let outer = box;
    if (framed && frame.hug && lines.length) { // box shrinks around the text instead of filling the space
      measureCtx.font = `${st.weight} ${size * 300 / 72}px "${st.font}"`;
      const k = (inner.x - box.x);
      const tw = Math.min(inner.w, Math.max(...lines.map(l => measureCtx.measureText(l).width)) / 300 + 0.04);
      const th = Math.min(inner.h, lines.length * size / 72 * LINE_HEIGHT);
      const ox = { left: 0, center: (inner.w - tw) / 2, right: inner.w - tw }[st.align || "center"];
      const oy = { top: 0, middle: (inner.h - th) / 2, bottom: inner.h - th }[st.valign || "top"];
      inner = { x: inner.x + ox, y: inner.y + oy, w: tw, h: th };
      outer = { x: inner.x - k, y: inner.y - k, w: tw + 2 * k, h: th + 2 * k };
    }
    const b = { kind, i, x: inner.x, y: inner.y, w: inner.w, h: inner.h, lines, size, font: st.font, weight: st.weight, color: st.color,
      align: st.align, valign: st.valign, line_height: LINE_HEIGHT, angle: deg || 0, px: pivot.x, py: pivot.y };
    if (framed) b.frame = { x: outer.x, y: outer.y, w: outer.w, h: outer.h, fill: frame.fill || null, opacity: frame.opacity ?? 1,
      border: frame.border && frame.width > 0 ? frame.border : null, width: frame.width || 0, radius: frame.radius || 0 };
    out.push(b);
  };
  pg.items.forEach((it, i) => { if (showsCaption(it)) add("caption", i, it.caption, captionStyle(pg, it), captionPlace(it), captionFrame(pg, it)); });
  if (pg.title) add("title", 0, pg.title.text, styleFor("title", pg.title.style), titlePlace(pg), pg.title.frame);
  (pg.texts || []).forEach((t, i) => add("text", i, t.text, styleFor("text", t.style), textPlace(t), t.frame));
  return out;
}

// ---------- crop math (mirrors layout.py) ----------
function cropBox(item, ph) {
  const W = ph.w, H = ph.h, c = item.crop, a = rad(c.angle);
  // The frame, turned into the photo's own axes, needs this much of the photo (inches).
  const bw = item.w * Math.abs(Math.cos(a)) + item.h * Math.abs(Math.sin(a));
  const bh = item.w * Math.abs(Math.sin(a)) + item.h * Math.abs(Math.cos(a));
  const k = Math.max(bw / W, bh / H) * Math.max(1, c.zoom); // inches per source px
  const cw = bw / k, ch = bh / k;
  const x = clamp(c.cx * W - cw / 2, 0, W - cw);
  const y = clamp(c.cy * H - ch / 2, 0, H - ch);
  return { x, y, cw, ch, k, W, H, bw, bh, mx: x + cw / 2, my: y + ch / 2 };
}

function bestOffset(length, win, lo, hi, soft, center) {
  if (win >= length) return 0;
  const tMin = Math.max(0, hi - win), tMax = Math.min(length - win, lo);
  if (tMin > tMax) return clamp((lo + hi) / 2 - win / 2, 0, length - win);
  let best = tMin, bestScore = -1e9;
  for (let s = 0; s <= 40; s++) {
    const t = tMin + (tMax - tMin) * s / 40;
    let score = 0;
    for (const [a, b, w] of soft) score += w * Math.max(0, Math.min(b, t + win) - Math.max(a, t)) / Math.max(1, b - a);
    score -= 0.05 * Math.abs(t + win / 2 - center) / win;
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}

function smartCrop(ph, aspect) {
  const W = ph.w, H = ph.h, k = ph.keep;
  const [cw, ch] = W / H > aspect ? [H * aspect, H] : [W, W / aspect];
  const x = bestOffset(W, cw, k[0], k[2], ph.soft.map(([b, w]) => [b[0], b[2], w]), (k[0] + k[2]) / 2);
  const y = bestOffset(H, ch, k[1], k[3], ph.soft.map(([b, w]) => [b[1], b[3], w]), (k[1] + k[3]) / 2 + 0.1 * ch);
  return { zoom: 1, cx: (x + cw / 2) / W, cy: (y + ch / 2) / H };
}

// Re-crop an existing photo around faces, keeping any turn or flip it was given.
function autoCrop(it) {
  const c = it.crop || {};
  return { ...smartCrop(photoOf(it), it.w / it.h), ...(c.angle ? { angle: c.angle } : {}),
    ...(c.flip_x ? { flip_x: true } : {}), ...(c.flip_y ? { flip_y: true } : {}) };
}

// ---------- history, saving & recovery ----------
const snapshot = () => JSON.stringify({ pages: book.pages, unplaced: book.unplaced, settings: book.settings, name: book.name,
  caption_memory: book.caption_memory || {} });
const localKey = () => `photobook:${slug}`;

function commit() {
  const snap = snapshot();
  if (history[history.length - 1] === snap) { renderAll(); return; }
  history.push(snap);
  if (history.length > 200) history.shift();
  future = [];
  scheduleSave(snap);
  renderAll();
}

function restore(snap) {
  Object.assign(book, JSON.parse(snap));
  pageIx = Math.min(pageIx, book.pages.length - 1);
  sel = null; cropMode = false; editing = null;
  scheduleSave(snap);
  renderAll();
}
function undo() { if (history.length > 1) { future.push(history.pop()); restore(history[history.length - 1]); } }
function redo() { if (future.length) { const s = future.pop(); history.push(s); restore(s); } }

function keepLocal(snap, saved) {
  // A quick extra copy, so nothing is lost if the tab closes mid-save.
  try { localStorage.setItem(localKey(), JSON.stringify({ snap, saved, at: new Date().toISOString(), rev: book.rev })); } catch (e) { /* storage full */ }
}

function setSaveState(text, bad = false) {
  const el = $("#save-state");
  el.textContent = text;
  el.classList.toggle("warn", bad);
  $("#offline").classList.toggle("hidden", !bad);
}

function scheduleSave(snap = snapshot()) {
  dirty = true;
  keepLocal(snap, false);
  setSaveState("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}

function flushSave() {
  clearTimeout(saveTimer);
  if (!book || !dirty) return saving;
  const snap = snapshot();
  const body = JSON.parse(snap);
  saving = saving.then(() => api("PUT", `/api/projects/${slug}`, body))
    .then(r => {
      book.rev = r.rev;
      if (snap === snapshot()) { dirty = false; keepLocal(snap, true); }
      clearTimeout(retryTimer);
      setSaveState(dirty ? "Saving…" : `All changes saved · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
      if (dirty) scheduleSave();
    })
    .catch(() => {
      setSaveState("Not saved yet — this browser's storage didn't accept the change (is the disk full?). Retrying…", true);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(flushSave, 4000);
    });
  return saving;
}

async function offerRecovery(server) {
  let local;
  try { local = JSON.parse(localStorage.getItem(localKey()) || "null"); } catch (e) { local = null; }
  if (!local || local.saved) return;
  const theirs = JSON.parse(local.snap);
  if (JSON.stringify({ pages: server.pages, unplaced: server.unplaced, settings: server.settings, name: server.name,
    caption_memory: server.caption_memory || {} }) === local.snap) return;
  const when = new Date(local.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  await new Promise(resolve => {
    const yes = btn("Restore my changes", () => { Object.assign(book, theirs); closeModal(); scheduleSave(); renderAll(); resolve(); }, "primary");
    const no = btn("Use the saved version", () => { keepLocal(snapshot(), true); closeModal(); resolve(); });
    modal(h("h2", {}, "Unsaved changes found"),
      h("p", {}, `There are changes from ${when} that didn't finish saving (maybe the tab closed mid-save).`),
      h("p", { className: "small muted" }, "Restoring them is usually right. Either way, earlier versions are kept under History."),
      h("div", { className: "btn-row" }, no, yes));
  });
}

async function showHistory() {
  await flushSave();
  const list = await api("GET", `/api/projects/${slug}/backups`);
  const rows = list.map(b => {
    const when = new Date(b.time).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const r = btn("Restore", async () => {
      await api("POST", `/api/projects/${slug}/backups/${b.name}/restore`);
      closeModal();
      await openBook(slug, { skipRecovery: true });
    }, "mini");
    return h("div", { className: "history-row" }, h("span", {}, h("b", {}, when), h("br"),
      h("span", { className: "small muted" }, `${b.pages} page${b.pages === 1 ? "" : "s"} · ${b.photos} photos · ${b.captions} captions`)), r);
  });
  modal(h("h2", {}, "History"),
    h("p", { className: "small muted" }, "A copy of this book is kept every couple of minutes while you work (in this browser). Restoring one keeps your current version in this list too, so you can always go back. For a copy you can keep anywhere, use Save book file."),
    h("div", { className: "history" }, ...(rows.length ? rows : [h("p", { className: "muted" }, "No earlier versions yet.")])),
    h("div", { className: "btn-row" }, btn("Close", closeModal)));
}

// ---------- home ----------
let coverURLs = [];
async function showHome() {
  if (book) await flushSave();
  slug = book = null;
  $("#editor").classList.add("hidden");
  $("#home").classList.remove("hidden");
  if (location.hash) window.history.replaceState(null, "", location.pathname + location.search);
  const [books, bgs] = await Promise.all([api("GET", "/api/projects"), api("GET", "/api/backgrounds")]);
  showStorage();
  $("#new-bg").replaceChildren(h("option", { value: "auto", selected: true }, "Match each month (automatic)"),
    h("option", { value: "" }, "Plain white"),
    ...bgGroups(bgs.filter(n => !n.startsWith("month-"))).map(([label, names]) =>
      h("optgroup", { label }, ...names.map(n => h("option", { value: n }, bgLabel(n))))));
  coverURLs.forEach(u => URL.revokeObjectURL(u)); coverURLs = [];
  const list = $("#books");
  list.replaceChildren(...books.map(b => {
    const del = h("button", { className: "mini ghost danger", title: "Delete book", textContent: "Delete" });
    del.onclick = async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${b.name}" from this browser? Its photos and pages here will be removed (your original photos elsewhere, and any book files you saved, are untouched).`)) return;
      await api("DELETE", `/api/projects/${b.slug}`);
      showHome();
    };
    const fileBtn = h("button", { className: "mini ghost", title: "Save a copy of this book (with its photos) as a file", textContent: "Save file" });
    fileBtn.onclick = e => { e.stopPropagation(); saveBookFile(b.slug, b.name); };
    const cover = h("div", { className: "cover" });
    if (b.cover) store.getPhoto(b.slug, b.cover, { thumb: true }).then(t => {
      if (!t) return;
      const u = URL.createObjectURL(t); coverURLs.push(u); cover.style.backgroundImage = `url(${u})`;
    });
    const card = h("div", { className: "book" }, cover,
      h("div", { className: "meta" }, h("b", {}, b.name),
        h("div", { className: "row" }, h("span", { className: "muted small" }, `${b.pages} page${b.pages === 1 ? "" : "s"} · ${b.photos} photos`), fileBtn, del)));
    card.onclick = () => openBook(b.slug);
    return card;
  }));
  if (!books.length) list.append(h("p", { className: "muted" }, "No books yet. Create one with your photos on the left, or open a book file."));
}

const mb = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`;
async function showStorage() {
  const { used, quota, persisted } = await store.storageInfo();
  const keep = persisted ? null : btn("Keep my books safe", async () => { await store.askToKeep(); showStorage(); }, "mini ghost",
    "Asks the browser never to clear these books to free up disk space");
  $("#storage").replaceChildren("Books are saved in this browser on this computer, nothing is uploaded. ",
    quota ? `Using ${mb(used)} of ${mb(quota)} available. ` : "",
    persisted ? h("span", { className: "ok" }, "✓ Kept even if the disk gets full.") : keep);
}

function download(blob, filename) {
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
const safeName = name => name.replace(/[\\/:*?"<>|]+/g, "").trim() || "book";

async function saveBookFile(id, name) {
  if (book && id === slug) await flushSave();
  const prog = h("div", { className: "progress" }, h("div", { className: "bar" }, h("i")), h("span"));
  modal(h("h2", {}, "Saving book file…"), h("p", { className: "small muted" }, "Packing the book and all of its photos into one file."), prog);
  try {
    const blob = await store.bookToFile(id, (n, of) => { $("i", prog).style.width = `${(100 * n) / of}%`; $("span", prog).textContent = `Photo ${n} / ${of}`; });
    download(blob, `${safeName(name)}.photobook`);
    modal(h("h2", {}, "Book file saved"),
      h("p", {}, `"${safeName(name)}.photobook" (${mb(blob.size)}) is in your Downloads folder.`),
      h("p", { className: "small muted" }, "Keep it somewhere safe (Google Drive, a USB drive…) as a backup. To open it on another computer, choose Open book file on the home screen."),
      h("div", { className: "btn-row" }, btn("Close", closeModal)));
  } catch (e) {
    modal(h("h2", {}, "Couldn't save the book file"), h("p", { className: "warn" }, e.message), btn("Close", closeModal));
  }
}

async function openBookFile(file) {
  const prog = h("div", { className: "progress" }, h("div", { className: "bar" }, h("i")), h("span"));
  modal(h("h2", {}, "Opening book file…"), h("p", { className: "small muted" }, file.name), prog);
  try {
    const b = await store.bookFromFile(file, makeThumb, (n, of) => { $("i", prog).style.width = `${(100 * n) / of}%`; $("span", prog).textContent = `Photo ${n} / ${of}`; });
    closeModal();
    openBook(b.id);
  } catch (e) {
    modal(h("h2", {}, "Couldn't open that file"), h("p", { className: "warn" }, e.message), btn("Close", closeModal));
  }
}

function pollJob(s, progressEl, verb) {
  progressEl.classList.remove("hidden");
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const j = await api("GET", `/api/projects/${s}/job`).catch(() => ({}));
      const total = j.total || 1, done = j.done || 0;
      $("i", progressEl).style.width = `${(100 * done) / total}%`;
      $("span", progressEl).textContent = `${verb} ${done} / ${j.total ?? "…"}`;
      if (j.error) { progressEl.classList.add("hidden"); reject(new Error(j.error)); }
      else if (j.finished) { progressEl.classList.add("hidden"); resolve(j); }
      else setTimeout(tick, 600);
    };
    tick();
  });
}

function setupHome() {
  const form = $("#new-book"), files = $("#files"), drop = $("#drop");
  const label = () => {
    const n = files.files.length;
    $("#drop-label").innerHTML = n ? `<b>${n} file${n > 1 ? "s" : ""} selected</b><br><small>${[...files.files].slice(0, 3).map(f => f.name).join(", ")}${n > 3 ? "…" : ""}</small>`
      : `<b>Choose photos</b> or drop them here<br><small>A Google Photos / Takeout .zip works, or pick images directly</small>`;
  };
  files.onchange = () => { label(); preload(); };
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove("over")));
  drop.addEventListener("drop", e => { e.preventDefault(); files.files = e.dataTransfer.files; label(); });
  form.onsubmit = async e => {
    e.preventDefault();
    if (!files.files.length) return alert("Choose some photos or a zip first.");
    const b = $("button[type=submit]", form);
    b.disabled = true; b.textContent = "Reading photos…";
    try {
      const { slug: s } = await api("POST", "/api/projects", new FormData(form));
      b.textContent = "Finding faces & laying out…";
      const j = await pollJob(s, $("#new-progress"), "Analyzing photo");
      if (j.skipped?.length) alert(`${j.skipped.length} file${j.skipped.length > 1 ? "s" : ""} couldn't be opened as photos and were skipped: ${j.skipped.slice(0, 5).join(", ")}${j.skipped.length > 5 ? "…" : ""}`);
      form.reset(); label();
      openBook(s);
    } catch (err) { alert("Couldn't create the book: " + err.message); }
    b.disabled = false; b.textContent = "Create book";
  };
}

// ---------- editor ----------
async function openBook(s, { skipRecovery = false } = {}) {
  slug = s;
  book = await api("GET", `/api/projects/${s}`);
  backgrounds = await api("GET", `/api/projects/${s}/backgrounds`);
  book.caption_memory = book.caption_memory || {};
  book.settings.caption_gap ??= 0.02; // books made before this setting existed
  if (!book.pages.length) book.pages.push(blankPage());
  for (const pg of book.pages) { pg.texts = pg.texts || []; pg.title = pg.title || { text: "", auto: false }; }
  pageIx = 0; sel = null; cropMode = false; swapMode = false; editing = null; dirty = false;
  history = [snapshot()]; future = [];
  location.hash = s;
  $("#home").classList.add("hidden");
  $("#editor").classList.remove("hidden");
  $("#book-name").value = book.name;
  setSaveState(book.saved_at ? `Saved · ${new Date(book.saved_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "");
  renderAll();
  if (!skipRecovery) await offerRecovery(JSON.parse(history[0]));
  else keepLocal(snapshot(), true);
  history = [snapshot()];
}

function blankPage(from) {
  return { items: [], background: from?.background ?? null, color: from?.color ?? "#ffffff", title: { text: "", auto: false }, texts: [] };
}

function renderAll() {
  renderPages();
  renderTray();
  renderPage();
  renderInspector();
  $("#undo").disabled = history.length < 2;
  $("#redo").disabled = !future.length;
  scheduleSpellcheck();
}

function renderPages() {
  const list = $("#pages");
  list.replaceChildren(...book.pages.map((pg, i) => {
    const mini = h("div", { className: "mini-page" });
    mini.style.backgroundImage = pg.background ? `url(${bgUrl(pg.background, true)})` : "";
    mini.style.backgroundColor = pg.color || "#fff";
    const p = S().page;
    for (const it of pg.items) {
      mini.append(h("i", { style: `left:${(100 * it.x) / p}%;top:${(100 * it.y) / p}%;width:${(100 * it.w) / p}%;height:${(100 * it.h) / p}%;background-image:url(${thumbUrl(it.photo)});transform:rotate(${it.rotation || 0}deg)` }));
    }
    const title = pg.title?.text?.trim();
    const el = h("div", { className: "page-thumb" + (i === pageIx ? " active" : "") }, mini,
      h("div", { className: "label" }, h("b", {}, `Page ${i + 1}`), h("br"),
        h("span", { className: "muted" }, `${pg.items.length} photo${pg.items.length === 1 ? "" : "s"}`),
        title ? [h("br"), h("span", { className: "muted page-title-snip", title }, title)] : null));
    el.onclick = () => { stopEditing(); pageIx = i; select(null); renderAll(); };
    el.ondragover = e => { e.preventDefault(); el.classList.add("drop-target"); };
    el.ondragleave = () => el.classList.remove("drop-target");
    el.ondrop = e => {
      e.preventDefault(); el.classList.remove("drop-target");
      const pid = e.dataTransfer.getData("text/photo");
      if (pid) { pageIx = i; placeFromTray(pid, S().page / 2, S().page / 2); }
    };
    return el;
  }));
}

function renderTray() {
  const tray = $("#tray");
  $("#tray-count").textContent = book.unplaced.length ? `(${book.unplaced.length})` : "";
  const items = book.unplaced.filter(pid => book.photos[pid]).map(pid => {
    const del = h("button", { title: "Delete from this book", textContent: "×" });
    del.onclick = async e => {
      e.stopPropagation();
      if (!confirm("Delete this photo from the book?")) return;
      await flushSave();
      await api("DELETE", `/api/projects/${slug}/photos/${pid}`);
      delete book.photos[pid];
      book.unplaced = book.unplaced.filter(x => x !== pid);
      history = [snapshot()]; future = [];
      renderAll();
    };
    const el = h("div", { className: "tray-item", draggable: true, title: `${book.photos[pid].name} — drag onto the page, or click to add` }, del);
    el.style.backgroundImage = `url(${thumbUrl(pid)})`;
    el.ondragstart = e => e.dataTransfer.setData("text/photo", pid);
    el.onclick = () => placeFromTray(pid, S().page / 2, S().page / 2);
    return el;
  });
  tray.replaceChildren(...(items.length ? items : [h("p", { className: "muted small empty-tray" },
    "Photos you remove from a page wait here. Drag one onto a page, or onto a photo to swap it in.")]));
}

function typicalHeight(pg) {
  const hs = pg.items.map(i => i.h).sort((a, b) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)] : 1.5;
}

// Captions belong to photos: they follow a photo to the tray and back.
function remember(item) {
  if (item.caption) book.caption_memory[item.photo] = { caption: item.caption, caption_auto: item.caption_auto, caption_style: item.caption_style, caption_frame: item.caption_frame };
}
function recall(pid) {
  const m = book.caption_memory[pid];
  delete book.caption_memory[pid];
  return m || { caption: "" };
}

function placeFromTray(pid, cx, cy, onto = null) {
  const ph = book.photos[pid], pg = curPage(), p = S().page;
  book.unplaced = book.unplaced.filter(x => x !== pid);
  if (onto != null) { // swap into an existing frame; its photo goes to the tray
    const it = pg.items[onto];
    remember(it);
    book.unplaced.unshift(it.photo);
    delete it.caption_style; delete it.caption_frame; delete it.caption_auto;
    Object.assign(it, { photo: pid, crop: smartCrop(ph, it.w / it.h) }, recall(pid));
    select("item", onto);
  } else {
    const hgt = typicalHeight(pg), w = Math.min(hgt * (ph.w / ph.h), p - 2 * S().margin);
    pg.items.push({ photo: pid, x: clamp(cx - w / 2, 0, p - w), y: clamp(cy - hgt / 2, 0, p - hgt), w, h: hgt,
      crop: smartCrop(ph, w / hgt), ...recall(pid) });
    select("item", pg.items.length - 1);
  }
  commit();
}

function removeToTray(ix = sel?.i) {
  const pg = curPage();
  const [it] = pg.items.splice(ix, 1);
  remember(it);
  book.unplaced.unshift(it.photo);
  select(null);
  commit();
}

// ---------- page canvas ----------
let scale = 80; // screen px per inch
const pageEl = () => $("#page");

function computeScale() {
  const st = $("#stage");
  return Math.max(30, Math.min(st.clientWidth - 48, st.clientHeight - 64) / S().page);
}

function renderPage() {
  const pg = curPage(), el = pageEl();
  scale = computeScale();
  const P = S().page * scale;
  el.style.width = el.style.height = `${P}px`;
  el.style.backgroundImage = pg.background ? `url(${bgUrl(pg.background)})` : "none";
  el.style.backgroundColor = pg.color || "#fff";
  el.classList.toggle("preview", previewMode);

  // items, reusing elements so dragging stays smooth
  const els = [...el.querySelectorAll(".item")];
  pg.items.forEach((it, i) => {
    let item = els[i];
    if (!item) { item = h("div", { className: "item" }, h("img", { draggable: false })); el.append(item); }
    item.dataset.i = i;
    placeItem(item, it);
  });
  els.slice(pg.items.length).forEach(e => e.remove());
  pg.items.forEach((_, i) => el.append(el.querySelector(`.item[data-i="${i}"]`)));
  renderText();
  renderOverlays();
}

// Photo frame color: each page can have its own; otherwise the book's.
const frameColor = pg => pg?.border_color || S().border_color || "#ffffff";

function placeItem(el, it) {
  const ph = photoOf(it), b = cropBox(it, ph), s = S(), c = it.crop;
  Object.assign(el.style, { left: `${it.x * scale}px`, top: `${it.y * scale}px`, width: `${it.w * scale}px`, height: `${it.h * scale}px`,
    outline: s.border > 0 ? `${s.border * scale}px solid ${frameColor(curPage())}` : "none",
    transform: it.rotation ? `rotate(${it.rotation}deg)` : "" });
  const img = el.firstChild, src = thumbUrl(it.photo);
  if (img.getAttribute("src") !== src) img.src = src;
  // The crop's center sits at the frame's center; the photo is flipped and turned about it.
  Object.assign(img.style, { width: `${b.W * b.k * scale}px`, height: `${b.H * b.k * scale}px`,
    left: `${it.w * scale / 2}px`, top: `${it.h * scale / 2}px`, transformOrigin: "0 0",
    transform: `rotate(${c.angle || 0}deg) scale(${c.flip_x ? -1 : 1}, ${c.flip_y ? -1 : 1}) translate(${-b.mx * b.k * scale}px, ${-b.my * b.k * scale}px)` });
  el.classList.toggle("lowres", b.cw / b.bw < 150); // under ~150 source px per printed inch
  el.classList.toggle("swap-target", false);
  el.classList.toggle("selected", selectedItems().includes(+el.dataset.i));
}

function renderText() {
  const el = pageEl(), pg = curPage();
  el.querySelectorAll(".tb, .tb-frame").forEach(e => e.remove());
  for (const b of pageTextBlocks(pg)) {
    if (b.frame) {
      const f = b.frame, fr = h("div", { className: `tb-frame tb-frame-${b.kind}` });
      const hex = f.fill ? f.fill.replace("#", "") : null;
      Object.assign(fr.style, { left: `${f.x * scale}px`, top: `${f.y * scale}px`, width: `${f.w * scale}px`, height: `${f.h * scale}px`,
        borderRadius: `${f.radius * scale}px`,
        background: hex ? `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${f.opacity})` : "transparent",
        border: f.border ? `${f.width / 72 * scale}px solid ${f.border}` : "none" });
      if (b.angle) Object.assign(fr.style, { transformOrigin: `${(b.px - f.x) * scale}px ${(b.py - f.y) * scale}px`, transform: `rotate(${b.angle}deg)` });
      el.append(fr);
    }
    if (editing && editing.kind === b.kind && editing.i === b.i) continue;
    const lh = b.size / 72 * b.line_height * scale;
    const blockH = lh * b.lines.length, boxH = b.h * scale;
    const pad = { top: 0, middle: (boxH - blockH) / 2, bottom: boxH - blockH }[b.valign || "top"];
    const box = h("div", { className: `tb tb-${b.kind}` });
    box.dataset.kind = b.kind; box.dataset.i = b.i;
    Object.assign(box.style, { left: `${b.x * scale}px`, top: `${b.y * scale}px`, width: `${b.w * scale}px`, height: `${boxH}px`,
      paddingTop: `${Math.max(pad, -1e3)}px`, fontFamily: `"${b.font}"`, fontWeight: b.weight, color: b.color,
      fontSize: `${b.size / 72 * scale}px`, lineHeight: `${lh}px`, textAlign: b.align });
    if (b.angle) Object.assign(box.style, { transformOrigin: `${(b.px - b.x) * scale}px ${(b.py - b.y) * scale}px`, transform: `rotate(${b.angle}deg)` });
    for (const line of b.lines) box.append(h("div", { className: "tl" }, line ? markSpelling(line) : "\u00a0"));
    el.append(box);
  }
}

function renderOverlays() {
  const el = pageEl(), pg = curPage(), s = S(), sc = scale;
  el.querySelectorAll(".ov").forEach(e => e.remove());
  const add = (cls, x, y, w, hh, props = {}) => {
    const d = h("div", { className: "ov " + cls, ...props });
    Object.assign(d.style, { left: `${x * sc}px`, top: `${y * sc}px`, width: `${w * sc}px`, height: `${hh * sc}px` });
    el.append(d);
    return d;
  };
  const addTurned = (cls, { box, deg, pivot }, props = {}) => { // a box turned `deg` about `pivot`
    const d = add(cls, box.x, box.y, box.w, box.h, props);
    if (deg) Object.assign(d.style, { transformOrigin: `${(pivot.x - box.x) * sc}px ${(pivot.y - box.y) * sc}px`, transform: `rotate(${deg}deg)` });
    return d;
  };
  const rotHandle = (pl, target) => { // round knob on a stick above the top edge
    const r = 8 / sc, lift = 26 / sc, b = pl.box;
    addTurned("rot-stick", { box: { x: b.x + b.w / 2 - 0.5 / sc, y: b.y - lift, w: 1 / sc, h: lift }, deg: pl.deg, pivot: pl.pivot });
    const p = rotPt({ x: b.x + b.w / 2, y: b.y - lift }, pl.pivot, pl.deg);
    add("rot-handle", p.x - r, p.y - r, 2 * r, 2 * r, { title: "Drag to turn · Shift for 15° steps" }).dataset.rot = target;
  };
  if (showGuides) {
    const inner = s.page - 2 * s.margin;
    add("guide margin", s.margin, s.margin, inner, inner);
  }
  // clickable text areas, with a faint prompt where nothing is written yet
  const blank = t => !t?.trim();
  const hit = (kind, i, place, empty, prompt) => {
    const d = addTurned(`hit hit-${kind}` + (empty ? " empty" : ""), place, { textContent: empty ? prompt : "" });
    d.dataset.kind = kind; d.dataset.i = i;
  };
  hit("title", 0, titlePlace(pg), blank(pg.title?.text), "Add a title…");
  pg.items.forEach((it, i) => { if (showsCaption(it)) hit("caption", i, captionPlace(it), blank(it.caption), "Add caption…"); });
  (pg.texts || []).forEach((t, i) => hit("text", i, textPlace(t), blank(t.text), "Type here…"));

  if (!sel) return;
  if (sel.kind === "items") {
    const list = sel.list.map(i => pg.items[i]);
    list.forEach(it => addTurned("sel-box multi", itemPlace(it)));
    const b = bounds(list.map(itemAabb));
    add("sel-box group", b.x, b.y, b.w, b.h);
    return;
  }
  if (sel.kind === "caption") {
    const it = pg.items[sel.i], place = captionPlace(it);
    addTurned("sel-box text-sel", place);
    if (it.caption_free) rotHandle(place, "caption");
    return;
  }
  const obj = selObject();
  if (!obj) return;
  const place = isItem() ? itemPlace(obj) : sel.kind === "title" ? titlePlace(pg) : textPlace(obj);
  if (cropMode && isItem()) {
    const it = obj, b = cropBox(it, photoOf(it)), c = centerOf(it), cr = it.crop;
    const g = add("ghost-img", c.x, c.y, b.W * b.k, b.H * b.k);
    Object.assign(g.style, { background: `url(${thumbUrl(it.photo)}) center/100% 100%`, transformOrigin: "0 0",
      transform: `rotate(${(it.rotation || 0) + (cr.angle || 0)}deg) scale(${cr.flip_x ? -1 : 1}, ${cr.flip_y ? -1 : 1}) translate(${-b.mx * b.k * sc}px, ${-b.my * b.k * sc}px)` });
    add("crop-veil", 0, 0, s.page, s.page).dataset.role = "veil";
    addTurned("sel-box crop", place);
    rotHandle(place, "image");
    return;
  }
  addTurned("sel-box" + (isItem() ? "" : " text-sel"), place);
  const hs = 6 / sc, box = place.box;
  const spots = { nw: [0, 0], n: [.5, 0], ne: [1, 0], e: [1, .5], se: [1, 1], s: [.5, 1], sw: [0, 1], w: [0, .5] };
  for (const [name, [fx, fy]] of Object.entries(spots)) {
    const p = rotPt({ x: box.x + fx * box.w, y: box.y + fy * box.h }, place.pivot, place.deg);
    const d = add("handle", p.x - hs, p.y - hs, 2 * hs, 2 * hs);
    d.dataset.handle = name;
    d.style.cursor = place.deg ? "move" : { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" }[name];
  }
  rotHandle(place, isItem() ? "frame" : sel.kind);
}

function showAngle(pt, deg) {
  let l = pageEl().querySelector(".rot-label");
  if (!l) { l = h("div", { className: "rot-label" }); pageEl().append(l); }
  Object.assign(l.style, { left: `${pt.x * scale + 14}px`, top: `${pt.y * scale + 14}px` });
  l.textContent = `${deg}°`;
}

function selObject(materialize = false) {
  if (!sel) return null;
  const pg = curPage();
  if (sel.kind === "item") return pg.items[sel.i];
  if (sel.kind === "text") return pg.texts[sel.i];
  if (sel.kind === "title") {
    if (materialize && pg.title.x == null) Object.assign(pg.title, titleBox(pg));
    return pg.title.x != null ? pg.title : titleBox(pg);
  }
  return null;
}

function drawSnapLines(lines) {
  const el = pageEl();
  el.querySelectorAll(".snap-line").forEach(e => e.remove());
  for (const [axis, v] of lines) {
    const d = h("div", { className: "snap-line" });
    Object.assign(d.style, axis === "x" ? { left: `${v * scale}px`, top: 0, width: "1px", height: "100%" }
      : { top: `${v * scale}px`, left: 0, height: "1px", width: "100%" });
    el.append(d);
  }
}

// ---------- snapping ----------
function snapTargets() {
  const s = S(), p = s.page, xs = [s.margin, p - s.margin, p / 2], ys = [s.margin, s.margin + s.title, p - s.margin, p - s.margin - s.caption, p / 2];
  curPage().items.forEach((it, i) => {
    if (selectedItems().includes(i)) return;
    const o = itemAabb(it);
    xs.push(o.x, o.x + o.w, o.x + o.w / 2, o.x + o.w + s.gap, o.x - s.gap);
    ys.push(o.y, o.y + o.h, o.y + o.h + s.caption + s.gap, o.y - s.gap, o.y - s.caption - s.gap, o.y + o.h + s.caption);
  });
  return { xs, ys };
}

function snap1(edges, targets, thr) {
  let best = null;
  for (const e of edges) for (const t of targets) {
    const d = t - e;
    if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best[0]))) best = [d, t];
  }
  return best || [0, null];
}

// ---------- pointer interaction ----------
let drag = null;

function pagePoint(e) {
  const r = pageEl().getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
}

// Clicking re-draws the page's clickable areas, which removes the element under the pointer,
// so the browser's own dblclick never fires reliably; detect double-clicks from timing instead.
let lastDown = { t: 0, x: 0, y: 0 };

function onPointerDown(e) {
  if (e.button !== 0 || e.target.closest(".tb-editor")) return;
  const pt = pagePoint(e), t = e.target;
  const now = performance.now(), isDouble = now - lastDown.t < 450 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6;
  lastDown = isDouble ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY };
  if (isDouble && !cropMode) { e.preventDefault(); onDoubleClick(pt); return; }
  stopEditing();
  if (cropMode) {
    const it = selItem();
    if (t.dataset.rot === "image") {
      drag = rotateDrag("image", pt);
      pageEl().setPointerCapture(e.pointerId);
    } else if (t.dataset.role === "veil") {
      drag = { kind: "pan", start: pt, box: cropBox(it, photoOf(it)), moved: false };
      pageEl().setPointerCapture(e.pointerId);
    }
    return;
  }
  if (t.dataset.rot) {
    drag = rotateDrag(t.dataset.rot, pt);
  } else if (t.dataset.handle) {
    const obj = selObject(true);
    drag = { kind: "resize", handle: t.dataset.handle, start: pt, orig: { ...obj }, aspect: obj.w / obj.h, moved: false };
  } else if (t.classList.contains("item")) {
    const i = +t.dataset.i, cur = selectedItems();
    if (swapMode && isItem() && i !== sel.i) { swapPhotos(sel.i, i); return; }
    if (e.shiftKey || e.metaKey || e.ctrlKey) { // add/remove this photo from the selection
      selectItems(cur.includes(i) ? cur.filter(j => j !== i) : [...cur, i]);
      renderPage(); renderInspector();
      return;
    }
    if (cur.length > 1 && cur.includes(i)) {
      drag = { kind: "group", start: pt, origs: cur.map(j => ({ j, x: curPage().items[j].x, y: curPage().items[j].y })), moved: false, clicked: i };
    } else {
      select("item", i);
      drag = { kind: "move", start: pt, orig: { ...curPage().items[i] }, moved: false };
    }
    renderPage(); renderInspector();
  } else if (t.classList.contains("hit")) {
    const kind = t.dataset.kind, i = +t.dataset.i;
    select(kind, i);
    if (kind !== "caption") drag = { kind: "move", start: pt, orig: { ...selObject(false) }, moved: false, text: true };
    renderPage(); renderInspector();
  } else { // empty page: drag a box to select the photos it touches
    drag = { kind: "marquee", start: pt, keep: e.shiftKey || e.metaKey || e.ctrlKey ? selectedItems() : [], moved: false };
    if (!drag.keep.length) select(null);
    renderPage(); renderInspector();
  }
  pageEl().setPointerCapture(e.pointerId);
}

// Turning by mouse: the angle follows the pointer around the thing's center.
function rotateDrag(target, pt) {
  const pg = curPage();
  let obj, key, pivot;
  if (target === "frame") { obj = pg.items[sel.i]; key = "rotation"; pivot = centerOf(obj); }
  else if (target === "image") { obj = pg.items[sel.i].crop; key = "angle"; pivot = centerOf(pg.items[sel.i]); }
  else if (target === "caption") { obj = pg.items[sel.i]; key = "caption_rotation"; pivot = captionPlace(obj).pivot; }
  else if (target === "title") { obj = pg.title; key = "rotation"; pivot = titlePlace(pg).pivot; }
  else { obj = pg.texts[sel.i]; key = "rotation"; pivot = centerOf(obj); }
  return { kind: "rotate", target, start: pt, pivot, a0: Math.atan2(pt.y - pivot.y, pt.x - pivot.x), r0: obj[key] || 0, obj, key, moved: false };
}

function bounds(list) {
  const x0 = Math.min(...list.map(o => o.x)), y0 = Math.min(...list.map(o => o.y));
  const x1 = Math.max(...list.map(o => o.x + o.w)), y1 = Math.max(...list.map(o => o.y + o.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function onPointerMove(e) {
  if (!drag) return;
  const pt = pagePoint(e), dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
  if (!drag.moved && Math.hypot(dx, dy) * scale < 3) return;
  if (!drag.moved && drag.text) selObject(true); // give the title its own geometry
  drag.moved = true;
  if (drag.kind === "group" || drag.kind === "marquee") return moveGroupOrMarquee(e, pt, dx, dy);
  if (drag.kind === "rotate") {
    const a = Math.atan2(pt.y - drag.pivot.y, pt.x - drag.pivot.x);
    const deg = normDeg(snapAngle(drag.r0 + (a - drag.a0) * 180 / Math.PI, e.shiftKey));
    drag.obj[drag.key] = deg;
    if (isItem()) { if (drag.target === "image") normalizeCrop(selItem()); placeItem(pageEl().querySelector(`.item[data-i="${sel.i}"]`), selItem()); }
    renderText(); renderOverlays(); showAngle(pt, deg);
    return;
  }
  const obj = selObject(), s = S(), thr = 6 / scale, lines = [];
  if (drag.kind === "move") {
    let x = drag.orig.x + dx, y = drag.orig.y + dy;
    if (!e.altKey) { // snap the upright outline (the frame itself when it isn't turned)
      const bb = aabb({ x, y, w: obj.w, h: obj.h }, obj.rotation || 0);
      const { xs, ys } = snapTargets();
      const [sx, lx] = snap1([bb.x, bb.x + bb.w / 2, bb.x + bb.w], xs, thr);
      const [sy, ly] = snap1(isItem() ? [bb.y, bb.y + bb.h, bb.y + bb.h + s.caption] : [bb.y, bb.y + bb.h / 2, bb.y + bb.h], ys, thr);
      x += sx; y += sy;
      if (lx != null) lines.push(["x", lx]);
      if (ly != null) lines.push(["y", ly]);
    }
    obj.x = x; obj.y = y;
  } else if (drag.kind === "resize" && drag.orig.rotation) {
    // Turned frame: resize along its own sides, keeping the opposite side where it is.
    const o = drag.orig, H = drag.handle, min = isItem() ? 0.25 : 0.15, deg = o.rotation;
    const v = rotPt({ x: dx, y: dy }, { x: 0, y: 0 }, -deg);
    let x0 = -o.w / 2, x1 = o.w / 2, y0 = -o.h / 2, y1 = o.h / 2;
    if (H.includes("w")) x0 += v.x;
    if (H.includes("e")) x1 += v.x;
    if (H.includes("n")) y0 += v.y;
    if (H.includes("s")) y1 += v.y;
    if (e.shiftKey && H.length === 2) {
      const w = Math.max(min, x1 - x0), hh = w / drag.aspect;
      if (H.includes("n")) y0 = y1 - hh; else y1 = y0 + hh;
    }
    if (x1 - x0 < min) H.includes("w") ? (x0 = x1 - min) : (x1 = x0 + min);
    if (y1 - y0 < min) H.includes("n") ? (y0 = y1 - min) : (y1 = y0 + min);
    const lc = rotPt({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, { x: 0, y: 0 }, deg), oc = centerOf(o);
    const w = x1 - x0, hh = y1 - y0;
    Object.assign(obj, { x: oc.x + lc.x - w / 2, y: oc.y + lc.y - hh / 2, w, h: hh });
  } else if (drag.kind === "resize") {
    const o = drag.orig, H = drag.handle, min = isItem() ? 0.25 : 0.15;
    let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
    if (H.includes("w")) x0 += dx;
    if (H.includes("e")) x1 += dx;
    if (H.includes("n")) y0 += dy;
    if (H.includes("s")) y1 += dy;
    if (!e.altKey) {
      const { xs, ys } = snapTargets();
      const sn = (v, ts, axis) => { const [d, l] = snap1([v], ts, thr); if (l != null) lines.push([axis, l]); return v + d; };
      if (H.includes("w")) x0 = sn(x0, xs, "x");
      if (H.includes("e")) x1 = sn(x1, xs, "x");
      if (H.includes("n")) y0 = sn(y0, ys, "y");
      if (H.includes("s")) {
        const [d, l] = snap1(isItem() ? [y1, y1 + s.caption] : [y1], ys, thr);
        y1 += d; if (l != null) lines.push(["y", l]);
      }
    }
    if (e.shiftKey && H.length === 2) { // keep the frame's shape from a corner
      const w = Math.max(min, x1 - x0), hh = w / drag.aspect;
      if (H.includes("n")) y0 = y1 - hh; else y1 = y0 + hh;
    }
    if (x1 - x0 < min) H.includes("w") ? (x0 = x1 - min) : (x1 = x0 + min);
    if (y1 - y0 < min) H.includes("n") ? (y0 = y1 - min) : (y1 = y0 + min);
    Object.assign(obj, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  } else if (drag.kind === "pan") {
    // The pointer's movement, in the turned/flipped photo's own directions.
    const b = drag.box, cr = obj.crop;
    const v = rotPt({ x: dx, y: dy }, { x: 0, y: 0 }, -((obj.rotation || 0) + (cr.angle || 0)));
    cr.cx = clamp((b.mx - (cr.flip_x ? -v.x : v.x) / b.k) / b.W, 0, 1);
    cr.cy = clamp((b.my - (cr.flip_y ? -v.y : v.y) / b.k) / b.H, 0, 1);
    normalizeCrop(obj);
  }
  if (isItem()) placeItem(pageEl().querySelector(`.item[data-i="${sel.i}"]`), obj);
  renderText();
  renderOverlays();
  drawSnapLines(lines);
}

function moveGroupOrMarquee(e, pt, dx, dy) {
  const pg = curPage(), s = S(), thr = 6 / scale, lines = [];
  if (drag.kind === "marquee") {
    const box = { x: Math.min(pt.x, drag.start.x), y: Math.min(pt.y, drag.start.y), w: Math.abs(dx), h: Math.abs(dy) };
    const touches = o => o.x < box.x + box.w && o.x + o.w > box.x && o.y < box.y + box.h && o.y + o.h > box.y;
    const hits = pg.items.map((it, i) => [itemAabb(it), i]).filter(([o]) => touches(o)).map(([, i]) => i);
    selectItems([...drag.keep, ...hits]);
    renderPage();
    const m = h("div", { className: "ov marquee" });
    Object.assign(m.style, { left: `${box.x * scale}px`, top: `${box.y * scale}px`, width: `${box.w * scale}px`, height: `${box.h * scale}px` });
    pageEl().append(m);
    return;
  }
  // group move: snap the group's outline, then shift every photo by the same amount
  const moved = drag.origs.map(o => itemAabb({ ...pg.items[o.j], x: o.x + dx, y: o.y + dy }));
  let b = bounds(moved), sx = 0, sy = 0;
  if (!e.altKey) {
    const { xs, ys } = snapTargets();
    const [ax, lx] = snap1([b.x, b.x + b.w / 2, b.x + b.w], xs, thr);
    const [ay, ly] = snap1([b.y, b.y + b.h, b.y + b.h + s.caption], ys, thr);
    sx = ax; sy = ay;
    if (lx != null) lines.push(["x", lx]);
    if (ly != null) lines.push(["y", ly]);
  }
  for (const o of drag.origs) { pg.items[o.j].x = o.x + dx + sx; pg.items[o.j].y = o.y + dy + sy; }
  for (const o of drag.origs) placeItem(pageEl().querySelector(`.item[data-i="${o.j}"]`), pg.items[o.j]);
  renderText();
  renderOverlays();
  drawSnapLines(lines);
}

function onPointerUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  drawSnapLines([]);
  pageEl().querySelectorAll(".rot-label").forEach(l => l.remove());
  if (d.kind === "rotate") { if (d.moved) commit(); else renderInspector(); return; }
  if (d.kind === "marquee") { pageEl().querySelectorAll(".marquee").forEach(m => m.remove()); renderPage(); renderInspector(); return; }
  if (d.kind === "group" && !d.moved) { select("item", d.clicked); renderPage(); renderInspector(); return; }
  if (d.kind === "pan" && !d.moved) { cropMode = false; renderOverlays(); renderInspector(); return; }
  if (d.moved) commit(); else renderInspector();
}

function normalizeCrop(it) {
  const b = cropBox(it, photoOf(it));
  it.crop.cx = (b.x + b.cw / 2) / b.W;
  it.crop.cy = (b.y + b.ch / 2) / b.H;
}

function onWheel(e) {
  if (!cropMode || !selItem()) return;
  e.preventDefault();
  const it = selItem(), cr = it.crop, pt = pagePoint(e), b = cropBox(it, photoOf(it)), c = centerOf(it);
  // keep the photo point under the cursor in place while zooming
  const v = rotPt({ x: pt.x - c.x, y: pt.y - c.y }, { x: 0, y: 0 }, -((it.rotation || 0) + (cr.angle || 0)));
  if (cr.flip_x) v.x = -v.x;
  if (cr.flip_y) v.y = -v.y;
  const p = { x: b.mx + v.x / b.k, y: b.my + v.y / b.k };
  cr.zoom = clamp(cr.zoom * Math.exp(-e.deltaY * 0.0025), 1, 8);
  const nb = cropBox(it, photoOf(it));
  cr.cx = (p.x - v.x / nb.k) / nb.W;
  cr.cy = (p.y - v.y / nb.k) / nb.H;
  normalizeCrop(it);
  placeItem(pageEl().querySelector(`.item[data-i="${sel.i}"]`), it);
  renderOverlays();
  const z = $("#zoom"); if (z) z.value = it.crop.zoom;
  clearTimeout(onWheel.t); onWheel.t = setTimeout(commit, 400);
}

function swapPhotos(a, b) {
  const pg = curPage(), A = pg.items[a], B = pg.items[b];
  const keys = ["photo", "caption", "caption_auto", "caption_style", "caption_frame"];
  const take = o => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
  const ta = take(A), tb = take(B);
  keys.forEach(k => { delete A[k]; delete B[k]; });
  Object.assign(A, tb); Object.assign(B, ta);
  A.crop = smartCrop(photoOf(A), A.w / A.h);
  B.crop = smartCrop(photoOf(B), B.w / B.h);
  select("item", b);
  commit();
}

// ---------- inline text editing ----------
function textTarget(kind, i, pg = curPage()) {
  if (kind === "caption") {
    const it = pg.items[i];
    return { get: () => it.caption || "", set: v => { it.caption = v; it.caption_auto = false; }, box: () => captionBox(it), place: () => captionPlace(it), style: () => captionStyle(pg, it) };
  }
  if (kind === "title") return { get: () => pg.title.text || "", set: v => { pg.title.text = v; pg.title.auto = false; }, box: () => titleBox(pg), place: () => titlePlace(pg), style: () => styleFor("title", pg.title.style) };
  const t = pg.texts[i];
  return { get: () => t.text || "", set: v => { t.text = v; }, box: () => t, place: () => textPlace(t), style: () => styleFor("text", t.style) };
}

function startEditing(kind, i) {
  stopEditing();
  select(kind, i);
  const session = editing = { kind, i };
  const tt = textTarget(kind, i), st = tt.style(), fo = kind === "caption" ? captionFrame(curPage(), curPage().items[i]) : frameTarget(kind, i)?.frame;
  const b = hasFrame(fo) ? frameInner(tt.box(), fo) : tt.box();
  const area = h("textarea", { className: "tb-editor", value: tt.get(), spellcheck: true });
  Object.assign(area.style, { left: `${b.x * scale}px`, top: `${b.y * scale}px`, width: `${b.w * scale}px`,
    height: `${Math.max(b.h * scale, st.size / 72 * scale * LINE_HEIGHT + 4)}px`, fontFamily: `"${st.font}"`, fontWeight: st.weight,
    fontSize: `${st.size / 72 * scale}px`, lineHeight: LINE_HEIGHT, textAlign: st.align, color: st.color });
  const pl = tt.place();
  if (pl.deg) Object.assign(area.style, { transformOrigin: `${(pl.pivot.x - b.x) * scale}px ${(pl.pivot.y - b.y) * scale}px`, transform: `rotate(${pl.deg}deg)` });
  area.oninput = () => { tt.set(area.value); const ins = $("#text-value"); if (ins) ins.value = area.value; scheduleSpellcheck(); };
  area.onkeydown = e => {
    if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey && kind === "caption")) { e.preventDefault(); stopEditing(); }
    else if (e.key === "Tab" && kind === "caption") { // jump to the next/previous caption
      e.preventDefault();
      const items = curPage().items, n = items.length;
      let next = i;
      do next = (next + (e.shiftKey ? -1 : 1) + n) % n; while (next !== i && !showsCaption(items[next]));
      stopEditing(); startEditing("caption", next);
    }
  };
  // Only end this session: Tab to the next caption removes this box and starts a new one.
  area.onblur = () => setTimeout(() => { if (editing === session && document.activeElement !== area) stopEditing(); }, 0);
  renderPage(); renderInspector();
  pageEl().append(area);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

function stopEditing() {
  if (!editing) return;
  editing = null;
  pageEl().querySelectorAll(".tb-editor").forEach(e => e.remove());
  commit();
}

function addTextBox() {
  const pg = curPage(), s = S();
  pg.texts.push({ text: "", x: s.page / 2 - 1.5, y: s.page / 2 - 0.3, w: 3, h: 0.6 });
  startEditing("text", pg.texts.length - 1);
}

function onDoubleClick(pt) {
  const pg = curPage();
  for (let i = (pg.texts || []).length - 1; i >= 0; i--) if (inPlace(pt, textPlace(pg.texts[i]))) return startEditing("text", i);
  for (let i = pg.items.length - 1; i >= 0; i--) if (showsCaption(pg.items[i]) && inPlace(pt, captionPlace(pg.items[i]))) return startEditing("caption", i);
  for (let i = pg.items.length - 1; i >= 0; i--) {
    if (inPlace(pt, itemPlace(pg.items[i]))) { select("item", i); cropMode = true; renderPage(); renderInspector(); return; }
  }
  if (inPlace(pt, titlePlace(pg))) return startEditing("title", 0);
}

function setupStage() {
  const el = pageEl();
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerUp);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("dragover", e => {
    e.preventDefault();
    el.querySelectorAll(".item").forEach(i => i.classList.toggle("swap-target", i === e.target));
    el.classList.toggle("drop-over", !e.target.classList.contains("item"));
  });
  el.addEventListener("dragleave", e => { if (e.target === el) el.classList.remove("drop-over"); });
  el.addEventListener("drop", e => {
    e.preventDefault();
    el.classList.remove("drop-over");
    const pid = e.dataTransfer.getData("text/photo");
    if (!pid) return;
    const pt = pagePoint(e);
    placeFromTray(pid, pt.x, pt.y, e.target.classList.contains("item") ? +e.target.dataset.i : null);
  });
  $("#stage").addEventListener("pointerdown", e => { if (e.target.id === "stage") { stopEditing(); select(null); renderPage(); renderInspector(); } });
  window.addEventListener("resize", () => book && renderPage());
}

// ---------- inspector ----------
function numField(label, value, onchange, { step = 0.01, min = 0, max = 99 } = {}) {
  const input = h("input", { type: "number", step, min, max, value: round2(value) });
  input.onchange = () => { const v = parseFloat(input.value); if (!isNaN(v)) onchange(clamp(v, min, max)); };
  return h("label", {}, label, input);
}

function renderInspector() {
  const box = $("#inspector");
  let content;
  if (!sel) content = pageInspector();
  else if (sel.kind === "items") content = multiInspector(sel.list);
  else if (sel.kind === "item") { const [photo, ...rest] = photoInspector(selItem()); content = [photo, captionSection(sel.i), ...rest]; }
  else content = textInspector(sel.kind, sel.i);
  box.replaceChildren(...content.filter(Boolean));
}

function styleControls(role, getOwn, setOwn, base = () => ({})) {
  const st = styleFor(role, { ...base(), ...(getOwn() || {}) });
  const change = (k, v) => { setOwn({ ...(getOwn() || {}), [k]: v }); commit(); };
  const font = h("select", {}, ...Object.entries(FONTS).map(([n, f]) => h("option", { value: n, selected: n === st.font, style: `font-family:"${n}"` }, `${n} (${f.kind.toLowerCase()})`)));
  font.onchange = () => change("font", font.value);
  const size = h("input", { type: "number", min: 4, max: 96, step: 0.5, value: st.size });
  size.onchange = () => change("size", clamp(parseFloat(size.value) || st.size, 4, 96));
  const color = h("input", { type: "color", value: st.color });
  color.onchange = () => change("color", color.value);
  const bold = btn("B", () => change("weight", st.weight >= 600 ? 400 : 700), "mini" + (st.weight >= 600 ? " on" : ""), hasBold(st.font) ? "Bold" : "This font has no bold");
  bold.disabled = !hasBold(st.font);
  const align = ["left", "center", "right"].map(a => btn({ left: "⟸", center: "≡", right: "⟹" }[a], () => change("align", a), "mini" + (st.align === a ? " on" : ""), `Align ${a}`));
  const valign = role === "caption" ? null : h("div", { className: "btn-row seg" }, ...["top", "middle", "bottom"].map(v =>
    btn({ top: "Top", middle: "Middle", bottom: "Bottom" }[v], () => change("valign", v), "mini" + (st.valign === v ? " on" : ""))));
  const name = { title: "titles", caption: "captions", text: "text boxes" }[role];
  return h("div", { className: "style-controls" },
    h("div", { className: "field" }, h("span", {}, "Font"), font),
    h("div", { className: "field" }, h("span", {}, "Size (pt)"), size),
    h("div", { className: "field" }, h("span", {}, "Color"), color),
    h("div", { className: "btn-row seg" }, bold, ...align),
    valign,
    role === "caption" ? captionScopeButtons("caption_style", "style") : h("div", { className: "btn-col", style: "margin-top:8px" },
      btn(`Use this style for all ${name}`, () => {
        S().styles[role] = { ...S().styles[role], ...(getOwn() || {}) };
        for (const pg of book.pages) {
          if (role === "caption") pg.items.forEach(it => delete it.caption_style);
          if (role === "title" && pg.title) delete pg.title.style;
          if (role === "text") (pg.texts || []).forEach(t => delete t.style);
        }
        commit();
      }, "", `Make this the book's ${role} style and apply it everywhere`)));
}

function textEditorField(kind, i, rows = 2) {
  const tt = textTarget(kind, i);
  const area = h("textarea", { id: "text-value", rows, value: tt.get(), placeholder: kind === "caption" ? "What's happening here?" : "Type here…" });
  area.oninput = () => { tt.set(area.value); renderText(); renderOverlays(); scheduleSpellcheck(); };
  area.onchange = commit;
  return area;
}

function angleField(value, onchange, title = "Degrees, clockwise") {
  const input = h("input", { type: "number", step: 1, min: -360, max: 360, value: round1(value || 0), title });
  input.onchange = () => { const v = parseFloat(input.value); if (!isNaN(v)) onchange(normDeg(v)); };
  return input;
}

function captionTurnControls(it) {
  const follow = h("input", { type: "checkbox", checked: !it.caption_free });
  follow.onchange = () => { if (follow.checked) delete it.caption_free; else it.caption_free = true; commit(); };
  return h("div", { className: "caption-turn" },
    h("label", { className: "toggle caption-toggle" }, follow, "Turn the caption with the photo"),
    it.caption_free ? h("div", { className: "field" }, h("span", {}, "Caption angle (°)"),
      angleField(it.caption_rotation, v => { it.caption_rotation = v; commit(); })) : null);
}

function rotateSection(label, obj, key = "rotation", note = "Or drag the round handle above it. Hold Shift for 15° steps.") {
  const set = v => { obj[key] = v; commit(); };
  return h("section", {}, h("h3", {}, label),
    h("div", { className: "field" }, h("span", {}, "Angle (°)"), angleField(obj[key], set)),
    h("div", { className: "btn-row" },
      btn("⟲ 90°", () => set(normDeg((obj[key] || 0) - 90))), btn("⟳ 90°", () => set(normDeg((obj[key] || 0) + 90))), btn("Level", () => set(0))),
    h("p", { className: "note" }, note));
}

function captionToggle(it) {
  const box = h("input", { type: "checkbox", checked: showsCaption(it) });
  box.onchange = () => { if (box.checked) delete it.caption_off; else it.caption_off = true; commit(); };
  return h("label", { className: "toggle caption-toggle" }, box, "Show a caption under this photo");
}

function captionSection(i) {
  const it = curPage().items[i];
  if (!showsCaption(it)) {
    return h("section", {}, h("h3", {}, "Caption"), captionToggle(it),
      h("p", { className: "note" }, it.caption?.trim()
        ? `Hidden for this photo (its text, "${it.caption.trim()}", is kept if you turn it back on).`
        : "Hidden for this photo — handy when one text box describes a group of photos."));
  }
  return h("section", {}, h("h3", {}, "Caption"),
    captionToggle(it),
    textEditorField("caption", i),
    spellingHints("caption", i),
    h("p", { className: "note" }, "Or double-click the space under the photo to type there. Tab jumps to the next caption."),
    captionTurnControls(it),
    h("details", {}, h("summary", { className: "small" }, "Caption style & box"),
      styleControls("caption", () => it.caption_style, v => { it.caption_style = v; }, () => curPage().caption_style || {}),
      frameSection("caption", i)));
}

function textInspector(kind, i) {
  const pg = curPage();
  const heading = { caption: "Caption", title: `Page ${pageIx + 1} title`, text: "Text box" }[kind];
  const own = kind === "caption" ? [() => pg.items[i].caption_style, v => { pg.items[i].caption_style = v; }, () => pg.caption_style || {}]
    : kind === "title" ? [() => pg.title.style, v => { pg.title.style = v; }]
    : [() => pg.texts[i].style, v => { pg.texts[i].style = v; }];
  const extra = [];
  if (kind === "title") {
    extra.push(btn("Suggest a title", () => suggestText({ pages: [pageIx], titles: true, captions: false, overwrite: true })));
    if (pg.title.x != null) extra.push(btn("Put back in the title area", () => { ["x", "y", "w", "h"].forEach(k => delete pg.title[k]); commit(); }));
  }
  if (kind === "caption") {
    extra.push(btn("Select the photo", () => { select("item", i); renderPage(); renderInspector(); }));
    extra.push(btn("Hide this caption", () => { pg.items[i].caption_off = true; select("item", i); commit(); }, "",
      "No caption under this photo (e.g. when one text box covers a group). The text is kept."));
  }
  if (kind === "text") extra.push(btn("Delete text box", () => { pg.texts.splice(i, 1); select(null); commit(); }, "danger"));
  return [
    h("section", {}, h("h3", {}, heading), textEditorField(kind, i, kind === "caption" ? 2 : 3), spellingHints(kind, i),
      h("div", { className: "btn-col", style: "margin-top:8px" }, btn("Edit on the page", () => startEditing(kind, i)), ...extra)),
    kind === "caption" ? h("section", {}, h("h3", {}, "Turn"), captionTurnControls(pg.items[i]))
      : rotateSection("Rotate", kind === "title" ? pg.title : pg.texts[i]),
    h("section", {}, h("h3", {}, "Style"), styleControls(kind, ...own)),
    frameSection(kind, i),
  ];
}

// The photo whose caption is being styled: a selected caption, or a selected photo.
function captionItem() {
  return sel && (sel.kind === "caption" || sel.kind === "item") ? curPage().items[sel.i] : null;
}

// "Use for every caption on this page / in the book": moves this caption's look (its own
// settings on top of the page's) up a level and clears the overrides below it.
// key: "caption_style" or "caption_frame".
function captionScopeButtons(key, what) {
  const pg = curPage(), it = captionItem();
  if (!it) return null;
  const merged = () => ({ ...(pg[key] || {}), ...(it[key] || {}) });
  const toPage = () => {
    pg[key] = merged();
    pg.items.forEach(x => delete x[key]);
    commit();
  };
  const toBook = () => {
    const m = merged(), s = S();
    if (key === "caption_style") s.styles.caption = { ...s.styles.caption, ...m };
    else s.caption_frame = m;
    for (const p of book.pages) { delete p[key]; p.items.forEach(x => delete x[key]); }
    for (const m2 of Object.values(book.caption_memory || {})) delete m2[key];
    commit();
  };
  const reset = () => { delete it[key]; commit(); };
  const own = it[key] && Object.keys(it[key]).length;
  return h("div", { className: "btn-col", style: "margin-top:8px" },
    h("div", { className: "small muted" }, `Changes above are for this photo's caption only. To share this ${what}:`),
    btn(`Use for every caption on this page`, toPage, "", `Every caption on page ${pageIx + 1} gets this ${what}`),
    btn(`Use for every caption in the book`, toBook, "", `Every caption in the book gets this ${what}, including photos added later`),
    own ? btn(`Match the rest of the page again`, reset, "", `Drop this photo's own ${what} and use the page's/book's`) : null);
}

// Fill and border behind a text box, title or caption.
function frameSection(kind, i) {
  const pg = curPage();
  const isCap = kind === "caption", it = isCap ? pg.items[i] : null;
  // obj.frame is what this control edits; for a caption that's the photo's own caption_frame.
  const obj = isCap ? { get frame() { return it.caption_frame; }, set frame(v) { if (v === undefined) delete it.caption_frame; else it.caption_frame = v; } }
    : frameTarget(kind, i);
  const effective = isCap ? captionFrame(pg, it) : obj.frame;
  const f = { ...(isCap ? CAPTION_FRAME_DEFAULT : FRAME_DEFAULT), ...(effective || {}) };
  const save = (patch, live) => {
    obj.frame = { ...f, ...(obj.frame || {}), ...patch };
    // A caption keeps an "off" setting so it can differ from the page's/book's box.
    if (!hasFrame(obj.frame) && !(isCap && (hasFrame(pg.caption_frame) || hasFrame(S().caption_frame)))) obj.frame = undefined;
    if (live) { renderText(); renderOverlays(); } else commit();
  };
  const on = effective || {};
  const fillOn = h("input", { type: "checkbox", checked: !!on.fill });
  fillOn.onchange = () => save({ fill: fillOn.checked ? fillColor.value : null });
  const fillColor = h("input", { type: "color", value: on.fill || f.fill || FRAME_DEFAULT.fill });
  fillColor.oninput = () => save({ fill: fillColor.value }, true);
  fillColor.onchange = () => save({ fill: fillColor.value });
  const opacity = h("input", { type: "range", min: 10, max: 100, step: 5, value: Math.round((f.opacity ?? 1) * 100) });
  const opLabel = h("span", {}, `See-through: ${100 - opacity.value}%`);
  opacity.oninput = () => { opLabel.textContent = `See-through: ${100 - opacity.value}%`; if (on.fill) save({ opacity: opacity.value / 100 }, true); };
  opacity.onchange = () => { if (on.fill) save({ opacity: opacity.value / 100 }); else f.opacity = opacity.value / 100; };
  const borderOn = h("input", { type: "checkbox", checked: !!on.border });
  const borderColor = h("input", { type: "color", value: on.border || "#7a6a58" });
  borderOn.onchange = () => save({ border: borderOn.checked ? borderColor.value : null, width: f.width || 1.5 });
  borderColor.oninput = () => { if (on.border) save({ border: borderColor.value }, true); };
  borderColor.onchange = () => { if (on.border) save({ border: borderColor.value }); else save({ border: borderColor.value, width: f.width || 1.5 }); };
  const num = (key, min, max, step, scaleBy = 1) => {
    const input = h("input", { type: "number", min, max, step, value: round1((f[key] ?? 0) * scaleBy * 10) / 10 });
    input.onchange = () => { const v = parseFloat(input.value); if (!isNaN(v)) save({ [key]: clamp(v, min, max) / scaleBy }); };
    return input;
  };
  const name = kind === "title" ? "titles" : "text boxes";
  const hug = h("input", { type: "checkbox", checked: !!f.hug });
  hug.onchange = () => save({ hug: hug.checked });
  return h("section", {}, h("h3", {}, isCap ? "Caption box" : "Box"),
    h("label", { className: "toggle" }, fillOn, "Solid background"),
    h("div", { className: "field" }, h("span", {}, "Fill color"), fillColor),
    h("div", { className: "field col" }, opLabel, opacity),
    h("label", { className: "toggle", style: "margin-top:8px" }, borderOn, "Border"),
    h("div", { className: "field" }, h("span", {}, "Border color"), borderColor),
    h("div", { className: "field" }, h("span", {}, "Border width (pt)"), num("width", 0.25, 12, 0.25)),
    h("div", { className: "field" }, h("span", {}, "Rounded corners (pt)"), num("radius", 0, 36, 1, 72)),
    h("div", { className: "field" }, h("span", {}, "Space inside (pt)"), num("pad", 0, 36, 1, 72)),
    h("label", { className: "toggle" }, hug, "Shrink the box to fit the text"),
    isCap ? captionScopeButtons("caption_frame", "box")
    : hasFrame(obj.frame) ? h("div", { className: "btn-col", style: "margin-top:8px" },
      btn(`Use this box for all ${name}`, () => {
        for (const pg of book.pages) {
          if (kind === "title" && pg.title) pg.title.frame = { ...obj.frame };
          if (kind === "text") (pg.texts || []).forEach(t => { t.frame = { ...obj.frame }; });
        }
        commit();
      }, "", `Give every ${kind === "title" ? "page title" : "text box"} in the book this fill and border`),
      btn("Remove box", () => { delete obj.frame; commit(); })) : null,
    h("p", { className: "note" }, isCap ? "The caption stays in the space under its photo. If the text gets small, use less space inside or raise the caption strip under Book layout."
      : "The text stays inside the box. Make the box bigger with its handles if the text gets small."));
}

// ---------- several photos selected ----------
function removeManyToTray(list) {
  const pg = curPage();
  for (const i of [...list].sort((a, b) => b - a)) {
    const [it] = pg.items.splice(i, 1);
    remember(it);
    book.unplaced.unshift(it.photo);
  }
  select(null);
  commit();
}

// Give each photo a new size; if its shape changes, re-crop so faces stay in frame.
function resizeKeepingFaces(it, w, hgt) {
  const reshaped = Math.abs(w / hgt - it.w / it.h) > 0.01;
  it.w = w; it.h = hgt;
  if (reshaped) it.crop = autoCrop(it);
}

function alignItems(list, how) { // by each photo's upright outline, so turned photos line up visibly
  const items = list.map(i => curPage().items[i]), b = bounds(items.map(itemAabb));
  for (const it of items) {
    const bb = itemAabb(it);
    if (how === "left") it.x += b.x - bb.x;
    if (how === "right") it.x += b.x + b.w - (bb.x + bb.w);
    if (how === "hcenter") it.x += b.x + b.w / 2 - (bb.x + bb.w / 2);
    if (how === "top") it.y += b.y - bb.y;
    if (how === "bottom") it.y += b.y + b.h - (bb.y + bb.h);
    if (how === "vcenter") it.y += b.y + b.h / 2 - (bb.y + bb.h / 2);
  }
  commit();
}

function matchSize(list, which) {
  const pg = curPage(), ref = pg.items[list[0]];
  for (const i of list.slice(1)) {
    const it = pg.items[i];
    resizeKeepingFaces(it, which === "height" ? it.w : ref.w, which === "width" ? it.h : ref.h);
  }
  commit();
}

// Equal space between neighbors, keeping the two outermost photos where they are.
function distribute(list, axis) {
  const pg = curPage(), [pos, size] = axis === "x" ? ["x", "w"] : ["y", "h"];
  const items = list.map(i => ({ it: pg.items[i], bb: itemAabb(pg.items[i]) })).sort((a, b) => a.bb[pos] - b.bb[pos]);
  const start = items[0].bb[pos], end = Math.max(...items.map(o => o.bb[pos] + o.bb[size]));
  const gap = (end - start - items.reduce((t, o) => t + o.bb[size], 0)) / (items.length - 1);
  let at = start;
  for (const { it, bb } of items) { it[pos] += at - bb[pos]; at += bb[size] + gap; }
  commit();
}

function pack(list, axis) {
  const pg = curPage(), s = S(), [pos, size] = axis === "x" ? ["x", "w"] : ["y", "h"];
  const items = list.map(i => ({ it: pg.items[i], bb: itemAabb(pg.items[i]) })).sort((a, b) => a.bb[pos] - b.bb[pos]);
  const step = axis === "x" ? s.gap : s.gap + s.caption;
  let at = items[0].bb[pos];
  for (const { it, bb } of items) {
    it[pos] += at - bb[pos];
    at += bb[size] + (axis === "y" && !showsCaption(it) ? s.gap : step);
  }
  commit();
}

function multiInspector(list) {
  const pg = curPage(), items = list.map(i => pg.items[i]);
  const on = items.filter(showsCaption).length;
  const capBox = h("input", { type: "checkbox", checked: on === items.length });
  capBox.indeterminate = on > 0 && on < items.length;
  capBox.onchange = () => { for (const it of items) { if (capBox.checked) delete it.caption_off; else it.caption_off = true; } commit(); };
  const icon = (label, fn, title) => btn(label, fn, "mini align-btn", title);
  const move = h("select", {}, h("option", { value: "" }, "Move to page…"),
    ...book.pages.map((_, i) => h("option", { value: i, disabled: i === pageIx }, `Page ${i + 1}`)),
    h("option", { value: "new" }, "New page"));
  move.onchange = () => {
    if (move.value === "") return;
    const moving = [...list].sort((a, b) => b - a).map(i => pg.items.splice(i, 1)[0]).reverse();
    if (move.value === "new") book.pages.push(blankPage(pg));
    const dest = move.value === "new" ? book.pages.length - 1 : +move.value;
    const first = book.pages[dest].items.length;
    book.pages[dest].items.push(...moving);
    pageIx = dest; selectItems(moving.map((_, k) => first + k));
    commit();
  };
  const ref = pg.items[list[0]];
  return [
    h("section", {}, h("h3", {}, `${list.length} photos selected`),
      h("div", { className: "multi-thumbs" }, ...items.slice(0, 12).map(it => h("i", { style: `background-image:url(${thumbUrl(it.photo)})` }))),
      h("p", { className: "note" }, `Shift-click (or ${MOD.replace("+", "")}-click) a photo to add or remove it. Drag any selected photo to move them all.`)),
    h("section", {}, h("h3", {}, "Captions"),
      h("label", { className: "toggle caption-toggle" }, capBox, "Show captions under these photos"),
      capBox.indeterminate ? h("p", { className: "note" }, `${on} of ${items.length} currently show a caption.`) : null,
      h("div", { className: "btn-col", style: "margin-top:6px" }, btn("Give them the first one's caption style & box", () => {
        const [first, ...rest] = items;
        for (const it of rest) for (const k of ["caption_style", "caption_frame"]) {
          if (first[k]) it[k] = JSON.parse(JSON.stringify(first[k])); else delete it[k];
        }
        commit();
      }, "", "Font, size, color and caption box, copied from the first photo you picked"))),
    h("section", {}, h("h3", {}, "Align"),
      h("div", { className: "align-grid" },
        icon("⇤ Left", () => alignItems(list, "left"), "Line up left edges"),
        icon("↔ Center", () => alignItems(list, "hcenter"), "Line up centers (across)"),
        icon("Right ⇥", () => alignItems(list, "right"), "Line up right edges"),
        icon("⤒ Top", () => alignItems(list, "top"), "Line up top edges"),
        icon("↕ Middle", () => alignItems(list, "vcenter"), "Line up middles (up and down)"),
        icon("⤓ Bottom", () => alignItems(list, "bottom"), "Line up bottom edges"))),
    h("section", {}, h("h3", {}, "Same size"),
      h("div", { className: "btn-row" },
        btn("Width", () => matchSize(list, "width")), btn("Height", () => matchSize(list, "height")), btn("Both", () => matchSize(list, "size"))),
      h("p", { className: "note" }, `Matches the first photo you selected (${round2(ref.w)}″ × ${round2(ref.h)}″). Faces stay in frame.`)),
    h("section", {}, h("h3", {}, "Rotate"),
      h("div", { className: "btn-col" },
        btn(`Same angle as the first (${round1(ref.rotation || 0)}°)`, () => { for (const it of items) it.rotation = ref.rotation || 0; commit(); }),
        h("div", { className: "field" }, h("span", {}, "Set all to (°)"),
          angleField(items.every(it => (it.rotation || 0) === (ref.rotation || 0)) ? ref.rotation : 0, v => { for (const it of items) it.rotation = v; commit(); })),
        h("div", { className: "btn-row" },
          btn("⟲ 90°", () => { for (const it of items) it.rotation = normDeg((it.rotation || 0) - 90); commit(); }),
          btn("⟳ 90°", () => { for (const it of items) it.rotation = normDeg((it.rotation || 0) + 90); commit(); }),
          btn("Level all", () => { for (const it of items) it.rotation = 0; commit(); })))),
    h("section", {}, h("h3", {}, "Spacing"),
      h("div", { className: "btn-col" },
        h("div", { className: "btn-row" },
          btn("Spread across", () => distribute(list, "x"), "", "Equal space between them, left to right"),
          btn("Spread down", () => distribute(list, "y"), "", "Equal space between them, top to bottom")),
        h("div", { className: "btn-row" },
          btn("Pack in a row", () => pack(list, "x"), "", "Side by side with the book's gap"),
          btn("Pack in a column", () => pack(list, "y"), "", "Stacked with the book's gap and caption strip"))),
      list.length < 3 ? h("p", { className: "note" }, "Spreading evenly needs 3 or more photos.") : null),
    h("section", {}, h("h3", {}, "Arrange"),
      h("div", { className: "btn-col" },
        btn("Auto-crop all", () => { for (const it of items) it.crop = autoCrop(it); commit(); }),
        h("div", { className: "btn-row" },
          btn("To front", () => {
            const keep = pg.items.filter((_, i) => !list.includes(i));
            pg.items.splice(0, pg.items.length, ...keep, ...items);
            selectItems(items.map((_, k) => keep.length + k)); commit();
          }),
          btn("To back", () => {
            const keep = pg.items.filter((_, i) => !list.includes(i));
            pg.items.splice(0, pg.items.length, ...items, ...keep);
            selectItems(items.map((_, k) => k)); commit();
          })),
        move,
        btn("Remove all to tray", () => removeManyToTray(list), "danger"))),
  ];
}

function photoInspector(it) {
  const ph = photoOf(it), b = cropBox(it, ph);
  const zoom = h("input", { type: "range", id: "zoom", min: 1, max: 5, step: 0.01, value: it.crop.zoom });
  zoom.oninput = () => { it.crop.zoom = +zoom.value; normalizeCrop(it); placeItem(pageEl().querySelector(`.item[data-i="${sel.i}"]`), it); renderOverlays(); };
  zoom.onchange = commit;
  const set = (k, v) => { it[k] = v; commit(); };
  const ppi = Math.round(b.cw / b.bw);
  const cr = it.crop;
  const liveImg = () => { normalizeCrop(it); placeItem(pageEl().querySelector(`.item[data-i="${sel.i}"]`), it); renderOverlays(); };
  const turnNum = angleField(cr.angle, v => { cr.angle = v; normalizeCrop(it); commit(); }, "Turn the photo inside its frame (degrees)");
  const turn = h("input", { type: "range", min: -45, max: 45, step: 0.5, value: clamp(cr.angle || 0, -45, 45) });
  turn.oninput = () => { cr.angle = +turn.value; turnNum.value = turn.value; liveImg(); };
  turn.onchange = commit;
  const turnImg = d => { cr.angle = normDeg((cr.angle || 0) + d); normalizeCrop(it); commit(); };
  const flip = key => { if (cr[key]) delete cr[key]; else cr[key] = true; commit(); };
  const move = h("select", {}, h("option", { value: "" }, "Move to page…"),
    ...book.pages.map((_, i) => h("option", { value: i, disabled: i === pageIx }, `Page ${i + 1}`)),
    h("option", { value: "new" }, "New page"));
  move.onchange = () => {
    if (move.value === "") return;
    const [moved] = curPage().items.splice(sel.i, 1);
    if (move.value === "new") book.pages.push(blankPage(curPage()));
    const dest = move.value === "new" ? book.pages.length - 1 : +move.value;
    book.pages[dest].items.push(moved);
    pageIx = dest; select("item", book.pages[dest].items.length - 1);
    commit();
  };
  const taken = ph.taken ? new Date(ph.taken).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
  const where = ph.place ? [ph.place.poi, ph.place.town, ph.place.state].filter(Boolean).join(", ") : "";
  return [
    h("section", {}, h("h3", {}, "Photo"),
      h("div", { className: "photo-preview", style: `background-image:url(${thumbUrl(it.photo)})` }),
      h("div", { className: "small" }, h("b", {}, ph.name)),
      h("div", { className: "small muted" }, [taken, where].filter(Boolean).join(" · ")),
      h("div", { className: "small " + (ppi < 150 ? "warn" : "muted") }, `${ph.faces} face${ph.faces === 1 ? "" : "s"} found · sharpness ${ppi} px/in ${ppi < 150 ? "(may look soft)" : ppi < 250 ? "(fine)" : "(great)"}`)),
    h("section", {}, h("h3", {}, "Crop"),
      h("div", { className: "btn-col" },
        btn(cropMode ? "Done adjusting" : "Adjust crop…", () => { cropMode = !cropMode; renderOverlays(); renderInspector(); }, cropMode ? "primary" : ""),
        h("label", { className: "small muted" }, "Zoom", zoom),
        h("div", { className: "btn-row" },
          btn("Auto-crop", () => { it.crop = autoCrop(it); commit(); }),
          btn("Whole photo", () => {
            const cxm = it.x + it.w / 2; it.w = it.h * (ph.w / ph.h); it.x = cxm - it.w / 2;
            it.crop = { zoom: 1, cx: .5, cy: .5, ...(cr.flip_x ? { flip_x: true } : {}), ...(cr.flip_y ? { flip_y: true } : {}) }; commit();
          })),
        h("label", { className: "small muted" }, "Turn the photo inside its frame", turn),
        h("div", { className: "field" }, h("span", {}, "Photo angle (°)"), turnNum),
        h("div", { className: "btn-row" },
          btn("⟲ 90°", () => turnImg(-90), "", "Turn the photo a quarter turn left inside its frame"),
          btn("⟳ 90°", () => turnImg(90), "", "Turn the photo a quarter turn right inside its frame")),
        h("div", { className: "btn-row" },
          btn("Flip ↔", () => flip("flip_x"), cr.flip_x ? "on" : "", "Mirror left to right"),
          btn("Flip ↕", () => flip("flip_y"), cr.flip_y ? "on" : "", "Mirror top to bottom")),
        (cr.angle || cr.flip_x || cr.flip_y) ? btn("Straighten & unflip", () => { delete cr.angle; delete cr.flip_x; delete cr.flip_y; normalizeCrop(it); commit(); }) : null),
      h("p", { className: "note" }, cropMode ? "Drag to slide the photo, scroll to zoom, drag the round handle to turn it. Click outside or press Esc when done." : "Double-click a photo to adjust its crop. Auto-crop keeps faces in frame. Turning the photo zooms in just enough to hide the corners.")),
    rotateSection("Rotate frame", it, "rotation", "Turns the photo, its frame and (unless set otherwise) its caption. Drag the round handle above the photo; hold Shift for 15° steps."),
    h("section", {}, h("h3", {}, "Position & size (inches)"),
      h("div", { className: "fields-2" },
        numField("X", it.x, v => set("x", v)), numField("Y", it.y, v => set("y", v)),
        numField("W", it.w, v => set("w", Math.max(0.25, v))), numField("H", it.h, v => set("h", Math.max(0.25, v))))),
    h("section", {}, h("h3", {}, "Arrange"),
      h("div", { className: "btn-col" },
        h("div", { className: "btn-row" },
          btn("To front", () => { const pg = curPage(); pg.items.push(pg.items.splice(sel.i, 1)[0]); select("item", pg.items.length - 1); commit(); }),
          btn("To back", () => { const pg = curPage(); pg.items.unshift(pg.items.splice(sel.i, 1)[0]); select("item", 0); commit(); })),
        btn(swapMode ? "Click another photo… (cancel)" : "Swap with another photo", () => { swapMode = !swapMode; renderInspector(); }, swapMode ? "primary" : ""),
        move,
        btn("Remove to tray", () => removeToTray(), "danger"))),
  ];
}

function monthBackground(pg) {
  const months = {};
  for (const it of pg.items) {
    const t = book.photos[it.photo]?.taken;
    if (t) { const m = new Date(t).getMonth() + 1; months[m] = (months[m] || 0) + 1; }
  }
  const m = Object.entries(months).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!m) return null;
  const prefix = `month-${String(m).padStart(2, "0")}`;
  const options = backgrounds.shared.filter(n => n.startsWith(prefix));
  const designed = options.filter(n => !n.includes("-photo-")); // designed ones are quieter behind 20 photos
  return designed.find(n => !/^month-\d\d-\d-/.test(n)) || designed[0] || options[0] || null; // month-NN-2-* are second choices
}

// Shared backgrounds, grouped by file-name prefix for the side panel and the new-book menu.
const BG_GROUPS = [["Monthly themes", "month-"], ["Patterns", "pattern-"], ["Watercolor", "wash-"],
  ["Occasions & trips", "occasion-"], ["Paper & maps", "paper-"], ["Paper & maps", "topo-"]];
function bgGroups(names) {
  const out = new Map();
  for (const n of names) {
    const g = BG_GROUPS.find(([, p]) => n.startsWith(p))?.[0] || "More";
    if (!out.has(g)) out.set(g, []);
    out.get(g).push(n);
  }
  const order = [...new Set(BG_GROUPS.map(g => g[0])), "More"];
  return [...out].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function bgLabel(n) {
  const m = n.match(/^month-(\d\d)-(?:\d-)?/);
  const rest = n.replace(/^(month-\d\d-(\d-)?|pattern-|wash-|occasion-|paper-|topo-)/, "").replace(/\.[a-z]+$/i, "").replace(/-/g, " ");
  return (m ? `${MONTHS[+m[1]]}: ` : n.startsWith("topo-") ? "map " : "") + rest;
}

function pageInspector() {
  const pg = curPage(), s = S();
  const swatch = (name, label) => {
    const el = h("div", { className: "bg-swatch" + (name ? "" : " plain") + ((pg.background || null) === name ? " active" : ""), title: label });
    if (name) el.style.backgroundImage = `url(${bgUrl(name, true)})`;
    else el.style.backgroundColor = pg.color || "#fff";
    el.onclick = () => { pg.background = name; commit(); };
    return el;
  };
  const color = h("input", { type: "color", value: pg.color || "#ffffff" });
  color.oninput = () => { pg.background = null; pg.color = color.value; renderPage(); };
  color.onchange = commit;
  const upload = h("label", { className: "file-btn", textContent: "Upload background…" }, h("input", { type: "file", accept: "image/*,.heic" }));
  $("input", upload).onchange = async ev => {
    const f = ev.target.files[0];
    if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    const { name } = await api("POST", `/api/projects/${slug}/backgrounds`, fd);
    backgrounds = await api("GET", `/api/projects/${slug}/backgrounds`);
    pg.background = name;
    commit();
  };
  const setting = (label, key, opts) => {
    const input = h("input", { type: "number", step: opts?.step ?? 0.01, min: opts?.min ?? 0, max: opts?.max ?? 4, value: s[key] });
    input.onchange = () => { const v = parseFloat(input.value); if (!isNaN(v)) { s[key] = opts?.int ? Math.round(v) : v; commit(); } };
    return h("div", { className: "field" }, h("span", {}, label), input);
  };
  const borderColor = h("input", { type: "color", value: frameColor(pg) });
  borderColor.oninput = () => { pg.border_color = borderColor.value; renderPage(); };
  borderColor.onchange = commit;
  const frameEverywhere = () => {
    s.border_color = frameColor(pg); // new pages get it too
    for (const p of book.pages) p.border_color = s.border_color;
    commit();
  };
  const movePage = d => { const j = pageIx + d; if (j < 0 || j >= book.pages.length) return; [book.pages[pageIx], book.pages[j]] = [book.pages[j], book.pages[pageIx]]; pageIx = j; commit(); };
  const groups = bgGroups(backgrounds.shared);
  const thisMonth = monthBackground(pg);
  const emptyCaptions = pg.items.filter(i => showsCaption(i) && !i.caption?.trim()).length;
  return [
    h("section", {}, h("h3", {}, `Page ${pageIx + 1}`),
      h("div", { className: "btn-col" },
        btn(pg.title?.text?.trim() ? "Edit title" : "Add a title", () => startEditing("title", 0)),
        btn("+ Text box", addTextBox),
        btn("Fill in starter captions & title", () => suggestText({ pages: [pageIx], titles: true, captions: true, overwrite: false }), "",
          "Writes suggestions only where a caption or the title is empty"),
        h("p", { className: "note" }, emptyCaptions ? `${emptyCaptions} photo${emptyCaptions === 1 ? " has" : "s have"} no caption yet.` : "Every photo on this page has a caption."))),
    h("section", {}, h("h3", {}, "Background"),
      h("div", { className: "bg-grid" }, swatch(null, "Plain color"), ...backgrounds.book.map(n => swatch(n, `Uploaded: ${n}`))),
      ...groups.map(([label, names], k) => h("details", { className: "bg-group", open: k === 0 || names.includes(pg.background) },
        h("summary", { className: "small muted" }, `${label} (${names.length})`),
        h("div", { className: "bg-grid" }, ...names.map(n => swatch(n, bgLabel(n)))))),
      h("div", { className: "field" }, h("span", {}, "Plain color"), color),
      h("div", { className: "btn-col" }, upload,
        thisMonth ? btn("Match this page's month", () => { pg.background = thisMonth; commit(); }) : null,
        btn("Match every page to its month", () => { for (const p of book.pages) p.background = monthBackground(p) || p.background; commit(); }),
        btn("Use this background on every page", () => { for (const p of book.pages) { p.background = pg.background; p.color = pg.color; } commit(); }))),
    h("section", {}, h("h3", {}, "Photo frames"),
      h("div", { className: "field" }, h("span", {}, "Frame color on this page"), borderColor),
      h("div", { className: "btn-col" }, btn("Use this frame color on every page", frameEverywhere)),
      h("p", { className: "note" }, "Only this page changes. The frame width is under Book layout.")),
    h("section", {}, h("h3", {}, "Arrange page"),
      h("div", { className: "btn-col" },
        btn("Auto-arrange this page", async () => {
          if (pg.items.length && !confirm("Re-arrange this page's photos automatically? Captions stay with their photos. (You can undo.)")) return;
          const r = await api("POST", `/api/projects/${slug}/autolayout`, { page: pageIx, pages: book.pages, settings: s });
          const caps = Object.fromEntries(pg.items.map(i => [i.photo, i]));
          pg.items = r.items.map(it => { const old = caps[it.photo] || {}; return { ...it, caption: old.caption || "", caption_auto: old.caption_auto, caption_style: old.caption_style, caption_frame: old.caption_frame, ...(old.caption_off ? { caption_off: true } : {}) }; });
          select(null); commit();
        }),
        h("div", { className: "btn-row" }, btn("↑ Move up", () => movePage(-1)), btn("↓ Move down", () => movePage(1))),
        btn("Delete page", () => {
          if (!confirm(`Delete page ${pageIx + 1}? Its photos go back to the tray.`)) return;
          pg.items.forEach(remember);
          book.unplaced.unshift(...pg.items.map(i => i.photo));
          book.pages.splice(pageIx, 1);
          if (!book.pages.length) book.pages.push(blankPage(pg));
          pageIx = Math.min(pageIx, book.pages.length - 1); select(null); commit();
        }, "danger"))),
    h("section", {}, h("h3", {}, "Whole book"),
      h("div", { className: "btn-col" },
        btn("Fill in all empty captions & titles", () => suggestText({ pages: book.pages.map((_, i) => i), titles: true, captions: true, overwrite: false })),
        btn("Redo all suggested text", () => {
          if (!confirm("Rewrite every caption and title that came from a suggestion? Ones you've typed or edited are kept.")) return;
          suggestText({ pages: book.pages.map((_, i) => i), titles: true, captions: true, overwrite: "auto" });
        }),
        btn("Re-flow whole book", async () => {
          if (!confirm("Lay out every photo again from scratch, using these settings? Your manual layout changes will be replaced, but captions stay with their photos and typed titles are kept (you can undo).")) return;
          const r = await api("POST", `/api/projects/${slug}/autolayout`, { all: true, pages: book.pages, unplaced: book.unplaced, settings: s });
          book.pages = r.pages; book.unplaced = r.unplaced; pageIx = 0; select(null); commit();
        }))),
    h("section", {}, h("h3", {}, "Book layout"),
      setting("Photos per page", "per_page", { step: 1, min: 1, max: 40, int: true }),
      setting("Edge margin (in)", "margin"),
      setting("Title space (in)", "title"),
      setting("Caption strip (in)", "caption"),
      setting("Photo-to-caption gap (in)", "caption_gap", { step: 0.01, max: 1 }),
      setting("Gap (in)", "gap"),
      setting("Photo frame (in)", "border", { step: 0.01, max: 0.3 }),
      h("p", { className: "note" }, "Margin, title space, caption strip and gap are used by auto-arrange and re-flow. The photo-to-caption gap moves captions down without shrinking them; if they start to crowd the next row, raise the caption strip (then re-flow) to make room. Click a caption or title to change its font.")),
  ];
}

// Starter captions/titles, applied where allowed:
// overwrite false = only empty ones; "auto" = also replace earlier suggestions; true = replace.
async function suggestText({ pages, titles, captions, overwrite }) {
  stopEditing();
  await flushSave();
  const prog = h("div", { className: "progress" }, h("div", { className: "bar" }, h("i")), h("span"));
  modal(h("h2", {}, "Writing starter text…"), h("p", { className: "small muted" }, "Looking at what's in each photo, where and when it was taken. Older photos are checked again the first time, which takes about a second each."), prog);
  try {
    await api("POST", `/api/projects/${slug}/suggest-text`, { pages: pages.map(i => book.pages[i]) });
    const j = await pollJob(slug, prog, "Step");
    const fresh = await api("GET", `/api/projects/${slug}`);
    book.photos = fresh.photos;
    const r = j.result;
    let n = 0;
    const may = (text, auto) => overwrite === true || !text?.trim() || (overwrite === "auto" && auto);
    pages.forEach((pi, k) => {
      const pg = book.pages[pi];
      if (captions) for (const it of pg.items) {
        if (showsCaption(it) && r.captions[it.photo] && may(it.caption, it.caption_auto)) { it.caption = r.captions[it.photo]; it.caption_auto = true; n++; }
      }
      if (titles && r.titles[k] && may(pg.title.text, pg.title.auto)) { pg.title.text = r.titles[k]; pg.title.auto = true; n++; }
    });
    closeModal();
    commit();
    setSaveState(n ? `Added ${n} suggestion${n === 1 ? "" : "s"} — edit any you like` : "Nothing to fill in — everything already has text");
  } catch (e) {
    modal(h("h2", {}, "Couldn't write suggestions"), h("p", { className: "warn" }, e.message), btn("Close", closeModal));
  }
}

// ---------- spelling ----------
// Words are checked against a bundled English dictionary (spell.js). Misspellings
// get a red squiggle on the page (never in the export), are listed under "Spelling", and the
// side panel offers fixes for whichever caption or title is selected.
const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’]*/gu;
const spell = { known: new Map(), ignored: new Set(), timer: null, busy: false, failed: false };
try { (JSON.parse(localStorage.getItem("photobook:ignored-words")) || []).forEach(w => spell.ignored.add(w)); } catch (e) { /* none yet */ }

const bareWord = w => w.replace(/['’]+$/, "");
const isMisspelled = w => !spell.ignored.has(w.toLowerCase()) && Array.isArray(spell.known.get(w));
const misspelledIn = text => [...new Set([...String(text || "").matchAll(WORD_RE)].map(m => bareWord(m[0])).filter(isMisspelled))];

function markSpelling(line) {
  if (previewMode) return line;
  const out = [];
  let last = 0;
  for (const m of line.matchAll(WORD_RE)) {
    const w = bareWord(m[0]);
    if (!isMisspelled(w)) continue;
    out.push(line.slice(last, m.index), h("span", { className: "misspelled" }, w));
    last = m.index + w.length;
  }
  out.push(line.slice(last));
  return h("span", {}, ...out.filter(x => x !== ""));
}

function allTextTargets() {
  const out = [];
  book.pages.forEach((pg, p) => {
    out.push({ p, kind: "title", i: 0, where: `Page ${p + 1} title` });
    pg.items.forEach((it, i) => { if (showsCaption(it)) out.push({ p, kind: "caption", i, where: `Page ${p + 1} caption` }); });
    (pg.texts || []).forEach((_, i) => out.push({ p, kind: "text", i, where: `Page ${p + 1} text box` }));
  });
  return out.map(t => ({ ...t, tt: textTarget(t.kind, t.i, book.pages[t.p]) })).filter(t => t.tt.get().trim());
}

function spellingIssues() {
  return allTextTargets().flatMap(t => misspelledIn(t.tt.get()).map(word => ({ ...t, word })));
}

function scheduleSpellcheck() {
  clearTimeout(spell.timer);
  spell.timer = setTimeout(runSpellcheck, 600);
}

async function runSpellcheck() {
  if (!book || spell.busy) return;
  const words = new Set();
  for (const t of allTextTargets()) for (const m of t.tt.get().matchAll(WORD_RE)) words.add(bareWord(m[0]));
  const unknown = [...words].filter(w => !spell.known.has(w));
  if (unknown.length) {
    spell.busy = true;
    try {
      const { misspelled } = await api("POST", "/api/spell", { words: unknown });
      for (const w of unknown) spell.known.set(w, misspelled[w] || null);
      spell.failed = false;
    } catch (e) { spell.failed = true; console.warn(e); /* dictionary didn't load (offline on first use?); retry on the next change */ }
    spell.busy = false;
    if (!book) return;
    renderText();
    const typing = document.activeElement && (document.activeElement.closest("#inspector") || document.activeElement.classList.contains("tb-editor"));
    if (!typing) renderInspector();
  }
  updateSpellButton();
}

function updateSpellButton() {
  const n = spellingIssues().length;
  const b = $("#spell-btn");
  b.textContent = spell.failed ? "Spelling (unavailable)" : n ? `Spelling (${n})` : "Spelling ✓";
  b.title = spell.failed ? "The spelling dictionary couldn't be loaded. Check the internet connection and reload the page." : "Check the spelling of every title and caption";
  b.classList.toggle("warn", n > 0 || spell.failed);
}

function replaceWord(text, word, repl) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(^|[^\\p{L}\\p{M}'’])${esc}(?![\\p{L}\\p{M}])`, "u"), (_, pre) => pre + repl);
}

function ignoreWord(word) {
  spell.ignored.add(word.toLowerCase());
  try { localStorage.setItem("photobook:ignored-words", JSON.stringify([...spell.ignored])); } catch (e) { /* storage full */ }
}

async function learnWord(word) {
  await api("POST", "/api/dictionary", { word });
  spell.known.set(word, null);
}

// Fix buttons for one misspelled word; `after` re-renders whatever is showing them.
function fixButtons(t, word, after) {
  const guesses = spell.known.get(word) || [];
  return h("div", { className: "spell-fixes" },
    ...guesses.map(g => btn(g, () => { t.tt.set(replaceWord(t.tt.get(), word, g)); commit(); after(); }, "mini fix", `Change "${word}" to "${g}"`)),
    guesses.length ? null : h("span", { className: "small muted" }, "No suggestions"),
    btn("Ignore", () => { ignoreWord(word); renderAll(); after(); }, "mini ghost", "Don't flag this word again on this computer"),
    btn("Add to dictionary", async () => { await learnWord(word); renderAll(); after(); }, "mini ghost", "Never flag this word again in this browser"));
}

function spellingHints(kind, i) {
  const t = { tt: textTarget(kind, i) };
  const words = misspelledIn(t.tt.get());
  if (!words.length) return null;
  return h("div", { className: "spell-hints" }, ...words.map(w =>
    h("div", { className: "spell-hint" }, h("div", { className: "small" }, "Check spelling: ", h("b", { className: "misspelled" }, w)),
      fixButtons(t, w, () => {}))));
}

async function showSpelling() {
  stopEditing();
  await runSpellcheck();
  if (spell.failed) {
    modal(h("h2", {}, "Spell check unavailable"),
      h("p", {}, "The spelling dictionary couldn't be loaded. It downloads the first time spelling is checked, so check the internet connection, then reload this page."),
      h("div", { className: "btn-row" }, btn("Close", closeModal)));
    return;
  }
  const issues = spellingIssues();
  const snippet = (text, word) => {
    const at = text.search(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    return h("span", {}, text.slice(Math.max(0, at - 30), at), h("b", { className: "misspelled" }, word), text.slice(at + word.length, at + word.length + 30));
  };
  const rows = issues.map(t => h("div", { className: "spell-row" },
    h("div", { className: "spell-where" }, h("span", { className: "small muted" }, t.where),
      btn("Go to", () => { closeModal(); pageIx = t.p; select(t.kind, t.i); renderAll(); }, "mini ghost")),
    h("div", { className: "small spell-snippet" }, snippet(t.tt.get(), t.word)),
    fixButtons(t, t.word, showSpelling)));
  modal(h("h2", {}, issues.length ? `Spelling: ${issues.length} to check` : "Spelling looks good"),
    h("p", { className: "small muted" }, issues.length
      ? "Click a suggestion to fix it. Names and places the dictionary doesn't know can be added to it."
      : "Every title, caption and text box in this book passed the spell check."),
    h("div", { className: "spell-list" }, ...rows),
    h("div", { className: "btn-row" }, btn("Close", closeModal)));
}

// ---------- export ----------
function modal(...content) {
  $("#modal-card").replaceChildren(...content.flat().filter(Boolean));
  $("#modal").classList.remove("hidden");
}
const closeModal = () => $("#modal").classList.add("hidden");

// Pages are drawn on a canvas at 300 dpi with the same geometry and text lines as the editor.
const DPI = 300;
let exported = []; // [{name, blob, url}]

async function renderPageImage(pg) {
  const s = S(), P = Math.round(s.page * DPI);
  const c = new OffscreenCanvas(P, P), ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = pg.color || "#ffffff";
  ctx.fillRect(0, 0, P, P);
  if (pg.background) { // cover the page, centered
    const bmp = await createImageBitmap(await (await fetch(bgUrl(pg.background))).blob());
    const k = Math.max(P / bmp.width, P / bmp.height);
    ctx.drawImage(bmp, (P - bmp.width * k) / 2, (P - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    bmp.close();
  }
  for (const it of pg.items) await drawItem(ctx, it, pg);
  for (const b of pageTextBlocks(pg)) {
    if (b.frame) drawFrame(ctx, b);
    if (b.lines.length) drawLines(ctx, b);
  }
  return c;
}

// The editor shows a photo with CSS: frame turned by `rotation`; inside it the photo, turned by
// crop.angle, flipped, and shifted so the crop's center sits at the frame's center. Same here.
async function drawItem(ctx, it, pg) {
  const ph = photoOf(it), b = cropBox(it, ph), c = it.crop, s = S();
  const drawW = b.W * b.k * DPI, drawH = b.H * b.k * DPI; // the whole photo at print size
  const blob = await store.getPhoto(slug, it.photo);
  const bmp = await uprightBitmap(blob, Math.ceil(Math.max(drawW, drawH))); // no bigger than needed
  const fw = it.w * DPI, fh = it.h * DPI, bd = s.border > 0 ? s.border * DPI : 0;
  ctx.save();
  ctx.translate((it.x + it.w / 2) * DPI, (it.y + it.h / 2) * DPI);
  if (it.rotation) ctx.rotate(rad(it.rotation));
  if (bd) { ctx.fillStyle = frameColor(pg); ctx.fillRect(-fw / 2 - bd, -fh / 2 - bd, fw + 2 * bd, fh + 2 * bd); }
  ctx.beginPath(); ctx.rect(-fw / 2, -fh / 2, fw, fh); ctx.clip();
  if (c.angle) ctx.rotate(rad(c.angle));
  ctx.scale(c.flip_x ? -1 : 1, c.flip_y ? -1 : 1);
  ctx.translate(-b.mx * b.k * DPI, -b.my * b.k * DPI);
  ctx.drawImage(bmp, 0, 0, drawW, drawH);
  ctx.restore();
  bmp.close();
}

function turnAboutPivot(ctx, b) {
  if (!b.angle) return;
  ctx.translate(b.px * DPI, b.py * DPI); ctx.rotate(rad(b.angle)); ctx.translate(-b.px * DPI, -b.py * DPI);
}

function drawFrame(ctx, b) {
  const f = b.frame, x = f.x * DPI, y = f.y * DPI, w = f.w * DPI, hh = f.h * DPI;
  const r = Math.min(f.radius * DPI, w / 2, hh / 2), bw = f.border ? (f.width / 72) * DPI : 0;
  ctx.save();
  turnAboutPivot(ctx, b);
  if (f.fill) { ctx.globalAlpha = f.opacity ?? 1; ctx.fillStyle = f.fill; ctx.beginPath(); ctx.roundRect(x, y, w, hh, r); ctx.fill(); ctx.globalAlpha = 1; }
  if (bw) { ctx.strokeStyle = f.border; ctx.lineWidth = bw; ctx.beginPath(); ctx.roundRect(x + bw / 2, y + bw / 2, w - bw, hh - bw, Math.max(0, r - bw / 2)); ctx.stroke(); }
  ctx.restore();
}

// Lines sit in line boxes `lh` tall with the text centered in each, as the browser lays them out.
function drawLines(ctx, b) {
  ctx.save();
  turnAboutPivot(ctx, b);
  const size = (b.size / 72) * DPI, lh = (b.size / 72) * b.line_height * DPI;
  ctx.font = `${b.weight} ${size}px "${b.font}"`;
  ctx.fillStyle = b.color;
  ctx.textAlign = b.align || "center";
  ctx.textBaseline = "alphabetic";
  const m = ctx.measureText("Hg"), asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent;
  const blockH = lh * b.lines.length, boxH = b.h * DPI;
  const top = b.y * DPI + ({ top: 0, middle: (boxH - blockH) / 2, bottom: boxH - blockH }[b.valign || "top"]);
  const x = { left: b.x * DPI, center: (b.x + b.w / 2) * DPI, right: (b.x + b.w) * DPI }[b.align || "center"];
  b.lines.forEach((line, i) => ctx.fillText(line, x, top + i * lh + (lh - (asc + desc)) / 2 + asc));
  ctx.restore();
}

// Canvas JPEGs say 72 dpi; mark them 300 dpi like the Mac build's (the pixels are what matter).
async function withDpi(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf[2] === 0xff && buf[3] === 0xe0 && String.fromCharCode(...buf.slice(6, 10)) === "JFIF") {
    buf[13] = 1; buf[14] = DPI >> 8; buf[15] = DPI & 255; buf[16] = DPI >> 8; buf[17] = DPI & 255;
  }
  return new Blob([buf], { type: "image/jpeg" });
}

async function doExport() {
  stopEditing();
  select(null); renderPage();
  await flushSave();
  const prog = h("div", { className: "progress" }, h("div", { className: "bar" }, h("i")), h("span"));
  const warn = book.unplaced.length ? h("p", { className: "small warn" }, `${book.unplaced.length} photo${book.unplaced.length > 1 ? "s are" : " is"} still in the tray and won't be in the book.`) : null;
  const blank = book.pages.filter(p => !p.items.length).length;
  const blankWarn = blank ? h("p", { className: "small warn" }, `${blank} page${blank > 1 ? "s have" : " has"} no photos and will export as just a background.`) : null;
  modal(h("h2", {}, "Exporting pages…"), h("p", { className: "muted small" }, "Drawing every page at full print resolution (2400 × 2400 px)."), prog, warn, blankWarn);
  exported.forEach(e => URL.revokeObjectURL(e.url));
  exported = [];
  const name = i => `page-${String(i + 1).padStart(2, "0")}.jpg`;
  try {
    for (const [i, pg] of book.pages.entries()) {
      $("i", prog).style.width = `${(100 * i) / book.pages.length}%`;
      $("span", prog).textContent = `Page ${i + 1} / ${book.pages.length}`;
      const c = await renderPageImage(pg);
      const blob = await withDpi(await c.convertToBlob({ type: "image/jpeg", quality: 0.95 }));
      exported.push({ name: name(i), blob, url: URL.createObjectURL(blob) });
    }
    const zip = btn("Download all pages (.zip)", async () => {
      zip.disabled = true; zip.textContent = "Packing…";
      download(await store.makeZip(exported.map(({ name, blob }) => ({ name, blob }))), `${safeName(book.name)} pages.zip`);
      zip.disabled = false; zip.textContent = "Download all pages (.zip)";
    }, "primary");
    modal(h("h2", {}, `Exported ${book.pages.length} page${book.pages.length > 1 ? "s" : ""}`),
      warn, blankWarn,
      h("div", { className: "export-grid" }, ...exported.map(e =>
        h("a", { href: e.url, download: e.name, title: `Download ${e.name}` }, h("img", { src: e.url }), h("span", { className: "small" }, e.name)))),
      h("p", { className: "note" }, "Click a page to download just that one, or download them all at once. In Shutterfly, give each page a single full-page photo layout and drop the matching page-XX.jpg onto it."),
      h("div", { className: "btn-row" }, btn("Close", closeModal), zip));
  } catch (e) {
    console.error(e);
    modal(h("h2", {}, "Export failed"), h("p", { className: "warn" }, e.message), btn("Close", closeModal));
  }
}

// ---------- add photos ----------
async function addPhotos(files) {
  if (!files.length) return;
  await flushSave();
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  try {
    await api("POST", `/api/projects/${slug}/photos`, fd);
    const j = await pollJob(slug, $("#add-progress"), "Analyzing photo");
    if (j.skipped?.length) alert(`${j.skipped.length} file${j.skipped.length > 1 ? "s" : ""} couldn't be opened as photos and were skipped.`);
    const fresh = await api("GET", `/api/projects/${slug}`);
    book.photos = fresh.photos;
    const seen = new Set([...book.pages.flatMap(p => p.items.map(i => i.photo)), ...book.unplaced]);
    book.unplaced.push(...fresh.unplaced.filter(pid => !seen.has(pid)));
    commit();
  } catch (e) { alert("Couldn't add photos: " + e.message); }
}

// ---------- keyboard & wiring ----------
function onKey(e) {
  if (!book || $("#editor").classList.contains("hidden")) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  if (!$("#modal").classList.contains("hidden")) { // Esc closes dialogs that offer a plain Close (not the recovery question)
    if (e.key === "Escape" && [...document.querySelectorAll("#modal-card button")].some(b => b.textContent === "Close")) closeModal();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (e.key === "Escape") { if (cropMode) cropMode = false; else if (swapMode) swapMode = false; else select(null); renderPage(); renderInspector(); return; }
  if (e.key.toLowerCase() === "p" && !mod) { togglePreview(); return; }
  if (e.key.toLowerCase() === "t" && !mod) { e.preventDefault(); addTextBox(); return; }
  if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); selectItems(curPage().items.map((_, i) => i)); renderPage(); renderInspector(); return; }
  if (!sel) return;
  if ((e.code === "BracketLeft" || e.code === "BracketRight") && !mod) { // [ ] turn by 1°, Shift for 15°
    e.preventDefault();
    const d = (e.code === "BracketLeft" ? -1 : 1) * (e.shiftKey ? 15 : 1), pg = curPage();
    const turn = (o, k) => { o[k] = normDeg((o[k] || 0) + d); };
    if (sel.kind === "items") sel.list.forEach(i => turn(pg.items[i], "rotation"));
    else if (sel.kind === "caption") { const it = pg.items[sel.i]; it.caption_free ? turn(it, "caption_rotation") : turn(it, "rotation"); }
    else if (cropMode && isItem()) { turn(selItem().crop, "angle"); normalizeCrop(selItem()); }
    else if (isItem()) turn(selItem(), "rotation");
    else if (sel.kind === "title") turn(pg.title, "rotation");
    else turn(pg.texts[sel.i], "rotation");
    commit();
    return;
  }
  if (sel.kind === "items") {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) { e.preventDefault(); for (const i of sel.list) { curPage().items[i].x += d[0]; curPage().items[i].y += d[1]; } commit(); }
    else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); removeManyToTray(sel.list); }
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (isItem()) { if (showsCaption(selItem())) startEditing("caption", sel.i); } else startEditing(sel.kind, sel.i);
    return;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    if (isItem()) removeToTray();
    else if (sel.kind === "text") { curPage().texts.splice(sel.i, 1); select(null); commit(); }
    return;
  }
  const obj = sel.kind === "caption" ? null : selObject(true);
  const step = e.shiftKey ? 0.1 : 0.01;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d && obj) { e.preventDefault(); obj.x += d[0]; obj.y += d[1]; commit(); }
}

function togglePreview() {
  stopEditing();
  previewMode = !previewMode;
  if (previewMode) select(null);
  $("#preview-btn").textContent = previewMode ? "Exit preview" : "Preview";
  renderPage(); renderInspector();
}

async function init() {
  $("#hint").textContent = `Drag to move · Shift-click or drag a box to select several · double-click a photo to crop, or a caption/title to type · ${ALT}-drag skips snapping`;
  $("#undo").title = `Undo (${MOD}Z)`;
  $("#redo").title = `Redo (${IS_MAC ? "⇧⌘Z" : "Ctrl+Shift+Z"})`;
  await loadFonts();
  setupHome();
  setupStage();
  $("#back").onclick = () => { stopEditing(); showHome(); };
  $("#undo").onclick = undo;
  $("#redo").onclick = redo;
  $("#export").onclick = doExport;
  $("#history-btn").onclick = showHistory;
  $("#spell-btn").onclick = showSpelling;
  $("#preview-btn").onclick = togglePreview;
  $("#add-text").onclick = addTextBox;
  $("#show-guides").onchange = e => { showGuides = e.target.checked; renderOverlays(); };
  $("#book-name").onchange = e => { book.name = e.target.value.trim() || book.name; commit(); };
  $("#add-page").onclick = () => {
    stopEditing();
    book.pages.splice(pageIx + 1, 0, blankPage(curPage()));
    pageIx++; select(null); commit();
  };
  $("#add-photos").onchange = e => { preload(); addPhotos([...e.target.files]); e.target.value = ""; };
  $("#save-file").onclick = () => saveBookFile(slug, book.name);
  $("#open-file").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) openBookFile(f); };
  document.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", e => {
    if ((book && dirty) || busy()) { flushSave(); e.preventDefault(); e.returnValue = ""; }
  });
  window.addEventListener("online", () => book && dirty && flushSave());
  window.addEventListener("hashchange", async () => {
    const want = location.hash.slice(1);
    if (want && want !== slug) { await flushSave(); closeModal(); openBook(want).catch(showHome); }
  });
  const start = location.hash.slice(1);
  start ? openBook(start).catch(showHome) : showHome();
}

init();
