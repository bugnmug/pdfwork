/**
 * A small HTML → PDF typesetter.
 *
 * Word (via mammoth), Markdown, HTML and EPUB chapters all become HTML, and
 * this turns that HTML into real PDF text (selectable, searchable, Unicode):
 * headings with bookmarks, bold/italic/underline/strike/code/links, nested and
 * numbered lists, block quotes, code blocks, images, horizontal rules, and
 * tables with content-aware column widths, wrapped cells, rows that can break
 * across pages and header rows repeated on each page.
 */
import { PDFArray, PDFName, PDFString } from "@cantoo/pdf-lib";
import { embedImage, hexToRgb, newDoc, saveDoc, type PDFDocument, type PDFPage, type RGB, type ProgressFn, tick } from "./core";
import { FontSet, graphemes, type Family, type TextStyle } from "./fonts";
import { setOutline, type OutlineEntry } from "./outline";

export type Style = {
  family: Family;
  bold: boolean;
  italic: boolean;
  size: number;
  color: RGB;
  underline?: boolean;
  strike?: boolean;
  link?: string;
  bg?: RGB;
  shift?: number; // baseline shift (sup/sub), in points
};

type Atom = { text: string; style: Style; space: boolean } | { br: true; style: Style };

type Align = "left" | "center" | "right" | "justify";

type ParaBlock = {
  kind: "para";
  atoms: Atom[];
  align: Align;
  indent: number;
  before: number;
  after: number;
  heading?: number;
  marker?: { text: string; style: Style };
  pre?: boolean;
  bar?: boolean;
  bg?: RGB;
};
type ImageBlock = { kind: "image"; src: string; width?: number; height?: number; indent: number; align: Align; alt?: string };
type TableBlock = { kind: "table"; rows: Cell[][]; headerRows: number; indent: number; borders: boolean };
type Cell = { blocks: Block[]; colspan: number; rowspan: number; header: boolean; bg?: RGB };
type Block = ParaBlock | ImageBlock | TableBlock | { kind: "hr" } | { kind: "pagebreak" } | { kind: "space"; h: number };

export type LayoutOpts = {
  pageSize?: [number, number];
  margin?: number | { top: number; right: number; bottom: number; left: number };
  baseSize?: number;
  family?: Family;
  lineHeight?: number;
  pageNumbers?: boolean;
  bookmarks?: boolean;
  title?: string;
  author?: string;
  /** Resolve <img src> to bytes (data: URIs are handled automatically). */
  resolveImage?: (src: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
  onProgress?: ProgressFn;
};

const LINK = hexToRgb("#1d4ed8");
const MUTED = hexToRgb("#555555");
const RULE = hexToRgb("#c8c8c8");
const CODE_BG = hexToRgb("#f2f2f2");
const TABLE_HEAD_BG = hexToRgb("#f0f0f0");

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "figure", "figcaption",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "pre", "table",
  "hr", "address", "center", "body", "html", "details", "summary", "form", "fieldset",
]);

/* ------------------------------------------------------------------ parse */

type Ctx = { style: Style; indent: number; align: Align; pre: boolean; listDepth: number; quote: number };

export function htmlToBlocks(html: string, base: Style): Block[] {
  const dom = new DOMParser().parseFromString(html, "text/html");
  dom.querySelectorAll("script, style, noscript, template, head, title, meta, link").forEach((n) => n.remove());
  const blocks: Block[] = [];
  walk(dom.body, { style: base, indent: 0, align: "left", pre: false, listDepth: 0, quote: 0 }, blocks);
  return blocks;
}

function styleFrom(el: Element, s: Style): Style {
  const tag = el.tagName.toLowerCase();
  const next: Style = { ...s };
  if (["b", "strong", "th"].includes(tag)) next.bold = true;
  if (["i", "em", "cite", "var", "dfn"].includes(tag)) next.italic = true;
  if (["u", "ins"].includes(tag)) next.underline = true;
  if (["s", "del", "strike"].includes(tag)) next.strike = true;
  if (["code", "kbd", "samp", "tt"].includes(tag)) next.family = "mono";
  if (tag === "mark") next.bg = hexToRgb("#fff3a3");
  if (tag === "small") next.size = s.size * 0.85;
  if (tag === "big") next.size = s.size * 1.15;
  if (tag === "sup" || tag === "sub") {
    next.size = s.size * 0.72;
    next.shift = tag === "sup" ? s.size * 0.35 : -s.size * 0.15;
  }
  if (tag === "a") {
    const href = el.getAttribute("href");
    if (href && /^(https?:|mailto:|tel:)/i.test(href)) {
      next.link = href;
      next.color = LINK;
      next.underline = true;
    }
  }
  const css = (el as HTMLElement).style;
  if (css) {
    const fw = css.fontWeight;
    if (fw === "bold" || Number(fw) >= 600) next.bold = true;
    else if (fw === "normal" || (Number(fw) > 0 && Number(fw) < 600)) next.bold = false;
    if (css.fontStyle === "italic" || css.fontStyle === "oblique") next.italic = true;
    if (/underline/.test(css.textDecoration)) next.underline = true;
    if (/line-through/.test(css.textDecoration)) next.strike = true;
    if (css.color) {
      const c = cssColor(css.color);
      if (c) next.color = c;
    }
    if (css.backgroundColor) {
      const c = cssColor(css.backgroundColor);
      if (c) next.bg = c;
    }
    if (css.fontFamily) {
      if (/mono|courier|consolas|menlo/i.test(css.fontFamily)) next.family = "mono";
      else if (/serif|times|georgia|garamond|cambria|book/i.test(css.fontFamily) && !/sans/i.test(css.fontFamily)) next.family = "serif";
      else if (/sans|arial|helvetica|calibri|verdana|segoe|roboto|inter/i.test(css.fontFamily)) next.family = "sans";
    }
    const fs = parseCssSize(css.fontSize, s.size);
    if (fs) next.size = fs;
  }
  return next;
}

