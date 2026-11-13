// Importing and analyzing photos, all in the browser.
//
// - Files and Google Photos / Takeout zips are unpacked (zips are read piece by piece).
// - iPhone HEIC photos are turned into JPEGs (browsers other than Safari can't show HEIC).
// - EXIF gives when (and where) each photo was taken.
// - MediaPipe (Google's on-device vision models) finds faces and people, so crops keep them:
//   the same "keep" (hard: faces with room for hair and chin) and "soft" (bodies) boxes the Mac
//   build gets from Apple's Vision.

import exifr from "https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs";
import { zipEntries, newId } from "./storage.js";

const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODELS = {
  face: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
  object: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite",
};
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|gif|bmp|avif)$/i;
const THUMB = 1400; // editor-sized copies (px on the long side)
const TILE_FRAC = 0.45;       // close-up tiles: this fraction of the photo's short side
const DETECT_SIZE = 1920;     // long side of the copy faces are looked for in (tuned: 96/101 of the Mac's faces on group shots, no false ones)
const TILE_MIN_SCORE = 0.75; // tuned on real family photos: false tile faces scored 0.56–0.68

// ---------- unpacking ----------
// files: File[] (images and/or zips) -> [{name, blob}]. Google zips can hold both an original and
// a "-edited" copy; only the edited one is kept. Mac "._" files and folders are skipped.
export async function collectImages(files, onStatus = () => {}) {
  const found = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      onStatus(`Opening ${f.name}…`);
      const { entries, close } = await zipEntries(f);
      try {
        for (const e of entries) {
          const base = e.name.split("/").pop();
          if (!IMAGE_EXT.test(base) || base.startsWith(".") || e.name.includes("__MACOSX")) continue;
          found.push({ name: base, blob: await e.read(mimeOf(base)) });
        }
      } finally { await close(); }
    } else if (IMAGE_EXT.test(f.name) || f.type.startsWith("image/")) {
      found.push({ name: f.name, blob: f });
    }
  }
  const stems = new Set(found.map(f => stem(f.name)));
  return found.filter(f => !stems.has(stem(f.name) + "-edited"));
}
const stem = name => name.replace(/\.[^.]+$/, "").toLowerCase();
const mimeOf = name => ({ png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif", avif: "image/avif" })[name.split(".").pop().toLowerCase()] || "image/jpeg";

// ---------- decoding ----------
let heic2any = null;
async function toBrowserImage(name, blob) {
  if (!/\.(heic|heif)$/i.test(name) && !/hei[cf]/.test(blob.type)) return blob;
  try { await createImageBitmap(blob); return blob; } catch { /* Chrome/Edge/Firefox: convert */ }
  if (!heic2any) {
    await new Promise((resolve, reject) => {
      const s = Object.assign(document.createElement("script"), { src: "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js", onload: resolve, onerror: reject });
      document.head.append(s);
    });
    heic2any = window.heic2any;
  }
  const out = await heic2any({ blob, toType: "image/jpeg", quality: 0.92 });
  return Array.isArray(out) ? out[0] : out;
}

// A copy of `bmp` scaled to fit `max` px (the same bitmap if it already fits; never closes `bmp`).
async function fitBitmap(bmp, max) {
  if (!max || Math.max(bmp.width, bmp.height) <= max) return bmp;
  const k = max / Math.max(bmp.width, bmp.height);
  return createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: "high" });
}

// Upright bitmap (EXIF rotation applied), optionally scaled to fit `max` px.
export async function uprightBitmap(blob, max = 0) {
  const full = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const out = await fitBitmap(full, max);
  if (out !== full) full.close();
  return out;
}

// JPEG of a bitmap, on white (so see-through PNGs don't turn black).
async function bitmapToJpeg(bmp, quality) {
  const c = new OffscreenCanvas(bmp.width, bmp.height), ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  return c.convertToBlob({ type: "image/jpeg", quality });
}

export async function makeThumb(blob, max = THUMB) {
  const bmp = await uprightBitmap(blob, max);
  const out = await bitmapToJpeg(bmp, 0.85);
  bmp.close();
  return out;
}

