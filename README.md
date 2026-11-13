# Photobook Studio (web)

Lay out 8×8 Shutterfly photobook pages with lots of photos per page, faces kept in frame, and
captions under each photo. Then export 2400×2400 JPEGs, one per Shutterfly page.

This is the browser version of the Mac app ([photobook-studio-mac](https://github.com/calebleehill1993/photobook-studio-mac)).
It runs entirely in the browser on any computer (Windows, Mac, Chromebook). Nothing to install.

## Where things live

- **The app** (code, fonts, backgrounds) is static files in this repo. The website serves them, and anyone who
  opens it gets the same backgrounds.
- **Books and photos** are saved in the visitor's own browser (IndexedDB), on their own computer. Nothing is
  uploaded. **Save book file** writes a `.photobook` file (a zip of the book and its photos) for backups or for
  moving to another computer; **Open book file** brings one back.

## Status

Working in the browser: making a book from photos or a Google Photos .zip (iPhone HEIC included),
face-aware auto-layout, the full editor (crop, rotation, multi-select, text boxes, caption boxes,
spelling, undo, History), and export of 2400×2400 JPEGs (one at a time or as a .zip). Books are saved
in the browser, with **Save book file** / **Open book file** for backups and moving between computers.

Checked against the Mac build: the same book exports pixel-for-pixel alike, and face finding gets
96 of the Mac's 101 faces on a set of group photos (no false ones on a set of baby photos).

Not yet: place names in starter captions and titles (the Mac used Apple's map lookup), scene
captions ("Ice cream stop", "By the water") and sign reading. Starter text is date-based for now.

## Files

- `index.html`, `app/style.css`: the page
- `app/editor.js`: the editor (from the Mac build's `static/app.js`)
- `app/local-api.js`: answers the editor's requests from browser storage (the Mac build's `app.py`)
- `app/storage.js`: IndexedDB storage, History versions, `.photobook` files
- `app/analyze.js`: importing photos, EXIF, HEIC, face/person detection (MediaPipe)
- `app/layout.js`: auto-layout, face-safe crops, starter captions/titles (the Mac build's `layout.py`/`describe.py`)
- `app/spell.js`: spell check (Hunspell English dictionary via Typo.js)

Libraries load from jsDelivr at pinned versions; MediaPipe's models load from Google's model storage.

## Moving books over from the Mac build

In the Mac build's folder: `.venv/bin/python tools/export_book.py <book-folder>` (or `--all <folder>`)
writes `.photobook` files; open them here with **Open book file**.

## Try it locally

    python3 -m http.server 5077

then open http://localhost:5077. (Any static file server works. Chrome refuses some ports, such as 5060.)

## Credits

Background photos `month-NN-photo-*` are from Unsplash (see `assets/backgrounds/CREDITS.txt`); fonts are from
Google Fonts (Open Font License).