function parseCssSize(v: string, base: number): number | null {
  if (!v) return null;
  const m = v.match(/^([\d.]+)(px|pt|em|rem|%)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const size = m[2] === "px" ? n * 0.75 : m[2] === "pt" ? n : m[2] === "%" ? (base * n) / 100 : n * base;
  return Math.max(5, Math.min(72, size));
}

function cssColor(v: string): RGB | null {
  if (!v || v === "inherit" || v === "transparent" || v === "initial") return null;
  if (v.startsWith("#")) return hexToRgb(v);
  const m = v.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?/);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return hexToRgb("#" + [m[1], m[2], m[3]].map((x) => Math.round(Number(x)).toString(16).padStart(2, "0")).join(""));
  }
  return null;
}

function alignOf(el: Element, inherited: Align): Align {
  const a = ((el as HTMLElement).style?.textAlign || el.getAttribute("align") || "").toLowerCase();
  if (a === "center" || a === "right" || a === "justify" || a === "left") return a;
  if (el.tagName.toLowerCase() === "center") return "center";
  return inherited;
}

function headingSize(level: number, base: number) {
  return [0, 2.0, 1.55, 1.27, 1.12, 1.0, 0.92][level] * base;
}

function walk(node: Node, ctx: Ctx, out: Block[]) {
  let para: ParaBlock | null = null;
  const flush = () => {
    if (para && para.atoms.some((a) => "br" in a || a.text.trim())) out.push(para);
    para = null;
  };
  const current = (): ParaBlock => {
    if (!para) para = { kind: "para", atoms: [], align: ctx.align, indent: ctx.indent, before: 0, after: ctx.style.size * 0.55, pre: ctx.pre, bar: ctx.quote > 0 };
    return para;
  };
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      pushText(current(), child.textContent ?? "", ctx.style, ctx.pre);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if ((el as HTMLElement).style?.display === "none" || el.hasAttribute("hidden")) continue;
    if ((el as HTMLElement).style?.pageBreakBefore === "always" || (el as HTMLElement).style?.breakBefore === "page") {
      flush();
      out.push({ kind: "pagebreak" });
    }
    if (tag === "br") {
      current().atoms.push({ br: true, style: ctx.style });
      continue;
    }
    if (tag === "img") {
      const src = el.getAttribute("src") || "";
      if (!src) continue;
      const w = parseFloat(el.getAttribute("width") || "") || parseCssSize((el as HTMLElement).style?.width || "", 0) || undefined;
      const h = parseFloat(el.getAttribute("height") || "") || undefined;
      flush();
      out.push({ kind: "image", src, width: w ? w * 0.75 : undefined, height: h ? h * 0.75 : undefined, indent: ctx.indent, align: ctx.align === "justify" ? "left" : ctx.align, alt: el.getAttribute("alt") || "" });
      continue;
    }
    if (tag === "svg" || tag === "canvas" || tag === "video" || tag === "audio" || tag === "iframe" || tag === "object") continue;
    if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button") {
      const v = (el as HTMLInputElement).value || el.getAttribute("value") || el.textContent || "";
      if ((el as HTMLInputElement).type === "checkbox") pushText(current(), (el as HTMLInputElement).checked ? "☑ " : "☐ ", ctx.style, false);
      else if (v) pushText(current(), `[${v}] `, ctx.style, false);
      continue;
    }
    if (!BLOCK_TAGS.has(tag)) {
      // Inline element: recurse with a derived style, keeping the same paragraph.
      const inner: Ctx = { ...ctx, style: styleFrom(el, ctx.style) };
      const sub: Block[] = [];
      walkInline(el, inner, current(), sub);
      if (sub.length) {
        // Inline element contained blocks (e.g. an image inside a link): flush around them.
        flush();
        out.push(...sub);
      }
      continue;
    }
    flush();
    const style = styleFrom(el, ctx.style);
    const align = alignOf(el, ctx.align);
    const base = ctx.style.size;
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Number(tag[1]);
        const hs: Style = { ...style, bold: true, size: headingSize(level, base) };
        const p: ParaBlock = { kind: "para", atoms: [], align, indent: ctx.indent, before: hs.size * (level <= 2 ? 0.9 : 0.7), after: hs.size * 0.35, heading: level };
        collect(el, { ...ctx, style: hs, align }, p, out);
        if (p.atoms.length) out.push(p);
        break;
      }
      case "p":
      case "div":
      case "section":
      case "article":
      case "header":
      case "footer":
      case "main":
      case "aside":
      case "nav":
      case "address":
      case "center":
      case "figure":
      case "figcaption":
      case "dt":
      case "dd":
      case "summary":
      case "details":
      case "form":
      case "fieldset": {
        const extra = tag === "dd" ? 18 : 0;
        const st = tag === "figcaption" ? { ...style, italic: true, size: base * 0.9, color: MUTED } : tag === "dt" ? { ...style, bold: true } : style;
        const hasBlockChild = Array.from(el.children).some((c) => BLOCK_TAGS.has(c.tagName.toLowerCase()) || c.tagName.toLowerCase() === "img");
        if (hasBlockChild || tag === "div" || tag === "section" || tag === "article" || tag === "main") {
          walk(el, { ...ctx, style: st, align: tag === "figure" ? "center" : align, indent: ctx.indent + extra }, out);
        } else {
          const p: ParaBlock = { kind: "para", atoms: [], align, indent: ctx.indent + extra, before: 0, after: base * 0.55, bar: ctx.quote > 0 };
          collect(el, { ...ctx, style: st, align }, p, out);
          if (p.atoms.some((a) => "br" in a || a.text.trim())) out.push(p);
        }
        break;
      }
      case "blockquote":
        out.push({ kind: "space", h: base * 0.2 });
        walk(el, { ...ctx, style: { ...style, color: MUTED }, indent: ctx.indent + 16, quote: ctx.quote + 1, align }, out);
        out.push({ kind: "space", h: base * 0.3 });
        break;
      case "pre": {
        const ms: Style = { ...style, family: "mono", size: base * 0.88 };
        const p: ParaBlock = { kind: "para", atoms: [], align: "left", indent: ctx.indent, before: base * 0.2, after: base * 0.8, pre: true, bg: CODE_BG };
        collect(el, { ...ctx, style: ms, pre: true }, p, out);
        // Trim one trailing newline (common in <pre><code>…\n</code></pre>).
        const last = p.atoms[p.atoms.length - 1];
        if (last && "br" in last) p.atoms.pop();
        if (p.atoms.length) out.push(p);
        break;
      }
      case "ul":
      case "ol":
        list(el, tag === "ol", { ...ctx, style, align }, out);
        out.push({ kind: "space", h: base * 0.35 });
        break;
      case "li": {
        // Stray <li> outside a list.
        const p: ParaBlock = { kind: "para", atoms: [], align, indent: ctx.indent + 18, before: 0, after: base * 0.25, marker: { text: "•", style } };
        collect(el, { ...ctx, style }, p, out);
        out.push(p);
        break;
      }
      case "dl":
        walk(el, { ...ctx, style, align }, out);
        break;
      case "hr":
        out.push({ kind: "hr" });
        break;
      case "table":
        out.push(table(el as HTMLTableElement, { ...ctx, style, align: "left" }));
        out.push({ kind: "space", h: base * 0.6 });
        break;
      default:
        walk(el, { ...ctx, style, align }, out);
    }
  }
  flush();
}

