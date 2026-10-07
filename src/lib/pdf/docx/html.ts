/**
 * Model → HTML laid out by the browser the way Word lays out the document:
 * line heights from Word's font metrics, Word's paragraph spacing, indents,
 * list labels, tabs (sized later, once positions are known), tables on their
 * grid, pictures and shapes. Everything is tagged with numbers that point into
 * tables (styles, paragraphs, boxes, drawings) used by the paginator and the
 * painter, so nothing has to be read back from computed CSS.
 */
import type { Block, Border, Cell, Drawing, DocxModel, GroupNode, Inline, Level, Link, Para, ParaProps, RunProps, Section, ShapeNode, Sides, TabStop, Table } from "./model";
import { FACE_METRICS, cssFamily, faceStack, scriptOf, styleKey, wordFont, type Face } from "./fonts";
import { mapSymbols } from "./symbols";
import { pt } from "./units";

export type SpanStyle = {
  stack: Face[];
  bold: boolean;
  italic: boolean;
  size: number;
  color: string;
  underline?: string;
  ulColor?: string;
  strike?: boolean;
  dstrike?: boolean;
  bg?: string;
  spacing?: number;
  scale?: number;
  link?: number;
  shift?: number;
};

export type ParaInfo = {
  tabs: TabStop[];
  indLeft: number;
  indFirst: number; // signed: negative for a hanging indent
  indRight: number;
  align: string;
  heading?: number;
  keepNext: boolean;
  keepLines: boolean;
  widow: boolean;
  /** A forced break before this paragraph part. */
  brk?: "page" | "column";
  pageBreakBefore: boolean;
  /** Space before this paragraph part (points). */
  before: number;
  /** A page or column break closes this paragraph: what follows starts anew. */
  breakAfter?: "page" | "column";
  labelJc?: string;
  inTable: boolean;
};

export type BoxInfo = { fill?: string; borders?: Sides<Border> & { between?: Border }; kind: "cell" | "group" | "para" | "table"; header?: boolean; cantSplit?: boolean };

export type DrawInfo = { d: Drawing; mode: "inline" | "float" | "block" | "overlay"; nodes: (ShapeNode | GroupNode)[] };

export type NoteInfo = { id: string; label: string; note: "footnote" | "endnote" };

export type Strip = { html: string; width: number; section: number; columns: { n: number; space: number; widths?: number[]; sep: boolean } };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ------------------------------------------------------------- numbering */

function roman(n: number): string {
  const map: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let s = "";
  for (const [v, r] of map) while (n >= v) {
    s += r;
    n -= v;
  }
  return s;
}
const letters = (n: number) => {
  if (n <= 0) return String(n);
  const ch = String.fromCharCode(97 + ((n - 1) % 26));
  return ch.repeat(Math.floor((n - 1) / 26) + 1);
};
const ORD_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const ORDINAL_WORDS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"];

export function formatNumber(n: number, fmt: string): string {
  switch (fmt) {
    case "lowerLetter":
      return letters(n);
    case "upperLetter":
      return letters(n).toUpperCase();
    case "lowerRoman":
      return roman(n);
    case "upperRoman":
      return roman(n).toUpperCase();
    case "decimalZero":
      return n < 10 ? `0${n}` : String(n);
    case "ordinal": {
      const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
      return `${n}${s}`;
    }
    case "cardinalText":
      return (ORD_WORDS[n] ?? String(n)).replace(/^./, (c) => c.toUpperCase());
    case "ordinalText":
      return (ORDINAL_WORDS[n] ?? `${n}th`).replace(/^./, (c) => c.toUpperCase());
    case "hex":
      return n.toString(16).toUpperCase();
    case "chicago":
      return ["*", "†", "‡", "§"][(n - 1) % 4].repeat(Math.floor((n - 1) / 4) + 1);
    case "decimalEnclosedCircle":
      return n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : String(n);
    case "hindiNumbers":
    case "hindiCounting":
      return String(n).replace(/\d/g, (d) => String.fromCodePoint(0x966 + Number(d)));
    case "hindiVowels":
      return "अआइईउऊऋएऐओऔ"[(n - 1) % 11] ?? String(n);
    case "hindiConsonants":
      return "कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह"[(n - 1) % 33] ?? String(n);
    case "none":
      return "";
    case "bullet":
      return "";
    default:
      return String(n);
  }
}

class Numbering {
  private counters = new Map<string, (number | undefined)[]>();
  private seen = new Set<string>();
  constructor(private model: DocxModel) {}

  private resolve(numId: string): { absId: string; levels: Level[] } | null {
    const n = this.model.nums.get(numId);
    if (!n) return null;
    let absId = n.abstractId;
    let a = this.model.abstracts.get(absId);
    for (let i = 0; i < 3 && a?.numStyleLink; i++) {
      const linked = this.linkedNum(a.numStyleLink);
      const ln = linked ? this.model.nums.get(linked) : undefined;
      if (!ln) break;
      absId = ln.abstractId;
      a = this.model.abstracts.get(absId);
    }
    if (!a) return null;
    const levels = a.levels.map((l, i) => n.overrides.get(i)?.level ?? l);
    return { absId, levels };
  }

  linkedNum: (styleId: string) => string | undefined = () => undefined;

