"""Builds the no-server GitHub Pages version of SlabScout into docs/.  Run: python3 build_pages.py"""
import os
import re
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC, OUT = os.path.join(ROOT, "static"), os.path.join(ROOT, "docs")

shutil.rmtree(OUT, ignore_errors=True)
shutil.copytree(SRC, OUT)
path = os.path.join(OUT, "index.html")
html = open(path, encoding="utf-8").read()
html = html.replace('href="/style.css"', 'href="style.css"')
html = html.replace('<script src="/app.js"></script>', '<script src="local-api.js"></script>\n<script src="app.js"></script>')
html = re.sub(r'\s*<a href="#/scan"[^>]*>.*?</a>', "", html)
assert "local-api.js" in html and "#/scan" not in html
open(path, "w", encoding="utf-8").write(html)
open(os.path.join(OUT, ".nojekyll"), "w").close()
print("Built", OUT)
