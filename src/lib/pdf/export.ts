/** PDF → other formats. */
import JSZip from "jszip";
import { BRAND } from "@/lib/brand";
import { canvasToBytes, stem, tick, type OutFile, type ProgressFn } from "./core";
import { imagesByPage } from "./contentstream";
import { open, withZip, type Src } from "./pages";
import { decodePixels, jpegBytes, listImages, pixelsToCanvas } from "./pdfimages";
import { extractPages, linesToText, renderPage, toLines, withPdfjs, type PageText } from "./pdfjs";
import { analyze, pageGrid, runsText, type Run, type SBlock } from "./structure";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function readStructured(src: Src, onProgress?: ProgressFn) {
  const pages = await extractPages(src.bytes, { password: src.password, styles: true, onProgress: (f, l) => onProgress?.(f * 0.5, l) });
  const chars = pages.reduce((s, p) => s + p.items.reduce((a, i) => a + i.str.trim().length, 0), 0);
  if (chars < 20) throw new Error("This looks like a scan, so there's no text to convert. Open it in OCR: Searchable PDF first.");
  return { pages, blocks: analyze(pages) };
}

/* ------------------------------------------------------------- images */

export type ExtractedImage = { name: string; bytes: Uint8Array; mime: string; page: number; width: number; height: number };

export async function extractImages(src: Src, o: { minSize?: number; format?: "original" | "png" } = {}, onProgress?: ProgressFn): Promise<ExtractedImage[]> {
  const doc = await open(src);
  const pageOf = imagesByPage(doc);
  const images = listImages(doc).filter((im) => !im.isMask && !im.usedAsMask && im.width >= (o.minSize ?? 24) && im.height >= (o.minSize ?? 24));
  const out: ExtractedImage[] = [];
  for (let k = 0; k < images.length; k++) {
    const im = images[k];
    onProgress?.(k / Math.max(1, images.length), `Extracting image ${k + 1} of ${images.length}`);
    const page = pageOf.get(im.ref.toString()) ?? -1;
    const base = `${stem(src.name)}-p${page >= 0 ? page + 1 : "x"}-img${String(k + 1).padStart(3, "0")}`;
    const jpg = jpegBytes(im);
    if (jpg && !im.smask && o.format !== "png" && im.colorSpace.kind !== "cmyk") {
      out.push({ name: `${base}.jpg`, bytes: jpg, mime: "image/jpeg", page, width: im.width, height: im.height });
      continue;
    }
    let canvas: HTMLCanvasElement | null = null;
    if (jpg) {
      try {
        const bmp = await createImageBitmap(new Blob([jpg.slice()], { type: "image/jpeg" }));
        canvas = document.createElement("canvas");
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext("2d")!.drawImage(bmp, 0, 0);
        bmp.close();
      } catch {
        canvas = null;
      }
    } else {
      const px = decodePixels(doc, im);
      if (px) canvas = pixelsToCanvas(px);
    }
    if (!canvas) continue;
    out.push({ name: `${base}.png`, bytes: await canvasToBytes(canvas, "image/png"), mime: "image/png", page, width: im.width, height: im.height });
    if (k % 4 === 3) await tick();
  }
  out.sort((a, b) => a.page - b.page);
  return out;
}

export async function extractImagesFiles(src: Src, o: { minSize?: number; format?: "original" | "png" } = {}, onProgress?: ProgressFn): Promise<OutFile[]> {
  const imgs = await extractImages(src, o, onProgress);
  if (!imgs.length) throw new Error("No embedded pictures were found. Pages drawn with vector graphics have no pictures to extract; use PDF to JPG to capture whole pages instead.");
  return withZip(
    imgs.map((i) => ({ filename: i.name, bytes: i.bytes, mime: i.mime, note: `${i.width}×${i.height}px${i.page >= 0 ? ` · page ${i.page + 1}` : ""}` })),
    `${stem(src.name)}-images.zip`,
  );
}

/* --------------------------------------------------------------- text */

