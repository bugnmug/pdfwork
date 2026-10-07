"""Generate realistic fixtures for exercising every PDF tool."""
import io, os, subprocess, zipfile, math, random
import pymupdf
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from pptx import Presentation
from pptx.util import Inches as PInches, Pt as PPt
from pptx.dml.color import RGBColor as PRGB
import openpyxl

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
os.makedirs(OUT, exist_ok=True)
random.seed(7)


def photo(w=1600, h=1100, seed=1):
    random.seed(seed)
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (
                int(128 + 100 * math.sin(x / 90 + seed)),
                int(128 + 90 * math.cos(y / 70)),
                int(128 + 80 * math.sin((x + y) / 120)),
            )
    d = ImageDraw.Draw(img)
    for _ in range(40):
        x, y = random.randint(0, w), random.randint(0, h)
        r = random.randint(20, 140)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)))
    img = img.filter(ImageFilter.GaussianBlur(2))
    for _ in range(3000):  # grain so JPEG is not trivially tiny
        x, y = random.randint(0, w - 1), random.randint(0, h - 1)
        px[x, y] = (random.randint(0, 255),) * 3
    return img


def save_img(img, fmt, **kw):
    b = io.BytesIO()
    img.save(b, fmt, **kw)
    return b.getvalue()


big = photo()
jpg_bytes = save_img(big, "JPEG", quality=95)
open(os.path.join(OUT, "photo.jpg"), "wb").write(jpg_bytes)
logo = Image.new("RGBA", (400, 220), (0, 0, 0, 0))
dl = ImageDraw.Draw(logo)
dl.rounded_rectangle([10, 10, 390, 210], 30, fill=(180, 35, 24, 255))
dl.ellipse([40, 40, 180, 180], fill=(255, 250, 242, 200))
logo_png = save_img(logo, "PNG")
open(os.path.join(OUT, "logo.png"), "wb").write(logo_png)
open(os.path.join(OUT, "pic.webp"), "wb").write(save_img(photo(800, 600, 3), "WEBP", quality=80))
thumb = Image.new("RGB", (300, 360), "white")
dt = ImageDraw.Draw(thumb)
for i in range(14):
    dt.ellipse([60 + i * 6, 40 + i * 8, 240 - i * 6, 320 - i * 8], outline=(40, 40, 120), width=3)
open(os.path.join(OUT, "thumb.png"), "wb").write(save_img(thumb, "PNG"))

# ---------- text.pdf : 4 pages, outline, images, table, PII, rotated page ----------
doc = pymupdf.open()
W, H = pymupdf.paper_size("a4")
p1 = doc.new_page(width=W, height=H)
p1.insert_text((56, 80), "Quarterly Operations Report", fontsize=24, fontname="hebo")
p1.insert_text((56, 104), "Prepared for the board, Q3 2026", fontsize=12, fontname="heit")
body = (
    "This report summarises operations for the quarter. Revenue grew steadily while costs stayed flat. "
    "The team shipped three major releases and closed forty-two support escalations. "
    "Contact the finance lead at priya.sharma@example.com or call +91 81234 50987 for questions. "
    "Vendor PAN ABCDE1234F and GSTIN 27ABCDE1234F1Z5 are on file. Card on record 4111 1111 1111 1111. "
    "Aadhaar reference 2345 6789 0123 was verified by the auditor."
)
rect = pymupdf.Rect(56, 130, W - 56, 400)
p1.insert_textbox(rect, body, fontsize=11, fontname="helv")
p1.insert_text((56, 430), "Highlights", fontsize=16, fontname="hebo")
for i, line in enumerate([
    "Customer retention improved to 94 percent.",
    "Average response time dropped from 9 hours to 4 hours.",
    "Two new enterprise accounts signed in September.",
]):
    p1.insert_text((72, 456 + i * 18), "- " + line, fontsize=11, fontname="helv")

p2 = doc.new_page(width=W, height=H)
p2.insert_text((56, 80), "Chapter A: Field Photos", fontsize=18, fontname="hebo")
p2.insert_image(pymupdf.Rect(56, 100, 356, 306), stream=jpg_bytes)
p2.insert_image(pymupdf.Rect(370, 100, 540, 194), stream=logo_png)
p2.insert_textbox(pymupdf.Rect(56, 330, W - 56, 420), "Photos from the September site visit. The logo is a transparent PNG.", fontsize=11, fontname="helv")

