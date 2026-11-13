// Automatic page layout, face-safe cropping and starter captions/titles.
// A straight translation of the Mac build's layout.py and describe.py.
//
// Geometry is in inches, top-left origin. A placed photo ("item") is a frame {x, y, w, h} plus a
// crop {zoom, cx, cy}. A photo's analysis: {w, h, keep: [x0,y0,x1,y1], soft: [[box, weight]...],
// faces, labels, signs, gps, place, taken}.

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// (natural, narrowest, widest) frame aspect (w/h) that keeps every face.
export function aspectRange(a) {
  const { w: W, h: H, keep: k } = a;
  return [W / H, Math.max(0.5, (k[2] - k[0]) / H), Math.min(3.0, W / Math.max(1, k[3] - k[1]))];
}

// ---------- cropping ----------
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

// Crop {zoom, cx, cy} for a frame of the given aspect that keeps faces, favoring people/signs.
export function smartCrop(a, aspect) {
  const { w: W, h: H, keep: k } = a;
  const [cw, ch] = W / H > aspect ? [H * aspect, H] : [W, W / aspect];
  const x = bestOffset(W, cw, k[0], k[2], a.soft.map(([b, w]) => [b[0], b[2], w]), (k[0] + k[2]) / 2);
  // Vertically, faces sit a bit above center so heads keep their headroom.
  const y = bestOffset(H, ch, k[1], k[3], a.soft.map(([b, w]) => [b[1], b[3], w]), (k[1] + k[3]) / 2 + 0.1 * ch);
  return { zoom: 1, cx: (x + cw / 2) / W, cy: (y + ch / 2) / H };
}

// ---------- layout ----------
// Aspects for one row so it fills `width` exactly, cropping each photo as evenly (in log terms)
// as possible within its face-safe range. Returns [aspects, cost] or null.
function fitRow(photos, width, height, gap) {
  const target = (width - gap * (photos.length - 1)) / height;
  const ranges = photos.map(aspectRange);
  const sum = f => ranges.reduce((t, r) => t + f(r), 0);
  if (!(sum(r => r[1]) <= target && target <= sum(r => r[2]))) return null;
  const fit = (r, s) => clamp(r[0] * Math.exp(s), r[1], r[2]);
  let lo = -5, hi = 5;
  for (let i = 0; i < 60; i++) {
    const s = (lo + hi) / 2;
    if (sum(r => fit(r, s)) < target) lo = s; else hi = s;
  }
  const s = (lo + hi) / 2;
  const aspects = ranges.map(r => fit(r, s));
  return [aspects, aspects.reduce((t, asp, i) => t + Math.log(asp / ranges[i][0]) ** 2, 0)];
}

// Split photos (in order) into nRows rows that each fill the width, minimizing total cropping.
// With allowShort there may be fewer rows and the last one may fall short.
function planRows(photos, width, height, gap, nRows, allowShort, maxPerRow = 8) {
  const n = photos.length;
  const best = Array.from({ length: nRows + 1 }, () => Array(n + 1).fill(Infinity));
  const back = Array.from({ length: nRows + 1 }, () => Array(n + 1).fill(null));
  best[0][0] = 0;
  for (let r = 1; r <= nRows; r++) {
    for (let j = 1; j <= n; j++) {
      for (let i = Math.max(0, j - maxPerRow); i < j; i++) {
        if (!isFinite(best[r - 1][i])) continue;
        const row = photos.slice(i, j);
        let fit = fitRow(row, width, height, gap);
        if (!fit && allowShort && j === n) {
          const natural = row.map(p => { const a = aspectRange(p); return Math.min(a[0], a[2]); });
          if (natural.reduce((t, x) => t + x, 0) * height + gap * (row.length - 1) <= width) fit = [natural, 0];
        }
        if (fit && best[r - 1][i] + fit[1] < best[r][j]) { best[r][j] = best[r - 1][i] + fit[1]; back[r][j] = [i, fit[0]]; }
      }
    }
  }
  const candidates = allowShort ? Array.from({ length: nRows }, (_, k) => k + 1) : [nRows];
  let r = candidates.reduce((a, b) => (best[b][n] < best[a][n] ? b : a));
  if (!isFinite(best[r][n])) return [null, Infinity];
  const cost = best[r][n], rows = [];
  let j = n;
  while (j) {
    const [i, aspects] = back[r][j];
    rows.push(photos.slice(i, j).map((p, k) => [p, aspects[k]]));
    j = i; r -= 1;
  }
  return [rows.reverse(), cost];
}

