"""pdfa-check.py <file.pdf> [1|2|3]: the PDF/A rules most files break, checked one by one (JSON).

Not a full validator (veraPDF is), but it covers what conversions get wrong in practice: the
file identity and metadata (no encryption, an /ID, XMP with pdfaid and an OutputIntent with an
ICC profile), fonts not embedded, transparency in PDF/A-1, colours the output intent doesn't
describe (CMYK under an RGB intent), JavaScript, launch actions and other active content,
embedded files, annotations that don't print or have no appearance, NeedAppearances, image
interpolation, optional content and LZW compression in PDF/A-1. Each problem is listed with
where it was found.
"""
import json, re, sys
import pikepdf
from pikepdf import Name

path = sys.argv[1]
part = int(sys.argv[2]) if len(sys.argv) > 2 else 2
problems = []
note = lambda kind, where="": problems.append(f"{kind}{' (' + where + ')' if where else ''}")

pdf = pikepdf.open(path)
root = pdf.Root
if pdf.is_encrypted or "/Encrypt" in pdf.trailer:
    note("encrypted")
if "/ID" not in pdf.trailer:
    note("no file ID")
meta = root.get("/Metadata")
xmp = bytes(meta.read_bytes()).decode("utf-8", "replace") if meta is not None else ""
m = re.search(r"pdfaid:part[^0-9]*(\d)", xmp)
if not m:
    note("no pdfaid in XMP")
elif int(m.group(1)) != part:
    note("XMP says part " + m.group(1))
intents = root.get("/OutputIntents")
rgb_intent = cmyk_intent = False
if not intents or not any(str(i.get("/S")) == "/GTS_PDFA1" and "/DestOutputProfile" in i for i in intents):
    note("no PDF/A output intent with an ICC profile")
else:
    for i in intents:
        prof = i.get("/DestOutputProfile")
        if prof is not None:
            n = int(prof.get("/N", 3))
            rgb_intent |= n == 3
            cmyk_intent |= n == 4
names = root.get("/Names")
if names is not None and "/JavaScript" in names:
    note("document JavaScript")
if names is not None and "/EmbeddedFiles" in names and part < 3:
    note("embedded files")
oa = root.get("/OpenAction")
if isinstance(oa, pikepdf.Dictionary) and str(oa.get("/S")) in ("/JavaScript", "/Launch"):
    note("open action " + str(oa.get("/S")))
if "/AA" in root:
    note("catalog additional actions")
acro = root.get("/AcroForm")
if acro is not None:
    if "/XFA" in acro:
        note("XFA form")
    if bool(acro.get("/NeedAppearances", False)):
        note("NeedAppearances true")
if part == 1 and "/OCProperties" in root:
    note("optional content (PDF/A-1)")

seen = set()
fonts_bad = {}
def font_ok(f):
    st = str(f.get("/Subtype"))
    if st == "/Type3":
        return True
    if st == "/Type0":
        d = f.get("/DescendantFonts")
        if d is None or len(d) == 0:
            return False
        f = d[0]
    fd = f.get("/FontDescriptor")
    return fd is not None and any(k in fd for k in ("/FontFile", "/FontFile2", "/FontFile3"))

def check_resources(res, where, depth=0):
    if res is None or depth > 8:
        return
    try:
        key = res.objgen if res.is_indirect else None
    except Exception:
        key = None
    if key and key in seen:
        return
    if key:
        seen.add(key)
    fonts = res.get("/Font")
    if fonts is not None:
        for name, f in fonts.items():
            if not font_ok(f):
                fonts_bad[str(f.get("/BaseFont"))] = where
            if str(f.get("/Subtype")) == "/Type3":
                check_resources(f.get("/Resources"), where + " Type3", depth + 1)
    gs = res.get("/ExtGState")
    if gs is not None and part == 1:
        for name, g in gs.items():
            if float(g.get("/CA", 1)) != 1 or float(g.get("/ca", 1)) != 1:
                note("transparency (CA/ca)", where)
            if "/SMask" in g and str(g.get("/SMask")) != "/None":
                note("soft mask", where)
            if "/BM" in g and str(g.get("/BM")) not in ("/Normal", "/Compatible"):
                note("blend mode " + str(g.get("/BM")), where)
    cs = res.get("/ColorSpace")
    if cs is not None:
        for name, c in cs.items():
            if str(c) == "/DeviceCMYK" and not cmyk_intent and "/DefaultCMYK" not in cs:
                note("CMYK colour without a CMYK intent", where)
    xo = res.get("/XObject")
    if xo is not None:
        for name, x in xo.items():
            st = str(x.get("/Subtype"))
            if st == "/Image":
                if bool(x.get("/Interpolate", False)):
                    note("image interpolation", where)
                if part == 1 and "/SMask" in x:
                    note("image soft mask (PDF/A-1)", where)
                filt = x.get("/Filter")
                if part == 1 and filt is not None and "LZW" in str(filt):
                    note("LZW", where)
                if str(x.get("/ColorSpace")) == "/DeviceCMYK" and not cmyk_intent:
                    note("CMYK image without a CMYK intent", where)
            elif st == "/Form":
                if part == 1 and "/Group" in x and str(x.Group.get("/S")) == "/Transparency":
                    note("transparency group (PDF/A-1)", where)
                check_resources(x.get("/Resources"), where + " form", depth + 1)

def content_cmyk(page):
    try:
        data = page.Contents.read_bytes() if not isinstance(page.Contents, pikepdf.Array) else b"".join(c.read_bytes() for c in page.Contents)
    except Exception:
        return False
    return bool(re.search(rb"(^|\s)[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[kK](\s|$)", data))

for i, page in enumerate(pdf.pages, 1):
    where = f"page {i}"
    obj = page.obj
    check_resources(obj.get("/Resources"), where)
    if part == 1 and "/Group" in obj and str(obj.Group.get("/S")) == "/Transparency":
        note("page transparency group (PDF/A-1)", where)
    if "/AA" in obj:
        note("page additional actions", where)
    if not cmyk_intent and "/Contents" in obj and content_cmyk(obj):
        note("CMYK colour operators without a CMYK intent", where)
    for a in obj.get("/Annots", []):
        st = str(a.get("/Subtype"))
        flags = int(a.get("/F", 0))
        if st != "/Popup" and (not flags & 4 or flags & (1 | 2 | 32)):
            note(f"annotation {st} not set to print (F={flags})", where)
        if st not in ("/Popup", "/Link") and "/AP" not in a:
            r = [float(v) for v in a.get("/Rect", [0, 0, 0, 0])]
            if abs(r[2] - r[0]) > 0 and abs(r[3] - r[1]) > 0:
                note(f"annotation {st} without appearance", where)
        act = a.get("/A")
        if act is not None and str(act.get("/S")) in ("/JavaScript", "/Launch", "/Sound", "/Movie", "/ResetForm", "/ImportData"):
            note("annotation action " + str(act.get("/S")), where)
        if "/AA" in a:
            note("annotation additional actions", where)
        ap = a.get("/AP")
        if ap is not None:
            for k in ("/N", "/R", "/D"):
                s = ap.get(k)
                if isinstance(s, pikepdf.Stream):
                    check_resources(s.get("/Resources"), where + " annotation")
                elif isinstance(s, pikepdf.Dictionary):
                    for _, sub in s.items():
                        if isinstance(sub, pikepdf.Stream):
                            check_resources(sub.get("/Resources"), where + " annotation")
for name, where in fonts_bad.items():
    note("font not embedded: " + name, where)
print(json.dumps({"part": part, "ok": not problems, "problems": problems[:60], "count": len(problems)}, ensure_ascii=False))
