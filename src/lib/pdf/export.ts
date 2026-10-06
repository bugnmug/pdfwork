/** PDF → other formats. */
import JSZip from "jszip";
import { BRAND } from "@/lib/brand";
import { canvasToBytes, stem, tick, type OutFile, type ProgressFn } from "./core";
import { imagesByPage } from "./contentstream";
import { open, withZip, type Src } from "./pages";
import { decodePixels, jpegBytes, listImages, pixelsToCanvas } from "./pdfimages";
import { extractPages, linesToText, renderPage, toLines, withPdfjs, type PageText } from "./pdfjs";
import { analyzeDoc, listLabel, luminance, pageGrid, runsText, type BodyStyle, type Cell, type Family, type FurnitureLine, type Geo, type ListFormat, type PageLayout, type Run, type SBlock } from "./structure";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function readStructured(src: Src, onProgress?: ProgressFn) {
  const pages = await extractPages(src.bytes, { password: src.password, styles: true, onProgress: (f, l) => onProgress?.(f * 0.5, l) });
  const chars = pages.reduce((s, p) => s + p.items.reduce((a, i) => a + i.str.trim().length, 0), 0);
  if (chars < 20) throw new Error("This looks like a scan, so there's no text to convert. Open it in OCR: Searchable PDF first.");
  const { blocks, body, layout, furniture } = analyzeDoc(pages);
  return { pages, blocks, body, layout, furniture };
}

type ListBlock = Extract<SBlock, { kind: "list" }>;
type TableBlock = Extract<SBlock, { kind: "table" }>;

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
const mdRuns = (runs: Run[]): string =>
  runs
    .map((r): string => {
      const t = mdEsc(r.text);
      if (!t.trim()) return t;
      if (r.sup) return `<sup>${t.trim()}</sup>`;
      if (r.br) return " " + mdRuns([{ ...r, br: false }]);
      const lead = t.match(/^\s*/)?.[0] ?? "";
      const trail = t.match(/\s*$/)?.[0] ?? "";
      const core = t.trim();
      return lead + (r.bold && r.italic ? `***${core}***` : r.bold ? `**${core}**` : r.italic ? `*${core}*` : core) + trail;
    })
    .join("");

function mdList(b: ListBlock): string {
  return b.items
    .map((it, i) => {
      const lvl = b.levels[i] ?? 0;
      const f = b.formats[lvl] ?? b.formats[0];
      // Markdown numbers lists itself; nested items indent under their parent's text.
      const label = f.kind === "check" ? "- [ ]" : f.kind === "bullet" ? "-" : /^\d/.test(listLabel(b, i)) ? `${listLabel(b, i).replace(/\D+$/, "")}.` : `- ${listLabel(b, i)}`;
      return `${"   ".repeat(lvl)}${label} ${mdRuns(it)}`;
    })
    .join("\n");
}

