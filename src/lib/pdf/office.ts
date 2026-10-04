/** Word, Excel, CSV, HTML and Markdown → PDF. */
import { marked } from "marked";
import { pdfOut, stem, type OutFile, type ProgressFn } from "./core";
import { renderHtml, type LayoutOpts } from "./layout";
import { paperSize } from "./core";

export async function wordToPdf(bytes: Uint8Array, name: string, o: { paper?: string; pageNumbers?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
    throw new Error("This is an old .doc file (Word 97–2003). Open it in Word, Google Docs or LibreOffice and save as .docx, then convert.");
  }
  onProgress?.(0.1, "Reading the Word file");
  const mammoth = await import("mammoth");
  // Word stores each picture's displayed size (EMU); mammoth does not pass it on,
  // so read the sizes in document order and attach them as we convert images.
  const sizes: { w: number; h: number }[] = [];
  try {
    const JSZip = (await import("jszip")).default;
    const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")?.async("string");
    for (const m of xml?.matchAll(/<w:drawing>[\s\S]*?<wp:extent cx="(\d+)" cy="(\d+)"/g) ?? []) sizes.push({ w: Number(m[1]) / 9525, h: Number(m[2]) / 9525 });
  } catch {
    /* sizes are a refinement only */
  }
  let imgIndex = 0;
  const convertImage = mammoth.images.imgElement(async (image: { contentType: string; readAsBase64String(): Promise<string> }) => {
    const size = sizes[imgIndex++];
    const attrs: Record<string, string> = { src: `data:${image.contentType};base64,${await image.readAsBase64String()}` };
    if (size && size.w > 0) {
      attrs.width = String(Math.round(size.w));
      attrs.height = String(Math.round(size.h));
    }
    return attrs as { src: string };
  });
  const result = await mammoth.convertToHtml(
    { arrayBuffer: bytes.slice().buffer },
    {
      convertImage,
      styleMap: [
        "p[style-name='Title'] => h1.title:fresh",
        "p[style-name='Subtitle'] => p.subtitle:fresh",
        "p[style-name='Quote'] => blockquote > p:fresh",
        "p[style-name='Intense Quote'] => blockquote > p:fresh",
        "r[style-name='Strong'] => strong",
        "p[style-name='Caption'] => figcaption:fresh",
      ],
      includeDefaultStyleMap: true,
    } as never,
  );
  const html = result.value || "<p></p>";
  const pdf = await renderHtml(html, {
    pageSize: paperSize(o.paper ?? "A4"),
    margin: { top: 72, right: 68, bottom: 72, left: 68 },
    family: "sans",
    baseSize: 11,
    pageNumbers: o.pageNumbers ?? true,
    title: stem(name),
    onProgress: (f, l) => onProgress?.(0.2 + f * 0.8, l),
  });
  const warn = result.messages?.filter((m) => m.type === "warning").length ?? 0;
  return pdfOut(`${stem(name)}.pdf`, pdf, warn ? `${warn} unsupported Word feature${warn === 1 ? "" : "s"} simplified` : undefined);
}

export async function htmlToPdf(html: string, name = "document", o: LayoutOpts = {}): Promise<OutFile> {
  if (!html.trim()) throw new Error("Paste some HTML or choose an .html file.");
  return pdfOut(`${stem(name)}.pdf`, await renderHtml(html, { pageSize: paperSize("A4"), pageNumbers: true, ...o }));
}

export async function markdownToPdf(md: string, name = "document", o: LayoutOpts = {}): Promise<OutFile> {
  if (!md.trim()) throw new Error("Paste some Markdown or choose a .md file.");
  const html = await marked.parse(md, { gfm: true, breaks: false });
  return pdfOut(`${stem(name)}.pdf`, await renderHtml(String(html), { pageSize: paperSize("A4"), pageNumbers: true, ...o }));
}

export async function textToPdf(text: string, name = "document", o: { title?: string; paper?: string; family?: "sans" | "serif" | "mono"; size?: number } = {}): Promise<OutFile> {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const html = `${o.title ? `<h1>${esc(o.title)}</h1>` : ""}${body}`;
  return pdfOut(`${stem(name)}.pdf`, await renderHtml(html, { pageSize: paperSize(o.paper ?? "A4"), family: o.family ?? "sans", baseSize: o.size ?? 11, pageNumbers: true, title: o.title }));
}

/** Parse CSV/TSV properly (quotes, escaped quotes, embedded newlines and delimiters). */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const d = delimiter ?? ([",", ";", "\t", "|"].map((c) => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0]);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") q = true;
    else if (c === d) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isNum = (s: string) => /^[-+(]?[₹$€£]?\s?[\d,]*\.?\d+%?\)?$/.test(s.trim());

