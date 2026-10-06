/**
 * Text boxes for a slide rebuilt from a PDF page. The page's text is grouped the way it was set
 * (titles, paragraphs, bullet and numbered lists, labels, table cells), and each group becomes
 * one text box placed so its lines land where the PDF has them. Used by PDF → PowerPoint, over
 * a picture of the page without its text.
 *
 * Placement follows how PowerPoint lays out text, which doesn't depend on the font: a line is
 * 1.2 times its largest size tall at single spacing (or exactly the spacing set), and its
 * baseline sits a fifth of the size above the bottom of the line.
 */
import { PICTORIAL, spaced, type Dir, type PageText, type Shape } from "./pdfjs";
import { glyphW, linesOf, type Family, type Item, type SLine } from "./structure";
import type { PBullet, PPara, PRun, PText } from "./pptxwrite";

const LINE = 1.2;
const DESC = 0.2;

type Rect = { x: number; y: number; w: number; h: number };
/** A link on the page: where it is (visual frame) and where it goes. */
export type Link = Rect & { url: string };
export type SlideOpts = {
  /** The face to name for a PDF face (common faces keep their name, others get a close, widely installed one). */
  fontOf: (face?: string, family?: Family) => string;
  links?: Link[];
  /**
   * How wide a run's text is in its face (points), where that face can be measured. Lines are
   * then letter-spaced to keep the PDF's widths when the face differs from the PDF's.
   */
  measure?: (r: PRun, text: string) => number | undefined;
};

/**
 * A list marker at the start of a line: how PowerPoint should draw it, where it and the text
 * after it start, and how much of the line's text it is (none for a dot drawn as a shape).
 */
type Marker = { bullet: PBullet; x: number; tx: number; chars: number; num?: number; token?: string };

/** Text drawn with a line under it, or through it (the line drawn as a shape). */
const lined = new WeakMap<Item, "under" | "strike">();

/** A run of text on one line, set apart from anything else on that line by a wide gap. */
type Piece = {
  items: Item[];
  dir: Dir;
  x: number;
  x2: number;
  base: number;
  top: number;
  bottom: number;
  /** Size of most of the text, and the largest (which sets the line's height). */
  size: number;
  max: number;
  text: string;
  marker?: Marker;
  /** The drawn box (card, table cell, button) it sits in. */
  box?: Rect;
  /** Other text on the same baseline: a row of a table, or text set in columns. */
  row: boolean;
  /** Running text: several words, as in a paragraph (not a label or a figure). */
  long: boolean;
};

type Block = { pieces: Piece[]; dir: Dir; box?: Rect; open: boolean; list: boolean };

const median = (a: number[]) => {
  if (!a.length) return 0;
  const v = [...a].sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)];
};
const last = <T>(a: T[]) => a[a.length - 1];
/** Average, leaving out the highest and lowest where there are enough values to spare them. */
const mean = (a: number[]) => {
  const v = a.length >= 4 ? [...a].sort((x, y) => x - y).slice(1, -1) : a;
  return v.reduce((s, x) => s + x, 0) / (v.length || 1);
};

/* ------------------------------------------------------------- pieces */

const BULLETS = "•◦▪▫■□●○◆◇►▸▹‣⁃∙·–—*✓✔✗✘➢➤→⇒❖✦✱★☐☑❑❒-";

/** Width of a string in ems of a face like the item's (Helvetica or Times widths), for positions inside an item. */
const ems = (s: string, family: Item["family"]) => [...s].reduce((n, c) => n + glyphW(c, family), 0) / 1000;

/** Where character `k` of an item starts, from typical glyph widths fitted to the item's width. */
function xAt(it: Item, k: number): number {
  const all = ems(it.str, it.family) || 1;
  return it.x + (it.w * ems(it.str.slice(0, k), it.family)) / all;
}

const SCHEMES: [RegExp, string][] = [
  [/^\d{1,3}\.$/, "arabicPeriod"],
  [/^\d{1,3}\)$/, "arabicParenR"],
  [/^\(\d{1,3}\)$/, "arabicParenBoth"],
  [/^[ivxlc]{1,5}\.$/, "romanLcPeriod"],
  [/^[IVXLC]{1,5}\.$/, "romanUcPeriod"],
  [/^[ivxlc]{1,5}\)$/, "romanLcParenR"],
  [/^[a-z]\.$/, "alphaLcPeriod"],
  [/^[A-Z]\.$/, "alphaUcPeriod"],
  [/^[a-z]\)$/, "alphaLcParenR"],
  [/^[A-Z]\)$/, "alphaUcParenR"],
  [/^\([a-z]\)$/, "alphaLcParenBoth"],
];
const roman = (s: string) => {
  const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let n = 0;
  const t = s.toLowerCase();
  for (let i = 0; i < t.length; i++) n += v[t[i]] < (v[t[i + 1]] ?? 0) ? -v[t[i]] : v[t[i]];
  return n;
};
const numberOf = (token: string, scheme: string) => {
  const core = token.replace(/[().]/g, "");
  if (scheme.startsWith("arabic")) return parseInt(core, 10);
  if (scheme.startsWith("roman")) return roman(core);
  return core.toLowerCase().charCodeAt(0) - 96;
};

