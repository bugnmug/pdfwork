/** PDF → other formats. */
import JSZip from "jszip";
import { BRAND } from "@/lib/brand";
import { canvasToBytes, stem, tick, type OutFile, type ProgressFn } from "./core";
import { imagesByPage, placementOf, viewTransform, walkImages } from "./contentstream";
import { open, withZip, type Src } from "./pages";
import { decodePixels, jpegBytes, listImages, pixelsToCanvas } from "./pdfimages";
import type { DrawnFigure } from "./drawn";
import { enrichFontStyles, extractPages, linesToText, loosePictures, pageLinks, pageText, pictureCanvas, renderPage, renderRegion, toLines, withPdfjs, type LoosePicture, type PageText, type Pic } from "./pdfjs";
import type { PMedia, PPic, PRun, PSlide, PText } from "./pptxwrite";
import type { PDFPageProxy } from "pdfjs-dist";
import { analyzeDoc, listLabel, luminance, runsText, type BodyStyle, type Cell, type Family, type Furniture, type FurnitureLine, type Geo, type ListFormat, type PageLayout, type Run, type SBlock, type Under } from "./structure";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The document's structure. With `images`, also its pictures, each placed where it is drawn
 * (on the pages as `pics`, so they take their place among the text), keyed by `ref`.
 */
async function readStructured(src: Src, onProgress?: ProgressFn, o: { images?: boolean } = {}) {
  const pages = await extractPages(src.bytes, { password: src.password, styles: true, onProgress: (f, l) => onProgress?.(f * 0.5, l) });
  const chars = pages.reduce((s, p) => s + p.items.reduce((a, i) => a + i.str.trim().length, 0), 0);
  if (chars < 20) throw new Error("This looks like a scan, so there's no text to convert. Open it in OCR: Searchable PDF first.");
  const images = o.images ? await placeImages(src, pages).catch(() => new Map<string, ExtractedImage>()) : new Map<string, ExtractedImage>();
  const { blocks, body, layout, furniture, unread, drawn } = analyzeDoc(pages);
  if (o.images && drawn.length) await drawFigures(src, drawn, images).catch(() => undefined);
  return { pages, blocks, body, layout, furniture, images, unread };
}

/** Pictures of the charts and drawings the pages make of shapes (see drawn.ts), each drawn once. */
async function drawFigures(src: Src, drawn: DrawnFigure[], images: Map<string, ExtractedImage>) {
  await withPdfjs(
    src.bytes,
    async ({ pdf }) => {
      let n = 0;
      for (const f of drawn) {
        if (images.has(f.pic.id)) continue;
        const page = await pdf.getPage(f.page + 1);
        try {
          const canvas = await renderRegion(page, f.pic, Math.min(3, Math.max(2, 1800 / Math.max(f.pic.w, f.pic.h))));
          const bytes = await canvasToBytes(canvas, "image/png");
          images.set(f.pic.id, { name: `${stem(src.name)}-p${f.page + 1}-figure${++n}.png`, bytes, mime: "image/png", page: f.page, width: canvas.width, height: canvas.height, ref: f.pic.id });
          canvas.width = canvas.height = 0;
        } finally {
          page.cleanup();
        }
      }
    },
    src.password,
  );
}

/** The document's pictures by object, each drawn place added to its page as a `pic`. */
async function placeImages(src: Src, pages: PageText[]): Promise<Map<string, ExtractedImage>> {
  const doc = await open(src);
  const byRef = new Map((await imagesOf(doc, src.name, { minSize: 8 })).map((im) => [im.ref, im]));
  const views = new Map<number, ReturnType<typeof viewTransform>>();
  walkImages(doc, (draw) => {
    const pt = pages[draw.page];
    const im = byRef.get(draw.ref.toString());
    if (!pt || !im) return;
    if (!views.has(draw.page)) views.set(draw.page, viewTransform(doc.getPage(draw.page)));
    const p = placementOf(draw, views.get(draw.page)!, pt);
    if (p) (pt.pics ??= []).push({ ...p, id: im.ref });
  });
  return byRef;
}

/**
 * Pictures with no place among the text, by page (drawn where the page's content couldn't be
 * followed): they go at the end of their page. Pictures left out on purpose (a scan under its
 * text, icons in a line) had a place and stay out.
 */
function unplaced(images: Map<string, ExtractedImage>, pages: PageText[], unread = new Set<number>()): Map<number, ExtractedImage[]> {
  const placed = new Set(pages.flatMap((p, pi) => (unread.has(pi) ? [] : (p.pics ?? []).map((x) => x.id))));
  const out = new Map<number, ExtractedImage[]>();
  for (const im of images.values()) if (!placed.has(im.ref) && !im.ref.startsWith("draw-") && im.width >= 40 && im.height >= 40) out.set(im.page, [...(out.get(im.page) ?? []), im]);
  return out;
}

type ListBlock = Extract<SBlock, { kind: "list" }>;
type TableBlock = Extract<SBlock, { kind: "table" }>;
type ImageBlock = Extract<SBlock, { kind: "image" }>;

/* ------------------------------------------------------------- images */

/** A picture taken out of the PDF: `ref` names the PDF object it came from. */
export type ExtractedImage = { name: string; bytes: Uint8Array; mime: string; page: number; width: number; height: number; ref: string };

export async function extractImages(src: Src, o: { minSize?: number; format?: "original" | "png" } = {}, onProgress?: ProgressFn): Promise<ExtractedImage[]> {
  return imagesOf(await open(src), src.name, o, onProgress);
}

async function imagesOf(doc: Awaited<ReturnType<typeof open>>, srcName: string, o: { minSize?: number; format?: "original" | "png" } = {}, onProgress?: ProgressFn): Promise<ExtractedImage[]> {
  const pageOf = imagesByPage(doc);
  const images = listImages(doc).filter((im) => !im.isMask && !im.usedAsMask && im.width >= (o.minSize ?? 24) && im.height >= (o.minSize ?? 24));
  const out: ExtractedImage[] = [];
  for (let k = 0; k < images.length; k++) {
    const im = images[k];
    onProgress?.(k / Math.max(1, images.length), `Extracting image ${k + 1} of ${images.length}`);
    const page = pageOf.get(im.ref.toString()) ?? -1;
    const base = `${stem(srcName)}-p${page >= 0 ? page + 1 : "x"}-img${String(k + 1).padStart(3, "0")}`;
    const ref = im.ref.toString();
    const jpg = jpegBytes(im);
    if (jpg && !im.smask && o.format !== "png" && im.colorSpace.kind !== "cmyk") {
      out.push({ name: `${base}.jpg`, bytes: jpg, mime: "image/jpeg", page, width: im.width, height: im.height, ref });
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
    out.push({ name: `${base}.png`, bytes: await canvasToBytes(canvas, "image/png"), mime: "image/png", page, width: im.width, height: im.height, ref });
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

/** Runs grouped by the link they are under; spaces at either end of a link stay outside it. */
function byLink(rs: Run[]): { url?: string; runs: Run[] }[] {
  const groups: { url?: string; runs: Run[] }[] = [];
  for (const r of rs) {
    const last = groups[groups.length - 1];
    if (last && last.url === r.link) last.runs.push(r);
    else groups.push({ url: r.link, runs: [r] });
  }
  return groups.flatMap((g) => {
    if (!g.url) return [g];
    const n = g.runs.length;
    const lead = g.runs[0].text.match(/^\s*/)![0];
    const trail = g.runs[n - 1].text.match(/\s*$/)![0];
    if (!lead && !trail) return [g];
    const runs = g.runs.map((r, i) => {
      let text = r.text;
      if (i === 0) text = text.trimStart();
      if (i === n - 1) text = text.trimEnd();
      return { ...r, text, ...(i === 0 && lead ? { br: undefined, tab: undefined } : {}) };
    });
    return [
      ...(lead ? [{ runs: [{ ...g.runs[0], text: lead, link: undefined }] }] : []),
      { url: g.url, runs: runs.filter((r) => r.text || r.pic) },
      ...(trail ? [{ runs: [{ ...g.runs[n - 1], text: trail, link: undefined, br: undefined, tab: undefined, pic: undefined }] }] : []),
    ];
  });
}

/** A link's address as Markdown can hold it (no spaces or brackets left bare). */
const mdUrl = (u: string) => u.replace(/[ ()<>]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));

const mdRuns = (runs: Run[]): string =>
  byLink(runs)
    .map((g) => {
      const t = mdPlain(g.runs);
      return g.url && t.trim() ? `[${t}](${mdUrl(g.url)})` : t;
    })
    .join("");

const mdPlain = (runs: Run[]): string =>
  runs
    .map((r): string => {
      // Pictures in the text have no place in plain Markdown.
      if (r.pic) return "";
      const t = mdEsc(r.text);
      if (!t.trim()) return t;
      // (Spaces stay outside the tag, so the words around it don't run together.)
      if (r.sup) return `${t.match(/^\s*/)?.[0] ?? ""}<sup>${t.trim()}</sup>${t.match(/\s*$/)?.[0] ?? ""}`;
      if (r.br) return "\\\n" + mdPlain([{ ...r, br: false }]);
      if (r.tab !== undefined) return " " + mdPlain([{ ...r, tab: undefined }]);
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
      if (f.kind === "none") return `${"   ".repeat(lvl)}${mdRuns(it)}`;
      const label = f.kind === "check" ? "- [ ]" : f.kind === "bullet" ? "-" : /^\d/.test(listLabel(b, i)) ? `${listLabel(b, i).replace(/\D+$/, "")}.` : `- ${listLabel(b, i)}`;
      return `${"   ".repeat(lvl)}${label} ${mdRuns(it)}`;
    })
    .join("\n");
}

/**
 * A running header or footer line as it reads once, without its page numbers ("Page 3 of 9"):
 * its pieces in order, or nothing when it only numbers the pages.
 */
function furnitureParts(l: FurnitureLine): string[] {
  return l.parts
    .map((p) =>
      /\{PAGES?\}/.test(p.text)
        ? p.text
            .replace(/\s*(?:\b(?:page|p\.?)\s*)?\{PAGE\}(?:\s*(?:of|\/)\s*\{PAGES\})?/gi, "")
            .replace(/\{PAGES?\}/g, "")
            .replace(/^[\s·|–—-]+|[\s·|–—-]+$/g, "")
        : p.text.trim(),
    )
    .filter((t) => /\p{L}|\d/u.test(t));
}

export function blocksToMarkdown(blocks: SBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "heading") out.push(`${"#".repeat(b.level)} ${b.runs.some((r) => r.link) ? byLink(b.runs).map((g) => (g.url ? `[${mdEsc(runsText(g.runs))}](${mdUrl(g.url)})` : mdEsc(runsText(g.runs)))).join("").replace(/\s+/g, " ") : b.text}`);
    else if (b.kind === "para") out.push(mdRuns(b.runs));
    else if (b.kind === "list") out.push(mdList(b));
    else if (b.kind === "box") out.push(blocksToMarkdown(b.blocks).trimEnd().split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
    else if (b.kind === "columns") out.push(blocksToMarkdown(b.blocks).trimEnd());
    else if (b.kind === "rule") out.push("---");
    // Content set side by side only for the page's look (and cards in a row) reads one part after the other.
    else if (b.kind === "table" && (b.layout || b.lines === "cards"))
      out.push(
        b.cells
          .flat()
          .map((c) => (c?.blocks?.length ? blocksToMarkdown(c.blocks) : (c?.paras ?? []).map(mdRuns).join("\n\n")).trimEnd())
          .filter(Boolean)
          .join("\n\n"),
      );
    else if (b.kind === "table") {
      // Cells keep their emphasis and links; their paragraphs are separated by line breaks.
      const w = Math.max(...b.cells.map((r) => r.length));
      const cell = (c?: Cell) => (c ? c.paras.map((p) => mdRuns(p).replace(/\\\n/g, "<br>").replace(/\n/g, " ")).join("<br>").replace(/\|/g, "\\|") : "");
      const row = (r: Cell[]) => `| ${Array.from({ length: w }, (_, i) => cell(r[i])).join(" | ")} |`;
      out.push([row(b.cells[0]), `| ${Array.from({ length: w }, () => "---").join(" | ")} |`, ...b.cells.slice(1).map(row)].join("\n"));
    }
  }
  return out.join("\n\n") + "\n";
}