function tableHtml(rows: string[][], header = true): string {
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (tag: string, v: string) => `<${tag}${isNum(v) && tag === "td" ? ' style="text-align:right"' : ""}>${escHtml(v)}</${tag}>`;
  const head = header && rows.length > 1 ? `<thead><tr>${Array.from({ length: width }, (_, i) => cell("th", rows[0][i] ?? "")).join("")}</tr></thead>` : "";
  const body = (header && rows.length > 1 ? rows.slice(1) : rows).map((r) => `<tr>${Array.from({ length: width }, (_, i) => cell("td", r[i] ?? "")).join("")}</tr>`).join("");
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

function sizing(cols: number) {
  const landscape = cols > 6;
  const base = cols > 14 ? 6.5 : cols > 10 ? 7.5 : cols > 7 ? 8.5 : 10;
  return { landscape, base };
}

export async function csvToPdf(text: string, name: string, o: { header?: boolean; paper?: string } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("The CSV file is empty.");
  const cols = Math.max(...rows.map((r) => r.length));
  const sz = sizing(cols);
  const pdf = await renderHtml(`<h2>${escHtml(stem(name))}</h2>${tableHtml(rows, o.header !== false)}`, {
    pageSize: paperSize(o.paper ?? "A4", sz.landscape),
    margin: 36,
    baseSize: sz.base,
    pageNumbers: true,
    lineHeight: 1.3,
    onProgress,
  });
  return pdfOut(`${stem(name)}.pdf`, pdf, `${rows.length} rows × ${cols} columns`);
}

export async function excelToPdf(bytes: Uint8Array, name: string, o: { sheets?: "all" | "first"; paper?: string; gridlines?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(bytes, { type: "array", cellDates: true, cellStyles: false });
  const names = o.sheets === "first" ? wb.SheetNames.slice(0, 1) : wb.SheetNames;
  let html = "";
  let maxCols = 0;
  let totalRows = 0;
  for (const sheetName of names) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    // Trim fully empty trailing rows/cols that Excel often leaves in the range.
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: "", blankrows: true }) as string[][];
    while (rows.length && !rows[rows.length - 1].some((c) => String(c).trim())) rows.pop();
    if (!rows.length) continue;
    let lastCol = 0;
    for (const r of rows) for (let c = r.length - 1; c >= 0; c--) if (String(r[c]).trim()) {
      lastCol = Math.max(lastCol, c);
      break;
    }
    const merges = (ws["!merges"] ?? []).map((m) => ({ s: { r: m.s.r - range.s.r, c: m.s.c - range.s.c }, e: { r: m.e.r - range.s.r, c: m.e.c - range.s.c } }));
    const cols = lastCol + 1;
    maxCols = Math.max(maxCols, cols);
    totalRows += rows.length;
    const covered = new Set<string>();
    const spanAt = new Map<string, { cs: number; rs: number }>();
    for (const m of merges) {
      spanAt.set(`${m.s.r},${m.s.c}`, { cs: m.e.c - m.s.c + 1, rs: m.e.r - m.s.r + 1 });
      for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) covered.add(`${r},${c}`);
    }
    const trs = rows.map((r, ri) => {
      const tds: string[] = [];
      for (let c = 0; c < cols; c++) {
        if (covered.has(`${ri},${c}`)) continue;
        const v = String(r[c] ?? "");
        const span = spanAt.get(`${ri},${c}`);
        const attrs = `${span?.cs && span.cs > 1 ? ` colspan="${Math.min(span.cs, cols - c)}"` : ""}${span?.rs && span.rs > 1 ? ` rowspan="${span.rs}"` : ""}${isNum(v) ? ' style="text-align:right"' : ""}`;
        tds.push(ri === 0 ? `<th${attrs}>${escHtml(v)}</th>` : `<td${attrs}>${escHtml(v)}</td>`);
      }
      return `<tr>${tds.join("")}</tr>`;
    });
    html += `${names.length > 1 ? `<h2 style="page-break-before:${html ? "always" : "auto"}">${escHtml(sheetName)}</h2>` : ""}<table><thead>${trs[0]}</thead><tbody>${trs.slice(1).join("")}</tbody></table>`;
  }
  if (!html) throw new Error("The workbook has no data to print.");
  const sz = sizing(maxCols);
  const pdf = await renderHtml(html, {
    pageSize: paperSize(o.paper ?? "A4", sz.landscape),
    margin: 32,
    baseSize: sz.base,
    lineHeight: 1.28,
    pageNumbers: true,
    title: stem(name),
    onProgress,
  });
  return pdfOut(`${stem(name)}.pdf`, pdf, `${names.length} sheet${names.length === 1 ? "" : "s"}, ${totalRows} rows`);
}