// ---------- when & where ----------
const pad = n => String(n).padStart(2, "0");
const localIso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// HEIC keeps EXIF as a separate item: "Exif\0\0" then a TIFF header ("II*\0" or "MM\0*").
// Find it and read that TIFF block directly.
async function heicExif(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  for (let i = 0; i < bytes.length - 10; i++) {
    if (bytes[i] !== 0x45 || bytes[i + 1] !== 0x78 || bytes[i + 2] !== 0x69 || bytes[i + 3] !== 0x66 || bytes[i + 4] || bytes[i + 5]) continue; // "Exif\0\0"
    const t = i + 6, le = bytes[t] === 0x49 && bytes[t + 1] === 0x49 && bytes[t + 2] === 0x2a, be = bytes[t] === 0x4d && bytes[t + 1] === 0x4d && bytes[t + 3] === 0x2a;
    if (!le && !be) continue;
    try {
      const x = await exifr.parse(bytes.slice(t, t + 256 * 1024).buffer, { tiff: true, gps: true });
      const d = x?.DateTimeOriginal || x?.CreateDate || x?.ModifyDate;
      return { taken: d instanceof Date && !isNaN(d) ? localIso(d) : null,
        gps: typeof x?.latitude === "number" && typeof x?.longitude === "number" ? [x.latitude, x.longitude] : null };
    } catch { return { taken: null, gps: null }; }
  }
  return { taken: null, gps: null };
}

