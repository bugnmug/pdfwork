"""pdf-probe.py <file.pdf>: what a PDF's pages hold, as JSON, for the checks in cases.mjs.

Per page: size, text, words with their boxes ([x0, y0, x1, y1, word], y down from the top),
spans of text with their colour and size, links, fill colours, stroked lines, picture boxes,
font names and how many vector drawings there are. Also the outline (bookmarks).
"""
import json, sys
import pymupdf

hexof = lambda c: "%02x%02x%02x" % tuple(round(v * 255) for v in c[:3])
r1 = lambda v: None if v != v else round(v, 1)  # (NaN, as in a link with no left edge, is not JSON)
d = pymupdf.open(sys.argv[1])
out = {"toc": d.get_toc(), "pages": []}
for p in d:
    drawings = p.get_drawings()
    strokes = []
    for x in drawings:
        if not x.get("color"):
            continue
        for it in x["items"]:
            if it[0] == "l":
                strokes.append({"color": hexof(x["color"]), "width": r1(x.get("width") or 0), "line": [r1(it[1].x), r1(it[1].y), r1(it[2].x), r1(it[2].y)]})
    links = []
    for l in p.get_links():
        to = l.get("to")
        links.append({"kind": l["kind"], "uri": l.get("uri"), "page": l.get("page"), "to": [r1(to.x), r1(to.y)] if to else None, "rect": [r1(v) for v in l["from"]]})
    out["pages"].append({
        "w": r1(p.rect.width),
        "h": r1(p.rect.height),
        "text": p.get_text(),
        "words": [[r1(v) for v in w[:4]] + [w[4]] for w in p.get_text("words")],
        "spans": [[r1(v) for v in sp["bbox"]] + [sp["text"], "%06x" % sp["color"], r1(sp["size"])] for b in p.get_text("dict")["blocks"] for l in b.get("lines", []) for sp in l["spans"] if sp["text"].strip()],
        "links": links,
        "fills": sorted({hexof(x["fill"]) for x in drawings if x.get("fill")}),
        "strokes": strokes,
        "images": [[r1(v) for v in rect] for img in p.get_images(full=True) for rect in p.get_image_rects(img[0])],
        "fonts": sorted({f[3] for f in p.get_fonts()}),
        "drawings": len(drawings),
    })
print(json.dumps(out, ensure_ascii=False))