  /** The label for a numbered paragraph, advancing the list's counters. */
  next(numId: string, ilvl: number): { text: string; level: Level } | null {
    const r = this.resolve(numId);
    if (!r) return null;
    const level = r.levels[ilvl];
    if (!level) return null;
    let vals = this.counters.get(r.absId);
    if (!vals) {
      vals = [];
      this.counters.set(r.absId, vals);
    }
    const n = this.model.nums.get(numId)!;
    if (!this.seen.has(numId)) {
      this.seen.add(numId);
      for (const [l, o] of n.overrides) if (o.start !== undefined) vals[l] = o.start - 1;
    }
    if (vals[ilvl] === undefined) vals[ilvl] = level.start - 1;
    vals[ilvl] = (vals[ilvl] ?? 0) + 1;
    for (let l = ilvl + 1; l < 9; l++) {
      const restartAt = r.levels[l]?.restart ?? l;
      if (restartAt !== 0 && ilvl <= restartAt - 1) vals[l] = undefined;
    }
    if (level.fmt === "bullet") return { text: level.text, level };
    const text = level.text.replace(/%([1-9])/g, (_m, d) => {
      const k = Number(d) - 1;
      const lv = r.levels[k];
      const v = vals![k] ?? lv?.start ?? 1;
      const fmt = level.legal && k < ilvl ? "decimal" : (lv?.fmt ?? "decimal");
      return formatNumber(v, fmt);
    });
    return { text, level };
  }
}

/* -------------------------------------------------------------- generator */

type Ctx = { width: number; inTable: boolean; part: "body" | "header" | "note" | "box" };

export class HtmlGen {
  spans: SpanStyle[] = [];
  private spanKey = new Map<string, number>();
  paras: ParaInfo[] = [];
  boxes: BoxInfo[] = [];
  draws: DrawInfo[] = [];
  links: Link[] = [];
  private linkKey = new Map<string, number>();
  notes: NoteInfo[] = [];
  noteLabel = new Map<string, string>();
  /** Faces (with style) the frame must load. */
  faces = new Set<string>();
  numbering: Numbering;
  private footnoteCounter: number;
  private endnoteCounter = 1;
  headingTexts = new Map<number, string>();
  /** Paragraph styles carried for contextual spacing. */
  private styleOfPara = new Map<number, string | undefined>();

  constructor(public model: DocxModel) {
    this.numbering = new Numbering(model);
    this.footnoteCounter = model.settings.footnoteStart;
  }

  /* ----- styles */

  private fontFor(rp: RunProps, script: "latin" | "cs" | "ea", ascii: boolean) {
    const f = rp.fonts ?? {};
    const name = script === "cs" ? (f.cs ?? f.hAnsi ?? f.ascii) : script === "ea" ? (f.eastAsia ?? f.hAnsi ?? f.ascii) : ascii ? (f.ascii ?? f.hAnsi) : (f.hAnsi ?? f.ascii);
    // With no font named anywhere, Word falls back to Times New Roman.
    return wordFont(name ?? "Times New Roman");
  }

  spanStyle(rp: RunProps, script: "latin" | "cs" | "ea" = "latin", ascii = true, link?: Link): { idx: number; css: string; size: number; lh: number; face: Face; above?: number } {
    const wf = this.fontFor(rp, script, ascii);
    let size = (script === "cs" ? (rp.sizeCs ?? rp.size) : rp.size) ?? 10;
    const bold = !!(script === "cs" ? (rp.boldCs ?? rp.bold) : rp.bold);
    const italic = !!(script === "cs" ? (rp.italicCs ?? rp.italic) : rp.italic);
    let shift = rp.position ?? 0;
    if (rp.vertAlign === "superscript") {
      shift += size * 0.33;
      size *= 0.65;
    } else if (rp.vertAlign === "subscript") {
      shift -= size * 0.14;
      size *= 0.65;
    }
    const color = !rp.color || rp.color === "auto" ? "000000" : rp.color;
    const bg = rp.highlight && rp.highlight !== "none" ? rp.highlight : rp.shading && rp.shading !== "none" ? rp.shading : undefined;
    const st: SpanStyle = {
      stack: faceStack(wf.face, wf.generic),
      bold,
      italic,
      size,
      color,
      underline: rp.underline && rp.underline !== "none" ? rp.underline : undefined,
      ulColor: rp.underlineColor,
      strike: rp.strike || undefined,
      dstrike: rp.dstrike || undefined,
      bg,
      spacing: rp.spacing || undefined,
      scale: rp.scale && rp.scale !== 100 ? rp.scale : undefined,
      link: link ? this.linkIndex(link) : undefined,
      shift: shift || undefined,
    };
    const key = JSON.stringify(st);
    let idx = this.spanKey.get(key);
    if (idx === undefined) {
      idx = this.spans.length;
      this.spans.push(st);
      this.spanKey.set(key, idx);
    }
    for (const f of st.stack) {
      this.faces.add(`${f}/${styleKey(bold, italic)}`);
    }
    const css = [
      `font-family:${st.stack.map((f) => cssFamily(f)).join(",")}`,
      `font-size:${pt(size)}`,
      bold ? "font-weight:700" : "",
      italic ? "font-style:italic" : "",
      st.spacing ? `letter-spacing:${pt(st.spacing)}` : "",
      shift ? `position:relative;top:${pt(-shift)}` : "",
      `color:#${color}`,
    ]
      .filter(Boolean)
      .join(";");
    return { idx, css, size, lh: wf.lh, face: wf.face, above: wf.above };
  }

  linkIndex(l: Link): number {
    const key = l.url ? `u:${l.url}` : `a:${l.anchor}`;
    let i = this.linkKey.get(key);
    if (i === undefined) {
      i = this.links.length;
      this.links.push(l);
      this.linkKey.set(key, i);
    }
    return i;
  }

  /** Line height for a run: Word's single spacing times the paragraph's rule. */
  private lineHeight(pp: ParaProps, size: number, lh: number): string {
    if (pp.lineRule === "exact") return pt(pp.line ?? size * lh);
    if (pp.lineRule === "atLeast") return pt(size * lh);
    const mult = pp.line ?? 1;
    return pt(size * lh * mult);
  }