export async function pdfToMarkdown(src: Src, onProgress?: ProgressFn): Promise<OutFile> {
  const { blocks, furniture } = await readStructured(src, onProgress);
  // The running header and footer (a letterhead, a statement's period), once: before and after the text.
  const lines = (ls: FurnitureLine[]) => ls.map((l) => furnitureParts(l).map((t) => (l.bold ? `**${mdEsc(t)}**` : mdEsc(t))).join(" · ")).filter(Boolean);
  const head = lines(furniture.header);
  const foot = lines(furniture.footer);
  const md = (head.length ? head.join("  \n") + "\n\n" : "") + blocksToMarkdown(blocks) + (foot.length ? "\n---\n\n" + foot.join("  \n") + "\n" : "");
  return { filename: `${stem(src.name)}.md`, bytes: new TextEncoder().encode(md), mime: "text/markdown" };
}

/* ----------------------------------------------------------------- html */

/**
 * What the HTML being written knows of its document: its pictures by id, the size of its running
 * text (points), and where a picture's file is (in the page as a data URI, or a file beside it).
 */
type HtmlDoc = { pics?: Map<string, ExtractedImage>; body?: number; src: (im: ExtractedImage) => string };
const dataUri = (im: ExtractedImage) => `data:${im.mime};base64,${b64(im.bytes)}`;
let hdoc: HtmlDoc = { src: dataUri };

const htmlRun = (r: Run) => {
  if (r.pic) {
    const im = hdoc.pics?.get(r.pic.id);
    return im ? `<span style="display:inline-block;vertical-align:middle">${htmlPic(r.pic, im)}</span>` : "";
  }
  let t = esc(r.text);
  // Symbols keep their colour (a legend's keys, a coloured tick); words take the page's.
  if (r.color && r.text.trim() && !/[\p{L}\p{N}]/u.test(r.text) && luminance(r.color) < 0.85) t = `<span style="color:${r.color}">${t}</span>`;
  if (r.br) t = "<br>" + t;
  if (r.sup) t = `<sup>${t}</sup>`;
  if (r.italic) t = `<em>${t}</em>`;
  if (r.bold) t = `<strong>${t}</strong>`;
  return t;
};
/**
 * Runs as HTML; a piece set flush right (after a tab) floats to the right of the line, other
 * tabs become a wide space. Links open their address.
 */
const htmlRuns = (rs: Run[]) => {
  const plain = (xs: Run[]) =>
    byLink(xs)
      .map((g) => {
        const h = g.runs.map((r) => (r.tab !== undefined ? "&#8195;&#8195;" : "") + htmlRun(r)).join("");
        return g.url ? `<a href="${esc(g.url)}">${h}</a>` : h;
      })
      .join("");
  const k = rs.findIndex((r) => r.tab === "right");
  if (k < 0) return plain(rs);
  return `${plain(rs.slice(0, k))} <span style="float:right">${plain([{ ...rs[k], tab: undefined }, ...rs.slice(k + 1)])}</span>`;
};

const OL_TYPE: Partial<Record<ListFormat["kind"], string>> = { lowerLetter: "a", upperLetter: "A", lowerRoman: "i", upperRoman: "I" };

/** Numbers HTML writes itself: plain ones followed by a full stop (1. a. i.). Others ([1], (a), 2)) are written as the PDF has them. */
const plainNumber = (f: ListFormat) => !f.before && (f.after === "." || f.after === "");

/**
 * A list as nested <ol>/<ul> elements, one level per indent. Numbers set some other way ([1],
 * (a), a clause's 2.1) hang before the text as they read in the PDF.
 */
function htmlList(b: ListBlock): string {
  let html = "";
  const open: string[] = [];
  const formatOf = (lvl: number) => b.formats[lvl] ?? b.formats[0];
  const labelled = (f: ListFormat) => f.kind === "none" || (f.kind !== "bullet" && f.kind !== "check" && !plainNumber(f));
  const openList = (lvl: number) => {
    const f = formatOf(lvl);
    const tag = f.kind === "bullet" || f.kind === "check" || f.kind === "none" ? "ul" : "ol";
    const attrs =
      (labelled(f) ? ` class="lbl"` : tag === "ol" ? `${OL_TYPE[f.kind] ? ` type="${OL_TYPE[f.kind]}"` : ""}${f.start !== 1 ? ` start="${f.start}"` : ""}` : f.kind === "check" ? ` class="check"` : "") +
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
    const f = formatOf(lvl);
    const check = f.kind === "check" ? "☐ " : "";
    // A clause's own number, before the tab to its text, hangs like a list's number.
    const k = f.kind === "none" ? it.findIndex((r) => r.tab === "next") : -1;
    if (k > 0) html += `<li><span class="n">${htmlRuns(it.slice(0, k))}</span>${htmlRuns([{ ...it[k], tab: undefined }, ...it.slice(k + 1)])}`;
    else if (labelled(f) && f.kind !== "none") html += `<li><span class="n">${esc(listLabel(b, i))}</span>${htmlRuns(it)}`;
    else html += `<li>${check}${htmlRuns(it)}`;
  });
  while (open.length) html += `</li></${open.pop()}>`;
  return html;
}

/**
 * A picture at the size it shows in the PDF (at most the page's width), turned and mirrored
 * as there; a cropped one inside a frame that shows only the part the PDF shows.
 */
function htmlPic(p: Pic, im: ExtractedImage): string {
  const w = Math.round(p.ow * (96 / 72));
  const h = Math.round(p.oh * (96 / 72));
  const src = hdoc.src(im);
  const turn = [p.rot ? `rotate(${p.rot}deg)` : "", p.flip ? "scaleX(-1)" : ""].filter(Boolean).join(" ");
  let pic: string;
  if (!p.crop) pic = `<img src="${src}" alt="" width="${w}" height="${h}">`;
  else {
    const c = p.crop;
    const fw = 1 - c.left - c.right;
    const fh = 1 - c.top - c.bottom;
    const pc = (v: number) => `${(v * 100).toFixed(2)}%`;
    pic = `<span class="crop" style="width:${w}px;aspect-ratio:${w}/${h}"><img src="${src}" alt="" style="width:${pc(1 / fw)};height:${pc(1 / fh)};left:${pc(-c.left / fw)};top:${pc(-c.top / fh)}"></span>`;
  }
  if (!turn) return pic;
  // Turned in a frame as big as it shows, so it takes its turned room on the page.
  const vw = Math.round(p.w * (96 / 72));
  const vh = Math.round(p.h * (96 / 72));
  return `<span class="turn" style="width:${vw}px;height:${vh}px"><span style="width:${w}px;height:${h}px;transform:translate(-50%,-50%) ${turn}">${pic}</span></span>`;
}