export async function pdfToText(src: Src, o: { layout?: boolean; pageBreaks?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const pages = await extractPages(src.bytes, { password: src.password, onProgress });
  const texts = pages.map((p) => (o.layout ? layoutText(p) : linesToText(toLines(p))));
  const chars = texts.join("").trim().length;
  if (!chars) throw new Error("No text found. This PDF is probably scanned; run Searchable PDF (OCR) first.");
  const body = texts.map((t, i) => (o.pageBreaks === false ? t : `${i ? "\n\n" : ""}--- Page ${i + 1} ---\n\n${t}`)).join(o.pageBreaks === false ? "\n\n" : "");
  return { filename: `${stem(src.name)}.txt`, bytes: new TextEncoder().encode(body.trim() + "\n"), mime: "text/plain", note: `${chars.toLocaleString()} characters` };
}

/** Monospaced reproduction of the page layout (columns and tables keep their alignment). */
function layoutText(p: PageText): string {
  const lines = toLines(p);
  const charW = 5.2;
  let prevBottom = 0;
  const out: string[] = [];
  for (const l of lines) {
    const gap = l.y - prevBottom;
    if (prevBottom && gap > l.h * 1.2) out.push("");
    let s = "";
    for (const it of l.items) {
      const col = Math.max(0, Math.round(it.x / charW));
      if (s.length < col) s += " ".repeat(col - s.length);
      else if (s && !s.endsWith(" ")) s += " ";
      s += it.str;
    }
    out.push(s.trimEnd());
    prevBottom = l.y + l.h;
  }
  return out.join("\n");
}

/* ------------------------------------------------------------- markdown */

const mdEsc = (s: string) => s.replace(/([*_`[\]#|\\])/g, "\\$1");
const mdRuns = (runs: Run[]) =>
  runs
    .map((r) => {
      const t = mdEsc(r.text);
      if (!t.trim()) return t;
      const lead = t.match(/^\s*/)?.[0] ?? "";
      const trail = t.match(/\s*$/)?.[0] ?? "";
      const core = t.trim();
      return lead + (r.bold && r.italic ? `***${core}***` : r.bold ? `**${core}**` : r.italic ? `*${core}*` : core) + trail;
    })
    .join("");

export function blocksToMarkdown(blocks: SBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "heading") out.push(`${"#".repeat(b.level)} ${b.text}`);
    else if (b.kind === "para") out.push(mdRuns(b.runs));
    else if (b.kind === "list") out.push(b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : "-"} ${mdRuns(it)}`).join("\n"));
    else if (b.kind === "table") {
      const w = Math.max(...b.rows.map((r) => r.length));
      const row = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|")).join(" | ")} |`;
      out.push([row(b.rows[0]), `| ${Array.from({ length: w }, () => "---").join(" | ")} |`, ...b.rows.slice(1).map(row)].join("\n"));
    }
  }
  return out.join("\n\n") + "\n";
}

export async function pdfToMarkdown(src: Src, onProgress?: ProgressFn): Promise<OutFile> {
  const { blocks } = await readStructured(src, onProgress);
  return { filename: `${stem(src.name)}.md`, bytes: new TextEncoder().encode(blocksToMarkdown(blocks)), mime: "text/markdown" };
}

/* ----------------------------------------------------------------- html */