  /**
   * Where Word puts the baseline in a line, against where CSS puts it (CSS centres text
   * in its line). Word keeps the font's ascent and line gap above the text and adds a
   * taller line's extra room below it; an exact line has its baseline at 80% of its
   * height; an at-least line that grew keeps the descent below. The difference moves
   * the paragraph's text without changing its lines. Measured on the paragraph mark's
   * font, so every run on a line moves together.
   */
  private baselineFix(pp: ParaProps, mark: { size: number; face: Face; lh: number; above?: number }): number {
    const [a, d] = FACE_METRICS[mark.face];
    const size = mark.size;
    const nat = mark.lh * size; // Word's single line
    const cssBase = (L: number) => (L - (a + d) * size) / 2 + a * size;
    if (pp.lineRule === "exact" && pp.line) return 0.8 * pp.line - cssBase(pp.line);
    if (pp.lineRule === "atLeast" && pp.line && pp.line > nat) return pp.line - d * size - cssBase(pp.line);
    const m = pp.lineRule === "atLeast" ? 1 : (pp.line ?? 1);
    const L = nat * m;
    const above = mark.above !== undefined ? mark.above * size : nat - d * size; // ascent plus line gap
    const wordBase = m >= 1 ? above : above - (nat - L);
    return wordBase - cssBase(L);
  }

  private markStyle?: { size: number; face: Face; lh: number; above?: number };
  /** The current paragraph's baseline correction (points, down). */
  private paraFix = 0;

  /** A run's span: its style, line height and Word's baseline. */
  private span(cls: string, s: { idx: number; css: string; size: number; lh: number; face: Face }, pp: ParaProps, inner: string, extra = ""): string {
    const fix = Math.abs(this.paraFix) > 0.01 ? this.paraFix : 0;
    const st = this.spans[s.idx];
    const top = fix ? `;position:relative;top:${pt(fix - (st.shift ?? 0))}` : "";
    return `<span class="${cls}" data-s="${s.idx}"${extra} style="${s.css}${top};line-height:${this.lineHeight(pp, s.size, s.lh)}">${inner}</span>`;
  }

  /* ----- text */

  private textHtml(text: string, rp: RunProps, pp: ParaProps, link?: Link): string {
    if (rp.vanish) return "";
    let t = text;
    if (rp.caps) t = t.toUpperCase();
    const pieces: { script: "latin" | "cs" | "ea"; ascii: boolean; text: string; small?: boolean }[] = [];
    for (const ch of t) {
      const cp = ch.codePointAt(0)!;
      const script = cp <= 0x20 || cp === 0xa0 ? (pieces[pieces.length - 1]?.script ?? "latin") : scriptOf(cp);
      const ascii = cp < 0x80;
      const small = !!rp.smallCaps && !rp.caps && /\p{Ll}/u.test(ch);
      const last = pieces[pieces.length - 1];
      if (last && last.script === script && (script !== "latin" || last.ascii === ascii || cp <= 0x20) && !!last.small === small) last.text += small ? ch.toUpperCase() : ch;
      else pieces.push({ script, ascii, text: small ? ch.toUpperCase() : ch, small });
    }
    let out = "";
    for (const pc of pieces) {
      const prp = pc.small ? { ...rp, size: (rp.size ?? 10) * 0.8, sizeCs: (rp.sizeCs ?? rp.size ?? 10) * 0.8 } : rp;
      const s = this.spanStyle(prp, pc.script, pc.ascii, link);
      out += this.span("r", s, pp, esc(pc.text));
    }
    return out;
  }

  /** The zero-width mark that stands for the paragraph mark (and gives empty paragraphs their height). */
  private markHtml(rp: RunProps, pp: ParaProps): string {
    const s = this.spanStyle({ ...rp, vertAlign: undefined, position: undefined, underline: undefined, strike: undefined, highlight: undefined, shading: undefined }, "latin", true);
    return this.span("r m", s, pp, "\u200b");
  }

  /* ----- paragraphs */

  private paraCss(pp: ParaProps, ctx: Ctx, before: number, after: number, firstPart: boolean, markCss = ""): string {
    const left = pp.indLeft ?? 0;
    const right = pp.indRight ?? 0;
    const first = firstPart ? (pp.indHanging ? -pp.indHanging : (pp.indFirst ?? 0)) : 0;
    const align = pp.align ?? "left";
    const rtl = !!pp.bidi;
    const ta =
      align === "center" ? "center" : align === "right" || align === "end" ? (rtl ? "left" : "right") : align === "both" || align === "distribute" || /^(highKashida|lowKashida|mediumKashida|thaiDistribute)$/.test(align) ? "justify" : rtl ? "right" : "left";
    const lh = pp.lineRule === "exact" ? pt(pp.line ?? 12) : pp.lineRule === "atLeast" ? pt(pp.line ?? 0) : "0";
    void ctx;
    return [
      markCss,
      `margin:${pt(before)} ${pt(right)} ${pt(after)} ${pt(left)}`,
      first ? `text-indent:${pt(first)}` : "",
      `text-align:${ta}`,
      align === "distribute" ? "text-align-last:justify" : "",
      `line-height:${lh}`,
      rtl ? "direction:rtl" : "",
    ]
      .filter(Boolean)
      .join(";");
  }

  /** Space before/after, honouring auto spacing and contextual spacing between same-style paragraphs. */
  private spacing(p: Para, prev: Block | undefined, next: Block | undefined): { before: number; after: number } {
    const pp = p.pp;
    let before = pp.spBeforeAuto ? 14 : (pp.spBefore ?? 0);
    let after = pp.spAfterAuto ? 14 : (pp.spAfter ?? 0);
    if (pp.contextual && prev?.kind === "p" && prev.pp.styleId === pp.styleId) before = 0;
    if (pp.contextual && next?.kind === "p" && next.pp.styleId === pp.styleId) after = 0;
    return { before, after };
  }