/** Inline content of a block element into one paragraph (nested blocks go to `out`). */
function collect(el: Element, ctx: Ctx, p: ParaBlock, out: Block[]) {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) pushText(p, child.textContent ?? "", ctx.style, ctx.pre);
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const c = child as Element;
      const tag = c.tagName.toLowerCase();
      if (tag === "br") p.atoms.push({ br: true, style: ctx.style });
      else if (BLOCK_TAGS.has(tag) || tag === "img") {
        const sub: Block[] = [];
        walk({ childNodes: [c] } as unknown as Node, ctx, sub);
        out.push(...sub);
      } else walkInline(c, { ...ctx, style: styleFrom(c, ctx.style) }, p, out);
    }
  }
}

function walkInline(el: Element, ctx: Ctx, p: ParaBlock, out: Block[]) {
  collect(el, ctx, p, out);
}

function pushText(p: ParaBlock, raw: string, style: Style, pre: boolean) {
  if (pre) {
    const lines = raw.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
    lines.forEach((line, i) => {
      if (i > 0) p.atoms.push({ br: true, style });
      // Keep runs of spaces as their own atoms so indentation survives.
      for (const tok of line.split(/( +)/)) if (tok) p.atoms.push({ text: tok, style, space: /^ +$/.test(tok) });
    });
    return;
  }
  const text = raw.replace(/[\s\u200b]+/g, " ");
  if (!text) return;
  for (const tok of text.split(/( )/)) {
    if (!tok) continue;
    if (tok === " ") {
      const last = p.atoms[p.atoms.length - 1];
      if (last && !("br" in last) && last.space) continue;
      p.atoms.push({ text: " ", style, space: true });
    } else p.atoms.push({ text: tok, style, space: false });
  }
}

const BULLETS = ["•", "◦", "▪", "‣"];

function list(el: Element, ordered: boolean, ctx: Ctx, out: Block[]) {
  const type = el.getAttribute("type") || ((el as HTMLElement).style?.listStyleType ?? "");
  let n = parseInt(el.getAttribute("start") || "1", 10) || 1;
  const depth = ctx.listDepth;
  const indent = ctx.indent + 20;
  for (const li of Array.from(el.children)) {
    if (li.tagName.toLowerCase() !== "li") continue;
    const value = parseInt(li.getAttribute("value") || "", 10);
    if (Number.isFinite(value)) n = value;
    const marker = ordered ? `${listLabel(n, type)}.` : BULLETS[depth % BULLETS.length];
    const st = styleFrom(li, ctx.style);
    const p: ParaBlock = { kind: "para", atoms: [], align: ctx.align === "justify" ? "left" : ctx.align, indent, before: 0, after: ctx.style.size * 0.22, marker: { text: marker, style: { ...st, bold: false, italic: false, underline: false, link: undefined } }, bar: ctx.quote > 0 };
    const nested: Block[] = [];
    for (const child of Array.from(li.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const c = child as Element;
        const tag = c.tagName.toLowerCase();
        if (tag === "ul" || tag === "ol") {
          list(c, tag === "ol", { ...ctx, style: st, indent, listDepth: depth + 1 }, nested);
          continue;
        }
        if (tag === "p" || tag === "div") {
          // Paragraphs inside list items (common in Markdown "loose" lists): inline into the item.
          if (p.atoms.length) p.atoms.push({ br: true, style: st });
          collect(c, { ...ctx, style: styleFrom(c, st) }, p, nested);
          continue;
        }
        if (BLOCK_TAGS.has(tag) || tag === "img") {
          const sub: Block[] = [];
          walk({ childNodes: [c] } as unknown as Node, { ...ctx, style: st, indent }, sub);
          nested.push(...sub);
          continue;
        }
        walkInline(c, { ...ctx, style: styleFrom(c, st) }, p, nested);
      } else if (child.nodeType === Node.TEXT_NODE) pushText(p, child.textContent ?? "", st, false);
    }
    // Drop leading break artefacts.
    while (p.atoms.length && ("br" in p.atoms[0] || (p.atoms[0] as { space: boolean }).space)) p.atoms.shift();
    out.push(p);
    out.push(...nested);
    n++;
  }
}