/** Blocks as HTML; `doc`, given at the top, says what the document holds (see HtmlDoc). */
function blocksToHtml(blocks: SBlock[], imgs: Map<number, ExtractedImage[]>, doc?: Partial<HtmlDoc>): string {
  if (doc) {
    const prev = hdoc;
    hdoc = { ...hdoc, ...doc };
    try {
      return blocksToHtml(blocks, imgs);
    } finally {
      hdoc = prev;
    }
  }
  const out: string[] = [];
  let page = 0;
  const flushImgs = (p: number) => {
    for (const im of imgs.get(p) ?? []) out.push(`<figure><img src="${hdoc.src(im)}" alt="" width="${Math.min(im.width, 720)}"></figure>`);
  };
  const inner = (bs: SBlock[]) => blocksToHtml(bs, new Map());
  const images = hdoc.pics;
  // A caption set just under a picture ("Figure 1. ..."): the picture's own, kept with it.
  const captions = new Set<SBlock>();
  blocks.forEach((b, i) => {
    const c = blocks[i + 1];
    if (b.kind !== "image" || c?.kind !== "para" || !b.geo || !c.geo) return;
    const text = runsText(c.runs).trim();
    const near = c.geo.top - b.geo.bottom <= Math.max(18, c.geo.first * 2);
    if (near && text.length <= 300 && (c.align === "center" || /^(fig(ure)?|chart|graph|diagram|photo|plate|exhibit|map|illustration)\.?\s*[\dIVX]/i.test(text))) captions.add(c);
  });
  for (const b of blocks) {
    if (captions.has(b)) continue;
    if (b.kind === "pagebreak") {
      flushImgs(page);
      page = b.page;
      // A page the author began (a slide, a chapter) is marked; where the text simply ran on, it reads on.
      if (b.deliberate !== false) out.push(`<hr class="page" aria-label="Page ${b.page + 1}">`);
    } else if (b.kind === "heading") {
      // As large as in the PDF beside its text, within what reads well on a screen.
      const em = hdoc.body ? Math.min(2.2, Math.max(1, 1 + (b.size / hdoc.body - 1) * 0.6)) : 0;
      const style = [em ? `font-size:${em.toFixed(2)}em` : "", b.align ? `text-align:${b.align}` : "", b.under ? `border-bottom:1px solid ${b.under.color};padding-bottom:.2em` : ""].filter(Boolean).join(";");
      const text = b.runs.some((r) => r.link) ? byLink(b.runs).map((g) => (g.url ? `<a href="${esc(g.url)}">${esc(runsText(g.runs))}</a>` : esc(runsText(g.runs)))).join("") : esc(b.text);
      out.push(`<h${b.level}${style ? ` style="${style}"` : ""}>${text}</h${b.level}>`);
    }
    else if (b.kind === "para") {
      const style = [
        b.align && b.align !== "left" ? `text-align:${b.align}` : "",
        // (A deep indent gives way on a narrow screen.)
        b.indent && !b.bar ? `margin-left:${b.indent.left > 36 ? `min(${b.indent.left.toFixed(0)}pt,35%)` : `${b.indent.left.toFixed(0)}pt`};text-indent:${b.indent.first.toFixed(0)}pt` : "",
        b.under ? `border-bottom:1px solid ${b.under.color};padding-bottom:.2em` : "",
      ]
        .filter(Boolean)
        .join(";");
      const p = `<p${style ? ` style="${style}"` : ""}>${htmlRuns(b.runs)}</p>`;
      // Paragraphs set beside one bar (a pull quote with its label) stay together beside it.
      const prev = blocks[blocks.indexOf(b) - 1];
      if (b.bar && prev?.kind === "para" && prev.bar === b.bar && out.length && out[out.length - 1].endsWith("</p></div>")) out[out.length - 1] = out[out.length - 1].slice(0, -"</div>".length) + p + "</div>";
      else out.push(b.bar ? `<div class="bar" style="border-left:3px solid ${b.bar};padding-left:.75em;margin:1rem 0">${p}</div>` : p);
    } else if (b.kind === "list") out.push(htmlList(b));
    else if (b.kind === "rule") out.push(`<hr style="border:0;border-top:${Math.max(1, Math.round(b.h))}px solid ${b.color}">`);
    // Columns of text, one under the other where the screen is too narrow for them.
    else if (b.kind === "columns") out.push(`<div style="columns:${b.count} 15rem;column-gap:2em">${inner(b.blocks)}</div>`);
    else if (b.kind === "box") {
      // Light boxes keep their colour; dark ones become a light panel with a bar in their colour, since text colours aren't kept here.
      const light = !b.fill || luminance(b.fill) > 0.75;
      const style = light ? `background:${b.fill ?? "transparent"};border:1px solid ${b.stroke ?? b.fill ?? "#ccc"}` : `background:#f4f6f8;border-left:4px solid ${b.fill}`;
      out.push(`<aside style="${style};padding:.75em 1em;margin:1em 0;border-radius:4px">${inner(b.blocks)}</aside>`);
    } else if (b.kind === "table" && b.layout) {
      // Content set side by side stays so, as wide as on the page, and goes one under the other on a
      // narrow screen. A shaded side (a CV's sidebar) keeps its shade, or a bar in it where it's dark.
      const row = b.cells[0] ?? [];
      const shade = (c?: Cell) => (!c?.fill ? "" : luminance(c.fill) > 0.75 ? `;background:${c.fill};padding:.75em 1em` : `;background:#f4f6f8;border-left:4px solid ${c.fill};padding:.75em 1em`);
      out.push(`<div class="side">${row.map((c, i) => `<div style="flex:${(b.widths[i] ?? 1 / row.length).toFixed(3)} 1 0${shade(c)}">${inner(c?.blocks ?? [])}</div>`).join("")}</div>`);
      for (const r of b.cells.slice(1)) out.push(...r.map((c) => `<div>${inner(c?.blocks ?? [])}</div>`));
    } else if (b.kind === "table" && b.lines === "cards") {
      // Cards side by side (boxes, or pictures with their captions): a row that wraps on small screens.
      const card = (c: Cell) => {
        const style = [c.fill ? `background:${c.fill}` : "", c.stroke ? `border:1px solid ${c.stroke}` : "", c.fill || c.stroke ? "padding:.75em 1em;border-radius:4px" : ""].filter(Boolean).join(";");
        return `<div${style ? ` style="${style}"` : ""}>${c.blocks?.length ? inner(c.blocks) : c.paras.map(htmlRuns).join("<br>")}</div>`;
      };
      out.push(...b.cells.map((r) => `<div class="cards">${r.filter(Boolean).map(card).join("")}</div>`));
    } else if (b.kind === "table") {
      const cell = (bl: TableBlock, ri: number, ci: number, tag: string) => {
        const c = bl.cells[ri]?.[ci];
        // A label hanging before the text (an option's letter): the text's lines line up after it.
        const hang = c?.hang && !c.blocks?.length && c.paras.length === 1 && c.paras[0].findIndex((r) => r.tab === "next") > 0 ? c.hang : 0;
        const label = (rs: Run[]) => {
          const k = rs.findIndex((r) => r.tab === "next");
          return `<span style="display:inline-block;min-width:${Math.round(hang)}pt;text-indent:0">${htmlRuns(rs.slice(0, k))}</span>${htmlRuns([{ ...rs[k], tab: undefined }, ...rs.slice(k + 1)])}`;
        };
        const html = c?.blocks?.length ? inner(c.blocks) : hang ? label(c!.paras[0]) : (c?.paras ?? []).map(htmlRuns).join("<br>");
        const style = [
          c?.align ? `text-align:${c.align}` : "",
          c?.valign ? `vertical-align:${c.valign === "center" ? "middle" : "bottom"}` : "",
          // Long unbroken strings (references in a statement's narration) may break, so the table can fit.
          c && /\S{18,}/.test(c.text) && c.text.length > 24 ? "overflow-wrap:anywhere" : "",
          hang ? `padding-left:calc(.5rem + ${Math.round(hang)}pt);text-indent:-${Math.round(hang)}pt` : c?.indent ? `padding-left:calc(.5rem + ${Math.round(c.indent)}pt)` : "",
        ]
          .filter(Boolean)
          .join(";");
        return `<${tag}${style ? ` style="${style}"` : ""}>${html}</${tag}>`;
      };
      const row = (ri: number, tag: string) => {
        // A cell across several columns covers the ones after it.
        let skip = 0;
        return `<tr>${b.rows[ri]
          .map((_, ci) => {
            if (skip > 0) return (skip--, "");
            const n = b.cells[ri]?.[ci]?.span ?? 1;
            skip = n - 1;
            const html = cell(b, ri, ci, tag);
            return n > 1 ? html.replace(/^<(t[hd])/, `<$1 colspan="${n}"`) : html;
          })
          .join("")}</tr>`;
      };
      const heads = b.head ?? (b.header ? 1 : 0);
      const head = heads ? `<thead>${b.rows.slice(0, heads).map((_, ri) => row(ri, "th")).join("")}</thead>` : "";
      // Wide tables scroll sideways on small screens instead of widening the page.
      out.push(`<div class="wide"><table>${head}<tbody>${b.rows.map((_, ri) => (ri < heads ? "" : row(ri, "td"))).join("")}</tbody></table></div>`);
    } else if (b.kind === "image" && images) {
      const pics = b.pics.flatMap((p) => (images.has(p.id) ? [htmlPic(p, images.get(p.id)!)] : []));
      const next = blocks[blocks.indexOf(b) + 1];
      const caption = next?.kind === "para" && captions.has(next) ? `<figcaption>${htmlRuns(next.runs)}</figcaption>` : "";
      if (pics.length) out.push(caption ? `<figure>${pics.length > 1 ? `<div class="row">${pics.join("")}</div>` : pics.join("")}${caption}</figure>` : `<figure${pics.length > 1 ? ' class="row"' : ""}>${pics.join("")}</figure>`);
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

/** Styles the HTML's blocks need, in a web page and in an ebook alike. */
const BLOCK_CSS = `table{border-collapse:collapse;margin:1rem 0;width:100%}th,td{border:1px solid #ccc;padding:.35rem .5rem;text-align:left;vertical-align:top}th{background:#f3f3f3}
figure{margin:1rem 0;break-inside:avoid}figcaption{font-size:.9em;text-align:center;margin-top:.4rem}img{max-width:100%;height:auto}figure.row,figure>.row{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-start}.crop{display:inline-block;max-width:100%;overflow:hidden;position:relative}.crop img{position:absolute;max-width:none}.turn{display:inline-block;position:relative}.turn>span{position:absolute;left:50%;top:50%}.turn img{max-width:none}.cards{display:flex;flex-wrap:wrap;gap:1rem;margin:1rem 0}.cards>div{flex:1 1 12rem;min-width:0}.cards figure{margin:0 0 .4rem}
.side{display:flex;flex-wrap:wrap;gap:0 2rem}.side>div{min-width:min(100%,13rem)}.lbl{list-style:none;padding-left:2.6em}.lbl>li>.n{display:inline-block;min-width:2.6em;margin-left:-2.6em}.wide{overflow-x:auto;margin:1rem 0}.wide>table{margin:0}ul.check{list-style:none;padding-left:1.4rem}ul.check>li{text-indent:-1.4rem}.bar>p{margin:.4rem 0}`;

const HTML_CSS = `body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:46rem;margin:2.5rem auto;padding:0 1.25rem;color:#1a1a1a}
h1,h2,h3{line-height:1.25}${BLOCK_CSS}
hr.page{border:0;border-top:1px dashed #ddd;margin:2rem 0}.running{color:#555;font-size:.85em;margin:0 0 1.5rem}footer.running{margin:2rem 0 0;border-top:1px solid #ddd;padding-top:.75rem}.running p{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.25rem 1rem;margin:.15rem 0}`;

export async function pdfToHtml(src: Src, o: { mode?: "reflow" | "exact"; images?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const title = stem(src.name);
  if (o.mode === "exact") return pdfToHtmlExact(src, onProgress);
  // Pictures go where the page has them; any whose place couldn't be read, at the end of their page.
  const { blocks, images, pages, unread, furniture, body } = await readStructured(src, onProgress, { images: o.images !== false });
  // The running header and footer (a letterhead, a statement's period), once: before and after the text.
  const run = (ls: FurnitureLine[], tag: string) => {
    const rows = ls
      .map((l) => ({ l, parts: furnitureParts(l) }))
      .filter((x) => x.parts.length)
      .map(({ l, parts }) => `<p${l.bold ? ' style="font-weight:600"' : ""}>${parts.map((t) => `<span>${esc(t)}</span>`).join("")}</p>`);
    return rows.length ? `<${tag} class="running">${rows.join("")}</${tag}>\n` : "";
  };
  // Tables of many columns (a statement) get a wider page, so they need not scroll on a computer.
  const cols = (bs: SBlock[]): number => Math.max(0, ...bs.map((b) => (b.kind === "table" && !b.layout ? Math.max(...b.rows.map((r) => r.length)) : b.kind === "box" || b.kind === "columns" ? cols(b.blocks) : 0)));
  const css = HTML_CSS + (cols(blocks) >= 6 ? "body{max-width:64rem}" : "");
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="generator" content="${esc(BRAND.name)}"><style>${css}</style></head><body>\n${run(furniture.header, "header")}${blocksToHtml(blocks, unplaced(images, pages, unread), { pics: images, body: body.size })}\n${run(furniture.footer, "footer")}</body></html>\n`;
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
  liberationsansnarrow: "Arial Narrow",
  arimo: "Arial",
  carlito: "Calibri",
  caladea: "Cambria",
  tinos: "Times New Roman",
  cousine: "Courier New",
  dejavusans: "Verdana",
  dejavusanscondensed: "Arial Narrow",
  dejavuserif: "Georgia",
  dejavusansmono: "Consolas",
  bitstreamverasans: "Verdana",
  bitstreamveraserif: "Georgia",
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
/** A colour (RRGGBB) with its blue `step` levels lighter or darker: the same to the eye, but not equal. */
const shade = (rgb: string, step: number) => {
  const c = parseInt(rgb, 16);
  const b = c & 0xff;
  return ((c & 0xffff00) | Math.max(0, Math.min(255, b + (b > 127 ? -step : step)))).toString(16).padStart(6, "0").toUpperCase();
};
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

type DocxMod = typeof import("docx");
type DocxOut = InstanceType<DocxMod["Paragraph"]> | InstanceType<DocxMod["Table"]>;
/** Formatting a paragraph's runs inherit (size in half-points, colour without "#"). */
type RunBase = { font: string; size: number; color: string; bold: boolean; italic: boolean };
/**
 * Where blocks go: the width (twips), the colour behind them, and where the text's left edge
 * is on the page (points), when known. `last`: the block ends a cell or box, which keeps the
 * space below it.
 */
type Where = { width: number; bg?: string; pageBreak?: boolean; cell?: boolean; x0?: number; last?: boolean };
/** Marks where the page switches to `count` text columns (1: back to one), splitting the document into sections. */
class Columns {
  /** `space`: between the columns, in twips. */
  constructor(
    public count: number,
    public space = 360,
  ) {}
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

/** A cell whose last paragraph was one line in the PDF (set solid in Word), or that holds blocks of its own. */
const solidEnd = (c: Cell | undefined) => !c || !!c.blocks?.length || (!!c.geo && !c.geo.leadings[Math.max(0, c.paras.length - 1)]);

/** The most space kept between two blocks (points); the structure already keeps gaps it isn't sure of modest. */
const MAX_GAP = 800;

/** Text set in one paragraph: its main face and size, and Word's line spacing for it. */
type Lines = { size: number; factor: number; multiple: number };

/**
 * How a picture floats: "over" the text where it is on the page (a logo in the running header);
 * "clear", where it is on the page with `below` points kept clear under it and the text going on
 * below it (a photo across the top of the page, above the margin); "behind" the text, `dy` points
 * from the paragraph it is anchored in (a photo with a title set over it).
 */
type Float = { mode: "over" | "clear" | "behind"; below?: number; dy?: number };

/** A picture as Word shows it: its own size (times `k`), turned, mirrored and cropped as in the PDF; inline, or floating (see Float). */
function picRun(d: DocxMod, p: Pic, im: ExtractedImage | undefined, k = 1, float?: Float) {
  if (!im) return null;
  const px = (pt: number) => Math.max(1, Math.round(pt * k * (96 / 72)));
  const pct = (f: number) => Math.round(f * 10000) / 100;
  const emu = (pt: number) => Math.round(pt * 12700);
  // A turned picture's own box is centred where the turned one shows.
  const at = { x: p.x + p.w / 2 - p.ow / 2, y: p.y + p.h / 2 - p.oh / 2 };
  return new d.ImageRun({
    type: im.mime === "image/png" ? "png" : "jpg",
    data: im.bytes,
    transformation: { width: px(p.ow), height: px(p.oh), ...(p.rot ? { rotation: p.rot } : {}), ...(p.flip ? { flip: { horizontal: true } } : {}) },
    ...(p.crop ? { crop: { left: pct(p.crop.left), top: pct(p.crop.top), right: pct(p.crop.right), bottom: pct(p.crop.bottom) } } : {}),
    ...(float
      ? {
          floating: {
            horizontalPosition: { relative: d.HorizontalPositionRelativeFrom.PAGE, offset: emu(at.x) },
            verticalPosition: float.mode === "behind" ? { relative: d.VerticalPositionRelativeFrom.PARAGRAPH, offset: emu((float.dy ?? 0) + at.y - p.y) } : { relative: d.VerticalPositionRelativeFrom.PAGE, offset: emu(at.y) },
            allowOverlap: true,
            ...(float.mode === "clear" ? { wrap: { type: d.TextWrappingType.TOP_AND_BOTTOM }, margins: { top: 0, bottom: emu(float.below ?? 0), left: 0, right: 0 } } : { wrap: { type: d.TextWrappingType.NONE } }),
            ...(float.mode === "behind" ? { behindDocument: true } : {}),
          },
        }
      : {}),
    altText: { name: im.name, description: "", title: "" },
    // In a run of tiny type, so the line holding it is no taller than the picture.
    run: { size: 2 },
  });
}

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
    private layout: PageLayout,
    private images: Map<string, ExtractedImage> = new Map(),
  ) {
    this.body = { font: wordFont(bs.face, bs.family), size: Math.round(bs.size * 2), color: hex(bs.color) ?? "000000", bold: false, italic: false };
    // Each heading level looks like its first heading (its longest run).
    const first: Record<number, Run> = {};
    const walk = (bs2: SBlock[]) => {
      for (const b of bs2) {
        if (b.kind === "heading" && !first[b.level]) first[b.level] = [...b.runs].sort((x, y) => y.text.length - x.text.length)[0];
        else if (b.kind === "box" || b.kind === "columns") walk(b.blocks);
        else if (b.kind === "table") for (const row of b.cells) for (const c of row) if (c?.blocks) walk(c.blocks);
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
   * With `solid`, single lines are always set solid (table cells: the row is as tall as the
   * PDF's, with no extra line spacing to take back).
   */
  private linesOf(runs: Run[], leading?: number, solid = false): Lines {
    const main = [...runs].sort((x, y) => y.text.length - x.text.length)[0];
    const size = main?.size ?? this.bs.size;
    const factor = LINE_HEIGHT[wordFont(main?.face, main?.family)] ?? 1.17;
    const multiple = leading ? clamp(leading / (size * factor), 0.9, 3) : solid || size > this.bs.size * 1.15 ? 1 : this.multiple;
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
    return Math.round(clamp(gap - below - 0.08 * next, 0, MAX_GAP) * 20);
  }

  /** The paragraph mark in the paragraph's own size: a mark in the larger default size would make its last line taller. */
  private mark(l: Lines, base: RunBase) {
    return Math.abs(l.size * 2 - base.size) >= 1 ? { run: { size: Math.round(l.size * 2) } } : {};
  }

  private spacing(l: Lines, after: number) {
    return { before: 0, after, line: Math.round(l.multiple * 240), lineRule: this.d.LineRuleType.AUTO };
  }

  /**
   * Spacing after a paragraph and, when a line is drawn under it, that line as its bottom
   * border: Word draws it `space` points below the text, and the space after follows it.
   */
  private underlined(l: Lines, u: Under | undefined, geo?: Geo) {
    if (!u) return { spacing: this.spacing(l, this.after(l, geo?.gap, geo?.next)) };
    const below = l.multiple * l.factor * l.size - 1.12 * l.size;
    const after = geo?.gap !== undefined ? Math.round(clamp(geo.gap - u.at - u.h - 0.08 * (geo.next ?? 0), 0, MAX_GAP) * 20) : this.paraAfter;
    return {
      spacing: this.spacing(l, after),
      border: { bottom: { style: this.d.BorderStyle.SINGLE, size: Math.max(2, Math.round(u.h * 8)), color: hex(u.color) ?? "000000", space: Math.round(clamp(u.at - below, 0, 31)) } },
    };
  }

  block(b: SBlock, at: Where): (DocxOut | Columns)[] {
    const d = this.d;
    if (b.kind === "heading") {
      const level = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3][b.level - 1];
      const l = this.linesOf(b.runs, b.geo?.leading);
      return [
        new d.Paragraph({
          heading: level,
          children: this.runs(b.runs, this.heads[b.level], at.bg),
          ...this.mark(l, this.heads[b.level]),
          pageBreakBefore: at.pageBreak,
          ...this.underlined(l, b.under, b.geo),
          ...(b.align ? { alignment: b.align === "center" ? d.AlignmentType.CENTER : d.AlignmentType.RIGHT } : {}),
          ...this.tabStops(b.runs, at.width),
        }),
      ];
    }
    if (b.kind === "para") {
      const l = this.linesOf(b.runs, b.geo?.leading);
      return [
        new d.Paragraph({
          children: this.runs(b.runs, this.body, at.bg),
          ...this.mark(l, this.body),
          ...this.tabStops(b.runs, at.width),
          pageBreakBefore: at.pageBreak,
          keepNext: b.keep,
          ...this.underlined(l, b.under, b.geo),
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
    if (b.kind === "rule") {
      // An empty paragraph one point tall with its bottom border where the line is.
      const gap = b.geo?.gap;
      // Its one-point line and the rule itself already take some of the gap.
      const after = gap !== undefined ? Math.round(clamp(gap - 0.08 * (b.geo?.next ?? 0) - 1 - b.h, 0, MAX_GAP) * 20) : 0;
      return [
        new d.Paragraph({
          children: [],
          pageBreakBefore: at.pageBreak,
          spacing: { before: 0, after, line: 20, lineRule: d.LineRuleType.EXACT },
          indent: { left: Math.round(b.inset.left * 20), right: Math.round(b.inset.right * 20) },
          // A colour a shade apart from the same line under a neighbouring paragraph, or Word joins the two into one bordered block.
          border: { bottom: { style: d.BorderStyle.SINGLE, size: Math.max(2, Math.round(b.h * 8)), color: shade(hex(b.color) ?? "000000", 2), space: 0 } },
        }),
      ];
    }
    if (b.kind === "table") return this.withBreak(this.table(b, at), b.geo, at, b.layout ? this.tailOf(b) : this.overOf(b));
    if (b.kind === "box") return this.withBreak(this.box(b, at), b.geo, at);
    if (b.kind === "image") return this.picture(b, at);
    if (b.kind === "columns") {
      // The space between the columns as in the PDF (from where each starts); inside a column, tables and boxes are a column wide.
      const pitch = b.starts && b.starts.length > 1 ? b.starts[1] - b.starts[0] : 0;
      const gutter = pitch ? Math.round(clamp(b.count * pitch - at.width / 20, 6, 72) * 20) : 360;
      const width = at.cell ? at.width : Math.round((at.width - gutter * (b.count - 1)) / b.count);
      const inner = b.blocks.flatMap((x, k) => this.block(x, { ...at, width, pageBreak: at.pageBreak && k === 0, cell: true, x0: undefined }));
      // The first column may start lower than the columns do (a heading with space above it, beside a column running on).
      const g0 = b.blocks.map((x) => ("geo" in x ? x.geo : undefined)).find(Boolean);
      const drop = g0 && b.geo ? g0.top - 0.08 * g0.first - (b.geo.top - 0.08 * b.geo.first) : 0;
      if (drop >= 1) inner.unshift(new d.Paragraph({ children: [], spacing: { before: 0, after: 0, line: Math.round(drop * 20), lineRule: d.LineRuleType.EXACT } }));
      // Columns of their own: a section set in columns (not inside a table or box).
      return at.cell ? content(inner) : [new Columns(b.count, gutter), ...content(inner), new Columns(1)];
    }
    return [];
  }

  /**
   * Pictures at their size and place. One goes in a paragraph of its own, set in from the left
   * as on the page (a wide one reaches into the margins as it does in the PDF); a row of them
   * goes in a table without lines, each at the top of a column as wide as it, the space
   * between them kept. Pictures too wide for the room they have shrink to fit.
   */
  private picture(b: ImageBlock, at: Where): DocxOut[] {
    const d = this.d;
    const pics = b.pics.filter((p) => this.images.has(p.id));
    if (!pics.length) return [];
    const left = Math.min(...pics.map((p) => p.x));
    const span = Math.max(...pics.map((p) => p.x + p.w)) - left;
    const width = at.width / 20;
    // Room: the text's width in a cell or a column; the page's width, margins and all, elsewhere.
    const page = at.x0 !== undefined && !at.cell;
    const k = Math.min(1, (page ? this.layout.width : width) / Math.max(1, span));
    const shift = at.x0 !== undefined ? left - at.x0 : 0;
    const x = page ? clamp(shift, -at.x0!, Math.max(0, this.layout.width - at.x0! - span * k)) : clamp(shift, 0, Math.max(0, width - span * k));
    // Word adds nothing below the pictures but the paragraph mark's line, set tiny.
    const gap = b.geo?.gap;
    const after = gap !== undefined ? Math.round(clamp(gap - 0.08 * (b.geo?.next ?? 0), 0, MAX_GAP) * 20) : this.paraAfter;
    const mark = { size: 2 };
    const p0 = pics[0];
    const anchor = (run: ReturnType<typeof picRun>, after = 0) =>
      new d.Paragraph({ children: run ? [run] : [], pageBreakBefore: at.pageBreak, run: mark, spacing: { before: 0, after: Math.round(clamp(after, 0, MAX_GAP) * 20), line: 20, lineRule: d.LineRuleType.EXACT } });
    // Text set over the picture (a title on a photo): the picture goes behind the text, where it
    // is, and the text where it is over it. Its paragraph sits at the picture's top, or at the top
    // margin for a picture that starts above it.
    if (pics.length === 1 && b.geo?.under) {
      const top = page ? Math.max(p0.y, this.layout.top) : p0.y;
      const after = (gap ?? 0) - 0.08 * (b.geo.next ?? 0) - (top - p0.y) - 1;
      return [anchor(picRun(d, p0, this.images.get(p0.id), 1, { mode: "behind", dy: p0.y - top }), after)];
    }
    // A picture that starts above the top margin (a photo across the top of the page) is fixed
    // where it is on the page, and the text goes on below it.
    if (page && pics.length === 1 && p0.y < this.layout.top - 1 && p0.h < this.layout.height * 0.9) {
      return [anchor(picRun(d, p0, this.images.get(p0.id), 1, { mode: "clear", below: Math.max(0, gap ?? 0) }))];
    }
    if (pics.length === 1) {
      const run = this.imageRun(pics[0], k);
      const right = Math.min(0, width - (x + span * k));
      return [
        new d.Paragraph({
          children: run ? [run] : [],
          pageBreakBefore: at.pageBreak,
          run: mark,
          spacing: { before: 0, after, line: 240, lineRule: d.LineRuleType.AUTO },
          ...(x || right ? { indent: { left: Math.round(x * 20), ...(right ? { right: Math.round(right * 20) } : {}) } } : {}),
        }),
      ];
    }
    // A row: a column for each picture and for each space between two.
    const none = { style: d.BorderStyle.NONE, size: 0, color: "auto" };
    const zero = { top: 0, bottom: 0, left: 0, right: 0 };
    const slots: { w: number; pic?: Pic }[] = [];
    pics.forEach((p, i) => {
      if (i) {
        const gapX = (p.x - (pics[i - 1].x + pics[i - 1].w)) * k;
        if (gapX >= 0.5) slots.push({ w: gapX });
      }
      slots.push({ w: p.w * k, pic: p });
    });
    const cells = slots.map((s) => {
      const run = s.pic ? this.imageRun(s.pic, k) : null;
      return new d.TableCell({
        width: { size: Math.round(s.w * 20), type: d.WidthType.DXA },
        margins: zero,
        borders: { top: none, bottom: none, left: none, right: none },
        children: [new d.Paragraph({ children: run ? [run] : [], run: mark, spacing: { before: 0, after: 0, line: 240, lineRule: d.LineRuleType.AUTO } })],
      });
    });
    const cols = slots.map((s) => Math.round(s.w * 20));
    const table = new d.Table({
      width: { size: cols.reduce((a, c) => a + c, 0), type: d.WidthType.DXA },
      columnWidths: cols,
      layout: d.TableLayoutType.FIXED,
      ...(x ? { indent: { size: Math.round(x * 20), type: d.WidthType.DXA } } : {}),
      borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
      margins: zero,
      rows: [new d.TableRow({ cantSplit: true, children: cells })],
    });
    return this.withBreak([table], b.geo, at);
  }

  private imageRun(p: Pic, k = 1) {
    return picRun(this.d, p, this.images.get(p.id), k);
  }

  /** Line spacing of a table's cell text: its usual size, at the spacing measured in its cells. */
  private cellLines(b: TableBlock): Lines {
    const sizes = b.cells.flatMap((r) => r.flatMap((c) => c?.geo?.sizes ?? [])).sort((x, y) => x - y);
    return this.linesOf([{ text: "x", bold: false, italic: false, size: sizes.length ? sizes[sizes.length >> 1] : this.bs.size }], b.leading, true);
  }

  /** How far a plain table's last line in a row reaches below the row's padding in Word (points): none for a last row of single lines, set solid. */
  private overOf(b: TableBlock, ri = b.cells.length - 1): number {
    if (b.lines === "cards" || b.layout) return 0;
    if ((b.cells[ri] ?? []).every(solidEnd)) return 0;
    const l = this.cellLines(b);
    return Math.max(0, l.multiple * l.factor * l.size - 1.12 * l.size - (b.pad?.y ?? 3));
  }

  /**
   * The space below a table or box that ends a cell or box, in twips: it goes in the cell's
   * bottom margin, since readers drop an empty paragraph after a table there.
   */
  private below(b: SBlock | undefined): number {
    const tableLike = b && (b.kind === "table" || b.kind === "box" || (b.kind === "image" && b.pics.length > 1));
    if (!b || !tableLike || !("geo" in b) || b.geo?.gap === undefined) return 0;
    const tail = b.kind === "table" ? (b.layout ? this.tailOf(b) : this.overOf(b)) : 0;
    return Math.round(clamp(b.geo.gap - 0.08 * (b.geo.next ?? 0) - tail, 0, MAX_GAP) * 20);
  }

  /** The paragraph Word needs after a table that ends a cell: as small as can be. */
  private stub() {
    return new this.d.Paragraph({ children: [], spacing: { before: 0, after: 0, line: 20, lineRule: this.d.LineRuleType.EXACT } });
  }

  /**
   * How far below its text a table of content set side by side ends in Word: the last line of
   * its deepest side is as tall as its line spacing, which reaches past the text (points).
   */
  private tailOf(b: TableBlock): number {
    const bottom = b.geo?.bottom;
    if (bottom === undefined) return 0;
    return Math.max(
      0,
      ...b.cells.flat().map((c) => {
        const last = c?.blocks?.[c.blocks.length - 1];
        const g = last && "geo" in last ? last.geo : undefined;
        if (!last || !g || Math.abs(g.bottom - bottom) > 2 || c?.valign) return 0;
        const runs = last.kind === "para" || last.kind === "heading" ? last.runs : last.kind === "list" ? last.items[last.items.length - 1] : undefined;
        if (!runs) return 0;
        const l = this.linesOf(runs, g.leading);
        return Math.max(0, l.multiple * l.factor * l.size - 1.12 * l.size);
      }),
    );
  }

  /** An empty paragraph after a table (it keeps the next table from joining it), exactly as tall as the gap below it in the PDF. */
  private withBreak(out: DocxOut[], geo: Geo | undefined, at: Where, tail = 0): DocxOut[] {
    const d = this.d;
    if (at.last) return out;
    const gap = geo?.gap !== undefined ? clamp(geo.gap - 0.08 * (geo.next ?? 0) - tail, 1, MAX_GAP) : 8;
    out.push(new d.Paragraph({ children: [], spacing: { before: 0, after: 0, line: Math.round(gap * 20), lineRule: d.LineRuleType.EXACT } }));
    return at.pageBreak ? [new d.Paragraph({ children: [], pageBreakBefore: true, spacing: { before: 0, after: 0, line: 20, lineRule: d.LineRuleType.EXACT } }), ...out] : out;
  }

  private runs(rs: Run[], base: RunBase, bg?: string) {
    // Text under a link opens its address.
    const out: (ReturnType<WordWriter["plainRuns"]>[number] | InstanceType<DocxMod["ExternalHyperlink"]>)[] = [];
    for (let i = 0; i < rs.length; ) {
      const url = rs[i].link;
      let j = i + 1;
      while (j < rs.length && rs[j].link === url) j++;
      const kids = this.plainRuns(rs.slice(i, j), base, bg);
      if (url && kids.length) out.push(new this.d.ExternalHyperlink({ link: url, children: kids }));
      else out.push(...kids);
      i = j;
    }
    return out;
  }

  private plainRuns(rs: Run[], base: RunBase, bg?: string) {
    return rs.flatMap((r) => {
      // A piece set flush right follows a tab (unshaded, so a badge's colour stays on the badge) to the stop at the right edge (see tabStops).
      // The tab is set in the size of the text after it, or a larger default size would make the line taller.
      const size = r.size && Math.abs(r.size * 2 - base.size) >= 1 ? { size: Math.round(r.size * 2) } : {};
      const tab = r.tab !== undefined ? [new this.d.TextRun({ ...size, children: [new this.d.Tab()] })] : [];
      const brk = r.br ? [new this.d.TextRun({ ...size, break: 1 })] : [];
      // A picture in the text, at its size.
      if (r.pic) {
        const pic = this.imageRun(r.pic);
        return [...brk, ...tab, ...(pic ? [pic] : [])];
      }
      const o = { ...(this.runOptions(r, base, bg) as object), ...(r.br ? { break: 1 } : {}) } as ConstructorParameters<DocxMod["TextRun"]>[0];
      return [...tab, new this.d.TextRun(o)];
    });
  }

  /** Tab stops a paragraph's tabs need: one at the right edge for a piece set flush right, others where the PDF has their text. */
  private tabStops(rs: Run[], width: number) {
    type Stop = { type: (DocxMod["TabStopType"])[keyof DocxMod["TabStopType"]]; position: number };
    const stops = rs.flatMap((r): Stop[] =>
      r.tab === "right" ? [{ type: this.d.TabStopType.RIGHT, position: width }] : typeof r.tab === "number" ? [{ type: this.d.TabStopType.LEFT, position: Math.round(r.tab * 20) }] : [],
    );
    return stops.length ? { tabStops: stops } : {};
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
    // (Text set over a picture keeps its colour: the picture is behind it.)
    const color = r.color && luminance(r.color) > 0.72 && !(behind && luminance(behind) < 0.55) && !r.onPic ? undefined : hex(r.color);
    if (color && color !== base.color) o.color = color;
    if (r.bg) o.shading = { type: this.d.ShadingType.CLEAR, color: "auto", fill: hex(r.bg) };
    // Tracked-out text keeps its letter-spacing (in twentieths of a point).
    if (r.track) o.characterSpacing = Math.round(r.track * 20);
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
      // Light colours show only on the dark background they were drawn on.
      const color = f.run?.color && (luminance(f.run.color) < 0.72 || (at.bg && luminance(at.bg) < 0.55)) ? hex(f.run.color) : undefined;
      const look = f.run ? { size: Math.round(f.run.size * 2), bold: f.run.bold, ...(color ? { color } : {}) } : {};
      // The item's text carries its own label (a clause number, options in a row).
      // No tab after the (empty) number either, or Word would move the text to the next tab stop.
      if (f.kind === "none") return { level: lvl, format: d.LevelFormat.NONE, text: "", suffix: d.LevelSuffix.NOTHING, alignment: d.AlignmentType.START, style: { paragraph: { indent } } };
      if (f.kind === "bullet" || f.kind === "check") {
        // Word's own bullet glyphs: a dot, "o" in Courier New for a ring, a small square, a dash, a check box.
        const [text, font] = f.kind === "check" ? ["\u2610", "Segoe UI Symbol"] : f.bullet === "◦" ? ["o", "Courier New"] : f.bullet === "▪" || f.bullet === "▫" ? ["\u25AA", "Segoe UI Symbol"] : f.bullet === "–" ? ["\u2013", undefined] : ["\u2022", undefined];
        // A face other than the text's sets its glyph a little smaller, so its taller line doesn't open up the list.
        const small = font ? { size: Math.round((f.run?.size ?? this.bs.size) * 1.6) } : {};
        return { level: lvl, format: d.LevelFormat.BULLET, text, alignment: d.AlignmentType.START, style: { paragraph: { indent }, run: { ...look, ...small, ...(font ? { font } : {}) } } };
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
      if (rule) {
        // Word draws the line `space` points below the text. Paragraphs with identical borders
        // merge into one bordered block (one line under the last), so neighbouring items get
        // colours one step apart.
        const below = l.multiple * l.factor * l.size - 1.12 * l.size;
        const space = Math.round(clamp(rule.at - below, 0, 30));
        if (gap !== undefined) after = Math.round(clamp(gap - rule.at - rule.h - 0.08 * (next ?? 0), 0, MAX_GAP) * 20);
        const color = i % 2 ? shade(hex(rule.color) ?? "000000", 1) : (hex(rule.color) ?? "000000");
        border = { bottom: { style: d.BorderStyle.SINGLE, size: Math.max(2, Math.round(rule.h * 8)), color, space } };
      }
      const spacing = big ? { ...this.spacing(l, after), line: Math.round(l.multiple * l.factor * l.size * 20), lineRule: d.LineRuleType.EXACT } : this.spacing(l, after);
      return new d.Paragraph({
        children: this.runs(it, this.body, at.bg),
        ...this.mark(l, this.body),
        ...this.tabStops(it, at.width),
        ...(b.align === "justify" ? { alignment: d.AlignmentType.JUSTIFIED } : {}),
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
  private cellParas(c: Cell | undefined, bg: string | undefined, width: number, leading?: number, keep?: boolean, below = 0): DocxOut[] {
    const d = this.d;
    const ps = c?.paras.length ? c.paras : [[]];
    return ps.map((p, pi) => {
      // A paragraph of one line in the PDF is set solid: its own spacing, not the spacing of longer cells.
      const l = this.linesOf(p, c?.geo ? c.geo.leadings[pi] : leading, true);
      const after = pi < ps.length - 1 ? this.after(l, c?.geo?.gaps[pi] ?? 2, c?.geo?.sizes[pi + 1]) : Math.round(below * 20);
      const alignment = c?.align === "right" ? d.AlignmentType.RIGHT : c?.align === "center" ? d.AlignmentType.CENTER : undefined;
      // A label with its text hanging after it (options in a grid).
      const hang = c?.hang ? { indent: { left: Math.round(c.hang * 20), hanging: Math.round(c.hang * 20) } } : c?.indent ? { indent: { left: Math.round(c.indent * 20) } } : {};
      return new d.Paragraph({ children: this.runs(p, this.body, bg), ...this.mark(l, this.body), ...this.tabStops(p, width), ...hang, spacing: this.spacing(l, after), keepNext: keep, alignment });
    });
  }

  private table(b: TableBlock, at: Where): DocxOut[] {
    const d = this.d;
    const cards = b.lines === "cards";
    // Cards keep the space between them: an empty column between neighbours, an empty row between rows.
    const cc = cards ? b.cardCols : undefined;
    const gapsX = cc && cc.length > 1 ? cc.slice(1).map((c, k) => c.x - (cc[k].x + cc[k].w)) : [];
    const spaced = !!cc && gapsX.length > 0 && gapsX.every((g) => g >= 3);
    type Slot = { w: number; ci?: number };
    // With no lines down the sides and no shading, text sits where the PDF has it: each column's
    // text at the column's start (the first set in by the table's inset), with the gap to the next
    // column after it.
    const open = !cards && b.lines !== "grid" && !b.cells.some((r) => r.some((c) => c?.fill));
    // Where the table sits: as in the PDF where it fits (an open table reaches the right edge).
    let indent = b.span ? Math.max(0, Math.round(b.span.x * 20)) : 0;
    let width = b.span ? Math.round(b.span.w * 20) : at.width;
    if (open || indent + width > at.width) width = at.width - indent;
    if (width < at.width * 0.3) [indent, width] = [0, at.width];
    // Content set side by side keeps its place on the page (a sidebar may reach into the margin).
    if (b.layout && !at.cell) [indent, width] = [Math.round((b.layout.x - this.layout.left) * 20), Math.round(b.layout.w * 20)];
    let slots: Slot[];
    if (spaced) {
      const span = cc[cc.length - 1].x + cc[cc.length - 1].w - cc[0].x;
      const k = at.width / span;
      slots = cc.flatMap((c, i): Slot[] => [{ w: Math.max(240, Math.round(c.w * k)), ci: i }, ...(i < gapsX.length ? [{ w: Math.max(40, Math.round(gapsX[i] * k)) }] : [])]);
    } else slots = b.widths.map((w, ci) => ({ w: Math.max(240, Math.round(w * width)), ci }));
    const cols = slots.map((sl) => sl.w);
    const lc = hex(b.lineColor) ?? "000000";
    const line = (color: string, size = 4) => ({ style: d.BorderStyle.SINGLE, size, color });
    const none = { style: d.BorderStyle.NONE, size: 0, color: "auto" };
    const all = (e: ReturnType<typeof line> | typeof none) => ({ top: e, bottom: e, left: e, right: e, insideHorizontal: e, insideVertical: e });
    // Lines as the PDF draws them: rules above and below rows (each in its colour), a full grid, or none.
    const rowRules = b.lines === "rows" ? b.rowRules : undefined;
    const borders = b.lines === "grid" ? all(line(lc)) : all(none);
    // Cell margins: the PDF's space around cell text, less what Word's taller lines already take.
    const l = this.cellLines(b);
    const below = l.multiple * l.factor * l.size - 1.12 * l.size;
    // Where a row's last line reaches further below its text than the row's padding, the next
    // row's padding above gives up the difference.
    const over = cards ? 0 : Math.round(Math.max(0, ...b.cells.map((_, ri) => this.overOf(b, ri))) * 20);
    const padX = Math.round((b.pad?.x ?? (cards ? 8 : 5)) * 20);
    const top = Math.round(clamp((b.pad?.y ?? 3) - 0.08 * l.size, 0, 30) * 20);
    const bottom = cards ? 0 : Math.round(clamp((b.pad?.y ?? 3) - below, 0, 30) * 20);
    const noEdges = { top: none, bottom: none, left: none, right: none };
    const marginsOf = (ci: number | undefined) =>
      open && ci !== undefined ? { top, bottom, left: ci === 0 ? Math.round((b.inset ?? 0) * 20) : 0, right: ci === r0.length - 1 ? 0 : padX } : undefined;
    const r0 = b.cells[0] ?? [];
    const empty = () => new d.Paragraph({ children: [], spacing: { before: 0, after: 0, line: 20, lineRule: d.LineRuleType.EXACT } });
    const spacer = (w: number) => new d.TableCell({ width: { size: w, type: d.WidthType.DXA }, borders: noEdges, margins: { top: 0, bottom: 0, left: 0, right: 0 }, children: [empty()] });
    const rows: InstanceType<DocxMod["TableRow"]>[] = [];
    // Content set side by side keeps its place, so each cell's left edge on the page is known.
    const slotX = (si: number) => (b.layout && !at.cell ? b.layout.x + slots.slice(0, si).reduce((a, sl) => a + sl.w, 0) / 20 : undefined);
    // A row of single lines (set solid): its padding below takes back only a solid line's room, and it runs no further below.
    const singles = b.cells.map((r) => !cards && r.every(solidEnd));
    b.cells.forEach((r, ri) => {
      const single = singles[ri];
      const rowSize = Math.max(0, ...r.flatMap((c) => c?.geo?.sizes ?? []));
      const solidBottom = single && rowSize ? Math.round(clamp((b.pad?.y ?? 3) - (this.linesOf([{ text: "x", bold: false, italic: false, size: rowSize }], undefined, true).factor - 1.12) * rowSize, 0, 30) * 20) : undefined;
      if (ri > 0 && (b.cardRowGaps?.[ri - 1] ?? 0) >= 3) {
        rows.push(new d.TableRow({ height: { value: Math.round(b.cardRowGaps![ri - 1] * 20), rule: d.HeightRule.EXACT }, children: [new d.TableCell({ columnSpan: slots.length, borders: noEdges, margins: { top: 0, bottom: 0, left: 0, right: 0 }, children: [empty()] })] }));
      }
      // Columns a spanning cell covers (a group's name across the table).
      const covered = new Set<number>();
      if (!spaced) r.forEach((c, ci) => Array.from({ length: (c?.span ?? 1) - 1 }, (_, k) => covered.add(ci + k + 1)));
      rows.push(
        new d.TableRow({
          tableHeader: ri < (b.head ?? (b.header ? 1 : 0)),
          cantSplit: !b.broken && r.every((c) => (c?.paras.length ?? 0) <= 6),
          // A sidebar as tall as in the PDF (no taller than the page's text area).
          ...(b.layout?.h && !at.cell ? { height: { value: Math.round(Math.min(b.layout.h, this.layout.height - this.layout.top - this.layout.bottom - 14) * 20), rule: d.HeightRule.ATLEAST } } : {}),
          children: slots.flatMap(({ w: w1, ci }, si) => {
            if (ci === undefined) return spacer(w1);
            if (covered.has(ci)) return [];
            const c = r[ci];
            const span = !spaced && c?.span && c.span > 1 ? Math.min(c.span, slots.length - si) : 1;
            const w = span > 1 ? slots.slice(si, si + span).reduce((a, sl) => a + sl.w, 0) : w1;
            const fill = c?.fill;
            const bg = fill ?? at.bg;
            // Word keeps a table on one page when every row but the last keeps with the next.
            const keep = b.keep && ri < b.cells.length - 1;
            const inner = w - (c?.margins ? Math.round((c.margins.left + c.margins.right) * 20) : padX * 2);
            const cx = slotX(si);
            const x0 = cx !== undefined ? cx + (c?.margins ? c.margins.left : padX / 20) : undefined;
            const nb = c?.blocks?.length ?? 0;
            const kids: DocxOut[] = nb ? content(c!.blocks!.flatMap((x, k) => this.block(x, { width: inner, bg, cell: true, x0, last: k === nb - 1 }))) : this.cellParas(c, bg, inner, b.leading, keep, b.rowSpace?.[ri] ?? 0);
            if (!(kids[kids.length - 1] instanceof d.Paragraph)) kids.push(this.stub());
            const under = nb ? this.below(c!.blocks![nb - 1]) : 0;
            const edge = c?.stroke ? line(hex(c.stroke) ?? "000000", 6) : undefined;
            const rule = (color?: string | null) => (color ? line(hex(color) ?? "000000", 6) : none);
            const cellBorders = cards && edge ? { top: edge, bottom: edge, left: edge, right: edge } : rowRules ? { top: rule(rowRules[ri]), bottom: ri === b.cells.length - 1 ? rule(rowRules[ri + 1]) : none, left: none, right: none } : undefined;
            const cm = c?.margins;
            let m = cm ? { top: Math.round(cm.top * 20), bottom: Math.round(cm.bottom * 20), left: Math.round(cm.left * 20), right: Math.round(cm.right * 20) } : marginsOf(ci);
            if (!cm && solidBottom !== undefined && solidBottom !== bottom) m = { ...(m ?? { top, bottom, left: padX, right: padX }), bottom: solidBottom };
            // A line drawn between rows sits in the space between them in the PDF; in Word it adds
            // its width to the row, so the row's padding gives that much up.
            const above = b.lines === "grid" ? 10 : rowRules?.[ri] ? 15 : 0;
            const beneath = ri === b.cells.length - 1 ? (b.lines === "grid" ? 10 : rowRules?.[ri + 1] ? 15 : 0) : 0;
            // A row as tall as a picture in it: the picture fills its line, with none of a line of text's room above or below.
            const pictured = !cm && !cards && r.some((x) => x?.paras.some((p) => p.some((run) => run.pic && run.pic.oh > l.size * 1.5)));
            const lift = ri > 0 && !cm && !pictured && !singles[ri - 1] ? over : 0;
            if (above || beneath || under || pictured || lift) {
              const base = m ?? { top, bottom, left: padX, right: padX };
              const py = Math.round((b.pad?.y ?? 3) * 20);
              m = { ...base, top: Math.max(0, (pictured ? py : base.top) - above - lift), bottom: Math.max(0, (pictured ? py : base.bottom) - beneath) + under };
            }
            return new d.TableCell({
              width: { size: w, type: d.WidthType.DXA },
              ...(span > 1 ? { columnSpan: span } : {}),
              ...(m ? { margins: m } : {}),
              ...(c?.valign ? { verticalAlign: c.valign === "center" ? d.VerticalAlignTable.CENTER : d.VerticalAlignTable.BOTTOM } : {}),
              children: kids,
              ...(fill ? { shading: { type: d.ShadingType.CLEAR, color: "auto", fill: hex(fill) } } : {}),
              ...(cellBorders ? { borders: cellBorders } : {}),
            });
          }),
        }),
      );
    });
    return [
      new d.Table({
        width: { size: cols.reduce((a, c) => a + c, 0), type: d.WidthType.DXA },
        columnWidths: cols,
        layout: d.TableLayoutType.FIXED,
        ...(indent ? { indent: { size: indent, type: d.WidthType.DXA } } : {}),
        borders,
        margins: { top, bottom, left: padX, right: padX },
        rows,
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
    const x0 = b.geo?.left !== undefined ? b.geo.left + padX / 20 : undefined;
    const n = b.blocks.length;
    const kids = content(b.blocks.flatMap((x, k) => this.block(x, { width: at.width - padX * 2, bg: b.fill ?? at.bg, cell: true, x0, last: k === n - 1 })));
    if (!(kids[kids.length - 1] instanceof d.Paragraph)) kids.push(this.stub());
    const under = this.below(b.blocks[n - 1]);
    return [
      new d.Table({
        width: { size: at.width, type: d.WidthType.DXA },
        columnWidths: [at.width],
        layout: d.TableLayoutType.FIXED,
        borders: { top: edge, bottom: edge, left: edge, right: edge, insideHorizontal: none, insideVertical: none },
        rows: [
          new d.TableRow({
            // On one page, as in the PDF, unless it takes up most of one.
            cantSplit: !b.broken && (b.geo ? b.geo.bottom - b.geo.top < (this.layout.height - this.layout.top - this.layout.bottom) * 0.6 : kids.length <= 10),
            children: [
              new d.TableCell({
                width: { size: at.width, type: d.WidthType.DXA },
                // The last paragraph's spacing reaches down to the box's edge, so no bottom margin.
                margins: { top: Math.round(clamp((b.pad?.y ?? 8) - 0.08 * first, 0, 30) * 20), bottom: under, left: padX, right: padX },
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
  const look = { size: Math.round(line.size * 2), bold: line.bold, italics: !!line.italic, font: wordFont(line.face, line.family), ...(color ? { color } : {}) };
  const children: InstanceType<DocxMod["TextRun"]>[] = [];
  let stop = 0;
  for (const p of line.parts) {
    const want = p.at === "left" ? 0 : p.at === "center" ? 1 : has("center") ? 2 : 1;
    const tabs: (InstanceType<DocxMod["Tab"]> | string)[] = [];
    for (; stop < want; stop++) tabs.push(new d.Tab());
    if (children.length && !tabs.length) tabs.push(" ");
    if (tabs.length) children.push(new d.TextRun({ ...look, children: tabs as never }));
    // Each page-number field in a run of its own, so every reader gives it the line's look.
    for (const t of p.text.split(/(\{PAGE\}|\{PAGES\})/).filter(Boolean)) {
      children.push(new d.TextRun({ ...look, children: [t === "{PAGE}" ? d.PageNumber.CURRENT : t === "{PAGES}" ? d.PageNumber.TOTAL_PAGES : t] as never }));
    }
  }
  return new d.Paragraph({ children, tabStops, spacing: { before: 0, after: 0 } });
}

/**
 * Page-number fields written the way Word writes them: each part (begin, code, separator,
 * result, end) in a run of its own with the line's formatting, and a result to show until
 * the reader counts the pages. Readers that find no result set the number in their default
 * size instead of the line's.
 */
function fieldRuns(xml: string, pages: number): string {
  return xml.replace(/<w:r>(<w:rPr>[\s\S]*?<\/w:rPr>)?([\s\S]*?)<\/w:r>/g, (all, rpr: string | undefined, body: string) => {
    if (!body.includes("<w:fldChar")) return all;
    const parts = body.match(/<w:fldChar [^>]*\/>|<w:instrText[^>]*>[^<]*<\/w:instrText>|<w:t[ >][^<]*<\/w:t>|<w:tab\/>/g) ?? [];
    let code = "";
    let out = "";
    for (const q of parts) {
      if (q.startsWith("<w:instrText")) code = q;
      if (q.includes('"end"') && out.endsWith('"separate"/></w:r>')) out += `<w:r>${rpr ?? ""}<w:t>${/NUMPAGES|SECTIONPAGES/.test(code) ? pages : 1}</w:t></w:r>`;
      out += `<w:r>${rpr ?? ""}${q}</w:r>`;
    }
    return out;
  });
}

/** The document split into sections where the number of text columns changes. */
function sectionsOf(d: DocxMod, children: (DocxOut | Columns)[], layout: PageLayout, furniture?: Furniture, images = new Map<string, ExtractedImage>()) {
  const parts: { count: number; space?: number; children: DocxOut[] }[] = [{ count: 1, children: [] }];
  for (const c of children) {
    if (c instanceof Columns) {
      if (!parts[parts.length - 1].children.length) parts.pop();
      parts.push({ count: c.count, space: c.space, children: [] });
    } else parts[parts.length - 1].children.push(c);
  }
  // A section set in columns needs one after it, or Word won't balance its columns.
  if (parts[parts.length - 1].count > 1) parts.push({ count: 1, children: [] });
  for (const p of parts) if (p.count === 1 && !p.children.length) p.children.push(new d.Paragraph({ children: [], spacing: { before: 0, after: 0, line: 20, lineRule: d.LineRuleType.EXACT } }));
  const used = parts.filter((p) => p.children.length);
  // Running header and footer on the first section; later sections carry them on.
  const width = Math.round((layout.width - layout.left - layout.right) * 20);
  // Running pictures (a logo in the letterhead) stay where they are on the page, over nothing else.
  const floats = (at: "header" | "footer") => {
    const runs = (furniture?.pics ?? []).filter((x) => x.at === at).flatMap(({ pic }) => picRun(d, pic, images.get(pic.id), 1, { mode: "over" }) ?? []);
    return runs.length ? [new d.Paragraph({ children: runs, spacing: { before: 0, after: 0, line: 20, lineRule: d.LineRuleType.EXACT } })] : [];
  };
  const heads = [...floats("header"), ...(furniture?.header ?? []).map((l) => furnitureParagraph(d, l, width))];
  const feet = [...(furniture?.footer ?? []).map((l) => furnitureParagraph(d, l, width)), ...floats("footer")];
  const header = heads.length ? { headers: { default: new d.Header({ children: heads }) } } : {};
  const footer = feet.length ? { footers: { default: new d.Footer({ children: feet }) } } : {};
  // Header and footer where the PDF has them, inside the page margins; where the margin is too
  // narrow for that (a slide's number beside the text at its foot), nearer the page's edge, as a
  // footer reaching into the text would push the text up and on to another page.
  const page = pageSetup(d, layout);
  const fit = (lines: FurnitureLine[] | undefined, margin: number) => {
    if (!lines?.length) return undefined;
    const room = Math.max(2, margin - lines.reduce((n, l) => n + l.size * 1.25, 0));
    return Math.round(clamp(Math.min(...lines.map((l) => l.edge)), Math.min(12, room), room) * 20);
  };
  const hd = fit(furniture?.header, layout.top);
  const fd = fit(furniture?.footer, Math.max(0, layout.bottom - 4));
  const margin = { ...page.margin, ...(hd !== undefined ? { header: hd } : {}), ...(fd !== undefined ? { footer: fd } : {}) };
  return (used.length ? used : [{ count: 1, children: [new d.Paragraph({ children: [] })] }]).map((p, i) => ({
    ...(i === 0 ? { ...header, ...footer } : {}),
    properties: {
      page: { ...page, margin },
      ...(i > 0 ? { type: d.SectionType.CONTINUOUS } : {}),
      ...(p.count > 1 ? { column: { count: p.count, space: p.space ?? 360, equalWidth: true } } : {}),
    },
    children: p.children as never[],
  }));
}

/** Word page size and margins (twips) for a PDF page layout. Landscape pages are given short side first, as docx expects. */
function pageSetup(d: DocxMod, l: PageLayout) {
  const tw = (pt: number) => Math.round(pt * 20);
  const landscape = l.width > l.height;
  // (A few points more room at the foot than the PDF's lowest text needs: lines Word sets a
  // little lower than the PDF did still fit on their page.)
  const bottom = Math.max(0, l.bottom - 4);
  return {
    size: { width: tw(Math.min(l.width, l.height)), height: tw(Math.max(l.width, l.height)), orientation: landscape ? d.PageOrientation.LANDSCAPE : d.PageOrientation.PORTRAIT },
    margin: { top: tw(l.top), right: tw(l.right), bottom: tw(bottom), left: tw(l.left), header: tw(Math.min(36, l.top / 2)), footer: tw(Math.min(36, bottom / 2)) },
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
  let furniture: Furniture = { header: [], footer: [] };
  let images = new Map<string, ExtractedImage>();
  let pageCount = 1;
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
    const r = await readStructured(src, onProgress, { images: o.images !== false });
    const { blocks, body } = r;
    layout = r.layout;
    furniture = r.furniture;
    images = r.images;
    pageCount = r.pages.length;
    const contentWidth = Math.round((layout.width - layout.left - layout.right) * 20);
    // Pictures go where the page has them; any whose place couldn't be read, at the end of their page.
    const imgs = unplaced(r.images, r.pages, r.unread);
    const w = new WordWriter(d, body, blocks, layout, r.images);
    let page = 0;
    const pushImgs = (p: number) => {
      for (const im of imgs.get(p) ?? []) {
        const iw = Math.min(560, im.width * 0.75);
        children.push(new d.Paragraph({ children: [new d.ImageRun({ type: im.mime === "image/png" ? "png" : "jpg", data: im.bytes, transformation: { width: iw, height: (iw * im.height) / im.width } })] }));
      }
    };
    let breakNext = false;
    let top = true;
    for (const b of blocks) {
      if (b.kind === "pagebreak") {
        pushImgs(page);
        page = b.page;
        // Only breaks the author made; where a page simply filled up, the text flows on.
        breakNext = o.pageBreaks !== false && b.deliberate !== false;
        continue;
      }
      // The first block on a page starts as far down as it does in the PDF: below an empty
      // paragraph that tall (readers drop the space before a paragraph at the top of a page).
      const g = "geo" in b ? b.geo : undefined;
      const lead = (top || breakNext) && g ? g.top - 0.08 * g.first - layout.top : 0;
      if (lead >= 1) {
        children.push(new d.Paragraph({ children: [], pageBreakBefore: breakNext, spacing: { before: 0, after: 0, line: Math.round(lead * 20), lineRule: d.LineRuleType.EXACT } }));
        breakNext = false;
      }
      const out = w.block(b, { width: contentWidth, pageBreak: breakNext, x0: layout.left });
      if (out.length || lead >= 1) breakNext = top = false;
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
    sections: sectionsOf(d, children, layout, furniture, images),
  });
  let bytes: Uint8Array = new Uint8Array(await (await d.Packer.toBlob(doc)).arrayBuffer());
  const zip = await JSZip.loadAsync(bytes);
  let changed = false;
  // The paragraphs docx adds to end each section (columns) take no room.
  const xml = await zip.file("word/document.xml")?.async("string");
  if (xml?.includes("<w:p><w:pPr><w:sectPr>")) {
    zip.file("word/document.xml", xml.replaceAll("<w:p><w:pPr><w:sectPr>", '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:sectPr>'));
    changed = true;
  }
  for (const f of zip.file(/^word\/(header|footer)\d*\.xml$/)) {
    const x = await f.async("string");
    if (!x.includes("<w:fldChar")) continue;
    zip.file(f.name, fieldRuns(x, pageCount));
    changed = true;
  }
  if (changed) bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return {
    filename: `${name}.docx`,
    bytes,
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    note: o.mode === "exact" ? "Pages as images (looks identical, not editable)" : "Editable text with headings, lists and tables",
  };
}

/* ---------------------------------------------------------- excel / csv */

export async function pdfToExcel(src: Src, o: { oneSheet?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const [{ sheetsOf }, { writeXlsx }] = await Promise.all([import("./tosheet"), import("./xlsx")]);
  const r = await readStructured(src, onProgress);
  const font = wordFont(r.body.face, r.body.family);
  const name = stem(src.name);
  const sheets = sheetsOf(r.blocks, r.body, r.furniture, { oneSheet: o.oneSheet, name, font, fontOf: wordFont, landscape: r.layout.width > r.layout.height, letter: Math.abs(Math.min(r.layout.width, r.layout.height) - 612) < 4 });
  const bytes = writeXlsx(sheets, { font, size: 10, title: name });
  return {
    filename: `${name}.xlsx`,
    bytes,
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    note: o.oneSheet ? "All pages on one sheet" : `${sheets.length} sheet${sheets.length === 1 ? "" : "s"}, one per page`,
  };
}

export async function pdfToCsv(src: Src, onProgress?: ProgressFn): Promise<OutFile> {
  const { sheetsOf, csvValue } = await import("./tosheet");
  const r = await readStructured(src, onProgress);
  const font = wordFont(r.body.face, r.body.family);
  // Everything on one sheet (a table carried across pages is one table), as plain values:
  // figures without grouping, dates as year-month-day.
  const [sheet] = sheetsOf(r.blocks, r.body, r.furniture, { oneSheet: true, name: stem(src.name), font, fontOf: wordFont });
  const field = (c: string) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  const lines = sheet.rows.map((row) => {
    const cells = row.map((c) => (c ? csvValue(c) : ""));
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    return cells.map(field).join(",");
  });
  return { filename: `${stem(src.name)}.csv`, bytes: new TextEncoder().encode("﻿" + lines.join("\r\n") + "\r\n"), mime: "text/csv" };
}

/* ---------------------------------------------------------------- pptx */

export async function pdfToPptx(src: Src, o: { mode?: "editable" | "exact"; notes?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const [{ writePptx }, { slideTexts }] = await Promise.all([import("./pptxwrite"), import("./toslides")]);
  const exact = o.mode === "exact";
  const measure = exact ? undefined : measurer();
  const slides: PSlide[] = [];
  const media: PMedia[] = [];
  const faces = new Map<string, { chars: number; big: number }>();
  let W = 0;
  let H = 0;
  let pictures = 0;
  let recognised = 0;
  await withPdfjs(
    src.bytes,
    async ({ pdf, pageCount }) => {
      for (let i = 1; i <= pageCount; i++) {
        onProgress?.(i / pageCount, `Slide ${i} of ${pageCount}`);
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        if (i === 1) {
          // The slides take the first page's size (PowerPoint allows 1 to 56 inches a side).
          const s = Math.min(1, 4032 / Math.max(vp.width, vp.height));
          W = Math.max(72, vp.width * s);
          H = Math.max(72, vp.height * s);
        }
        // Pages of another size are fitted in, centred.
        const k = Math.min(W / vp.width, H / vp.height);
        const fit = { x: (W - vp.width * k) / 2, y: (H - vp.height * k) / 2, w: vp.width * k, h: vp.height * k };
        const fills = fit.x < 0.5 && fit.y < 0.5;
        const pt = await pageText(page);
        const slide: PSlide = { items: [] };
        let canvas: HTMLCanvasElement;
        if (exact) {
          canvas = await renderPage(page, 2, { snap: true });
          media.push({ bytes: await canvasToBytes(canvas, "image/jpeg", 0.88), ext: "jpeg" });
          slide.items.push({ kind: "pic", ...fit, media: media.length - 1, name: `Page ${i}` });
          if (o.notes !== false) {
            const notes = linesToText(toLines(pt)).slice(0, 8000);
            if (notes.trim()) slide.notes = notes;
          }
        } else {
          const shapes = await enrichFontStyles(page, pt.items);
          await sampleColours(page, pt);
          const { texts, erase } = slideTexts(pt, shapes, { fontOf: wordFont, links: await pageLinks(page), measure });
          if (!texts.length) {
            pictures++;
            // A scan with recognised text (OCR) can't have its text on the slide: it goes in the notes.
            const ocr = linesToText(toLines(pt)).slice(0, 8000);
            if (ocr.trim()) {
              slide.notes = ocr;
              recognised++;
            }
          }
          // Pictures that stand on their own come off the page, to move or replace.
          const loose: PPic[] = [];
          const taken: LoosePicture[] = [];
          if (texts.length)
            for (const p of await loosePictures(page)) {
              const c = await pictureCanvas(page, p.id);
              if (!c) continue;
              media.push(await imageOf(c));
              c.width = c.height = 0;
              taken.push(p);
              loose.push({ kind: "pic", x: fit.x + p.x * k, y: fit.y + p.y * k, w: p.w * k, h: p.h * k, media: media.length - 1, name: `Picture ${loose.length + 1}`, ...(p.crop ? { crop: p.crop } : {}) });
            }
          // The page without its text (the text goes on top, editable); a page with none stays whole.
          const scale = Math.min(2, 2400 / Math.max(vp.width, vp.height));
          canvas = await renderPage(page, scale, { text: texts.length ? false : undefined, erase, snap: true, skip: taken, readback: true });
          const plain = plainColour(canvas);
          if (plain && fills) {
            if (plain !== "FFFFFF") slide.background = { color: plain };
          } else {
            media.push(await pictureOf(canvas));
            if (fills) slide.background = { media: media.length - 1 };
            else slide.items.push({ kind: "pic", ...fit, media: media.length - 1, name: `Page ${i}` });
          }
          slide.items.push(...loose);
          for (const t of texts) {
            const placed = k === 1 && !fit.x && !fit.y ? t : scaled(t, k, fit.x, fit.y);
            slide.items.push(placed);
            for (const p of placed.paras)
              for (const r of p.runs) {
                const f = faces.get(r.face ?? "") ?? { chars: 0, big: 0 };
                f.chars += r.text.length;
                if (r.size >= 24) f.big += r.text.length;
                faces.set(r.face ?? "", f);
              }
          }
        }
        page.cleanup();
        canvas.width = canvas.height = 0;
        slides.push(slide);
        await tick();
      }
    },
    src.password,
  );
  // New text added to these slides starts in the deck's own faces.
  const byUse = [...faces.entries()].filter(([f]) => f);
  const minor = byUse.sort((a, b) => b[1].chars - a[1].chars)[0]?.[0];
  const major = byUse.sort((a, b) => b[1].big - a[1].big)[0];
  const bytes = writePptx({ width: W, height: H, slides, media, title: stem(src.name), fonts: minor ? { minor, major: major && major[1].big ? major[0] : minor } : undefined });
  const n = slides.length;
  let note = exact ? (o.notes !== false ? "One slide per page, page text in speaker notes" : "One slide per page") : "One slide per page, with editable text";
  if (!exact && pictures) {
    note =
      pictures === n
        ? `${n === 1 ? "The page has" : "The pages have"} no text to edit (a scan, or a picture), so each slide is a picture of its page`
        : `${note}. ${pictures} page${pictures === 1 ? " has" : "s have"} no text to edit (a scan, or a picture), so ${pictures === 1 ? "its slide is a picture" : "their slides are pictures"}`;
    if (recognised) note += ", with the recognised text in the speaker notes";
  }
  return {
    filename: `${stem(src.name)}.pptx`,
    bytes,
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    note,
  };
}

/**
 * Widths of text in the faces the slides name, measured with the fonts installed here (most
 * likely the computer that opens the slides). Faces not installed can't be measured.
 */
function measurer(): ((r: PRun, text: string) => number | undefined) | undefined {
  const ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!ctx) return undefined;
  const installed = new Map<string, boolean>();
  const has = (face: string) => {
    let v = installed.get(face);
    if (v === undefined) {
      // An installed face sets this probe differently from at least one of the generic faces.
      const probe = "mmmmmmmmmmlli1WQ@#0123456789 abcdefghijklmnopqrstuvwxyz";
      v = ["monospace", "serif", "sans-serif"].some((g) => {
        ctx.font = `40px ${g}`;
        const a = ctx.measureText(probe).width;
        ctx.font = `40px "${face.replace(/"/g, "")}", ${g}`;
        return Math.abs(ctx.measureText(probe).width - a) > 0.5;
      });
      installed.set(face, v);
    }
    return v;
  };
  return (r, text) => {
    if (!r.face || !has(r.face)) return undefined;
    ctx.font = `${r.italic ? "italic " : ""}${r.bold ? "bold " : ""}40px "${r.face.replace(/"/g, "")}"`;
    return (ctx.measureText(text).width / 40) * r.size;
  };
}