function blocksToHtml(blocks: SBlock[], imgs: Map<number, ExtractedImage[]>): string {
  const runs = (rs: Run[]) => rs.map((r) => (r.bold && r.italic ? `<strong><em>${esc(r.text)}</em></strong>` : r.bold ? `<strong>${esc(r.text)}</strong>` : r.italic ? `<em>${esc(r.text)}</em>` : esc(r.text))).join("");
  const out: string[] = [];
  let page = 0;
  const flushImgs = (p: number) => {
    for (const im of imgs.get(p) ?? []) out.push(`<figure><img src="data:${im.mime};base64,${b64(im.bytes)}" alt="" width="${Math.min(im.width, 720)}"></figure>`);
  };
  for (const b of blocks) {
    if (b.kind === "pagebreak") {
      flushImgs(page);
      page = b.page;
      out.push(`<hr class="page" aria-label="Page ${b.page + 1}">`);
    } else if (b.kind === "heading") out.push(`<h${b.level}>${esc(b.text)}</h${b.level}>`);
    else if (b.kind === "para") out.push(`<p>${runs(b.runs)}</p>`);
    else if (b.kind === "list") out.push(`<${b.ordered ? "ol" : "ul"}>${b.items.map((i) => `<li>${runs(i)}</li>`).join("")}</${b.ordered ? "ol" : "ul"}>`);
    else if (b.kind === "table") out.push(`<table><thead><tr>${b.rows[0].map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
  }
  flushImgs(page);
  return out.join("\n");
}

function b64(u: Uint8Array) {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

const HTML_CSS = `body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:46rem;margin:2.5rem auto;padding:0 1.25rem;color:#1a1a1a}
h1,h2,h3{line-height:1.25}table{border-collapse:collapse;margin:1rem 0;width:100%}th,td{border:1px solid #ccc;padding:.35rem .5rem;text-align:left;vertical-align:top}th{background:#f3f3f3}
figure{margin:1rem 0}img{max-width:100%;height:auto}hr.page{border:0;border-top:1px dashed #ddd;margin:2rem 0}`;

export async function pdfToHtml(src: Src, o: { mode?: "reflow" | "exact"; images?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const title = stem(src.name);
  if (o.mode === "exact") return pdfToHtmlExact(src, onProgress);
  const { blocks } = await readStructured(src, onProgress);
  const imgs = new Map<number, ExtractedImage[]>();
  if (o.images !== false) {
    for (const im of await extractImages(src, { minSize: 40 }).catch(() => [])) imgs.set(im.page, [...(imgs.get(im.page) ?? []), im]);
  }
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="generator" content="${esc(BRAND.name)}"><style>${HTML_CSS}</style></head><body>\n${blocksToHtml(blocks, imgs)}\n</body></html>\n`;
  return { filename: `${title}.html`, bytes: new TextEncoder().encode(html), mime: "text/html", note: "Reflowed, readable on phones" };
}

/** Matches the PDF's appearance: each page is an image, overlaid with invisible text you can select. */
async function pdfToHtmlExact(src: Src, onProgress?: ProgressFn): Promise<OutFile> {
  const pages = await extractPages(src.bytes, { password: src.password });
  const parts: string[] = [];
  await withPdfjs(
    src.bytes,
    async ({ pdf, pageCount }) => {
      for (let i = 1; i <= pageCount; i++) {
        onProgress?.(i / pageCount, `Page ${i} of ${pageCount}`);
        const page = await pdf.getPage(i);
        const canvas = await renderPage(page, 1.6);
        page.cleanup();
        const pt = pages[i - 1];
        const img = b64(await canvasToBytes(canvas, "image/jpeg", 0.82));
        const spans = pt.items
          .filter((it) => it.str.trim() && it.dir === 0)
          .map((it) => `<span style="left:${((it.x / pt.width) * 100).toFixed(3)}%;top:${((it.y / pt.height) * 100).toFixed(3)}%;font-size:calc(var(--w) * ${(it.fontSize / pt.width).toFixed(5)});width:${((it.w / pt.width) * 100).toFixed(3)}%">${esc(it.str)}</span>`)
          .join("");
        parts.push(`<section class="pg" style="aspect-ratio:${pt.width}/${pt.height}"><img src="data:image/jpeg;base64,${img}" alt="Page ${i}">${spans}</section>`);
        canvas.width = canvas.height = 0;
        await tick();
      }
    },
    src.password,
  );
  const css = `body{margin:0;background:#e9e9e9;font-family:sans-serif}.pg{--w:min(100vw - 2rem,900px);position:relative;width:var(--w);margin:1rem auto;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.2)}.pg img{position:absolute;inset:0;width:100%;height:100%}.pg span{position:absolute;color:transparent;white-space:pre;line-height:1;transform-origin:0 0}.pg span::selection{background:rgba(0,90,255,.25)}`;
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(stem(src.name))}</title><style>${css}</style></head><body>${parts.join("\n")}</body></html>\n`;
  return { filename: `${stem(src.name)}.html`, bytes: new TextEncoder().encode(html), mime: "text/html", note: "Exact look, text still selectable" };
}

/* ----------------------------------------------------------------- docx */

export async function pdfToWord(src: Src, o: { mode?: "editable" | "exact"; pageBreaks?: boolean; images?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const d = await import("docx");
  const children: InstanceType<typeof d.Paragraph | typeof d.Table>[] = [];
  const name = stem(src.name);
  if (o.mode === "exact") {
    await withPdfjs(
      src.bytes,
      async ({ pdf, pageCount }) => {
        for (let i = 1; i <= pageCount; i++) {
          onProgress?.(i / pageCount, `Page ${i} of ${pageCount}`);
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          const canvas = await renderPage(page, 2);
          page.cleanup();
          const data = await canvasToBytes(canvas, "image/jpeg", 0.85);
          const maxW = 600;
          const w = Math.min(maxW, vp.width * 1.0);
          children.push(new d.Paragraph({ children: [new d.ImageRun({ type: "jpg", data, transformation: { width: w, height: (w * vp.height) / vp.width } })], pageBreakBefore: i > 1 }));
          await tick();
        }
      },
      src.password,
    );
  } else {
    const { blocks } = await readStructured(src, onProgress);
    const imgs = new Map<number, ExtractedImage[]>();
    if (o.images !== false) for (const im of await extractImages(src, { minSize: 40 }).catch(() => [])) imgs.set(im.page, [...(imgs.get(im.page) ?? []), im]);
    const runs = (rs: Run[], size?: number) => rs.map((r) => new d.TextRun({ text: r.text, bold: r.bold, italics: r.italic, size }));
    let page = 0;
    const pushImgs = (p: number) => {
      for (const im of imgs.get(p) ?? []) {
        const w = Math.min(560, im.width * 0.75);
        children.push(new d.Paragraph({ children: [new d.ImageRun({ type: im.mime === "image/png" ? "png" : "jpg", data: im.bytes, transformation: { width: w, height: (w * im.height) / im.width } })] }));
      }
    };
    let breakNext = false;
    for (const b of blocks) {
      if (b.kind === "pagebreak") {
        pushImgs(page);
        page = b.page;
        breakNext = o.pageBreaks !== false;
        continue;
      }
      const pb = breakNext;
      breakNext = false;
      if (b.kind === "heading") {
        const level = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3][b.level - 1];
        children.push(new d.Paragraph({ heading: level, children: [new d.TextRun(b.text)], pageBreakBefore: pb }));
      } else if (b.kind === "para") children.push(new d.Paragraph({ children: runs(b.runs), spacing: { after: 120 }, pageBreakBefore: pb }));
      else if (b.kind === "list") {
        b.items.forEach((it, i) =>
          children.push(
            new d.Paragraph({
              children: runs(it),
              ...(b.ordered ? { numbering: { reference: "num", level: 0 } } : { bullet: { level: 0 } }),
              pageBreakBefore: pb && i === 0,
            }),
          ),
        );
      } else if (b.kind === "table") {
        if (pb) children.push(new d.Paragraph({ children: [], pageBreakBefore: true }));
        const width = Math.max(...b.rows.map((r) => r.length));
        children.push(
          new d.Table({
            width: { size: 100, type: d.WidthType.PERCENTAGE },
            rows: b.rows.map(
              (r, ri) =>
                new d.TableRow({
                  tableHeader: ri === 0,
                  children: Array.from({ length: width }, (_, ci) => new d.TableCell({ children: [new d.Paragraph({ children: [new d.TextRun({ text: r[ci] ?? "", bold: ri === 0 })] })] })),
                }),
            ),
          }),
        );
        children.push(new d.Paragraph({ children: [] }));
      }
    }
    pushImgs(page);
  }
  const doc = new d.Document({
    creator: BRAND.name,
    title: name,
    numbering: { config: [{ reference: "num", levels: [{ level: 0, format: d.LevelFormat.DECIMAL, text: "%1.", alignment: d.AlignmentType.START }] }] },
    sections: [{ children: children as never[] }],
  });
  const blob = await d.Packer.toBlob(doc);
  return {
    filename: `${name}.docx`,
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    note: o.mode === "exact" ? "Pages as images (looks identical, not editable)" : "Editable text with headings, lists and tables",
  };
}

/* ---------------------------------------------------------- excel / csv */

const NUMERIC = /^[-+(]?\s?[₹$€£]?\s?\d{1,3}(?:[,\s]\d{2,3})*(?:\.\d+)?\)?$|^[-+]?\d+(?:\.\d+)?$/;
function asNumber(s: string): number | string {
  const t = s.trim();
  if (!t || !NUMERIC.test(t)) return s;
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const n = Number(t.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : s;
}

export async function pdfToExcel(src: Src, o: { oneSheet?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const XLSX = await import("xlsx");
  const pages = await extractPages(src.bytes, { password: src.password, onProgress });
  if (!pages.some((p) => p.items.some((i) => i.str.trim()))) throw new Error("No text found. This PDF is probably scanned; run Searchable PDF (OCR) first.");
  const wb = XLSX.utils.book_new();
  const all: (string | number)[][] = [];
  pages.forEach((p, i) => {
    const rows = pageGrid(p).map((r) => r.map(asNumber));
    if (o.oneSheet) {
      if (i) all.push([]);
      all.push(...rows);
    } else {
      const ws = XLSX.utils.aoa_to_sheet(rows.length ? rows : [[""]]);
      ws["!cols"] = colWidths(rows);
      XLSX.utils.book_append_sheet(wb, ws, `Page ${i + 1}`);
    }
  });
  if (o.oneSheet) {
    const ws = XLSX.utils.aoa_to_sheet(all);
    ws["!cols"] = colWidths(all);
    XLSX.utils.book_append_sheet(wb, ws, "Data");
  }
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return { filename: `${stem(src.name)}.xlsx`, bytes: new Uint8Array(out), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", note: o.oneSheet ? "All pages on one sheet" : `${pages.length} sheet${pages.length === 1 ? "" : "s"}` };
}

function colWidths(rows: (string | number)[][]) {
  const w: number[] = [];
  for (const r of rows) r.forEach((c, i) => (w[i] = Math.min(60, Math.max(w[i] ?? 6, String(c).length + 2))));
  return w.map((wch) => ({ wch }));
}

export async function pdfToCsv(src: Src, onProgress?: ProgressFn): Promise<OutFile> {
  const pages = await extractPages(src.bytes, { password: src.password, onProgress });
  const rows = pages.flatMap((p, i) => [...(i ? [[]] : []), ...pageGrid(p)]);
  if (!rows.some((r) => r.some((c) => c.trim()))) throw new Error("No text found. This PDF is probably scanned; run Searchable PDF (OCR) first.");
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n");
  return { filename: `${stem(src.name)}.csv`, bytes: new TextEncoder().encode("﻿" + csv + "\r\n"), mime: "text/csv" };
}

/* ---------------------------------------------------------------- pptx */

export async function pdfToPptx(src: Src, o: { notes?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  const texts = o.notes !== false ? await extractPages(src.bytes, { password: src.password }).catch(() => [] as PageText[]) : [];
  await withPdfjs(
    src.bytes,
    async ({ pdf, pageCount }) => {
      const first = await pdf.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      const W = 10;
      const H = (W * vp.height) / vp.width;
      pptx.defineLayout({ name: "PDF", width: W, height: H });
      pptx.layout = "PDF";
      for (let i = 1; i <= pageCount; i++) {
        onProgress?.(i / pageCount, `Slide ${i} of ${pageCount}`);
        const page = await pdf.getPage(i);
        const canvas = await renderPage(page, 2);
        page.cleanup();
        const data = `data:image/jpeg;base64,${b64(await canvasToBytes(canvas, "image/jpeg", 0.88))}`;
        const slide = pptx.addSlide();
        const pv = page.getViewport({ scale: 1 });
        const ratio = Math.min(W / (pv.width / 72), H / (pv.height / 72));
        const iw = (pv.width / 72) * ratio;
        const ih = (pv.height / 72) * ratio;
        slide.addImage({ data, x: (W - iw) / 2, y: (H - ih) / 2, w: iw, h: ih });
        const t = texts[i - 1];
        if (t) {
          const notes = linesToText(toLines(t)).slice(0, 8000);
          if (notes.trim()) slide.addNotes(notes);
        }
        canvas.width = canvas.height = 0;
        await tick();
      }
    },
    src.password,
  );
  const blob = (await pptx.write({ outputType: "blob" })) as Blob;
  return {
    filename: `${stem(src.name)}.pptx`,
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    note: o.notes !== false ? "One slide per page, page text in speaker notes" : "One slide per page",
  };
}

/* ---------------------------------------------------------------- epub */

export async function pdfToEpub(src: Src, o: { title?: string; author?: string } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const { blocks } = await readStructured(src, onProgress);
  const doc = await open(src);
  const title = o.title || doc.getTitle() || stem(src.name);
  const author = o.author || doc.getAuthor() || "";
  // Chapters: split at top-level headings; fall back to every 10 pages.
  const hasH1 = blocks.filter((b) => b.kind === "heading" && b.level === 1).length >= 2;
  const chapters: { title: string; blocks: SBlock[] }[] = [];
  let cur: { title: string; blocks: SBlock[] } = { title, blocks: [] };
  for (const b of blocks) {
    const split = hasH1 ? b.kind === "heading" && b.level === 1 : b.kind === "pagebreak" && b.page % 10 === 0;
    if (split && cur.blocks.some((x) => x.kind !== "pagebreak")) {
      chapters.push(cur);
      cur = { title: b.kind === "heading" ? b.text : `Pages ${b.page + 1}+`, blocks: [] };
    } else if (split && b.kind === "heading") cur.title = b.text;
    if (b.kind !== "pagebreak") cur.blocks.push(b);
  }
  if (cur.blocks.length) chapters.push(cur);
  // Cover from page 1.
  const cover = await withPdfjs(src.bytes, async ({ pdf }) => {
    const page = await pdf.getPage(1);
    const c = await renderPage(page, 1.6);
    page.cleanup();
    return canvasToBytes(c, "image/jpeg", 0.85);
  }, src.password).catch(() => null);
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const id = `urn:uuid:${crypto.randomUUID()}`;
  const xhtml = (t: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><meta charset="UTF-8"/><title>${esc(t)}</title><link rel="stylesheet" href="style.css"/></head><body>${body}</body></html>`;
  const toX = (bs: SBlock[]) => blocksToHtml(bs, new Map()).replace(/<br>/g, "<br/>").replace(/<hr([^>]*)>/g, "<hr$1/>");
  zip.file("OEBPS/style.css", "body{font-family:serif;line-height:1.5;margin:0 5%}h1,h2,h3{font-family:sans-serif;line-height:1.2}table{border-collapse:collapse}td,th{border:1px solid #999;padding:.2em .4em}img{max-width:100%}");
  chapters.forEach((ch, i) => zip.file(`OEBPS/ch${i + 1}.xhtml`, xhtml(ch.title, `${i === 0 || !ch.blocks.some((b) => b.kind === "heading") ? `<h1>${esc(ch.title)}</h1>` : ""}${toX(ch.blocks)}`)));
  if (cover) {
    zip.file("OEBPS/cover.jpg", cover);
    zip.file("OEBPS/cover.xhtml", xhtml("Cover", `<div style="text-align:center"><img src="cover.jpg" alt="Cover"/></div>`));
  }
  const nav = `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${chapters.map((c, i) => `<li><a href="ch${i + 1}.xhtml">${esc(c.title)}</a></li>`).join("")}</ol></nav>`;
  zip.file("OEBPS/nav.xhtml", xhtml("Contents", nav));
  zip.file(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${id}"/></head><docTitle><text>${esc(title)}</text></docTitle><navMap>${chapters.map((c, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(c.title)}</text></navLabel><content src="ch${i + 1}.xhtml"/></navPoint>`).join("")}</navMap></ncx>`,
  );
  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    ...(cover ? [`<item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`, `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`] : []),
    ...chapters.map((_, i) => `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`),
  ].join("");
  const spine = [...(cover ? [`<itemref idref="cover"/>`] : []), ...chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`)].join("");
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${esc(title)}</dc:title>${author ? `<dc:creator>${esc(author)}</dc:creator>` : ""}<dc:language>en</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>${cover ? `<meta name="cover" content="cover-image"/>` : ""}</metadata><manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`,
  );
  const bytes = await zip.generateAsync({ type: "uint8array", mimeType: "application/epub+zip", compression: "DEFLATE" });
  return { filename: `${stem(src.name)}.epub`, bytes, mime: "application/epub+zip", note: `${chapters.length} chapter${chapters.length === 1 ? "" : "s"}` };
}

export { runsText };