  paragraph(p: Para, ctx: Ctx, prev: Block | undefined, next: Block | undefined): string {
    const pp = p.pp;
    const { before, after } = this.spacing(p, prev, next);
    const markS = this.spanStyle({ ...p.mark, vertAlign: undefined, position: undefined }, "latin", true);
    this.markStyle = { size: markS.size, face: markS.face, lh: markS.lh, above: markS.above };
    this.paraFix = this.baselineFix(pp, this.markStyle);
    const markCss = markS.css.split(";").filter((d) => /^font-(family|size)/.test(d)).join(";");
    // Numbering label.
    let label = "";
    let labelJc: string | undefined;
    if (pp.numId && pp.numId !== "0" && p.inlines.length + 1 > 0) {
      const lab = this.numbering.next(pp.numId, pp.ilvl ?? 0);
      if (lab && (lab.text || lab.level.suffix !== "nothing")) {
        const lrp: RunProps = { ...p.mark, ...stripUndef(lab.level.rp), fonts: { ...p.mark.fonts, ...lab.level.rp.fonts }, underline: lab.level.rp.underline, vertAlign: undefined, highlight: undefined, shading: undefined };
        let text = lab.text;
        const mapped = mapSymbols(text, lrp.fonts?.ascii ?? lrp.fonts?.hAnsi);
        if (mapped !== null) {
          text = mapped;
          lrp.fonts = { ...lrp.fonts, ascii: "Symbol Mapped", hAnsi: "Symbol Mapped" };
        }
        if (lab.level.picBullet) text = "•";
        label = `<span class="lbl">${this.textHtml(text, lrp, pp)}</span>`;
        if (lab.level.suffix === "tab") label += `<span class="tb" data-ti="lbl"></span>`;
        else if (lab.level.suffix === "space") label += this.textHtml(" ", lrp, pp);
        labelJc = lab.level.jc !== "left" && lab.level.jc !== "start" ? lab.level.jc : undefined;
      }
    }
    // Split at page and column breaks: each part is its own block for the paginator.
    const parts: { inlines: Inline[]; brk?: "page" | "column"; trailing?: "page" | "column" }[] = [{ inlines: [] }];
    for (const it of p.inlines) {
      if (it.kind === "br" && it.type !== "line") parts.push({ inlines: [], brk: it.type });
      else parts[parts.length - 1].inlines.push(it);
    }
    // A break that ends the paragraph leaves its mark on the old page, as Word shows it.
    while (parts.length > 1 && !parts[parts.length - 1].inlines.some((x) => x.kind !== "bookmark")) {
      const gone = parts.pop()!;
      parts[parts.length - 1].inlines.push(...gone.inlines);
      if (parts.length === 1 && !parts[0].inlines.some((x) => x.kind !== "bookmark") && !label) {
        // A paragraph holding only a page break: the break comes after it.
        parts[0].trailing = gone.brk;
      } else parts[parts.length - 1].trailing = gone.brk;
    }
    const heading = this.model.headingLevel(pp.styleId) ?? (pp.outlineLvl !== undefined && pp.outlineLvl < 9 ? pp.outlineLvl + 1 : undefined);
    let html = "";
    parts.forEach((part, i) => {
      const firstPart = i === 0;
      const lastPart = i === parts.length - 1;
      // A break right at the start of a paragraph leaves nothing before it.
      if (firstPart && !lastPart && !part.inlines.some((x) => x.kind !== "bookmark") && !label) return;
      const idx = this.paras.length;
      const info: ParaInfo = {
        tabs: pp.tabs ?? [],
        indLeft: pp.indLeft ?? 0,
        indFirst: firstPart ? (pp.indHanging ? -pp.indHanging : (pp.indFirst ?? 0)) : 0,
        indRight: pp.indRight ?? 0,
        align: pp.align ?? "left",
        heading: firstPart ? heading : undefined,
        keepNext: !!pp.keepNext && lastPart,
        keepLines: !!pp.keepLines,
        widow: pp.widowControl !== false,
        brk: part.brk,
        pageBreakBefore: !!pp.pageBreakBefore && firstPart,
        before: firstPart ? before : 0,
        breakAfter: part.trailing,
        labelJc: firstPart ? labelJc : undefined,
        inTable: ctx.inTable,
      };
      this.paras.push(info);
      this.styleOfPara.set(idx, pp.styleId);
      const css = this.paraCss(pp, ctx, firstPart ? before : 0, lastPart ? after : 0, firstPart, markCss);
      const { body, floats } = this.inlinesHtml(part.inlines, pp, ctx);
      const text = firstPart && heading ? plainText(p.inlines) : "";
      if (text) this.headingTexts.set(idx, text);
      html += `<div class="p" data-p="${idx}" style="${css}">${floats}${firstPart ? label : ""}${body}${this.markHtml(p.mark, pp)}</div>`;
    });
    return html;
  }

