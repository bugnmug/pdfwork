// Test cases for the rebuilt app. Each case runs one tool and validates the output independently.
import { statSync, readFileSync } from "node:fs";
import { FX } from "./lib.mjs";

const first = (saved, ext) => saved.find((s) => s.filename.toLowerCase().endsWith(ext));
const all = (saved, ext) => saved.filter((s) => s.filename.toLowerCase().endsWith(ext));
const ok = (notes) => ({ pass: notes.every((n) => !String(n).startsWith("✗")), notes });
const has = (text, needle) => text.replace(/\s+/g, " ").toLowerCase().includes(needle.replace(/\s+/g, " ").toLowerCase());
const py = (h, code) => h.sh("python3", ["-c", code]).out.trim();
function needPdf(saved, h, opts = {}) {
  const notes = [];
  const pdf = opts.pdf ?? first(saved, ".pdf");
  if (!pdf) return { notes: ["✗ no PDF output"], text: "", pdf: null };
  const chk = h.sh("qpdf", ["--check", ...(opts.password ? ["--password=" + opts.password] : []), pdf.path]);
  if (chk.code !== 0 && chk.code !== 3) notes.push("✗ qpdf --check failed: " + chk.out.slice(-200));
  else if (chk.code === 3) notes.push("qpdf warnings");
  const text = opts.mutool ? "" : h.pdfText(pdf.path, opts.password);
  const pages = h.pdfPages(pdf.path);
  if (opts.pages != null && pages !== opts.pages) notes.push(`✗ pages ${pages}, expected ${opts.pages}`);
  const fitzText = opts.text?.length || opts.notText?.length ? py(h, `import pymupdf;d=pymupdf.open(${JSON.stringify(pdf.path)}${opts.password ? `);d.authenticate(${JSON.stringify(opts.password)}` : ""});print(" ".join(p.get_text() for p in d))`) : "";
  for (const t of opts.text ?? []) if (!has(text, t) && !has(fitzText, t)) notes.push(`✗ missing text "${t}"`);
  for (const t of opts.notText ?? []) if (has(text, t) || has(fitzText, t)) notes.push(`✗ still contains "${t}"`);
  return { notes, text: text + "\n" + fitzText, pdf, pages };
}
const imgCount = (h, p) => Math.max(0, h.sh("pdfimages", ["-list", p]).out.trim().split("\n").length - 2);