p3 = doc.new_page(width=W, height=H)
p3.insert_text((56, 80), "INVOICE", fontsize=20, fontname="hebo")
p3.insert_text((56, 104), "Invoice number INV-2026-0042", fontsize=11, fontname="helv")
cols = [56, 250, 330, 420]
heads = ["Item", "Qty", "Unit price", "Amount"]
rows = [["Consulting hours", "12", "1500.00", "18000.00"], ["Cloud hosting", "1", "4200.50", "4200.50"], ["Support plan", "3", "999.00", "2997.00"], ["Training workshop", "2", "7500.00", "15000.00"]]
for c, h in zip(cols, heads):
    p3.insert_text((c, 150), h, fontsize=11, fontname="hebo")
for r, row in enumerate(rows):
    for c, v in zip(cols, row):
        p3.insert_text((c, 172 + r * 20), v, fontsize=11, fontname="helv")
p3.insert_text((330, 172 + 4 * 20 + 10), "Total", fontsize=11, fontname="hebo")
p3.insert_text((420, 172 + 4 * 20 + 10), "40197.50", fontsize=11, fontname="hebo")

p4 = doc.new_page(width=W, height=H)
p4.insert_text((56, 80), "Chapter B: Appendix", fontsize=18, fontname="hebo")
p4.insert_textbox(pymupdf.Rect(56, 100, W - 56, 300), "This appendix page is stored rotated by 90 degrees to test rotation handling in stamping tools.", fontsize=11, fontname="helv")
p4.set_rotation(90)
doc.set_toc([[1, "Introduction", 1], [1, "Chapter A", 2], [2, "Photos", 2], [1, "Invoice", 3], [1, "Chapter B", 4]])
doc.set_metadata({"title": "Quarterly Operations Report", "author": "Ops Team", "subject": "Q3", "keywords": "ops, quarterly"})
doc.save(os.path.join(OUT, "text.pdf"))

# compare pair
for name, lines in [
    ("cmp-a.pdf", ["Alpha clause: payment due in 30 days.", "Beta clause: delivery by courier.", "Gamma clause: warranty of 12 months.", "Delta clause: governed by Indian law."]),
    ("cmp-b.pdf", ["Alpha clause: payment due in 45 days.", "Beta clause: delivery by courier.", "New clause: late fee of 2 percent.", "Gamma clause: warranty of 12 months.", "Delta clause: governed by Indian law."]),
]:
    d = pymupdf.open()
    pg = d.new_page(width=W, height=H)
    for i, l in enumerate(lines):
        pg.insert_text((56, 90 + i * 24), l, fontsize=12, fontname="helv")
    d.save(os.path.join(OUT, name))

# form.pdf
d = pymupdf.open()
pg = d.new_page(width=W, height=H)
pg.insert_text((56, 70), "Registration form", fontsize=18, fontname="hebo")
def widget(kind, name, rect, value=None, choices=None):
    w = pymupdf.Widget()
    w.field_type = kind
    w.field_name = name
    w.rect = pymupdf.Rect(*rect)
    if choices:
        w.choice_values = choices
    if value is not None:
        w.field_value = value
    w.text_fontsize = 11
    pg.add_widget(w)
pg.insert_text((56, 112), "Full name", fontsize=11)
widget(pymupdf.PDF_WIDGET_TYPE_TEXT, "full_name", (150, 98, 450, 118), "")
pg.insert_text((56, 142), "Email", fontsize=11)
widget(pymupdf.PDF_WIDGET_TYPE_TEXT, "email", (150, 128, 450, 148), "")
pg.insert_text((56, 172), "Subscribe", fontsize=11)
widget(pymupdf.PDF_WIDGET_TYPE_CHECKBOX, "subscribe", (150, 158, 166, 174), False)
pg.insert_text((56, 202), "Plan", fontsize=11)
widget(pymupdf.PDF_WIDGET_TYPE_COMBOBOX, "plan", (150, 188, 300, 208), "Basic", ["Basic", "Pro", "Enterprise"])
d.save(os.path.join(OUT, "form.pdf"))

