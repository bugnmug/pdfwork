"""colour-probe.py <before.pdf> <after.pdf>: how a colour change went, page by page, as JSON.

For each page of the result: how many rendered pixels still have colour (a channel more than
30 levels from the others), how many differ in lightness from the original by more than 48
levels (grey should keep each colour's lightness; the margin covers the different weightings of
luminance), the text that can be extracted, the colour spaces of its pictures and whether the
page is drawn by one full-page picture.
"""
import json, sys
import pymupdf
from PIL import Image, ImageChops

a, b = pymupdf.open(sys.argv[1]), pymupdf.open(sys.argv[2])
out = []
for i in range(b.page_count):
    pb = b[i].get_pixmap(dpi=50, alpha=False)
    ib = Image.frombytes("RGB", (pb.width, pb.height), pb.samples)
    r, g, bl = ib.split()
    coloured = sum(ImageChops.difference(r, g).histogram()[31:]) + sum(ImageChops.difference(g, bl).histogram()[31:])
    lighter = None
    if i < a.page_count:
        pa = a[i].get_pixmap(dpi=50, alpha=False)
        ia = Image.frombytes("RGB", (pa.width, pa.height), pa.samples)
        if ia.size == ib.size:
            lighter = sum(ImageChops.difference(ia.convert("L"), ib.convert("L")).histogram()[49:])
    page = b[i]
    images = []
    for img in page.get_images(full=True):
        images.append(img[5])
    box = page.cropbox  # (picture boxes come unturned, like the crop box)
    full = any(abs(r.width - box.width) < 2 and abs(r.height - box.height) < 2 for img in page.get_images(full=True) for r in page.get_image_rects(img[0]))
    out.append({"coloured": coloured, "lightness": lighter, "text": page.get_text(), "images": images, "fullPagePicture": full, "links": len(page.get_links())})
print(json.dumps({"pages": out, "toc": len(b.get_toc())}, ensure_ascii=False))