const rowHeight = (s, nRows) => (s.page - 2 * s.margin - s.title - (nRows - 1) * s.gap) / nRows - s.caption;

// Plain grid when no justified layout fits (e.g. many very wide panoramas).
function gridFallback(photos, s) {
  const n = photos.length, cols = Math.ceil(Math.sqrt(n * 1.3)), rows = Math.ceil(n / cols);
  const width = s.page - 2 * s.margin, w = (width - (cols - 1) * s.gap) / cols, h = rowHeight(s, rows);
  const out = [];
  for (let i = 0; i < n; i += cols) out.push(photos.slice(i, i + cols).map(p => [p, w / h]));
  return [out, h];
}

// Items and row height for a page. Picks the row count that crops least. A `short` page (fewer
// photos than a full page) may leave its last row part-filled, and keeps rowH if given to match
// the page before it.
export function layoutPage(photos, s, { rowH = null, short = false } = {}) {
  if (!photos.length) return [[], null];
  const width = s.page - 2 * s.margin;
  const plans = [];
  if (short && rowH) {
    const nRows = Math.max(1, Math.round((s.page - 2 * s.margin - s.title + s.gap) / (rowH + s.caption + s.gap)));
    plans.push([...planRows(photos, width, rowH, s.gap, nRows, true), rowH]);
  }
  if (!(plans.length && plans[0][0])) {
    for (let r = 1; r < 8; r++) {
      const h = rowHeight(s, r);
      if (h > 0.4) {
        plans.push([...planRows(photos, width, h, s.gap, r, false), h]);
        if (short) plans.push([...planRows(photos, width, h, s.gap, r, true), h]);
      }
    }
  }
  let [rows, , h] = plans.reduce((a, b) => (b[1] < a[1] ? b : a), [null, Infinity, null]);
  if (!rows) [rows, h] = gridFallback(photos, s);
  const items = [];
  let y = s.margin + s.title;
  for (const row of rows) {
    const rowW = row.reduce((t, [, asp]) => t + h * asp, 0) + s.gap * (row.length - 1);
    let x = s.margin + (width - rowW) / 2;
    for (const [p, asp] of row) {
      items.push({ photo: p.id, x, y, w: h * asp, h, crop: smartCrop(p, asp) });
      x += h * asp + s.gap;
    }
    y += h + s.caption + s.gap;
  }
  return [items, h];
}

// ---------- starter captions ----------
// Scene label -> caption phrase, most specific first. (Labels come from the Mac build's
// analysis; the browser build doesn't name scenes yet, so these apply to books moved over.)
const SCENES = [
  [["carousel"], "Carousel ride"], [["roller_coaster", "ferris_wheel", "amusement_park"], "Fun at the fair"],
  [["aquarium"], "At the aquarium"], [["zoo", "giraffe", "elephant", "zebra"], "At the zoo"],
  [["ice_cream", "frozen_dessert"], "Ice cream stop"], [["birthday_cake", "cake", "candle"], "Birthday cake"],
  [["christmas_tree", "christmas_decoration"], "Christmas time"], [["pumpkin", "jack_o_lantern"], "Pumpkin time"],
  [["fireworks"], "Fireworks"], [["snow", "snowman", "sled", "skiing"], "Snow day"],
  [["swimming_pool", "pool"], "Pool day"], [["beach", "shore", "sand"], "Beach day"],
  [["lake", "river", "waterfall", "ocean", "sea"], "By the water"], [["playground", "swing", "slide_toy"], "Playground fun"],
  [["campfire", "camping", "tent"], "Under the tents"], [["piano", "musical_instrument", "guitar", "violin"], "Making music"],
  [["board_game", "games", "cards", "puzzle"], "Game night"], [["soccer", "football", "baseball", "basketball", "sport"], "Game day"],
  [["hiking", "trail", "forest"], "On the trail"], [["mountain", "hill"], "Mountain views"],
  [["tableware", "plate", "food", "meal", "restaurant", "utensil"], null], // a meal, named by time of day
  [["grass", "park"], "Out on the grass"],
];
const GROUP = ["All together", "Group selfie", "Smiles all around", "The whole crew", "Making memories", "Family time"];
const titleCase = s => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