/** A bullet or number at the start of a piece, set apart from the text after it. */
function markerOf(p: Piece, o: SlideOpts): Marker | undefined {
  const k = p.items.findIndex((it) => it.str.trim());
  if (k < 0) return undefined;
  const it = p.items[k];
  const lead = it.str.length - it.str.trimStart().length;
  const s = it.str.trimStart();
  const token = s.split(/\s/)[0];
  const rest = s.slice(token.length);
  const alone = !rest.trim();
  const next = p.items.slice(k + 1).find((x) => x.str.trim());
  // Text after the marker: in the same item after a space, or the next item.
  if (alone && !next) return undefined;
  const tx = alone ? next!.x : xAt(it, lead + token.length + (rest.length - rest.trimStart().length));
  const gap = tx - (alone ? it.x + it.w : xAt(it, lead + token.length));
  const color = it.color?.replace("#", "").toUpperCase();
  const textSize = next && alone ? next.fontSize : it.fontSize;
  const sizePct = Math.round((it.fontSize / textSize) * 100);
  if (token.length === 1 && BULLETS.includes(token)) {
    // A hyphen, dash or star is a bullet before words (not "- 5" in a sum, or a dash between phrases).
    if ("-–—*".includes(token) && (gap < it.fontSize * 0.15 || !/^\s*[\p{L}"“‘(]/u.test(alone ? next!.str : rest))) return undefined;
    // Common bullets are in every text face; the rest (check marks, arrows) in the symbol face.
    const face = "•◦▪■□●○–—*-·∙".includes(token) ? "Arial" : "Segoe UI Symbol";
    return { bullet: { char: token, face, color, sizePct }, x: alone ? it.x : xAt(it, lead), tx, chars: lead + token.length };
  }
  for (const [re, scheme] of SCHEMES) {
    if (!re.test(token)) continue;
    // Letters and roman numerals read as words too ("I.", "A."): only with a clear gap, or set apart as their own item.
    if (!/^\(?\d/.test(token) && !alone && gap < it.fontSize * 0.45) return undefined;
    if (gap < it.fontSize * 0.15) return undefined;
    const num = numberOf(token, scheme);
    return { bullet: { auto: scheme, startAt: num, face: o.fontOf(it.face, it.family), color, sizePct: 100 }, x: alone ? it.x : xAt(it, lead), tx, chars: lead + token.length, num, token };
  }
  return undefined;
}

/** Where a gap before an item starts a new piece: wide, or before a list marker, or (`weak`) where other lines start text too. */
const MARKED = new RegExp(`^\\s*([${BULLETS.replace("-", "\\-")}]|\\(?\\d{1,2}[.)])\\s`);
const BREAK = (it: Item, gap: number) => gap > Math.max(it.fontSize * 0.8, 6) || (gap > it.fontSize * 0.4 && MARKED.test(it.str + " "));

/**
 * Split a line into pieces wherever a gap separates its text: a wide one, one before a bullet or
 * number, or one where `starts` (where pieces start on other lines, with how many) says a
 * column begins.
 */
function piecesOf(l: SLine, o: SlideOpts, starts?: Map<number, number>): Piece[] {
  const groups: Item[][] = [];
  let end = -Infinity;
  for (const it of l.items) {
    if (!it.str.trim()) {
      if (groups.length) last(groups).push(it);
      continue;
    }
    const gap = it.x - end;
    const column = !!starts && gap > it.fontSize * 0.4 && (starts.get(Math.round(it.x / 2)) ?? 0) + (starts.get(Math.round(it.x / 2) - 1) ?? 0) + (starts.get(Math.round(it.x / 2) + 1) ?? 0) >= 3;
    if (groups.length && !BREAK(it, gap) && !column) last(groups).push(it);
    else groups.push([it]);
    end = Math.max(end, it.x + it.w);
  }
  return groups.map((items) => {
    while (items.length && !last(items).str.trim()) items.pop();
    const ink = items.filter((i) => i.str.trim());
    const main = ink.filter((i) => !i.sup);
    const base = main.length ? main : ink;
    const sizes = new Map<number, number>();
    for (const i of base) sizes.set(Math.round(i.fontSize * 2) / 2, (sizes.get(Math.round(i.fontSize * 2) / 2) ?? 0) + i.str.trim().length);
    const size = [...sizes.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    const domItems = base.filter((i) => Math.abs(i.fontSize - size) < 0.6);
    let text = "";
    let prevEnd = -Infinity;
    for (const it of items) {
      if (spaced(text, it.str, it.x - prevEnd, it.fontSize)) text += " ";
      text += it.str;
      prevEnd = Math.max(prevEnd, it.x + it.w);
    }
    text = text.replace(/\s+/g, " ").trim();
    const p: Piece = {
      items,
      dir: l.dir,
      x: Math.min(...ink.map((i) => i.x)),
      x2: Math.max(...ink.map((i) => i.x + i.w)),
      base: median(domItems.map((i) => i.base)),
      top: Math.min(...base.map((i) => i.y)),
      bottom: Math.max(...base.map((i) => i.y + i.h)),
      size,
      max: Math.max(...base.map((i) => i.fontSize)),
      text,
      row: false,
      long: text.split(" ").length >= 5,
    };
    p.marker = markerOf(p, o);
    return p;
  });
}

/* ------------------------------------------------------------- grouping */

const center = (p: { x: number; x2: number }) => (p.x + p.x2) / 2;
const inside = (o: Rect, p: Piece, pad = 1.5) => p.x >= o.x - pad && p.x2 <= o.x + o.w + pad && p.top >= o.y - pad && p.bottom <= o.y + o.h + pad;

/** Where a list's item text starts, for the item a line would continue. */
function textStart(b: Block): number {
  for (let i = b.pieces.length - 1; i >= 0; i--) {
    const p = b.pieces[i];
    if (p.marker) return p.marker.tx;
  }
  return b.pieces[0].x;
}

/** How well piece p continues block b (lower is better), or null when it doesn't. */
function fits(b: Block, p: Piece, rules: Rect[]): number | null {
  const l = last(b.pieces);
  if (p.dir !== b.dir || p.box !== b.box) return null;
  const size = Math.max(l.size, p.size);
  const dy = p.base - l.base;
  if (dy < size * 0.75) return null;
  if (Math.abs(p.size - l.size) > Math.max(0.6, size * 0.12)) return null;
  // Spacing: like the block's own lines, or a paragraph's space more.
  const steps = b.pieces.slice(1).map((q, k) => q.base - b.pieces[k].base);
  const lead = steps.length ? Math.min(...steps) : undefined;
  if (lead !== undefined && dy < lead * 0.8 - 1) return null;
  if (dy > (lead !== undefined ? lead + Math.max(size, 10) : size * 2.1)) return null;
  if (p.x >= Math.max(...b.pieces.map((q) => q.x2)) || p.x2 <= Math.min(...b.pieces.map((q) => q.x))) return null;
  // A rule drawn between them separates them (rows of a table, sections).
  const x0 = Math.max(p.x, l.x);
  const x1 = Math.min(p.x2, l.x2);
  if (rules.some((r) => r.w > r.h && r.y >= l.bottom - 2 && r.y + r.h <= p.top + 2 && r.x < x1 && r.x + r.w > x0)) return null;
  // Cells of a table on consecutive rows stay apart; text in columns, and lists, don't.
  if (p.row && l.row && !b.list && !p.marker && !(p.long && l.long)) return null;
  const tol = Math.max(1.5, size * 0.15);
  const left = Math.min(...b.pieces.map((q) => (q.marker ? q.marker.x : q.x)));
  if (b.list || p.marker) {
    if (p.marker) {
      // Another item: its marker where the block's are, or further in (a nested item).
      const xs = b.pieces.map((q) => (q.marker ? q.marker.x : q.x));
      const near = Math.min(...xs.map((x) => Math.abs(x - p.marker!.x)));
      if (near <= tol) return dy + near;
      if (b.list && p.marker.x > left && p.marker.x < left + size * 8 && p.marker.x <= textStart(b) + tol) return dy + size;
      return null;
    }
    // A wrapped line of the last item, or a line set under the items' text.
    const tx = textStart(b);
    if (Math.abs(p.x - tx) <= tol) return dy + Math.abs(p.x - tx);
    return null;
  }
  if (Math.abs(p.x - left) <= tol) return dy + Math.abs(p.x - left);
  const lines = b.pieces;
  const sameLeft = lines.every((q) => Math.abs(q.x - lines[0].x) <= tol);
  if ((!sameLeft || lines.length === 1) && Math.abs(center(p) - center(l)) <= Math.max(2, size * 0.4) && lines.every((q) => Math.abs(center(q) - center(l)) <= Math.max(2, size * 0.4))) return dy + Math.abs(center(p) - center(l));
  if (Math.abs(p.x2 - l.x2) <= tol && lines.every((q) => Math.abs(q.x2 - l.x2) <= tol)) return dy + Math.abs(p.x2 - l.x2);
  return null;
}

function group(pieces: Piece[], rules: Rect[]): Block[] {
  const order = [...pieces].sort((a, b) => a.dir - b.dir || a.base - b.base || a.x - b.x);
  const blocks: Block[] = [];
  for (const p of order) {
    let best: Block | null = null;
    let score = Infinity;
    if (p.dir === 0)
      for (const b of blocks) {
        if (!b.open || b.dir !== p.dir) continue;
        const s = fits(b, p, rules);
        if (s !== null && s < score) [best, score] = [b, s];
      }
    // Text below a block's last line and across it closes the block: nothing further down joins it.
    for (const b of blocks) {
      if (b === best || !b.open || b.dir !== p.dir) continue;
      const l = last(b.pieces);
      if (l.base < p.base - p.size * 0.5 && p.x < Math.max(...b.pieces.map((q) => q.x2)) && p.x2 > Math.min(...b.pieces.map((q) => q.x))) b.open = false;
    }
    if (best) {
      best.pieces.push(p);
      if (p.marker) best.list = true;
    } else blocks.push({ pieces: [p], dir: p.dir, box: p.box, open: p.dir === 0, list: !!p.marker });
  }
  return blocks;
}

/* ------------------------------------------------------------- paragraphs */

type Para = { lines: Piece[]; marker?: Marker };

/** Whether the line before `next` stopped short of where the text could run: the first word of `next` would have fitted. */
function endedEarly(prev: Piece, next: Piece, measure: { left: number; right: number }, align: string): boolean {
  if (/[-­]$/.test(prev.text)) return false;
  const first = next.items.find((it) => it.str.trim());
  if (!first) return false;
  const str = first.str.trimStart();
  const word = str.split(/\s/)[0];
  const need = (first.w * word.length) / (str.length || 1) + next.size * 0.25 + 0.5;
  const room = align === "ctr" ? measure.right - measure.left - (prev.x2 - prev.x) : align === "r" ? prev.x - measure.left : measure.right - prev.x2;
  return room > need;
}

function paragraphs(b: Block, align: string): Para[] {
  const lines = b.pieces;
  const right = Math.max(...lines.map((q) => q.x2));
  const left = Math.min(...lines.map((q) => (q.marker ? q.marker.tx : q.x)));
  const steps = lines.slice(1).map((q, k) => q.base - lines[k].base);
  const lead = steps.length ? Math.min(...steps) : 0;
  const out: Para[] = [];
  lines.forEach((p, i) => {
    const prev = lines[i - 1];
    const fresh =
      !prev ||
      !!p.marker ||
      /:$/.test(prev.text) ||
      Math.abs(p.size - prev.size) > Math.max(0.6, p.size * 0.1) ||
      steps[i - 1] > lead * 1.2 + 1 ||
      (prev.row && p.row && !b.list && !(prev.long && p.long)) ||
      endedEarly(prev, p, { left, right }, align);
    if (fresh) out.push({ lines: [p], marker: p.marker });
    else last(out).lines.push(p);
  });
  return out;
}

/** How the block's lines line up: flush left, centred, flush right, or justified. */
function alignOf(b: Block, pt: { width: number }): "l" | "ctr" | "r" | "just" {
  const lines = b.pieces;
  const size = Math.max(...lines.map((q) => q.size));
  const tol = Math.max(1.5, size * 0.15);
  const box = b.box ?? (b.dir === 0 ? { x: 0, y: 0, w: pt.width, h: 0 } : undefined);
  if (lines.length === 1 || b.list) {
    if (b.list || !box) return "l";
    const l = lines[0];
    // A single line: as it sits in its box (or on the page).
    const c = box.x + box.w / 2;
    if (Math.abs(center(l) - c) <= Math.max(2, box.w * 0.015) && l.x - box.x > size) return "ctr";
    if (b.box && Math.abs(box.x + box.w - l.x2) < Math.abs(l.x - box.x) * 0.5 && l.x - box.x > box.w * 0.3) return "r";
    return "l";
  }
  const lefts = lines.every((q) => Math.abs(q.x - lines[0].x) <= tol);
  const rights = lines.every((q) => Math.abs(q.x2 - lines[0].x2) <= tol);
  const centers = lines.every((q) => Math.abs(center(q) - center(lines[0])) <= Math.max(2, size * 0.4));
  if (lefts) {
    // Justified: all but each paragraph's last line reach the same right edge.
    const right = Math.max(...lines.map((q) => q.x2));
    const full = lines.filter((q) => Math.abs(q.x2 - right) <= tol).length;
    return full >= 3 && full >= lines.length - 2 && !rights ? "just" : "l";
  }
  if (centers) return "ctr";
  if (rights) return "r";
  return "l";
}

/* ------------------------------------------------------------- runs */

const hex = (c?: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c.slice(1).toUpperCase() : "000000");

function runOf(it: Item, text: string, dom: number, o: SlideOpts, base: number): PRun {
  const r: PRun = { text, size: Math.round((it.sup ? dom : it.fontSize) * 20) / 20, face: o.fontOf(it.face, it.family), color: hex(it.color) };
  if (it.bold || (it.mode ?? 0) % 4 === 2) r.bold = true;
  if (it.italic) r.italic = true;
  // Raised text keeps the line's size (apps set it smaller themselves), raised as far as in the PDF.
  if (it.sup) r.baseline = Math.max(10, Math.min(60, Math.round(((base - it.base) / dom) * 100)));
  if (it.track) r.spc = Math.round(it.track * it.fontSize * 10) / 10;
  if (lined.get(it) === "under") r.underline = true;
  if (lined.get(it) === "strike") r.strike = true;
  const link = o.links?.find((k) => {
    const cx = it.bbox.x + it.bbox.w / 2;
    const cy = it.bbox.y + it.bbox.h / 2;
    return cx >= k.x && cx <= k.x + k.w && cy >= k.y && cy <= k.y + k.h;
  });
  if (link) r.link = link.url;
  return r;
}

const sameRun = (a: PRun, b: PRun) =>
  a.size === b.size && a.face === b.face && !!a.bold === !!b.bold && !!a.italic === !!b.italic && a.color === b.color && a.spc === b.spc && a.baseline === b.baseline && a.link === b.link && !!a.underline === !!b.underline && !!a.strike === !!b.strike && !b.br;

/** Styled runs of a line, from character `skip` of its first text item on (after a list marker). */
function lineRuns(p: Piece, o: SlideOpts, skip = 0): PRun[] {
  const runs: PRun[] = [];
  let text = "";
  let prevEnd = -Infinity;
  let skipping = skip;
  const k0 = p.items.findIndex((it) => it.str.trim());
  p.items.forEach((it, k) => {
    let s = it.str;
    if (k < k0) return;
    if (skipping > 0) {
      const cut = Math.min(skipping, s.length);
      skipping -= cut;
      s = s.slice(cut);
      if (!s.trim()) {
        prevEnd = it.x + it.w;
        return;
      }
      s = s.trimStart();
      text = "";
      prevEnd = -Infinity;
    }
    if (!s) return;
    const r = runOf(it, s, p.size, o, p.base);
    const l = last(runs);
    // A gap before this item is a space; it goes with the text before it (a link or an underline
    // starts at its first letter). A gap much wider than a space (a number set off from a heading)
    // keeps its width: a space of its own, spaced out.
    if (l && spaced(text, s, it.x - prevEnd, it.fontSize)) {
      const extra = it.x - prevEnd - (o.measure?.(l, " ") ?? l.size * 0.27);
      if (extra > Math.max(l.size, it.fontSize) * 0.25 && !/\s$/.test(l.text)) runs.push({ ...l, text: " ", spc: Math.round(extra * 100) / 100 });
      else l.text += " ";
      text += " ";
    }
    const m = last(runs);
    if (m && (sameRun(m, r) || !s.trim())) m.text += s;
    else if (m && !m.text.trim() && m.spc === undefined) {
      runs.pop();
      r.text = m.text + r.text;
      runs.push(r);
    } else runs.push(r);
    text += s;
    prevEnd = Math.max(prevEnd, it.x + it.w);
  });
  for (const r of runs) r.text = r.text.replace(/\s+/g, " ");
  if (runs.length) {
    runs[0].text = runs[0].text.trimStart();
    last(runs).text = last(runs).text.trimEnd();
  }
  return runs.filter((r) => r.text);
}

/** Append a wrapped line's runs to a paragraph, closing up words broken at a hyphen. */
function joinRuns(into: PRun[], add: PRun[]) {
  if (!add.length) return;
  const l = last(into);
  if (l && /[a-z]-$/.test(l.text) && /^[a-z]/.test(add[0].text)) l.text = l.text.slice(0, -1);
  else if (l && /[A-Za-z0-9]-$/.test(l.text) && /^[A-Za-z0-9]/.test(add[0].text)) {
    /* a word broken at its own hyphen: close up */
  } else if (l) l.text += " ";
  for (const r of add) {
    const m = last(into);
    if (m && sameRun(m, r)) m.text += r.text;
    else into.push({ ...r });
  }
}

/** Append a line's runs after a line break (a heading's lines as the PDF breaks them). */
function breakRuns(into: PRun[], add: PRun[]) {
  if (!add.length) return;
  const l = last(into);
  if (l) l.text = l.text.trimEnd();
  into.push({ ...add[0], text: add[0].text.trimStart(), br: true }, ...add.slice(1).map((r) => ({ ...r })));
}

/* ------------------------------------------------------------- boxes */

/**
 * Letter-spacing that keeps a paragraph's lines as long as in the PDF when the face named for
 * them sets wider or narrower (a web font replaced by a common one): measured from the face as
 * installed here, spread over the characters, and kept within what still reads well.
 */
function fitWidths(q: Para, perLine: PRun[][], o: SlideOpts, align: string) {
  if (!o.measure) return;
  let want = 0;
  let have = 0;
  let chars = 0;
  let size = 0;
  for (let k = 0; k < q.lines.length; k++) {
    // Justified lines are stretched to the measure: only the paragraph's last line has its own width.
    if (align === "just" && k < q.lines.length - 1) continue;
    const l = q.lines[k];
    const rs = perLine[k];
    if (!rs.length) continue;
    for (const r of rs) {
      const w = o.measure(r, r.text);
      if (w === undefined) return;
      const n = [...r.text].length;
      have += w + (r.spc ?? 0) * n;
      chars += n;
      size = Math.max(size, r.size);
    }
    want += l.x2 - (k === 0 && q.marker ? q.marker.tx : l.x);
  }
  // Within 1.5% (or half a point), the face is the PDF's own or one made to match it: it fits as
  // it is (apps measure a few tenths of a percent apart, which spacing would only add to).
  if (chars < 2 || have <= 0 || Math.abs(want - have) < Math.max(0.5, want * 0.015)) return;
  const add = Math.max(-0.05 * size, Math.min(0.3 * size, (want - have) / chars));
  for (const rs of perLine)
    for (const r of rs) {
      const v = Math.round(((r.spc ?? 0) + add) * 100) / 100;
      if (v) r.spc = v;
      else delete r.spc;
    }
}

/** Spacing for a paragraph whose lines sit `step` apart, at its largest size: a multiple of single spacing, or exact points where sizes are mixed. */
function spacingOf(step: number, max: number, min: number): NonNullable<PPara["spacing"]> {
  const pct = step / (LINE * max);
  // Tighter than single spacing, or sizes mixed: exact points, which every app places alike (some
  // move the first line up by their own rule for tight multiples). Otherwise a multiple, which
  // follows the size if it's changed, in whole percents (what some apps keep of it).
  if (max / min > 1.25 || pct < 0.995) return { pts: Math.round(step * 10) / 10 };
  return { pct: Math.round(pct * 100) / 100 };
}

function textBox(b: Block, pt: { width: number; height: number }, o: SlideOpts, others: Block[], body: number, col?: "l" | "ctr" | "r"): PText | null {
  const align = col ?? alignOf(b, pt);
  const paras = paragraphs(b, align);
  const lines = b.pieces;
  // Headings keep their lines as set: broken where the PDF breaks them, never wrapping on their
  // own (a face that sets wider then runs past the box instead of pushing a line down).
  const keep = !b.list && Math.max(...lines.map((q) => q.size)) >= Math.max(20, body * 1.3) && paras.every((q) => q.lines.length <= 3) && paras.some((q) => q.lines.length > 1);
  const maxOf = (p: Piece) => p.max;
  // Line spacing of wrapped lines (within paragraphs), and of the block's paragraphs.
  // (Averaged: line positions come rounded to a grid, so steps alternate, 14.25 then 15 for 14.6.)
  const wraps = paras.flatMap((q) => q.lines.slice(1).map((l, k) => l.base - q.lines[k].base));
  const wrapLead = wraps.length ? mean(wraps) : undefined;
  const out: PPara[] = [];
  const left = Math.min(...lines.map((q) => (q.marker ? q.marker.x : q.x)));
  let prevLast: Piece | null = null;
  for (const q of paras) {
    const first = q.lines[0];
    const max = Math.max(...q.lines.map(maxOf));
    const min = Math.min(...q.lines.map((l) => l.size));
    const own = q.lines.length > 1 ? mean(q.lines.slice(1).map((l, k) => l.base - q.lines[k].base)) : undefined;
    let step = own ?? wrapLead ?? LINE * max;
    let gap: number | undefined;
    if (prevLast) {
      // From the line above: this paragraph's first line, and any more as space before it.
      gap = first.base - prevLast.base + DESC * (first.max - prevLast.max);
      if (own === undefined && gap < step) step = gap;
    }
    const spacing = spacingOf(step, max, min);
    const before = gap === undefined ? 0 : Math.max(0, gap - lineHeight({ runs: [], spacing }, first.max));
    const runs: PRun[] = [];
    const perLine = q.lines.map((l, k) => lineRuns(l, o, k === 0 && q.marker ? q.marker.chars : 0));
    fitWidths(q, perLine, o, align);
    perLine.forEach((rs, k) => {
      if (k === 0) runs.push(...rs);
      else if (keep) breakRuns(runs, rs);
      else joinRuns(runs, rs);
    });
    if (!runs.length) continue;
    const para: PPara = { runs, align: b.list ? "l" : align, spacing, before: Math.round(before * 10) / 10 };
    if (q.marker) {
      para.marL = q.marker.tx - left;
      para.indent = q.marker.x - q.marker.tx;
      para.bullet = { ...q.marker.bullet };
      // "c." after "b." is a letter, not a roman hundred.
      const before = last(out)?.bullet;
      const t = q.marker.token ?? "";
      if (para.bullet.auto?.startsWith("roman") && before?.auto?.startsWith("alpha") && /^\(?[a-zA-Z][.)]$/.test(t) && before.auto.replace("alpha", "") === para.bullet.auto.replace("roman", ""))
        para.bullet = { ...para.bullet, auto: before.auto, startAt: t.replace(/[().]/g, "").toLowerCase().charCodeAt(0) - 96 };
    } else if (align === "l" || align === "just") {
      const restX = q.lines[1]?.x ?? first.x;
      para.marL = restX - left;
      para.indent = first.x - restX;
    }
    out.push(para);
    prevLast = last(q.lines);
  }
  if (!out.length) return null;
  // Numbered items: PowerPoint counts on through consecutive items with the same numbering, so
  // a run of items that count by one shares the first one's start; a break in the count (or a
  // paragraph between items) starts again at the item's own number.
  let prev: { scheme: string; n: number; start: number } | null = null;
  for (const p of out) {
    const bu = p.bullet;
    if (bu?.auto && bu.startAt !== undefined) {
      const n = bu.startAt;
      const start: number = prev && prev.scheme === bu.auto && n === prev.n + 1 ? prev.start : n;
      bu.startAt = start;
      prev = { scheme: bu.auto, n, start };
    } else prev = null;
  }

  // Vertical: the first baseline sits (line height − descent) below the box's top.
  const f = lines[0];
  const p0 = out[0];
  const firstLine = lineHeight(p0, f.max);
  const top = f.base - (firstLine - DESC * f.max);
  const l = last(lines);
  const bottom = l.base + DESC * l.max;

  // Horizontal: wide enough for every line, and narrow enough to wrap where the PDF did.
  const right = Math.max(...lines.map((q) => q.x2));
  const wrapped = paras.some((q) => q.lines.length > 1);
  const size = Math.max(...lines.map((q) => q.size));
  if ((lines.length === 1 && !b.list) || keep) {
    // Lines that don't wrap: their alignment holds them in place if the face runs wider or narrower.
    const x = align === "l" ? left : Math.min(...lines.map((q) => q.x));
    if (x !== left) for (const p of out) if (p.marL !== undefined) p.marL += left - x;
    return { kind: "text", x, y: top, w: Math.max(1, right - x), h: bottom - top, wrap: false, paras: out };
  }
  let x0 = left;
  let x1 = right;
  if (wrapped) {
    // Lines flush left wrap at the box's right edge; centred and flush-right lines at its width.
    const flush = align === "l" || align === "just";
    const need = flush ? right - left : Math.max(...lines.map((q) => q.x2 - q.x));
    // A line that wrapped had no room for the next line's first word: that caps the width.
    let cap = Infinity;
    for (const q of paras)
      q.lines.slice(1).forEach((nl, k) => {
        const pl = q.lines[k];
        const it = nl.items.find((i) => i.str.trim());
        if (!it) return;
        const s = it.str.trimStart();
        const word = (it.w * s.split(/\s/)[0].length) / (s.length || 1);
        cap = Math.min(cap, (flush ? pl.x2 - left : pl.x2 - pl.x) + nl.size * 0.25 + word);
      });
    // A little more than the longest line, for a face that runs a little wider (but short of the
    // cap, as estimated). Justified lines fill the measure exactly: any more and words move up.
    const w = align === "just" ? need + 0.3 : Math.max(need + 0.5, Math.min(need * 1.04 + 1, cap - Math.max(1, size * 0.15)));
    if (align === "ctr") {
      const c = (Math.min(...lines.map((q) => q.x)) + right) / 2;
      x0 = c - w / 2;
      x1 = c + w / 2;
    } else if (align === "r") x0 = right - w;
    else x1 = x0 + w;
  } else {
    // Nothing wraps: leave room for a wider face, up to the next text or the page's edge.
    const grow = Math.max(4, (right - left) * 0.12);
    const wall = (dir: 1 | -1) => {
      let lim = dir > 0 ? pt.width : 0;
      for (const ob of others) {
        if (ob === b || ob.dir !== 0) continue;
        for (const q of ob.pieces) {
          if (q.bottom < top || q.top > bottom) continue;
          if (dir > 0 && q.x >= right) lim = Math.min(lim, q.x - 2);
          if (dir < 0 && q.x2 <= left) lim = Math.max(lim, q.x2 + 2);
        }
      }
      if (b.box) lim = dir > 0 ? Math.min(lim, b.box.x + b.box.w) : Math.max(lim, b.box.x);
      return lim;
    };
    if (align === "r") x0 = Math.min(left, Math.max(wall(-1), left - grow));
    else if (align === "ctr") {
      const g = Math.max(0, Math.min(grow, wall(1) - right, left - wall(-1)));
      x0 = left - g;
      x1 = right + g;
    } else x1 = Math.max(right, Math.min(wall(1), right + grow));
  }
  // Flush-left text measures its indents from the box's left edge.
  if (x0 !== left) for (const p of out) if (p.marL !== undefined) p.marL += left - x0;
  return { kind: "text", x: x0, y: top, w: Math.max(1, x1 - x0), h: Math.max(1, bottom - top), wrap: true, paras: out };
}

/** Height PowerPoint gives a paragraph's first line. */
function lineHeight(p: PPara, max: number): number {
  const sp = p.spacing;
  if (sp && "pts" in sp) return sp.pts;
  return LINE * max * (sp && "pct" in sp ? sp.pct : 1);
}

/** A single rotated line: its box in its own frame, turned about its centre to where the text runs. */
function turned(p: Piece, o: SlideOpts): PText | null {
  const runs = lineRuns(p, o);
  if (!runs.length) return null;
  const it = p.items.find((i) => i.str.trim()) ?? p.items[0];
  const h = LINE * p.max;
  const w = p.x2 - p.x;
  // Upright frame → page: the text's direction and its "down" (see pageText).
  const ax = it.ax;
  const ay = it.ay;
  // Start of the line's baseline on the page: from the first item's origin, back to the line's left end.
  const back = it.x - p.x;
  const ox = it.ox - ax * back;
  const oy = it.oy - ay * back;
  // Centre in the text's frame: halfway along, and between the top and bottom of the line box.
  const down = DESC * p.max - h / 2;
  const cx = ox + ax * (w / 2) + -ay * down;
  const cy = oy + ay * (w / 2) + ax * down;
  const rot = (Math.atan2(ay, ax) * 180) / Math.PI;
  return { kind: "text", x: cx - w / 2, y: cy - h / 2, w: Math.max(1, w), h, rot: Math.round(rot * 100) / 100, wrap: false, paras: [{ runs, align: "l", spacing: { pct: 1 }, before: 0 }] };
}

/* ------------------------------------------------------------- page */

/** Whether a text item becomes editable text: drawn (not invisible or only outlined) and made of real characters. */
function editable(it: Item): boolean {
  const m = it.mode ?? 0;
  if (m === 1 || m === 3 || m === 5) return false;
  return !PICTORIAL.test(it.str);
}

/**
 * A dot or square drawn just before a line's text (how browsers draw list bullets): a bullet
 * PowerPoint draws itself, in the same colour and about the same size.
 */
function drawnMarker(p: Piece, marks: Shape[]): (Marker & { shape: Shape }) | undefined {
  let best: Shape | undefined;
  for (const s of marks) {
    const gap = p.x - (s.x + s.w);
    const cy = s.y + s.h / 2;
    if (gap < p.size * 0.1 || gap > p.size * 2.2) continue;
    if (s.w > p.size * 0.7 || s.h > p.size * 0.7) continue;
    if (cy < p.base - p.size * 0.7 || cy > p.base) continue;
    if (!best || s.x > best.x) best = s;
  }
  if (!best) return undefined;
  const filled = !!best.fill;
  const char = best.round ? (filled ? "\u2022" : "\u25E6") : filled ? "\u25AA" : "\u25A1";
  // How wide each of these is in Arial, as a fraction of the size: sized to match the drawn one.
  const across = best.round ? (filled ? 0.271 : 0.242) : filled ? 0.248 : 0.598;
  const pct = Math.round((Math.max(best.w, best.h) / (p.size * across)) * 100);
  const color = (best.fill ?? best.stroke)?.replace("#", "").toUpperCase();
  return { bullet: { char, face: "Arial", color, sizePct: Math.max(40, Math.min(250, pct)) }, x: best.x, tx: p.x, chars: 0, shape: best };
}

/**
 * Lines drawn under text (links, underlined words) or through it, as the text's own
 * underline or strikethrough: they then move with the text. Returns the lines taken.
 */
function textLines(pieces: Piece[], rules: Shape[]): Shape[] {
  const taken: Shape[] = [];
  for (const r of rules) {
    const y = r.y + r.h / 2;
    for (const p of pieces) {
      if (p.dir !== 0 || r.x < p.x - p.size * 0.6 || r.x + r.w > p.x2 + p.size * 0.6) continue;
      const kind = y > p.base - p.size * 0.05 && y < p.base + p.size * 0.3 ? "under" : y > p.base - p.size * 0.45 && y < p.base - p.size * 0.15 ? "strike" : null;
      if (!kind || r.h > Math.max(2.5, p.size * 0.15)) continue;
      const hit = p.items.filter((it) => it.str.trim() && Math.min(it.x + it.w, r.x + r.w) - Math.max(it.x, r.x) >= it.w * 0.6);
      if (!hit.length) continue;
      for (const it of hit) lined.set(it, kind);
      // Spaces between underlined words are underlined too.
      p.items.forEach((it, k) => {
        if (!it.str.trim() && lined.get(p.items[k - 1]) === kind && lined.get(p.items[k + 1]) === kind) lined.set(it, kind);
      });
      taken.push(r);
      break;
    }
  }
  return taken;
}

/**
 * How a lone line lines up with the text above and below it in the same column (figures in a
 * table set flush right, labels centred under bars), when that says more than its box does.
 */
function columnAlign(p: Piece, pieces: Piece[]): "l" | "ctr" | "r" | undefined {
  const tol = Math.max(1.5, p.size * 0.15);
  let L = 0;
  let R = 0;
  let C = 0;
  for (const q of pieces) {
    if (q === p || q.dir !== p.dir || Math.abs(q.base - p.base) < p.size) continue;
    const ov = Math.min(p.x2, q.x2) - Math.max(p.x, q.x);
    if (ov < Math.min(p.x2 - p.x, q.x2 - q.x) * 0.5) continue;
    const l = Math.abs(q.x - p.x) <= tol;
    const r = Math.abs(q.x2 - p.x2) <= tol;
    const c = Math.abs(center(q) - center(p)) <= tol;
    if (l && r) continue;
    if (l) L++;
    else if (r) R++;
    else if (c) C++;
  }
  if (R > L && R >= C) return "r";
  if (C > L && C > R) return "ctr";
  return L ? "l" : undefined;
}

/**
 * Text boxes for one page, and the shapes they take over from the page's picture (bullets and
 * underlines drawn as shapes, which the text now draws itself). `shapes`: the boxes and rules
 * drawn on the page (from enrichFontStyles).
 */
export function slideTexts(pt: PageText, shapes: Shape[], o: SlideOpts): { texts: PText[]; erase: Rect[] } {
  const items = pt.items
    .filter(editable)
    .map((it) => ({ ...it, str: it.str.replace(/[\uE000-\uF8FF\uFFFD]/g, "") }))
    .filter((it) => it.str.length) as Item[];
  if (!items.some((it) => it.str.trim())) return { texts: [], erase: [] };
  const lines = linesOf(items, pt);
  // Where pieces start, line by line: text that starts where other lines' text does begins a column.
  const starts = new Map<number, number>();
  for (const l of lines) for (const p of piecesOf(l, o)) starts.set(Math.round(p.x / 2), (starts.get(Math.round(p.x / 2)) ?? 0) + 1);
  const pieces = lines.flatMap((l) => piecesOf(l, o, starts)).filter((p) => p.text);
  const erase: Rect[] = [];
  const marks = shapes.filter((s) => (s.fill || s.stroke) && s.w >= 1.2 && s.h >= 1.2 && s.w <= 16 && s.h <= 16 && Math.abs(s.w - s.h) <= Math.max(s.w, s.h) * 0.35);
  for (const p of pieces)
    if (!p.marker && p.dir === 0) {
      const m = drawnMarker(p, marks);
      if (m) {
        p.marker = m;
        erase.push(m.shape);
      }
    }
  const thin = shapes.filter((s) => s.h <= 3 && s.w >= 3 && s.w > s.h * 3 && !erase.includes(s));
  const taken = new Set(textLines(pieces, thin));
  erase.push(...taken);
  const boxes = shapes.filter((s) => (s.fill || s.stroke) && s.w > 6 && s.h > 6 && !(s.w > pt.width * 0.95 && s.h > pt.height * 0.95));
  const rules = shapes.filter((s) => ((s.h <= 3 && s.w > 8) || (s.w <= 3 && s.h > 8)) && !taken.has(s));
  for (const p of pieces) {
    p.row = pieces.some((q) => q !== p && q.dir === p.dir && Math.abs(q.base - p.base) < Math.max(2, p.size * 0.3) && (q.x2 < p.x || q.x > p.x2));
    if (p.dir === 0) {
      let best: Rect | undefined;
      for (const s of boxes) if (inside(s, p) && (!best || s.w * s.h < best.w * best.h)) best = s;
      p.box = best;
    }
  }
  const blocks = group(pieces, rules);
  // The page's running text size (most characters), to tell headings by.
  const bySize = new Map<number, number>();
  for (const p of pieces) bySize.set(p.size, (bySize.get(p.size) ?? 0) + p.text.length);
  const body = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 12;
  const texts: PText[] = [];
  for (const b of blocks) {
    const upright = b.dir === 0 && Math.abs(b.pieces[0].items[0].ay) < 0.02;
    if (upright) {
      const t = textBox(b, pt, o, blocks, body, b.pieces.length === 1 && !b.list ? columnAlign(b.pieces[0], pieces) : undefined);
      if (t) texts.push(t);
      continue;
    }
    // Turned text: a box for each line (only upright text is grouped).
    for (const p of b.pieces) {
      const r = turned(p, o);
      if (r) texts.push(r);
    }
  }
  // Reading order (what a screen reader or the selection pane follows): the slide's title, its
  // largest text in the top third, first; then top to bottom.
  const sizeOf = (t: PText) => Math.max(0, ...t.paras.flatMap((p) => p.runs.map((r) => r.size)));
  const head = texts.filter((t) => !t.rot && t.y < pt.height / 3).reduce<PText | null>((a, t) => (!a || sizeOf(t) > sizeOf(a) ? t : a), null);
  if (head && sizeOf(head) > body) {
    texts.splice(texts.indexOf(head), 1);
    texts.unshift(head);
  }
  return { texts, erase };
}