function listLabel(n: number, type: string): string {
  const t = type.toLowerCase();
  if (type === "a" || t === "lower-alpha" || t === "lower-latin") return alpha(n);
  if (type === "A" || t === "upper-alpha" || t === "upper-latin") return alpha(n).toUpperCase();
  if (type === "i" || t === "lower-roman") return roman(n);
  if (type === "I" || t === "upper-roman") return roman(n).toUpperCase();
  return String(n);
}
const alpha = (n: number): string => (n <= 0 ? String(n) : (n > 26 ? alpha(Math.floor((n - 1) / 26)) : "") + String.fromCharCode(97 + ((n - 1) % 26)));
function roman(n: number): string {
  const map: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let s = "";
  for (const [v, r] of map) while (n >= v) {
    s += r;
    n -= v;
  }
  return s;
}

function table(el: HTMLTableElement, ctx: Ctx): TableBlock {
  const rows: Cell[][] = [];
  let headerRows = 0;
  const trs = Array.from(el.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr"));
  let cover = 0; // rows still filled by cells spanning down from above
  trs.forEach((tr, ri) => {
    const cells: Cell[] = [];
    const inHead = tr.parentElement?.tagName.toLowerCase() === "thead";
    for (const td of Array.from(tr.children)) {
      const tag = td.tagName.toLowerCase();
      if (tag !== "td" && tag !== "th") continue;
      const header = tag === "th" || inHead;
      const st: Style = { ...styleFrom(td, { ...ctx.style, size: ctx.style.size * 0.92 }), bold: header || styleFrom(td, ctx.style).bold };
      const blocks: Block[] = [];
      const hasBlock = Array.from(td.children).some((c) => BLOCK_TAGS.has(c.tagName.toLowerCase()) || c.tagName.toLowerCase() === "img");
      if (hasBlock) walk(td, { ...ctx, style: st, indent: 0, align: alignOf(td, "left") }, blocks);
      else {
        const p: ParaBlock = { kind: "para", atoms: [], align: alignOf(td, "left"), indent: 0, before: 0, after: 0 };
        collect(td, { ...ctx, style: st, indent: 0 }, p, blocks);
        blocks.unshift(p);
      }
      // Tighten spacing inside cells.
      for (const b of blocks) if (b.kind === "para") b.after = Math.min(b.after, st.size * 0.3);
      const last = blocks[blocks.length - 1];
      if (last?.kind === "para") last.after = 0;
      const bg = cssColor((td as HTMLElement).style?.backgroundColor || td.getAttribute("bgcolor") || "") ?? (header ? TABLE_HEAD_BG : undefined);
      cells.push({ blocks, colspan: Math.max(1, Number(td.getAttribute("colspan")) || 1), rowspan: Math.max(1, Number(td.getAttribute("rowspan")) || 1), header, bg });
    }
    if (cells.length) {
      if ((inHead || cells.every((c) => c.header)) && ri === headerRows) headerRows++;
      rows.push(cells);
    } else if (cover > 0) rows.push([]); // a row that only cells from above reach into
    cover = Math.max(cover - 1, ...cells.map((c) => c.rowspan - 1));
  });
  // A rowspan cannot reach past the last row.
  rows.forEach((cells, r) => cells.forEach((c) => (c.rowspan = Math.min(c.rowspan, rows.length - r))));
  return { kind: "table", rows, headerRows: Math.min(headerRows, Math.max(0, rows.length - 1)), indent: ctx.indent, borders: true };
}

/* ----------------------------------------------------------------- layout */

type Frag = { text: string; style: Style; x: number; w: number };
type LineBox = { kind: "line"; frags: Frag[]; height: number; ascent: number; x: number; width: number; fullWidth?: number; bar?: boolean; bg?: RGB; first?: boolean; last?: boolean; heading?: number; headingText?: string; spaceFill?: number };

const styleKey = (s: Style): TextStyle => ({ family: s.family, bold: s.bold, italic: s.italic });

export class Typesetter {
  doc!: PDFDocument;
  fonts!: FontSet;
  page!: PDFPage;
  y = 0; // distance from the top of the page
  pageW = 595.28;
  pageH = 841.89;
  m = { top: 64, right: 60, bottom: 64, left: 60 };
  lineHeight = 1.4;
  outline: { title: string; level: number; page: number }[] = [];
  private images = new Map<string, Promise<Awaited<ReturnType<typeof embedImage>> | null>>();
  resolveImage?: LayoutOpts["resolveImage"];

  static async create(opts: LayoutOpts = {}): Promise<Typesetter> {
    const t = new Typesetter();
    t.doc = await newDoc();
    t.fonts = new FontSet(t.doc);
    if (opts.pageSize) [t.pageW, t.pageH] = opts.pageSize;
    if (typeof opts.margin === "number") t.m = { top: opts.margin, right: opts.margin, bottom: opts.margin, left: opts.margin };
    else if (opts.margin) t.m = opts.margin;
    if (opts.lineHeight) t.lineHeight = opts.lineHeight;
    t.resolveImage = opts.resolveImage;
    if (opts.title) t.doc.setTitle(opts.title);
    if (opts.author) t.doc.setAuthor(opts.author);
    t.newPage();
    return t;
  }

  get contentW() {
    return this.pageW - this.m.left - this.m.right;
  }
  get bottomLimit() {
    return this.pageH - this.m.bottom;
  }

  newPage() {
    this.page = this.doc.addPage([this.pageW, this.pageH]);
    this.y = this.m.top;
  }

  ensure(h: number) {
    if (this.y + h > this.bottomLimit && this.y > this.m.top + 0.5) this.newPage();
  }

  /** Break a paragraph into positioned lines within `width`. */
  async layoutPara(p: ParaBlock, width: number): Promise<LineBox[]> {
    const lines: LineBox[] = [];
    const markerW = p.marker ? 0 : 0;
    const avail = Math.max(20, width - p.indent - markerW);
    let cur: Frag[] = [];
    let curW = 0;
    let pendingSpace: Frag | null = null;
    const push = (last: boolean) => {
      while (cur.length && cur[cur.length - 1].text.trim() === "" && !p.pre) {
        curW -= cur[cur.length - 1].w;
        cur.pop();
      }
      const maxSize = Math.max(p.atoms[0] && !("br" in p.atoms[0]) ? p.atoms[0].style.size : 10, ...cur.map((f) => f.style.size));
      const sizeForHeight = cur.length ? Math.max(...cur.map((f) => f.style.size)) : maxSize;
      lines.push({ kind: "line", frags: cur, height: sizeForHeight * (p.pre ? 1.3 : this.lineHeight), ascent: sizeForHeight * (p.pre ? 0.95 : 1.0), x: p.indent, width: curW, fullWidth: avail, last, bar: p.bar, bg: p.bg, heading: p.heading });
      cur = [];
      curW = 0;
      pendingSpace = null;
    };
    for (const atom of p.atoms) {
      if ("br" in atom) {
        push(true);
        continue;
      }
      const w = await this.fonts.width(atom.text, atom.style.size, styleKey(atom.style));
      if (atom.space && !p.pre) {
        if (cur.length) pendingSpace = { text: " ", style: atom.style, x: 0, w };
        continue;
      }
      const spaceW = pendingSpace ? pendingSpace.w : 0;
      if (curW + spaceW + w <= avail || (!cur.length && w <= avail)) {
        if (pendingSpace) {
          pendingSpace.x = curW;
          cur.push(pendingSpace);
          curW += spaceW;
          pendingSpace = null;
        }
        cur.push({ text: atom.text, style: atom.style, x: curW, w });
        curW += w;
        continue;
      }
      if (w > avail) {
        // Token wider than the line: break it by grapheme.
        if (pendingSpace && cur.length) {
          pendingSpace.x = curW;
          cur.push(pendingSpace);
          curW += spaceW;
          pendingSpace = null;
        }
        let chunk = "";
        for (const g of graphemes(atom.text)) {
          const tw = await this.fonts.width(chunk + g, atom.style.size, styleKey(atom.style));
          if (curW + tw > avail && (chunk || cur.length)) {
            if (chunk) {
              const cw = await this.fonts.width(chunk, atom.style.size, styleKey(atom.style));
              cur.push({ text: chunk, style: atom.style, x: curW, w: cw });
              curW += cw;
            }
            push(false);
            chunk = g;
          } else chunk += g;
        }
        if (chunk) {
          const cw = await this.fonts.width(chunk, atom.style.size, styleKey(atom.style));
          cur.push({ text: chunk, style: atom.style, x: curW, w: cw });
          curW += cw;
        }
        continue;
      }
      push(false);
      cur.push({ text: atom.text, style: atom.style, x: 0, w });
      curW = w;
    }
    if (cur.length || !lines.length) push(true);
    if (lines.length) lines[0].first = true;
    // Alignment.
    for (const l of lines) {
      const free = avail - l.width;
      if (p.align === "center") l.x += free / 2;
      else if (p.align === "right") l.x += free;
      else if (p.align === "justify" && !l.last && free > 0 && free < avail * 0.35) {
        const spaces = l.frags.filter((f) => f.text === " ").length;
        if (spaces) {
          const add = free / spaces;
          let shift = 0;
          for (const f of l.frags) {
            f.x += shift;
            if (f.text === " ") {
              f.w += add;
              shift += add;
            }
          }
          l.width = avail;
        }
      }
    }
    if (p.marker && lines.length) {
      const mw = await this.fonts.width(p.marker.text, p.marker.style.size, styleKey(p.marker.style));
      lines[0].frags.unshift({ text: p.marker.text, style: p.marker.style, x: -mw - 6, w: mw });
    }
    if (p.heading && lines.length) lines[0].headingText = p.atoms.map((a) => ("br" in a ? " " : a.text)).join("").replace(/\s+/g, " ").trim();
    return lines;
  }

  /** Draw a laid-out line with its top at `top` (distance from page top) and left edge at `left`. */
  async drawLine(l: LineBox, left: number, top: number, page = this.page) {
    const baseY = this.pageH - (top + l.ascent);
    if (l.bg) page.drawRectangle({ x: left + l.x - 6, y: this.pageH - top - l.height, width: (l.fullWidth ?? l.width) + 12, height: l.height + 0.5, color: l.bg });
    // 1) Highlight backgrounds go underneath everything.
    for (const f of l.frags) {
      if (!f.style.bg || !f.text.trim()) continue;
      const y = baseY + (f.style.shift ?? 0);
      page.drawRectangle({ x: left + l.x + f.x, y: y - f.style.size * 0.25, width: f.w, height: f.style.size * 1.15, color: f.style.bg });
    }
    // 2) Text: contiguous same-style fragments become one string, so the PDF has
    //    real space characters (better copy/paste and search) and fewer operators.
    const runs: { x: number; text: string; style: Style }[] = [];
    let prev: Frag | null = null;
    for (const f of l.frags) {
      const last = runs[runs.length - 1];
      const contiguous = !!prev && !!last && Math.abs(prev.x + prev.w - f.x) < 0.01 && sameStyle(last.style, f.style) && f.x >= 0;
      if (contiguous) last!.text += f.text;
      else runs.push({ x: f.x, text: f.text, style: f.style });
      prev = f;
    }
    for (const r of runs) {
      if (!r.text.trim()) continue;
      const keepSpaces = r.style.family === "mono";
      let text = keepSpaces ? r.text.replace(/\s+$/, "") : r.text.trim();
      let x = left + l.x + r.x;
      if (!keepSpaces) {
        const lead = r.text.length - r.text.trimStart().length;
        if (lead) x += await this.fonts.width(r.text.slice(0, lead), r.style.size, styleKey(r.style));
      }
      if (!text) text = r.text;
      await this.fonts.draw(page, text, { x, y: baseY + (r.style.shift ?? 0), size: r.style.size, style: styleKey(r.style), color: r.style.color });
    }
    // 3) Decorations and links on top.
    for (const f of l.frags) {
      const x = left + l.x + f.x;
      const y = baseY + (f.style.shift ?? 0);
      if (f.style.underline && f.text.trim()) page.drawLine({ start: { x, y: y - f.style.size * 0.13 }, end: { x: x + f.w, y: y - f.style.size * 0.13 }, thickness: Math.max(0.4, f.style.size / 18), color: f.style.color });
      if (f.style.strike && f.text.trim()) page.drawLine({ start: { x, y: y + f.style.size * 0.28 }, end: { x: x + f.w, y: y + f.style.size * 0.28 }, thickness: Math.max(0.4, f.style.size / 18), color: f.style.color });
      if (f.style.link && f.text.trim()) addLink(page, { x, y: y - f.style.size * 0.25, w: f.w, h: f.style.size * 1.2 }, f.style.link);
    }
  }

  async image(block: ImageBlock, maxW: number, maxH: number) {
    let p = this.images.get(block.src);
    if (!p) {
      p = (async () => {
        try {
          let data: { bytes: Uint8Array; mime: string } | null = null;
          if (block.src.startsWith("data:")) data = dataUri(block.src);
          else if (this.resolveImage) data = await this.resolveImage(block.src);
          return data ? await embedImage(this.doc, data.bytes, data.mime) : null;
        } catch {
          return null;
        }
      })();
      this.images.set(block.src, p);
    }
    const img = await p;
    if (!img) return null;
    let w = block.width ?? img.width * 0.75;
    let h = block.height ?? (w * img.height) / img.width;
    if (block.width && !block.height) h = (w * img.height) / img.width;
    if (!block.width && block.height) w = (h * img.width) / img.height;
    const s = Math.min(1, maxW / w, maxH / h);
    return { img, w: w * s, h: h * s };
  }

  /* -------- flow (body) -------- */

  async flow(blocks: Block[], onProgress?: ProgressFn) {
    for (let i = 0; i < blocks.length; i++) {
      if (i % 25 === 0) {
        onProgress?.(i / blocks.length, "Typesetting");
        await tick();
      }
      const b = blocks[i];
      if (b.kind === "pagebreak") {
        if (this.y > this.m.top) this.newPage();
        continue;
      }
      if (b.kind === "space") {
        if (this.y > this.m.top) this.y += b.h;
        continue;
      }
      if (b.kind === "hr") {
        this.ensure(14);
        const y = this.pageH - (this.y + 7);
        this.page.drawLine({ start: { x: this.m.left, y }, end: { x: this.pageW - this.m.right, y }, thickness: 0.7, color: RULE });
        this.y += 14;
        continue;
      }
      if (b.kind === "image") {
        const r = await this.image(b, this.contentW - b.indent, this.bottomLimit - this.m.top);
        if (!r) continue;
        this.ensure(r.h + 6);
        const left = this.m.left + b.indent + (b.align === "center" ? (this.contentW - b.indent - r.w) / 2 : b.align === "right" ? this.contentW - b.indent - r.w : 0);
        this.page.drawImage(r.img, { x: left, y: this.pageH - this.y - r.h, width: r.w, height: r.h });
        this.y += r.h + 8;
        continue;
      }
      if (b.kind === "table") {
        await this.table(b);
        continue;
      }
      // Paragraph
      if (this.y > this.m.top) this.y += b.before;
      const lines = await this.layoutPara(b, this.contentW);
      if (b.heading) {
        // Keep a heading with at least two lines of what follows.
        const next = blocks[i + 1];
        const follow = next?.kind === "para" ? next.atoms.length ? (next.atoms.find((a) => !("br" in a)) as { style: Style } | undefined)?.style.size ?? 11 : 11 : 11;
        this.ensure(lines.reduce((s, l) => s + l.height, 0) + follow * this.lineHeight * 2);
        if (lines[0]?.headingText) this.outline.push({ title: lines[0].headingText, level: b.heading, page: this.doc.getPageCount() - 1 });
      }
      for (const l of lines) {
        this.ensure(l.height);
        if (l.bar) {
          const top = this.pageH - this.y;
          this.page.drawLine({ start: { x: this.m.left + l.x - 10 - (b.marker ? 14 : 0), y: top }, end: { x: this.m.left + l.x - 10 - (b.marker ? 14 : 0), y: top - l.height }, thickness: 2, color: RULE });
        }
        await this.drawLine(l, this.m.left, this.y);
        this.y += l.height;
      }
      this.y += b.after;
    }
  }

  async measure(blocks: Block[]): Promise<{ min: number; max: number }> {
    let min = 0;
    let max = 0;
    for (const b of blocks) {
      if (b.kind === "para") {
        let line = 0;
        let lmax = 0;
        for (const a of b.atoms) {
          if ("br" in a) {
            lmax = Math.max(lmax, line);
            line = 0;
            continue;
          }
          const w = await this.fonts.width(a.text, a.style.size, styleKey(a.style));
          line += w;
          if (!a.space) min = Math.max(min, Math.min(w, 140) + b.indent);
        }
        lmax = Math.max(lmax, line);
        const mk = b.marker ? 18 : 0;
        max = Math.max(max, lmax + b.indent + mk);
        min += 0;
      } else if (b.kind === "image") {
        min = Math.max(min, 40);
        max = Math.max(max, b.width ?? 160);
      } else if (b.kind === "table") {
        max = Math.max(max, 300);
        min = Math.max(min, 120);
      }
    }
    return { min, max: Math.max(min, max) };
  }

  async table(t: TableBlock) {
    const PAD = 4.5;
    // Build a grid honouring colspan/rowspan.
    type Placed = { cell: Cell; row: number; col: number };
    const placed: Placed[] = [];
    const occupied: boolean[][] = [];
    let ncols = 0;
    t.rows.forEach((row, r) => {
      occupied[r] ??= [];
      let c = 0;
      for (const cell of row) {
        while (occupied[r][c]) c++;
        placed.push({ cell, row: r, col: c });
        for (let dr = 0; dr < cell.rowspan; dr++) {
          occupied[r + dr] ??= [];
          for (let dc = 0; dc < cell.colspan; dc++) occupied[r + dr][c + dc] = true;
        }
        c += cell.colspan;
        ncols = Math.max(ncols, c);
      }
    });
    if (!ncols) return;
    const avail = this.contentW - t.indent;
    const mins = new Array(ncols).fill(18);
    const maxs = new Array(ncols).fill(18);
    for (const p of placed) {
      const m = await this.measure(p.cell.blocks);
      const span = p.cell.colspan;
      for (let k = 0; k < span; k++) {
        mins[p.col + k] = Math.max(mins[p.col + k], (m.min + PAD * 2) / span);
        maxs[p.col + k] = Math.max(maxs[p.col + k], (m.max + PAD * 2 + 1) / span);
      }
    }
    const sumMax = maxs.reduce((a, b) => a + b, 0);
    const sumMin = mins.reduce((a, b) => a + b, 0);
    let widths: number[];
    if (sumMax <= avail) widths = maxs.map((w) => w * (sumMax < avail * 0.6 ? 1 : avail / sumMax));
    else if (sumMin >= avail) widths = mins.map((w) => (w * avail) / sumMin);
    else {
      const extra = avail - sumMin;
      const flex = maxs.map((w, i) => w - mins[i]);
      const sumFlex = flex.reduce((a, b) => a + b, 0) || 1;
      widths = mins.map((w, i) => w + (extra * flex[i]) / sumFlex);
    }
    const tableW = widths.reduce((a, b) => a + b, 0);
    const colX = widths.reduce<number[]>((acc, _w, i) => (acc.push(i ? acc[i - 1] + widths[i - 1] : 0), acc), []);
    // Lay out every cell into lines.
    type Laid = Placed & { items: ({ kind: "line"; line: LineBox } | { kind: "img"; img: NonNullable<Awaited<ReturnType<Typesetter["image"]>>> })[]; w: number };
    const laid: Laid[] = [];
    for (const p of placed) {
      const w = colX[p.col + p.cell.colspan - 1] + widths[p.col + p.cell.colspan - 1] - colX[p.col];
      const items: Laid["items"] = [];
      for (const b of p.cell.blocks) {
        if (b.kind === "para") {
          for (const line of await this.layoutPara(b, w - PAD * 2)) items.push({ kind: "line", line });
        } else if (b.kind === "image") {
          const r = await this.image(b, w - PAD * 2, 300);
          if (r) items.push({ kind: "img", img: r });
        }
      }
      laid.push({ ...p, items, w });
    }
    const heightOf = (l: Laid) => l.items.reduce((s, it) => s + (it.kind === "line" ? it.line.height : it.img.h + 4), 0) + PAD * 2;
    const nrows = t.rows.length;
    const rowH = new Array(nrows).fill(0);
    for (const l of laid) if (l.cell.rowspan === 1) rowH[l.row] = Math.max(rowH[l.row], heightOf(l));
    for (const l of laid) {
      if (l.cell.rowspan > 1) {
        const span = rowH.slice(l.row, l.row + l.cell.rowspan).reduce((a, b) => a + b, 0);
        const need = heightOf(l);
        if (need > span) rowH[l.row + l.cell.rowspan - 1] += need - span;
      }
    }
    // (A row with no cells of its own takes only what the cells spanning into it need.)
    for (let r = 0; r < nrows; r++) rowH[r] = Math.max(rowH[r], t.rows[r].length ? 14 : 0);
    const left = this.m.left + t.indent;
    const drawRow = async (r: number, top: number, clipFrom = 0, clipH = Infinity) => {
      for (const l of laid.filter((x) => x.row === r)) {
        const h = rowH.slice(r, r + l.cell.rowspan).reduce((a, b) => a + b, 0);
        const visibleH = Math.min(h - clipFrom, clipH);
        const x = left + colX[l.col];
        if (l.cell.bg) this.page.drawRectangle({ x, y: this.pageH - top - visibleH, width: l.w, height: visibleH, color: l.cell.bg });
        let y = top + PAD - clipFrom;
        for (const it of l.items) {
          const ih = it.kind === "line" ? it.line.height : it.img.h + 4;
          if (y >= top - 0.1 && y + ih <= top + visibleH + 0.1) {
            if (it.kind === "line") await this.drawLine(it.line, x + PAD, y);
            else this.page.drawImage(it.img.img, { x: x + PAD, y: this.pageH - y - it.img.h, width: it.img.w, height: it.img.h });
          }
          y += ih;
        }
        if (t.borders) this.page.drawRectangle({ x, y: this.pageH - top - visibleH, width: l.w, height: visibleH, borderColor: RULE, borderWidth: 0.6 });
      }
    };
    const pageBody = this.bottomLimit - this.m.top;
    let header = Array.from({ length: t.headerRows }, (_, i) => i);
    let headerH = header.reduce((s, r) => s + rowH[r], 0);
    if (headerH > pageBody * 0.4) {
      // Do not repeat a header that would eat most of every page.
      for (const r of header) {
        this.ensure(rowH[r]);
        await drawRow(r, this.y);
        this.y += rowH[r];
      }
      header = [];
      headerH = 0;
    }
    const bodyLimit = () => this.bottomLimit;
    this.ensure(Math.min(headerH + (rowH[t.headerRows] ?? 0), pageBody));
    for (const r of header) {
      await drawRow(r, this.y);
      this.y += rowH[r];
    }
    // The last row a cell starting in rows r.. reaches: rows tied together by a cell spanning
    // down keep together on one page, drawn whole.
    const groupEnd = (r: number) => {
      let end = r;
      for (let k = r; k <= end; k++) for (const l of laid) if (l.row === k) end = Math.max(end, k + l.cell.rowspan - 1);
      return Math.min(end, nrows - 1);
    };
    for (let r = t.headerRows; r < nrows; r++) {
      const end = groupEnd(r);
      const groupH = rowH.slice(r, end + 1).reduce((a, b) => a + b, 0);
      if (end > r && groupH <= pageBody - headerH) {
        if (groupH > bodyLimit() - this.y) {
          this.newPage();
          for (const hr of header) {
            await drawRow(hr, this.y);
            this.y += rowH[hr];
          }
        }
        for (let k = r; k <= end; k++) {
          await drawRow(k, this.y);
          this.y += rowH[k];
        }
        r = end;
        continue;
      }
      let remaining = rowH[r];
      let offset = 0;
      while (remaining > 0) {
        const space = bodyLimit() - this.y;
        if (remaining <= space) {
          await drawRow(r, this.y, offset, remaining);
          this.y += remaining;
          remaining = 0;
        } else if (space > 40 && rowH[r] > pageBody - headerH) {
          // Row taller than a whole page: split it.
          await drawRow(r, this.y, offset, space);
          offset += space;
          remaining -= space;
          this.newPage();
          for (const hr of header) {
            await drawRow(hr, this.y);
            this.y += rowH[hr];
          }
        } else {
          this.newPage();
          for (const hr of header) {
            await drawRow(hr, this.y);
            this.y += rowH[hr];
          }
        }
      }
    }
    void tableW;
    this.y += 2;
  }

  async finish(opts: { pageNumbers?: boolean; bookmarks?: boolean } = {}): Promise<Uint8Array> {
    const pages = this.doc.getPages();
    if (opts.pageNumbers && pages.length > 1) {
      for (let i = 0; i < pages.length; i++) {
        const label = `${i + 1} / ${pages.length}`;
        const w = await this.fonts.width(label, 8.5);
        await this.fonts.draw(pages[i], label, { x: (this.pageW - w) / 2, y: Math.max(18, this.m.bottom / 2 - 4), size: 8.5, color: MUTED });
      }
    }
    if (opts.bookmarks !== false && this.outline.length > 1) setOutline(this.doc, nest(this.outline), true);
    return saveDoc(this.doc);
  }
}

function nest(flat: { title: string; level: number; page: number }[]): OutlineEntry[] {
  const minLevel = Math.min(...flat.map((f) => f.level));
  const root: OutlineEntry[] = [];
  const stack: { level: number; e: OutlineEntry }[] = [];
  for (const f of flat.filter((x) => x.level <= minLevel + 2)) {
    const e: OutlineEntry = { title: f.title, pageIndex: f.page };
    while (stack.length && stack[stack.length - 1].level >= f.level) stack.pop();
    if (stack.length) (stack[stack.length - 1].e.children ??= []).push(e);
    else root.push(e);
    stack.push({ level: f.level, e });
  }
  return root;
}

function addLink(page: PDFPage, r: { x: number; y: number; w: number; h: number }, url: string) {
  const ctx = page.doc.context;
  const annot = ctx.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [r.x, r.y, r.x + r.w, r.y + r.h],
    Border: [0, 0, 0],
    A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
  });
  const ref = ctx.register(annot);
  let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) {
    annots = ctx.obj([]);
    page.node.set(PDFName.of("Annots"), annots);
  }
  annots.push(ref);
}

