#!/usr/bin/env python3
"""Dump a .pptx as JSON for the tests: slide size, and per slide its background, pictures and
text boxes (position in points, rotation, wrapping, paragraphs with alignment, bullets and line
spacing, runs with font, size, colour, weight, letter-spacing, raise, underline and link).

With the original PDF as a second argument, also renders the .pptx with LibreOffice and reports
how far each word's baseline and start moved from the PDF (points), per slide.

    python3 pptx-dump.py deck.pptx [original.pdf]
"""
import json, os, subprocess, sys, tempfile, zipfile
import xml.etree.ElementTree as ET

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
EMU = 12700.0
R = "{%s}" % NS["r"]


def rels(z, part):
    d = os.path.dirname(part)
    path = f"{d}/_rels/{os.path.basename(part)}.rels"
    out = {}
    if path in z.namelist():
        for rel in ET.fromstring(z.read(path)):
            out[rel.get("Id")] = (rel.get("Target"), rel.get("TargetMode"))
    return out


def run(r, rl):
    rp = r.find("a:rPr", NS)
    o = {"text": (r.findtext("a:t", "", NS))}
    if rp is not None:
        if rp.get("sz"): o["size"] = int(rp.get("sz")) / 100
        if rp.get("b") == "1": o["bold"] = True
        if rp.get("i") == "1": o["italic"] = True
        if rp.get("u"): o["underline"] = rp.get("u")
        if rp.get("spc"): o["spc"] = int(rp.get("spc")) / 100
        if rp.get("baseline"): o["baseline"] = int(rp.get("baseline")) / 1000
        c = rp.find("a:solidFill/a:srgbClr", NS)
        if c is not None: o["color"] = c.get("val")
        f = rp.find("a:latin", NS)
        if f is not None: o["font"] = f.get("typeface")
        h = rp.find("a:hlinkClick", NS)
        if h is not None: o["link"] = rl.get(h.get(R + "id"), (None,))[0]
    return o


def para(p, rl):
    pp = p.find("a:pPr", NS)
    o = {"runs": [], "text": ""}
    for el in p:
        tag = el.tag.split("}")[1]
        if tag == "r":
            o["runs"].append(run(el, rl))
            o["text"] += o["runs"][-1]["text"]
        elif tag == "br":
            o["text"] += "\n"
    if pp is not None:
        o["align"] = pp.get("algn", "l")
        if pp.get("marL"): o["marL"] = int(pp.get("marL")) / EMU
        if pp.get("indent"): o["indent"] = int(pp.get("indent")) / EMU
        s = pp.find("a:lnSpc/a:spcPct", NS)
        if s is not None: o["spacing"] = {"pct": int(s.get("val")) / 100000}
        s = pp.find("a:lnSpc/a:spcPts", NS)
        if s is not None: o["spacing"] = {"pts": int(s.get("val")) / 100}
        s = pp.find("a:spcBef/a:spcPts", NS)
        if s is not None: o["before"] = int(s.get("val")) / 100
        b = pp.find("a:buChar", NS)
        if b is not None: o["bullet"] = b.get("char")
        b = pp.find("a:buAutoNum", NS)
        if b is not None: o["bullet"] = b.get("type") + ("@" + b.get("startAt") if b.get("startAt") else "")
        c = pp.find("a:buClr/a:srgbClr", NS)
        if c is not None: o["bulletColor"] = c.get("val")
    return o


def geom(el):
    x = el.find(".//a:xfrm", NS)
    off, ext = x.find("a:off", NS), x.find("a:ext", NS)
    g = {"x": int(off.get("x")) / EMU, "y": int(off.get("y")) / EMU, "w": int(ext.get("cx")) / EMU, "h": int(ext.get("cy")) / EMU}
    if x.get("rot"): g["rot"] = int(x.get("rot")) / 60000
    return g