export const CASES = [
  { id: "merge", slug: "merge-pdf", files: ["text.pdf", "cmp-a.pdf"], check: (s, h) => {
      const r = needPdf(s, h, { pages: 5, text: ["Quarterly Operations", "Alpha clause"] });
      const toc = py(h, `import pymupdf;print(len(pymupdf.open(${JSON.stringify(r.pdf.path)}).get_toc()))`);
      return ok([...r.notes, Number(toc) >= 2 ? `${toc} bookmarks` : `✗ bookmarks ${toc}`]);
  } },
  { id: "merge-encrypted-needs-password", slug: "merge-pdf", files: ["encrypted.pdf", "cmp-a.pdf"], expectError: true },
  { id: "merge-encrypted-with-password", slug: "merge-pdf", files: ["encrypted.pdf", "cmp-a.pdf"], passwords: { "encrypted.pdf": "secret" }, check: (s, h) => ok(needPdf(s, h, { pages: 5, text: ["Quarterly", "Alpha clause"] }).notes) },
  { id: "merge-restricted", slug: "merge-pdf", files: ["restricted.pdf", "cmp-a.pdf"], check: (s, h) => ok(needPdf(s, h, { pages: 5, text: ["Quarterly"] }).notes) },
  { id: "mix-reverse", slug: "mix-pdf", files: ["text.pdf", "cmp-a.pdf"], options: { reverseSecond: true }, check: (s, h) => ok(needPdf(s, h, { pages: 5 }).notes) },
  { id: "split-ranges", slug: "split-pdf", files: ["text.pdf"], options: { mode: "range", ranges: "1-2, 4" }, check: (s, h) => {
      const pdfs = all(s, ".pdf");
      const notes = [`${pdfs.length} pdfs`, first(s, ".zip") ? "zip" : "✗ no zip"];
      if (pdfs.length !== 2) notes.push("✗ expected 2 files");
      if (pdfs[0] && h.pdfPages(pdfs[0].path) !== 2) notes.push("✗ first part should have 2 pages");
      return ok(notes);
  } },
  { id: "split-ranges-merged", slug: "split-pdf", files: ["text.pdf"], options: { mode: "range", ranges: "4, 1", merge: true }, check: (s, h) => ok(needPdf(s, h, { pages: 2 }).notes) },
  { id: "split-every", slug: "split-pdf", files: ["text.pdf"], options: { mode: "every", every: 3 }, check: (s) => ok([all(s, ".pdf").length === 2 ? "2 files" : `✗ ${all(s, ".pdf").length}`]) },
  { id: "split-each", slug: "split-pdf", files: ["text.pdf"], options: { mode: "each" }, check: (s) => ok([all(s, ".pdf").length === 4 ? "4 files" : "✗ expected 4"]) },
  { id: "split-bad-range", slug: "split-pdf", files: ["text.pdf"], options: { mode: "range", ranges: "9-12" }, expectError: true },
  { id: "remove-pages", slug: "remove-pages", files: ["text.pdf"], options: { pages: "2-3" }, check: (s, h) => ok(needPdf(s, h, { pages: 2, text: ["Quarterly", "Appendix"], notText: ["Consulting hours"] }).notes) },
  { id: "extract-pages", slug: "extract-pages", files: ["text.pdf"], options: { pages: "3, 1" }, check: (s, h) => {
      const r = needPdf(s, h, { pages: 2 });
      return ok([...r.notes, r.text.indexOf("INVOICE") < r.text.indexOf("Quarterly") ? "order kept" : "✗ order"]);
  } },
  { id: "organize-plan", slug: "organize-pages", files: ["text.pdf"], options: { plan: [{ source: 3 }, { blank: true }, { source: 0, rotate: 90 }] }, check: (s, h) => {
      const r = needPdf(s, h, { pages: 3 });
      const rots = h.sh("pdfinfo", ["-f", "1", "-l", "3", r.pdf.path]).out.match(/Page\s+\d+ rot:\s+(\d+)/g);
      return ok([...r.notes, `rotations ${rots}`]);
  } },
  { id: "rotate-some", slug: "rotate-pdf", files: ["text.pdf"], options: { angle: "90", pages: "1,3" }, check: (s, h) => {
      const out = h.sh("pdfinfo", ["-f", "1", "-l", "4", s[0].path]).out;
      const rots = [...out.matchAll(/Page\s+(\d+) rot:\s+(\d+)/g)].map((m) => m[2]).join(",");
      return ok([rots === "90,0,90,90" ? "rot 90,0,90,90 (page 4 was already 90→180? see)" : `rots ${rots}`]);
  } },
  { id: "split-by-text", slug: "split-by-text", files: ["text.pdf"], options: { query: "INVOICE" }, check: (s) => ok([all(s, ".pdf").length === 2 ? "2 pdfs" : `✗ ${all(s, ".pdf").length}`]) },
  { id: "split-by-bookmarks", slug: "split-by-bookmarks", files: ["text.pdf"], options: { level: "0" }, check: (s) => ok([all(s, ".pdf").length === 4 ? `4 pdfs ${all(s, ".pdf").map((p) => p.filename).join(" ")}` : `✗ ${all(s, ".pdf").length}`]) },
  { id: "split-in-half", slug: "split-in-half", files: ["cmp-a.pdf"], options: { axis: "v" }, check: (s, h) => {
      const r = needPdf(s, h, { pages: 2 });
      const t1 = h.sh("pdftotext", ["-f", "1", "-l", "1", r.pdf.path, "-"]).out;
      return ok([...r.notes, has(t1, "Alpha") ? "left half has text" : "✗ text lost"]);
  } },
  { id: "split-by-size", slug: "split-by-size", files: ["heavy.pdf"], options: { maxMb: 0.4 }, check: (s) => ok([all(s, ".pdf").length >= 2 ? `${all(s, ".pdf").length} parts` : "✗ not split"]) },
  { id: "n-up", slug: "n-up", files: ["text.pdf"], options: { n: "4" }, check: (s, h) => ok(needPdf(s, h, { pages: 1, text: ["Quarterly", "Appendix"] }).notes) },
  { id: "crop-margins", slug: "crop-pdf", files: ["text.pdf"], options: { mode: "margins", top: 20, bottom: 20, left: 20, right: 20 }, check: (s, h) => {
      const r = needPdf(s, h, { pages: 4, text: ["Quarterly"] });
      return ok([...r.notes, (h.sh("pdfinfo", [r.pdf.path]).out.match(/Page size:[^\n]+/) || [""])[0]]);
  } },
  { id: "crop-auto", slug: "crop-pdf", files: ["cmp-a.pdf"], options: { mode: "auto", pad: 5 }, check: (s, h) => {
      const r = needPdf(s, h, { pages: 1, text: ["Alpha"] });
      const size = (h.sh("pdfinfo", [r.pdf.path]).out.match(/Page size:\s+([\d.]+) x ([\d.]+)/) || []).slice(1).map(Number);
      return ok([...r.notes, size[1] < 300 ? `cropped to ${size.join("x")}` : `✗ not cropped ${size.join("x")}`]);
  } },
  { id: "resize", slug: "resize-pdf", files: ["cmp-a.pdf"], options: { paper: "Letter" }, check: (s, h) => ok([...needPdf(s, h, { pages: 1, text: ["Alpha"] }).notes, (h.sh("pdfinfo", [s[0].path]).out.match(/Page size:[^\n]+/) || [""])[0]]) },
  { id: "flip", slug: "flip-pdf", files: ["cmp-a.pdf"], options: { dir: "h" }, check: (s, h) => ok(needPdf(s, h, { pages: 1 }).notes) },
  { id: "pdf-to-zip", slug: "pdf-to-zip", files: ["text.pdf"], check: (s, h) => {
      const z = first(s, ".zip");
      const n = z ? (h.sh("unzip", ["-l", z.path]).out.match(/\.pdf/g) || []).length : 0;
      return ok([n === 4 ? "4 entries" : `✗ ${n} entries`]);
  } },
  ...["lossless", "recommended", "strong", "extreme"].map((level) => ({
    id: `compress-${level}`, slug: "compress-pdf", files: ["heavy.pdf"], options: { level },
    check: (s, h) => {
      const r = needPdf(s, h, { pages: 3, text: level === "extreme" ? [] : ["Caption text that must stay selectable"] });
      const before = statSync(h.join(h.FX, "heavy.pdf")).size;
      const after = r.pdf ? r.pdf.size : 0;
      const pct = Math.round((1 - after / before) * 100);
      const notes = [...r.notes, `${before} → ${after} (${pct}% smaller)`, s[0].note ?? ""];
      if (level !== "lossless" && pct < 20) notes.push("✗ expected a real reduction");
      return ok(notes);
    },
  })),
  { id: "compress-text-pdf", slug: "compress-pdf", files: ["text.pdf"], options: { level: "recommended" }, check: (s, h) => {
      const r = needPdf(s, h, { pages: 4, text: ["Quarterly", "Consulting hours"] });
      const before = statSync(h.join(h.FX, "text.pdf")).size;
      return ok([...r.notes, `${before} → ${r.pdf.size}`, imgCount(h, r.pdf.path) >= 2 ? "images kept" : "✗ images lost"]);
  } },
  { id: "repair", slug: "repair-pdf", files: ["text.pdf"], check: (s, h) => ok(needPdf(s, h, { pages: 4, text: ["Quarterly"] }).notes) },
  { id: "ocr-pdf", slug: "ocr-pdf", files: ["scan.pdf"], options: { lang: "eng" }, check: (s, h) => {
      const r = needPdf(s, h, { pages: 1, text: ["Quarterly Operations", "escalations"] });
      return ok([...r.notes, imgCount(h, r.pdf.path) >= 1 ? "original scan kept" : "✗ scan image lost", s[0].note ?? ""]);
  } },
  { id: "ocr-image", slug: "ocr-pdf", files: ["scan.png"], options: { lang: "eng" }, check: (s, h) => ok(needPdf(s, h, { pages: 1, text: ["Quarterly"] }).notes) },
  { id: "grayscale", slug: "grayscale-pdf", files: ["cmp-a.pdf"], check: (s, h) => ok(needPdf(s, h, { pages: 1 }).notes) },
  { id: "pdfa", slug: "pdf-to-pdfa", files: ["cmp-a.pdf"], options: { level: "2B" }, check: (s, h) => {
      const r = needPdf(s, h, { pages: 1, text: ["Alpha"] });
      const meta = h.sh("pdfinfo", ["-meta", r.pdf.path]).out;
      return ok([...r.notes, /pdfaid/i.test(meta) ? "PDF/A metadata present" : "✗ no PDF/A metadata"]);
  } },
  { id: "watermark-text", slug: "watermark", files: ["text.pdf"], options: { text: "DRAFT", opacity: 0.2, color: "#b42318" }, check: (s, h) => ok(needPdf(s, h, { pages: 4, text: ["DRAFT", "Quarterly"] }).notes) },
  { id: "watermark-unicode-tiled", slug: "watermark", files: ["cmp-a.pdf"], options: { text: "गोपनीय ₹ Confidential", position: "tile", opacity: 0.15 }, check: (s, h) => ok(needPdf(s, h, { pages: 1, text: ["Confidential", "₹"] }).notes) },
  { id: "watermark-image", slug: "watermark", files: ["cmp-a.pdf"], options: { kind: "image", image: { __file: "logo.png" }, position: "center" }, check: (s, h) => ok([...needPdf(s, h, { pages: 1 }).notes, imgCount(h, s[0].path) >= 1 ? "image drawn" : "✗ no image"]) },
  { id: "page-numbers", slug: "page-numbers", files: ["text.pdf"], options: { format: "Page {n} of {total}", position: "bottom" }, check: (s, h) => ok(needPdf(s, h, { pages: 4, text: ["Page 1 of 4", "Page 4 of 4"] }).notes) },
  { id: "page-numbers-roman-skip", slug: "page-numbers", files: ["text.pdf"], options: { format: "{n}", numerals: "roman", skipFirst: 1, position: "bottom-right" }, check: (s, h) => ok(needPdf(s, h, { text: ["iii"] }).notes) },
  { id: "header-footer", slug: "header-footer", files: ["text.pdf"], options: { headerCenter: "Acme ₹ Internal", footerRight: "Page {page} of {pages}", footerLeft: "{filename}" }, check: (s, h) => ok(needPdf(s, h, { text: ["Acme ₹ Internal", "Page 2 of 4", "text.pdf"] }).notes) },
  { id: "bates-multi", slug: "bates", files: ["text.pdf", "cmp-a.pdf"], options: { prefix: "EXH-", start: 7, digits: 6 }, check: (s, h) => {
      const pdfs = all(s, ".pdf");
      const t2 = pdfs[1] ? h.pdfText(pdfs[1].path) : "";
      return ok([...needPdf(s, h, { pdf: pdfs[0], text: ["EXH-000007", "EXH-000010"] }).notes, has(t2, "EXH-000011") ? "continues across files" : "✗ numbering did not continue"]);
  } },
  { id: "stamp-image", slug: "thumbmark", files: ["text.pdf", "thumb.png"], options: { where: "last", caption: "L.T.I." }, check: (s, h) => ok(needPdf(s, h, { pages: 4, text: ["L.T.I."] }).notes) },
  { id: "flatten", slug: "flatten-pdf", files: ["form.pdf"], check: (s, h) => {
      const r = needPdf(s, h, { pages: 1, text: ["Registration form"] });
      const fields = py(h, `import pymupdf;d=pymupdf.open(${JSON.stringify(r.pdf.path)});print(sum(1 for p in d for w in p.widgets()))`);
      return ok([...r.notes, fields === "0" ? "no fields left" : `✗ ${fields} fields remain`]);
  } },
  { id: "fill-form", slug: "fill-form", files: ["form.pdf"], options: { values: { full_name: "Priya Sharma ₹ नमस्ते", email: "p@example.com", subscribe: "true", plan: "Pro" }, flatten: false }, check: (s, h) => {
      const v = py(h, `import pymupdf;d=pymupdf.open(${JSON.stringify(s[0].path)});print({w.field_name:w.field_value for p in d for w in p.widgets()})`);
      return ok([/Priya Sharma/.test(v) ? "name filled" : "✗ " + v, /'plan': 'Pro'/.test(v) ? "dropdown set" : "✗ dropdown", /subscribe': (True|'Yes'|'On')/i.test(v) ? "checkbox set" : "✗ checkbox " + v]);
  } },
  { id: "fill-form-flatten", slug: "fill-form", files: ["form.pdf"], options: { values: { full_name: "Ravi Kumar", plan: "Enterprise" }, flatten: true }, check: (s, h) => ok(needPdf(s, h, { text: ["Ravi Kumar", "Enterprise"] }).notes) },
  { id: "invert", slug: "invert-pdf", files: ["cmp-a.pdf"], check: (s, h) => ok(needPdf(s, h, { pages: 1 }).notes) },
  { id: "metadata", slug: "metadata", files: ["text.pdf"], options: { title: "New Title ₹", author: "Harsh", subject: "S", keywords: "a, b" }, check: (s, h) => {
      const info = h.sh("pdfinfo", [s[0].path]).out;
      return ok([/Title:\s+New Title/.test(info) ? "title set" : "✗ title", /Author:\s+Harsh/.test(info) ? "author set" : "✗ author"]);
  } },
  { id: "pdf-to-handwriting", slug: "pdf-to-handwriting", files: ["cmp-a.pdf"], check: (s, h) => ok(needPdf(s, h, { text: ["Alpha"] }).notes) },
  { id: "text-to-handwriting", slug: "text-to-handwriting", options: { heading: "Homework", body: "Dear diary,\nToday I merged twelve PDFs. नमस्ते दुनिया ₹500." }, check: (s, h) => ok(needPdf(s, h, { text: ["Homework", "merged twelve"] }).notes) },
  { id: "images-to-pdf", slug: "images-to-pdf", files: ["photo.jpg", "logo.png", "pic.webp"], options: { pageSize: "A4" }, check: (s, h) => ok([...needPdf(s, h, { pages: 3 }).notes, imgCount(h, s[0].path) >= 3 ? "3 images" : "✗ images"]) },
  { id: "images-to-pdf-fit", slug: "images-to-pdf", files: ["photo.jpg"], options: { pageSize: "fit", marginMm: 0 }, check: (s, h) => ok(needPdf(s, h, { pages: 1 }).notes) },
  { id: "word-to-pdf", slug: "word-to-pdf", files: ["sample.docx"], check: (s, h) => {
      const r = needPdf(s, h, { text: ["Project Charter", "Hiring plan", "Reach 500 paying users", "₹12,50,000", "success criteria", "नमस्ते"] });
      const toc = py(h, `import pymupdf;print(len(pymupdf.open(${JSON.stringify(r.pdf.path)}).get_toc()))`);
      return ok([...r.notes, imgCount(h, r.pdf.path) >= 1 ? "image kept" : "✗ image dropped", Number(toc) >= 2 ? `${toc} bookmarks` : `✗ bookmarks ${toc}`]);
  } },
  { id: "excel-to-pdf", slug: "excel-to-pdf", files: ["sample.xlsx"], check: (s, h) => {
      const r = needPdf(s, h, { text: ["Region", "Revenue", "Col 15", "r19c15", "Rep 16"] });
      const rows = r.text.split("\n").filter((l) => /\b(North|South|East|West)\b/.test(l)).length;
      return ok([...r.notes, rows >= 150 ? `${rows} data rows` : `✗ only ${rows} rows`]);
  } },
  { id: "ppt-to-pdf", slug: "ppt-to-pdf", files: ["sample.pptx"], check: (s, h) => {
      const r = needPdf(s, h, { pages: 3, text: ["Launch Plan 2026", "Agenda", "Pricing", "Up 38% QoQ", "Revenue chart", "Go-to-market review"] });
      return ok([...r.notes, imgCount(h, r.pdf.path) >= 1 ? "picture kept" : "✗ picture dropped"]);
  } },
  { id: "html-to-pdf", slug: "html-to-pdf", options: { html: readFileSync(FX + "sample.html", "utf8") }, check: (s, h) => ok(needPdf(s, h, { text: ["Offer Letter", "Account Executive", "₹18,00,000", "indented   code", "Join by Nov 1"] }).notes) },
  { id: "markdown-to-pdf", slug: "markdown-to-pdf", options: { md: readFileSync(FX + "sample.md", "utf8") }, check: (s, h) => ok(needPdf(s, h, { text: ["Release Notes", "Faster merge", "function hello(name) {", "₹499", "OCR", "nested item"] }).notes) },
  { id: "create-pdf", slug: "create-pdf", options: { title: "Memo ₹ budget", body: "Line **one**.\n\n- item a\n- item b\n\nनमस्ते ✓ → done" }, check: (s, h) => ok(needPdf(s, h, { text: ["Memo", "item b", "नमस्ते", "✓"] }).notes) },
  { id: "csv-to-pdf", slug: "csv-to-pdf", files: ["sample.csv"], check: (s, h) => ok(needPdf(s, h, { text: ["Sharma, Priya", "Multi, comma, value", 'Said "hello"'] }).notes) },
  { id: "ebook-to-pdf", slug: "ebook-to-pdf", files: ["sample.epub"], check: (s, h) => {
      const r = needPdf(s, h, { text: ["Chapter One", "Chapter Two", "quiet morning", "Tea stalls"] });
      const t = r.text.indexOf("Chapter One") < r.text.indexOf("Chapter Two");
      return ok([...r.notes, t ? "spine order" : "✗ order", imgCount(h, r.pdf.path) >= 1 ? `${imgCount(h, r.pdf.path)} images` : "✗ images dropped"]);
  } },
  { id: "pdf-to-word", slug: "pdf-to-word", files: ["text.pdf"], check: (s, h) => {
      const d = first(s, ".docx");
      const o = h.officeText(d.path);
      if (!o.ok) return ok(["✗ " + o.note]);
      const notes = ["Quarterly Operations Report", "Consulting hours", "Appendix"].map((t) => (has(o.text, t) ? t : `✗ missing ${t}`));
      const st = py(h, `import docx;d=docx.Document(${JSON.stringify(d.path)});print(sum(1 for p in d.paragraphs if p.style.name.startswith('Heading')), len(d.tables), len(d.inline_shapes))`);
      const [heads, tables, imgs] = st.split(" ").map(Number);
      notes.push(heads >= 2 ? `${heads} headings` : `✗ headings ${heads}`, tables >= 1 ? `${tables} table(s)` : "✗ no table", imgs >= 1 ? `${imgs} images` : "✗ no images");
      return ok(notes);
  } },
  { id: "pdf-to-word-exact", slug: "pdf-to-word", files: ["cmp-a.pdf"], options: { mode: "exact" }, check: (s, h) => {
      const o = h.officeText(first(s, ".docx").path);
      return ok([o.ok ? "opens in LibreOffice" : "✗ " + o.note]);
  } },
  { id: "pdf-to-excel", slug: "pdf-to-excel", files: ["text.pdf"], check: (s, h) => {
      const x = first(s, ".xlsx");
      const out = py(h, `import openpyxl;wb=openpyxl.load_workbook(${JSON.stringify(x.path)});
found=False
for ws in wb.worksheets:
  for row in ws.iter_rows(values_only=True):
    vals=[v for v in row if v is not None]
    if 'Consulting hours' in vals and 18000 in vals: found=True
print('cells' if found else 'flat')`);
      return ok([out === "cells" ? "table split into cells, numbers numeric" : "✗ " + out]);
  } },
  { id: "pdf-to-csv", slug: "pdf-to-csv", files: ["text.pdf"], check: (s) => {
      const txt = readFileSync(first(s, ".csv").path, "utf8");
      return ok([/Consulting hours,12,1500\.00,18000\.00/.test(txt) ? "columns detected" : "✗ " + txt.split("\n").find((l) => l.includes("Consulting"))]);
  } },
  { id: "pdf-to-ppt", slug: "pdf-to-ppt", files: ["text.pdf"], check: (s, h) => {
      const p = first(s, ".pptx");
      const v = py(h, `import pptx\ntry:\n  pr=pptx.Presentation(${JSON.stringify(p.path)});print(len(pr.slides), sum(1 for sl in pr.slides if sl.has_notes_slide and sl.notes_slide.notes_text_frame.text.strip()))\nexcept Exception as e: print('ERR',e)`);
      const o = h.officeText(p.path);
      return ok([v.startsWith("4 ") ? `python-pptx opens: ${v}` : `✗ python-pptx: ${v.slice(0, 120)}`, o.ok ? "LibreOffice opens" : "✗ " + o.note]);
  } },
  { id: "pdf-to-jpg", slug: "pdf-to-jpg", files: ["text.pdf"], options: { dpi: "72" }, check: (s) => ok([all(s, ".jpg").length === 4 ? "4 jpgs" : `✗ ${all(s, ".jpg").length}`, first(s, ".zip") ? "zip" : "✗ zip"]) },
  { id: "pdf-to-png-some", slug: "pdf-to-jpg", files: ["text.pdf"], options: { format: "png", dpi: "96", pages: "2-3" }, check: (s) => ok([all(s, ".png").length === 2 ? "2 pngs" : `✗ ${all(s, ".png").length}`]) },
  { id: "extract-images", slug: "extract-images", files: ["text.pdf"], check: (s) => {
      const imgs = s.filter((x) => /\.(png|jpe?g)$/i.test(x.filename));
      return ok([imgs.length >= 2 ? `${imgs.length} images: ${imgs.map((i) => i.filename + "(" + i.size + ")").join(", ")}` : `✗ ${imgs.length} images`]);
  } },
  { id: "extract-text", slug: "extract-text", files: ["text.pdf"], check: (s) => {
      const txt = readFileSync(first(s, ".txt").path, "utf8");
      return ok(["Quarterly Operations Report", "Consulting hours", "Appendix", "rotated by 90 degrees"].map((n) => (has(txt, n) ? n : `✗ missing ${n}`)));
  } },
  { id: "extract-text-layout", slug: "extract-text", files: ["text.pdf"], options: { layout: "layout" }, check: (s) => {
      const txt = readFileSync(first(s, ".txt").path, "utf8");
      return ok([/Consulting hours\s{3,}12\s{3,}1500\.00/.test(txt) ? "columns aligned" : "✗ layout lost"]);
  } },
  { id: "pdf-to-html", slug: "pdf-to-html", files: ["text.pdf"], check: (s) => {
      const t = readFileSync(first(s, ".html").path, "utf8");
      return ok([/<h1>Quarterly Operations Report<\/h1>/.test(t) ? "h1" : "✗ h1", /<table>/.test(t) ? "table" : "✗ table", /<img/.test(t) ? "images" : "✗ images", /<ul>/.test(t) ? "list" : "✗ list"]);
  } },
  { id: "pdf-to-html-exact", slug: "pdf-to-html", files: ["cmp-a.pdf"], options: { mode: "exact" }, check: (s) => {
      const t = readFileSync(first(s, ".html").path, "utf8");
      return ok([/Alpha clause/.test(t) ? "text layer" : "✗ text", /data:image\/jpeg/.test(t) ? "page image" : "✗ image"]);
  } },
  { id: "pdf-to-markdown", slug: "pdf-to-markdown", files: ["text.pdf"], check: (s) => {
      const t = readFileSync(first(s, ".md").path, "utf8");
      return ok([/^# Quarterly Operations Report/m.test(t) ? "heading" : "✗ heading", /\| Consulting hours \| 12 \|/.test(t) ? "table" : "✗ table", /^- Customer retention/m.test(t) ? "list" : "✗ list"]);
  } },
  { id: "pdf-to-epub", slug: "pdf-to-epub", files: ["text.pdf"], check: (s, h) => {
      const e = first(s, ".epub");
      const v = py(h, `import zipfile;z=zipfile.ZipFile(${JSON.stringify(e.path)});n=z.namelist();print(n[0], z.read('mimetype').decode(), len([x for x in n if x.endswith('xhtml')]), 'cover.jpg' in ' '.join(n))`);
      const lo = h.sh("python3", ["-c", `import zipfile,xml.dom.minidom as m;z=zipfile.ZipFile(${JSON.stringify(e.path)})\nfor n in z.namelist():\n  if n.endswith(('xhtml','opf','ncx','xml')): m.parseString(z.read(n))\nprint('xml ok')`]).out.trim();
      return ok([v.startsWith("mimetype application/epub+zip") ? v : "✗ " + v, lo === "xml ok" ? "all XML well-formed" : "✗ " + lo.slice(-200)]);
  } },
  { id: "encrypt", slug: "encrypt-pdf", files: ["text.pdf"], options: { userPassword: "open123", ownerPassword: "boss456", printing: "high", copying: false }, check: (s, h) => {
      const p = first(s, ".pdf");
      const notes = [];
      const enc = h.sh("qpdf", ["--show-encryption", "--password=open123", p.path]).out;
      if (!/R = 6|AESv3|256/.test(enc)) notes.push("✗ not AES-256: " + enc.slice(0, 120));
      if (h.sh("qpdf", ["--check", p.path]).code === 0) notes.push("✗ opens without password");
      if (!has(h.pdfText(p.path, "open123"), "Quarterly")) notes.push("✗ unreadable with password");
      if (!/extract for any purpose: not allowed|extract.*: not allowed/i.test(enc)) notes.push("copy restriction: " + (enc.match(/extract[^\n]*/i) || [""])[0]);
      return ok(notes.length ? notes : ["AES-256, password required, readable with password, copy blocked"]);
  } },
  { id: "encrypt-short-password", slug: "encrypt-pdf", files: ["text.pdf"], options: { userPassword: "ab" }, expectError: true },
  { id: "remove-password", slug: "remove-password", files: ["encrypted.pdf"], options: { password: "secret" }, check: (s, h) => {
      const r = needPdf(s, h, { pages: 4, text: ["Quarterly"] });
      return ok([...r.notes, /not encrypted/i.test(h.sh("qpdf", ["--show-encryption", r.pdf.path]).out) ? "not encrypted" : "✗ still encrypted"]);
  } },
  { id: "remove-password-wrong", slug: "remove-password", files: ["encrypted.pdf"], options: { password: "nope" }, expectError: true },
  { id: "unlock-restricted", slug: "unlock-pdf", files: ["restricted.pdf"], options: { password: "" }, check: (s, h) => {
      const r = needPdf(s, h, { pages: 4, text: ["Quarterly"] });
      return ok([...r.notes, /not encrypted/i.test(h.sh("qpdf", ["--show-encryption", r.pdf.path]).out) ? "restrictions removed" : "✗ still encrypted"]);
  } },
  { id: "auto-redact", slug: "auto-redact", files: ["text.pdf"], check: (s, h) => {
      const r = needPdf(s, h, { pages: 4, text: ["Quarterly", "finance lead", "Consulting hours"], notText: ["priya.sharma@example.com", "ABCDE1234F", "98765 43210", "4111 1111 1111 1111", "2345 6789 0123", "27ABCDE1234F1Z5"] });
      const log = first(s, ".txt");
      return ok([...r.notes, log ? "log: " + readFileSync(log.path, "utf8").split("\n").slice(4, 12).filter(Boolean).join("; ") : "✗ no log"]);
  } },
  { id: "auto-redact-custom", slug: "auto-redact", files: ["text.pdf"], options: { kinds: [], terms: ["forty-two", "Cloud hosting"] }, check: (s, h) => ok(needPdf(s, h, { notText: ["forty-two", "Cloud hosting"], text: ["Consulting hours", "priya.sharma@example.com"] }).notes) },
  { id: "redact-boxes", slug: "redact-pdf", files: ["cmp-a.pdf"], options: { boxes: [{ page: 0, x: 50, y: 70, w: 300, h: 30 }] }, check: (s, h) => ok(needPdf(s, h, { pages: 1, notText: ["Alpha clause"], text: ["Beta clause", "Delta clause"] }).notes) },
  { id: "privacy-scanner", slug: "privacy-scanner", files: ["text.pdf"], check: (s) => {
      const t = readFileSync(s[0].path, "utf8");
      return ok(["Email address", "PAN", "GSTIN", "Payment card number", "Phone number", "Aadhaar number"].map((w) => (t.includes(w) ? "found " + w : "✗ missed " + w)).concat([/priya\.sharma@example\.com/.test(t) ? "✗ report leaks the raw value" : "values masked"]));
  } },
  { id: "sanitize", slug: "sanitize-pdf", files: ["text.pdf"], check: (s, h) => {
      const r = needPdf(s, h, { pages: 4, text: ["Quarterly"] });
      const info = h.sh("pdfinfo", [r.pdf.path]).out;
      return ok([...r.notes, /Author:\s+Ops Team/.test(info) ? "✗ author still there" : "metadata removed"]);
  } },
  { id: "fingerprint", slug: "fingerprint", files: ["text.pdf"], check: (s, h) => {
      const t = readFileSync(s[0].path, "utf8");
      const sha = h.sh("sha256sum", [h.join(h.FX, "text.pdf")]).out.split(" ")[0];
      const md5 = h.sh("md5sum", [h.join(h.FX, "text.pdf")]).out.split(" ")[0];
      const sha1 = h.sh("sha1sum", [h.join(h.FX, "text.pdf")]).out.split(" ")[0];
      return ok([t.includes(sha) ? "sha256 ok" : "✗ sha256", t.includes(md5) ? "md5 ok" : "✗ md5", t.includes(sha1) ? "sha1 ok" : "✗ sha1", /Pages:\s+4/.test(t) ? "pdf info" : "✗ pdf info"]);
  } },
  { id: "compare", slug: "compare-pdfs", files: ["cmp-a.pdf", "cmp-b.pdf"], check: (s, h) => ok([...needPdf(s, h, { text: ["Comparison report", "45", "late fee"] }).notes, s[0].note ?? ""]) },
  { id: "gst-invoice", slug: "gst-invoice", options: { invoice: {
      number: "INV-2026-007", date: "2026-10-04", seller: { name: "Blaze Hire Pvt Ltd", address: "HSR Layout\nBengaluru 560102", gstin: "29ABCPE1234F1Z5", state: "29", phone: "+91 80 1234 5678", email: "billing@example.com" },
      buyer: { name: "Acme Retail LLP", address: "Andheri East, Mumbai", gstin: "27AAACA1234B1Z9", state: "27" }, placeOfSupply: "27",
      items: [{ desc: "Recruitment services — SDR hiring (2 hires)", hsn: "998512", qty: 2, unit: "nos", rate: 85000, discount: 5, gst: 18 }, { desc: "Assessment platform licence", hsn: "997331", qty: 1, unit: "yr", rate: 24000, discount: 0, gst: 18 }],
      bank: { holder: "Blaze Hire Pvt Ltd", name: "HDFC Bank", account: "50200012345678", ifsc: "HDFC0001234" }, upi: "blazehire@okhdfcbank", notes: "Payment due in 15 days.", terms: "Subject to Bengaluru jurisdiction." } },
    check: (s, h) => {
      const r = needPdf(s, h, { pages: 1, text: ["TAX INVOICE", "Acme Retail LLP", "IGST", "₹2,18,890.00", "Two Lakh Eighteen Thousand Eight Hundred Ninety Rupees Only", "998512", "Scan to pay"] });
      return ok([...r.notes, imgCount(h, r.pdf.path) >= 1 ? "UPI QR present" : "✗ no QR"]);
  } },
  { id: "pos-bill", slug: "pos-bill", options: { bill: { shop: "Chai Point", address: "MG Road, Bengaluru", gstin: "29ABCPE1234F1Z5", billNo: "B-1042", items: [{ name: "Masala chai", qty: 2, rate: 40 }, { name: "Samosa", qty: 3, rate: 25 }], gstRate: 5, gstInclusive: true, payment: "UPI", upi: "chai@ybl", width: 80 } }, check: (s, h) => ok(needPdf(s, h, { pages: 1, text: ["Chai Point", "Masala chai", "TOTAL", "₹155.00"] }).notes) },
  { id: "gst-filing", slug: "gst-filing", options: { business: "Blaze", period: "Sep 2026", rows: [
      { type: "B2B", inv: "INV-1", date: "2026-09-02", party: "Acme", gstin: "27AAACA1234B1Z9", pos: "27", taxable: 100000, rate: 18, interstate: true },
      { type: "B2B", inv: "INV-2", date: "2026-09-10", party: "Zeta", gstin: "29AAACZ1234B1Z9", pos: "29", taxable: 50000, rate: 18, interstate: false },
      { type: "B2C", inv: "INV-3", date: "2026-09-12", party: "Walk-in", gstin: "", pos: "29", taxable: 10000, rate: 5, interstate: false } ] },
    check: (s, h) => {
      const r = needPdf(s, h, { text: ["GST working paper", "Summary by tax rate", "18,000.00", "4,500.00"] });
      return ok([...r.notes, first(s, ".csv") ? "csv" : "✗ csv"]);
  } },
  { id: "resume", slug: "resume", options: { resume: { name: "Asha Verma", title: "Account Executive", email: "asha@example.com", phone: "+91 90000 00000", location: "Bengaluru", links: "linkedin.com/in/asha", summary: "SaaS seller with 5 years of closing mid-market deals.", experience: [{ role: "AE", org: "Skit.ai", start: "2022", end: "Present", points: "Closed ₹3 Cr ARR\nBuilt outbound playbook" }], education: [{ degree: "B.Tech", school: "NIT Jalandhar", year: "2018", detail: "" }], skills: "Negotiation, Salesforce, Outbound", extras: [], template: "classic" } }, check: (s, h) => ok(needPdf(s, h, { pages: 1, text: ["Asha Verma", "Closed ₹3 Cr ARR", "NIT Jalandhar", "Negotiation"] }).notes) },
  { id: "audio-transcript", slug: "audio-to-pdf", options: { title: "Call notes", body: "We agreed on pricing. Next call Friday." }, check: (s, h) => ok(needPdf(s, h, { text: ["Call notes", "pricing"] }).notes) },
];
