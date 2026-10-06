/**
 * Recover document structure from positioned PDF text and the shapes drawn around it:
 * headings, paragraphs, lists (bulleted, numbered, lettered, check lists, nested lists and
 * lists set in columns), tables (ruled or aligned), boxed callouts and grids of cards, with
 * running headers, footers and page numbers removed. Text keeps its font, size and colour.
 * Used by PDF → Word / HTML / EPUB / Markdown / Excel.
 */
import { toLines, type Line, type PageText, type Shape, type TextItem } from "./pdfjs";

export type Family = "sans" | "serif" | "mono";
export type Run = {
  text: string;
  bold: boolean;
  italic: boolean;
  /** Font size in points. */
  size?: number;
  /** Text colour, #rrggbb. */
  color?: string;
  /** Font family name as the PDF gives it, and what kind of face it is. */
  face?: string;
  family?: Family;
  /** Raised text: footnote markers, exponents. */
  sup?: boolean;
  /** Background drawn behind the text (a badge or highlight), #rrggbb. */
  bg?: string;
  /** Starts a new line (a line break the author set, inside a heading). */
  br?: boolean;
};
/** One table cell: its paragraphs (each a list of styled runs) and the plain text. Cards also carry their blocks. */
export type Cell = {
  paras: Run[][];
  text: string;
  blocks?: SBlock[];
  fill?: string;
  stroke?: string;
  /** Spacing of the paragraphs: gap after each one, and baseline-to-baseline spacing inside each (points). */
  geo?: { gaps: number[]; leadings: (number | undefined)[]; sizes: number[] };
  /** Text set flush right or centred in its column. */
  align?: "right" | "center";
};
/**
 * Where a block sits, in points: the top of its first line (or its box) and the bottom of its
 * last, the sizes of those lines (0 for a box or table edge), baseline-to-baseline spacing
 * inside it, and the gap below it, to the next block or to the edge of the box it is in.
 */
export type Geo = { top: number; bottom: number; first: number; last: number; leading?: number; gap?: number; next?: number };
/** How a list level is numbered: Word's number format, the text around the number, and the first value. */
export type ListFormat = {
  kind: "bullet" | "check" | "decimal" | "lowerLetter" | "upperLetter" | "lowerRoman" | "upperRoman";
  before: string;
  after: string;
  start: number;
  /** The bullet character, for bullet lists. */
  bullet?: string;
  /** How the number or bullet is set (size in points, colour, weight, face). */
  run?: { size: number; color?: string; bold: boolean; face?: string; family?: Family };
  /** Indent of the item text from the left edge, and how far the marker hangs before it (points). */
  indent?: { left: number; hanging: number };
};
export type SBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string; runs: Run[]; size: number; page: number; geo?: Geo }
  | {
      kind: "para";
      runs: Run[];
      page: number;
      align?: "left" | "center" | "right" | "justify";
      /** Indents from the edges of the text, and of the first line (negative: it hangs out), in points. */
      indent?: { left: number; first: number; right?: number };
      bar?: string;
      keep?: boolean;
      geo?: Geo;
    }
  | {
      kind: "list";
      ordered: boolean;
      items: Run[][];
      /** Nesting level of each item (0 = top). */
      levels: number[];
      /** Numbering of each level. */
      formats: ListFormat[];
      /** Set in this many columns, read down each column in turn. */
      columns?: number;
      /** Gap after each item (points). */
      gaps?: number[];
      /** A rule drawn below an item: its colour and how far below the item's text it runs (points). */
      rules?: ({ color: string; at: number; h: number } | null)[];
      page: number;
      geo?: Geo;
    }
  | {
      kind: "table";
      /** Plain text of each cell; paragraphs inside a cell are separated by "\n". */
      rows: string[][];
      cells: Cell[][];
      /** The first row is a header row. */
      header: boolean;
      /** Relative column widths, summing to 1. */
      widths: number[];
      /** Lines drawn in the PDF: rules between rows, a full grid, or separate cards. Missing: none drawn. */
      lines?: "rows" | "grid" | "cards";
      lineColor?: string;
      /** For ruled rows: the colour of the rule above each row and, last, below the table (null: none). */
      rowRules?: (string | null)[];
      /** Space between a cell's edge and its text, and baseline-to-baseline spacing of cell text (points). */
      pad?: { x: number; y: number };
      leading?: number;
      /** Keep the table on one page (and with what follows), as the box it came in. */
      keep?: boolean;
      page: number;
      geo?: Geo;
    }
  | { kind: "box"; blocks: SBlock[]; fill?: string; stroke?: string; pad?: { x: number; y: number }; page: number; geo?: Geo }
  /** Text set in columns, read down each column in turn (`starts`: where each column begins on the page). */
  | { kind: "columns"; count: number; blocks: SBlock[]; page: number; geo?: Geo; starts?: number[] }
  /** `deliberate`: the page ended early on purpose (a new chapter), not because it was full. */
  | { kind: "pagebreak"; page: number; deliberate?: boolean };

/** The document's running text: size, face and colour, line spacing and space between paragraphs (points). */
export type BodyStyle = { size: number; face?: string; family?: Family; color?: string; leading?: number; paraGap?: number };
/** Page size and the margins around the content, in points. */
export type PageLayout = { width: number; height: number; top: number; right: number; bottom: number; left: number };
/** One line of a running header or footer: its pieces by position ("{PAGE}" and "{PAGES}" stand for page numbers), and its look. */
export type FurnitureLine = { parts: { text: string; at: "left" | "center" | "right" }[]; size: number; color?: string; face?: string; family?: Family; bold: boolean; /** Distance from the top of the page (header) or the bottom (footer), points. */ edge: number };
/** Running header and footer lines, as they appear on the pages. */
export type Furniture = { header: FurnitureLine[]; footer: FurnitureLine[] };

export type Segment = { text: string; x: number; x2: number; items: TextItem[] };

/** Split a line into cells wherever there is a wide horizontal gap. */
export function segments(line: Line): Segment[] {
  const groups: TextItem[][] = [];
  let end = -Infinity;
  for (const it of line.items) {
    if (!it.str.trim()) continue;
    const gapLimit = Math.max(it.fontSize * 1.3, 9);
    if (groups.length && it.x - end <= gapLimit) groups[groups.length - 1].push(it);
    else {
      groups.push([it]);
      end = -Infinity;
    }
    end = Math.max(end, it.x + it.w);
  }
  return groups.map(segmentOf).filter((s) => s.text);
}

function segmentOf(items: TextItem[]): Segment {
  let text = "";
  let x2 = -Infinity;
  for (const it of items) {
    if (text && it.x - x2 > it.fontSize * 0.18 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
    text += it.str;
    x2 = Math.max(x2, it.x + it.w);
  }
  return { text: text.replace(/\s+/g, " ").trim(), x: items[0].x, x2, items };
}

/** Column starts shared by a set of rows (simple 1-D clustering). */
export function columnStarts(rows: Segment[][], tol = 10): number[] {
  const xs = rows.flatMap((r) => r.map((s) => s.x)).sort((a, b) => a - b);
  const cols: { x: number; n: number }[] = [];
  for (const x of xs) {
    const c = cols[cols.length - 1];
    if (c && x - c.x <= tol) {
      c.x = (c.x * c.n + x) / (c.n + 1);
      c.n++;
    } else cols.push({ x, n: 1 });
  }
  return cols.map((c) => c.x);
}

/* ------------------------------------------------------------- helpers */

const median = (a: number[]) => {
  if (!a.length) return 0;
  const v = [...a].sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)];
};
const half = (n: number) => Math.round(n * 2) / 2;
/** Relative luminance of #rrggbb, 0 (black) to 1 (white). */
export function luminance(hex?: string): number {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return 0;
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
const isWhite = (hex?: string) => luminance(hex) > 0.985;
function mode<T>(entries: Iterable<[T, number]>): T | undefined {
  let best: T | undefined;
  let n = -1;
  for (const [k, c] of entries) if (c > n) [best, n] = [k, c];
  return best;
}
const tally = <T>(m: Map<T, number>, k: T, n: number) => m.set(k, (m.get(k) ?? 0) + n);

type Rect = { x: number; y: number; w: number; h: number };
type Rule = Rect & { color?: string };
type Box = Rect & { fill?: string; stroke?: string };
/** A drawn list marker: an empty square (check box), or a bullet (a dot, ring or small square). */
type Mark = Rect & { check: boolean; bullet: string };
/** A text item as used here: may be raised (superscript) or sit on a drawn badge. */
type Item = TextItem & { sup?: boolean; bg?: string };
type SLine = Omit<Line, "items"> & { items: Item[]; dom: number; domBase: number; /** Column it was read from, for text set in columns. */ col?: number };

const centerIn = (r: Rect, x: number, y: number, pad = 1) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
const itemCenter = (it: TextItem): [number, number] => [it.x + it.w / 2, it.base - it.fontSize * 0.3];
const contains = (o: Rect, i: Rect, pad = 1.5) => i.x >= o.x - pad && i.y >= o.y - pad && i.x + i.w <= o.x + o.w + pad && i.y + i.h <= o.y + o.h + pad;
const chars = (s: string) => s.replace(/\s/g, "").length;

/* ------------------------------------------------------------- lines */

/** Dominant (most characters) size of a line, ignoring raised text, and the baseline of that text. */
function setDom(l: SLine) {
  const w = new Map<number, number>();
  for (const it of l.items) if (!it.sup) tally(w, half(it.fontSize), chars(it.str));
  let dom = half(l.size);
  let best = 0;
  for (const [k, n] of w) if (n > best || (n === best && k > dom)) [dom, best] = [k, n];
  l.dom = dom;
  const bases = l.items.filter((it) => !it.sup && Math.abs(half(it.fontSize) - dom) < 0.6 && it.str.trim()).map((it) => it.base);
  l.domBase = bases.length ? median(bases) : l.base;
}

/** Recompute a line's text and geometry after items were added or marked raised. */
function relayout(l: SLine) {
  l.items.sort((a, b) => a.x - b.x);
  let text = "";
  let prevEnd = -Infinity;
  for (const it of l.items) {
    if (text && it.x - prevEnd > it.fontSize * 0.18 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
    text += it.str;
    prevEnd = Math.max(prevEnd, it.x + it.w);
  }
  l.text = text.replace(/\s+/g, " ").trim();
  const main = l.items.filter((i) => !i.sup);
  const base = main.length ? main : l.items;
  l.x = Math.min(...l.items.map((i) => i.x));
  l.w = Math.max(...l.items.map((i) => i.x + i.w)) - l.x;
  l.y = Math.min(...base.map((i) => i.y));
  l.h = Math.max(...base.map((i) => i.y + i.h)) - l.y;
  l.base = base.reduce((s, i) => s + i.base, 0) / base.length;
  const weight = (pred: (i: Item) => boolean) => base.filter(pred).reduce((n, i) => n + i.str.length, 0);
  const total = weight(() => true) || 1;
  l.size = base.reduce((s, i) => s + i.fontSize * i.str.length, 0) / total;
  l.bold = weight((i) => i.bold) / total > 0.6;
  l.italic = weight((i) => i.italic) / total > 0.6;
  setDom(l);
}

/**
 * Lines of a set of items, with superscripts (footnote markers set smaller and raised, which
 * PDF.js may report as lines of their own) attached to the line they belong to.
 */
function linesOf(items: Item[], pt: { page: number; width: number; height: number }): SLine[] {
  const lines = toLines({ page: pt.page, width: pt.width, height: pt.height, items }) as SLine[];
  for (const l of lines) setDom(l);
  // Raised text sits right after (or right before) a word of the text it belongs to.
  const besideText = (h: SLine, x0: number, x1: number) =>
    h.items.some((o) => !o.sup && o.str.trim() && Math.abs(half(o.fontSize) - h.dom) < 0.6 && ((x0 - (o.x + o.w) > -1 && x0 - (o.x + o.w) < h.dom * 0.6) || (o.x - x1 > -1 && o.x - x1 < h.dom * 0.6)));
  const out: SLine[] = [];
  const touched = new Set<SLine>();
  for (const l of lines) {
    const t = l.text.replace(/\s/g, "");
    if (t.length <= 6 && /^[\d,*†‡§¶a-z]+$/i.test(t)) {
      const host = lines.find(
        (h) =>
          h !== l &&
          l.dom <= h.dom * 0.82 &&
          l.base < h.domBase - h.dom * 0.12 &&
          l.base > h.domBase - h.dom * 0.75 &&
          besideText(h, l.x, l.x + l.w),
      );
      if (host) {
        for (const it of l.items) host.items.push({ ...it, sup: true });
        touched.add(host);
        continue;
      }
    }
    out.push(l);
  }
  for (const l of out) {
    let raised = false;
    for (const it of l.items) {
      if (!it.sup && it.str.trim() && it.fontSize <= l.dom * 0.82 && it.base < l.domBase - l.dom * 0.15 && chars(it.str) <= 6 && besideText(l, it.x, it.x + it.w)) {
        it.sup = true;
        raised = true;
      }
    }
    if (raised || touched.has(l)) relayout(l);
  }
  // A raised item next to a following space: let the space belong to the text after it.
  for (const l of out)
    l.items.forEach((it, k) => {
      if (!it.str.trim() && l.items[k - 1]?.sup) it.sup = false;
    });
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/* ------------------------------------------------------------- runs */

function itemRun(it: Item, text: string, dom?: number): Run {
  const r: Run = { text, bold: it.bold, italic: it.italic, size: half(it.sup && dom ? dom : it.fontSize) };
  if (it.color) r.color = it.color;
  if (it.face) r.face = it.face;
  r.family = it.family;
  if (it.sup) r.sup = true;
  if (it.bg) r.bg = it.bg;
  return r;
}

const sameStyle = (a: Run, b: Run) =>
  a.bold === b.bold && a.italic === b.italic && a.size === b.size && a.color === b.color && a.face === b.face && a.family === b.family && !!a.sup === !!b.sup && a.bg === b.bg && !b.br;

/** Styled runs of a sequence of items (one line or part of one), with spaces where the gaps are. */
function itemsRuns(items: Item[], dom?: number): Run[] {
  const runs: Run[] = [];
  let prevEnd = -Infinity;
  for (const it of items) {
    if (!it.str) continue;
    let text = it.str;
    const last = runs[runs.length - 1];
    if (last && it.x - prevEnd > it.fontSize * 0.18 && !/\s$/.test(last.text) && !/^\s/.test(text)) text = " " + text;
    const r = itemRun(it, text, dom);
    if (last && (sameStyle(last, r) || !text.trim())) last.text += text;
    else if (last && /^\s+$/.test(last.text) && runs.length > 1) {
      // A lone space run takes the style of what follows.
      runs.pop();
      r.text = last.text + r.text;
      const prev = runs[runs.length - 1];
      if (sameStyle(prev, r)) prev.text += r.text;
      else runs.push(r);
    } else runs.push(r);
    prevEnd = Math.max(prevEnd, it.x + it.w);
  }
  for (const r of runs) r.text = r.text.replace(/\s+/g, " ");
  if (runs.length) runs[0].text = runs[0].text.trimStart();
  return runs.filter((r) => r.text);
}

const lineRuns = (l: SLine) => itemsRuns(l.items, l.dom);

/** Baseline-to-baseline spacing of consecutive lines (median), when they read as one block. */
function leadingOf(bases: number[], size: number): number | undefined {
  const steps = bases.slice(1).map((b, k) => b - bases[k]).filter((d) => d > size * 0.8 && d < size * 2.5);
  return steps.length ? median(steps) : undefined;
}

/** Position of a run of lines (see Geo). */
function geoOf(lines: SLine[]): Geo {
  return {
    top: Math.min(...lines.map((l) => l.y)),
    bottom: Math.max(...lines.map((l) => l.y + l.h)),
    first: lines[0].dom,
    last: lines[lines.length - 1].dom,
    leading: leadingOf(lines.map((l) => l.domBase), lines[0].dom),
  };
}

/** Append a line's runs to a paragraph, de-hyphenating words split across lines. */
function joinRuns(target: Run[], add: Run[]) {
  if (!add.length) return;
  const last = target[target.length - 1];
  if (last && /[a-z]-$/.test(last.text) && /^[a-z]/.test(add[0].text)) last.text = last.text.slice(0, -1);
  else if (last && !/\s$/.test(last.text)) last.text += " ";
  target.push(...add.map((r) => ({ ...r })));
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameStyle(last, r)) last.text += r.text;
    else if (last && !r.text.trim()) last.text += r.text;
    else out.push({ ...r });
  }
  for (const r of out) r.text = r.text.replace(/\s+/g, " ");
  if (out.length) {
    out[0].text = out[0].text.trimStart();
    out[out.length - 1].text = out[out.length - 1].text.trimEnd();
  }
  return out.filter((r) => r.text);
}

export const runsText = (runs: Run[]) => runs.map((r) => r.text).join("");

/** Items of a line from x0 (inclusive) to x1 (exclusive), cutting items that straddle the bounds. */
function sliceItems(items: Item[], x0: number, x1 = Infinity): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    if (it.x + it.w <= x0 + 0.5 || it.x >= x1 - 0.5) continue;
    if (it.x >= x0 - 0.5 && it.x + it.w <= x1 + 0.5) {
      out.push(it);
      continue;
    }
    const n = it.str.length || 1;
    const cw = it.w / n;
    const a = Math.max(0, Math.round((x0 - it.x) / cw));
    const b = Math.min(n, Math.round((x1 - it.x) / cw));
    if (b <= a) continue;
    out.push({ ...it, str: it.str.slice(a, b), x: it.x + a * cw, w: (b - a) * cw });
  }
  return out;
}