/**
 * Colours of text the PDF paints in a colour that can't be read without drawing it (a spot
 * colour, a pattern, a gradient seen through lettering): taken from the page drawn with and
 * without its text, as the colour of the pixels the text changes most. Text that changes
 * nothing gets the colour under it.
 */
async function sampleColours(page: PDFPageProxy, pt: PageText) {
  // (Text that clips shows what's painted through it, a gradient say: its own colour isn't what shows.)
  const unknown = pt.items.filter((it) => (!it.color || (it.mode ?? 0) >= 4) && it.str.trim() && it.mode !== 3);
  if (!unknown.length) return;
  const k = 1.5;
  const [withText, without] = [await renderPage(page, k, { readback: true }), await renderPage(page, k, { text: false, readback: true })];
  try {
    const a = withText.getContext("2d", { willReadFrequently: true });
    const b = without.getContext("2d", { willReadFrequently: true });
    if (!a || !b) return;
    const hex2 = (r: number, g: number, bl: number) => "#" + [r, g, bl].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    for (const it of unknown) {
      const x = Math.max(0, Math.floor(it.bbox.x * k));
      const y = Math.max(0, Math.floor(it.bbox.y * k));
      const w = Math.min(withText.width - x, Math.ceil(it.bbox.w * k));
      const h = Math.min(withText.height - y, Math.ceil(it.bbox.h * k));
      if (w <= 0 || h <= 0) continue;
      const p = a.getImageData(x, y, w, h).data;
      const q = b.getImageData(x, y, w, h).data;
      let most = 0;
      const diff = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        diff[i] = Math.abs(p[i * 4] - q[i * 4]) + Math.abs(p[i * 4 + 1] - q[i * 4 + 1]) + Math.abs(p[i * 4 + 2] - q[i * 4 + 2]);
        most = Math.max(most, diff[i]);
      }
      if (most < 24) {
        it.color = hex2(q[0], q[1], q[2]);
        continue;
      }
      // The glyphs' solid middles: pixels changed by more than half the most.
      const rs: number[] = [];
      const gs: number[] = [];
      const bs: number[] = [];
      for (let i = 0; i < w * h; i++)
        if (diff[i] >= most * 0.6) {
          rs.push(p[i * 4]);
          gs.push(p[i * 4 + 1]);
          bs.push(p[i * 4 + 2]);
        }
      const mid = (v: number[]) => v.sort((m, n) => m - n)[Math.floor(v.length / 2)];
      it.color = hex2(mid(rs), mid(gs), mid(bs));
    }
  } finally {
    withText.width = withText.height = without.width = without.height = 0;
  }
}