# scan.pdf (image only, for OCR)
src = pymupdf.open(os.path.join(OUT, "text.pdf"))
pix = src[0].get_pixmap(dpi=150)
d = pymupdf.open()
pg = d.new_page(width=W, height=H)
pg.insert_image(pg.rect, stream=pix.tobytes("png"))
d.save(os.path.join(OUT, "scan.pdf"))
open(os.path.join(OUT, "scan.png"), "wb").write(pix.tobytes("png"))

# heavy.pdf: many big photos (compression target)
d = pymupdf.open()
for k in range(3):
    pg = d.new_page(width=W, height=H)
    pg.insert_text((56, 70), f"Photo page {k + 1}", fontsize=18, fontname="hebo")
    pg.insert_image(pymupdf.Rect(56, 90, W - 56, 500), stream=save_img(photo(2000, 1400, k + 5), "JPEG", quality=95))
    pg.insert_textbox(pymupdf.Rect(56, 520, W - 56, 600), "Caption text that must stay selectable after compression.", fontsize=12, fontname="helv")
d.save(os.path.join(OUT, "heavy.pdf"))

# encrypted variants
subprocess.run(["qpdf", "--encrypt", "secret", "ownerpw", "256", "--", os.path.join(OUT, "text.pdf"), os.path.join(OUT, "encrypted.pdf")], check=True)
subprocess.run(["qpdf", "--encrypt", "", "ownerpw", "256", "--print=none", "--extract=n", "--modify=none", "--", os.path.join(OUT, "text.pdf"), os.path.join(OUT, "restricted.pdf")], check=True)

# ---------- DOCX ----------
dx = Document()
dx.add_heading("Project Charter", 0)
p = dx.add_paragraph("This charter sets out the ")
r = p.add_run("scope"); r.bold = True
p.add_run(", the ")
r = p.add_run("budget"); r.italic = True
p.add_run(" of ₹12,50,000 and the “success criteria” — agreed by all parties.")
dx.add_heading("Goals", level=1)
for g in ["Launch the beta by December", "Reach 500 paying users", "Keep churn under 3 percent"]:
    dx.add_paragraph(g, style="List Bullet")
dx.add_heading("Milestones", level=2)
for g in ["Design review", "Private beta", "Public launch"]:
    dx.add_paragraph(g, style="List Number")
t = dx.add_table(rows=1, cols=3)
t.style = "Table Grid"
hdr = t.rows[0].cells
hdr[0].text, hdr[1].text, hdr[2].text = "Owner", "Task", "Due"
for row in [("Asha", "Hiring plan", "Oct 20"), ("Ravi", "Pricing page", "Nov 2"), ("Meera", "Beta invites", "Nov 15")]:
    cells = t.add_row().cells
    for c, v in zip(cells, row):
        c.text = v
dx.add_paragraph("")
dx.add_picture(io.BytesIO(save_img(photo(600, 400, 9), "PNG")), width=Inches(3))
dx.add_paragraph("Signed off by the steering committee. नमस्ते team.")
dx.save(os.path.join(OUT, "sample.docx"))
# Word documents as people make them, for Word to PDF: word-report.docx, word-letter.docx,
# word-resume.docx, word-features.docx, word-charts.docx and word-longtable.docx.
import word_fixtures
word_fixtures.build(OUT)
# Workbooks as people make them, for Excel to PDF: excel-invoice.xlsx, excel-sales.xlsx,
# excel-expenses.xlsx, excel-features.xlsx and excel-export.xlsx.
import excel_fixtures
excel_fixtures.build(OUT)
# A deck with one slide per thing PowerPoint to PDF must get right (deck-features.pptx), and a
# Word document whose picture is a WMF drawing (word-wmf.docx). Written on import.
import ppt_fixtures

# ---------- XLSX ----------
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Sales"
ws.append(["Region", "Rep", "Month", "Units", "Price", "Revenue"])
regions = ["North", "South", "East", "West"]
for i in range(150):
    u = random.randint(1, 90)
    pr = round(random.uniform(10, 500), 2)
    ws.append([regions[i % 4], f"Rep {i % 17}", f"2026-{(i % 12) + 1:02d}", u, pr, None])
    ws.cell(row=i + 2, column=6).value = f"=D{i + 2}*E{i + 2}"
