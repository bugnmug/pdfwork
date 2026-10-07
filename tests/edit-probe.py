"""edit-probe.py <before.pdf> <after.pdf> <page> <x> <y> <w> <h>: what an edit inside a box changed, as JSON.

The box is on the page as seen (points from the top left, y down). Reports the page's text
after the edit, the words in the box, the words outside it that moved or changed (there should
be none), how many rendered pixels changed outside the box (there should be none; the box is
widened to the right, where longer new text may run) and inside it, and the fonts on the page.
"""
import json, sys
import pymupdf
from PIL import Image, ImageChops, ImageDraw

before, after, page = sys.argv[1], sys.argv[2], int(sys.argv[3]) - 1
x, y, w, h = (float(v) for v in sys.argv[4:8])
box = (x - 2, y - 2, x + w + 2, y + h + 2)


def words(path):
    p = pymupdf.open(path)[page]
    m = p.rotation_matrix
    out = []
    for wd in p.get_text("words"):
        r = pymupdf.Rect(wd[:4]) * m
        out.append([round(r.x0, 1), round(r.y0, 1), round(r.x1, 1), round(r.y1, 1), wd[4]])
    return out, p.get_text()


inside = lambda wd: box[0] <= (wd[0] + wd[2]) / 2 <= box[2] and box[1] <= (wd[1] + wd[3]) / 2 <= box[3]
wb, _ = words(before)
wa, text = words(after)
ob = [wd for wd in wb if not inside(wd)]
oa = [wd for wd in wa if not inside(wd)]
# New words may run past the box on its line: only words that were there before must stay put.
moved = [b for b in ob if not any(a[4] == b[4] and max(abs(a[i] - b[i]) for i in range(4)) <= 0.3 for a in oa)]
dpi = 100
k = dpi / 72
ims = []
for path in (before, after):
    pm = pymupdf.open(path)[page].get_pixmap(dpi=dpi, alpha=False)
    ims.append(Image.frombytes("RGB", (pm.width, pm.height), pm.samples))
diff = ImageChops.difference(ims[0], ims[1]).convert("L").point(lambda v: 255 if v > 40 else 0)
mask = Image.new("L", diff.size, 255)
ImageDraw.Draw(mask).rectangle([int((box[0] - 1) * k), int((box[1] - 2) * k), int((box[2] + 80) * k), int((box[3] + 2) * k)], fill=0)
changed = ImageChops.multiply(diff, mask).histogram()[255]
changed_in = diff.crop((int(box[0] * k), int(box[1] * k), int(box[2] * k), int(box[3] * k))).histogram()[255]
print(json.dumps({
    "text": text,
    "inBox": " ".join(wd[4] for wd in wa if inside(wd)),
    "moved": moved[:5],
    "pixelsOutside": changed,
    "pixelsInside": changed_in,
    "fonts": sorted({f[3] for f in pymupdf.open(after)[page].get_fonts()}),
}, ensure_ascii=False))