export function blocksToMarkdown(blocks: SBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "heading") out.push(`${"#".repeat(b.level)} ${b.text}`);
    else if (b.kind === "para") out.push(mdRuns(b.runs));
    else if (b.kind === "list") out.push(mdList(b));
    else if (b.kind === "box") out.push(blocksToMarkdown(b.blocks).trimEnd().split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
    else if (b.kind === "columns") out.push(blocksToMarkdown(b.blocks).trimEnd());
    else if (b.kind === "table") {
      const w = Math.max(...b.rows.map((r) => r.length));
      const row = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>")).join(" | ")} |`;
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

const htmlRuns = (rs: Run[]) =>
  rs
    .map((r) => {
      let t = esc(r.text);
      if (r.br) t = "<br>" + t;
      if (r.sup) t = `<sup>${t}</sup>`;
      if (r.italic) t = `<em>${t}</em>`;
      if (r.bold) t = `<strong>${t}</strong>`;
      return t;
    })
    .join("");

const OL_TYPE: Partial<Record<ListFormat["kind"], string>> = { lowerLetter: "a", upperLetter: "A", lowerRoman: "i", upperRoman: "I" };

/** A list as nested <ol>/<ul> elements, one level per indent. */
function htmlList(b: ListBlock): string {
  let html = "";
  const open: string[] = [];
  const openList = (lvl: number) => {
    const f = b.formats[lvl] ?? b.formats[0];
    const tag = f.kind === "bullet" || f.kind === "check" ? "ul" : "ol";
    const attrs =
      (tag === "ol" ? `${OL_TYPE[f.kind] ? ` type="${OL_TYPE[f.kind]}"` : ""}${f.start !== 1 ? ` start="${f.start}"` : ""}` : f.kind === "check" ? ` class="check"` : "") +
      (lvl === 0 && b.columns && b.columns > 1 ? ` style="columns:${b.columns}"` : "");
    html += `<${tag}${attrs}>`;
    open.push(tag);
  };
  b.items.forEach((it, i) => {
    const lvl = b.levels[i] ?? 0;
    if (!open.length) openList(0);
    while (open.length > lvl + 1) html += `</li></${open.pop()}>`;
    if (open.length === lvl + 1 && i > 0) html += "</li>";
    while (open.length < lvl + 1) openList(open.length);
    const check = (b.formats[lvl] ?? b.formats[0]).kind === "check" ? "☐ " : "";
    html += `<li>${check}${htmlRuns(it)}`;
  });
  while (open.length) html += `</li></${open.pop()}>`;
  return html;
}

function blocksToHtml(blocks: SBlock[], imgs: Map<number, ExtractedImage[]>): string {
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
    else if (b.kind === "para") {
      const style = [
        b.align && b.align !== "left" ? `text-align:${b.align}` : "",
        b.bar ? `border-left:3px solid ${b.bar};padding-left:.75em` : "",
        b.indent && !b.bar ? `margin-left:${b.indent.left.toFixed(0)}pt;text-indent:${b.indent.first.toFixed(0)}pt` : "",
      ]
        .filter(Boolean)
        .join(";");
      out.push(`<p${style ? ` style="${style}"` : ""}>${htmlRuns(b.runs)}</p>`);
    } else if (b.kind === "list") out.push(htmlList(b));
    else if (b.kind === "columns") out.push(`<div style="columns:${b.count};column-gap:2em">${blocksToHtml(b.blocks, new Map())}</div>`);
    else if (b.kind === "box") {
      // Light boxes keep their colour; dark ones become a light panel with a bar in their colour, since text colours aren't kept here.
      const light = !b.fill || luminance(b.fill) > 0.75;
      const style = light ? `background:${b.fill ?? "transparent"};border:1px solid ${b.stroke ?? b.fill ?? "#ccc"}` : `background:#f4f6f8;border-left:4px solid ${b.fill}`;
      out.push(`<aside style="${style};padding:.75em 1em;margin:1em 0;border-radius:4px">${blocksToHtml(b.blocks, new Map())}</aside>`);
    } else if (b.kind === "table") {
      const cell = (bl: TableBlock, ri: number, ci: number, tag: string) => {
        const c = bl.cells[ri]?.[ci];
        const inner = c?.blocks?.length ? blocksToHtml(c.blocks, new Map()) : (c?.paras ?? []).map(htmlRuns).join("<br>");
        return `<${tag}${c?.align ? ` style="text-align:${c.align}"` : ""}>${inner}</${tag}>`;
      };
      const row = (ri: number, tag: string) => `<tr>${b.rows[ri].map((_, ci) => cell(b, ri, ci, tag)).join("")}</tr>`;
      const head = b.header ? `<thead>${row(0, "th")}</thead>` : "";
      out.push(`<table>${head}<tbody>${b.rows.map((_, ri) => (b.header && ri === 0 ? "" : row(ri, "td"))).join("")}</tbody></table>`);
    }
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

/** Faces PDFs commonly use, by name without spaces, and the font Word should show for them. */
const WORD_FONTS: Record<string, string> = {
  arial: "Arial",
  helvetica: "Arial",
  helveticaneue: "Arial",
  liberationsans: "Arial",
  nimbussans: "Arial",
  arialnarrow: "Arial Narrow",
  arialblack: "Arial Black",
  aptos: "Aptos",
  calibri: "Calibri",
  calibrilight: "Calibri Light",
  cambria: "Cambria",
  candara: "Candara",
  consolas: "Consolas",
  constantia: "Constantia",
  corbel: "Corbel",
  couriernew: "Courier New",
  courier: "Courier New",
  liberationmono: "Courier New",
  nimbusmono: "Courier New",
  georgia: "Georgia",
  garamond: "Garamond",
  palatinolinotype: "Palatino Linotype",
  palatino: "Palatino Linotype",
  bookantiqua: "Book Antiqua",
  timesnewroman: "Times New Roman",
  times: "Times New Roman",
  liberationserif: "Times New Roman",
  nimbusroman: "Times New Roman",
  segoeui: "Segoe UI",
  tahoma: "Tahoma",
  trebuchetms: "Trebuchet MS",
  verdana: "Verdana",
  centurygothic: "Century Gothic",
  gillsans: "Gill Sans MT",
  franklingothic: "Franklin Gothic Medium",
  lucidaconsole: "Lucida Console",
  comicsansms: "Comic Sans MS",
  symbol: "Symbol",
  wingdings: "Wingdings",
};

/**
 * The font to name in Word for a PDF face. Common system fonts keep their name; anything
 * else (usually a web font the reader won't have installed) gets a widely installed face
 * of the same kind, so the document looks the same on every computer.
 */
function wordFont(face?: string, family?: Family): string {
  const key = (face ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (key) {
    if (WORD_FONTS[key]) return WORD_FONTS[key];
    const hit = Object.keys(WORD_FONTS)
      .filter((k) => k.length >= 5 && key.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (hit) return WORD_FONTS[hit];
  }
  return family === "serif" ? "Georgia" : family === "mono" ? "Courier New" : "Arial";
}

const hex = (c?: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c.slice(1).toUpperCase() : undefined);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

type DocxMod = typeof import("docx");
type DocxOut = InstanceType<DocxMod["Paragraph"]> | InstanceType<DocxMod["Table"]>;
/** Formatting a paragraph's runs inherit (size in half-points, colour without "#"). */
type RunBase = { font: string; size: number; color: string; bold: boolean; italic: boolean };
type Where = { width: number; bg?: string; pageBreak?: boolean; cell?: boolean };
/** Marks where the page switches to `count` text columns (1: back to one), splitting the document into sections. */
class Columns {
  constructor(public count: number) {}
}
const content = (xs: (DocxOut | Columns)[]): DocxOut[] => xs.filter((x): x is DocxOut => !(x instanceof Columns));

/** Writes structure blocks as Word content, keeping the PDF's fonts, sizes, colours, boxes and lists. */
/** Word's single line height as a multiple of the font size (ascent, descent and line gap of the face). */
const LINE_HEIGHT: Record<string, number> = {
  Arial: 1.15,
  "Arial Narrow": 1.15,
  "Arial Black": 1.41,
  Aptos: 1.2,
  Calibri: 1.22,
  "Calibri Light": 1.22,
  Cambria: 1.17,
  Candara: 1.22,
  Consolas: 1.17,
  Constantia: 1.22,
  Corbel: 1.22,
  "Courier New": 1.13,
  Georgia: 1.14,
  Garamond: 1.12,
  "Palatino Linotype": 1.14,
  "Book Antiqua": 1.17,
  "Times New Roman": 1.15,
  "Segoe UI": 1.33,
  Tahoma: 1.21,
  "Trebuchet MS": 1.16,
  Verdana: 1.22,
  "Century Gothic": 1.23,
  "Gill Sans MT": 1.15,
  "Franklin Gothic Medium": 1.13,
};

/** Text set in one paragraph: its main face and size, and Word's line spacing for it. */
type Lines = { size: number; factor: number; multiple: number };

/** Writes structure blocks as Word content, keeping the PDF's fonts, sizes, colours, spacing, boxes and lists. */
class WordWriter {
  private lists: { reference: string; levels: unknown[] }[] = [];
  private body: RunBase;
  private heads: Record<number, RunBase> = {};
  private paraAfter: number;
  /** The running text's line spacing, as a multiple of Word's single spacing. */
  private multiple: number;

  constructor(
    private d: DocxMod,
    private bs: BodyStyle,
    blocks: SBlock[],
  ) {
    this.body = { font: wordFont(bs.face, bs.family), size: Math.round(bs.size * 2), color: hex(bs.color) ?? "000000", bold: false, italic: false };
    // Each heading level looks like its first heading (its longest run).
    const first: Record<number, Run> = {};
    const walk = (bs2: SBlock[]) => {
      for (const b of bs2) {
        if (b.kind === "heading" && !first[b.level]) first[b.level] = [...b.runs].sort((x, y) => y.text.length - x.text.length)[0];
        else if (b.kind === "box" || b.kind === "columns") walk(b.blocks);
      }
    };
    walk(blocks);
    for (const lvl of [1, 2, 3]) {
      const r = first[lvl];
      const color = r?.color && luminance(r.color) < 0.72 ? hex(r.color) : undefined;
      this.heads[lvl] = r
        ? { font: wordFont(r.face, r.family), size: Math.round((r.size ?? bs.size) * 2), color: color ?? this.body.color, bold: r.bold, italic: r.italic }
        : { ...this.body, size: Math.round(bs.size * [0, 1.8, 1.4, 1.15][lvl] * 2), bold: true };
    }
    const f = LINE_HEIGHT[this.body.font] ?? 1.17;
    this.multiple = bs.leading ? clamp(bs.leading / (bs.size * f), 1, 2) : 1.1;
    this.paraAfter = bs.paraGap != null ? clamp(Math.round(bs.paraGap * 20), 40, 360) : 120;
  }

  styles() {
    const head = (lvl: number) => {
      const h = this.heads[lvl];
      return {
        run: { font: h.font, size: h.size, color: h.color, bold: h.bold, italics: h.italic },
        paragraph: { spacing: { before: [0, 360, 300, 220][lvl], after: [0, 140, 120, 80][lvl], line: 240, lineRule: this.d.LineRuleType.AUTO }, keepNext: true, keepLines: true },
      };
    };
    return {
      default: {
        document: {
          run: { font: this.body.font, size: this.body.size, color: this.body.color },
          paragraph: { spacing: { after: this.paraAfter, line: Math.round(this.multiple * 240), lineRule: this.d.LineRuleType.AUTO } },
        },
        heading1: head(1),
        heading2: head(2),
        heading3: head(3),
      },
    };
  }

  numbering() {
    return this.lists;
  }

  /**
   * Line spacing for a paragraph: from its own baseline-to-baseline spacing when it has
   * several lines; single lines of large type are set solid, other text like the body.
   */
  private linesOf(runs: Run[], leading?: number): Lines {
    const main = [...runs].sort((x, y) => y.text.length - x.text.length)[0];
    const size = main?.size ?? this.bs.size;
    const factor = LINE_HEIGHT[wordFont(main?.face, main?.family)] ?? 1.17;
    const multiple = leading ? clamp(leading / (size * factor), 0.9, 3) : size > this.bs.size * 1.15 ? 1 : this.multiple;
    return { size, factor, multiple };
  }

  /**
   * Word's space after a paragraph, in twips, so the next text starts where it does in the PDF.
   * `gap` runs from the bottom of this text to the top of the next (PDF line boxes reach 0.82
   * of the size above the baseline and 0.22 below); Word's line boxes are taller by their
   * line spacing, so that much less space is added. `next` is the size of the next text (0: a
   * table or box edge).
   */
  private after(l: Lines, gap?: number, next = 0): number {
    if (gap === undefined) return this.paraAfter;
    const below = l.multiple * l.factor * l.size - 1.12 * l.size;
    return Math.round(clamp(gap - below - 0.08 * next, 0, 72) * 20);
  }

  private spacing(l: Lines, after: number) {
    return { before: 0, after, line: Math.round(l.multiple * 240), lineRule: this.d.LineRuleType.AUTO };
  }

  block(b: SBlock, at: Where): (DocxOut | Columns)[] {
    const d = this.d;
    if (b.kind === "heading") {
      const level = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3][b.level - 1];
      const l = this.linesOf(b.runs, b.geo?.leading);
      return [new d.Paragraph({ heading: level, children: this.runs(b.runs, this.heads[b.level], at.bg), pageBreakBefore: at.pageBreak, spacing: this.spacing(l, this.after(l, b.geo?.gap, b.geo?.next)) })];
    }
    if (b.kind === "para") {
      const l = this.linesOf(b.runs, b.geo?.leading);
      return [
        new d.Paragraph({
          children: this.runs(b.runs, this.body, at.bg),
          pageBreakBefore: at.pageBreak,
          keepNext: b.keep,
          spacing: this.spacing(l, this.after(l, b.geo?.gap, b.geo?.next)),
          alignment: b.align === "center" ? d.AlignmentType.CENTER : b.align === "right" ? d.AlignmentType.RIGHT : b.align === "justify" ? d.AlignmentType.JUSTIFIED : undefined,
          ...(b.bar
            ? { border: { left: { style: d.BorderStyle.SINGLE, size: 18, color: hex(b.bar) ?? "000000", space: 10 } }, indent: { left: 220 } }
            : b.indent
              ? {
                  indent: {
                    left: Math.round(b.indent.left * 20),
                    ...(b.indent.right ? { right: Math.round(b.indent.right * 20) } : {}),
                    ...(b.indent.first >= 0 ? { firstLine: Math.round(b.indent.first * 20) } : { hanging: Math.round(-b.indent.first * 20) }),
                  },
                }
              : {}),
        }),
      ];
    }
    if (b.kind === "list") return this.list(b, at);
    if (b.kind === "table") return this.withBreak(this.table(b, at), b.geo, at);
    if (b.kind === "box") return this.withBreak(this.box(b, at), b.geo, at);
    if (b.kind === "columns") {
      // Inside a column, tables and boxes are a column wide.
      const width = at.cell ? at.width : Math.round((at.width - 360 * (b.count - 1)) / b.count);
      const inner = b.blocks.flatMap((x, k) => this.block(x, { ...at, width, pageBreak: at.pageBreak && k === 0, cell: true }));
      // Columns of their own: a section set in columns (not inside a table or box).
      return at.cell ? content(inner) : [new Columns(b.count), ...content(inner), new Columns(1)];
    }
    return [];
  }

  /** An empty paragraph after a table (it keeps the next table from joining it), exactly as tall as the gap below it in the PDF. */
  private withBreak(out: DocxOut[], geo: Geo | undefined, at: Where): DocxOut[] {
    const d = this.d;
    const gap = geo?.gap !== undefined ? clamp(geo.gap - 0.08 * (geo.next ?? 0), 1, 72) : 8;
    out.push(new d.Paragraph({ children: [], spacing: { before: 0, after: 0, line: Math.round(gap * 20), lineRule: d.LineRuleType.EXACT } }));
    return at.pageBreak ? [new d.Paragraph({ children: [], pageBreakBefore: true, spacing: { before: 0, after: 0, line: 20, lineRule: d.LineRuleType.EXACT } }), ...out] : out;
  }

  private runs(rs: Run[], base: RunBase, bg?: string) {
    return rs.map((r) => new this.d.TextRun({ ...(this.runOptions(r, base, bg) as object), ...(r.br ? { break: 1 } : {}) } as ConstructorParameters<DocxMod["TextRun"]>[0]));
  }

  private runOptions(r: Run, base: RunBase, bg?: string) {
    const o: Record<string, unknown> = { text: r.text };
    if (r.bold !== base.bold) o.bold = r.bold;
    if (r.italic !== base.italic) o.italics = r.italic;
    if (r.sup) o.superScript = true;
    if (r.size && Math.abs(r.size * 2 - base.size) >= 1) o.size = Math.round(r.size * 2);
    const font = wordFont(r.face, r.family);
    if (r.family && font !== base.font) o.font = font;
    // Light text shows only on the dark background it was drawn on.
    const behind = r.bg ?? bg;
    const color = r.color && luminance(r.color) > 0.72 && !(behind && luminance(behind) < 0.55) ? undefined : hex(r.color);
    if (color && color !== base.color) o.color = color;
    if (r.bg) o.shading = { type: this.d.ShadingType.CLEAR, color: "auto", fill: hex(r.bg) };
    return o as ConstructorParameters<DocxMod["TextRun"]>[0];
  }

  private list(b: ListBlock, at: Where): (DocxOut | Columns)[] {
    const d = this.d;
    const reference = `list-${this.lists.length + 1}`;
    const depth = Math.max(0, ...b.levels);
    const tw = (pt: number) => Math.round(pt * 20);
    const levels = Array.from({ length: depth + 1 }, (_, lvl) => {
      const f = b.formats[lvl] ?? b.formats[b.formats.length - 1];
      // Indents as in the PDF where known (the text's distance from the edge, the marker hanging before it).
      const indent = f.indent && f.indent.left >= f.indent.hanging ? { left: tw(f.indent.left), hanging: tw(f.indent.hanging) } : { left: 360 * (lvl + 1) + 60, hanging: 360 };
      // The number keeps its look (size, colour, weight, face); bullets keep size and colour only.
      const color = f.run?.color && luminance(f.run.color) < 0.72 ? hex(f.run.color) : undefined;
      const look = f.run ? { size: Math.round(f.run.size * 2), bold: f.run.bold, ...(color ? { color } : {}) } : {};
      if (f.kind === "bullet" || f.kind === "check") {
        // Word's own bullet glyphs: a dot, "o" in Courier New for a ring, a small square, a dash, a check box.
        const [text, font] = f.kind === "check" ? ["\u2610", "Segoe UI Symbol"] : f.bullet === "◦" ? ["o", "Courier New"] : f.bullet === "▪" || f.bullet === "▫" ? ["\u25AA", "Segoe UI Symbol"] : f.bullet === "–" ? ["\u2013", undefined] : ["\u2022", undefined];
        return { level: lvl, format: d.LevelFormat.BULLET, text, alignment: d.AlignmentType.START, style: { paragraph: { indent }, run: { ...look, ...(font ? { font } : {}) } } };
      }
      const format = { decimal: d.LevelFormat.DECIMAL, lowerLetter: d.LevelFormat.LOWER_LETTER, upperLetter: d.LevelFormat.UPPER_LETTER, lowerRoman: d.LevelFormat.LOWER_ROMAN, upperRoman: d.LevelFormat.UPPER_ROMAN }[f.kind];
      const run = f.run ? { ...look, font: wordFont(f.run.face, f.run.family) } : undefined;
      return { level: lvl, format, text: `${f.before}%${lvl + 1}${f.after}`, start: f.start, alignment: d.AlignmentType.START, style: { paragraph: { indent }, ...(run ? { run } : {}) } };
    });
    this.lists.push({ reference, levels });
    // Rules between items become a line under each item: under every top-level item (after
    // its sub-items), so they read as separators; anything less regular is left out.
    const ends = b.items.map((_, i) => i === b.items.length - 1 || (b.levels[i + 1] ?? 0) === 0);
    const ruled = b.rules && b.rules.every((r, i) => (ends[i] ? !!r || i === b.items.length - 1 : !r)) ? b.rules : undefined;
    // A number set much larger than its text would make Word's first line taller: set lines exactly.
    const f0 = b.formats[0];
    const paras = b.items.map((it, i) => {
      const l = this.linesOf(it, b.geo?.leading);
      const big = !!f0.run && (b.levels[i] ?? 0) === 0 && f0.run.size > l.size * 1.3;
      const last = i === b.items.length - 1;
      const gap = last ? b.geo?.gap : (b.gaps?.[i] ?? 0);
      const next = last ? b.geo?.next : (b.items[i + 1] && this.linesOf(b.items[i + 1]).size) || l.size;
      const rule = ruled?.[i];
      let after = this.after(l, gap, next);
      let border: object | undefined;
      if (rule && gap !== undefined) {
        // Word draws the line `space` points below the text. Paragraphs with identical borders
        // merge into one bordered block (one line under the last), so neighbouring items get
        // colours one step apart.
        const below = l.multiple * l.factor * l.size - 1.12 * l.size;
        const space = Math.round(clamp(rule.at - below, 0, 30));
        after = Math.round(clamp(gap - rule.at - rule.h - 0.08 * (next ?? 0), 0, 72) * 20);
        const c = parseInt(hex(rule.color) ?? "000000", 16);
        const color = ((c & 0xffff00) | Math.max(0, Math.min(255, (c & 0xff) + (i % 2 ? (c & 0xff) > 127 ? -1 : 1 : 0)))).toString(16).padStart(6, "0").toUpperCase();
        border = { bottom: { style: d.BorderStyle.SINGLE, size: Math.max(2, Math.round(rule.h * 8)), color, space } };
      }
      const spacing = big ? { ...this.spacing(l, after), line: Math.round(l.multiple * l.factor * l.size * 20), lineRule: d.LineRuleType.EXACT } : this.spacing(l, after);
      return new d.Paragraph({
        children: this.runs(it, this.body, at.bg),
        numbering: { reference, level: b.levels[i] ?? 0 },
        pageBreakBefore: at.pageBreak && i === 0,
        spacing,
        ...(border ? { border } : {}),
      });
    });
    // A list set in columns keeps its columns (a section of its own).
    return b.columns && b.columns > 1 && !at.cell ? [new Columns(b.columns), ...paras, new Columns(1)] : paras;
  }

  /** Paragraphs of a plain table cell, spaced as in the PDF; the last one adds no space (the cell margin does). */
  private cellParas(c: Cell | undefined, bg: string | undefined, leading?: number, keep?: boolean): DocxOut[] {
    const d = this.d;
    const ps = c?.paras.length ? c.paras : [[]];
    return ps.map((p, pi) => {
      const l = this.linesOf(p, c?.geo?.leadings[pi] ?? leading);
      const after = pi < ps.length - 1 ? this.after(l, c?.geo?.gaps[pi] ?? 2, c?.geo?.sizes[pi + 1]) : 0;
      const alignment = c?.align === "right" ? d.AlignmentType.RIGHT : c?.align === "center" ? d.AlignmentType.CENTER : undefined;
      return new d.Paragraph({ children: this.runs(p, this.body, bg), spacing: this.spacing(l, after), keepNext: keep, alignment });
    });
  }

  private table(b: TableBlock, at: Where): DocxOut[] {
    const d = this.d;
    const cols = b.widths.map((w) => Math.max(240, Math.round(w * at.width)));
    const lc = hex(b.lineColor) ?? "000000";
    const line = (color: string, size = 4) => ({ style: d.BorderStyle.SINGLE, size, color });
    const none = { style: d.BorderStyle.NONE, size: 0, color: "auto" };
    const all = (e: ReturnType<typeof line> | typeof none) => ({ top: e, bottom: e, left: e, right: e, insideHorizontal: e, insideVertical: e });
    // Lines as the PDF draws them: rules above and below rows (each in its colour), a full grid, or none.
    const rowRules = b.lines === "rows" ? b.rowRules : undefined;
    const borders = b.lines === "grid" ? all(line(lc)) : all(none);
    const cards = b.lines === "cards";
    // Cell margins: the PDF's space around cell text, less what Word's taller lines already take.
    const sizes = b.cells.flatMap((r) => r.flatMap((c) => c?.geo?.sizes ?? []));
    const l = this.linesOf([{ text: "x", bold: false, italic: false, size: sizes.length ? sizes.sort((x, y) => x - y)[sizes.length >> 1] : this.bs.size }], b.leading);
    const below = l.multiple * l.factor * l.size - 1.12 * l.size;
    const padX = Math.round((b.pad?.x ?? (cards ? 8 : 5)) * 20);
    const top = Math.round(clamp((b.pad?.y ?? 3) - 0.08 * l.size, 0, 30) * 20);
    const bottom = cards ? 0 : Math.round(clamp((b.pad?.y ?? 3) - below, 0, 30) * 20);
    return [
      new d.Table({
        width: { size: cols.reduce((a, c) => a + c, 0), type: d.WidthType.DXA },
        columnWidths: cols,
        layout: d.TableLayoutType.FIXED,
        borders,
        margins: { top, bottom, left: padX, right: padX },
        rows: b.cells.map(
          (r, ri) =>
            new d.TableRow({
              tableHeader: b.header && ri === 0,
              cantSplit: r.every((c) => (c?.paras.length ?? 0) <= 6),
              children: cols.map((w, ci) => {
                const c = r[ci];
                const fill = c?.fill;
                const bg = fill ?? at.bg;
                // Word keeps a table on one page when every row but the last keeps with the next.
                const keep = b.keep && ri < b.cells.length - 1;
                const kids: DocxOut[] = c?.blocks?.length ? content(c.blocks.flatMap((x) => this.block(x, { width: w - padX * 2, bg, cell: true }))) : this.cellParas(c, bg, b.leading, keep);
                if (!(kids[kids.length - 1] instanceof d.Paragraph)) kids.push(new d.Paragraph({ children: [] }));
                const edge = c?.stroke ? line(hex(c.stroke) ?? "000000", 6) : undefined;
                const rule = (color?: string | null) => (color ? line(hex(color) ?? "000000", 6) : none);
                const cellBorders = cards && edge ? { top: edge, bottom: edge, left: edge, right: edge } : rowRules ? { top: rule(rowRules[ri]), bottom: ri === b.cells.length - 1 ? rule(rowRules[ri + 1]) : none, left: none, right: none } : undefined;
                return new d.TableCell({
                  width: { size: w, type: d.WidthType.DXA },
                  children: kids,
                  ...(fill ? { shading: { type: d.ShadingType.CLEAR, color: "auto", fill: hex(fill) } } : {}),
                  ...(cellBorders ? { borders: cellBorders } : {}),
                });
              }),
            }),
        ),
      }),
    ];
  }

  private box(b: Extract<SBlock, { kind: "box" }>, at: Where): DocxOut[] {
    const d = this.d;
    const s = hex(b.stroke);
    const edge = s ? { style: d.BorderStyle.SINGLE, size: 6, color: s } : { style: d.BorderStyle.NONE, size: 0, color: "auto" };
    const none = { style: d.BorderStyle.NONE, size: 0, color: "auto" };
    const padX = Math.round((b.pad?.x ?? 10) * 20);
    const first = b.blocks.map((x) => ("geo" in x ? x.geo : undefined)).find(Boolean)?.first ?? 0;
    const kids = content(b.blocks.flatMap((x) => this.block(x, { width: at.width - padX * 2, bg: b.fill ?? at.bg, cell: true })));
    if (!(kids[kids.length - 1] instanceof d.Paragraph)) kids.push(new d.Paragraph({ children: [] }));
    return [
      new d.Table({
        width: { size: at.width, type: d.WidthType.DXA },
        columnWidths: [at.width],
        layout: d.TableLayoutType.FIXED,
        borders: { top: edge, bottom: edge, left: edge, right: edge, insideHorizontal: none, insideVertical: none },
        rows: [
          new d.TableRow({
            cantSplit: kids.length <= 10,
            children: [
              new d.TableCell({
                width: { size: at.width, type: d.WidthType.DXA },
                // The last paragraph's spacing reaches down to the box's edge, so no bottom margin.
                margins: { top: Math.round(clamp((b.pad?.y ?? 8) - 0.08 * first, 0, 30) * 20), bottom: 0, left: padX, right: padX },
                ...(b.fill ? { shading: { type: d.ShadingType.CLEAR, color: "auto", fill: hex(b.fill) } } : {}),
                children: kids,
              }),
            ],
          }),
        ],
      }),
    ];
  }
}

/** A running header or footer line: its pieces at the left, centre and right (tab stops), page numbers as fields. */
function furnitureParagraph(d: DocxMod, line: FurnitureLine, width: number) {
  const has = (at: string) => line.parts.some((p) => p.at === at);
  const tabStops = [...(has("center") ? [{ type: d.TabStopType.CENTER, position: Math.round(width / 2) }] : []), { type: d.TabStopType.RIGHT, position: width }];
  const color = line.color && luminance(line.color) < 0.72 ? hex(line.color) : undefined;
  const look = { size: Math.round(line.size * 2), bold: line.bold, font: wordFont(line.face, line.family), ...(color ? { color } : {}) };
  const children: InstanceType<DocxMod["TextRun"]>[] = [];
  let stop = 0;
  for (const p of line.parts) {
    const want = p.at === "left" ? 0 : p.at === "center" ? 1 : has("center") ? 2 : 1;
    const tabs: (InstanceType<DocxMod["Tab"]> | string)[] = [];
    for (; stop < want; stop++) tabs.push(new d.Tab());
    if (children.length && !tabs.length) tabs.push(" ");
    const pieces = p.text.split(/(\{PAGE\}|\{PAGES\})/).filter(Boolean).map((t) => (t === "{PAGE}" ? d.PageNumber.CURRENT : t === "{PAGES}" ? d.PageNumber.TOTAL_PAGES : t));
    children.push(new d.TextRun({ ...look, children: [...tabs, ...pieces] as never }));
  }
  return new d.Paragraph({ children, tabStops, spacing: { before: 0, after: 0 } });
}

/** The document split into sections where the number of text columns changes. */
function sectionsOf(d: DocxMod, children: (DocxOut | Columns)[], layout: PageLayout, furniture?: { header: FurnitureLine[]; footer: FurnitureLine[] }) {
  const parts: { count: number; children: DocxOut[] }[] = [{ count: 1, children: [] }];
  for (const c of children) {
    if (c instanceof Columns) {
      if (!parts[parts.length - 1].children.length) parts.pop();
      parts.push({ count: c.count, children: [] });
    } else parts[parts.length - 1].children.push(c);
  }
  // A section set in columns needs one after it, or Word won't balance its columns.
  if (parts[parts.length - 1].count > 1) parts.push({ count: 1, children: [] });
  for (const p of parts) if (p.count === 1 && !p.children.length) p.children.push(new d.Paragraph({ children: [], spacing: { before: 0, after: 0, line: 20, lineRule: d.LineRuleType.EXACT } }));
  const used = parts.filter((p) => p.children.length);
  // Running header and footer on the first section; later sections carry them on.
  const width = Math.round((layout.width - layout.left - layout.right) * 20);
  const header = furniture?.header.length ? { headers: { default: new d.Header({ children: furniture.header.map((l) => furnitureParagraph(d, l, width)) }) } } : {};
  const footer = furniture?.footer.length ? { footers: { default: new d.Footer({ children: furniture.footer.map((l) => furnitureParagraph(d, l, width)) }) } } : {};
  // Header and footer where the PDF has them, inside the page margins.
  const page = pageSetup(d, layout);
  const fit = (lines: FurnitureLine[] | undefined, margin: number) => (lines?.length ? Math.round(clamp(Math.min(...lines.map((l) => l.edge)), 12, Math.max(12, margin - lines.length * 12 - 4)) * 20) : undefined);
  const hd = fit(furniture?.header, layout.top);
  const fd = fit(furniture?.footer, layout.bottom);
  const margin = { ...page.margin, ...(hd !== undefined ? { header: hd } : {}), ...(fd !== undefined ? { footer: fd } : {}) };
  return (used.length ? used : [{ count: 1, children: [new d.Paragraph({ children: [] })] }]).map((p, i) => ({
    ...(i === 0 ? { ...header, ...footer } : {}),
    properties: {
      page: { ...page, margin },
      ...(i > 0 ? { type: d.SectionType.CONTINUOUS } : {}),
      ...(p.count > 1 ? { column: { count: p.count, space: 360, equalWidth: true } } : {}),
    },
    children: p.children as never[],
  }));
}

/** Word page size and margins (twips) for a PDF page layout. Landscape pages are given short side first, as docx expects. */
function pageSetup(d: DocxMod, l: PageLayout) {
  const tw = (pt: number) => Math.round(pt * 20);
  const landscape = l.width > l.height;
  return {
    size: { width: tw(Math.min(l.width, l.height)), height: tw(Math.max(l.width, l.height)), orientation: landscape ? d.PageOrientation.LANDSCAPE : d.PageOrientation.PORTRAIT },
    margin: { top: tw(l.top), right: tw(l.right), bottom: tw(l.bottom), left: tw(l.left), header: tw(Math.min(36, l.top / 2)), footer: tw(Math.min(36, l.bottom / 2)) },
  };
}

export async function pdfToWord(src: Src, o: { mode?: "editable" | "exact"; pageBreaks?: boolean; images?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const d = await import("docx");
  const children: (DocxOut | Columns)[] = [];
  const name = stem(src.name);
  // Pages the size of the PDF's, with its margins, so lines and pages break in the same places.
  let layout: PageLayout = { width: 595.3, height: 841.9, top: 72, right: 72, bottom: 72, left: 72 };
  let docStyles: ConstructorParameters<typeof d.Document>[0]["styles"];
  let numbering: unknown[] = [];
  let furniture: { header: FurnitureLine[]; footer: FurnitureLine[] } = { header: [], footer: [] };
  if (o.mode === "exact") {
    await withPdfjs(
      src.bytes,
      async ({ pdf, pageCount }) => {
        for (let i = 1; i <= pageCount; i++) {
          onProgress?.(i / pageCount, `Page ${i} of ${pageCount}`);
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          if (i === 1) layout = { width: vp.width, height: vp.height, top: 18, right: 18, bottom: 18, left: 18 };
          const canvas = await renderPage(page, 2);
          page.cleanup();
          const data = await canvasToBytes(canvas, "image/jpeg", 0.85);
          // Fit the page picture inside the margins (sizes in pixels at 96 per inch).
          const scale = Math.min((layout.width - 36) / vp.width, ((layout.height - 36) * 0.97) / vp.height);
          const w = vp.width * scale * (96 / 72);
          children.push(new d.Paragraph({ children: [new d.ImageRun({ type: "jpg", data, transformation: { width: w, height: (w * vp.height) / vp.width } })], pageBreakBefore: i > 1, spacing: { after: 0 } }));
          await tick();
        }
      },
      src.password,
    );
  } else {
    const r = await readStructured(src, onProgress);
    const { blocks, body } = r;
    layout = r.layout;
    furniture = r.furniture;
    const contentWidth = Math.round((layout.width - layout.left - layout.right) * 20);
    const imgs = new Map<number, ExtractedImage[]>();
    if (o.images !== false) for (const im of await extractImages(src, { minSize: 40 }).catch(() => [])) imgs.set(im.page, [...(imgs.get(im.page) ?? []), im]);
    const w = new WordWriter(d, body, blocks);
    let page = 0;
    const pushImgs = (p: number) => {
      for (const im of imgs.get(p) ?? []) {
        const iw = Math.min(560, im.width * 0.75);
        children.push(new d.Paragraph({ children: [new d.ImageRun({ type: im.mime === "image/png" ? "png" : "jpg", data: im.bytes, transformation: { width: iw, height: (iw * im.height) / im.width } })] }));
      }
    };
    let breakNext = false;
    for (const b of blocks) {
      if (b.kind === "pagebreak") {
        pushImgs(page);
        page = b.page;
        // Only breaks the author made; where a page simply filled up, the text flows on.
        breakNext = o.pageBreaks !== false && b.deliberate !== false;
        continue;
      }
      const out = w.block(b, { width: contentWidth, pageBreak: breakNext });
      if (out.length) breakNext = false;
      children.push(...out);
    }
    pushImgs(page);
    docStyles = w.styles();
    numbering = w.numbering();
  }
  const doc = new d.Document({
    creator: BRAND.name,
    title: name,
    styles: docStyles,
    numbering: { config: numbering as never },
    sections: sectionsOf(d, children, layout, furniture),
  });
  let bytes: Uint8Array = new Uint8Array(await (await d.Packer.toBlob(doc)).arrayBuffer());
  // The paragraphs docx adds to end each section (columns) take no room.
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (xml?.includes("<w:p><w:pPr><w:sectPr>")) {
    zip.file("word/document.xml", xml.replaceAll("<w:p><w:pPr><w:sectPr>", '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:sectPr>'));
    bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }
  return {
    filename: `${name}.docx`,
    bytes,
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