ws2 = wb.create_sheet("Wide")
ws2.append([f"Col {c}" for c in range(1, 16)])
for r in range(20):
    ws2.append([f"r{r}c{c}" for c in range(1, 16)])
wb.save(os.path.join(OUT, "sample.xlsx"))
# Evaluate formula caches via LibreOffice round trip so cached values exist
subprocess.run(["soffice", "--headless", "--convert-to", "xlsx", "--outdir", os.path.join(OUT, "lo"), os.path.join(OUT, "sample.xlsx")], check=True, capture_output=True)
os.replace(os.path.join(OUT, "lo", "sample.xlsx"), os.path.join(OUT, "sample.xlsx"))

# ---------- PPTX ----------
prs = Presentation()
prs.slide_width, prs.slide_height = PInches(13.333), PInches(7.5)
s = prs.slides.add_slide(prs.slide_layouts[0])
s.shapes.title.text = "Launch Plan 2026"
s.placeholders[1].text = "Go-to-market review"
s = prs.slides.add_slide(prs.slide_layouts[1])
s.shapes.title.text = "Agenda"
tf = s.placeholders[1].text_frame
tf.text = "Market sizing"
for b in ["Pricing", "Channels", "Hiring"]:
    tf.add_paragraph().text = b
s = prs.slides.add_slide(prs.slide_layouts[6])
box = s.shapes.add_textbox(PInches(0.8), PInches(0.5), PInches(6), PInches(1))
box.text_frame.text = "Revenue chart"
box.text_frame.paragraphs[0].runs[0].font.size = PPt(36)
box.text_frame.paragraphs[0].runs[0].font.bold = True
box.text_frame.paragraphs[0].runs[0].font.color.rgb = PRGB(0xB4, 0x23, 0x18)
s.shapes.add_picture(io.BytesIO(save_img(photo(800, 500, 11), "JPEG")), PInches(0.8), PInches(1.8), width=PInches(6))
from pptx.enum.shapes import MSO_SHAPE
shp = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, PInches(7.5), PInches(1.8), PInches(4.5), PInches(2))
shp.fill.solid(); shp.fill.fore_color.rgb = PRGB(0x2F, 0x6B, 0x4F)
shp.text_frame.text = "Up 38% QoQ"
prs.save(os.path.join(OUT, "sample.pptx"))

# office-deck.pdf: a deck made the way people make them in PowerPoint (placeholders, bullets
# from the master at two levels, two columns, a native chart, a table, cards drawn as shapes, a
# picture), exported to PDF by LibreOffice. PDF to PowerPoint must give it back nearly as it was.
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.text import PP_ALIGN
prs = Presentation()
prs.slide_width, prs.slide_height = PInches(13.333), PInches(7.5)
L = prs.slide_layouts
s = prs.slides.add_slide(L[0])
s.shapes.title.text = "Harbour Logistics"
s.placeholders[1].text = "Annual planning offsite, 2027"
s = prs.slides.add_slide(L[1])
s.shapes.title.text = "Where we stand"
tf = s.placeholders[1].text_frame
tf.text = "Volumes grew 14% across all three hubs, the strongest year since the network opened"
for t, lvl in [("Northern hub ran at 96% of capacity for eight months", 1), ("Southern hub added a night shift", 1), ("On-time delivery reached 93.4%", 0), ("Fuel costs fell for the first time in four years", 0)]:
    p = tf.add_paragraph(); p.text = t; p.level = lvl