/* ------------------------------------------------------------- page furniture */

const normalize = (s: string) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

/** Lines that repeat at the top or bottom of many pages (running heads, page numbers). */
function furniture(pages: { lines: Line[]; height: number }[]): Set<string> {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const edge = p.lines.filter((l) => l.y < p.height * 0.1 || l.y + l.h > p.height * 0.9);
    for (const key of new Set(edge.map((l) => normalize(l.text)))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // On every page of a two-page document, or on at least half the pages (three or more) of a longer one.
  const min = pages.length === 2 ? 2 : Math.max(3, Math.ceil(pages.length * 0.5));
  const out = new Set<string>();
  for (const [k, n] of counts) if (n >= min || /^(page )?#( (of|\/) #)?$/.test(k) || /^- # -$/.test(k)) out.add(k);
  return out;
}

/* ------------------------------------------------------------- shapes */

type Graphics = { hrules: Rule[]; vrules: Rule[]; boxes: Box[]; marks: Mark[] };

/** Sort a page's shapes into rules, boxes and small marks (check boxes, drawn bullets). */
function graphicsOf(shapes: Shape[], pw: number, ph: number): Graphics {
  const g: Graphics = { hrules: [], vrules: [], boxes: [], marks: [] };
  for (const s of shapes) {
    const color = s.fill ?? s.stroke;
    if (s.h <= 3.2 && s.w >= 10) g.hrules.push({ x: s.x, y: s.y, w: s.w, h: s.h, color });
    else if (s.w <= 3.2 && s.h >= 8) g.vrules.push({ x: s.x, y: s.y, w: s.w, h: s.h, color });
    else if (s.w >= 2.5 && s.h >= 2.5 && s.w <= 16 && s.h <= 16 && Math.abs(s.w - s.h) <= 0.3 * Math.max(s.w, s.h)) {
      if (!(s.fill && isWhite(s.fill) && !s.stroke)) {
        const hollow = !s.fill || isWhite(s.fill);
        // Rings and dots are bullets; an empty square big enough to tick is a check box.
        g.marks.push({ x: s.x, y: s.y, w: s.w, h: s.h, check: hollow && !s.round && s.w >= 5, bullet: s.round ? (hollow ? "◦" : "•") : hollow ? "▫" : "▪" });
      }
    } else if (s.w >= 16 && s.h >= 8 && s.w * s.h < pw * ph * 0.8 && !(s.fill && isWhite(s.fill) && !s.stroke)) {
      // A fill and an outline drawn separately for the same box count once.
      const twin = g.boxes.find((b) => Math.abs(b.x - s.x) < 2 && Math.abs(b.y - s.y) < 2 && Math.abs(b.w - s.w) < 3 && Math.abs(b.h - s.h) < 3);
      if (twin) {
        twin.fill ??= s.fill && !isWhite(s.fill) ? s.fill : undefined;
        twin.stroke ??= s.stroke;
      } else g.boxes.push({ x: s.x, y: s.y, w: s.w, h: s.h, fill: s.fill && !isWhite(s.fill) ? s.fill : undefined, stroke: s.stroke });
    }
  }
  return g;
}

/* ------------------------------------------------------------- regions */

/** A page, or a box on it, with the text and shapes inside (boxes inside it are its kids). */
type Region = { box?: Box; items: Item[]; kids: Region[]; hrules: Rule[]; vrules: Rule[]; marks: Mark[]; fills: Box[]; outlines: Box[] };

const newRegion = (box?: Box): Region => ({ box, items: [], kids: [], hrules: [], vrules: [], marks: [], fills: [], outlines: [] });

/** Two boxes sharing an edge: cells of a drawn table, not boxes of their own. */
function touches(a: Box, b: Box): boolean {
  const vOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const hOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const side = (Math.abs(a.x + a.w - b.x) < 2 || Math.abs(b.x + b.w - a.x) < 2) && vOverlap > Math.min(a.h, b.h) * 0.5;
  const stack = (Math.abs(a.y + a.h - b.y) < 2 || Math.abs(b.y + b.h - a.y) < 2) && hOverlap > Math.min(a.w, b.w) * 0.5;
  return side || stack;
}

/** Starts of the text columns in a set of items (one entry per line piece after a wide gap). */
function columnXs(items: Item[]): number[] {
  return toLines({ page: 0, width: 0, height: 0, items }).flatMap((l) => {
    const sg = segments(l);
    return sg.length >= 2 ? sg.map((s) => s.x) : [];
  });
}

/**
 * Shading on rows of a table (striped rows, a highlighted row): the text inside sits in
 * columns that line up with the rows directly above or below the box (not in a box of their own).
 */
function tableRow(b: Box, inner: Item[], items: Item[], size: number, boxes: Box[]): boolean {
  const inside = columnXs(inner);
  if (inside.length < 2) return false;
  const near = items.filter(
    (it) =>
      !inner.includes(it) &&
      it.str.trim() &&
      it.x >= b.x - 4 &&
      it.x + it.w <= b.x + b.w + 4 &&
      (Math.abs(it.y + it.h - b.y) < size * 1.2 || Math.abs(it.y - (b.y + b.h)) < size * 1.2) &&
      !boxes.some((o) => o !== b && !contains(o, b) && centerIn(o, ...itemCenter(it))),
  );
  const outside = [...columnXs(near), ...near.map((it) => it.x)];
  const shared = new Set(inside.filter((x) => outside.some((o) => Math.abs(o - x) < 4)).map((x) => Math.round(x / 4)));
  return shared.size >= 2;
}

function regionsOf(items: Item[], g: Graphics): Region {
  const root = newRegion();
  const containers: Box[] = [];
  const fills: Box[] = [];
  const outlines: Box[] = [];
  const marks = g.marks.filter((m) => !items.some((it) => centerIn(m, ...itemCenter(it), 0)));
  const notBox = (b: Box) => {
    if (b.fill) fills.push(b);
    if (b.stroke) outlines.push(b);
  };
  for (const b of g.boxes) {
    const inner = items.filter((it) => it.str.trim() && centerIn(b, ...itemCenter(it)));
    if (!inner.length || g.boxes.some((o) => o !== b && touches(o, b))) {
      notBox(b);
      continue;
    }
    const size = Math.max(...inner.map((i) => i.fontSize));
    const bases = inner.map((i) => i.base);
    const oneLine = Math.max(...bases) - Math.min(...bases) < size * 0.6;
    const n = inner.reduce((k, i) => k + chars(i.str), 0);
    if (oneLine && b.h <= size * 2.8) {
      // A badge: a short label on its own background.
      if (n <= 32 && b.fill) {
        for (const it of inner) it.bg = b.fill;
        continue;
      }
      // Shading behind a table row or cell, or an outlined label: not a box of its own.
      const sorted = [...inner].sort((a, c) => a.x - c.x);
      const gaps = sorted.slice(1).some((it, k) => it.x - (sorted[k].x + sorted[k].w) > Math.max(it.fontSize * 1.3, 9));
      const besides = items.some((it) => !inner.includes(it) && it.str.trim() && Math.abs(it.base - inner[0].base) < size * 0.5 && (it.x > b.x + b.w || it.x + it.w < b.x));
      if (gaps || besides || n <= 32) {
        notBox(b);
        continue;
      }
    }
    if (tableRow(b, inner, items, size, g.boxes)) {
      notBox(b);
      continue;
    }
    containers.push(b);
  }
  const regs: Region[] = containers.sort((a, b) => a.w * a.h - b.w * b.h).map((box) => newRegion(box));
  const home = (r: Rect, skip?: Region): Region => regs.find((reg) => reg !== skip && reg.box!.w * reg.box!.h > r.w * r.h && contains(reg.box!, r)) ?? root;
  const homeOf = (x: number, y: number): Region => regs.find((reg) => centerIn(reg.box!, x, y)) ?? root;
  for (const reg of regs) home(reg.box!, reg).kids.push(reg);
  for (const it of items) homeOf(...itemCenter(it)).items.push(it);
  for (const r of g.hrules) homeOf(r.x + r.w / 2, r.y + r.h / 2).hrules.push(r);
  for (const r of g.vrules) homeOf(r.x + r.w / 2, r.y + r.h / 2).vrules.push(r);
  for (const m of marks) homeOf(m.x + m.w / 2, m.y + m.h / 2).marks.push(m);
  for (const f of fills) homeOf(f.x + f.w / 2, f.y + f.h / 2).fills.push(f);
  for (const o of outlines) homeOf(o.x + o.w / 2, o.y + o.h / 2).outlines.push(o);
  return root;
}

/* ------------------------------------------------------------- analysis */

type Ctx = {
  page: number;
  pt: { page: number; width: number; height: number };
  body: number;
  hrules: Rule[];
  vrules: Rule[];
  marks: Mark[];
  fills: Box[];
  outlines: Box[];
  /** Left and right edges of the region's text. */
  x0: number;
  x1: number;
  /** Starts of text columns the previous page ended in. */
  columns?: number[];
};

export function analyze(pagesText: PageText[]): SBlock[] {
  return analyzeDoc(pagesText).blocks;
}

export function analyzeDoc(pagesText: PageText[]): { blocks: SBlock[]; body: BodyStyle; layout: PageLayout; furniture: Furniture } {
  const pages = pagesText.map((p) => {
    const all = toLines(p);
    const dir = all[0]?.dir ?? 0;
    return { pt: p, dir, lines: all.filter((l) => l.dir === dir), height: p.height, width: p.width };
  });
  const skip = pages.length >= 2 ? furniture(pages) : new Set<string>();
  const kept = pages.map((p) => {
    const gone = new Set<TextItem>();
    for (const l of p.lines) if (skip.has(normalize(l.text)) && (l.y < p.height * 0.1 || l.y + l.h > p.height * 0.9)) for (const it of l.items) gone.add(it);
    return p.pt.items.filter((it) => it.dir === p.dir && !gone.has(it)).map((it) => ({ ...it }) as Item);
  });
  const body = bodyStyle(kept, pages);

  const graphics: Graphics[] = [];
  let carry: number[] | undefined;
  const perPage = pages.map((p, pi) => {
    const g = p.dir === 0 ? graphicsOf(p.pt.shapes ?? [], p.width, p.height) : { hrules: [], vrules: [], boxes: [], marks: [] };
    graphics.push(g);
    const blocks = layoutRegion(regionsOf(kept[pi], g), { page: pi, pt: p.pt, body: body.size, columns: carry });
    const last = blocks[blocks.length - 1];
    carry = last?.kind === "columns" ? last.starts : undefined;
    return blocks;
  });
  const layout = layoutOf(pagesText, kept, graphics);
  // Where each page's content ends, to tell a page that simply filled up from one ended on purpose.
  const bottoms = kept.map((items, i) => {
    const g = graphics[i];
    const ys = [...items.filter((it) => it.str.trim()).map((it) => it.y + it.h), ...[...g.boxes, ...g.hrules, ...g.vrules].map((r) => r.y + r.h)];
    return ys.length ? Math.max(...ys) : 0;
  });
  const out: SBlock[] = [];
  perPage.forEach((blocks, pi) => {
    if (pi > 0) out.push({ kind: "pagebreak", page: pi, deliberate: deliberateBreak(perPage[pi - 1], blocks, layout.height - layout.bottom - bottoms[pi - 1], body, graphics[pi].boxes) });
    out.push(...blocks);
  });
  joinAcrossPages(out);
  rankHeadings(out);
  return { blocks: out, body, layout, furniture: furnitureLines(pages, skip) };
}

/** The running header and footer, from the first page that carries each line, with page numbers as placeholders. */
function furnitureLines(pages: { lines: Line[]; height: number; width: number }[], skip: Set<string>): Furniture {
  const out: Furniture = { header: [], footer: [] };
  const seen = new Set<string>();
  pages.forEach((p, pi) => {
    for (const l of p.lines) {
      const key = normalize(l.text);
      const top = l.y < p.height * 0.1;
      if (!skip.has(key) || seen.has(key) || !(top || l.y + l.h > p.height * 0.9)) continue;
      seen.add(key);
      const parts = segments(l).map((sg) => {
        const mid = (sg.x + sg.x2) / 2;
        const at: "left" | "center" | "right" = Math.abs(mid - p.width / 2) < p.width * 0.08 ? "center" : sg.x2 > p.width * 0.8 && sg.x > p.width * 0.5 ? "right" : "left";
        // The page's own number (and the page count) become fields that count in Word.
        const m = sg.text.match(/^(page\s+)?(\d+)(\s*(?:of|\/)\s*)?(\d+)?$/i) ?? sg.text.match(/^(-\s*)(\d+)(\s*-)$/);
        const text = m && Number(m[2]) === pi + 1 ? sg.text.replace(/\d+/, "{PAGE}").replace(new RegExp(`(of|/)(\\s*)${pages.length}$`), "$1$2{PAGES}") : sg.text;
        return { text, at };
      });
      const it = l.items.find((i) => i.str.trim()) ?? l.items[0];
      (top ? out.header : out.footer).push({ parts, size: half(l.size), color: it?.color, face: it?.face, family: it?.family, bold: l.bold, edge: top ? l.y : p.height - (l.y + l.h) });
    }
  });
  return out;
}

/**
 * A page break the author made (a new chapter, a section starting on a new page) rather
 * than one where the text simply ran on: the page ended with room to spare for what comes
 * next. Only those are kept in a reflowed document; elsewhere the text flows on.
 */
function deliberateBreak(before: SBlock[], after: SBlock[], free: number, body: BodyStyle, boxes: Box[]): boolean {
  if (!before.length || !after.length) return true;
  const lead = body.leading ?? body.size * 1.4;
  const geo = (b: SBlock) => ("geo" in b ? b.geo : undefined);
  const first = after.find((b) => geo(b));
  const g = first && geo(first);
  if (!first || !g) return free > lead * 4;
  const height = g.bottom - g.top;
  // How much of it had to fit: text can split after a few lines; a box can't; a heading or
  // lead-in comes with the start of what follows it.
  let need = first.kind === "box" ? height : first.kind === "table" ? Math.min(height, lead * 4) : first.kind === "heading" || (first.kind === "para" && first.keep) ? height + lead * 3 : Math.min(height, lead * 3);
  const frame = boxes.find((b) => b.y <= g.top + 1 && b.y + b.h >= g.top && b.h < 700);
  if (frame) need = Math.max(need, frame.h);
  return free > need + lead;
}

/** Merge what a natural page break cut in two: a paragraph, a list, or a table that runs on (dropping a repeated header row). */
function joinAcrossPages(blocks: SBlock[]) {
  for (let i = 1; i < blocks.length - 1; i++) {
    const pb = blocks[i];
    if (pb.kind !== "pagebreak" || pb.deliberate) continue;
    const a = blocks[i - 1];
    const b = blocks[i + 1];
    let joined = false;
    if (a.kind === "para" && b.kind === "para") {
      const last = runsText(a.runs).trimEnd();
      const sizeA = a.runs[a.runs.length - 1]?.size ?? 0;
      const sizeB = b.runs[0]?.size ?? 0;
      if (!/[.!?:;]["”’)]?$/.test(last) && /^[a-z(“"‘'0-9]/.test(runsText(b.runs)) && Math.abs(sizeA - sizeB) < 0.6 && a.bar === b.bar) {
        joinRuns(a.runs, b.runs);
        a.runs = mergeRuns(a.runs);
        joined = true;
      }
    } else if (a.kind === "list" && b.kind === "list") {
      const fa = a.formats[0];
      const fb = b.formats[0];
      const count = a.levels.filter((l) => l === 0).length;
      const same = fa.kind === fb.kind && fa.before === fb.before && fa.after === fb.after && (!a.ordered || fb.start === fa.start + count) && !a.columns && !b.columns;
      if (same) {
        const gap = a.gaps?.length ? median(a.gaps) : 0;
        a.items.push(...b.items);
        a.levels.push(...b.levels);
        a.gaps = [...(a.gaps ?? []), gap, ...(b.gaps ?? [])];
        b.formats.forEach((f, k) => (a.formats[k] ??= f));
        joined = true;
      }
    } else if (a.kind === "columns" && b.kind === "columns" && a.count === b.count) {
      // Columns that run on to the next page: one run of text (a paragraph cut by the page joins up).
      const x = a.blocks[a.blocks.length - 1];
      const y = b.blocks[0];
      if (x?.kind === "para" && y?.kind === "para" && !/[.!?:;]["”’)]?$/.test(runsText(x.runs).trimEnd()) && /^[a-z(“"‘'0-9]/.test(runsText(y.runs))) {
        joinRuns(x.runs, y.runs);
        x.runs = mergeRuns(x.runs);
        b.blocks.shift();
      }
      a.blocks.push(...b.blocks);
      joined = true;
    } else if (a.kind === "table" && b.kind === "table" && a.lines !== "cards" && b.lines !== "cards") {
      const cols = a.widths.length;
      const fits = b.widths.length === cols && b.widths.every((w, k) => Math.abs(w - a.widths[k]) < 0.06);
      if (fits) {
        const repeat = a.header && b.rows[0]?.join("|") === a.rows[0]?.join("|");
        const from = repeat ? 1 : 0;
        a.rows.push(...b.rows.slice(from));
        a.cells.push(...b.cells.slice(from));
        if (a.rowRules && b.rowRules) a.rowRules = [...a.rowRules.slice(0, -1), ...b.rowRules.slice(from)];
        joined = true;
      }
    }
    if (joined) {
      if ("geo" in a && a.geo && "geo" in b && b.geo) {
        a.geo.gap = b.geo.gap;
        a.geo.next = b.geo.next;
      }
      blocks.splice(i + 1, 1);
    }
  }
}

/** The most common page size, and margins from the outermost text, boxes and rules on any page. */
function layoutOf(pages: PageText[], kept: Item[][], graphics: Graphics[]): PageLayout {
  const sizes = new Map<string, number>();
  for (const p of pages) tally(sizes, `${Math.round(p.width)}x${Math.round(p.height)}`, 1);
  const [width, height] = (mode(sizes) ?? "595x842").split("x").map(Number);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  pages.forEach((p, i) => {
    if (Math.round(p.width) !== width || Math.round(p.height) !== height) return;
    const g = graphics[i];
    const rects: Rect[] = [
      ...kept[i].filter((it) => it.str.trim() && it.dir === 0).map((it) => ({ x: it.x, y: it.y, w: it.w, h: it.h })),
      ...[...g.boxes, ...g.hrules, ...g.vrules].filter((r) => r.w < width * 0.95),
    ];
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
  });
  const m = (v: number) => Math.min(108, Math.max(18, Number.isFinite(v) ? v : 72));
  return { width, height, left: m(x0), top: m(y0), right: m(width - x1), bottom: m(height - y1) };
}

/** Size, face and colour of the running text, from character counts; line spacing from its paragraphs. */
function bodyStyle(kept: Item[][], pages: { pt: PageText }[]): BodyStyle {
  const sizes = new Map<number, number>();
  for (const items of kept) for (const it of items) tally(sizes, half(it.fontSize), chars(it.str));
  const size = mode(sizes) ?? 11;
  const faces = new Map<string, number>();
  const fams = new Map<Family, number>();
  const colors = new Map<string, number>();
  for (const items of kept)
    for (const it of items) {
      if (Math.abs(half(it.fontSize) - size) > 0.3 || it.bold) continue;
      const n = chars(it.str);
      if (it.face) tally(faces, it.face, n);
      tally(fams, it.family, n);
      if (it.color) tally(colors, it.color, n);
    }
  // Line spacing: baseline to baseline within paragraphs of body text. The gap between
  // paragraphs: from a line that ends a sentence to one that starts a new one.
  const steps: number[] = [];
  const breaks: number[] = [];
  kept.forEach((items, i) => {
    const lines = toLines({ ...pages[i].pt, items }).filter((l) => Math.abs(half(l.size) - size) <= 0.5);
    for (let k = 1; k < lines.length; k++) {
      const a = lines[k - 1];
      const b = lines[k];
      if (Math.abs(a.x - b.x) >= 4 || b.base <= a.base) continue;
      if (/[.!?:]["”’)]?$/.test(a.text) && /^[A-Z“"(]/.test(b.text)) breaks.push(b.base - a.base);
      else steps.push(b.base - a.base);
    }
  });
  const inPara = steps.filter((s) => s >= size * 0.95 && s <= size * 2.2);
  const leading = inPara.length >= 3 ? median(inPara) : undefined;
  const between = leading ? breaks.filter((s) => s > leading * 1.15 && s < leading * 2.5) : [];
  return {
    size,
    face: mode(faces),
    family: mode(fams),
    color: mode(colors),
    leading,
    paraGap: between.length >= 2 ? median(between) - leading! : leading && breaks.length >= 2 ? 0 : undefined,
  };
}

/** Heading levels from size across the whole document: the largest size is level 1. */
function rankHeadings(blocks: SBlock[]) {
  const all: Extract<SBlock, { kind: "heading" }>[] = [];
  const walk = (bs: SBlock[]) => {
    for (const b of bs) {
      if (b.kind === "heading") all.push(b);
      else if (b.kind === "box" || b.kind === "columns") walk(b.blocks);
    }
  };
  walk(blocks);
  const sizes = [...new Set(all.map((h) => h.size))].sort((a, b) => b - a);
  const tiers: number[] = [];
  for (const s of sizes) if (!tiers.length || tiers[tiers.length - 1] - s > 0.75) tiers.push(s);
  for (const h of all) {
    const t = tiers.findIndex((x) => x - h.size <= 0.75);
    h.level = Math.min(3, Math.max(1, t + 1)) as 1 | 2 | 3;
  }
}

/** Blocks of a region: its own text, with the boxes inside it (callouts, rows of cards) in reading order. */
function layoutRegion(r: Region, base: { page: number; pt: Ctx["pt"]; body: number; columns?: number[] }): SBlock[] {
  const lines = linesOf(r.items, base.pt);
  const x0 = lines.length ? Math.min(...lines.map((l) => l.x)) : 0;
  const x1 = lines.length ? Math.max(...lines.map((l) => l.x + l.w)) : 0;
  const ctx: Ctx = { ...base, hrules: r.hrules, vrules: r.vrules, marks: r.marks, fills: r.fills, outlines: r.outlines, x0, x1 };
  // Runs of ordinary lines, and stretches set in columns, in order down the region.
  type Unit = { y: number; lines: SLine[]; gutter?: number };
  const groups = cardGroups(r.kids);
  const units: Unit[] = [];
  let at = 0;
  const push = (ls: SLine[], gutter?: number) => {
    if (ls.length) units.push({ y: ls[0].y + ls[0].h / 2, lines: ls, gutter });
  };
  // Ordinary lines are split where a box or row of cards comes between them.
  const pushPlain = (ls: SLine[]) => {
    let cur: SLine[] = [];
    for (const l of ls) {
      const mid = l.y + l.h / 2;
      if (cur.length && groups.some((g) => g.y > cur[cur.length - 1].y + cur[cur.length - 1].h / 2 && g.y <= mid)) {
        push(cur);
        cur = [];
      }
      cur.push(l);
    }
    push(cur);
  };
  for (const z of columnZones(lines, ctx)) {
    pushPlain(lines.slice(at, z.from));
    push(lines.slice(z.from, z.to), z.gutter);
    at = z.to;
  }
  pushPlain(lines.slice(at));
  const render = (u: Unit): SBlock[] => {
    if (u.gutter === undefined) return blocksOf(u.lines, ctx);
    const g = u.gutter;
    const sides = [0, 1].map((n) => linesFromItems(u.lines.flatMap((l) => l.items.filter((it) => (it.x + it.w / 2 < g) === (n === 0))), base.pt));
    const starts = sides.map((sd) => Math.min(...sd.map((l) => l.x)));
    return [columnsBlock(sides, starts, u.lines, ctx)];
  };
  const out: SBlock[] = [];
  let ui = 0;
  for (const grp of groups) {
    while (ui < units.length && units[ui].y < grp.y) out.push(...render(units[ui++]));
    out.push(...groupBlocks(grp, base));
  }
  while (ui < units.length) out.push(...render(units[ui++]));
  // The gap below each block: to the next one, or for the last block in a box, to the box's edge.
  const placed = out.filter((b): b is Extract<SBlock, { geo?: Geo }> & { geo: Geo } => "geo" in b && !!b.geo);
  placed.forEach((b, k) => {
    const nx = placed[k + 1]?.geo;
    if (nx) {
      b.geo.gap = Math.max(0, nx.top - b.geo.bottom);
      b.geo.next = nx.first;
    } else if (r.box) {
      b.geo.gap = Math.max(0, r.box.y + r.box.h - b.geo.bottom);
      b.geo.next = undefined;
    }
  });
  return out;
}

type Group = { y: number; rows: Region[][] };

/** Boxes side by side form a row of cards; rows of cards that line up form one grid. */
function cardGroups(kids: Region[]): Group[] {
  const sorted = [...kids].sort((a, b) => a.box!.y - b.box!.y || a.box!.x - b.box!.x);
  const rows: Region[][] = [];
  for (const k of sorted) {
    const row = rows.find((rw) =>
      rw.every((o) => {
        const a = o.box!;
        const b = k.box!;
        const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        return overlap > Math.min(a.h, b.h) * 0.5 && (b.x >= a.x + a.w - 2 || b.x + b.w <= a.x + 2);
      }),
    );
    if (row) row.push(k);
    else rows.push([k]);
  }
  for (const rw of rows) rw.sort((a, b) => a.box!.x - b.box!.x);
  const groups: Group[] = [];
  for (const rw of rows) {
    const last = groups[groups.length - 1];
    const prev = last?.rows[last.rows.length - 1];
    const aligned = prev && prev.length >= 2 && prev.length === rw.length && rw.every((k, i) => Math.abs(k.box!.x - prev[i].box!.x) < 12);
    const near = prev && rw[0].box!.y - Math.max(...prev.map((k) => k.box!.y + k.box!.h)) < 40;
    if (last && aligned && near) last.rows.push(rw);
    else groups.push({ y: Math.min(...rw.map((k) => k.box!.y)), rows: [rw] });
  }
  return groups.sort((a, b) => a.y - b.y);
}

/** How far a box's text sits from its edges (points). */
function insets(r: Region): { x: number; y: number } | undefined {
  const its = r.items.filter((it) => it.str.trim());
  if (!its.length || !r.box) return undefined;
  const lim = (v: number) => Math.min(24, Math.max(2, v));
  return { x: lim(Math.min(...its.map((i) => i.x)) - r.box.x), y: lim(Math.min(...its.map((i) => i.y)) - r.box.y) };
}

function groupBlocks(g: Group, base: { page: number; pt: Ctx["pt"]; body: number }): SBlock[] {
  if (g.rows.length === 1 && g.rows[0].length === 1) {
    const kid = g.rows[0][0];
    const inner = layoutRegion(kid, base);
    // A frame around a whole section (with tables or boxes inside, or most of a page) adds nothing: keep its content.
    if (inner.some((b) => b.kind === "table" || b.kind === "box") || kid.box!.h > base.pt.height * 0.45) {
      // Its parts stay together on a page, as in the box.
      for (const b of inner) if (b.kind === "para" || (b.kind === "table" && b.cells.length <= 12)) b.keep = true;
      return inner;
    }
    const box = kid.box!;
    return inner.length ? [{ kind: "box", blocks: inner, fill: box.fill, stroke: box.stroke, pad: insets(kid), page: base.page, geo: { top: box.y, bottom: box.y + box.h, first: 0, last: 0 } }] : [];
  }
  const cols = Math.max(...g.rows.map((r) => r.length));
  const cells = g.rows.map((rw) =>
    Array.from({ length: cols }, (_, c) => {
      const kid = rw[c];
      if (!kid) return { paras: [], text: "" } as Cell;
      // Titles inside a card stay styled text: they aren't headings of the document.
      const blocks = layoutRegion(kid, base).map((b): SBlock => (b.kind === "heading" ? { kind: "para", runs: b.runs, page: b.page, geo: b.geo } : b));
      const paras = blocks.flatMap(blockParas);
      return { paras, text: paras.map(runsText).join("\n"), blocks, fill: kid.box!.fill, stroke: kid.box!.stroke } as Cell;
    }),
  );
  const first = g.rows.find((r) => r.length === cols) ?? g.rows[0];
  const raw = first.map((k, i) => (i + 1 < first.length ? first[i + 1].box!.x - k.box!.x : k.box!.w));
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const boxes = g.rows.flat().map((k) => k.box!);
  const geo: Geo = { top: Math.min(...boxes.map((b) => b.y)), bottom: Math.max(...boxes.map((b) => b.y + b.h)), first: 0, last: 0 };
  return [{ kind: "table", rows: cells.map((r) => r.map((c) => c.text)), cells, header: false, widths: raw.map((w) => w / total), lines: "cards", pad: insets(first[0]), page: base.page, geo }];
}

/** A block flattened to paragraphs (for plain table cells). */
function blockParas(b: SBlock): Run[][] {
  if (b.kind === "heading" || b.kind === "para") return [b.runs];
  if (b.kind === "list") return b.items.map((it, i) => [{ ...(it[0] ?? { bold: false, italic: false }), text: listLabel(b, i) + " " }, ...it]);
  if (b.kind === "table") return b.cells.flatMap((r) => r.flatMap((c) => c.paras));
  if (b.kind === "box" || b.kind === "columns") return b.blocks.flatMap(blockParas);
  return [];
}

/** The marker an item of a list shows ("3.", "b)", "•", "☐"). */
export function listLabel(b: Extract<SBlock, { kind: "list" }>, i: number): string {
  const lvl = b.levels[i] ?? 0;
  const f = b.formats[lvl] ?? b.formats[0];
  if (f.kind === "bullet") return f.bullet ?? "•";
  if (f.kind === "check") return "☐";
  let n = f.start;
  for (let k = i - 1; k >= 0; k--) {
    if ((b.levels[k] ?? 0) < lvl) break;
    if ((b.levels[k] ?? 0) === lvl) n++;
  }
  const s = f.kind === "decimal" ? String(n) : f.kind === "lowerLetter" ? letters(n) : f.kind === "upperLetter" ? letters(n).toUpperCase() : f.kind === "lowerRoman" ? roman(n) : roman(n).toUpperCase();
  return f.before + s + f.after;
}

const letters = (n: number): string => (n <= 26 ? String.fromCharCode(96 + Math.max(1, n)) : letters(Math.floor((n - 1) / 26)) + letters(((n - 1) % 26) + 1));
function roman(n: number): string {
  const t: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let s = "";
  for (const [v, r] of t) while (n >= v) [s, n] = [s + r, n - v];
  return s;
}
function romanValue(s: string): number {
  const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let n = 0;
  const t = s.toLowerCase();
  for (let i = 0; i < t.length; i++) n += v[t[i]] < (v[t[i + 1]] ?? 0) ? -v[t[i]] : v[t[i]];
  return n;
}

/* ------------------------------------------------------------- blocks of text */

function blocksOf(lines: SLine[], ctx: Ctx): SBlock[] {
  const out: SBlock[] = [];
  if (!lines.length) return out;
  const segs = lines.map(segments);
  let para: { runs: Run[]; first: SLine; last: SLine; lines: SLine[]; bar?: string } | null = null;
  const flush = () => {
    if (para) {
      const runs = mergeRuns(para.runs);
      if (runs.length) out.push({ kind: "para", runs, page: ctx.page, ...alignOf(para.lines, ctx), ...indentOf(para.lines, ctx), ...(para.bar ? { bar: para.bar } : {}), geo: geoOf(para.lines) });
    }
    para = null;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const h = headingAt(lines, segs, i, ctx);
    if (h) {
      flush();
      out.push(h.block);
      i = h.end;
      continue;
    }
    const li = findList(lines, segs, i, ctx);
    if (li) {
      flush();
      out.push(li.block);
      i = li.end;
      continue;
    }
    const co = findColumns(lines, segs, i, ctx);
    if (co) {
      flush();
      out.push(co.block);
      i = co.end;
      continue;
    }
    const t = findTable(lines, segs, i, ctx);
    if (t) {
      flush();
      const rows = lines.slice(i, t.end);
      const py = t.pad?.y ?? 0;
      const geo: Geo = { top: Math.min(...rows.map((l) => l.y)) - py, bottom: Math.max(...rows.map((l) => l.y + l.h)) + py, first: 0, last: 0 };
      out.push({ kind: "table", rows: t.cells.map((r) => r.map((c) => c.text)), cells: t.cells, header: t.header, widths: t.widths, page: ctx.page, pad: t.pad, leading: t.leading, ...(t.lines ? { lines: t.lines, lineColor: t.lineColor, rowRules: t.rowRules } : {}), geo });
      i = t.end;
      continue;
    }
    const runs = lineRuns(l);
    const bar = barOf(l, ctx);
    if (para) {
      const gap = l.y - (para.last.y + para.last.h);
      const sameSize = Math.abs(l.dom - para.last.dom) < 0.6;
      // A new paragraph starts indented (beyond the line before) or, where paragraphs are
      // marked by a first-line indent, a little in from lines that sat at the left edge.
      const indented = l.x - para.last.x > l.size * 1.5 || (para.lines.length >= 2 && Math.abs(para.last.x - ctx.x0) < 1.5 && l.x - para.last.x > l.size * 0.6 && l.x - para.last.x < l.size * 4);
      const sentenceEnd = /[.!?:]["”’)]?$/.test(para.last.text);
      const prevShort = para.last.x + para.last.w < ctx.x0 + (ctx.x1 - ctx.x0) * 0.55 && sentenceEnd;
      // At the top of the next column the spacing that marks a new paragraph is gone: a finished sentence followed by a capital is one.
      const newColumn = l.col !== para.last.col && sentenceEnd && /^[A-Z“"‘]/.test(l.text);
      if (gap < l.h * 0.75 && sameSize && !indented && !prevShort && !newColumn && bar === para.bar && l.x >= para.first.x - l.size * 1.5) {
        joinRuns(para.runs, runs);
        para.last = l;
        para.lines.push(l);
        i++;
        continue;
      }
      flush();
    }
    para = { runs, first: l, last: l, lines: [l], bar };
    i++;
  }
  flush();
  return out;
}

/** A coloured bar drawn just left of a line (a pull quote or callout), as its colour. */
function barOf(l: SLine, ctx: Ctx): string | undefined {
  const bar = ctx.vrules.find((r) => r.x + r.w <= l.x + 0.5 && l.x - (r.x + r.w) < 24 && Math.min(r.y + r.h, l.y + l.h) - Math.max(r.y, l.y) > l.h * 0.5);
  return bar ? (bar.color ?? "#000000") : undefined;
}

/** Centred or right-aligned text, judged against the edges of the region's text. */
function alignOf(lines: SLine[], ctx: Ctx): { align?: "center" | "right" | "justify" } {
  const width = ctx.x1 - ctx.x0;
  if (width < 100) return {};
  // Justified: every line but the last starts and ends at the same edges (ragged or centred text varies).
  const body = lines.slice(0, -1);
  const edge = Math.max(...lines.map((l) => l.x + l.w));
  const start = Math.min(...body.map((l) => l.x));
  if (body.length >= 2 && body.every((l) => edge - (l.x + l.w) < 1.2 && l.x - start < 1.2 + (l === lines[0] ? l.dom * 4 : 0))) return { align: "justify" };
  const centred = lines.every((l) => {
    const left = l.x - ctx.x0;
    const right = ctx.x1 - (l.x + l.w);
    return left > 24 && Math.abs(left - right) < Math.max(6, width * 0.04);
  });
  if (centred) return { align: "center" };
  const right = lines.every((l) => ctx.x1 - (l.x + l.w) < 3 && l.x - ctx.x0 > width * 0.3);
  return right ? { align: "right" } : {};
}

/** A paragraph's indents: where its lines start, and how far the first line sits in (or hangs out). */
function indentOf(lines: SLine[], ctx: Ctx): { indent?: { left: number; first: number; right?: number } } {
  if (lines.length < 2) return {};
  const left = Math.min(...lines.slice(1).map((l) => l.x)) - ctx.x0;
  const first = lines[0].x - ctx.x0 - left;
  const size = lines[0].dom;
  // A justified block narrower than the text around it (an abstract, a quotation) is indented on the right too.
  const body = lines.slice(0, -1);
  const edge = Math.max(...lines.map((l) => l.x + l.w));
  const right = lines.length >= 3 && body.every((l) => edge - (l.x + l.w) < 1.2) && ctx.x1 - edge >= size * 0.5 ? ctx.x1 - edge : 0;
  return Math.abs(first) >= size * 0.5 || left >= size * 0.5 || right ? { indent: { left: Math.max(0, left), first, ...(right ? { right } : {}) } } : {};
}

/* ------------------------------------------------------------- columns */

/** A line made of the given items (see relayout). */
function lineFromItems(items: Item[], dir: Line["dir"]): SLine {
  const l = { text: "", dir, x: 0, y: 0, w: 0, h: 0, base: 0, size: 0, bold: false, italic: false, items: [...items], dom: 0, domBase: 0 } as SLine;
  relayout(l);
  return l;
}

/**
 * Running text set in two or three columns, starting at line i: lines that pair a piece of
 * prose from each column. Read down each column in turn instead of across.
 */
function findColumns(lines: SLine[], segs: Segment[][], i: number, ctx: Ctx): { block: SBlock; end: number } | null {
  const s0 = segs[i];
  if (s0.length < 2 || s0.length > 3) return null;
  const starts = s0.map((sg) => sg.x);
  const width = ctx.x1 - ctx.x0;
  if (width <= 0 || starts.some((x, k) => k > 0 && x - starts[k - 1] < width * 0.25)) return null;
  // A piece of a line belongs to the column it starts in (a paragraph's first line may be indented).
  const colAt = (x: number) => {
    for (let k = starts.length - 1; k >= 0; k--) if (x >= starts[k] - 4) return x <= starts[k] + 36 ? k : -1;
    return -1;
  };
  const frags: { col: number; seg: Segment; line: SLine }[] = [];
  let end = i;
  for (let j = i; j < lines.length; j++) {
    const l = lines[j];
    if (j > i && l.y - (lines[j - 1].y + lines[j - 1].h) > l.h * 2.5) break;
    const cs = segs[j].map((sg) => colAt(sg.x));
    if (cs.some((c) => c < 0) || new Set(cs).size !== cs.length) break;
    // Text running across a gutter is not in columns.
    if (segs[j].some((sg, n) => cs[n] + 1 < starts.length && sg.x2 > starts[cs[n] + 1] - 4)) break;
    segs[j].forEach((sg, n) => frags.push({ col: cs[n], seg: sg, line: l }));
    end = j + 1;
  }
  // Columns carried over from the previous page may end after a line or two.
  const carried = !!ctx.columns && ctx.columns.length === starts.length && ctx.columns.every((x, k) => Math.abs(x - starts[k]) < 6);
  const min = carried ? 1 : 3;
  if (lines.slice(i, end).filter((_, k) => segs[i + k].length >= 2).length < min) return null;
  // Each column must read as running text: lines that fill the column (allowing a ragged
  // right edge) or end a sentence, of ordinary length and weight.
  const breaks: number[][] = [];
  for (let k = 0; k < starts.length; k++) {
    const fr = frags.filter((f) => f.col === k);
    if (fr.length < min) return null;
    const right = Math.max(...fr.map((f) => f.seg.x2));
    const full = fr.filter((f) => f.seg.x2 >= right - (right - starts[k]) * 0.3 || /[.!?:]["”’)]?$/.test(f.seg.text)).length;
    const avg = fr.reduce((n, f) => n + f.seg.text.length, 0) / fr.length;
    const bold = fr.filter((f) => f.seg.items.filter((it) => it.bold).length > f.seg.items.length / 2).length;
    if (full / fr.length < 0.85 || avg < 25 || bold / fr.length > 0.3) return null;
    // Where each column's paragraphs break.
    const steps = fr.slice(1).map((f, n) => f.line.y - fr[n].line.y);
    const usual = median(steps);
    breaks.push(fr.slice(1).filter((_, n) => steps[n] > usual * 1.3).map((f) => f.line.y));
  }
  // Rows of a table break at the same height in every column; columns of text don't.
  const shared = breaks[0].filter((y) => breaks.slice(1).every((b) => b.some((v) => Math.abs(v - y) < 3)));
  if (breaks[0].length >= 2 && shared.length >= breaks[0].length * 0.7) return null;
  const sides = starts.map((_, k) => frags.filter((f) => f.col === k).map((f) => lineFromItems(f.seg.items as Item[], f.line.dir)));
  return { block: columnsBlock(sides, starts, lines.slice(i, end), ctx), end };
}

/**
 * Text in columns as one block: each column's lines (moved over to the first column's edge)
 * are read in turn, so a paragraph that runs from the foot of one column to the top of the
 * next stays one paragraph.
 */
function columnsBlock(sides: SLine[][], starts: number[], rows: SLine[], ctx: Ctx): SBlock {
  const vlines = sides.flatMap((side, k) =>
    side.map((l) => (k ? { ...lineFromItems(l.items.map((it) => ({ ...it, x: it.x - (starts[k] - starts[0]) })), l.dir), col: k } : { ...l, col: 0 })),
  );
  const colRight = Math.max(...sides[0].map((l) => l.x + l.w));
  // Rules, marks and shading inside a column move over with its text.
  const colOf = (x: number) => starts.reduce((c, sx, k) => (x >= sx - 6 ? k : c), 0);
  const move = <T extends Rect>(rs: T[]) => rs.map((r) => ({ ...r, x: r.x - (starts[colOf(r.x + Math.min(r.w, 8) / 2)] - starts[0]) }));
  const inner = blocksOf(vlines, { ...ctx, x0: starts[0], x1: colRight, hrules: move(ctx.hrules), vrules: move(ctx.vrules), marks: move(ctx.marks), fills: move(ctx.fills), outlines: move(ctx.outlines) });
  // Gaps inside: down a column as measured; where the next block heads the next column, unknown.
  const placed = inner.filter((b): b is Extract<SBlock, { geo?: Geo }> & { geo: Geo } => "geo" in b && !!b.geo);
  placed.forEach((b, k) => {
    const nx = placed[k + 1]?.geo;
    const gap = nx ? nx.top - b.geo.bottom : undefined;
    b.geo.gap = gap !== undefined && gap >= 0 ? gap : undefined;
    b.geo.next = nx?.first;
  });
  const geo: Geo = { top: Math.min(...rows.map((l) => l.y)), bottom: Math.max(...rows.map((l) => l.y + l.h)), first: rows[0].dom, last: rows[rows.length - 1].dom };
  return { kind: "columns", count: starts.length, blocks: inner, page: ctx.page, geo, starts };
}

/** Each side's text reads as running text: lines that fill the column (ragged right allowed) or end a sentence, of ordinary length; headings aside. */
function proseSides(sides: SLine[][], body: number): boolean {
  return sides.every((side) => {
    const text = side.filter((l) => !l.bold && l.dom <= body * 1.15);
    if (text.length < 3) return false;
    const left = Math.min(...text.map((l) => l.x));
    const right = Math.max(...text.map((l) => l.x + l.w));
    const full = text.filter((l) => l.x + l.w >= right - (right - left) * 0.3 || /[.!?:]["”’)]?$/.test(l.text)).length;
    const avg = text.reduce((n, l) => n + l.text.length, 0) / text.length;
    return full / text.length >= 0.7 && avg >= 20;
  });
}

/** Lines built from items (raised text kept raised). */
function linesFromItems(items: Item[], pt: Ctx["pt"]): SLine[] {
  const lines = toLines({ page: pt.page, width: pt.width, height: pt.height, items }) as SLine[];
  for (const l of lines) relayout(l);
  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Stretches of a region set in two columns, found from the page rather than line by line
 * (the columns' lines needn't share baselines): lines that keep clear of one vertical gutter
 * with running text on both sides. A title or abstract across the gutter is outside them.
 */
function columnZones(lines: SLine[], ctx: Ctx): { from: number; to: number; gutter: number }[] {
  const w = ctx.x1 - ctx.x0;
  if (w < 200 || lines.length < 6) return [];
  const segsOf = lines.map((l) => segments(l));
  const lo = Math.floor(ctx.x0 + w * 0.25);
  const hi = Math.ceil(ctx.x0 + w * 0.75);
  const cover = new Array<number>(hi - lo + 1).fill(0);
  for (const ss of segsOf) for (const sg of ss) for (let x = Math.max(lo, Math.floor(sg.x - 2)); x <= Math.min(hi, Math.ceil(sg.x2 + 2)); x++) cover[x - lo]++;
  // The gutter: the middle of the widest run of least-covered positions.
  const least = Math.min(...cover);
  let best = -1;
  let len = 0;
  for (let x = 0; x < cover.length; ) {
    if (cover[x] !== least) {
      x++;
      continue;
    }
    let e = x;
    while (e < cover.length && cover[e] === least) e++;
    if (e - x > len) [best, len] = [x + (e - x) / 2, e - x];
    x = e;
  }
  if (best < 0 || len < 4) return [];
  const g = lo + best;
  const crosses = segsOf.map((ss) => ss.some((sg) => sg.x < g - 1 && sg.x2 > g + 1));
  const side = (l: SLine, k: number) => l.items.filter((it) => it.str.trim() && (it.x + it.w / 2 < g) === (k === 0));
  const zones: { from: number; to: number; gutter: number }[] = [];
  for (let k = 0; k < lines.length; ) {
    if (crosses[k]) {
      k++;
      continue;
    }
    let e = k;
    while (e < lines.length && !crosses[e]) e++;
    let from = k;
    let to = e;
    k = e;
    // Small print on one side only before or after the columns (a note, a footnote) is outside them.
    const size = median(lines.slice(from, to).map((l) => l.dom));
    const oneSided = (l: SLine) => !side(l, 0).length || !side(l, 1).length;
    while (to - from > 0 && oneSided(lines[to - 1]) && lines[to - 1].dom < size * 0.9) to--;
    while (to - from > 0 && oneSided(lines[from]) && lines[from].dom < size * 0.9) from++;
    const zl = lines.slice(from, to);
    if (zl.length < 6) continue;
    const sides = [0, 1].map((n) => linesFromItems(zl.flatMap((l) => side(l, n)), ctx.pt));
    if (!proseSides(sides, ctx.body)) continue;
    // Lines paired across the gutter whose paragraphs break at the same heights are rows of a table.
    const paired = zl.filter((l) => side(l, 0).length && side(l, 1).length).length;
    if (paired / zl.length > 0.6) {
      const breaks = sides.map((sd) => {
        const steps = sd.slice(1).map((l, n) => l.y - sd[n].y);
        const usual = median(steps);
        return sd.slice(1).filter((_, n) => steps[n] > usual * 1.3).map((l) => l.y);
      });
      const shared = breaks[0].filter((y) => breaks[1].some((v) => Math.abs(v - y) < 3));
      if (breaks[0].length >= 2 && shared.length >= breaks[0].length * 0.7) continue;
    }
    // Rules across the gutter inside the stretch belong to a table or a grid of cards.
    const top = Math.min(...zl.map((l) => l.y));
    const bottom = Math.max(...zl.map((l) => l.y + l.h));
    if (ctx.hrules.some((r) => r.y > top && r.y < bottom && r.x < g - 4 && r.x + r.w > g + 4)) continue;
    zones.push({ from, to, gutter: g });
  }
  return zones;
}

/* ------------------------------------------------------------- headings */

function headingAt(lines: SLine[], segs: Segment[][], i: number, ctx: Ctx): { block: SBlock; end: number } | null {
  const l = lines[i];
  if (segs[i].length !== 1) return null;
  const text = l.text;
  if (text.length > 150 || !/\p{L}/u.test(text)) return null;
  const big = l.dom >= ctx.body * 1.18;
  const boldish = l.bold && l.dom >= ctx.body * 0.98 && text.length < 80 && !/[.:,;!?]$/.test(text) && !markerAt(l, ctx);
  if ((!big && !boldish) || l.dom < ctx.body * 0.95) return null;
  // A heading that wraps continues with lines of the same size and weight.
  let end = i + 1;
  while (
    end < lines.length &&
    segs[end].length === 1 &&
    Math.abs(lines[end].dom - l.dom) < 0.6 &&
    lines[end].bold === l.bold &&
    lines[end].y - (lines[end - 1].y + lines[end - 1].h) < l.h * 0.8 &&
    Math.abs(lines[end].x - l.x) < l.dom * 2
  )
    end++;
  const group = lines.slice(i, end);
  const runs: Run[] = [];
  // Lines well short of the column were broken on purpose: keep those breaks.
  const deliberate = group.length > 1 && group.slice(0, -1).every((g) => g.w < (ctx.x1 - ctx.x0) * 0.75);
  for (const g of group) {
    const add = lineRuns(g);
    if (deliberate && runs.length && add.length) {
      runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd();
      runs.push({ ...add[0], br: true }, ...add.slice(1));
    } else joinRuns(runs, add);
  }
  const merged = mergeRuns(runs);
  const all = merged.map((r) => (r.br ? " " : "") + r.text).join("");
  if (all.length > 200) return null;
  // Large type set as sentences over several lines is a pull quote: one paragraph, not a heading.
  if (end - i >= 2 && !l.bold && /[.!?]["”’)]?$/.test(all)) {
    const bar = barOf(l, ctx);
    return { block: { kind: "para", runs: merged, page: ctx.page, ...alignOf(group, ctx), ...(bar ? { bar } : {}), geo: geoOf(group) }, end };
  }
  return { block: { kind: "heading", level: 1, text: all, runs: merged, size: l.dom, page: ctx.page, geo: geoOf(group) }, end };
}

/* ------------------------------------------------------------- lists */

type Marker = { kind: ListFormat["kind"]; value: number; before: string; after: string; bullet?: string; x: number; textX: number; letter?: string; run?: ListFormat["run"] };

type Ch = { c: string; x: number; x2: number; it: Item };
function charsOf(items: Item[]): Ch[] {
  const out: Ch[] = [];
  for (const it of items) {
    const n = it.str.length;
    for (let k = 0; k < n; k++) out.push({ c: it.str[k], x: it.x + (it.w * k) / n, x2: it.x + (it.w * (k + 1)) / n, it });
  }
  return out;
}

// Bullets, including the private-use codes Symbol and Wingdings bullets come through as (Word's ""; "", "").
const BULLETS = /^[•●▪■◦○‣∙·➢►➤✓✔❖♦◆□☐❑→–—*\-\uF0B7\uF0A7\uF0D8\uF076\uF0FC\uF06E\uF0A8\uF0E0\uF0F0]$/;

/** A list marker at the start of a line (or of the part of it from x0): numbers, letters, bullets, or a drawn check box. */
function markerAt(l: SLine, ctx: Ctx, x0 = -Infinity): Marker | null {
  const chs = charsOf(sliceItems(l.items, x0));
  let k = 0;
  while (k < chs.length && !chs[k].c.trim()) k++;
  if (k >= chs.length) return null;
  const first = chs[k];
  // A check box or bullet drawn just left of the text.
  const mark = ctx.marks.find((m) => m.x + m.w <= first.x + 1 && first.x - (m.x + m.w) < first.it.fontSize * 2.5 && m.x >= x0 - 1 && Math.min(m.y + m.h, l.y + l.h) - Math.max(m.y, l.y) > Math.min(m.h, l.h) * 0.4);
  if (mark) return { kind: mark.check ? "check" : "bullet", value: 1, before: "", after: "", bullet: mark.bullet, x: mark.x, textX: first.x };
  let e = k + 1;
  while (e < chs.length && chs[e].c.trim() && chs[e].x - chs[e - 1].x2 < chs[e].it.fontSize * 0.15 && e - k < 8) e++;
  const token = chs.slice(k, e).map((c) => c.c).join("");
  let n = e;
  while (n < chs.length && !chs[n].c.trim()) n++;
  if (n >= chs.length) return null;
  const next = chs[n];
  const em = first.it.fontSize;
  const gap = next.x - chs[e - 1].x2;
  const a = first.it;
  const b = next.it;
  const styled = a.bold !== b.bold || (a.color ?? "") !== (b.color ?? "") || Math.abs(a.fontSize - b.fontSize) > 0.6 || (a.face ?? "") !== (b.face ?? "");
  const it0 = first.it;
  const at = { x: first.x, textX: next.x, run: { size: half(it0.fontSize), color: it0.color, bold: it0.bold, face: it0.face, family: it0.family } };
  if (BULLETS.test(token)) return { kind: "bullet", value: 1, before: "", after: "", bullet: /[–—*-]/.test(token) ? "–" : /[▪■\uF0A7\uF06E]/.test(token) ? "▪" : /[◦○]/.test(token) ? "◦" : "•", ...at };
  let m = token.match(/^(\()?(\d{1,3})([.)])$/) ?? token.match(/^(\[)(\d{1,3})(\])$/);
  if (m) return { kind: "decimal", value: Number(m[2]), before: m[1] ?? "", after: m[3], ...at };
  m = token.match(/^(\()?([a-zA-Z])([.)])$/);
  if (m) return { kind: m[2] === m[2].toLowerCase() ? "lowerLetter" : "upperLetter", value: m[2].toLowerCase().charCodeAt(0) - 96, before: m[1] ?? "", after: m[3], letter: m[2], ...at };
  m = token.match(/^(\()?([ivxlc]{2,5}|[IVXLC]{2,5})([.)])$/);
  if (m) return { kind: m[2] === m[2].toLowerCase() ? "lowerRoman" : "upperRoman", value: romanValue(m[2]), before: m[1] ?? "", after: m[3], ...at };
  // Bare numbers and letters count only when set apart: another style, or a wide gap.
  if (/^\d{1,3}$/.test(token) && ((styled && gap > em * 0.25) || gap >= em * 1.5)) return { kind: "decimal", value: Number(token), before: "", after: "", ...at };
  if (/^[a-z]$/.test(token) && styled && gap > em * 0.3) return { kind: "lowerLetter", value: token.charCodeAt(0) - 96, before: "", after: "", letter: token, ...at };
  return null;
}

const sameFamily = (a: Marker, b: Marker) => {
  const fam = (k: Marker["kind"]) => (k === "lowerLetter" || k === "lowerRoman" ? "lower" : k === "upperLetter" || k === "upperRoman" ? "upper" : k);
  return fam(a.kind) === fam(b.kind) && a.after === b.after && a.before === b.before;
};

type LItem = { m: Marker; col: number; runs: Run[]; children: LItem[]; childFormat?: ListFormat; top: number; bottom: number; bases: number[]; size: number };

/**
 * A list starting at line i. Items continue on lines aligned with their text (hanging
 * indents); deeper markers start a nested list; a line can hold items side by side
 * (a list set in columns), read in the order of their numbers.
 */
function findList(lines: SLine[], segs: Segment[][], i: number, ctx: Ctx, minX = -Infinity): { block: SBlock; end: number; items: LItem[]; format: ListFormat } | null {
  const m0 = markerAt(lines[i], ctx, minX);
  if (!m0) return null;
  // Columns: further markers of the same kind on this line, after a wide gap.
  const cols = [m0];
  for (;;) {
    const last = cols[cols.length - 1];
    const rest = charsOf(sliceItems(lines[i].items, last.textX + 1)).filter((c) => c.c.trim());
    let found: Marker | null = null;
    for (let k = 1; k < rest.length; k++) {
      if (rest[k].x - rest[k - 1].x2 > rest[k].it.fontSize * 2) {
        const mk = markerAt(lines[i], ctx, rest[k].x - 0.5);
        if (mk && sameFamily(mk, m0) && mk.kind !== "bullet" && mk.kind !== "check") found = mk;
        break;
      }
    }
    if (!found) break;
    cols.push(found);
  }
  if (cols.length > 1 && !cols.slice(1).every((c) => lines.slice(i + 1, i + 8).some((l) => markerAt(l, ctx, c.x - 2)?.x !== undefined && Math.abs(markerAt(l, ctx, c.x - 2)!.x - c.x) < 4))) cols.length = 1;
  const bounds = cols.map((c, k) => [c.x - 3, k + 1 < cols.length ? cols[k + 1].x - 3 : Infinity]);
  // The text after the marker must be one piece; several columns of text make it a table row.
  const textSegs = (l: SLine, x0: number, x1: number) => segments({ ...l, items: sliceItems(l.items, x0, x1) } as Line).length;
  if (cols.some((c, k) => textSegs(lines[i], c.textX - 0.5, bounds[k][1]) !== 1)) return null;

  const items: LItem[] = [];
  const open: (LItem | null)[] = cols.map(() => null);
  const lineH = lines[i].h;
  let end = i;
  for (let j = i; j < lines.length; j++) {
    const l = lines[j];
    if (j > i) {
      const prev = lines[j - 1];
      if (l.y - (prev.y + prev.h) > Math.max(lineH, prev.h) * 2.6) break;
      if (l.dom >= ctx.body * 1.18 && headingAt(lines, segs, j, ctx)) break;
      if (l.x < cols[0].x - 4) break;
    }
    let ok = true;
    let nested = false;
    for (let k = 0; k < cols.length && ok; k++) {
      const [x0, x1] = bounds[k];
      const part = sliceItems(l.items, x0, x1);
      if (!part.some((it) => it.str.trim())) continue;
      const px = Math.min(...part.filter((it) => it.str.trim()).map((it) => it.x));
      const mk = markerAt(l, ctx, x0);
      const cur = open[k];
      if (mk && Math.abs(mk.x - cols[k].x) < 4 && sameFamily(mk, cols[k]) && textSegs(l, mk.textX - 0.5, x1) === 1) {
        const it: LItem = { m: mk, col: k, runs: itemsRuns(sliceItems(l.items, mk.textX - 0.5, x1), l.dom), children: [], top: l.y, bottom: l.y + l.h, bases: [l.domBase], size: l.dom };
        items.push(it);
        open[k] = it;
      } else if (cur && cols.length === 1 && mk && mk.x > cols[k].x + 6 && mk.x <= cur.m.textX + 48) {
        // A nested list under the current item.
        const sub = findList(lines, segs, j, ctx, mk.x - 2);
        if (!sub || sub.end <= j) {
          ok = false;
          break;
        }
        cur.children.push(...sub.items);
        cur.childFormat = sub.format;
        j = sub.end - 1;
        nested = true;
      } else if (cur && px >= cur.m.textX - 4) {
        joinRuns(cur.runs, itemsRuns(part, l.dom));
        cur.bottom = Math.max(cur.bottom, l.y + l.h);
        cur.bases.push(l.domBase);
      } else ok = false;
    }
    if (!ok) break;
    end = j + 1;
    if (nested) continue;
  }
  if (!items.length) return null;
  // Read side-by-side items in the order of their numbers when they run in sequence.
  let ordered = items;
  let columns: number | undefined;
  if (cols.length > 1) {
    const vals = items.map((it) => it.m.value);
    const sorted = [...vals].sort((a, b) => a - b);
    const seq = sorted.every((v, k) => k === 0 || v === sorted[k - 1] + 1);
    const down = [...items].sort((a, b) => a.col - b.col);
    ordered = seq ? [...items].sort((a, b) => a.m.value - b.m.value) : down;
    // Numbered down each column in turn (not across): keep the columns.
    if (seq && down.every((it, k) => it === ordered[k])) columns = cols.length;
  }
  // Bare numbers, and letters (an initial like "A. Rao" looks the same), need a run of them to count as a list.
  if (ordered.length < 2 && m0.kind !== "bullet" && m0.kind !== "check" && (!m0.after || m0.kind !== "decimal")) return null;
  const firstM = ordered[0].m;
  let kind = firstM.kind;
  let start = firstM.value;
  // "i." before "ii." is a roman numeral, not the letter i.
  if (kind === "lowerLetter" && firstM.letter === "i" && ordered[1]?.m.kind === "lowerRoman") [kind, start] = ["lowerRoman", 1];
  if (kind === "upperLetter" && firstM.letter === "I" && ordered[1]?.m.kind === "upperRoman") [kind, start] = ["upperRoman", 1];
  const indent = { left: Math.max(0, firstM.textX - ctx.x0), hanging: Math.max(9, firstM.textX - firstM.x) };
  const format: ListFormat = { kind, before: firstM.before, after: firstM.after, start, ...(firstM.bullet ? { bullet: firstM.bullet } : {}), ...(firstM.run ? { run: firstM.run } : {}), indent };
  const flat: Run[][] = [];
  const levels: number[] = [];
  const formats: ListFormat[] = [format];
  const geos: LItem[] = [];
  const add = (its: LItem[], lvl: number, f?: ListFormat) => {
    if (f) formats[lvl] ??= f;
    for (const it of its) {
      flat.push(mergeRuns(it.runs));
      levels.push(lvl);
      geos.push(it);
      add(it.children, lvl + 1, it.childFormat);
    }
  };
  add(ordered, 0);
  // Gaps between items; where the next item sits beside this one or heads another column,
  // the usual gap between items of that level read down a column.
  const lvlOf = new Map(geos.map((g, k) => [g, levels[k]]));
  const raw = geos.slice(1).map((g, k) => g.top - geos[k].bottom);
  const usual = (lvl: number) => median(raw.filter((g, k) => g >= 0 && lvlOf.get(geos[k]) === lvl && lvlOf.get(geos[k + 1]) === lvl));
  const gaps = raw.map((g, k) => (g >= 0 ? g : usual(levels[k + 1]) || usual(levels[k]) || 0));
  const geo: Geo = {
    top: Math.min(...geos.map((g) => g.top)),
    bottom: Math.max(...geos.map((g) => g.bottom)),
    first: geos[0].size,
    last: geos[geos.length - 1].size,
    leading: median(geos.map((g) => leadingOf(g.bases, g.size)).filter((v): v is number => v !== undefined)) || undefined,
  };
  // Rules drawn between items (and under the last), across most of the list's width.
  const lx0 = Math.min(...geos.map((g) => g.m.x));
  const lx1 = ctx.x1;
  const rules = geos.map((g, k) => {
    const below = k + 1 < geos.length ? geos[k + 1].top : g.bottom + g.size * 3;
    if (below < g.bottom) return null;
    const r = ctx.hrules.find((h) => h.y >= g.bottom - 1 && h.y + h.h <= below + 1 && h.w >= (lx1 - lx0) * 0.6 && h.x < lx0 + 20);
    return r ? { color: r.color ?? "#000000", at: r.y - g.bottom, h: r.h } : null;
  });
  const isOrdered = format.kind !== "bullet" && format.kind !== "check";
  return { block: { kind: "list", ordered: isOrdered, items: flat, levels, formats, ...(columns ? { columns } : {}), gaps, ...(rules.some(Boolean) ? { rules } : {}), page: ctx.page, geo }, end, items: ordered, format };
}

/* ------------------------------------------------------------- tables */

/** Page → rows of cells for spreadsheets: tables become cells, other lines stay in column A. */
export function pageGrid(pt: PageText): string[][] {
  const lines = toLines(pt);
  const segs = lines.map(segments);
  const rows: string[][] = [];
  let i = 0;
  while (i < lines.length) {
    const t = findTable(lines, segs, i);
    if (t) {
      rows.push(...t.cells.map((r) => r.map((c) => c.text)));
      i = t.end;
      continue;
    }
    rows.push([lines[i].text]);
    i++;
  }
  return rows;
}

type Band = { x0: number; x1: number };
/** A piece of text placed in a column; `span` marks a heading that stretches over several columns. */
type Placed = Segment & { y: number; h: number; base: number; size: number; bold: boolean; band: number; span: boolean };
type TableHit = { end: number; cells: Cell[][]; header: boolean; widths: number[]; lines?: "rows" | "grid"; lineColor?: string; rowRules?: (string | null)[]; pad?: { x: number; y: number }; leading?: number };
type TableCtx = { body: number; hrules: Rule[]; vrules: Rule[]; fills: Box[]; outlines: Box[] };

/** Left edges that line up across at least `min` of the given lines. */
function sharedStarts(rows: Segment[][], min: number): number[] {
  const pts = rows.flatMap((r, ri) => r.map((sg) => ({ x: sg.x, ri }))).sort((a, b) => a.x - b.x);
  const groups: { x: number; n: number; rows: Set<number> }[] = [];
  for (const p of pts) {
    const g = groups[groups.length - 1];
    if (g && p.x - g.x <= 10) {
      g.x = (g.x * g.n + p.x) / (g.n + 1);
      g.n++;
      g.rows.add(p.ri);
    } else groups.push({ x: p.x, n: 1, rows: new Set([p.ri]) });
  }
  return groups.filter((g) => g.rows.size >= min).map((g) => g.x);
}

/** Cut a segment where a column edge falls inside it (cells whose text nearly touches). */
function splitAtStarts(sg: Segment, starts: number[]): Segment[] {
  const cuts = starts.filter((x) => x > sg.x + 4 && x < sg.x2 - 4);
  if (!cuts.length || sg.items.length < 2) return [sg];
  const parts: TextItem[][] = [[]];
  let ci = 0;
  for (const it of sg.items) {
    let cut = false;
    while (ci < cuts.length && it.x >= cuts[ci] - 6) {
      cut = true;
      ci++;
    }
    if (cut && parts[parts.length - 1].length) parts.push([]);
    parts[parts.length - 1].push(it);
  }
  return parts.filter((p) => p.length).map(segmentOf);
}

/** Columns: horizontal ranges covered by text, separated by empty gutters. */
function bandsOf(segs: Segment[]): Band[] {
  const out: Band[] = [];
  for (const sg of [...segs].sort((a, b) => a.x - b.x)) {
    const last = out[out.length - 1];
    if (last && sg.x <= last.x1 + 3) last.x1 = Math.max(last.x1, sg.x2);
    else out.push({ x0: sg.x, x1: sg.x2 });
  }
  return out;
}

function bandIndex(bands: Band[], x: number): number {
  let best = 0;
  for (let k = 0; k < bands.length; k++) if (bands[k].x0 - 4 <= x) best = k;
  return best;
}

function place(sg: Segment, band: number, span = false): Placed {
  const y = Math.min(...sg.items.map((i) => i.y));
  const n = sg.items.reduce((k, i) => k + i.str.length, 0) || 1;
  return {
    ...sg,
    band,
    span,
    y,
    h: Math.max(...sg.items.map((i) => i.y + i.h)) - y,
    base: sg.items.reduce((k, i) => k + i.base, 0) / sg.items.length,
    size: sg.items.reduce((k, i) => k + i.fontSize * i.str.length, 0) / n,
    bold: sg.items.filter((i) => i.bold).reduce((k, i) => k + i.str.length, 0) / n > 0.6,
  };
}

/** Where the vertical gaps between lines split into "inside a row" and "between rows" (Otsu). */
function rowGapThreshold(gaps: number[], lineH: number): number | null {
  if (gaps.length < 2) return gaps.length === 1 && gaps[0] > lineH * 0.6 ? gaps[0] - 0.01 : null;
  const v = [...gaps].sort((a, b) => a - b);
  let best = -1;
  let split = 0;
  for (let p = 1; p < v.length; p++) {
    const lo = v.slice(0, p);
    const hi = v.slice(p);
    const m0 = lo.reduce((a, b) => a + b, 0) / lo.length;
    const m1 = hi.reduce((a, b) => a + b, 0) / hi.length;
    const between = lo.length * hi.length * (m1 - m0) ** 2;
    if (between > best) {
      best = between;
      split = p;
    }
  }
  const lo = v.slice(0, split);
  const hi = v.slice(split);
  const m0 = lo.reduce((a, b) => a + b, 0) / lo.length;
  const m1 = hi.reduce((a, b) => a + b, 0) / hi.length;
  return m1 - m0 >= lineH * 0.4 && m1 >= m0 * 1.8 + 1 ? (v[split - 1] + v[split]) / 2 : null;
}

/** Turn a cell's text pieces (top to bottom) into paragraphs of styled runs, with their spacing. */
function cellOf(parts: Placed[], fill?: string): Cell {
  const paras: { runs: Run[]; last: Placed; lines: number; top: number; bottom: number; bases: number[]; size: number }[] = [];
  for (const p of parts.sort((a, b) => a.base - b.base || a.x - b.x)) {
    const runs = itemsRuns(p.items as Item[]);
    const prev = paras[paras.length - 1];
    if (prev) {
      const sameLine = Math.abs(p.base - prev.last.base) < Math.max(2, p.size * 0.3);
      const gap = p.y - (prev.last.y + prev.last.h);
      const styleBreak = (prev.lines === 1 && prev.last.bold !== p.bold && runsText(prev.runs).length < 40) || p.span || prev.last.span;
      if (sameLine || (Math.abs(p.size - prev.last.size) <= 0.8 && gap < p.h * 0.9 && !styleBreak)) {
        joinRuns(prev.runs, runs);
        prev.last = p;
        prev.bottom = Math.max(prev.bottom, p.y + p.h);
        if (!sameLine) {
          prev.lines++;
          prev.bases.push(p.base);
        }
        continue;
      }
    }
    paras.push({ runs, last: p, lines: 1, top: p.y, bottom: p.y + p.h, bases: [p.base], size: p.size });
  }
  const kept = paras.map((p) => ({ ...p, runs: mergeRuns(p.runs) })).filter((p) => p.runs.length);
  const out = kept.map((p) => p.runs);
  const geo = {
    gaps: kept.slice(1).map((p, k) => Math.max(0, p.top - kept[k].bottom)),
    leadings: kept.map((p) => leadingOf(p.bases, p.size)),
    sizes: kept.map((p) => half(p.size)),
  };
  return { paras: out, text: out.map(runsText).join("\n"), geo, ...(fill ? { fill } : {}) };
}

const domOf = (l: Line) => (l as SLine).dom ?? l.size;

/**
 * A table starting at line `start`, if there is one. Columns come from the gutters
 * between text; rows from rules drawn between them, the spacing between lines (cell
 * padding) or, in tightly set tables, from a new entry in the first column. Wrapped text
 * stays in its cell.
 */
export function findTable(lines: Line[], segs: Segment[][], start: number, ctx?: TableCtx): TableHit | null {
  if (segs[start].length < 2) return null;
  const hr = ctx?.hrules ?? [];
  // A rule drawn across the whole gap between two lines (one under a group of columns in a
  // grouped header doesn't end the row: the cell beside it carries on).
  const ruleBetween = (a: Line, b: Line, x0: number, x1: number) => {
    const span = hr.filter((r) => r.y >= a.y + a.h * 0.5 && r.y + r.h <= b.y + b.h * 0.5).filter((r) => r.x < x1 && r.x + r.w > x0);
    const cover = span.reduce((n, r) => n + Math.min(r.x + r.w, x1) - Math.max(r.x, x0), 0);
    return span.length && cover >= (x1 - x0) * 0.9 ? span : null;
  };
  // 1. Grow the region: lines with several cells, plus lone lines that sit inside one column.
  const region = [start];
  let bottom = lines[start].y + lines[start].h;
  let left = segs[start][0].x;
  let right = segs[start][segs[start].length - 1].x2;
  const multi = () => region.filter((k) => segs[k].length >= 2);
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j];
    const sg = segs[j];
    if (!sg.length) break;
    const m = multi();
    const lineH = median(m.map((k) => lines[k].h));
    const ruled = ruleBetween(lines[j - 1], l, left, right);
    if (l.y - bottom > lineH * (ruled ? 4.5 : 2.6)) break;
    if (ctx ? sg.length === 1 && domOf(l) >= ctx.body * 1.25 : l.size > median(m.map((k) => lines[k].size)) * 1.35) break;
    if (sg.length < 2) {
      const starts = sharedStarts(m.map((k) => segs[k]), 1);
      const s0 = sg[0];
      if (starts.some((x) => x > s0.x + 6 && x < s0.x2 - 6)) break;
      if (s0.x < left - 8) {
        // Left of everything so far: only a row label under a grouped header (the rows below start here too).
        const below = lines.slice(j + 1, j + 5).filter((nl, n) => segs[j + 1 + n].length >= 2 && nl.y - (l.y + l.h) < lineH * 4);
        if (!below.some((nl) => Math.abs(segments(nl)[0].x - s0.x) <= 12)) break;
        left = s0.x;
      }
    } else {
      left = Math.min(left, sg[0].x);
      right = Math.max(right, sg[sg.length - 1].x2);
    }
    region.push(j);
    bottom = Math.max(bottom, l.y + l.h);
  }
  const multiLines = multi();
  if (multiLines.length < 2) return null;

  // 2. Columns.
  const starts = sharedStarts(multiLines.map((k) => segs[k]), 2);
  const pieces = new Map<number, Segment[]>(region.map((k) => [k, segs[k].flatMap((sg) => splitAtStarts(sg, starts))]));
  // Columns come from the fullest rows; other text widens them, joins none of them up
  // (a heading spanning several columns stays one cell) or adds a column of its own.
  const counts = multiLines.map((k) => pieces.get(k)!.length);
  const typical = median(counts);
  const core = multiLines.filter((k) => pieces.get(k)!.length >= typical);
  const bands = bandsOf(core.flatMap((k) => pieces.get(k)!));
  for (const k of region) {
    if (core.includes(k)) continue;
    for (const sg of pieces.get(k)!) {
      const hit = bands.filter((b) => Math.min(b.x1, sg.x2) - Math.max(b.x0, sg.x) > 3);
      if (hit.length === 1) {
        hit[0].x0 = Math.min(hit[0].x0, sg.x);
        hit[0].x1 = Math.max(hit[0].x1, sg.x2);
      } else if (!hit.length && !bands.some((b) => sg.x <= b.x1 + 3 && sg.x2 >= b.x0 - 3)) bands.push({ x0: sg.x, x1: sg.x2 });
    }
  }
  bands.sort((a, b) => a.x0 - b.x0);
  if (bands.length < 2 || bands.length > 20) return null;
  // Ordinary cell text stays inside its column; anything reaching past it is a heading over several columns.
  const placed = new Map<number, Placed[]>(
    region.map((k) => [
      k,
      pieces.get(k)!.map((sg) => {
        const b = bandIndex(bands, sg.x);
        return place(sg, b, sg.x2 > bands[b].x1 + 3);
      }),
    ]),
  );
  const aligned = multiLines.filter((k) => new Set(placed.get(k)!.map((p) => p.band)).size >= 2).length;
  if (aligned / multiLines.length < 0.7) return null;

  // 3. Rows: a rule drawn between lines always starts a new row; otherwise the spacing decides.
  const tx0 = bands[0].x0;
  const tx1 = bands[bands.length - 1].x1;
  const ruledGaps = new Set<number>();
  const usedRules: Rule[] = [];
  region.slice(1).forEach((k, gi) => {
    const r = ruleBetween(lines[region[gi]], lines[k], tx0, tx1);
    if (r) {
      ruledGaps.add(gi);
      usedRules.push(...r);
    }
  });
  const lineH = median(region.map((k) => lines[k].h));
  const gaps: number[] = [];
  let low = lines[region[0]].y + lines[region[0]].h;
  for (const k of region.slice(1)) {
    gaps.push(Math.max(0, lines[k].y - low));
    low = Math.max(low, lines[k].y + lines[k].h);
  }
  const cut = rowGapThreshold(gaps, lineH);
  const hasFirst = (k: number) => placed.get(k)!.some((p) => p.band === 0);
  // A line whose first-column text starts in lower case continues the cell above.
  const continues = (k: number) => /^[a-z]/.test(placed.get(k)!.find((p) => p.band === 0)?.text ?? "");
  let groups: number[][] = [[region[0]]];
  region.slice(1).forEach((k, gi) => {
    const breakRow = ruledGaps.has(gi) || (cut !== null ? gaps[gi] > cut : hasFirst(k) && !continues(k));
    if (breakRow) groups.push([k]);
    else groups[groups.length - 1].push(k);
  });
  // Padded tables whose rows are single lines anyway, apart from a gap under the header:
  // if nearly every following line starts a new entry, each line is its own row.
  if (cut !== null && !ruledGaps.size) {
    groups = groups.flatMap((g) => {
      const rest = g.slice(1);
      const full = rest.filter((k) => hasFirst(k) && segs[k].length >= 2 && !continues(k)).length;
      const even = new Set(g.map((k) => Math.round(domOf(lines[k])))).size === 1;
      return rest.length >= 2 && even && full / rest.length >= 0.8 ? g.map((k) => [k]) : [g];
    });
  }
  // A lone line under the table (a note or caption) is not a row.
  while (groups.length > 1 && !groups[groups.length - 1].some((k) => segs[k].length >= 2)) groups.pop();
  if (groups.length < 2) return null;

  // 4. Cells, with any shading drawn behind them.
  const cells = groups.map((g) =>
    bands.map((_, b) => {
      const parts = g.flatMap((k) => placed.get(k)!.filter((p) => p.band === b));
      const fill = parts.length ? ctx?.fills.find((f) => parts.every((p) => centerIn(f, (p.x + p.x2) / 2, p.y + p.h / 2)))?.fill : undefined;
      return cellOf(parts, fill);
    }),
  );
  const filled = cells.flat().filter((c) => c.text).length;
  if (filled / (cells.length * bands.length) < 0.35) return null;
  // Columns set flush right (figures) or centred: every piece of text ends (or centres) at
  // the same place while their starts wander.
  bands.forEach((_, b) => {
    // Judged on the body rows; a header cell follows when it lines up the same way.
    const pieces = (gs: number[][]) => gs.flatMap((g) => g.flatMap((k) => placed.get(k)!.filter((p) => p.band === b && !p.span)));
    const body = pieces(groups.length >= 3 ? groups.slice(1) : groups);
    if (body.length < 2) return;
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    const starts = spread(body.map((p) => p.x));
    // Figures of equal width line up both ways; figures are set flush right by convention.
    const figures = body.every((p) => /^[-+(]?[₹$€£]?\s?[\d.,]+\s?%?\)?$/.test(p.text.trim()));
    const right = spread(body.map((p) => p.x2)) < 2.5 && (starts > 4 || figures);
    const centre = !right && spread(body.map((p) => (p.x + p.x2) / 2)) < 2.5 && starts > 4;
    if (!right && !centre) return;
    const end = Math.max(...body.map((p) => p.x2));
    const mid = (Math.max(...body.map((p) => p.x)) + Math.min(...body.map((p) => p.x2))) / 2;
    const head = pieces(groups.slice(0, 1));
    const headFits = head.every((p) => (right ? Math.abs(p.x2 - end) < 2.5 : Math.abs((p.x + p.x2) / 2 - mid) < 3));
    cells.forEach((row, ri) => {
      if (row[b].text && (ri > 0 || groups.length < 3 || headFits)) row[b].align = right ? "right" : "center";
    });
  });
  const head = groups[0].flatMap((k) => placed.get(k)!);
  const headChars = head.reduce((n, p) => n + p.text.length, 0) || 1;
  const header = head.filter((p) => p.bold).reduce((n, p) => n + p.text.length, 0) / headChars >= 0.6;
  // Column widths from where each column starts.
  const gutter = bands.length > 1 ? median(bands.slice(1).map((b, k) => b.x0 - bands[k].x1)) : 0;
  const raw = bands.map((b, k) => Math.max(1, (k + 1 < bands.length ? bands[k + 1].x0 : b.x1 + gutter) - b.x0));
  const total = raw.reduce((a, b) => a + b, 0);
  const floored = raw.map((w) => Math.max(w / total, 0.05));
  const sum = floored.reduce((a, b) => a + b, 0);
  const end = groups[groups.length - 1][groups[groups.length - 1].length - 1] + 1;
  // Lines drawn in the PDF: a grid (ruled columns, or every cell outlined), or rules above,
  // between and below the rows, each in its own colour.
  const top = lines[region[0]].y;
  const bottomY = Math.max(...groups[groups.length - 1].map((k) => lines[k].y + lines[k].h));
  const within = (r: Rect) => r.y < bottomY + 2 && r.y + r.h > top - 2 && r.x + r.w > tx0 - 12 && r.x < tx1 + 12;
  const vr = (ctx?.vrules ?? []).filter(within);
  const ol = (ctx?.outlines ?? []).filter(within);
  const colorOf = (rs: Rule[]) => mode(rs.reduce((m, r) => tally(m, r.color ?? "#000000", r.w + r.h), new Map<string, number>()));
  const ruleIn = (y0: number, y1: number) => {
    const span = hr.filter((r) => r.y >= y0 - 1 && r.y + r.h <= y1 + 1 && r.x < tx1 && r.x + r.w > tx0);
    const cover = span.reduce((n, r) => n + Math.min(r.x + r.w, tx1) - Math.max(r.x, tx0), 0);
    return span.length && cover >= (tx1 - tx0) * 0.5 ? (colorOf(span) ?? "#000000") : null;
  };
  const gTop = (g: number[]) => Math.min(...g.map((k) => lines[k].y));
  const gBottom = (g: number[]) => Math.max(...g.map((k) => lines[k].y + lines[k].h));
  const rowRules = [
    ruleIn(gTop(groups[0]) - lineH * 2.5, gTop(groups[0])),
    ...groups.slice(1).map((g, k) => ruleIn(gBottom(groups[k]), gTop(g))),
    ruleIn(bottomY, bottomY + lineH * 2.5),
  ];
  const drawn =
    vr.length >= 2 || ol.length >= 2
      ? { lines: "grid" as const, lineColor: colorOf([...vr, ...ol.map((o) => ({ ...o, color: o.stroke }))]) }
      : rowRules.some(Boolean)
        ? { lines: "rows" as const, lineColor: colorOf(usedRules), rowRules }
        : {};
  // Cell padding from the space between rows (and around rules); line spacing inside cells.
  const rowGaps = groups.slice(1).map((g, k) => gTop(g) - gBottom(groups[k]));
  const steps = groups.flatMap((g) =>
    bands.flatMap((_, b) => {
      const ps = g.flatMap((k) => placed.get(k)!.filter((p) => p.band === b)).sort((x, y) => x.base - y.base);
      return ps.slice(1).map((p, n) => p.base - ps[n].base).filter((d) => d > p0size(ps) * 0.9 && d < p0size(ps) * 2.2);
    }),
  );
  const pad = rowGaps.length ? { x: Math.min(10, Math.max(3, gutter / 2)), y: Math.min(14, Math.max(1.5, median(rowGaps) / 2)) } : undefined;
  return { end, cells, header, widths: floored.map((w) => w / sum), pad, leading: steps.length ? median(steps) : undefined, ...drawn };
}

const p0size = (ps: Placed[]) => (ps.length ? median(ps.map((p) => p.size)) : 10);
