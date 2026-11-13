"""Stamp a version on the app's own files so browsers fetch every update fresh, and together.

GitHub Pages lets browsers reuse files for 10 minutes, so after an update a browser could run a
new editor.js with an old local-api.js. Every reference to an app file (index.html's stylesheet
and script, and each module import) gets ?v=<hash of all app files>. Run before committing:

    python3 tools/stamp_version.py
"""
import hashlib, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = [ROOT / "index.html", *sorted((ROOT / "app").glob("*.js")), ROOT / "app" / "style.css"]
REF = re.compile(r"""((?:\./|app/)[\w-]+\.(?:js|css))(\?v=[0-9a-f]+)?(?=["'])""")

unstamped = {f: REF.sub(r"\1", f.read_text()) for f in FILES}
digest = hashlib.sha1("".join(unstamped[f] for f in FILES).encode()).hexdigest()[:10]
changed = 0
for f, text in unstamped.items():
    stamped = REF.sub(lambda m: f"{m.group(1)}?v={digest}", text)
    if stamped != f.read_text():
        f.write_text(stamped)
        changed += 1
print(f"version {digest} ({changed} file{'s' if changed != 1 else ''} updated)")