function meal(taken) {
  const hour = taken ? new Date(taken).getHours() : 18;
  return hour < 10 ? "Breakfast together" : hour < 15 ? "Lunch together" : "Dinner together";
}

// A short starter caption. `used` holds captions already on the page, to avoid repeats.
export function captionFor(photo, used = []) {
  const place = photo.place || {}, town = place.town, poi = place.poi;
  const labels = new Set((photo.labels || []).filter(([, c]) => c >= 0.4).map(([l]) => l));
  const sign = photo.signs?.[0];
  let phrase = null;
  for (const [keys, text] of SCENES) if (keys.some(k => labels.has(k))) { phrase = text || meal(photo.taken); break; }
  const options = [];
  if (sign) options.push(titleCase(sign));
  if (poi) options.push(phrase ? `${phrase} at ${poi}` : `At ${poi}`);
  if (phrase) options.push(town ? `${phrase} in ${town}` : phrase);
  const n = photo.faces || 0;
  const lead = n >= 3 ? GROUP : n >= 2 ? ["Smiles", "Together", "Just us"] : n ? ["Sweet moment", "Smile!"] : ["Sights along the way"];
  options.push(...lead.map(g => (town ? `${g} in ${town}` : g)));
  return options.find(t => !used.includes(t)) || options[0];
}

// ---------- titles ----------
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function dateRange(photos) {
  const days = [...new Set(photos.filter(p => p.taken).map(p => p.taken.slice(0, 10)))].sort();
  if (!days.length) return "";
  const parse = d => ({ y: +d.slice(0, 4), m: +d.slice(5, 7) - 1, d: +d.slice(8, 10) });
  const a = parse(days[0]), b = parse(days.at(-1));
  const fmt = (x, year = true) => `${MONTH_NAMES[x.m]} ${x.d}` + (year ? `, ${x.y}` : "");
  if (days[0] === days.at(-1)) return fmt(a);
  if (a.y === b.y && a.m === b.m) return `${MONTH_NAMES[a.m]} ${a.d}–${b.d}, ${a.y}`;
  if (a.y === b.y) return `${fmt(a, false)} – ${fmt(b)}`;
  return `${fmt(a)} – ${fmt(b)}`;
}

// E.g. "Hayden, Wallace & Missoula · June 13–15, 2024".
export function titleFor(photos) {
  const towns = photos.map(p => p.place?.town).filter(Boolean);
  const when = dateRange(photos);
  if (!towns.length) return when;
  const counts = new Map();
  towns.forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
  const top = new Set([...counts].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t]) => t));
  const names = [...new Set(towns)].filter(t => top.has(t)); // the three most-photographed, in trip order
  const where = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;
  return when ? `${where} · ${when}` : where;
}

// ---------- monthly backgrounds ----------
export function monthOf(photos) {
  const counts = new Map();
  for (const p of photos) if (p.taken) { const m = +p.taken.slice(5, 7); counts.set(m, (counts.get(m) || 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// The month-NN-*.jpg background for the month most of these photos were taken in.
export function monthBackground(photos, available) {
  const m = monthOf(photos);
  if (!m) return null;
  const options = available.filter(n => n.startsWith(`month-${String(m).padStart(2, "0")}`)).sort();
  const designed = options.filter(n => !n.includes("-photo-")); // quieter than the photo ones behind 20 photos
  const first = designed.filter(n => !/^month-\d\d-\d-/.test(n)); // month-NN-2-* are second choices
  return first[0] || designed[0] || options[0] || null;
}