  private inlinesHtml(inlines: Inline[], pp: ParaProps, ctx: Ctx): { body: string; floats: string } {
    let body = "";
    let floats = "";
    for (const it of inlines) {
      switch (it.kind) {
        case "text":
          body += this.textHtml(it.text, it.rp, pp, it.link);
          break;
        case "tab": {
          const s = this.spanStyle(it.rp, "latin", true, it.link);
          const ptab = it.ptab ? ` data-ptab="${it.ptab.align}"${it.ptab.leader ? ` data-lead="${it.ptab.leader}"` : ""}` : "";
          body += this.span("tb", s, pp, "", ptab);
          break;
        }
        case "br":
          body += "<br>";
          break;
        case "field": {
          const s = this.spanStyle(it.rp, "latin", true, it.link);
          body += this.span("r f", s, pp, esc(it.field === "PAGE" ? "1" : it.text || "1"), ` data-fld="${it.field}"${it.format ? ` data-fmt="${it.format}"` : ""}`);
          break;
        }
        case "noteRef": {
          if (it.custom) break;
          const label = this.noteRef(it.note, it.id);
          const s = this.spanStyle(it.rp, "latin", true);
          body += this.span("r n", s, pp, esc(label), ` data-note="${it.note}:${it.id}"`);
          break;
        }
        case "noteMark": {
          const label = this.currentNoteLabel ?? "";
          if (label) {
            const s = this.spanStyle(it.rp, "latin", true);
            body += this.span("r", s, pp, esc(label));
          }
          break;
        }
        case "bookmark":
          body += `<span class="bm" data-bm="${esc(it.name)}"></span>`;
          break;
        case "check":
          body += this.textHtml(it.checked ? "☒" : "☐", { ...it.rp, fonts: { ascii: "Symbol Mapped", hAnsi: "Symbol Mapped" } }, pp);
          break;
        case "drawing": {
          const h = this.drawingHtml(it.d, ctx, it.link);
          if (h.float) floats += h.html;
          else body += h.html;
          break;
        }
      }
    }
    return { body, floats };
  }

  currentNoteLabel?: string;

  private noteRef(note: "footnote" | "endnote", id: string): string {
    const key = `${note}:${id}`;
    let label = this.noteLabel.get(key);
    if (label === undefined) {
      label = note === "footnote" ? formatNumber(this.footnoteCounter++, this.model.settings.footnoteFmt) : formatNumber(this.endnoteCounter++, this.model.settings.endnoteFmt);
      this.noteLabel.set(key, label);
      this.notes.push({ id, label, note });
    }
    return label;
  }

  /* ----- drawings */

  private drawingHtml(d: Drawing, ctx: Ctx, link?: Link): { html: string; float: boolean } {
    const pl = d.place;
    let mode: DrawInfo["mode"] = "inline";
    if (pl.mode === "anchor") {
      const paraRel = !pl.vRel || pl.vRel === "paragraph" || pl.vRel === "line";
      if ((pl.wrap === "square" || pl.wrap === "tight" || pl.wrap === "through") && paraRel && !pl.behind) mode = "float";
      else if (pl.wrap === "topAndBottom" && paraRel) mode = "block";
      else mode = "overlay";
    }
    this.resolveSize(d);
    const idx = this.draws.length;
    const info: DrawInfo = { d, mode, nodes: [] };
    this.draws.push(info);
    const inner = this.nodeHtml(d.node, info, true, !!d.autofit);
    const linkAttr = link ? ` data-l="${this.linkIndex(link)}"` : "";
    if (mode === "overlay") {
      // Drawn on the page where its anchor lands; its text is laid out on its own.
      this.overlays.set(idx, `<div class="ov" style="position:relative;width:${pt(d.w)};${d.autofit ? "" : `height:${pt(d.h)}`}">${inner}</div>`);
      return { html: `<span class="a" data-a="${idx}"></span>`, float: true };
    }
    const size = `width:${pt(d.w)};${d.autofit ? "" : `height:${pt(d.h)}`}`;
    const fix = Math.abs(this.paraFix) > 0.01 ? `;top:${pt(this.paraFix)}` : "";
    if (mode === "inline") return { html: `<span class="d" data-d="${idx}"${linkAttr} style="display:inline-block;position:relative;${size};vertical-align:baseline;text-indent:0;line-height:normal${fix}">${inner}</span>`, float: false };
    const dist = pl.dist;
    if (mode === "block") {
      const left = pl.hAlign === "center" ? "auto" : pl.hAlign === "right" ? "auto" : pt(Math.max(0, pl.hOffset ?? 0));
      const right = pl.hAlign === "center" || pl.hAlign === "left" ? "auto" : "0";
      return { html: `<span class="d" data-d="${idx}"${linkAttr} style="display:block;position:relative;${size};margin:${pt((pl.vOffset ?? 0) > 0 ? (pl.vOffset ?? 0) : 0)} ${pl.hAlign === "right" ? "0" : right} ${pt(dist.bottom ?? 0)} ${left};text-indent:0;line-height:normal">${inner}</span>`, float: true };
    }
    // Floats: left or right of the column, at the paragraph.
    const colW = ctx.width;
    const off = pl.hOffset ?? 0;
    const relLeft = pl.hRel === "page" ? off - (this.currentMarginLeft ?? 0) : pl.hRel === "leftMargin" ? off - (this.currentMarginLeft ?? 0) : off;
    const right = pl.hAlign === "right" || pl.hAlign === "outside" || (!pl.hAlign && relLeft + d.w / 2 > colW / 2);
    const mt = Math.max(0, pl.vOffset ?? 0);
    const side = right
      ? `float:right;margin:${pt(mt)} ${pt(pl.hAlign ? 0 : Math.max(0, colW - relLeft - d.w))} ${pt(dist.bottom ?? 0)} ${pt(dist.left ?? 9)}`
      : `float:left;margin:${pt(mt)} ${pt(dist.right ?? 9)} ${pt(dist.bottom ?? 0)} ${pt(pl.hAlign === "center" ? Math.max(0, (colW - d.w) / 2) : Math.max(0, pl.hAlign ? 0 : relLeft))}`;
    return { html: `<span class="d" data-d="${idx}"${linkAttr} style="position:relative;${size};${side};text-indent:0;line-height:normal">${inner}</span>`, float: true };
  }