s = prs.slides.add_slide(L[3])
s.shapes.title.text = "Priorities"
a = s.placeholders[1].text_frame; a.text = "Automate sorting at the northern hub"
a.add_paragraph().text = "Open a cross-dock in the east"
b = s.placeholders[2].text_frame; b.text = "Renew the fleet lease on better terms"
b.add_paragraph().text = "Train forty new forklift drivers"
s = prs.slides.add_slide(L[5])
s.shapes.title.text = "Parcels handled (thousands)"
cd = CategoryChartData(); cd.categories = ["Q1", "Q2", "Q3", "Q4"]
cd.add_series("2025", (410, 455, 470, 520)); cd.add_series("2026", (468, 512, 540, 601))
ch = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, PInches(1), PInches(1.6), PInches(11.3), PInches(5.4), cd).chart
ch.has_legend = True; ch.legend.position = XL_LEGEND_POSITION.BOTTOM; ch.legend.include_in_layout = False
ch.plots[0].has_data_labels = True
s = prs.slides.add_slide(L[5])
s.shapes.title.text = "Hub scorecard"
rows = [("Hub", "Parcels (K)", "On time", "Cost per parcel"), ("Northern", "1,204", "94.1%", "$1.82"), ("Southern", "865", "92.7%", "$1.95"), ("Eastern", "462", "93.0%", "$2.10")]
tb = s.shapes.add_table(4, 4, PInches(1), PInches(1.8), PInches(11.3), PInches(2.4)).table
for r, row in enumerate(rows):
    for c, v in enumerate(row):
        cell = tb.cell(r, c); cell.text = v
        if c: cell.text_frame.paragraphs[0].alignment = PP_ALIGN.RIGHT
s = prs.slides.add_slide(L[6])
for i, (big, small, col) in enumerate([("14%", "volume growth", "1F4E79"), ("93.4%", "on-time delivery", "2E7D32"), ("$1.91", "average cost per parcel", "B71C1C")]):
    sh = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, PInches(0.9 + i * 4), PInches(1.5), PInches(3.5), PInches(2.4))
    sh.fill.solid(); sh.fill.fore_color.rgb = PRGB.from_string(col); sh.line.fill.background()
    tf = sh.text_frame; tf.text = big; tf.paragraphs[0].runs[0].font.size = PPt(48); tf.paragraphs[0].runs[0].font.bold = True
    p = tf.add_paragraph(); p.text = small; p.runs[0].font.size = PPt(18)
tx = s.shapes.add_textbox(PInches(0.9), PInches(4.6), PInches(11.5), PInches(1.5)).text_frame
tx.word_wrap = True
tx.text = "Figures are for the twelve months to 30 September 2026 and include contract work for partner carriers. Cost per parcel excludes depreciation."
tx.paragraphs[0].runs[0].font.size = PPt(16)
s = prs.slides.add_slide(L[5])
s.shapes.title.text = "The new sorting line"
s.shapes.add_picture(io.BytesIO(save_img(photo(900, 600, 5), "JPEG")), PInches(0.9), PInches(1.6), PInches(6.5), PInches(4.3))
t = s.shapes.add_textbox(PInches(7.8), PInches(1.6), PInches(4.6), PInches(4)).text_frame; t.word_wrap = True
t.text = "Installed in March, the line sorts 9,000 parcels an hour and cut manual handling by half."
t.paragraphs[0].runs[0].font.size = PPt(20)
os.makedirs(os.path.join(OUT, "lo"), exist_ok=True)
prs.save(os.path.join(OUT, "lo", "office-deck.pptx"))
subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", os.path.join(OUT, "lo"), os.path.join(OUT, "lo", "office-deck.pptx")], check=True, capture_output=True)
os.replace(os.path.join(OUT, "lo", "office-deck.pdf"), os.path.join(OUT, "office-deck.pdf"))