/** A text box moved and scaled with its page (a page fitted into a slide of another size). */
function scaled(t: PText, k: number, dx: number, dy: number): PText {
  return {
    ...t,
    x: dx + t.x * k,
    y: dy + t.y * k,
    w: t.w * k,
    h: t.h * k,
    paras: t.paras.map((p) => ({
      ...p,
      ...(p.spacing && "pts" in p.spacing ? { spacing: { pts: p.spacing.pts * k } } : {}),
      ...(p.before ? { before: p.before * k } : {}),
      ...(p.marL !== undefined ? { marL: p.marL * k } : {}),
      ...(p.indent !== undefined ? { indent: p.indent * k } : {}),
      runs: p.runs.map((r) => ({ ...r, size: Math.round(r.size * k * 20) / 20, ...(r.spc ? { spc: r.spc * k } : {}) })),
    })),
  };
}

/** The colour a picture is filled with, as RRGGBB, when it is one colour throughout. */
function plainColour(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !canvas.width || !canvas.height) return null;
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const [r, g, b] = [d[0], d[1], d[2]];
  for (let i = 0; i < d.length; i += 4 * 3) if (Math.abs(d[i] - r) > 2 || Math.abs(d[i + 1] - g) > 2 || Math.abs(d[i + 2] - b) > 2) return null;
  return ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0").toUpperCase();
}