  currentMarginLeft?: number;
  currentSect?: Section;
  overlays = new Map<number, string>();

  /** Relative sizes (a share of the page or margins) resolved against the current section. */
  private resolveSize(d: Drawing) {
    const s = this.currentSect;
    if (!s) return;
    const W = (rel: string) => (rel === "page" ? s.pageW : rel === "leftMargin" || rel === "insideMargin" ? s.margin.left : rel === "rightMargin" || rel === "outsideMargin" ? s.margin.right : s.pageW - s.margin.left - s.margin.right);
    const H = (rel: string) => (rel === "page" ? s.pageH : rel === "topMargin" ? s.margin.top : rel === "bottomMargin" ? s.margin.bottom : s.pageH - s.margin.top - s.margin.bottom);
    if (d.relW) {
      d.w = d.relW.pct * W(d.relW.rel);
      if (d.node.kind === "shape" || d.node.kind === "group") d.node.w = d.w;
    }
    if (d.relH && !d.autofit) {
      d.h = d.relH.pct * H(d.relH.rel);
      d.node.h = d.h;
    }
  }

  /** A drawing's shapes as positioned boxes; text boxes carry their paragraphs. */
  private nodeHtml(n: ShapeNode | GroupNode, info: DrawInfo, root: boolean, fit = false): string {
    const k = info.nodes.length;
    info.nodes.push(n);
    const pos = root ? "left:0;top:0;width:100%;height:100%" : `left:${pt(n.x)};top:${pt(n.y)};width:${pt(n.w)};height:${pt(n.h)}`;
    if (n.kind === "group") return `<div class="dn" data-n="${k}" style="position:absolute;${pos}">${n.children.map((c) => this.nodeHtml(c, info, false)).join("")}</div>`;
    if (fit && n.text && n.text.blocks.length) {
      // Sized by its text: the box flows, and its height comes from layout.
      const ins = n.text.insets;
      const w = Math.max(4, n.w - (ins.left ?? 0) - (ins.right ?? 0));
      const saved = { mark: this.markStyle, fix: this.paraFix };
      const inner = this.blocks(n.text.blocks, { width: w, inTable: false, part: "box" });
      this.markStyle = saved.mark;
      this.paraFix = saved.fix;
      return `<div class="dn" data-n="${k}" style="position:relative;width:100%"><div class="tx flow" style="position:relative;margin:${pt(ins.top ?? 0)} ${pt(ins.right ?? 0)} ${pt(ins.bottom ?? 0)} ${pt(ins.left ?? 0)};width:${pt(w)}">${inner}</div></div>`;
    }
    let text = "";
    if (n.text && n.text.blocks.length) {
      const ins = n.text.insets;
      const w = Math.max(4, n.w - (ins.left ?? 0) - (ins.right ?? 0));
      const jc = n.text.anchor === "ctr" ? "center" : n.text.anchor === "b" ? "flex-end" : "flex-start";
      // The text box's paragraphs must not disturb the paragraph that holds the drawing.
      const saved = { mark: this.markStyle, fix: this.paraFix };
      const inner = this.blocks(n.text.blocks, { width: w, inTable: false, part: "box" });
      this.markStyle = saved.mark;
      this.paraFix = saved.fix;
      text = `<div class="tx" style="position:absolute;left:${pt(ins.left ?? 0)};top:${pt(ins.top ?? 0)};width:${pt(w)};height:${pt(Math.max(0, n.h - (ins.top ?? 0) - (ins.bottom ?? 0)))};display:flex;flex-direction:column;justify-content:${jc}"><div class="flow">${inner}</div></div>`;
    }
    return `<div class="dn" data-n="${k}" style="position:absolute;${pos}">${text}</div>`;
  }

  /* ----- tables */

