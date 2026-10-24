"""Outlines the wordmark from Unbounded at weight 800 into brand/fonts/wordmark.json.
Run when the name or the font changes:  /tmp/dt-venv/bin/python scripts/outline-wordmark.py   (needs fonttools and brotli)
scripts/brand.mjs reads the JSON, so it needs no Python."""
import json
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

TEXT = "kennel"
SRC = "node_modules/@fontsource-variable/unbounded/files/unbounded-latin-wght-normal.woff2"

font = instancer.instantiateVariableFont(TTFont(SRC), {"wght": 800})
upm = font["head"].unitsPerEm
TRACKING = round(-0.04 * upm)
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
fmt = lambda v: ("%.1f" % v).rstrip("0").rstrip(".")
pen = SVGPathPen(glyphs, ntos=fmt)
bounds = BoundsPen(glyphs)
x = 0
for ch in TEXT:
    g = glyphs[cmap[ord(ch)]]
    flip = (1, 0, 0, -1, x, 0)  # SVG's y axis points down
    g.draw(TransformPen(pen, flip))
    g.draw(TransformPen(bounds, flip))
    x += g.width + TRACKING

x1, y1, x2, y2 = bounds.bounds
json.dump({"text": TEXT, "unitsPerEm": upm, "d": pen.getCommands(), "x1": x1, "y1": y1, "x2": x2, "y2": y2}, open("brand/fonts/wordmark.json", "w"))
print("wordmark outlined:", round(x2 - x1), "x", round(y2 - y1), "units, em", upm)