/** A picture from the page: PNG where it has see-through parts or flat colour (logos, diagrams), JPEG for photos. */
async function imageOf(canvas: HTMLCanvasElement): Promise<PMedia> {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let alpha = false;
  if (ctx) {
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) {
      alpha = true;
      break;
    }
  }
  const png = await canvasToBytes(canvas, "image/png");
  if (alpha) return { bytes: png, ext: "png" };
  const jpeg = await canvasToBytes(canvas, "image/jpeg", 0.92);
  return png.length <= jpeg.length * 1.1 ? { bytes: png, ext: "png" } : { bytes: jpeg, ext: "jpeg" };
}

/** A page picture: PNG, sharp and true to colour, unless JPEG is much smaller (photos). */
async function pictureOf(canvas: HTMLCanvasElement): Promise<PMedia> {
  const png = await canvasToBytes(canvas, "image/png");
  if (png.length < 160_000) return { bytes: png, ext: "png" };
  const jpeg = await canvasToBytes(canvas, "image/jpeg", 0.9);
  return png.length <= jpeg.length * 2 ? { bytes: png, ext: "png" } : { bytes: jpeg, ext: "jpeg" };
}

/* ---------------------------------------------------------------- epub */

export async function pdfToEpub(src: Src, o: { title?: string; author?: string } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  // Pictures (and charts drawn with shapes) where the pages have them, as files beside the chapters.
  const { blocks, images, body } = await readStructured(src, onProgress, { images: true });
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
  const files = new Map<string, { path: string; im: ExtractedImage }>();
  const fileOf = (im: ExtractedImage) => {
    let f = files.get(im.ref);
    if (!f) files.set(im.ref, (f = { path: `images/picture${files.size + 1}.${im.mime === "image/png" ? "png" : "jpg"}`, im }));
    return f.path;
  };
  // XHTML: empty elements close themselves.
  const toX = (bs: SBlock[]) =>
    blocksToHtml(bs, new Map(), { pics: images, body: body.size, src: fileOf })
      .replace(/<br>/g, "<br/>")
      .replace(/<hr([^>]*)>/g, "<hr$1/>")
      .replace(/<img([^>]*?)\s*\/?>/g, "<img$1/>");
  zip.file("OEBPS/style.css", `body{font-family:serif;line-height:1.5;margin:0 5%}h1,h2,h3{font-family:sans-serif;line-height:1.2}${BLOCK_CSS}`);
  chapters.forEach((ch, i) => zip.file(`OEBPS/ch${i + 1}.xhtml`, xhtml(ch.title, `${i === 0 || !ch.blocks.some((b) => b.kind === "heading") ? `<h1>${esc(ch.title)}</h1>` : ""}${toX(ch.blocks)}`)));
  for (const f of files.values()) zip.file(`OEBPS/${f.path}`, f.im.bytes);
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
    ...[...files.values()].map((f, i) => `<item id="pic${i + 1}" href="${f.path}" media-type="${f.im.mime}"/>`),
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
