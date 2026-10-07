"""repair-probe.py <original.pdf> <repaired.pdf>: how much of the original a repaired file keeps, as JSON.

Read the way a strict viewer reads it (Poppler). pages: page counts (original, repaired). words:
share of the original's words found in the repaired file (by count); junk: words in the repaired
file the original doesn't have. look: per page, share of the original's detail (ink, and paper
inside dark areas, at 60 dpi) that the repaired page has at the same place, within one pixel.
errors: complaints from Poppler and MuPDF while reading every page of the repaired file, with the
first one. links and toc: links per page and bookmarks of the repaired file.
"""
import glob, json, os, re, subprocess, sys, tempfile
from collections import Counter
import numpy as np
import pymupdf
from PIL import Image
from scipy.ndimage import maximum_filter, minimum_filter

pymupdf.TOOLS.mupdf_display_errors(False)
orig, cand = sys.argv[1], sys.argv[2]


def pages_of(path):
    r = subprocess.run(["pdfinfo", path], capture_output=True, text=True)
    m = re.search(r"Pages:\s+(\d+)", r.stdout)
    return int(m.group(1)) if m else 0, [l for l in r.stderr.splitlines() if l.strip()]


def text_of(path):
    r = subprocess.run(["pdftotext", path, "-"], capture_output=True, text=True, errors="replace")
    return r.stdout, [l for l in r.stderr.splitlines() if l.strip()]


def renders(path, tmp, tag):
    subprocess.run(["pdftoppm", "-q", "-r", "60", "-gray", path, os.path.join(tmp, tag)], capture_output=True)
    files = sorted(glob.glob(os.path.join(tmp, tag + "*.pgm")), key=lambda f: int(re.search(r"-(\d+)\.pgm$", f).group(1)))
    return [np.asarray(Image.open(f), dtype=np.int16) for f in files]


out = {}
na, _ = pages_of(orig)
nb, errs = pages_of(cand)
out["pages"] = [na, nb]
ta, _ = text_of(orig)
tb, e2 = text_of(cand)
errs += e2
words = lambda t: Counter(re.findall(r"\w+", t))
wa, wb = words(ta), words(tb)
out["words"] = round(sum(min(c, wb[w]) for w, c in wa.items()) / (sum(wa.values()) or 1), 3)
out["junk"] = sum(max(0, c - wa[w]) for w, c in wb.items())
with tempfile.TemporaryDirectory() as tmp:
    look = []
    for a, b in zip(renders(orig, tmp, "a"), renders(cand, tmp, "b")):
        if a.shape != b.shape:
            b = np.asarray(Image.fromarray(b.astype(np.uint8)).resize((a.shape[1], a.shape[0])), dtype=np.int16)
        lost = (a < minimum_filter(b, 3) - 60) | (a > maximum_filter(b, 3) + 60)
        detail = max(1, int(((a < 200) | (np.abs(a - maximum_filter(a, 3)) > 60)).sum()))
        look.append(round(1 - lost.sum() / detail, 3))
    out["look"] = look
pymupdf.TOOLS.reset_mupdf_warnings()
d = pymupdf.open(cand)
for p in d:
    p.get_text()
    p.get_pixmap(dpi=20)
errs += [l for l in pymupdf.TOOLS.mupdf_warnings().splitlines() if l.strip()]
out["errors"] = len(errs)
out["firstError"] = errs[0][:160] if errs else None
out["links"] = [len(p.get_links()) for p in d]
out["toc"] = len(d.get_toc())
print(json.dumps(out))
