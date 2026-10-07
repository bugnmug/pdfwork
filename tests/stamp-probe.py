"""stamp-probe.py <file.pdf> [RRGGBB]: each page as a reader shows it (turned and cropped), as JSON.

Per page: its size, the words with their boxes ([x0, y0, x1, y1, word], points from the top
left of the visible page), whether its content marks things as artifacts (page furniture),
and, given a colour, the box of everything drawn tinted like it (its strongest channel
clearly above the other two), even when drawn see-through.
"""
import json, re, sys
import pymupdf
from PIL import Image, ImageChops

DPI = 36
d = pymupdf.open(sys.argv[1])
ink = sys.argv[2] if len(sys.argv) > 2 else None
out = []
for p in d:
    m = p.rotation_matrix
    words = []
    for w in p.get_text("words"):
        r = pymupdf.Rect(w[:4]) * m
        words.append([round(r.x0, 1), round(r.y0, 1), round(r.x1, 1), round(r.y1, 1), w[4]])
    box = None
    if ink:
        pm = p.get_pixmap(dpi=DPI, alpha=False)
        bands = Image.frombytes("RGB", (pm.width, pm.height), pm.samples).split()
        rgb = [int(ink[i : i + 2], 16) for i in (0, 2, 4)]
        top = rgb.index(max(rgb))
        over = lambda other: ImageChops.subtract(bands[top], bands[other]).point(lambda v: 255 if v > 20 else 0)
        a, b = [over(i) for i in range(3) if i != top]
        bb = ImageChops.multiply(a, b).getbbox()
        if bb:
            box = [round(v * 72 / DPI, 1) for v in bb]
    content = p.read_contents()
    out.append({
        "w": round(p.rect.width, 1),
        "h": round(p.rect.height, 1),
        "words": words,
        "ink": box,
        "artifacts": sorted({s.decode() for s in re.findall(rb"/Artifact\s*<<[^>]*/Subtype\s*/(\w+)", content)}),
    })
print(json.dumps(out, ensure_ascii=False))