# ---------- EPUB (spine order differs from manifest order) ----------
ep = zipfile.ZipFile(os.path.join(OUT, "sample.epub"), "w")
ep.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
ep.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
ep.writestr("OPS/book.opf", """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Small Book</dc:title><dc:creator>A. Writer</dc:creator><dc:identifier id="id">x</dc:identifier><dc:language>en</dc:language></metadata>
<manifest>
<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="img" href="images/cover.jpg" media-type="image/jpeg"/>
<item id="css" href="style.css" media-type="text/css"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>""")
ep.writestr("OPS/style.css", "p{margin:0}")
ep.writestr("OPS/images/cover.jpg", save_img(photo(600, 800, 13), "JPEG", quality=80))
ep.writestr("OPS/text/ch1.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>Chapter One</h1><p>It was a <em>quiet</em> morning in Kanpur.</p><img src="../images/cover.jpg" alt="cover"/><p>The <strong>first</strong> chapter ends here.</p></body></html>')
ep.writestr("OPS/text/ch2.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h1>Chapter Two</h1><p>By noon the market was busy.</p><ul><li>Tea stalls</li><li>Book sellers</li></ul></body></html>')
ep.close()

open(os.path.join(OUT, "sample.csv"), "w").write('Name,City,Notes,Amount\n"Sharma, Priya",Bengaluru,"Said ""hello""",1200.50\nRavi,Kanpur,Plain note,300\nMeera,Pune,"Multi, comma, value",45\n')
open(os.path.join(OUT, "sample.md"), "w").write("""# Release Notes

Version **2.4** ships *today*. See [the docs](https://example.com).

## Changes

- Faster merge
- New `compress` levels
  - nested item

1. First step
2. Second step

> Quote: privacy first.

```js
function hello(name) {
  return `hi ${name}`;
}
```

| Tool | Status |
| ---- | ------ |
| Merge | Done |
| OCR | Beta |

Price: ₹499 — “smart quotes”.
""")
open(os.path.join(OUT, "sample.html"), "w").write("""<h1>Offer Letter</h1><p>Dear <b>Asha</b>,</p><p>We are pleased to offer you the role of <i>Account Executive</i>.</p><table border="1"><tr><th>Component</th><th>Amount</th></tr><tr><td>Base</td><td>₹18,00,000</td></tr><tr><td>Variable</td><td>₹6,00,000</td></tr></table><ol><li>Join by Nov 1</li><li>Bring documents</li></ol><pre>  indented   code
    stays</pre><p>Regards,<br/>HR</p>""")
# links.pdf: a contents page whose entries jump to the chapters (one by an explicit page, one by a
# named destination), for checking links survive merging, splitting and extracting.
d = pymupdf.open()
for i in range(3):
    p = d.new_page()
    p.insert_text((72, 72), "Contents" if i == 0 else f"Chapter {i}", fontsize=18)
    if i:
        p.insert_text((72, 110), f"Text of chapter {i}.", fontsize=11)
d[0].insert_text((72, 120), "Go to chapter 1", fontsize=12)
d[0].insert_text((72, 150), "Go to chapter 2", fontsize=12)
d[0].insert_link({"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(70, 108, 200, 124), "page": 1, "to": pymupdf.Point(72, 72)})
d[0].insert_link({"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(70, 138, 200, 154), "page": 2, "to": pymupdf.Point(72, 72)})
d.set_toc([[1, "Contents", 1], [1, "Chapter 1", 2], [1, "Chapter 2", 3]])
d.save(os.path.join(OUT, "links.pdf"))
# The second link by name: a named destination in the catalog's Dests tree.
d = pymupdf.open(os.path.join(OUT, "links.pdf"))
page2 = d[2].xref
names = d.get_new_xref()
d.update_object(names, f"<< /Names [(chapter-2) [{page2} 0 R /XYZ 72 720 0]] >>")
cat = d.pdf_catalog()
d.xref_set_key(cat, "Names", f"<< /Dests {names} 0 R >>")
annot = [a for a in d[0].annot_xrefs() if a[1] == pymupdf.PDF_ANNOT_LINK][1][0]
d.xref_set_key(annot, "A", "null")
d.xref_set_key(annot, "Dest", "(chapter-2)")
d.save(os.path.join(OUT, "links-named.pdf"))
d.close()
os.replace(os.path.join(OUT, "links-named.pdf"), os.path.join(OUT, "links.pdf"))

# phone-turned.jpg: a photo taken with the phone upright, stored on its side with an EXIF note to
# turn it 90 degrees clockwise (as phones save them). Viewed the right way up, a red arrow points up.
raw = Image.new("RGB", (600, 400), "white")
dr = ImageDraw.Draw(raw)
dr.polygon([(20, 200), (120, 140), (120, 260)], fill=(220, 0, 0))
dr.rectangle([120, 180, 560, 220], fill=(220, 0, 0))
ex = Image.Exif()
ex[0x0112] = 6
raw.save(os.path.join(OUT, "phone-turned.jpg"), quality=90, exif=ex.tobytes())

print("fixtures:", sorted(os.listdir(OUT)))