function sameStyle(a: Style, b: Style) {
  return a === b || (a.family === b.family && a.bold === b.bold && a.italic === b.italic && a.size === b.size && a.color === b.color && a.shift === b.shift && a.link === b.link && a.bg === b.bg && a.underline === b.underline && a.strike === b.strike);
}

export function dataUri(src: string): { bytes: Uint8Array; mime: string } | null {
  const m = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  if (m[2]) {
    const bin = atob(m[3]);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return { bytes: u, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(m[3])), mime };
}

export function baseStyle(o: { family?: Family; size?: number } = {}): Style {
  return { family: o.family ?? "sans", bold: false, italic: false, size: o.size ?? 11, color: hexToRgb("#111111") };
}

/** One call: HTML → PDF bytes. */
export async function renderHtml(html: string, opts: LayoutOpts = {}): Promise<Uint8Array> {
  const t = await Typesetter.create(opts);
  const blocks = htmlToBlocks(html, baseStyle({ family: opts.family, size: opts.baseSize }));
  if (!blocks.length) blocks.push({ kind: "para", atoms: [{ text: " ", style: baseStyle(), space: false }], align: "left", indent: 0, before: 0, after: 0 });
  await t.flow(blocks, opts.onProgress);
  return t.finish({ pageNumbers: opts.pageNumbers, bookmarks: opts.bookmarks });
}

export type { Block, ParaBlock };
