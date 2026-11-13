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

Early: the storage layer (`app/storage.js`) and a test page (`index.html`) that saves books in the browser,
keeps them across reloads, and saves/opens book files.

Next:
1. Editor (from the Mac build's `static/app.js`) on top of browser storage
2. Import: Google Photos .zip, EXIF dates/GPS, HEIC
3. Auto-layout and face-safe cropping (port of `layout.py`), faces/people via MediaPipe
4. Export: page rendering on a canvas, download as .zip
5. Starter captions/titles (offline town list), spell check (bundled dictionary)
6. Move books over from the Mac build; compare exports page for page

## Try it locally

    python3 -m http.server 5077

then open http://localhost:5077. (Any static file server works. Chrome refuses some ports, such as 5060.)

## Credits

Background photos `month-NN-photo-*` are from Unsplash (see `assets/backgrounds/CREDITS.txt`); fonts are from
Google Fonts (Open Font License).