  table(t: Table, ctx: Ctx): string {
    const tp = t.tp;
    const nCols = Math.max(t.grid.length, ...t.rows.map((r) => (r.gridBefore ?? 0) + r.cells.reduce((s, c) => s + c.cp.span, 0) + (r.gridAfter ?? 0)));
    let grid = t.grid.slice(0, nCols);
    while (grid.length < nCols) grid.push(0);
    // Word sizes an autofit table by its cells' preferred widths; the stored grid is only
    // a cache, and documents made by other programs often leave it stale.
    if (tp.layout !== "fixed") {
      const full = t.rows.find((r) => !r.gridBefore && !r.gridAfter && r.cells.length === nCols && r.cells.every((c) => c.cp.span === 1 && c.cp.width && (c.cp.width.type === "dxa" || c.cp.width.type === "pct") && c.cp.width.value > 0));
      if (full) {
        const ws = full.cells.map((c) => (c.cp.width!.type === "dxa" ? c.cp.width!.value / 20 : (ctx.width * c.cp.width!.value) / 5000));
        const sum = ws.reduce((a, b) => a + b, 0);
        if (ws.some((w, i) => Math.abs(w - (grid[i] ?? 0)) > 1) && sum <= ctx.width * 1.5) grid = ws;
      }
    }
    if (!grid.some((g) => g > 0)) {
      // No grid: widths from the first row's cells, else equal.
      const first = t.rows[0];
      const ws: number[] = [];
      for (const c of first?.cells ?? []) {
        const w = c.cp.width?.type === "dxa" ? c.cp.width.value / 20 : c.cp.width?.type === "pct" ? (ctx.width * c.cp.width.value) / 5000 : 0;
        for (let i = 0; i < c.cp.span; i++) ws.push(w / c.cp.span);
      }
      grid = Array.from({ length: nCols }, (_, i) => ws[i] || ctx.width / nCols);
    } else if (grid.some((g) => g <= 0)) {
      const known = grid.filter((g) => g > 0);
      const avg = known.reduce((a, b) => a + b, 0) / Math.max(1, known.length);
      grid = grid.map((g) => (g > 0 ? g : avg));
    }
    let total = grid.reduce((a, b) => a + b, 0);
    if (tp.width?.type === "pct" && tp.width.value > 0) {
      const want = (ctx.width * (tp.width.value > 100 ? tp.width.value / 5000 : tp.width.value / 100));
      grid = grid.map((g) => (g * want) / total);
      total = want;
    } else if (tp.width?.type === "dxa" && tp.width.value > 0 && Math.abs(tp.width.value / 20 - total) > 2 && total > 0 && t.grid.length === 0) {
      grid = grid.map((g) => (g * tp.width!.value) / 20 / total);
      total = tp.width.value / 20;
    }
    // Word 2010 and older hang the table out by the first cell's left margin.
    const hang = this.model.settings.compatMode < 15 && tp.indent === undefined ? -(tp.cellMargins.left ?? 5.4) : 0;
    const indent = (tp.indent ?? 0) + hang;
    const align = tp.align === "center" ? "margin-left:auto;margin-right:auto" : tp.align === "right" || tp.align === "end" ? "margin-left:auto;margin-right:0" : `margin-left:${pt(indent)}`;
    const tIdx = this.boxes.length;
    this.boxes.push({ kind: "table" });
    let html = `<table class="t" data-x="${tIdx}" style="width:${pt(total)};${align};border-collapse:collapse;table-layout:fixed;border-spacing:0"><colgroup>${grid.map((g) => `<col style="width:${pt(g)}">`).join("")}</colgroup>`;
    // Vertical merges: a restart cell spans the continue cells under it.
    const starts = t.rows.map((r) => {
      let c = r.gridBefore ?? 0;
      return r.cells.map((cell) => {
        const s = c;
        c += cell.cp.span;
        return s;
      });
    });
    const rowspan = (ri: number, ci: number): number => {
      const col = starts[ri][ci];
      let n = 1;
      for (let r = ri + 1; r < t.rows.length; r++) {
        const j = starts[r].indexOf(col);
        if (j < 0 || t.rows[r].cells[j].cp.vMerge !== "continue") break;
        n++;
      }
      return n;
    };
    t.rows.forEach((row, ri) => {
      // Word gives every cell in a row the row's largest top and bottom cell margins.
      const padTop = Math.max(0, ...row.cells.map((c) => c.cp.margins.top ?? 0));
      const padBottom = Math.max(0, ...row.cells.map((c) => c.cp.margins.bottom ?? 0));
      for (const c of row.cells) c.cp.margins = { ...c.cp.margins, top: padTop, bottom: padBottom };
      const rIdx = this.boxes.length;
      this.boxes.push({ kind: "table", header: !!row.header, cantSplit: !!row.cantSplit });
      const h = row.height && row.height.value > 0 ? `height:${pt(row.height.value)}` : "";
      html += `<tr data-r="${rIdx}" style="${h}">`;
      if (row.gridBefore) html += `<td colspan="${row.gridBefore}" style="padding:0;border:none"></td>`;
      row.cells.forEach((cell, ci) => {
        if (cell.cp.vMerge === "continue") return;
        const span = cell.cp.vMerge === "restart" ? rowspan(ri, ci) : 1;
        const start = starts[ri][ci];
        const w = grid.slice(start, start + cell.cp.span).reduce((a, b) => a + b, 0);
        html += this.cell(cell, span, w, row.height?.rule === "exact" ? row.height.value : undefined);
      });
      if (row.gridAfter) html += `<td colspan="${row.gridAfter}" style="padding:0;border:none"></td>`;
      html += "</tr>";
    });
    return html + "</table>";
  }

  private borderCss(b: Border | undefined): string {
    if (!b || b.style === "none" || b.width <= 0) return "none";
    const style = /^double|triple|thinThick|thickThin/.test(b.style) ? "double" : /dot/.test(b.style) ? "dotted" : /dash/.test(b.style) ? "dashed" : "solid";
    const w = style === "double" ? Math.max(b.width * 3, 2.25) : b.width;
    return `${pt(w)} ${style} #${b.color}`;
  }

  private cell(cell: Cell, rowspan: number, width: number, exactH?: number): string {
    const cp = cell.cp;
    const m = cp.margins;
    const idx = this.boxes.length;
    const fill = cp.shading && cp.shading !== "none" ? cp.shading : undefined;
    this.boxes.push({ kind: "cell", fill, borders: cp.borders });
    const b = cp.borders;
    const va = cp.vAlign === "center" ? "middle" : cp.vAlign === "bottom" ? "bottom" : "top";
    const css = [
      `padding:${pt(m.top ?? 0)} ${pt(m.right ?? 5.4)} ${pt(m.bottom ?? 0)} ${pt(m.left ?? 5.4)}`,
      `border-top:${this.borderCss(b.top)}`,
      `border-bottom:${this.borderCss(b.bottom)}`,
      `border-left:${this.borderCss(b.left)}`,
      `border-right:${this.borderCss(b.right)}`,
      `vertical-align:${va}`,
      fill ? `background:#${fill}` : "",
      cp.noWrap ? "white-space:nowrap" : "",
    ]
      .filter(Boolean)
      .join(";");
    const inner = Math.max(4, width - (m.left ?? 5.4) - (m.right ?? 5.4));
    let content = this.blocks(cell.blocks.length ? cell.blocks : [{ kind: "p", pp: {}, mark: {}, inlines: [] }], { width: inner, inTable: true, part: "body" });
    if (exactH) content = `<div style="max-height:${pt(exactH)};overflow:hidden">${content}</div>`;
    return `<td class="c" data-x="${idx}"${cp.span > 1 ? ` colspan="${cp.span}"` : ""}${rowspan > 1 ? ` rowspan="${rowspan}"` : ""} style="${css}"><div class="flow">${content}</div></td>`;
  }

