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
/** Expected table cells from a fixture page in html/ (a line break inside a cell becomes " / "). */
function htmlTable(file) {
  const src = readFileSync(new URL("./html/" + file, import.meta.url), "utf8");
  return [...src.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((m) =>
    [...m[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/gs)].map((c) => c[1].replace(/<span[^>]*>(.*?)<\/span>/g, "$1").replace(/<br>/g, " / ").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim()),
  );
}
/** Tables (cell paragraphs joined by " / "), body paragraphs and page orientation of a .docx. */
function docxLayout(h, path) {
  return JSON.parse(
    py(
      h,
      `import docx,json
d=docx.Document(${JSON.stringify(path)});s=d.sections[0]
head=lambda t:t.rows[0]._tr.trPr is not None and 'tblHeader' in t.rows[0]._tr.trPr.xml
print(json.dumps({"landscape":s.page_width>s.page_height,"body":[p.text for p in d.paragraphs if p.text.strip()],"tables":[{"header":head(t),"cells":[[" / ".join(p.text for p in c.paragraphs) for c in r.cells] for r in t.rows]} for t in d.tables]}))`,
    ),
  );
}
/** A .docx as structure (see docx-dump.py): body blocks in order, header and footer. */
const docxDump = (h, path) => JSON.parse(h.sh("python3", [new URL("./docx-dump.py", import.meta.url).pathname, path]).out);
/** Every paragraph, in reading order, including those inside tables. */
const parasIn = (blocks) => blocks.flatMap((b) => (b.t === "p" ? [b] : b.rows.flatMap((r) => r.flatMap((c) => parasIn(c.blocks)))));
/** Every table, outer ones first, including tables nested in cells. */
const tablesIn = (blocks) => blocks.flatMap((b) => (b.t === "table" ? [b, ...b.rows.flatMap((r) => r.flatMap((c) => tablesIn(c.blocks)))] : []));
const cellText = (c) => parasIn(c.blocks).map((p) => p.text).join(" / ");
const shape = (t) => `${t.rows.length}x${Math.max(...t.rows.map((r) => r.length))}`;
/** A check: "label" when it holds, "✗ label" when it doesn't. */
const expect = (ok, label) => (ok ? label : `✗ ${label}`);
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
  { id: "stamp-image", slug: "stamp-image", files: ["text.pdf", "thumb.png"], options: { where: "last", caption: "L.T.I." }, check: (s, h) => ok(needPdf(s, h, { pages: 4, text: ["L.T.I."] }).notes) },
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
  { id: "pdf-to-word-wrapped-table", slug: "pdf-to-word", files: ["partners.pdf"], check: (s, h) => {
      const d = docxLayout(h, first(s, ".docx").path);
      const want = htmlTable("partners.html");
      const t = d.tables[0];
      const notes = [d.tables.length === 1 ? "one table" : `✗ ${d.tables.length} tables`];
      if (t) {
        const shape = `${t.cells.length}x${t.cells[0].length}`;
        notes.push(shape === `${want.length}x${want[0].length}` ? shape : `✗ shape ${shape}`);
        const bad = want.flatMap((r, i) => r.flatMap((c, j) => ((t.cells[i]?.[j] ?? "") === c ? [] : [`r${i}c${j}`])));
        notes.push(bad.length ? `✗ ${bad.length} cells differ (${bad.slice(0, 4).join(", ")})` : "every cell matches", t.header ? "header row" : "✗ no header row");
      }
      notes.push(d.landscape ? "landscape" : "✗ portrait", d.body.length === 2 ? "nothing leaked out of the table" : `✗ ${d.body.length} paragraphs outside tables`);
      return ok(notes);
  } },
  { id: "pdf-to-word-table-styles", slug: "pdf-to-word", files: ["table-styles.pdf"], check: (s, h) => {
      const d = docxLayout(h, first(s, ".docx").path);
      const shapes = d.tables.map((t) => `${t.cells.length}x${t.cells[0].length}`).join(" ");
      return ok([
        shapes === "5x4 4x2 5x4 4x5" ? `tables ${shapes}` : `✗ tables ${shapes}`,
        d.tables[1]?.cells[1]?.[1]?.endsWith("in any way at all.") ? "wrapped cell kept whole" : "✗ wrapped cell split",
        d.tables[2]?.cells[4]?.join("|") === "Total|4,63,600|2,92,800|1,70,800" ? "totals row" : "✗ totals row",
        d.tables[3]?.cells[0]?.slice(1, 3).every((c) => c === "2025 results overall") && d.tables[3]?.cells[1]?.join("|") === "Region|Deals|Value|Deals|Value" ? "grouped header over its two columns" : "✗ grouped header",
        d.body.some((p) => p.startsWith("Paragraph after table A")) ? "paragraph after table" : "✗ paragraph swallowed",
        d.body.some((p) => p.startsWith("Figures in rupees")) ? "note after table" : "✗ note swallowed",
      ]);
  } },
  // Designed documents of the kinds people convert, printed from html/ by Chromium.
  { id: "pdf-to-word-brief", slug: "pdf-to-word", files: ["brief.pdf"], check: (s, h) => {
      const d = docxDump(h, first(s, ".docx").path);
      const ps = parasIn(d.body);
      const ts = tablesIn(d.body);
      const text = ps.map((p) => p.text).join("\n");
      const h1 = ps.filter((p) => p.style === "Heading1");
      const checks = ps.filter((p) => p.list?.format === "bullet" && p.list.text === "☐");
      const qs = ps.filter((p) => p.list?.format === "decimal" && p.list.level === 0 && /^(Which|If we|What)/.test(p.text));
      const grid = ts.find((t) => cellText(t.rows[0][0]).startsWith("a\tThe support rota"));
      const sources = ps.filter((p) => p.list && /^(Sprint review|Bug tracker|Support rota, March|Partner status|Payment test|Campaign brief|Customer survey)/.test(p.text));
      const kv = ts[0];
      const cards = ts.find((t) => cellText(t.rows[0][0]).startsWith("READING B"));
      const frame = ts.find((t) => t.rows.length === 1 && t.rows[0].length === 1 && cellText(t.rows[0][0]).startsWith("OPTION 2"));
      const options = ts.find((t) => cellText(t.rows[0][0]) === "OPTION");
      return ok([
        expect(!/[-ʼ�]/.test(text), "no stand-in characters"),
        expect(ps.some((p) => p.text === "LAUNCH REVIEW · FIRST DRAFT"), "letter-spaced label reads as words"),
        expect(h1.length === 1 && h1[0].text.replace(/\s+/g, " ") === "A first look at the spring launch", "one title"),
        expect(ps.some((p) => p.style === "Heading2" && p.text === "07 Five questions for the team"), "section headings"),
        expect(kv && shape(kv) === "4x2" && cellText(kv.rows[0][1]).startsWith("The product is ready"), "summary table 4x2"),
        expect(cards && cards.rows[0].length === 3 && cards.rows[0][0].fill === "F6F8F9" && cellText(cards.rows[0][2]).endsWith("the only story anyone remembers."), "cards side by side, the one cut by the page joined"),
        expect(options && shape(options) === "5x4", "options table 5x4"),
        expect(frame && tablesIn(frame.rows[0][0].blocks).some((t) => shape(t) === "3x2"), "framed card with its table inside"),
        expect(ts.some((t) => t.rows[0][0].fill === "0E4A54"), "dark callout"),
        expect(checks.length === 3 && checks[0].text.startsWith("Confirm the partner date"), "check list of 3"),
        expect(qs.length === 5 && !!grid && shape(grid) === "2x2" && cellText(grid.rows[1][1]) === "d\tThe second campaign", "five questions, options in a grid"),
        expect(sources.length === 9, "9 sources"),
        expect(ps.some((p) => p.text.startsWith("1 As reported by the partner")), "footnote kept"),
        expect(d.footer.page && d.footer.text.startsWith("Team Atlas"), "footer with page numbers"),
      ]);
  } },
  { id: "pdf-to-word-resume", slug: "pdf-to-word", files: ["resume.pdf"], check: (s, h) => {
      const d = docxDump(h, first(s, ".docx").path);
      const ps = parasIn(d.body);
      const bullets = ps.filter((p) => p.list?.format === "bullet");
      const heads = ps.filter((p) => /^Heading/.test(p.style ?? ""));
      return ok([
        expect(ps.some((p) => p.style === "Heading1" && p.text === "Jordan Ellis" && p.align === "center"), "name centred"),
        expect(ps.some((p) => p.text === "Lead Product Designer\tMarch 2021 – Present" && p.tabs?.includes("right")), "dates flush right on a tab"),
        expect(bullets.length === 6, `${bullets.length} bullets`),
        expect(heads.filter((p) => p.border?.includes("bottom")).length >= 4, "section rules under headings"),
        expect(!ps.some((p) => p.text.split("\n").some((l) => l.includes("Design:") && l.includes("Tools:"))), "skills lines kept apart"),
        expect(!d.body.some((b) => b.t === "table"), "no tables"),
      ]);
  } },
  { id: "pdf-to-word-exam", slug: "pdf-to-word", files: ["exam.pdf"], check: (s, h) => {
      const d = docxDump(h, first(s, ".docx").path);
      const ps = parasIn(d.body);
      const roman = ps.filter((p) => p.list?.format === "lowerRoman");
      const qs = ps.filter((p) => p.list?.format === "decimal" && /\t\[1\]$/.test(p.text));
      const marks = tablesIn(d.body).find((t) => cellText(t.rows[0][0]) === "Marks");
      return ok([
        expect(ps.some((p) => p.text === "Greenfield Public School" && p.align === "center"), "title centred"),
        expect(ps.some((p) => p.text === "Time allowed: 3 hours\tMaximum marks: 80" && p.border?.includes("bottom")), "time and marks at either end, ruled"),
        expect(roman.length === 4, "instructions (i) to (iv)"),
        expect(qs.length === 4, "questions numbered, marks flush right"),
        expect(ps.some((p) => p.text === "(a) 2⁵\t(b) 2⁶") && ps.some((p) => p.text === "(a) 1\t(b) 2\t(c) 3\t(d) 4"), "options in rows"),
        expect(ps.some((p) => p.text === "OR" && p.align === "center"), "OR between alternatives"),
        expect(marks && shape(marks) === "2x5", "marks table 2x5"),
        expect(ps.filter((p) => p.list?.format === "lowerLetter").length === 2, "sub-parts (a) and (b)"),
        expect(d.footer.page && d.footer.pages, "page x of y in the footer"),
      ]);
  } },
  { id: "pdf-to-word-invoice", slug: "pdf-to-word", files: ["invoice.pdf"], check: (s, h) => {
      const d = docxDump(h, first(s, ".docx").path);
      const top = d.body.find((b) => b.t === "table");
      const ts = tablesIn(d.body);
      const items = ts.find((t) => cellText(t.rows[0][1]) === "Description");
      const totals = ts.find((t) => cellText(t.rows[0][0]) === "Subtotal");
      const ps = parasIn(d.body);
      return ok([
        expect(top && top.rows.length === 1 && cellText(top.rows[0][0]).startsWith("Brightline Studio") && cellText(top.rows[0][1]).startsWith("INVOICE"), "letterhead and invoice details side by side"),
        expect(top && cellText(top.rows[0][0]).includes("BILL TO") && cellText(top.rows[0][1]).includes("SHIP TO"), "billing and shipping side by side"),
        expect(items && shape(items) === "5x5" && items.rows[0][0].fill === "2A5D84", "item table 5x5 with its shaded header"),
        expect(ps.some((p) => p.text === "54,000.00" && p.align === "right"), "amounts flush right"),
        expect(totals && shape(totals) === "4x2" && cellText(totals.rows[3][1]) === "₹1,04,902.00", "totals"),
        expect(ps.some((p) => p.text === "Payment terms"), "terms after the tables"),
      ]);
  } },
  { id: "pdf-to-word-contract", slug: "pdf-to-word", files: ["contract.pdf"], check: (s, h) => {
      const d = docxDump(h, first(s, ".docx").path);
      const ps = parasIn(d.body);
      const clauses = ps.filter((p) => /^\d\.\d\t/.test(p.text));
      const subs = ps.filter((p) => p.list?.format === "lowerLetter");
      const sig = tablesIn(d.body).find((t) => cellText(t.rows[0][0]).startsWith("Signed for Harbour"));
      return ok([
        expect(ps.some((p) => p.text === "SERVICES AGREEMENT" && p.align === "center"), "title centred"),
        expect(["1. Definitions", "2. Term", "6. Termination"].every((t) => ps.some((p) => p.text === t && /^Heading/.test(p.style ?? ""))), "numbered headings"),
        expect(clauses.length === 12, `${clauses.length} clauses with their numbers`),
        expect(clauses.filter((p) => p.align === "both").length >= 10, "clauses justified"),
        expect(subs.length === 3, "sub-clauses (a) to (c)"),
        expect(sig && sig.rows[0].length === 2, "signature blocks side by side"),
        expect(d.header.text.includes("Services Agreement"), "running header"),
      ]);
  } },
  { id: "pdf-to-word-letter", slug: "pdf-to-word", files: ["letter.pdf"], check: (s, h) => {
      const d = docxDump(h, first(s, ".docx").path);
      const ps = parasIn(d.body);
      return ok([
        expect(ps.some((p) => p.align === "right" && p.text === "Flat 4, Rosewood Apartments\n17 Hill Road, Bandra West\nMumbai 400050\nasha.menon@example.com"), "sender's address flush right, line by line"),
        expect(ps.some((p) => p.text === "The Branch Manager\nCoastal Co-operative Bank\nLinking Road Branch\nMumbai 400052"), "recipient's address line by line"),
        expect(ps.filter((p) => p.list?.format === "bullet").length === 3, "3 bullets"),
        expect(!d.body.some((b) => b.t === "table"), "no tables"),
      ]);
  } },
  { id: "pdf-to-word-cv-sidebar", slug: "pdf-to-word", files: ["cv-sidebar.pdf"], check: (s, h) => {
      const d = docxDump(h, first(s, ".docx").path);
      const t = d.body.find((b) => b.t === "table");
      const side = t?.rows[0][0];
      const main = t?.rows[0][1];
      return ok([
        expect(t && t.rows.length === 1 && t.rows[0].length === 2, "sidebar beside the main column"),
        expect(side?.fill === "24364B" && cellText(side).startsWith("Rohan Iyer"), "sidebar keeps its colour"),
        expect(side && parasIn(side.blocks).filter((p) => p.list?.format === "bullet").length === 6, "skills list in the sidebar"),
        expect(main && parasIn(main.blocks).some((p) => p.text === "Senior Data Engineer\t2023 – now"), "experience with dates in the main column"),
      ]);
  } },
  { id: "pdf-to-word-site-report", slug: "pdf-to-word", files: ["site-report.pdf"], check: (s, h) => {
      const d = docxDump(h, first(s, ".docx").path);
      const ps = parasIn(d.body);
      const ts = tablesIn(d.body);
      const pic = (c) => parasIn(c.blocks).some((p) => p.pics);
      const head = d.body.find((b) => b.t === "table");
      const figure = ps.findIndex((p) => p.text.startsWith("Figure 1."));
      const row = ts.find((t) => t.rows.length === 1 && t.rows[0].filter(pic).length === 3);
      const items = ts.find((t) => cellText(t.rows[0][0]) === "Item");
      const callout = ts.find((t) => t.rows[0].length === 2 && pic(t.rows[0][0]) && cellText(t.rows[0][1]).startsWith("Site visit"));
      return ok([
        expect(head && pic(head.rows[0][0]) && cellText(head.rows[0][1]).startsWith("Riverside Clinic"), "logo beside the letterhead"),
        expect(d.body[1] && d.body.slice(1, 3).some((b) => b.t === "p" && b.pics), "banner photo under the letterhead"),
        expect(figure > 0 && ps[figure - 1].pics === 1, "figure above its caption"),
        expect(ts.some((t) => t.rows[0].length === 2 && pic(t.rows[0][0]) && cellText(t.rows[0][1]).startsWith("The roofing team")), "photo beside its text"),
        expect(row && ["Reception", "Plant room", "Corridor"].every((w) => row.rows[0].some((c) => pic(c) && parasIn(c.blocks).some((p) => p.text.startsWith(w)))), "three photos in a row, each over its caption"),
        expect(items && shape(items) === "4x3" && items.rows.slice(1).every((r) => pic(r[0])) && cellText(items.rows[1][1]).startsWith("Fire doors"), "thumbnails in the table's rows"),
        expect(callout, "picture inside the callout box"),
        expect(ps.filter((p) => p.pics === 1 && /Site office|site\.office/.test(p.text)).length === 2, "icons kept in the contact lines"),
        expect(d.header.pics === 1, "repeated logo in the running header, once"),
      ]);
  } },
  { id: "pdf-to-excel-wrapped-table", slug: "pdf-to-excel", files: ["partners.pdf"], check: (s, h) => {
      const x = first(s, ".xlsx");
      const rows = JSON.parse(py(h, `import openpyxl,json;ws=openpyxl.load_workbook(${JSON.stringify(x.path)}).active;print(json.dumps([[c if c is not None else "" for c in r] for r in ws.iter_rows(values_only=True)]))`));
      const want = htmlTable("partners.html");
      const entries = rows.filter((r) => want.slice(1).some((w) => w[0] === r[0]));
      const row = rows.find((r) => r[0] === want[1][0]);
      return ok([entries.length === want.length - 1 ? `${entries.length} entries, one row each` : `✗ ${entries.length} entry rows`, row?.[1] === want[1][1] ? "description in one cell" : "✗ description split"]);
  } },
  { id: "pdf-to-markdown-table", slug: "pdf-to-markdown", files: ["partners.pdf"], check: (s) => {
      const lines = readFileSync(first(s, ".md").path, "utf8").split("\n").filter((l) => l.startsWith("| "));
      return ok([lines.length === 10 ? "10 table lines" : `✗ ${lines.length} table lines`, lines.some((l) => l.startsWith("| Northwind Labs | Consulting and training firm")) ? "row intact" : "✗ row broken"]);
  } },
  { id: "pdf-to-word-exact", slug: "pdf-to-word", files: ["cmp-a.pdf"], options: { mode: "exact" }, check: (s, h) => {
      const o = h.officeText(first(s, ".docx").path);
      return ok([o.ok ? "opens in LibreOffice" : "✗ " + o.note]);
  } },
  // A bank statement on one sheet: one table of transactions, its header once, real dates and
  // numbers, references kept as text, and totals that agree with the statement's own summary.
  { id: "pdf-to-excel-statement", slug: "pdf-to-excel", files: ["statement.pdf"], options: { oneSheet: true }, check: (s, h) => {
      const r = JSON.parse(py(h, `import openpyxl,json,datetime
wb=openpyxl.load_workbook(${JSON.stringify(first(s, ".xlsx").path)});ws=wb.active
rows=[[c.value for c in r] for r in ws.iter_rows()]
D=datetime.datetime
hd=[i for i,r in enumerate(rows) if r[:7]==['Date','Narration','Chq./Ref.No.','Value Dt','Withdrawal Amt.','Deposit Amt.','Closing Balance']]
body=[r for r in rows[hd[0]+1:] if isinstance(r[0],D)] if hd else []
sm=[i for i,r in enumerate(rows) if r[0]=='Opening Balance']
tot=rows[sm[0]+1] if sm else []
cells=[v for r in rows for v in r if v is not None]
print(json.dumps({"sheets":len(wb.worksheets),"heads":len(hd),"n":len(body),
"open":body[0][1]=='OPENING BALANCE' and body[0][0]==D(2026,8,1) and body[0][6]==48210.55 if body else False,
"refs":all(r[2] is None or (isinstance(r[2],str) and r[2].startswith('000')) for r in body[1:]),
"dates":all(isinstance(r[3],D) for r in body[1:]),"fmt":ws.cell(row=hd[0]+3,column=1).number_format if hd else '',
"sums":bool(tot) and abs(sum(r[4] or 0 for r in body)-tot[3])<0.01 and abs(sum(r[5] or 0 for r in body)-tot[4])<0.01 and abs(body[-1][6]-tot[5])<0.01,
"account":'50100123456789' in cells,"bank":sum(1 for v in cells if v=='NORTHBRIDGE BANK'),"pages":any('Page 1' in str(v) for v in cells),
"wrapped":'BIL/ONL/000123456789/METRO POWER/MUMBAI ELECTRICITY BILL AUG' in cells}))`));
      return ok([
        expect(r.sheets === 1 && r.heads === 1 && r.n === 67, `one table of 67 rows, header once (${r.sheets} sheets, ${r.heads} headers, ${r.n} rows)`),
        expect(r.open, "opening balance row, dated"),
        expect(r.dates && r.fmt === "dd\\/mm\\/yy", "value dates are dates, shown day first"),
        expect(r.refs, "references keep their leading zeros"),
        expect(r.sums, "withdrawals, deposits and closing balance agree with the summary"),
        expect(r.account, "account number kept as text"),
        expect(r.bank === 1 && !r.pages, "letterhead once, no page numbers"),
        expect(r.wrapped, "wrapped description in one cell"),
      ]);
  } },
  { id: "pdf-to-excel-income-statement", slug: "pdf-to-excel", files: ["income-statement.pdf"], check: (s, h) => {
      const r = JSON.parse(py(h, `import openpyxl,json
ws=openpyxl.load_workbook(${JSON.stringify(first(s, ".xlsx").path)}).active
row=lambda k:next((r for r in ws.iter_rows() if r[0].value==k),None)
rv=row('Revenue');cs=row('Cost of sales');ip=row('Impairment of goodwill');bp=row('Basic (pence)')
yr=next((c for r in ws.iter_rows() for c in r if c.value=='Year to 31 March'),None)
print(json.dumps({"revenue":[c.value for c in rv[1:6]] if rv else None,"indent":rv[0].alignment.indent if rv else 0,
"neg":[cs[2].value,cs[2].number_format] if cs else None,"pct":[rv[5].number_format] if rv else None,"nil":ip[2].value if ip else None,
"merged":any(str(m).startswith(yr.coordinate+':') and m.max_col-m.min_col==1 for m in ws.merged_cells.ranges) if yr else False,
"k":any(c.value=='£000' for r in ws.iter_rows() for c in r),"eps":[c.value for c in bp[1:5]] if bp else None}))`));
      return ok([
        expect(JSON.stringify(r.revenue) === "[3,412870,389114,23756,0.061]", `revenue row as numbers (${JSON.stringify(r.revenue)})`),
        expect(r.indent >= 1, "items indented under their section"),
        expect(r.neg?.[0] === -251032 && /\(#,##0\)/.test(r.neg?.[1] ?? ""), "bracketed figures negative, still shown in brackets"),
        expect(r.pct?.[0] === "0.0%", "percentages as percentages"),
        expect(r.nil === "—", "a dash for nil stays a dash"),
        expect(r.merged, "heading over two columns spans them"),
        expect(r.k, "£000 stays a heading"),
        expect(JSON.stringify(r.eps) === "[8,18.42,13.21,5.21]", "earnings per share rows in the same table"),
      ]);
  } },
  { id: "pdf-to-excel-price-list", slug: "pdf-to-excel", files: ["price-list.pdf"], check: (s, h) => {
      const r = JSON.parse(py(h, `import openpyxl,json,datetime
ws=openpyxl.load_workbook(${JSON.stringify(first(s, ".xlsx").path)}).active
row=next((r for r in ws.iter_rows() if r[0].value=='000142'),None)
grp=next((c for r in ws.iter_rows() for c in r if c.value=='Adhesives and sealants'),None)
print(json.dumps({"row":[c.value if not isinstance(c.value,datetime.datetime) else c.value.strftime('%Y-%m-%d') for c in row[:9]] if row else None,
"fmts":[row[3].number_format,row[4].number_format] if row else None,
"group":any(str(m).startswith(grp.coordinate+':') and m.max_col-m.min_col==8 for m in ws.merged_cells.ranges) if grp else False,
"landscape":ws.page_setup.orientation}))`));
      return ok([
        expect(JSON.stringify(r.row) === '["000142","Wood screw, 4 x 40 mm, zinc","Box of 200",12.4,0.15,10.54,1240,"Next day","2026-09-14"]', `a row in nine columns, typed (${JSON.stringify(r.row)})`),
        expect(r.fmts?.[0] === '"$"0.00' && r.fmts?.[1] === "0%", "prices and discounts keep their look"),
        expect(r.group, "group names across the table"),
        expect(r.landscape === "landscape", "prints landscape like the PDF"),
      ]);
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
  // Background tab: no animation frames are delivered, so rendering must not wait for them.
  { id: "hidden-tab-pdf-to-jpg", slug: "pdf-to-jpg", files: ["text.pdf"], options: { dpi: "72" }, hidden: true, check: (s) => ok([all(s, ".jpg").length === 4 ? "4 jpgs with the tab hidden" : `✗ ${all(s, ".jpg").length}`]) },
  { id: "hidden-tab-grayscale", slug: "grayscale-pdf", files: ["cmp-a.pdf"], hidden: true, check: (s, h) => ok(needPdf(s, h, { pages: 1 }).notes) },
  { id: "hidden-tab-ocr-pdf", slug: "ocr-pdf", files: ["scan.pdf"], options: { lang: "eng" }, hidden: true, check: (s, h) => ok(needPdf(s, h, { pages: 1, text: ["Quarterly Operations"] }).notes) },
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
      const r = needPdf(s, h, { pages: 4, text: ["Quarterly", "finance lead", "Consulting hours"], notText: ["priya.sharma@example.com", "ABCDE1234F", "81234 50987", "4111 1111 1111 1111", "2345 6789 0123", "27ABCDE1234F1Z5"] });
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
      const sha512 = h.sh("sha512sum", [h.join(h.FX, "text.pdf")]).out.split(" ")[0];
      return ok([t.includes(sha) ? "sha256 ok" : "✗ sha256", t.includes(sha512) ? "sha512 ok" : "✗ sha512", t.includes(md5) ? "md5 ok" : "✗ md5", t.includes(sha1) ? "sha1 ok" : "✗ sha1", /Pages:\s+4/.test(t) ? "pdf info" : "✗ pdf info"]);
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