async function exifInfo(blob, name, lastModified) {
  let taken = null, gps = null;
  try {
    const x = await exifr.parse(blob, { pick: ["DateTimeOriginal", "CreateDate", "ModifyDate", "GPSLatitude", "GPSLongitude", "GPSLatitudeRef", "GPSLongitudeRef"], gps: true });
    const d = x?.DateTimeOriginal || x?.CreateDate || x?.ModifyDate;
    if (d instanceof Date && !isNaN(d)) taken = localIso(d);
    if (x && typeof x.latitude === "number" && typeof x.longitude === "number") gps = [x.latitude, x.longitude];
  } catch { /* no EXIF */ }
  if (!taken && !gps && /\.(heic|heif)$/i.test(name)) ({ taken, gps } = await heicExif(blob)); // exifr misses some HEIC layouts
  if (!taken) { // PXL_20240613_152436 style names
    const m = name.match(/(20\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (m) taken = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  }
  if (!taken && lastModified) taken = localIso(new Date(lastModified));
  return { taken, gps };
}

// ---------- faces & people ----------
let detectors = null;
async function getDetectors() {
  detectors ??= (async () => {
    const { FilesetResolver, FaceDetector, ObjectDetector } = await import(`${MP}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const make = async delegate => Promise.all([
      FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODELS.face, delegate }, runningMode: "IMAGE", minDetectionConfidence: 0.55 }),
      ObjectDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODELS.object, delegate }, runningMode: "IMAGE", scoreThreshold: 0.4, categoryAllowlist: ["person"], maxResults: 20 }),
    ]);
    let face, object;
    try { [face, object] = await make("GPU"); } catch { [face, object] = await make("CPU"); }
    return { face, object };
  })();
  return detectors;
}

// IoU-style overlap test for merging the same face found in two tiles.
function overlaps(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy, ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return inter / ua > 0.3 || inter / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])) > 0.6;
}

// Faces and people as [x0, y0, x1, y1] in the bitmap's pixels. The face model is made for faces
// filling a good part of the frame, so it also looks at overlapping tiles to catch smaller faces
// in group shots.
async function detect(bmp, { tileFrac = TILE_FRAC, minTile = TILE_MIN_SCORE } = {}) {
  const { face, object } = await getDetectors();
  const W = bmp.width, H = bmp.height;
  const faces = [];
  const addFaces = (res, ox, oy, k, src) => {
    for (const d of res.detections || []) {
      const b = d.boundingBox, score = d.categories?.[0]?.score ?? 0;
      const box = [ox + b.originX * k, oy + b.originY * k, ox + (b.originX + b.width) * k, oy + (b.originY + b.height) * k];
      // Close-up tiles also "find" faces in hands, feet and stuffed animals; only trust confident ones.
      if (src === "tile" && score < minTile) continue;
      if (!faces.some(f => overlaps(f, box))) faces.push(Object.assign(box, { score, src }));
    }
  };
  addFaces(face.detect(bmp), 0, 0, 1, "full");
  const tile = Math.round(Math.min(W, H) * tileFrac), step = Math.round(tile * 0.7);
  const c = new OffscreenCanvas(640, 640), ctx = c.getContext("2d");
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const tx = Math.min(x, W - tile), ty = Math.min(y, H - tile);
      ctx.clearRect(0, 0, 640, 640);
      ctx.drawImage(bmp, tx, ty, tile, tile, 0, 0, 640, 640);
      const piece = c.transferToImageBitmap();
      addFaces(face.detect(piece), tx, ty, tile / 640, "tile");
      piece.close();
      if (x + tile >= W) break;
    }
    if (y + tile >= H) break;
  }
  const people = (object.detect(bmp).detections || []).map(d => {
    const b = d.boundingBox;
    return [b.originX, b.originY, b.originX + b.width, b.originY + b.height];
  });
  return { faces, people };
}

// keep/soft boxes in the photo's full-size pixels, as layout.py computes them.
function regions(faces, people, W, H) {
  const pads = faces.map(f => [f[0] - 0.3 * (f[2] - f[0]), f[1] - 0.45 * (f[3] - f[1]), f[2] + 0.3 * (f[2] - f[0]), f[3] + 0.5 * (f[3] - f[1])]);
  let keep;
  if (pads.length) {
    keep = [Math.max(0, Math.min(...pads.map(p => p[0]))), Math.max(0, Math.min(...pads.map(p => p[1]))),
      Math.min(W, Math.max(...pads.map(p => p[2]))), Math.min(H, Math.max(...pads.map(p => p[3])))];
  } else if (people.length) {
    const top = Math.min(...people.map(p => p[1]));
    keep = [Math.min(...people.map(p => p[0])), top, Math.max(...people.map(p => p[2])), Math.min(H, top + 0.25 * H)];
  } else {
    keep = [W * 0.3, H * 0.25, W * 0.7, H * 0.6];
  }
  return { keep, soft: people.map(b => [b, 1.0]) };
}

// One photo: returns {blob (browser-viewable original), thumb, info}.
export async function analyzePhoto({ name, blob }) {
  const original = await toBrowserImage(name, blob);
  const full = await createImageBitmap(original, { imageOrientation: "from-image" }); // decoded once
  const W = full.width, H = full.height;
  const small = await fitBitmap(full, DETECT_SIZE); // detection works on a smaller copy
  const thumbBmp = await fitBitmap(full, THUMB);
  const thumb = await bitmapToJpeg(thumbBmp, 0.85);
  const k = W / small.width;
  let faces = [], people = [];
  try { ({ faces, people } = await detect(small)); } catch (e) { console.warn("Face detection unavailable:", e); }
  for (const b of new Set([small, thumbBmp, full])) b.close();
  const up = b => b.map(v => v * k);
  faces = faces.map(up); people = people.map(up);
  const { taken, gps } = await exifInfo(blob, name, blob.lastModified);
  const id = newId();
  const info = { id, name, w: W, h: H, ...regions(faces, people, W, H), faces: faces.length, labels: [], signs: [], gps, taken };
  return { id, blob: original, thumb, info };
}

// For tuning: faces and people found in one photo, in the detection copy's pixels.
export async function debugDetect(blob, { size = DETECT_SIZE, ...opts } = {}) {
  const small = await uprightBitmap(blob, size);
  const r = await detect(small, opts);
  return { ...r, faces: r.faces.map(f => ({ box: [...f], score: f.score, src: f.src })), bitmap: small };
}

// Warm up the models while the person is still choosing photos.
export const preload = () => getDetectors().catch(() => {});