  /* ----- blocks */

  blocks(blocks: Block[], ctx: Ctx): string {
    let html = "";
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.kind === "tbl") {
        html += this.table(b, ctx);
        continue;
      }
      // Consecutive paragraphs with the same borders (or shading) share one box.
      const key = boxKey(b.pp);
      if (key) {
        let j = i;
        while (j + 1 < blocks.length && blocks[j + 1].kind === "p" && boxKey((blocks[j + 1] as Para).pp) === key) j++;
        const group = blocks.slice(i, j + 1) as Para[];
        html += this.borderGroup(group, ctx, blocks[i - 1], blocks[j + 1]);
        i = j;
        continue;
      }
      html += this.paragraph(b, ctx, blocks[i - 1], blocks[i + 1]);
    }
    return html;
  }

  private borderGroup(group: Para[], ctx: Ctx, prev: Block | undefined, next: Block | undefined): string {
    const pp = group[0].pp;
    const bd = pp.borders ?? {};
    const fill = pp.shading && pp.shading !== "none" ? pp.shading : undefined;
    const idx = this.boxes.length;
    const borders = { top: bd.top, bottom: bd.bottom, left: bd.left, right: bd.right, between: bd.between };
    this.boxes.push({ kind: "group", fill, borders });
    const sp = (b?: Border) => (b && b.style !== "none" ? b.space : 0);
    const bw = (b?: Border) => (b && b.style !== "none" ? b.width : 0);
    const first = this.spacing(group[0], prev, group[1] ?? next);
    const last = this.spacing(group[group.length - 1], group[group.length - 2] ?? prev, next);
    // Word draws paragraph borders outside the text by their spacing.
    const ml = (pp.indLeft ?? 0) - sp(bd.left) - bw(bd.left);
    const mr = (pp.indRight ?? 0) - sp(bd.right) - bw(bd.right);
    const css = [
      `margin:${pt(first.before)} ${pt(mr)} ${pt(last.after)} ${pt(ml)}`,
      `padding:${pt(sp(bd.top))} ${pt(sp(bd.right))} ${pt(sp(bd.bottom))} ${pt(sp(bd.left))}`,
      `border-top:${this.borderCss(bd.top)}`,
      `border-bottom:${this.borderCss(bd.bottom)}`,
      `border-left:${this.borderCss(bd.left)}`,
      `border-right:${this.borderCss(bd.right)}`,
      fill ? `background:#${fill}` : "",
      "display:flow-root",
    ]
      .filter(Boolean)
      .join(";");
    let inner = "";
    group.forEach((p, k) => {
      // Inside the box the indents are taken by the box itself.
      const q: Para = { ...p, pp: { ...p.pp, indLeft: 0, indRight: 0, spBefore: k === 0 ? 0 : p.pp.spBefore, spAfter: k === group.length - 1 ? 0 : p.pp.spAfter, spBeforeAuto: k === 0 ? false : p.pp.spBeforeAuto, spAfterAuto: k === group.length - 1 ? false : p.pp.spAfterAuto } };
      inner += this.paragraph(q, { ...ctx, width: ctx.width - ml - mr }, group[k - 1], group[k + 1]);
    });
    return `<div class="bx" data-x="${idx}" style="${css}">${inner}</div>`;
  }

  /* ----- whole parts */

  body(blocks: Block[], width: number, sect: Section): string {
    this.currentMarginLeft = sect.margin.left;
    this.currentSect = sect;
    return this.blocks(blocks, { width, inTable: false, part: "body" });
  }

  part(blocks: Block[], width: number, sect: Section): string {
    this.currentMarginLeft = sect.margin.left;
    this.currentSect = sect;
    return this.blocks(blocks, { width, inTable: false, part: "header" });
  }

  /** A short rule above endnotes (or footnotes): a box with a top border. */
  rule(width: number): string {
    const idx = this.boxes.length;
    this.boxes.push({ kind: "group", borders: { top: { style: "single", width: 0.5, color: "000000", space: 0 } } });
    return `<div class="bx" data-x="${idx}" style="margin:${pt(12)} 0 ${pt(6)};height:0;width:${pt(Math.min(144, width / 3))};border-top:${pt(0.5)} solid #000"></div>`;
  }

  note(blocks: Block[], width: number, label: string): string {
    this.currentNoteLabel = label;
    const html = this.blocks(blocks, { width, inTable: false, part: "note" });
    this.currentNoteLabel = undefined;
    return html;
  }
}

function boxKey(pp: ParaProps): string | null {
  const b = pp.borders;
  const has = (x?: Border) => !!x && x.style !== "none" && x.width > 0;
  const shaded = !!pp.shading && pp.shading !== "none";
  if (!b && !shaded) return null;
  if (b && !has(b.top) && !has(b.bottom) && !has(b.left) && !has(b.right) && !has(b.between) && !shaded) return null;
  return JSON.stringify([b?.top, b?.bottom, b?.left, b?.right, b?.between, shaded ? pp.shading : null, pp.indLeft ?? 0, pp.indRight ?? 0]);
}

function stripUndef<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in o) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export function plainText(inlines: Inline[]): string {
  return inlines
    .map((i) => (i.kind === "text" ? i.text : i.kind === "tab" ? " " : i.kind === "br" ? " " : ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