def dump(path):
    z = zipfile.ZipFile(path)
    pres = ET.fromstring(z.read("ppt/presentation.xml"))
    sz = pres.find("p:sldSz", NS)
    prel = rels(z, "ppt/presentation.xml")
    out = {"width": int(sz.get("cx")) / EMU, "height": int(sz.get("cy")) / EMU, "slides": []}
    for sid in pres.find("p:sldIdLst", NS):
        part = "ppt/" + prel[sid.get(R + "id")][0]
        rl = rels(z, part)
        root = ET.fromstring(z.read(part))
        s = {"background": None, "pictures": [], "texts": [], "notes": False}
        bg = root.find("p:cSld/p:bg/p:bgPr", NS)
        if bg is not None:
            blip = bg.find("a:blipFill/a:blip", NS)
            col = bg.find("a:solidFill/a:srgbClr", NS)
            s["background"] = {"image": rl[blip.get(R + "embed")][0]} if blip is not None else {"color": col.get("val")} if col is not None else None
        for el in root.find("p:cSld/p:spTree", NS):
            tag = el.tag.split("}")[1]
            if tag == "pic":
                blip = el.find(".//a:blip", NS)
                pic = {**geom(el), "image": rl[blip.get(R + "embed")][0]}
                src = el.find(".//a:srcRect", NS)
                if src is not None and src.attrib: pic["crop"] = {k: int(v) / 100000 for k, v in src.attrib.items()}
                s["pictures"].append(pic)
            elif tag == "sp":
                body = el.find("p:txBody", NS)
                if body is None: continue
                bp = body.find("a:bodyPr", NS)
                t = {**geom(el), "wrap": bp.get("wrap") != "none", "anchor": bp.get("anchor", "t"), "paras": [para(p, rl) for p in body.findall("a:p", NS)]}
                t["text"] = "\n".join(p["text"] for p in t["paras"])
                s["texts"].append(t)
        s["notes"] = any(v[0].startswith("../notesSlides/") for v in rl.values())
        out["slides"].append(s)
    return out


def words(page):
    out = []
    for b in page.get_text("rawdict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                cur = None
                for ch in s["chars"]:
                    if ch["c"].isspace():
                        cur = None
                        continue
                    if cur is None:
                        cur = ["", ch["origin"][0], ch["origin"][1]]
                        out.append(cur)
                    cur[0] += ch["c"]
    return out


def placement(pptx, pdf):
    """Per slide: words matched, and the median and 90th percentile of how far baselines and starts moved (points)."""
    import pymupdf
    d = tempfile.mkdtemp()
    subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", d, pptx], capture_output=True, timeout=180)
    rendered = os.path.join(d, os.path.splitext(os.path.basename(pptx))[0] + ".pdf")
    if not os.path.exists(rendered): return None
    a, b = pymupdf.open(pdf), pymupdf.open(rendered)
    res = []
    for i in range(min(len(a), len(b))):
        wa, wb = words(a[i]), words(b[i])
        pairs = sorted((abs(q[1] - p[1]) + abs(q[2] - p[2]) * 3, ia, ib) for ia, p in enumerate(wa) for ib, q in enumerate(wb) if p[0] == q[0])
        da, db, dy, dx = set(), set(), [], []
        for _, ia, ib in pairs:
            if ia in da or ib in db: continue
            da.add(ia); db.add(ib)
            dy.append(abs(wb[ib][2] - wa[ia][2])); dx.append(abs(wb[ib][1] - wa[ia][1]))
        dy.sort(); dx.sort()
        q = lambda v, f: round(v[min(len(v) - 1, int(len(v) * f))], 2) if v else None
        res.append({"words": len(wa), "matched": len(dy), "dy50": q(dy, 0.5), "dy90": q(dy, 0.9), "dx50": q(dx, 0.5), "dx90": q(dx, 0.9)})
    return res


if __name__ == "__main__":
    o = dump(sys.argv[1])
    if len(sys.argv) > 2: o["placement"] = placement(sys.argv[1], sys.argv[2])
    print(json.dumps(o))
