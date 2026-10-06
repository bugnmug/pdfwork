/**
 * Recover document structure from positioned PDF text and the shapes drawn around it:
 * headings, paragraphs, lists (bulleted, numbered, lettered, check lists, nested lists and
 * lists set in columns), tables (ruled or aligned), boxed callouts and grids of cards, with
 * running headers, footers and page numbers removed. Text keeps its font, size and colour.
 * Used by PDF → Word / HTML / EPUB / Markdown / Excel.
 */
import { spaced, toLines, type Line, type PageText, type Pic, type Shape, type TextItem } from "./pdfjs";

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
  /** Letter-spacing: extra space after each character (points). */
  track?: number;
  /** Starts a new line (a line break the author set, inside a heading). */
  br?: boolean;
  /**
   * Follows a tab: "right", set flush right at the end of the line (a date across from a title);
   * "next", to the next stop (the text after a clause number, at the hanging indent); a number,
   * to a stop that many points in from the left edge of the text (options set in columns).
   */
  tab?: "right" | "next" | number;
  /** A picture set in the text (an icon before a phone number, a thumbnail in a row of a table); its text is "\uFFFC". */
  pic?: Pic;
  /** Set over a picture: its colour (white on a photo) is kept as it is. */
  onPic?: boolean;
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
  /** Space around the text inside the cell (points), where it differs from the table's. */
  margins?: { left: number; right: number; top: number; bottom: number };
  /** Its paragraphs hang this far after their first word (a label), in points. */
  hang?: number;
  /** Text set in the middle, or at the foot, of a taller row. */
  valign?: "center" | "bottom";
  /** The cell runs across this many columns (a group's name across the table, a heading over columns); the cells it covers are empty. */
  span?: number;
  /** Its text sits this far in from where its column's text starts (an item under a subtotal's name), in points. */
  indent?: number;
};
/**
 * Where a block sits, in points: the top of its first line (or its box) and the bottom of its
 * last, the sizes of those lines (0 for a box or table edge), baseline-to-baseline spacing
 * inside it, and the gap below it, to the next block or to the edge of the box it is in.
 */
export type Geo = {
  top: number;
  bottom: number;
  first: number;
  last: number;
  leading?: number;
  gap?: number;
  next?: number;
  /** Left and right edges (boxes). */
  left?: number;
  right?: number;
  /** The next block starts over this one (text set over a photo); `gap` then runs from this block's top. */
  under?: boolean;
};
/** How a list level is numbered: Word's number format, the text around the number, and the first value. */
export type ListFormat = {
  /** "none": no number from Word; the item's text carries its own label (a clause number like 2.1, or options set in a row). */
  kind: "bullet" | "check" | "decimal" | "lowerLetter" | "upperLetter" | "lowerRoman" | "upperRoman" | "none";
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
  | { kind: "heading"; level: 1 | 2 | 3; text: string; runs: Run[]; size: number; page: number; align?: "center" | "right"; under?: Under; geo?: Geo }
  | {
      kind: "para";
      runs: Run[];
      page: number;
      align?: "left" | "center" | "right" | "justify";
      /** Indents from the edges of the text, and of the first line (negative: it hangs out), in points. */
      indent?: { left: number; first: number; right?: number };
      bar?: string;
      keep?: boolean;
      under?: Under;
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
      /** Items set justified. */
      align?: "justify";
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
      /** How many rows at the top are header rows, where more than one (a heading over two columns above their own). */
      head?: number;
      /** Relative column widths, summing to 1. */
      widths: number[];
      /** Where the table sits: its left edge from the left edge of the text around it, and its width (points). */
      span?: { x: number; w: number };
      /** Lines drawn in the PDF: rules between rows, a full grid, or separate cards. Missing: none drawn. */
      lines?: "rows" | "grid" | "cards";
      lineColor?: string;
      /** For ruled rows: the colour of the rule above each row and, last, below the table (null: none). */
      rowRules?: (string | null)[];
      /** Space between a cell's edge and its text, and baseline-to-baseline spacing of cell text (points). */
      pad?: { x: number; y: number };
      /** Space below each row beyond its padding (all but the last), where rows sit further apart than usual (points). */
      rowSpace?: number[];
      /** How far the first column's text sits in from the table's left edge, where no lines are drawn down the side (points). */
      inset?: number;
      leading?: number;
      /** Keep the table on one page (and with what follows), as the box it came in. */
      keep?: boolean;
      /** A page break cut it in the PDF: it may break across pages in Word too. */
      broken?: boolean;
      /** A table that only sets content side by side (a sidebar beside the main text): where its left edge sits on the page, and its width (points). */
      layout?: { x: number; w: number; h?: number };
      /** For cards: where each card's box sits across the page, and the space below each row of cards but the last. */
      cardCols?: { x: number; w: number }[];
      cardRowGaps?: number[];
      page: number;
      geo?: Geo;
    }
  | { kind: "box"; blocks: SBlock[]; fill?: string; stroke?: string; pad?: { x: number; y: number }; page: number; geo?: Geo; broken?: boolean }
  /** Text set in columns, read down each column in turn (`starts`: where each column begins on the page). */
  | { kind: "columns"; count: number; blocks: SBlock[]; page: number; geo?: Geo; starts?: number[] }
  /** `deliberate`: the page ended early on purpose (a new chapter), not because it was full. */
  | { kind: "pagebreak"; page: number; deliberate?: boolean }
  /** A line drawn across the page between blocks; `inset`: how far in from the edges of the text it stops (points). */
  | { kind: "rule"; color: string; h: number; inset: { left: number; right: number }; page: number; geo?: Geo }
  /** Pictures in a row (one or more), where and how large each shows on the page (points). */
  | { kind: "image"; pics: Pic[]; page: number; geo?: Geo };

/** A line drawn under a heading or paragraph across the text: its colour, thickness, and distance below the text (points). */
export type Under = { color: string; h: number; at: number };

/** The document's running text: size, face and colour, line spacing and space between paragraphs (points). */
export type BodyStyle = { size: number; face?: string; family?: Family; color?: string; leading?: number; paraGap?: number };
/** Page size and the margins around the content, in points. */
export type PageLayout = { width: number; height: number; top: number; right: number; bottom: number; left: number };
/** One line of a running header or footer: its pieces by position ("{PAGE}" and "{PAGES}" stand for page numbers), and its look. */
export type FurnitureLine = { parts: { text: string; at: "left" | "center" | "right" }[]; size: number; color?: string; face?: string; family?: Family; bold: boolean; italic?: boolean; /** Distance from the top of the page (header) or the bottom (footer), points. */ edge: number };
/** Running header and footer lines, as they appear on the pages, and pictures that repeat with them (a logo), where they sit on the page. */
export type Furniture = { header: FurnitureLine[]; footer: FurnitureLine[]; pics?: { pic: Pic; at: "header" | "footer" }[] };

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
    if (spaced(text, it.str, it.x - x2, it.fontSize)) text += " ";
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
/** A horizontal or vertical line; `src` is the rule a moved copy (text in columns) was made from. */
type Rule = Rect & { color?: string; src?: Rule };
type Box = Rect & { fill?: string; stroke?: string };
/** A drawn list marker: an empty square (check box), or a bullet (a dot, ring or small square). */
type Mark = Rect & { check: boolean; bullet: string; color?: string };
/** A text item as used here: may be raised (superscript) or sit on a drawn badge. */
export type Item = TextItem & { sup?: boolean; bg?: string; /** Right edge of the badge it sits on. */ bgRight?: number; /** A picture set in the line, standing in as one character. */ pic?: Pic; /** Drawn over a picture. */ onPic?: boolean };
export type SLine = Omit<Line, "items"> & { items: Item[]; dom: number; domBase: number; /** Column it was read from, for text set in columns. */ col?: number };

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
    if (spaced(text, it.str, it.x - prevEnd, it.fontSize)) text += " ";
    text += it.str;
    prevEnd = Math.max(prevEnd, it.x + it.w);
  }
  l.text = text.replace(/\s+/g, " ").trim();
  // Extents from the visible text (see finishLine in pdfjs.ts); height from the text that isn't raised.
  const ink = l.items.filter((i) => i.str.trim());
  const shown = ink.length ? ink : l.items;
  const main = shown.filter((i) => !i.sup);
  const base = main.length ? main : shown;
  l.x = Math.min(...shown.map((i) => i.x));
  l.w = Math.max(...shown.map((i) => i.x + i.w)) - l.x;
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
export function linesOf(items: Item[], pt: { page: number; width: number; height: number }): SLine[] {
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
  if (it.track) r.track = Math.round(it.track * it.fontSize * 10) / 10;
  if (it.pic) r.pic = it.pic;
  if (it.onPic) r.onPic = true;
  return r;
}

const sameStyle = (a: Run, b: Run) =>
  !a.pic &&
  !b.pic &&
  !!a.onPic === !!b.onPic &&
  a.bold === b.bold && a.italic === b.italic && a.size === b.size && a.color === b.color && a.face === b.face && a.family === b.family && !!a.sup === !!b.sup && a.bg === b.bg && a.track === b.track && !b.br && b.tab === undefined;

/** Styled runs of a sequence of items (one line or part of one), with spaces where the gaps are. */
function itemsRuns(items: Item[], dom?: number): Run[] {
  const runs: Run[] = [];
  let prevEnd = -Infinity;
  for (const it of items) {
    if (!it.str) continue;
    let text = it.str;
    const last = runs[runs.length - 1];
    if (last && spaced(last.text, text, it.x - prevEnd, it.fontSize)) text = " " + text;
    const r = itemRun(it, text, dom);
    if (last && !last.pic && !r.pic && (sameStyle(last, r) || !text.trim())) last.text += text;
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
  // A word broken at its own hyphen (a code, a name) closes up again: LTD-SALARY.
  else if (last && /[A-Za-z0-9]-$/.test(last.text) && /^[A-Za-z0-9]/.test(add[0].text)) return void target.push(...add.map((r) => ({ ...r })));
  else if (last && !/\s$/.test(last.text)) last.text += " ";
  target.push(...add.map((r) => ({ ...r })));
}

/** Append a line's runs after a line break. */
function breakRuns(target: Run[], add: Run[]) {
  if (!add.length) return;
  const last = target[target.length - 1];
  if (last) last.text = last.text.trimEnd();
  target.push({ ...add[0], text: add[0].text.trimStart(), br: true }, ...add.slice(1).map((r) => ({ ...r })));
}

/**
 * Whether the line before `next` stopped short of the edge by more than next's first word
 * (and a space) needs: text that wraps by itself would have taken that word, so the line was
 * broken on purpose. Text set flush right has its room before the line.
 */
function endedEarly(prev: SLine, next: SLine, ctx: Ctx): boolean {
  if (/[-\u00ad]$/.test(prev.text)) return false;
  const first = next.items.find((it) => it.str.trim());
  if (!first) return false;
  const str = first.str.trimStart();
  const word = str.split(/\s/)[0];
  const need = (first.w * word.length) / (str.length || 1) + next.dom * 0.25 + 0.5;
  const width = ctx.x1 - ctx.x0;
  const room = ctx.x1 - (prev.x + prev.w);
  // A long line stopping mid-sentence, the sentence going on in lower case below, wrapped there
  // (the text is set narrower than the page's).
  if (prev.w >= width * 0.5 && !/[.:;!?]["”’)]?$/.test(prev.text) && /^\p{Ll}/u.test(next.text)) return false;
  if (room >= 1.5) return room > need;
  const flushRight = Math.abs(next.x + next.w - ctx.x1) < 1.5 && prev.x - ctx.x0 > width * 0.3;
  return flushRight && prev.x - ctx.x0 > need;
}

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameStyle(last, r)) last.text += r.text;
    else if (last && !last.pic && !r.text.trim()) last.text += r.text;
    else out.push({ ...r });
  }
  for (const r of out) r.text = r.text.replace(/\s+/g, " ");
  if (out.length) {
    out[0].text = out[0].text.trimStart();
    out[out.length - 1].text = out[out.length - 1].text.trimEnd();
  }
  return out.filter((r) => r.text);
}

/** Plain text of runs (a line break the author set becomes a newline). */
export const runsText = (runs: Run[]) => runs.map((r) => (r.br ? "\n" : "") + (r.pic ? "" : r.text)).join("");

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
    out.push({ ...it, str: it.str.slice(a, b), x: it.x + a * cw, w: (b - a) * cw, gaps: it.gaps?.filter((g) => g.at >= a && g.at < b).map((g) => ({ ...g, at: g.at - a })) });
  }
  return out;
}

/* ------------------------------------------------------------- page furniture */

const normalize = (s: string) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

/** Lines that repeat at the top or bottom of many pages (running heads, page numbers). */
function furniture(pages: { lines: Line[]; height: number }[]): Set<string> {
  const counts = new Map<string, number>();
  // A table's header repeated at the top of each page it runs onto is the table's, not the page's:
  // the lines right under it have their pieces in its columns.
  const heads = (ls: Line[], i: number) => {
    const sg = segments(ls[i]);
    const next = ls.slice(i + 1, i + 5);
    if (sg.length < 3 || next.length < 2 || next[0].y - (ls[i].y + ls[i].h) > ls[i].h * 2) return false;
    return (
      next.filter((n) => {
        const ns = segments(n);
        return ns.length >= 2 && sg.filter((g) => ns.some((x) => Math.min(g.x2, x.x2) - Math.max(g.x, x.x) > 0)).length >= 2;
      }).length >= 2
    );
  };
  for (const p of pages) {
    const edge = p.lines.filter((l, i) => (l.y < p.height * 0.1 || l.y + l.h > p.height * 0.9) && !(l.y < p.height * 0.1 && heads(p.lines, i)));
    for (const key of new Set(edge.map((l) => normalize(l.text)))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // On every page of a two-page document, or on at least half the pages (three or more) of a longer one.
  const min = pages.length === 2 ? 2 : Math.max(3, Math.ceil(pages.length * 0.5));
  const out = new Set<string>();
  for (const [k, n] of counts) if (n >= min || /^(page )?#( (of|\/) #)?$/.test(k) || /^- # -$/.test(k)) out.add(k);
  return out;
}

/* ------------------------------------------------------------- shapes */

type Graphics = { hrules: Rule[]; vrules: Rule[]; boxes: Box[]; marks: Mark[]; pics: Pic[] };

/** Sort a page's shapes into rules, boxes and small marks (check boxes, drawn bullets). */
function graphicsOf(shapes: Shape[], pw: number, ph: number, pics: Pic[] = []): Graphics {
  const g: Graphics = { hrules: [], vrules: [], boxes: [], marks: [], pics };
  for (const s of shapes) {
    const color = s.fill ?? s.stroke;
    if (s.h <= 3.2 && s.w >= 10) g.hrules.push({ x: s.x, y: s.y, w: s.w, h: s.h, color });
    else if (s.w <= 3.2 && s.h >= 8) g.vrules.push({ x: s.x, y: s.y, w: s.w, h: s.h, color });
    else if (s.w >= 2.5 && s.h >= 2.5 && s.w <= 16 && s.h <= 16 && Math.abs(s.w - s.h) <= 0.3 * Math.max(s.w, s.h)) {
      if (!(s.fill && isWhite(s.fill) && !s.stroke)) {
        const hollow = !s.fill || isWhite(s.fill);
        // Rings and dots are bullets; an empty square big enough to tick is a check box.
        g.marks.push({ x: s.x, y: s.y, w: s.w, h: s.h, check: hollow && !s.round && s.w >= 5, bullet: s.round ? (hollow ? "◦" : "•") : hollow ? "▫" : "▪", color: hollow ? (s.stroke ?? s.fill) : s.fill });
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
/** `x1`: how far right its text may run, where that's more than its longest line (a block beside another). */
/** `pic`: the region is a picture (its box is where the picture shows), placed among the text like a box. */
type Region = { box?: Box; items: Item[]; kids: Region[]; hrules: Rule[]; vrules: Rule[]; marks: Mark[]; fills: Box[]; outlines: Box[]; x1?: number; pic?: Pic };

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

/**
 * The page's pictures, sorted by how they sit among the text. A backdrop under most of the
 * page's text (a scanned page under its text, a page background) is left out. A small picture
 * in a line of text (an icon before a phone number, a picture used as a bullet), and a picture
 * in a column of pictures each with text beside it (thumbnails in the rows of a table), stand in
 * the text as one character each, so they stay in their line or cell. The rest are figures,
 * placed among the text like boxes.
 */
function figures(pics: Pic[], items: Item[], page: { width: number; height: number }): { kids: Pic[]; inline: Item[] } {
  const text = items.filter((it) => it.str.trim());
  const kids: Pic[] = [];
  const inline: Item[] = [];
  const mid = (o: Rect) => o.y + o.h / 2;
  for (const p of pics) {
    if (p.w < 6 || p.h < 6) continue;
    const over = text.filter((it) => centerIn(p, ...itemCenter(it), -1)).reduce((k, it) => k + chars(it.str), 0);
    if (over >= 40 && p.w * p.h > page.width * page.height * 0.7) continue;
    const icon = text.find(
      (it) =>
        p.h <= it.fontSize * 2.4 &&
        p.w <= it.fontSize * 4 &&
        Math.min(p.y + p.h, it.y + it.h) - Math.max(p.y, it.y) > Math.min(p.h, it.h) * 0.5 &&
        Math.min(Math.abs(it.x - (p.x + p.w)), Math.abs(p.x - (it.x + it.w))) < it.fontSize * 2.5,
    );
    const beside = text.filter((it) => mid(it) > p.y && mid(it) < p.y + p.h && (it.x >= p.x + p.w - 1 || it.x + it.w <= p.x + 1));
    // A thumbnail in a table's row has a line or two beside it; a photo beside a paragraph (a bio) has more, and stays a figure.
    const short = new Set(beside.map((it) => Math.round(it.base))).size <= 2;
    const stacked = short && pics.some((o) => o !== p && Math.abs(o.x - p.x) < 3 && Math.abs(o.w - p.w) < Math.max(4, p.w * 0.25) && (o.y >= p.y + p.h - 1 || o.y + o.h <= p.y + 1));
    const host = icon ?? (stacked && beside.length ? beside.reduce((a, b) => (Math.abs(mid(b) - mid(p)) < Math.abs(mid(a) - mid(p)) ? b : a)) : undefined);
    if (!host) {
      kids.push(p);
      continue;
    }
    // In the host's line (on its baseline, in its size), with the picture's own box.
    inline.push({ ...host, str: "\uFFFC", x: p.x, w: p.w, y: p.y, h: p.h, ox: p.x, bbox: { x: p.x, y: p.y, w: p.w, h: p.h }, bold: false, italic: false, color: undefined, track: undefined, sup: undefined, bg: undefined, bgRight: undefined, hasEOL: false, pic: p });
  }
  return { kids, inline };
}

function regionsOf(text: Item[], g: Graphics, page: { width: number; height: number }): Region {
  const fig = figures(g.pics, text, page);
  const items = fig.inline.length ? [...text, ...fig.inline] : text;
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
      // A badge: a short label on its own background, the box close around it (not a bar across a table).
      const textW = Math.max(...inner.map((i) => i.x + i.w)) - Math.min(...inner.map((i) => i.x));
      if (n <= 32 && b.fill && b.w <= textW + Math.max(24, size * 4)) {
        for (const it of inner) {
          it.bg = b.fill;
          it.bgRight = b.x + b.w;
        }
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
  // Pictures sit among the text like boxes, in the box they are drawn in. Text drawn over one
  // stays with the text around it, and keeps its colour (the picture goes behind it).
  for (const p of fig.kids) {
    const reg = newRegion({ x: p.x, y: p.y, w: p.w, h: p.h });
    reg.pic = p;
    home(reg.box!).kids.push(reg);
    for (const it of items) if (!it.pic && centerIn(p, ...itemCenter(it), -1)) it.onPic = true;
  }
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
  /** Baseline-to-baseline spacing of the running text, when known. */
  leading?: number;
  hrules: Rule[];
  /** Rules already drawn by a table, list or heading. */
  used: Set<Rule>;
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

export function analyzeDoc(pagesText: PageText[]): { blocks: SBlock[]; body: BodyStyle; layout: PageLayout; furniture: Furniture; unread: Set<number> } {
  const pages = pagesText.map((p) => {
    const all = toLines(p);
    const dir = all[0]?.dir ?? 0;
    return { pt: p, dir, lines: all.filter((l) => l.dir === dir), height: p.height, width: p.width };
  });
  // Running heads repeat on many pages; a page number counts even on one.
  const skip = furniture(pages);
  const kept = pages.map((p) => {
    const gone = new Set<TextItem>();
    for (const l of p.lines) if (skip.has(normalize(l.text)) && (l.y < p.height * 0.1 || l.y + l.h > p.height * 0.9)) for (const it of l.items) gone.add(it);
    return p.pt.items.filter((it) => it.dir === p.dir && !gone.has(it)).map((it) => ({ ...it }) as Item);
  });
  const body = bodyStyle(kept, pages);

  const graphics: Graphics[] = [];
  let carry: number[] | undefined;
  const running = runningPics(pages);
  const perPage = pages.map((p, pi) => {
    const pics = (p.pt.pics ?? []).filter((x) => !running.has(x));
    const g = p.dir === 0 ? graphicsOf(p.pt.shapes ?? [], p.width, p.height, pics) : { hrules: [], vrules: [], boxes: [], marks: [], pics: [] };
    graphics.push(g);
    const blocks = layoutRegion(regionsOf(kept[pi], g, p), { page: pi, pt: p.pt, body: body.size, leading: body.leading, columns: carry });
    const last = blocks[blocks.length - 1];
    carry = last?.kind === "columns" ? last.starts : undefined;
    return blocks;
  });
  const layout = layoutOf(pagesText, kept, graphics);
  // Where each page's content ends, to tell a page that simply filled up from one ended on purpose.
  const bottoms = kept.map((items, i) => {
    const g = graphics[i];
    const ys = [...items.filter((it) => it.str.trim()).map((it) => it.y + it.h), ...[...g.boxes, ...g.hrules, ...g.vrules, ...g.pics].map((r) => r.y + r.h)];
    return ys.length ? Math.max(...ys) : 0;
  });
  const out: SBlock[] = [];
  perPage.forEach((blocks, pi) => {
    if (pi > 0) out.push({ kind: "pagebreak", page: pi, deliberate: deliberateBreak(perPage[pi - 1], blocks, layout.height - layout.bottom - bottoms[pi - 1], body, graphics[pi].boxes) });
    out.push(...blocks);
  });
  joinAcrossPages(out, layout);
  rankHeadings(out);
  const furn = furnitureLines(pages, skip);
  // Each running picture once, from the first page that has it.
  const pics = new Map<string, { pic: Pic; at: "header" | "footer" }>();
  for (const p of pages) for (const pic of p.pt.pics ?? []) if (running.has(pic) && !pics.has(pic.id)) pics.set(pic.id, { pic, at: pic.y + pic.h / 2 < p.height / 2 ? "header" : "footer" });
  // Pages read in another direction (text running up or down the page) don't place their pictures.
  const unread = new Set(pages.flatMap((p, pi) => (p.dir === 0 ? [] : [pi])));
  return { blocks: out, body, layout, furniture: pics.size ? { ...furn, pics: [...pics.values()] } : furn, unread };
}

/**
 * Pictures that repeat in the same place at the top or foot of the pages (a logo in the
 * letterhead, a band along the bottom): the running header and footer, not content.
 */
function runningPics(pages: { pt: PageText; height: number }[]): Set<Pic> {
  const out = new Set<Pic>();
  if (pages.length < 2) return out;
  const all = pages.flatMap((p, pi) => (p.pt.pics ?? []).map((pic) => ({ pic, pi, h: p.height })));
  for (const a of all) {
    if (out.has(a.pic) || !(a.pic.y + a.pic.h < a.h * 0.2 || a.pic.y > a.h * 0.8)) continue;
    const same = all.filter((b) => b.pic.id === a.pic.id && Math.abs(b.pic.x - a.pic.x) < 3 && Math.abs(b.pic.y - a.pic.y) < 3 && Math.abs(b.pic.w - a.pic.w) < 3);
    const n = new Set(same.map((b) => b.pi)).size;
    if (n >= 2 && n >= pages.length * 0.3) for (const b of same) out.add(b.pic);
  }
  return out;
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
      (top ? out.header : out.footer).push({ parts, size: half(l.size), color: it?.color, face: it?.face, family: it?.family, bold: l.bold, italic: l.italic, edge: top ? l.y : p.height - (l.y + l.h) });
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
  let need = first.kind === "box" || first.kind === "image" ? height : first.kind === "table" ? Math.min(height, lead * 4) : first.kind === "heading" || (first.kind === "para" && first.keep) ? height + lead * 3 : Math.min(height, lead * 3);
  const frame = boxes.find((b) => b.y <= g.top + 1 && b.y + b.h >= g.top && b.h < 700);
  if (frame) need = Math.max(need, frame.h);
  return free > need + lead;
}

/** Append blocks that continue a run of blocks, joining a paragraph the break cut mid-sentence. */
function joinBlocks(into: SBlock[], more: SBlock[]) {
  const x = into[into.length - 1];
  const y = more[0];
  const gx = x && "geo" in x ? x.geo : undefined;
  const gy = y && "geo" in y ? y.geo : undefined;
  if (x?.kind === "para" && y?.kind === "para" && !/[.!?:;]["”’)]?$/.test(runsText(x.runs).trimEnd()) && /^[a-z(“"‘'0-9]/.test(runsText(y.runs))) {
    joinRuns(x.runs, y.runs);
    x.runs = mergeRuns(x.runs);
    if (gx && gy) [gx.gap, gx.next] = [gy.gap, gy.next];
    into.push(...more.slice(1));
    return;
  }
  // The space the break took (down to the foot of the page): as between the blocks before it.
  if (gx) {
    const gaps = into.slice(0, -1).flatMap((b) => ("geo" in b && b.geo?.gap !== undefined ? [b.geo.gap] : []));
    gx.gap = gaps.length ? median(gaps) : undefined;
    gx.next = gy?.first;
  }
  into.push(...more);
}

/** Merge what a natural page break cut in two: a paragraph, a list, or a table that runs on (dropping a repeated header row). */
function joinAcrossPages(blocks: SBlock[], layout: PageLayout) {
  // A box the break cut runs to the foot of one page and from the head of the next; two boxes
  // that merely end one page and start the next are two boxes.
  const cut = (a: SBlock, b: SBlock) => {
    const ga = "geo" in a ? a.geo : undefined;
    const gb = "geo" in b ? b.geo : undefined;
    return !!ga && !!gb && ga.bottom >= layout.height - layout.bottom - 14 && gb.top <= layout.top + 14;
  };
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
    } else if (a.kind === "box" && b.kind === "box" && cut(a, b) && a.fill === b.fill && a.stroke === b.stroke && Math.abs((a.geo?.left ?? 0) - (b.geo?.left ?? 0)) < 3 && Math.abs((a.geo?.right ?? 0) - (b.geo?.right ?? 0)) < 3) {
      // A box the page break cut in two.
      joinBlocks(a.blocks, b.blocks);
      a.broken = true;
      joined = true;
    } else if (a.kind === "table" && a.cardCols && b.kind === "box" && b.geo?.left !== undefined && cut(a, b)) {
      // The rest of one card of a row cut by the page break.
      const k = a.cardCols.findIndex((c) => Math.abs(c.x - b.geo!.left!) < 3 && Math.abs(c.x + c.w - b.geo!.right!) < 3);
      const cell = k >= 0 ? a.cells[a.cells.length - 1][k] : undefined;
      if (cell?.blocks) {
        joinBlocks(cell.blocks, b.blocks);
        cell.paras = cell.blocks.flatMap(blockParas);
        cell.text = cell.paras.map(runsText).join("\n");
        a.rows[a.rows.length - 1][k] = cell.text;
        a.broken = true;
        joined = true;
      }
    } else if (a.kind === "columns" && b.kind === "columns" && a.count === b.count) {
      // Columns that run on to the next page: one run of text (a paragraph cut by the page joins up).
      joinBlocks(a.blocks, b.blocks);
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
    const rects: (Rect & { lift?: number })[] = [
      // Word sets a line's text a little below the top of its line (0.08 of the size).
      ...kept[i].filter((it) => it.str.trim() && it.dir === 0).map((it) => ({ x: it.x, y: it.y, w: it.w, h: it.h, lift: it.fontSize * 0.08 })),
      ...[...g.boxes, ...g.hrules, ...g.vrules].filter((r) => r.w < width * 0.95),
    ];
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y - (r.lift ?? 0));
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
  });
  const m = (v: number) => Math.min(108, Math.max(18, Number.isFinite(v) ? v : 72));
  // A little room below the lowest text, so a page that ends with its last line right at the
  // margin still holds that line when Word sets the text a point or two lower.
  return { width, height, left: m(x0), top: m(y0), right: m(width - x1), bottom: m(height - y1 - 6) };
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
  // Lines inside paragraphs sit closest: the tighter half of the steps (items of a list, set apart a little, are looser).
  const inPara = steps.filter((s) => s >= size * 0.95 && s <= size * 2.2).sort((a, b) => a - b);
  const leading = inPara.length >= 3 ? median(inPara.slice(0, Math.ceil(inPara.length / 2))) : undefined;
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
type Base = { page: number; pt: Ctx["pt"]; body: number; leading?: number; columns?: number[] };

/**
 * Blocks of a region. A tall box down one side (a CV's sidebar) with the rest of the content
 * beside it becomes a table of one row: the box's content in one cell, in its colour, and
 * what sits beside it in the other, each laid out on its own.
 */
function layoutRegion(r: Region, base: Base): SBlock[] {
  if (r.pic) return [picsBlock([r], base)];
  const sb = sidebarOf(r, base);
  const sp = sb ? null : (picSide(r, base) ?? sideBySide(r, base));
  if (!sb && !sp) return layoutPlain(r, base);
  const [y0, y1] = sb ? [sb.y0, sb.y1] : [sp!.y0, sp!.y1];
  const mid = (o: Rect) => o.y + o.h / 2;
  const inSpan = (o: Rect) => mid(o) >= y0 && mid(o) <= y1;
  const part = (keep: (o: Rect) => boolean, box?: Box): Region => ({
    box,
    items: r.items.filter(keep),
    kids: r.kids.filter((k) => k !== sb?.kid && keep(k.box!)),
    hrules: r.hrules.filter(keep),
    vrules: r.vrules.filter(keep),
    marks: r.marks.filter(keep),
    fills: r.fills.filter(keep),
    outlines: r.outlines.filter(keep),
  });
  const text = (bs: SBlock[]) => bs.flatMap(blockParas).map(runsText).join("\n");
  // The last block in a cell ends where its side does: the row is as tall as the taller side.
  const ending = (bs: SBlock[], to?: number) => {
    const last = [...bs].reverse().find((b) => "geo" in b && b.geo);
    const g = last && "geo" in last ? last.geo : undefined;
    if (g && g.gap === undefined) [g.gap, g.next] = [to !== undefined ? Math.min(72, Math.max(0, to - g.bottom)) : 0, undefined];
    return bs;
  };
  // Content set in the middle of the row (a logo beside the letterhead's text) or at its foot.
  const valignOf = (bs: SBlock[]): Cell["valign"] => {
    const gs = bs.flatMap((b) => ("geo" in b && b.geo ? [b.geo] : []));
    if (!gs.length) return undefined;
    const a = Math.min(...gs.map((g) => g.top)) - y0;
    const z = y1 - Math.max(...gs.map((g) => g.bottom));
    return a > 3 && Math.abs(a - z) < Math.max(2.5, (y1 - y0) * 0.12) ? "center" : a > 3 && z < 1.5 ? "bottom" : undefined;
  };
  const cellOfBlocks = (bs: SBlock[], extra: Partial<Cell>, to?: number): Cell => {
    const valign = to !== undefined ? valignOf(bs) : undefined;
    return { paras: bs.flatMap(blockParas), text: text(ending(bs, valign ? undefined : to)), blocks: bs, ...extra, ...(valign ? { valign } : {}) };
  };
  // How far a part's text, and any picture in it, reaches across.
  const extent = (reg: Region) => {
    const rs: Rect[] = [...reg.items.filter((it) => it.str.trim()), ...reg.kids.filter((k) => k.pic).map((k) => k.box!)];
    return rs.length ? { x0: Math.min(...rs.map((o) => o.x)), x1: Math.max(...rs.map((o) => o.x + o.w)) } : null;
  };
  let cells: Cell[];
  let ws: number[];
  let layout: { x: number; w: number; h?: number };
  if (sb) {
    const box = sb.kid.box!;
    const main = part(inSpan);
    const sideBlocks = layoutRegion(sb.kid, base);
    const mainBlocks = layoutRegion(main, base);
    const e = extent(main) ?? { x0: box.x + box.w, x1: box.x + box.w };
    const pad = insets(sb.kid) ?? { x: 8, y: 8 };
    const sideCell = cellOfBlocks(sideBlocks, { ...(box.fill ? { fill: box.fill } : {}), margins: { left: pad.x, right: pad.x, top: pad.y, bottom: pad.y } });
    // The main text keeps its distance from the box.
    const gapX = Math.max(0, sb.left ? e.x0 - (box.x + box.w) : box.x - e.x1);
    const mainCell = cellOfBlocks(mainBlocks, { margins: { left: sb.left ? gapX : 0, right: sb.left ? 0 : gapX, top: 0, bottom: 0 } });
    cells = sb.left ? [sideCell, mainCell] : [mainCell, sideCell];
    ws = sb.left ? [box.w, e.x1 - (box.x + box.w)] : [box.x - e.x0, box.w];
    layout = { x: sb.left ? box.x : e.x0, w: ws[0] + ws[1], h: box.h };
  } else {
    // Blocks side by side (a letterhead beside the invoice details): each laid out on its own,
    // the second cell starting where its text does.
    const left = part((o) => inSpan(o) && o.x + o.w / 2 < sp!.gx);
    const right = part((o) => inSpan(o) && o.x + o.w / 2 >= sp!.gx);
    const el = extent(left)!;
    const er = extent(right)!;
    // Text on the left could run on towards the right-hand block.
    left.x1 = er.x0 - 12;
    const none = { left: 0, right: 0, top: 0, bottom: 0 };
    cells = [cellOfBlocks(layoutRegion(left, base), { margins: none }, y1), cellOfBlocks(layoutRegion(right, base), { margins: none }, y1)];
    // The right-hand side may run on to where the region's text ends (its lines wrap no sooner in Word).
    const words = r.items.filter((it) => it.str.trim());
    const rx = Math.max(er.x1, r.box ? r.box.x + r.box.w - (insets(r)?.x ?? 0) : Math.max(er.x1, ...words.map((it) => it.x + it.w)));
    ws = [er.x0 - el.x0, rx - er.x0];
    layout = { x: el.x0, w: ws[0] + ws[1] };
  }
  const total = ws[0] + ws[1];
  // Where text is the first thing in it, the table starts with that text's line.
  const spanItems = r.items.filter((it) => it.str.trim() && inSpan(it));
  const topText = spanItems.length ? spanItems.reduce((a, b) => (b.y < a.y ? b : a)) : undefined;
  const topKid = Math.min(Infinity, ...r.kids.filter((k) => inSpan(k.box!)).map((k) => k.box!.y));
  const table: SBlock = {
    kind: "table",
    rows: [cells.map((c) => c.text)],
    cells: [cells],
    header: false,
    widths: ws.map((w) => w / total),
    layout,
    page: base.page,
    geo: { top: y0, bottom: y1, first: topText && topText.y <= topKid + 1 ? half(topText.fontSize) : 0, last: 0 },
  };
  const out = layoutRegion(part((o) => !inSpan(o), r.box), base);
  const at = out.findIndex((b) => "geo" in b && !!b.geo && b.geo.top >= y1 - 1);
  out.splice(at < 0 ? out.length : at, 0, table);
  setGaps(out, r.box);
  return out;
}

/**
 * Two blocks of text side by side that don't line up as a table: a stretch of four or more
 * lines with a clear gap down the middle (nothing drawn across it), text on both sides, and
 * lines on the two sides that mostly don't share baselines (a letterhead beside invoice
 * details). Rows of a table, even with wrapped cells, keep one side aligned with the other.
 */
function sideBySide(r: Region, base: Base): { y0: number; y1: number; gx: number } | null {
  const lines = linesOf(r.items, base.pt);
  if (lines.length < 4) return null;
  const x0 = Math.min(...lines.map((l) => l.x));
  const x1 = Math.max(...lines.map((l) => l.x + l.w));
  const width = x1 - x0;
  if (width < 200) return null;
  const lo = x0 + width * 0.15;
  const hi = x1 - width * 0.15;
  type Gap = { a: number; b: number };
  const freeOf = (l: SLine): Gap[] => {
    const out: Gap[] = [];
    let at = lo;
    for (const sg of segments(l)) {
      if (sg.x > at) out.push({ a: at, b: Math.min(sg.x, hi) });
      at = Math.max(at, sg.x2);
    }
    if (at < hi) out.push({ a: at, b: hi });
    return out.filter((g) => g.b - g.a >= 16);
  };
  const cross = (g: Gap, top: number, bottom: number) =>
    [...r.fills, ...r.outlines, ...r.hrules, ...r.kids.map((k) => k.box!)].some((o) => o.y < bottom && o.y + o.h > top && o.x < g.a && o.x + o.w > g.b);
  for (let i = 0; i < lines.length; i++) {
    let common = freeOf(lines[i]).filter((g) => !cross(g, lines[i].y, lines[i].y + lines[i].h));
    let j = i;
    while (common.length && j + 1 < lines.length) {
      const l = lines[j + 1];
      const next = common
        .flatMap((g) => freeOf(l).map((f) => ({ a: Math.max(g.a, f.a), b: Math.min(g.b, f.b) })))
        .filter((g) => g.b - g.a >= 16 && !cross(g, lines[j].y, l.y + l.h));
      if (!next.length) break;
      common = next;
      j++;
    }
    if (!common.length || j - i + 1 < 4) continue;
    const g = common.reduce((a, b) => (b.b - b.a > a.b - a.a ? b : a));
    const gx = (g.a + g.b) / 2;
    const leftOf = (l: SLine) => l.items.some((it) => it.str.trim() && it.x + it.w / 2 < gx);
    const rightOf = (l: SLine) => l.items.some((it) => it.str.trim() && it.x + it.w / 2 >= gx);
    // The blocks start where the later of the two does; short lines above it are ordinary text.
    const from = Math.max(lines.slice(i, j + 1).findIndex(leftOf), lines.slice(i, j + 1).findIndex(rightOf));
    const run = lines.slice(i + Math.max(0, from), j + 1);
    if (run.length < 4) continue;
    // Running text in two columns is read down one column then the next (see columnZones).
    const sides = [0, 1].map((n) => linesFromItems(run.flatMap((l) => l.items.filter((it) => it.str.trim() && (it.x + it.w / 2 < gx) === (n === 0))), base.pt));
    if (proseSides(sides, base.body)) continue;
    const ls = run.filter(leftOf);
    const rs = run.filter(rightOf);
    const nl = ls.length;
    const nr = rs.length;
    const paired = run.filter((l) => leftOf(l) && rightOf(l)).length;
    if (nl < 2 || nr < 2) continue;
    // Side by side, not one above the other (an address set to the right above a date at the left).
    const span = (xs: SLine[]) => [Math.min(...xs.map((l) => l.y)), Math.max(...xs.map((l) => l.y + l.h))];
    const [la, lb] = span(ls);
    const [ra, rb] = span(rs);
    if (Math.min(lb, rb) - Math.max(la, ra) < Math.min(lb - la, rb - ra) * 0.5) continue;
    const pl = paired / nl;
    const pr = paired / nr;
    if (Math.max(pl, pr) <= 0.8 && Math.min(pl, pr) < 0.65) return { y0: Math.min(...run.map((l) => l.y)), y1: Math.max(...run.map((l) => l.y + l.h)), gx };
    i = j;
  }
  return null;
}

/**
 * A box that runs down one side of the region (at least 40% of its height, under half its
 * width) with text beside it and nothing else in its way: a sidebar.
 */
function sidebarOf(r: Region, base: Base): { kid: Region; left: boolean; y0: number; y1: number } | null {
  const height = r.box?.h ?? base.pt.height;
  const width = r.box?.w ?? base.pt.width;
  for (const kid of r.kids) {
    const b = kid.box!;
    if (kid.pic || b.h < height * 0.4 || b.w > width * 0.45) continue;
    const beside = r.items.filter((it) => it.str.trim() && it.y + it.h / 2 >= b.y && it.y + it.h / 2 <= b.y + b.h);
    if (toLines({ page: 0, width: 0, height: 0, items: beside }).length < 3) continue;
    const left = beside.every((it) => it.x >= b.x + b.w + 4);
    const right = beside.every((it) => it.x + it.w <= b.x - 4);
    const others = r.kids.filter((k) => k !== kid && k.box!.y + k.box!.h / 2 >= b.y && k.box!.y + k.box!.h / 2 <= b.y + b.h);
    const clear = others.every((k) => (left ? k.box!.x >= b.x + b.w : k.box!.x + k.box!.w <= b.x));
    if ((left || right) && clear) return { kid, left, y0: b.y, y1: b.y + b.h };
  }
  return null;
}

/**
 * A picture with text beside it and nothing on its far side (a logo beside the letterhead, a
 * photo beside a short bio): the two side by side, split down the space between them. Text
 * that only overlaps the picture's top or foot is ordinary text above or below it.
 */
function picSide(r: Region, base: Base): { y0: number; y1: number; gx: number } | null {
  const width = r.box?.w ?? base.pt.width;
  for (const kid of r.kids) {
    if (!kid.pic) continue;
    const b = kid.box!;
    if (b.w > width * 0.7) continue;
    const mid = (o: Rect) => o.y + o.h / 2;
    const band = r.items.filter((it) => it.str.trim() && mid(it) >= b.y - 1 && mid(it) <= b.y + b.h + 1);
    const right = band.filter((it) => it.x >= b.x + b.w - 1);
    const left = band.filter((it) => it.x + it.w <= b.x + 1);
    // Text on one side only, and none drawn over the picture.
    const side = right.length + left.length === band.length ? (right.length && !left.length ? right : left.length && !right.length ? left : null) : null;
    if (!side || side.reduce((k, it) => k + chars(it.str), 0) < 3) continue;
    const onRight = side === right;
    // Anything else in the band (another box or picture) sits with the text.
    const others = r.kids.filter((k) => k !== kid && k.box!.y < b.y + b.h && k.box!.y + k.box!.h > b.y);
    if (!others.every((k) => (onRight ? k.box!.x >= b.x + b.w : k.box!.x + k.box!.w <= b.x))) continue;
    const tx = onRight ? Math.min(...side.map((it) => it.x)) : Math.max(...side.map((it) => it.x + it.w));
    return { y0: Math.min(b.y, ...side.map((it) => it.y)), y1: Math.max(b.y + b.h, ...side.map((it) => it.y + it.h)), gx: onRight ? (b.x + b.w + tx) / 2 : (tx + b.x) / 2 };
  }
  return null;
}

/**
 * The gap below each block: to the next one, or for the last block in a box, to the box's edge.
 * Space the page leaves empty (nothing else sits level with it) is kept whatever its size
 * (room left for an answer, a title set halfway down the page); where something else does sit
 * level with it, the next block isn't simply the one below, so the gap is kept modest.
 */
function setGaps(out: SBlock[], box?: Box) {
  const placed = out.filter((b): b is Extract<SBlock, { geo?: Geo }> & { geo: Geo } => "geo" in b && !!b.geo);
  placed.forEach((b, k) => {
    const nx = placed[k + 1]?.geo;
    if (nx) {
      const gap = Math.max(0, nx.top - b.geo.bottom);
      const empty = !placed.some((o, j) => j !== k && j !== k + 1 && o.geo.top < nx.top - 1 && o.geo.bottom > b.geo.bottom + 1);
      b.geo.gap = empty ? gap : Math.min(gap, 72);
      b.geo.next = nx.first;
      // Text set over a picture: the gap runs from the picture's top to that text.
      if (b.kind === "image" && nx.top < b.geo.bottom - 2) [b.geo.under, b.geo.gap] = [true, Math.max(0, nx.top - b.geo.top)];
    } else if (box) {
      // To the box's edge: the box itself keeps any room below that.
      b.geo.gap = Math.min(72, Math.max(0, box.y + box.h - b.geo.bottom));
      b.geo.next = undefined;
    }
  });
}

function layoutPlain(r: Region, base: Base): SBlock[] {
  const groups = cardGroups(r.kids);
  // Captions set one under each picture of a row go with their picture (see captionsOf).
  const lines = captionsOf(groups, linesOf(r.items, base.pt));
  const x0 = lines.length ? Math.min(...lines.map((l) => l.x)) : 0;
  // In a box, text can run as far from its right edge as it starts from the left.
  const x1 = lines.length ? Math.max(...lines.map((l) => l.x + l.w), r.box ? r.box.x + r.box.w - Math.min(24, x0 - r.box.x) : -Infinity, r.x1 ?? -Infinity) : 0;
  const ctx: Ctx = { ...base, hrules: r.hrules, used: new Set(), vrules: r.vrules, marks: r.marks, fills: r.fills, outlines: r.outlines, x0, x1 };
  // Runs of ordinary lines, and stretches set in columns, in order down the region.
  type Unit = { y: number; lines: SLine[]; gutter?: number };
  const units: Unit[] = [];
  let at = 0;
  const push = (ls: SLine[], gutter?: number) => {
    if (ls.length) units.push({ y: ls[0].y + ls[0].h / 2, lines: ls, gutter });
  };
  // Ordinary lines are split where a box or row of cards comes between them. Pictures with text
  // beside them (in a row of a table, beside a list) don't split it: they follow that text.
  const kidsOf = (g: Group) => g.rows.flat();
  const beside = (g: Group) =>
    kidsOf(g).every((k) => k.pic) &&
    lines.some((l) =>
      kidsOf(g).some((k) => {
        const b = k.box!;
        return Math.min(l.y + l.h, b.y + b.h) - Math.max(l.y, b.y) > l.h * 0.4 && l.items.some((it) => it.str.trim() && (it.x >= b.x + b.w - 1 || it.x + it.w <= b.x + 1));
      }),
    );
  const cuts = groups.filter((g) => !beside(g));
  const pushPlain = (ls: SLine[]) => {
    let cur: SLine[] = [];
    for (const l of ls) {
      const mid = l.y + l.h / 2;
      if (cur.length && cuts.some((g) => g.y > cur[cur.length - 1].y + cur[cur.length - 1].h / 2 && g.y <= mid)) {
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
  attachRules(out, lines, ctx);
  setGaps(out, r.box);
  return out;
}

/**
 * Rules no table, list or heading drew. One just under a paragraph or heading, across the
 * text, becomes its bottom border; any other (between blocks, under a table, or short) a
 * rule of its own. Underlines under words are left alone.
 */
function attachRules(out: SBlock[], lines: SLine[], ctx: Ctx) {
  const width = ctx.x1 - ctx.x0;
  if (width <= 0) return;
  const free = ctx.hrules.filter((r) => !ctx.used.has(r.src ?? r) && r.w >= 24).sort((a, b) => a.y - b.y);
  for (const r of free) {
    const underline = lines.some((l) => r.y >= l.domBase - 1 && r.y <= l.domBase + l.dom * 0.35 && r.x >= l.x - 3 && r.x + r.w <= l.x + l.w + 3);
    if (underline) continue;
    const placed = out.flatMap((b, k) => ("geo" in b && b.geo ? [{ b, k, g: b.geo }] : []));
    // Inside a block (a line in a table or box): not ours.
    if (placed.some(({ g }) => r.y > g.top + 1 && r.y + r.h < g.bottom - 1)) continue;
    const above = [...placed].reverse().find(({ g }) => g.bottom <= r.y + 1);
    const below = placed.find(({ g }) => g.top >= r.y + r.h - 1);
    const gapAbove = above ? r.y - above.g.bottom : Infinity;
    const gapBelow = below ? below.g.top - (r.y + r.h) : Infinity;
    const ab = above?.b;
    if (ab && (ab.kind === "para" || ab.kind === "heading") && !ab.under && r.w >= width * 0.8 && gapAbove <= gapBelow + 2 && gapAbove < 30) {
      ab.under = { color: r.color ?? "#000000", h: r.h, at: Math.max(0, gapAbove) };
      continue;
    }
    const at = below ? below.k : out.length;
    out.splice(at, 0, { kind: "rule", color: r.color ?? "#000000", h: r.h, inset: { left: Math.max(0, r.x - ctx.x0), right: Math.max(0, ctx.x1 - (r.x + r.w)) }, page: ctx.page, geo: { top: r.y, bottom: r.y + r.h, first: 0, last: 0 } });
  }
}

/** Boxes or pictures in rows; `caps`: the caption under each picture of a single row. */
type Group = { y: number; rows: Region[][]; caps?: Map<Region, Item[]> };

/**
 * Lines set under a row of pictures with each piece of text under one picture (captions under
 * photos side by side): taken out of the running text and given to their pictures. Returns the
 * lines left.
 */
function captionsOf(groups: Group[], lines: SLine[]): SLine[] {
  const taken = new Set<SLine>();
  for (const g of groups) {
    const row = g.rows[0];
    if (g.rows.length !== 1 || row.length < 2 || !row.every((k) => k.pic)) continue;
    const caps = new Map<Region, Item[]>();
    let last = Math.max(...row.map((k) => k.box!.y + k.box!.h));
    for (const l of [...lines].sort((a, b) => a.y - b.y)) {
      if (taken.has(l) || l.y < last - 1) continue;
      if (l.y - last > Math.max(l.h, 6) * 1.2) break;
      const segs = segments(l);
      const owners = segs.map((sg) => row.find((k) => sg.x >= k.box!.x - 4 && sg.x2 <= k.box!.x + k.box!.w + 4));
      if (owners.some((o) => !o)) break;
      segs.forEach((sg, i) => caps.set(owners[i]!, [...(caps.get(owners[i]!) ?? []), ...sg.items]));
      taken.add(l);
      last = l.y + l.h;
    }
    if (caps.size) g.caps = caps;
  }
  return taken.size ? lines.filter((l) => !taken.has(l)) : lines;
}

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
  // Its text, and any picture in it.
  const its: Rect[] = [...r.items.filter((it) => it.str.trim()), ...r.kids.filter((k) => k.pic).map((k) => k.box!)];
  if (!its.length || !r.box) return undefined;
  const lim = (v: number) => Math.min(24, Math.max(2, v));
  return { x: lim(Math.min(...its.map((i) => i.x)) - r.box.x), y: lim(Math.min(...its.map((i) => i.y)) - r.box.y) };
}

/** Pictures side by side, each with its caption under it: a row of cards without lines. */
function captionedRow(row: Region[], caps: Map<Region, Item[]>, base: { page: number; pt: Ctx["pt"]; body: number }): SBlock {
  const cells = row.map((k): Cell => {
    const b = k.box!;
    const its = caps.get(k) ?? [];
    const ctx: Ctx = { page: base.page, pt: base.pt, body: base.body, hrules: [], used: new Set(), vrules: [], marks: [], fills: [], outlines: [], x0: b.x, x1: b.x + b.w };
    const blocks: SBlock[] = [picsBlock([k], base), ...(its.length ? blocksOf(linesFromItems(its, base.pt), ctx) : [])];
    setGaps(blocks);
    const last = blocks[blocks.length - 1];
    if ("geo" in last && last.geo && last.geo.gap === undefined) last.geo.gap = 0;
    const paras = blocks.flatMap(blockParas);
    return { paras, text: paras.map(runsText).join("\n"), blocks };
  });
  const xs = row.map((k) => k.box!);
  const raw = xs.map((b, i) => (i + 1 < xs.length ? xs[i + 1].x - b.x : b.w));
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const bottom = Math.max(...row.map((k) => Math.max(k.box!.y + k.box!.h, ...(caps.get(k) ?? []).map((it) => it.y + it.h))));
  return {
    kind: "table",
    rows: [cells.map((c) => c.text)],
    cells: [cells],
    header: false,
    widths: raw.map((w) => w / total),
    lines: "cards",
    pad: { x: 0, y: 0 },
    page: base.page,
    geo: { top: Math.min(...xs.map((b) => b.y)), bottom, first: 0, last: 0 },
    cardCols: xs.map((b) => ({ x: b.x, w: b.w })),
  };
}

/** Pictures in a row, as one block. */
function picsBlock(kids: Region[], base: { page: number }): SBlock {
  const pics = kids.map((k) => k.pic!).sort((a, b) => a.x - b.x);
  return { kind: "image", pics, page: base.page, geo: { top: Math.min(...pics.map((p) => p.y)), bottom: Math.max(...pics.map((p) => p.y + p.h)), first: 0, last: 0 } };
}

function groupBlocks(g: Group, base: { page: number; pt: Ctx["pt"]; body: number }): SBlock[] {
  if (g.caps) return [captionedRow(g.rows[0], g.caps, base)];
  // Pictures only (one, a row, or a grid of them): a row of pictures at a time.
  if (g.rows.every((rw) => rw.every((k) => k.pic))) return g.rows.map((rw) => picsBlock(rw, base));
  if (g.rows.length === 1 && g.rows[0].length === 1) {
    const kid = g.rows[0][0];
    const inner = layoutRegion(kid, base);
    const box = kid.box!;
    // A border around (nearly) the whole page, or the outline of the one ruled table inside, adds nothing: keep the content.
    const pageFrame = box.h > base.pt.height * 0.75 && box.w > base.pt.width * 0.6;
    const tableEdge = inner.length === 1 && inner[0].kind === "table" && inner[0].lines === "grid";
    if (pageFrame || tableEdge) return inner;
    return inner.length ? [{ kind: "box", blocks: inner, fill: box.fill, stroke: box.stroke, pad: insets(kid), page: base.page, geo: { top: box.y, bottom: box.y + box.h, first: 0, last: 0, left: box.x, right: box.x + box.w } }] : [];
  }
  const cols = Math.max(...g.rows.map((r) => r.length));
  const cells = g.rows.map((rw) =>
    Array.from({ length: cols }, (_, c) => {
      const kid = rw[c];
      if (!kid) return { paras: [], text: "" } as Cell;
      // Titles inside a card stay styled text: they aren't headings of the document.
      const blocks = layoutRegion(kid, base).map((b): SBlock => (b.kind === "heading" ? { kind: "para", runs: b.runs, page: b.page, ...(b.align ? { align: b.align } : {}), geo: b.geo } : b));
      const paras = blocks.flatMap(blockParas);
      return { paras, text: paras.map(runsText).join("\n"), blocks, fill: kid.box!.fill, stroke: kid.box!.stroke } as Cell;
    }),
  );
  const first = g.rows.find((r) => r.length === cols) ?? g.rows[0];
  const raw = first.map((k, i) => (i + 1 < first.length ? first[i + 1].box!.x - k.box!.x : k.box!.w));
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  const boxes = g.rows.flat().map((k) => k.box!);
  const geo: Geo = { top: Math.min(...boxes.map((b) => b.y)), bottom: Math.max(...boxes.map((b) => b.y + b.h)), first: 0, last: 0 };
  const rowSpan = g.rows.map((rw) => ({ top: Math.min(...rw.map((k) => k.box!.y)), bottom: Math.max(...rw.map((k) => k.box!.y + k.box!.h)) }));
  const cardRowGaps = rowSpan.slice(1).map((r, k) => Math.max(0, r.top - rowSpan[k].bottom));
  return [
    {
      kind: "table",
      rows: cells.map((r) => r.map((c) => c.text)),
      cells,
      header: false,
      widths: raw.map((w) => w / total),
      lines: "cards",
      pad: insets(first[0]),
      page: base.page,
      geo,
      cardCols: first.map((k) => ({ x: k.box!.x, w: k.box!.w })),
      ...(cardRowGaps.length ? { cardRowGaps } : {}),
    },
  ];
}

/** A block flattened to paragraphs (for plain table cells). */
function blockParas(b: SBlock): Run[][] {
  if (b.kind === "heading" || b.kind === "para") return [b.runs];
  if (b.kind === "list") return b.items.map((it, i) => (listLabel(b, i) ? [{ ...(it[0] ?? { bold: false, italic: false }), text: listLabel(b, i) + " " }, ...it] : it));
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
  if (f.kind === "none") return "";
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
  const segs = lines.map((l) => splitAtRules(segments(l), ctx.vrules, l));
  let para: { runs: Run[]; first: SLine; last: SLine; lines: SLine[]; bar?: string } | null = null;
  // The lines each paragraph was made from (a table's header set above it may be among them).
  const lineOf = new Map<SBlock, SLine[]>();
  const flush = () => {
    if (para) {
      const runs = mergeRuns(para.runs);
      const align = alignOf(para.lines, ctx);
      // Centred and flush-right text sits by its alignment, not by indents.
      // (Its lines all wrapped where they had to, none broken on purpose: a measure of its own shows.)
      const indent = align.align === "center" || align.align === "right" ? {} : indentOf(para.lines, ctx, !para.runs.some((r) => r.br) && align.align !== "justify");
      if (runs.length) {
        const b: SBlock = { kind: "para", runs, page: ctx.page, ...align, ...indent, ...(para.bar ? { bar: para.bar } : {}), geo: geoOf(para.lines) };
        out.push(b);
        lineOf.set(b, para.lines);
      }
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
      for (const r of li.used) ctx.used.add(r.src ?? r);
      out.push(...li.blocks);
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
      for (const r of t.rules) ctx.used.add(r.src ?? r);
      const rows = lines.slice(i, t.end);
      const py = t.pad?.y ?? 0;
      const geo: Geo = { top: Math.min(...rows.map((l) => l.y)) - py, bottom: Math.max(...rows.map((l) => l.y + l.h)) + py, first: 0, last: 0 };
      const tb: TableBlock = { kind: "table", rows: t.cells.map((r) => r.map((c) => c.text)), cells: t.cells, header: t.header, ...(t.head ? { head: t.head } : {}), widths: t.widths, span: t.span, page: ctx.page, pad: t.pad, inset: t.inset, leading: t.leading, ...(t.rowSpace ? { rowSpace: t.rowSpace } : {}), ...(t.lines ? { lines: t.lines, lineColor: t.lineColor, rowRules: t.rowRules } : {}), geo };
      headsAbove(out, tb, t.bands, lines[i], lineOf, ctx);
      out.push(tb);
      i = t.end;
      continue;
    }
    const tabbed = tabbedRuns(l, segs[i], ctx);
    if (tabbed) {
      flush();
      const left = l.x - ctx.x0;
      const tb: SBlock = { kind: "para", runs: tabbed, page: ctx.page, ...(left > 2 ? { indent: { left, first: 0 } } : {}), geo: geoOf([l]) };
      out.push(tb);
      lineOf.set(tb, [l]);
      i++;
      continue;
    }
    const runs = lineRuns(l);
    const bar = barOf(l, ctx);
    if (para) {
      const gap = l.y - (para.last.y + para.last.h);
      const sameSize = Math.abs(l.dom - para.last.dom) < 0.6;
      // A new paragraph starts indented (beyond the line before) or, where paragraphs are
      // marked by a first-line indent, a little in from lines that sat at the left edge.
      // (Not for lines set flush right or centred, which start wherever their length puts them.)
      const flushRight = Math.abs(l.x + l.w - ctx.x1) < 2 && Math.abs(para.last.x + para.last.w - ctx.x1) < 2 && l.x - ctx.x0 > (ctx.x1 - ctx.x0) * 0.2;
      const centred = Math.abs(l.x + l.w / 2 - (para.last.x + para.last.w / 2)) < 2 && l.x - ctx.x0 > 24;
      const indented = !flushRight && !centred && (l.x - para.last.x > l.size * 1.5 || (para.lines.length >= 2 && Math.abs(para.last.x - ctx.x0) < 1.5 && l.x - para.last.x > l.size * 0.6 && l.x - para.last.x < l.size * 4));
      const sentenceEnd = /[.!?:]["”’)]?$/.test(para.last.text);
      const prevShort = para.last.x + para.last.w < ctx.x0 + (ctx.x1 - ctx.x0) * 0.55 && sentenceEnd;
      // At the top of the next column the spacing that marks a new paragraph is gone: a finished sentence followed by a capital is one.
      const newColumn = l.col !== para.last.col && sentenceEnd && /^[A-Z“"‘]/.test(l.text);
      // The line before ended with room to spare for this one's first word: the author broke
      // the line there (an address, a list of labels) or, after a full stop, ended the paragraph.
      const early = l.col === para.last.col && endedEarly(para.last, l, ctx);
      // Lines set further apart than the paragraph's own spacing (or the text's usual spacing) start a new one.
      const step = l.domBase - para.last.domBase;
      const usual = para.lines.length >= 2 ? para.last.domBase - para.lines[para.lines.length - 2].domBase : sameSize && ctx.leading && Math.abs(l.dom - ctx.body) < 0.6 ? ctx.leading : undefined;
      const spaced = usual !== undefined && l.col === para.last.col && step > usual + Math.max(1.5, l.dom * 0.15);
      if (gap < l.h * 0.75 && sameSize && !indented && !prevShort && !newColumn && !spaced && !(early && sentenceEnd) && bar === para.bar && l.x >= para.first.x - l.size * 1.5) {
        if (early) breakRuns(para.runs, runs);
        else joinRuns(para.runs, runs);
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

type TableBlock = Extract<SBlock, { kind: "table" }>;

/**
 * Lines set just above a table that head its columns (a heading centred over two columns, a
 * label set between two header rows): taken from the paragraphs they were read into and made
 * the table's header rows, each piece in the column (or columns) it sits over.
 */
function headsAbove(out: SBlock[], tb: TableBlock, bands: Band[], first: SLine, lineOf: Map<SBlock, SLine[]>, ctx: Ctx) {
  const n = tb.cells[0]?.length ?? 0;
  if (n < 2 || bands.length !== n) return;
  // Each column reaches halfway across the gaps on either side of its text.
  const edges = [bands[0].x0 - 6, ...bands.slice(1).map((b, k) => (bands[k].x1 + b.x0) / 2), bands[n - 1].x1 + 6];
  const rowsAbove: { y: number; y1: number; cells: Cell[] }[] = [];
  let topRow = { y: first.y, y1: first.y + first.h, cells: tb.cells[0] };
  let top = first.y;
  const taken: SBlock[] = [];
  for (let k = out.length - 1; k >= 0; k--) {
    const b = out[k];
    const ls = lineOf.get(b);
    if (!ls || b.kind !== "para" || b.page !== tb.page) break;
    let ok = true;
    const rows: { y: number; y1: number; cells: Cell[] }[] = [];
    for (const l of [...ls].reverse()) {
      const sg = segments(l);
      // Close above, no bigger than the table's text, short pieces each over its own columns.
      if (top - (l.y + l.h) > l.h * 1.6 || l.dom > ctx.body * 1.3 || sg.length > n || sg.some((g) => g.text.length > 40)) {
        ok = false;
        break;
      }
      const cols = sg.map((g) => {
        const over = edges.slice(0, -1).flatMap((x, c) => (Math.min(g.x2, edges[c + 1]) - Math.max(g.x, x) > Math.max(2, (g.x2 - g.x) * 0.2) ? [c] : []));
        return { g, from: over[0], span: over.length };
      });
      if (cols.some((c) => c.from === undefined) || cols.every((c) => c.from === 0) || l.x < edges[0] - 4 || l.x + l.w > edges[n] + 4) {
        ok = false;
        break;
      }
      const cellAt = (c: { g: Segment; span: number }): Cell => {
        const runs = mergeRuns(itemsRuns(c.g.items as Item[], (l as SLine).dom));
        return { paras: [runs], text: runsText(runs), ...(c.span > 1 ? { span: c.span, align: "center" as const } : {}) };
      };
      // A label reaching down beside the row below it (set between two header rows) fills that row's empty cell.
      const into = rows[rows.length - 1] ?? topRow;
      if (l.y + l.h > into.y - 1 && cols.every((c) => Array.from({ length: c.span }, (_, q) => !into.cells[c.from! + q]?.paras.length).every(Boolean))) {
        for (const c of cols) into.cells[c.from!] = { ...cellAt(c), ...(into.cells[c.from!]?.fill ? { fill: into.cells[c.from!].fill } : {}) };
        into.y = Math.min(into.y, l.y);
      } else {
        const cells: Cell[] = Array.from({ length: n }, () => ({ paras: [], text: "" }));
        for (const c of cols) cells[c.from!] = cellAt(c);
        rows.push({ y: l.y, y1: l.y + l.h, cells });
      }
      top = Math.min(top, l.y);
    }
    if (!ok) break;
    taken.push(b);
    rowsAbove.push(...rows);
    topRow = rowsAbove[rowsAbove.length - 1] ?? topRow;
  }
  if (!taken.length) return;
  for (const b of taken) out.splice(out.indexOf(b), 1);
  const extra = rowsAbove.reverse().map((r) => r.cells);
  tb.cells.unshift(...extra);
  tb.rows = tb.cells.map((r) => r.map((c) => c.text));
  tb.head = extra.length + (tb.header ? 1 : 0);
  tb.header = true;
  if (tb.geo) tb.geo.top = Math.min(tb.geo.top, top - (tb.pad?.y ?? 0));
  if (tb.rowRules) tb.rowRules = [...extra.map(() => null), ...tb.rowRules];
  if (tb.rowSpace) tb.rowSpace = [...extra.map(() => 0), ...tb.rowSpace];
}

/**
 * A line with a short piece set flush right across a wide gap (a date beside a job title, a
 * badge beside a label, an amount beside its name): that piece follows a tab to a stop at
 * the right edge, so it stays flush right in Word.
 */
function tabbedRuns(l: SLine, segs: Segment[], ctx: Ctx): Run[] | null {
  const width = ctx.x1 - ctx.x0;
  if (segs.length < 2 || width < 150) return null;
  const last = segs[segs.length - 1];
  const prev = segs[segs.length - 2];
  // A badge counts to the edge of its background.
  const end = Math.max(last.x2, ...(last.items as Item[]).map((it) => it.bgRight ?? -Infinity));
  if (ctx.x1 - end > Math.max(3, l.dom * 0.4) || last.x - prev.x2 < l.dom * 2 || last.x2 - last.x > width * 0.4) return null;
  const left = mergeRuns(itemsRuns(sliceItems(l.items, -Infinity, last.x - 0.5), l.dom));
  const right = mergeRuns(itemsRuns(sliceItems(l.items, last.x - 0.5), l.dom));
  if (!left.length || !right.length) return null;
  right[0] = { ...right[0], tab: "right" };
  return [...left, ...right];
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
function indentOf(lines: SLine[], ctx: Ctx, wrapped = false): { indent?: { left: number; first: number; right?: number } } {
  if (lines.length < 2) {
    const left = lines[0] ? lines[0].x - ctx.x0 : 0;
    return left >= (lines[0]?.dom ?? 10) * 0.5 ? { indent: { left, first: 0 } } : {};
  }
  const left = Math.min(...lines.slice(1).map((l) => l.x)) - ctx.x0;
  const first = lines[0].x - ctx.x0 - left;
  const size = lines[0].dom;
  // A justified block narrower than the text around it (an abstract, a quotation) is indented on the right too.
  const body = lines.slice(0, -1);
  const edge = Math.max(...lines.map((l) => l.x + l.w));
  let right = lines.length >= 3 && body.every((l) => edge - (l.x + l.w) < 1.2) && ctx.x1 - edge >= size * 0.5 ? ctx.x1 - edge : 0;
  // Ragged text set narrower than the column (every line broke with room for the next word):
  // as narrow, between its longest line and the shortest that would have taken the next word.
  if (!right && wrapped) {
    const fits = body.map((l, k) => {
      const nx = lines[k + 1];
      const it = nx.items.find((i) => i.str.trim());
      const str = it ? it.str.trimStart() : "";
      return l.x + l.w + nx.dom * 0.28 + (it ? (it.w * (str.split(/\s/)[0].length || 1)) / (str.length || 1) : 0);
    });
    const most = Math.min(...fits);
    if (most < ctx.x1 - size * 0.5 && most > edge) right = ctx.x1 - (edge + most) / 2;
  }
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
  const move = <T extends Rect>(rs: T[]) => rs.map((r) => ({ ...r, x: r.x - (starts[colOf(r.x + Math.min(r.w, 8) / 2)] - starts[0]), src: (r as Rule).src ?? r }));
  const inner = blocksOf(vlines, { ...ctx, x0: starts[0], x1: colRight, hrules: move(ctx.hrules), vrules: move(ctx.vrules), marks: move(ctx.marks), fills: move(ctx.fills), outlines: move(ctx.outlines) });
  // Gaps inside: down a column as measured; where the next block heads the next column, unknown.
  const placed = inner.filter((b): b is Extract<SBlock, { geo?: Geo }> & { geo: Geo } => "geo" in b && !!b.geo);
  placed.forEach((b, k) => {
    const nx = placed[k + 1]?.geo;
    const gap = nx ? nx.top - b.geo.bottom : undefined;
    b.geo.gap = gap !== undefined && gap >= 0 ? Math.min(gap, 72) : undefined;
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
    // Prose is words: mostly letters (columns of figures fill their lines just as evenly).
    const all = text.map((l) => l.text.replace(/\s/g, "")).join("");
    const letters = (all.match(/\p{L}/gu) ?? []).length;
    return full / text.length >= 0.7 && avg >= 20 && letters >= all.length * 0.6;
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
    // The columns start where both do (within a line or so): short lines well above that are ordinary text.
    while (to - from > 0 && oneSided(lines[from])) {
      const own = side(lines[from], 0).length ? 0 : 1;
      const other = lines.slice(from + 1, to).find((l) => side(l, 1 - own).length);
      if (other && other.y - lines[from].y <= lines[from].h * 1.8) break;
      from++;
    }
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
  // A numbered title ("1. Definitions" over its clauses) is a heading; one followed by the next number is an item of a list.
  const mk = markerAt(l, ctx);
  const after = lines[i + 1] ? markerAt(lines[i + 1], ctx) : null;
  const titled = !mk || (mk.kind === "decimal" && !!mk.after && text.length < 60 && !(after?.kind === "decimal" && Math.abs(after.x - mk.x) < 4));
  const boldish = l.bold && l.dom >= ctx.body * 0.98 && text.length < 80 && (text.match(/\p{L}/gu) ?? []).length >= 3 && !/[.:,;!?]$/.test(text) && titled;
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
  const { align } = alignOf(group, ctx);
  const geo = geoOf(group);
  const under = underOf(geo, lines[end], ctx);
  return { block: { kind: "heading", level: 1, text: all, runs: merged, size: l.dom, page: ctx.page, ...(align === "center" || align === "right" ? { align } : {}), ...(under ? { under } : {}), geo }, end };
}

/**
 * A rule drawn just under a heading (and above whatever follows), across most of the text:
 * the heading's own underline. It is claimed so no table below takes it as its top line.
 */
function underOf(geo: Geo, next: SLine | undefined, ctx: Ctx): Under | undefined {
  const width = ctx.x1 - ctx.x0;
  const limit = Math.min(geo.bottom + Math.max(geo.last, 6) * 0.9, next ? next.y : Infinity);
  const r = ctx.hrules.find((h) => !ctx.used.has(h.src ?? h) && h.y >= geo.bottom - 1 && h.y <= limit && h.w >= width * 0.5 && h.x <= ctx.x0 + width * 0.25);
  if (!r) return undefined;
  ctx.used.add(r.src ?? r);
  return { color: r.color ?? "#000000", h: r.h, at: Math.max(0, r.y - geo.bottom) };
}

/* ------------------------------------------------------------- lists */

/** A list marker: its kind and value, the text around the number, where it and the item's text start, its look, and the text it shows (`token`). */
type Marker = { kind: ListFormat["kind"]; value: number; before: string; after: string; bullet?: string; x: number; textX: number; letter?: string; run?: ListFormat["run"]; token?: string; literal?: string };

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
  if (mark) return { kind: mark.check ? "check" : "bullet", value: 1, before: "", after: "", bullet: mark.bullet, x: mark.x, textX: first.x, ...(mark.color ? { run: { size: half(first.it.fontSize), color: mark.color, bold: false } } : {}) };
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
  if (first.it.sup) return null;
  const it0 = first.it;
  const at = { x: first.x, textX: next.x, token, run: { size: half(it0.fontSize), color: it0.color, bold: it0.bold, face: it0.face, family: it0.family } };
  if (BULLETS.test(token)) return { kind: "bullet", value: 1, before: "", after: "", bullet: /[–—*-]/.test(token) ? "–" : /[▪■\uF0A7\uF06E]/.test(token) ? "▪" : /[◦○]/.test(token) ? "◦" : "•", ...at };
  let m = token.match(/^(\()?(\d{1,3})([.)])$/) ?? token.match(/^(\[)(\d{1,3})(\])$/);
  if (m) return { kind: "decimal", value: Number(m[2]), before: m[1] ?? "", after: m[3], ...at };
  m = token.match(/^(\()?([a-zA-Z])([.)])$/);
  if (m) return { kind: m[2] === m[2].toLowerCase() ? "lowerLetter" : "upperLetter", value: m[2].toLowerCase().charCodeAt(0) - 96, before: m[1] ?? "", after: m[3], letter: m[2], ...at };
  m = token.match(/^(\()?([ivxlc]{2,5}|[IVXLC]{2,5})([.)])$/);
  if (m) return { kind: m[2] === m[2].toLowerCase() ? "lowerRoman" : "upperRoman", value: romanValue(m[2]), before: m[1] ?? "", after: m[3], ...at };
  // Clause numbers (2.1, 3.2.4) set apart from their text: kept as text, the item hanging after them.
  if (/^\d{1,3}(\.\d{1,3}){1,3}\.?$/.test(token) && gap >= em * 0.6) return { kind: "none", value: Number(token.replace(/\.$/, "").split(".").pop()), before: "", after: "", literal: token, ...at };
  // Bare numbers and letters count only when set apart: another style, or a wide gap.
  if (/^\d{1,3}$/.test(token) && ((styled && gap > em * 0.25) || gap >= em * 1.5)) return { kind: "decimal", value: Number(token), before: "", after: "", ...at };
  if (/^[a-z]$/.test(token) && styled && gap > em * 0.3) return { kind: "lowerLetter", value: token.charCodeAt(0) - 96, before: "", after: "", letter: token, ...at };
  return null;
}

const sameFamily = (a: Marker, b: Marker) => {
  const fam = (k: Marker["kind"]) => (k === "lowerLetter" || k === "lowerRoman" ? "lower" : k === "upperLetter" || k === "upperRoman" ? "upper" : k);
  const depth = (m: Marker) => (m.literal ? m.literal.replace(/\.$/, "").split(".").length : 0);
  return fam(a.kind) === fam(b.kind) && a.after === b.after && a.before === b.before && depth(a) === depth(b);
};

/** The run that shows a marker's own text, in its look. */
const markerRun = (m: Marker, text: string): Run => ({ text, bold: m.run?.bold ?? false, italic: false, ...(m.run ? { size: m.run.size, color: m.run.color, face: m.run.face, family: m.run.family } : {}) });

/** Markers of one list look alike (a footnote's raised "1" is not the next item of a numbered list). */
const sameLook = (a: Marker, b: Marker) => !a.run || !b.run || (Math.abs(a.run.size - b.run.size) < 1 && a.run.bold === b.run.bold && (a.run.color ?? "") === (b.run.color ?? ""));

/** An item of a list being read: its marker, text, nested items (or options set in a grid under it), and where it sits. */
type LItem = { m: Marker; col: number; runs: Run[]; children: LItem[]; childFormat?: ListFormat; grid?: Grid; top: number; bottom: number; bases: number[]; size: number; right: number; rights?: number[] };
/** Items set side by side, read row by row, that wrap within their columns. */
type Grid = { rows: LItem[][]; cols: Marker[] };

/**
 * A list starting at line i. Items continue on lines aligned with their text (hanging
 * indents); deeper markers start a nested list; a line can hold items side by side
 * (a list set in columns), read in the order of their numbers.
 */
function findList(lines: SLine[], segs: Segment[][], i: number, ctx: Ctx, minX = -Infinity): { blocks: SBlock[]; end: number; items: LItem[]; format: ListFormat; used: Rule[]; grid?: Grid } | null {
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
  // Side by side on later lines too (a grid of options), or a single row of them.
  const besideBelow = (c: Marker) => lines.slice(i + 1, i + 8).some((l) => Math.abs((markerAt(l, ctx, c.x - 2)?.x ?? -99) - c.x) < 4);
  const oneRow = cols.every((c, k) => k === 0 || c.value === cols[k - 1].value + 1);
  if (cols.length > 1 && !oneRow && !cols.slice(1).every(besideBelow)) cols.length = 1;
  const bounds = cols.map((c, k) => [c.x - 3, k + 1 < cols.length ? cols[k + 1].x - 3 : Infinity]);
  // The text after the marker must be one piece (several columns of text make it a table
  // row), apart from a short piece set flush right at the end (marks, a date).
  const textSegs = (l: SLine, x0: number, x1: number) => segments({ ...l, items: sliceItems(l.items, x0, x1) } as Line);
  const tailAt = (l: SLine, x0: number, x1: number): number | null => {
    if (cols.length > 1) return null;
    const sg = textSegs(l, x0, x1);
    const last = sg[sg.length - 1];
    if (sg.length !== 2) return null;
    return ctx.x1 - last.x2 < Math.max(3, l.dom * 0.4) && last.x - sg[0].x2 >= l.dom * 2 && last.x2 - last.x <= (ctx.x1 - ctx.x0) * 0.25 ? last.x : null;
  };
  const onePiece = (l: SLine, x0: number, x1: number) => textSegs(l, x0, x1).length === 1 || tailAt(l, x0, x1) !== null;
  if (cols.some((c, k) => !onePiece(lines[i], c.textX - 0.5, bounds[k][1]))) return null;

  const items: LItem[] = [];
  const open: (LItem | null)[] = cols.map(() => null);
  // Without a hanging indent, a wrapped item carries on under its marker: the line before ran
  // to the edge of the column and this one follows straight on.
  const wraps = (cur: LItem, k: number, px: number, l: SLine) => {
    const right = k + 1 < cols.length ? cols[k + 1].x - 6 : ctx.x1;
    return px >= cur.m.x - 4 && cur.right > right - (right - cols[k].x) * 0.2 && l.y - cur.bottom < l.h * 0.6 && !markerAt(l, ctx, bounds[k][0]);
  };
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
      if (mk && Math.abs(mk.x - cols[k].x) < 4 && sameFamily(mk, cols[k]) && sameLook(mk, cols[k]) && onePiece(l, mk.textX - 0.5, x1)) {
        const tail = tailAt(l, mk.textX - 0.5, x1);
        // Where the item's text sits (a number set larger than the text reaches above and below it).
        const body = sliceItems(l.items, mk.textX - 0.5, tail ?? x1);
        const text = body.filter((p) => p.str.trim() && !p.sup);
        const top = text.length ? Math.min(...text.map((p) => p.y)) : l.y;
        const bottom = text.length ? Math.max(...text.map((p) => p.y + p.h)) : l.y + l.h;
        let runs = itemsRuns(body, l.dom);
        // A clause number stays in the text, the item's text after a tab at its hanging indent.
        if (mk.literal && runs.length) runs = [markerRun(mk, mk.literal), { ...runs[0], text: runs[0].text.trimStart(), tab: "next" }, ...runs.slice(1)];
        if (tail !== null) {
          const right = mergeRuns(itemsRuns(sliceItems(l.items, tail - 0.5, x1), l.dom));
          if (right.length) runs = [...mergeRuns(runs), { ...right[0], tab: "right" }, ...right.slice(1)];
        }
        const right = text.length ? Math.max(...text.map((p) => p.x + p.w)) : l.x + l.w;
        const it: LItem = { m: mk, col: k, runs, children: [], top, bottom, bases: [l.domBase], size: l.dom, right, rights: [right] };
        items.push(it);
        open[k] = it;
      } else if (cur && cols.length === 1 && mk && mk.x > cols[k].x + 6 && mk.x <= cur.m.textX + 48) {
        // A nested list under the current item.
        const sub = findList(lines, segs, j, ctx, mk.x - 2);
        if (!sub || sub.end <= j) {
          ok = false;
          break;
        }
        if (sub.grid) cur.grid = sub.grid;
        else {
          cur.children.push(...sub.items);
          cur.childFormat = sub.format;
        }
        j = sub.end - 1;
        nested = true;
      } else if (cur && (Math.abs(px - cur.m.textX) <= Math.max(4, l.dom * 0.6) || wraps(cur, k, px, l))) {
        joinRuns(cur.runs, itemsRuns(part, l.dom));
        cur.bottom = Math.max(cur.bottom, l.y + l.h);
        cur.bases.push(l.domBase);
        cur.right = Math.max(...part.filter((p) => p.str.trim()).map((p) => p.x + p.w));
        cur.rights?.push(cur.right);
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
  let grid = false;
  if (cols.length > 1) {
    const vals = items.map((it) => it.m.value);
    const sorted = [...vals].sort((a, b) => a - b);
    const seq = sorted.every((v, k) => k === 0 || v === sorted[k - 1] + 1);
    const down = [...items].sort((a, b) => a.col - b.col);
    ordered = seq ? [...items].sort((a, b) => a.m.value - b.m.value) : down;
    const downColumns = seq && down.every((it, k) => it === ordered[k]);
    // Short options set in a row, or across a grid row by row: each row one line, the options
    // after tabs where they sit. Numbered down each column in turn (not across): keep the columns.
    const short = items.every((it) => it.bases.length === 1 && !it.children.length);
    if (seq && (items.length === cols.length || !downColumns)) {
      // Options that wrap within their columns are kept in a grid (a table under the item they belong to).
      if (!short && minX > -Infinity) return { blocks: [], end, items: ordered, format: { kind: "none", before: "", after: "", start: 1 }, used: [], grid: { rows: byRows(ordered), cols } };
      if (short) {
        ordered = gridRows(ordered, cols, ctx);
        grid = true;
      }
    } else if (downColumns) columns = cols.length;
  }
  // Bare numbers, and letters (an initial like "A. Rao" looks the same), need a run of them to count as a list.
  if (ordered.length < 2 && !grid && m0.kind !== "bullet" && m0.kind !== "check" && m0.kind !== "none" && (!m0.after || m0.kind !== "decimal")) return null;
  const firstM = ordered[0].m;
  let kind = firstM.kind;
  let start = firstM.value;
  // "i." before "ii." is a roman numeral, not the letter i.
  if (kind === "lowerLetter" && firstM.letter === "i" && ordered[1]?.m.kind === "lowerRoman") [kind, start] = ["lowerRoman", 1];
  if (kind === "upperLetter" && firstM.letter === "I" && ordered[1]?.m.kind === "upperRoman") [kind, start] = ["upperRoman", 1];
  const indent = grid ? { left: Math.max(0, firstM.x - ctx.x0), hanging: 0 } : { left: Math.max(0, firstM.textX - ctx.x0), hanging: Math.max(9, firstM.textX - firstM.x) };
  const format: ListFormat = { kind, before: firstM.before, after: firstM.after, start, ...(firstM.bullet ? { bullet: firstM.bullet } : {}), ...(firstM.run && !grid ? { run: firstM.run } : {}), indent };
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
  const used: Rule[] = [];
  const lx0 = Math.min(...geos.map((g) => g.m.x));
  const lx1 = ctx.x1;
  const bottomOf = (g: LItem) => (g.grid ? Math.max(g.bottom, ...g.grid.rows.flat().map((r) => r.bottom)) : g.bottom);
  const gridRules = new Map<LItem, Rule>();
  const between = geos.slice(0, -1).some((g, k) => ctx.hrules.some((h) => !ctx.used.has(h.src ?? h) && h.y >= bottomOf(g) - 1 && h.y + h.h <= geos[k + 1].top + 1 && h.w >= (lx1 - lx0) * 0.6 && h.x < lx0 + 20));
  const rules = geos.map((g, k) => {
    const bottom = bottomOf(g);
    // A line under the last item is the list's own only when lines also run between its items.
    if (k === geos.length - 1 && !between) return null;
    const below = k + 1 < geos.length ? geos[k + 1].top : bottom + g.size * 3;
    if (below < bottom) return null;
    const r = ctx.hrules.find((h) => !ctx.used.has(h.src ?? h) && h.y >= bottom - 1 && h.y + h.h <= below + 1 && h.w >= (lx1 - lx0) * 0.6 && h.x < lx0 + 20);
    if (r) used.push(r);
    if (r && g.grid) gridRules.set(g, r);
    return r && !g.grid ? { color: r.color ?? "#000000", at: r.y - g.bottom, h: r.h } : null;
  });
  const isOrdered = format.kind !== "bullet" && format.kind !== "check";
  const out = grid ? { ...format, kind: "none" as const } : format;
  // Justified: the items that wrap fill every line but their last to the right edge.
  const wrapped = geos.filter((g) => (g.rights?.length ?? 0) >= 2);
  const justified = wrapped.length >= 2 && wrapped.filter((g) => g.rights!.slice(0, -1).every((r) => ctx.x1 - r < 1.5)).length >= wrapped.length * 0.75;
  const block: Extract<SBlock, { kind: "list" }> = { kind: "list", ordered: isOrdered, items: flat, levels, formats: grid ? [out, ...formats.slice(1)] : formats, ...(columns ? { columns } : {}), gaps, ...(rules.some(Boolean) ? { rules } : {}), ...(justified ? { align: "justify" as const } : {}), page: ctx.page, geo };
  // Options set in a grid under an item: the list stops after that item, the grid follows as a
  // table (with any rule drawn under it), and the list carries on, numbered from where it was.
  const blocks: SBlock[] = [];
  let from = 0;
  geos.forEach((g, k) => {
    if (!g.grid) return;
    let to = k + 1;
    while (to < geos.length && levels[to] > levels[k]) to++;
    blocks.push(listPart(block, geos, from, to), gridTable(g.grid, ctx));
    const r = gridRules.get(g);
    if (r) blocks.push({ kind: "rule", color: r.color ?? "#000000", h: r.h, inset: { left: Math.max(0, r.x - ctx.x0), right: Math.max(0, ctx.x1 - (r.x + r.w)) }, page: ctx.page, geo: { top: r.y, bottom: r.y + r.h, first: 0, last: 0 } });
    from = to;
  });
  if (from < geos.length) blocks.push(from ? listPart(block, geos, from, geos.length) : block);
  return { blocks, end, items: ordered, format: out, used };
}

/** Items from..to of a list as a list of their own (numbered on from where they were). */
function listPart(b: Extract<SBlock, { kind: "list" }>, geos: LItem[], from: number, to: number): SBlock {
  if (from === 0 && to === b.items.length) return b;
  const gs = geos.slice(from, to);
  const base = b.levels[from] ?? 0;
  const formats = b.formats.map((f, lvl) => (lvl === base && from > 0 && f.kind !== "bullet" && f.kind !== "check" && f.kind !== "none" ? { ...f, start: geos[from].m.value } : f));
  return {
    ...b,
    items: b.items.slice(from, to),
    levels: b.levels.slice(from, to),
    formats,
    gaps: b.gaps?.slice(from, to - 1),
    ...(b.rules ? { rules: b.rules.slice(from, to) } : {}),
    geo: { ...b.geo!, top: Math.min(...gs.map((g) => g.top)), bottom: Math.max(...gs.map((g) => g.bottom)), first: gs[0].size, last: gs[gs.length - 1].size },
  };
}

/** Items in rows (by where they sit), each row left to right. */
function byRows(items: LItem[]): LItem[][] {
  const rows: LItem[][] = [];
  for (const it of [...items].sort((a, b) => a.top - b.top)) {
    const row = rows.find((r) => Math.abs(r[0].top - it.top) < Math.max(2, it.size * 0.4));
    if (row) row.push(it);
    else rows.push([it]);
  }
  for (const r of rows) r.sort((a, b) => a.m.x - b.m.x);
  return rows;
}

/** Options set in a grid that wrap within their columns, as a table without lines: each keeps its label, its text hanging after it. */
function gridTable(g: Grid, ctx: Ctx): SBlock {
  const edges = [...g.cols.map((c) => c.x), ctx.x1];
  const ws = edges.slice(1).map((e, k) => Math.max(1, e - edges[k]));
  const total = ws.reduce((a, b) => a + b, 0);
  const cells: Cell[][] = g.rows.map((row) =>
    g.cols.map((_, k) => {
      const it = row.find((r) => r.col === k);
      if (!it || !it.runs.length) return { paras: [], text: "" };
      const runs = mergeRuns([markerRun(it.m, it.m.token ?? listToken(it.m)), { ...it.runs[0], text: it.runs[0].text.trimStart(), tab: "next" }, ...it.runs.slice(1)]);
      return { paras: [runs], text: runsText(runs), hang: it.m.textX - it.m.x, geo: { gaps: [], leadings: [leadingOf(it.bases, it.size)], sizes: [half(it.size)] } };
    }),
  );
  const tops = g.rows.map((r) => Math.min(...r.map((i) => i.top)));
  const bottoms = g.rows.map((r) => Math.max(...r.map((i) => i.bottom)));
  const gaps = tops.slice(1).map((t, k) => t - bottoms[k]).filter((v) => v >= 0);
  const padY = gaps.length ? median(gaps) / 2 : 2;
  const all = g.rows.flat();
  return {
    kind: "table",
    rows: cells.map((r) => r.map((c) => c.text)),
    cells,
    header: false,
    widths: ws.map((w) => w / total),
    span: { x: g.cols[0].x - ctx.x0, w: total },
    pad: { x: 4, y: padY },
    inset: 0,
    leading: median(all.map((i) => leadingOf(i.bases, i.size)).filter((v): v is number => v !== undefined)) || undefined,
    page: ctx.page,
    // Like other tables, its edges sit half a row's gap beyond its text.
    geo: { top: tops[0] - padY, bottom: bottoms[bottoms.length - 1] + padY, first: 0, last: 0 },
  };
}

/**
 * Items set side by side (options a to d in a row, or two by two) as one line per row: each
 * item keeps its own label as text, the second and later ones after a tab where they sit.
 */
function gridRows(items: LItem[], cols: Marker[], ctx: Ctx): LItem[] {
  const rows: LItem[][] = [];
  for (const it of items) {
    const row = rows.find((r) => Math.abs(r[0].top - it.top) < Math.max(2, it.size * 0.4));
    if (row) row.push(it);
    else rows.push([it]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.m.x - b.m.x);
    const runs: Run[] = [];
    row.forEach((it, k) => {
      const label = markerRun(it.m, it.m.token ?? listToken(it.m));
      const own = it.runs.map((r, n) => (n ? r : { ...r, text: " " + r.text.trimStart() }));
      if (own.length) own[own.length - 1] = { ...own[own.length - 1], text: own[own.length - 1].text.trimEnd() };
      runs.push(k ? { ...label, tab: it.m.x - ctx.x0 } : label, ...own);
    });
    const first = row[0];
    const m: Marker = { kind: "none", value: rows.indexOf(row) + 1, before: "", after: "", x: cols[0].x, textX: cols[0].x };
    return { m, col: 0, runs: mergeRuns(runs), children: [], top: Math.min(...row.map((r) => r.top)), bottom: Math.max(...row.map((r) => r.bottom)), bases: first.bases, size: first.size, right: Math.max(...row.map((r) => r.right)) };
  });
}

/** The text a marker shows, rebuilt from its kind and value (for markers drawn rather than written). */
function listToken(m: Marker): string {
  if (m.kind === "bullet") return m.bullet ?? "•";
  if (m.kind === "check") return "☐";
  const n = m.value;
  const s = m.kind === "lowerLetter" ? letters(n) : m.kind === "upperLetter" ? letters(n).toUpperCase() : m.kind === "lowerRoman" ? roman(n) : m.kind === "upperRoman" ? roman(n).toUpperCase() : String(n);
  return m.before + s + m.after;
}

/* ------------------------------------------------------------- tables */

type Band = { x0: number; x1: number };
/** A piece of text placed in a column; `span` marks a heading that stretches over several columns. */
type Placed = Segment & { y: number; h: number; base: number; size: number; bold: boolean; band: number; span: boolean };
type TableHit = { end: number; cells: Cell[][]; header: boolean; head?: number; widths: number[]; bands: Band[]; span?: { x: number; w: number }; lines?: "rows" | "grid"; lineColor?: string; rowRules?: (string | null)[]; pad?: { x: number; y: number }; inset?: number; leading?: number; rules: Rule[]; rowSpace?: number[] };
type TableCtx = { body: number; hrules: Rule[]; used?: Set<Rule>; vrules: Rule[]; fills: Box[]; outlines: Box[]; marks?: Mark[]; x0?: number; x1?: number };

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

/* Widths of the printable ASCII characters (space to tilde) in Helvetica and Times, thousandths of
   an em: to estimate where each character of a run of text sits. */
const SANS_W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const SERIF_W = [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541];
export const glyphW = (c: string, family: TextItem["family"]) => {
  if (family === "mono") return 600;
  const k = c.charCodeAt(0) - 32;
  if (k >= 0 && k < 95) return (family === "serif" ? SERIF_W : SANS_W)[k];
  return /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(c) ? 1000 : family === "serif" ? 500 : 556;
};

/**
 * An item cut where its text runs across a column's edge: a PDF reader runs two cells together
 * when the space between them is under about half a character, putting a single space for it.
 * Each space in the item is a possible cut; one is taken where the word after it starts at a
 * column start (`starts`) or the word before it ends at a column's flush-right edge (`ends`),
 * as estimated from typical glyph widths fitted to the item's width.
 */
function cutAtColumns(it: TextItem, starts: number[], ends: number[], tight: number[] = []): TextItem[] {
  const str = it.str;
  if (str.trim().length < 3 || !/\S\s+\S/.test(str)) return [it];
  // Where the reader marked the gap, its place is exact: cut where it lines up with a column's
  // edge, or holds one found down the rows.
  if (it.gaps?.length) {
    const g = it.gaps.find((q) => starts.some((x) => Math.abs(x - (q.x + q.w)) <= 1.5) || ends.some((x) => Math.abs(x - q.x) <= 1.5) || tight.some((x) => x >= q.x - 0.5 && x <= q.x + q.w + 0.5));
    if (!g) return [it];
    const [left, right] = cutAtGap(it, g);
    return [...cutAtColumns(left, starts, ends, tight), ...cutAtColumns(right, starts, ends, tight)];
  }
  const ws = Array.from(str, (c) => glyphW(c, it.family));
  const total = ws.reduce((a, b) => a + b, 0) || 1;
  const at: number[] = [0];
  for (const w of ws) at.push(at[at.length - 1] + (w / total) * it.w);
  // Also the widths as set at the item's size, counted from either end: exact where the gap the
  // space stands for is wide (scaling would spread it over every character).
  const nat: number[] = [0];
  for (const w of ws) nat.push(nat[nat.length - 1] + (w / 1000) * it.fontSize);
  const n = str.length;
  const tol = Math.max(2, it.fontSize * 0.35);
  for (let k = 1; k < n - 1; k++) {
    if (str[k] !== " " || str[k - 1] === " ") continue;
    let e = k;
    while (e < n && str[e] === " ") e++;
    if (e >= n) break;
    const x0 = it.x + at[k];
    const x1 = it.x + at[e];
    const ends0 = [x0, it.x + nat[k], it.x + it.w - (nat[n] - nat[k])];
    const starts1 = [x1, it.x + it.w - (nat[n] - nat[e]), it.x + nat[e]];
    const s = starts.find((x) => x > it.x + 2 && starts1.some((y) => Math.abs(x - y) <= tol));
    const z = ends.find((x) => x < it.x + it.w - 2 && ends0.some((y) => Math.abs(x - y) <= tol));
    if (s === undefined && z === undefined) continue;
    // The space the reader put there stands for a wider gap: the known edge places the cut exactly,
    // the other side keeps its own width.
    const end = z ?? Math.min(x0, (s ?? x0) - 1);
    const start = s ?? Math.max(end + 1, it.x + it.w - (at[str.length] - at[e]));
    const left: TextItem = { ...it, str: str.slice(0, k), w: end - it.x, gaps: undefined };
    const right: TextItem = { ...it, str: str.slice(e), x: start, w: it.x + it.w - start, ox: it.ox + (start - it.x), bbox: { ...it.bbox, x: it.bbox.x + (start - it.x), w: it.x + it.w - start }, gaps: undefined };
    return [left, ...cutAtColumns(right, starts, ends)];
  }
  return [it];
}

/**
 * Right edges that line up across at least `min` of the given lines where figures end, each a
 * different figure: a column of figures set flush right (or codes of one length).
 */
function sharedEnds(rows: Segment[][], min: number): number[] {
  const pts = rows.flatMap((r, ri) => r.map((sg) => ({ x: sg.x2, ri, t: sg.text }))).sort((a, b) => a.x - b.x);
  const out: number[] = [];
  for (let i = 0; i < pts.length; ) {
    let j = i;
    while (j + 1 < pts.length && pts[j + 1].x - pts[i].x <= 1.5) j++;
    const g = pts.slice(i, j + 1);
    i = j + 1;
    // (Ending in a figure of its own: an amount, a code, a percentage, a balance marked Cr or Dr.)
    const figures = g.flatMap((p) => p.t.match(/(?:^|\s)([-+(]?[₹$€£]?\d[\d,.]*\)?%?(?:\s+(?:cr|dr))?)$/i)?.slice(1, 2) ?? []);
    // (Different figures: the same code at the end of a repeated entry doesn't make a column.)
    if (new Set(g.map((p) => p.ri)).size >= min && figures.length * 2 >= g.length && new Set(figures).size >= Math.min(2, figures.length)) out.push(g[g.length >> 1].x);
  }
  return out;
}

/** Cut a segment between two of its items wherever one of `xs` falls in the space between them. */
function splitBetween(sg: Segment, xs: number[]): Segment[] {
  const cuts = xs.filter((x) => x > sg.x && x < sg.x2);
  if (!cuts.length || sg.items.length < 2) return [sg];
  const parts: TextItem[][] = [[]];
  let end = -Infinity;
  for (const it of sg.items) {
    const [x0, x1] = inked(it);
    if (parts[0].length && cuts.some((x) => x >= end - 0.5 && x <= x0 + 0.5)) parts.push([]);
    parts[parts.length - 1].push(it);
    end = Math.max(end, x1);
  }
  return parts.filter((p) => p.length).map(segmentOf);
}

/** An item cut at one of its closed-up gaps (see TextItem.gaps): the text before it and after it. */
function cutAtGap(it: TextItem, g: NonNullable<TextItem["gaps"]>[number]): [TextItem, TextItem] {
  const end = g.x + g.w;
  const left: TextItem = { ...it, str: it.str.slice(0, g.at), w: g.x - it.x, gaps: it.gaps!.filter((q) => q.at < g.at) };
  const right: TextItem = {
    ...it,
    str: it.str.slice(g.at + 1),
    x: end,
    w: it.x + it.w - end,
    ox: it.ox + (end - it.x),
    bbox: { ...it.bbox, x: it.bbox.x + (end - it.x), w: it.x + it.w - end },
    gaps: it.gaps!.filter((q) => q.at > g.at).map((q) => ({ ...q, at: q.at - g.at - 1 })),
  };
  return [left, right];
}

/** Where an item's text runs, piece by piece between its closed-up gaps. */
function boxesOf(it: TextItem): [number, number][] {
  if (!it.gaps?.length) return [inked(it)];
  const out: [number, number][] = [];
  let x = it.x;
  for (const g of it.gaps) {
    if (g.x > x) out.push([x, g.x]);
    x = g.x + g.w;
  }
  if (it.x + it.w > x) out.push([x, it.x + it.w]);
  return out;
}

/** Where an item's characters start and end, without the spaces at its ends. */
function inked(it: TextItem): [number, number] {
  const n = it.str.length || 1;
  const lead = it.str.length - it.str.trimStart().length;
  const trail = it.str.length - it.str.trimEnd().length;
  return [it.x + (it.w * lead) / n, it.x + it.w - (it.w * trail) / n];
}

/** A line's pieces, also cut where a line drawn down the page (a table's column rule) passes between them. */
function splitAtRules(sgs: Segment[], vrules: Rule[], l: Line): Segment[] {
  const xs = vrules.filter((r) => r.y <= l.y + l.h * 0.3 && r.y + r.h >= l.y + l.h * 0.7).map((r) => r.x + r.w / 2);
  if (!xs.length) return sgs;
  // Text run together across a rule (the reader joined two cells): cut at the space over it.
  return sgs.flatMap((sg) => {
    const items = sg.items.flatMap((it) => {
      let parts = [it];
      for (const x of xs) parts = parts.flatMap((p) => (p.x < x - 1 && p.x + p.w > x + 1 ? cutAtRule(p, x) : [p]));
      return parts;
    });
    return splitBetween(items.length === sg.items.length ? sg : segmentOf(items), xs);
  });
}

/** An item cut at the space that sits over x (a rule drawn between two cells the reader ran together). */
function cutAtRule(it: TextItem, x: number): TextItem[] {
  const str = it.str;
  // The reader's own record of the gap, where it kept one.
  const g = it.gaps?.find((q) => x >= q.x - 1 && x <= q.x + q.w + 1);
  if (g) return cutAtGap(it, g);
  if (it.gaps?.length) return [it];
  const ws = Array.from(str, (c) => glyphW(c, it.family));
  const total = ws.reduce((a, b) => a + b, 0) || 1;
  const at: number[] = [0];
  for (const w of ws) at.push(at[at.length - 1] + (w / total) * it.w);
  // The space nearest the rule, if clearly nearest (the next nearest at least twice as far).
  const spaces: { k: number; e: number; d: number }[] = [];
  for (let k = 1; k < str.length - 1; k++) {
    if (str[k] !== " " || str[k - 1] === " ") continue;
    let e = k;
    while (e < str.length && str[e] === " ") e++;
    spaces.push({ k, e, d: Math.abs(it.x + (at[k] + at[e]) / 2 - x) });
  }
  spaces.sort((a, b) => a.d - b.d);
  const [near, next] = spaces;
  if (!near || near.d > Math.max(6, it.fontSize * 1.3) || (next && next.d < near.d * 2)) return [it];
  const { k, e } = near;
  // Each side keeps clear of the rule, as a cell's text keeps inside its padding.
  const end = Math.min(it.x + at[k], x - 2.5);
  const start = Math.max(it.x + at[e], x + 2.5);
  return [
    { ...it, str: str.slice(0, k), w: end - it.x, gaps: undefined },
    { ...it, str: str.slice(e), x: start, w: it.x + it.w - start, ox: it.ox + (start - it.x), bbox: { ...it.bbox, x: it.bbox.x + (start - it.x), w: it.x + it.w - start }, gaps: undefined },
  ];
}

/**
 * Column edges set closer than a word gap's limit (dates right beside descriptions, figures
 * beside figures): a strip left empty down the rows (a header over several columns may cross
 * it), with the text on one side of it lined up in at least three rows.
 */
function tightCuts(ls: Line[]): number[] {
  if (ls.length < 3) return [];
  const rows = ls.map((l) => l.items.filter((it) => it.str.trim()).flatMap(boxesOf).sort((a, b) => a[0] - b[0]));
  const size = median(ls.map((l) => l.size));
  // (Wider than a word space, about a quarter of the size.)
  const gap = size * 0.35;
  const allowed = Math.floor(ls.length * 0.1);
  const cuts: number[] = [];
  for (const side of ["start", "end"] as const) {
    const xs: number[] = [];
    for (const r of rows) for (let i = 1; i < r.length; i++) if (r[i][0] - r[i - 1][1] >= gap) xs.push(side === "start" ? r[i][0] : r[i - 1][1]);
    xs.sort((a, b) => a - b);
    for (let i = 0; i < xs.length; ) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] - xs[i] <= 1.5) j++;
      const n = j - i + 1;
      const x = xs[i + (n >> 1)];
      i = j + 1;
      if (n < Math.max(3, ls.length * 0.25)) continue;
      // The strip beside the edge: empty in (nearly) every row.
      const [lo, hi] = side === "start" ? [x - gap, x] : [x, x + gap];
      const crossed = rows.filter((r) => r.some(([a, b]) => a < hi - 0.3 && b > lo + 0.3)).length;
      if (crossed <= allowed) cuts.push(side === "start" ? x - 0.25 : x + 0.25);
    }
  }
  return cuts.sort((a, b) => a - b);
}

/**
 * Lines drawn down a table between its columns: rules at the same place (a cell's side drawn
 * row by row counts as one line) that run beside at least half the table's lines. Their places.
 */
function columnRules(vrules: Rule[], ls: Line[], x0: number, x1: number): number[] {
  if (ls.length < 2) return [];
  const mids = ls.map((l) => l.y + l.h / 2);
  const rs = vrules.filter((r) => r.x > x0 - 16 && r.x < x1 + 16).sort((a, b) => a.x - b.x);
  const out: number[] = [];
  for (let i = 0; i < rs.length; ) {
    let j = i;
    while (j + 1 < rs.length && rs[j + 1].x - rs[i].x <= 1.5) j++;
    const group = rs.slice(i, j + 1);
    i = j + 1;
    const beside = mids.filter((y) => group.some((r) => y >= r.y && y <= r.y + r.h)).length;
    if (beside >= Math.max(2, ls.length * 0.5)) out.push(group[0].x + group[0].w / 2);
  }
  return out;
}

/** Columns: horizontal ranges covered by text, separated by empty gutters. */
function bandsOf(segs: Segment[], hard: number[] = []): Band[] {
  const out: Band[] = [];
  for (const sg of [...segs].sort((a, b) => a.x - b.x)) {
    const last = out[out.length - 1];
    // Text that nearly touches is one column, unless a column's edge was found between.
    if (last && sg.x <= last.x1 + 3 && !(sg.x > last.x1 && hard.some((x) => x > last.x1 - 0.5 && x < sg.x + 0.5))) last.x1 = Math.max(last.x1, sg.x2);
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
function cellOf(parts: Placed[], fill?: string, limit?: number): Cell {
  const paras: { runs: Run[]; last: Placed; lines: number; top: number; bottom: number; bases: number[]; size: number }[] = [];
  // A line that stops short of the column's edge by more than the next line's first word was broken there on purpose.
  const edge = Math.max(limit ?? -Infinity, ...parts.map((p) => p.x2));
  const early = (prev: Placed, p: Placed) => {
    const first = p.items.find((it) => it.str.trim());
    if (!first || /[-\u00ad]$/.test(prev.text)) return false;
    const str = first.str.trimStart();
    return edge - prev.x2 > (first.w * str.split(/\s/)[0].length) / (str.length || 1) + p.size * 0.3 + 1;
  };
  for (const p of parts.sort((a, b) => a.base - b.base || a.x - b.x)) {
    const runs = itemsRuns(p.items as Item[]);
    const prev = paras[paras.length - 1];
    if (prev) {
      const sameLine = Math.abs(p.base - prev.last.base) < Math.max(2, p.size * 0.3);
      const gap = p.y - (prev.last.y + prev.last.h);
      const styleBreak = (prev.lines === 1 && prev.last.bold !== p.bold && runsText(prev.runs).length < 40) || p.span || prev.last.span;
      if (sameLine || (Math.abs(p.size - prev.last.size) <= 0.8 && gap < p.h * 0.9 && !styleBreak)) {
        if (!sameLine && early(prev.last, p)) breakRuns(prev.runs, runs);
        else joinRuns(prev.runs, runs);
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
  const hr = (ctx?.hrules ?? []).filter((r) => !ctx?.used?.has(r.src ?? r));
  // A rule drawn across the whole gap between two lines (one under a group of columns in a
  // grouped header doesn't end the row: the cell beside it carries on).
  const ruleBetween = (a: Line, b: Line, x0: number, x1: number) => {
    const span = hr.filter((r) => r.y >= a.y + a.h * 0.5 && r.y + r.h <= b.y + b.h * 0.5).filter((r) => r.x < x1 && r.x + r.w > x0);
    const cover = span.reduce((n, r) => n + Math.min(r.x + r.w, x1) - Math.max(r.x, x0), 0);
    return span.length && cover >= (x1 - x0) * 0.9 ? span : null;
  };
  // A line set across the whole table: a group's name on a band shaded the table's width, or
  // between the lines drawn down the table's sides.
  const acrossTable = (l: Line, x0: number, x1: number) => {
    const inside = (r: Rect) => r.y <= l.y + l.h * 0.3 && r.y + r.h >= l.y + l.h * 0.7;
    if (ctx?.fills.some((f) => inside(f) && f.x <= x0 + 2 && f.x + f.w >= x1 - 2 && f.w < (x1 - x0) * 1.6)) return true;
    const vr = (ctx?.vrules ?? []).filter(inside);
    return vr.some((r) => r.x <= x0 + 1 && r.x >= x0 - 16) && vr.some((r) => r.x + r.w >= x1 - 1 && r.x <= x1 + 16);
  };
  // 1. Grow the region: lines with several cells, plus lone lines that sit inside one column.
  const region = [start];
  let bottom = lines[start].y + lines[start].h;
  let left = segs[start][0].x;
  let right = segs[start][segs[start].length - 1].x2;
  const multi = () => region.filter((k) => segs[k].length >= 2);
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j];
    let sg = segs[j];
    if (!sg.length) break;
    const m = multi();
    // A row whose cells sit so close it reads as one piece: cut where its items begin at the
    // columns' starts.
    if (sg.length === 1 && sg[0].items.length >= 2) {
      const inner = sharedStarts(m.map((k) => segs[k].slice(1)), 1);
      const parts = splitBetween(sg[0], inner.filter((x) => sg[0].items.some((it, n) => n > 0 && Math.abs(it.x - x) <= 1.5)).map((x) => x - 0.25));
      if (parts.length >= 2) segs[j] = sg = parts;
    }
    const lineH = median(m.map((k) => lines[k].h));
    // Rules between the lines (even with gaps, like signature lines in two columns) allow a wider gap.
    const ruled = hr.some((r) => r.y >= lines[j - 1].y + lines[j - 1].h * 0.5 && r.y + r.h <= l.y + l.h * 0.5 && Math.min(r.x + r.w, right) - Math.max(r.x, left) > (right - left) * 0.3);
    if (l.y - bottom > lineH * (ruled ? 4.5 : 2.6)) break;
    if (ctx ? sg.length === 1 && domOf(l) >= ctx.body * 1.25 : l.size > median(m.map((k) => lines[k].size)) * 1.35) break;
    // A numbered item (its number, its text, perhaps marks set flush right) starts a list, not a row.
    if (ctx?.x1 !== undefined && sg.length >= 2 && sg.length <= 3 && /^(\(?\d{1,3}[.)]|\(?[a-z][.)]|\d{1,3}(\.\d{1,3})+\.?)$/i.test(sg[0].text) && (sg.length === 2 || ctx.x1 - sg[2].x2 < 3)) break;
    if (sg.length < 2) {
      const s0 = sg[0];
      // (Where the columns after the first start: a row's first piece may sit indented in the first column.)
      const inner = sharedStarts(m.map((k) => segs[k].slice(1)), 1);
      if (inner.some((x) => x > s0.x + 6 && x < s0.x2 - 6) && !(m.length >= 2 && acrossTable(l, left, right))) break;
      // A bulleted or numbered line starts a list; a bold line among plain rows heads what follows.
      const lead = s0.text.split(" ")[0];
      if (BULLETS.test(lead) || /^(\(?\d{1,3}[.)]|\(?[a-z][.)])$/i.test(lead) || ctx?.marks?.some((mk) => mk.x + mk.w <= s0.x + 1 && s0.x - (mk.x + mk.w) < l.size * 2.5 && mk.y + mk.h >= l.y && mk.y <= l.y + l.h)) break;
      if ((l as SLine).bold && s0.text.length < 60 && !/[.,;:]$/.test(s0.text) && m.every((k) => !lines[k].bold)) break;
      if (s0.x < left - 8) {
        // Left of everything so far: only a row label under a grouped header (the rows below start here too).
        const below = lines.slice(j + 1, j + 5).filter((nl, n) => segs[j + 1 + n].length >= 2 && nl.y - (l.y + l.h) < lineH * 4);
        if (!below.some((nl) => Math.abs(segments(nl)[0].x - s0.x) <= 12)) break;
        left = s0.x;
      }
    } else {
      // A row whose cells start where none of the rows so far do begins another table.
      const known = sharedStarts(m.map((k) => segs[k]), 1);
      const matches = sg.filter((s) => known.some((x) => Math.abs(x - s.x) <= 10) || known.some((x, n) => n > 0 && s.x > known[n - 1] && s.x2 >= x - 4 && s.x2 < x + 40)).length;
      if (m.length >= 2 && matches < Math.min(sg.length, 2)) break;
      // More cells than the rows so far, starting where none of theirs do (one at most lines up):
      // another table's header.
      const strong = sg.filter((x) => known.some((k) => Math.abs(k - x.x) <= 10)).length;
      if (m.length >= 2 && ((sg.length >= Math.max(...m.map((k) => segs[k].length)) + 2 && matches * 2 < sg.length) || (sg.length >= 3 && sg.length > median(m.map((k) => segs[k].length)) && strong <= 1))) break;
      left = Math.min(left, sg[0].x);
      right = Math.max(right, sg[sg.length - 1].x2);
    }
    region.push(j);
    bottom = Math.max(bottom, l.y + l.h);
  }
  const multiLines = multi();
  if (multiLines.length < 2) return null;
  // Text with a short piece set flush right on each line (titles and dates, labels and amounts) is tabbed text, not a table.
  if (ctx?.x1 !== undefined && ctx.x0 !== undefined) {
    const width = ctx.x1 - ctx.x0;
    const tabbed = (k: number) => {
      const sg = segs[k];
      const last = sg[sg.length - 1];
      return sg.length === 2 && ctx.x1! - last.x2 < Math.max(3, lines[k].size * 0.4) && last.x - sg[0].x2 >= lines[k].size * 2 && last.x2 - last.x <= width * 0.4;
    };
    if (multiLines.every(tabbed) && !ruleBetween(lines[multiLines[0]], lines[multiLines[multiLines.length - 1]], left, right)) return null;
  }

  // 2. Columns.
  const starts = sharedStarts(multiLines.map((k) => segs[k]), 2);
  // Cells the PDF reader ran together: cut where other lines (a header, a wrapped line) show a column's edge.
  const edgeStarts = sharedStarts(region.map((k) => segs[k].slice(1).concat(segs[k].length === 1 && segs[k][0].x > left + 4 ? segs[k] : [])), 1);
  const ends = sharedEnds(region.map((k) => segs[k]), 2);
  const tight = tightCuts(region.map((k) => lines[k]));
  const own = new Map<number, Segment[]>(
    region.map((k) => {
      const cut = segs[k].flatMap((sg) => {
        const parts = sg.items.map((it) => cutAtColumns(it, edgeStarts, ends, tight));
        const n = parts.reduce((a, p) => a + p.length - 1, 0);
        // (A line in one piece cut once may be a heading across the table whose words happen to
        // line up with a column; a row of cells run together lines up more than once.)
        if (!n || (segs[k].length === 1 && n < 2)) return [sg];
        return splitBetween(segmentOf(parts.flat()), parts.flatMap((p) => p.slice(1).map((it) => it.x - 0.25)));
      });
      return [k, cut];
    }),
  );
  // Column edges found between pieces that nearly touch.
  const hard = [...tight, ...[...own.values()].flatMap((sgs) => sgs.slice(1).map((sg, n) => (sgs[n].x2 + sg.x) / 2).filter((x, n) => sgs[n + 1].x - sgs[n].x2 <= 3))];
  const pieces = new Map<number, Segment[]>(region.map((k) => [k, own.get(k)!.flatMap((sg) => splitAtStarts(sg, starts)).flatMap((sg) => splitBetween(sg, tight))]));
  // Columns come from the fullest rows; other text widens them, joins none of them up
  // (a heading spanning several columns stays one cell) or adds a column of its own.
  const counts = multiLines.map((k) => pieces.get(k)!.length);
  const typical = median(counts);
  const core = multiLines.filter((k) => pieces.get(k)!.length >= typical);
  const bands = bandsOf(core.flatMap((k) => pieces.get(k)!), hard);
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
  // Where the columns are drawn, text between the same two lines is one column (a heading set
  // flush left over figures set flush right).
  const drawnEdges = columnRules(ctx?.vrules ?? [], region.map((k) => lines[k]), left, right);
  if (drawnEdges.length >= 2)
    for (let i = 0; i + 1 < bands.length; ) {
      const [a, b] = [bands[i], bands[i + 1]];
      if (drawnEdges.some((x) => x > a.x1 - 1 && x < b.x0 + 1)) i++;
      else {
        a.x1 = Math.max(a.x1, b.x1);
        bands.splice(i + 1, 1);
      }
    }
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
  // A label and its value set after a colon (Customer ID : 00418273): an entry of its own.
  const entry = (k: number) => placed.get(k)!.some((p, i, ps) => (p.band > 0 && /^:\s/.test(p.text)) || (i < ps.length - 1 && /\S:$/.test(p.text)));
  let groups: number[][] = [[region[0]]];
  region.slice(1).forEach((k, gi) => {
    const breakRow = ruledGaps.has(gi) || (cut !== null ? gaps[gi] > cut : (hasFirst(k) && !continues(k)) || entry(k));
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
  // A lone line under the table (a note or caption) is not a row, unless it sits in a column
  // like the rows above it (the last line of an address in the first column).
  const rowLike = (g: number[], prev: number[]) => {
    const gap = Math.min(...g.map((k) => lines[k].y)) - Math.max(...prev.map((k) => lines[k].y + lines[k].h));
    const usualGap = median(groups.slice(1, -1).map((h, n) => Math.min(...h.map((k) => lines[k].y)) - Math.max(...groups[n].map((k) => lines[k].y + lines[k].h))));
    const size = median(multiLines.map((k) => domOf(lines[k])));
    // Its text no wider than the column is in the rows with several cells.
    const fits = (k: number) => {
      const p = placed.get(k)![0];
      const ends = multiLines.flatMap((m) => placed.get(m)!.filter((q) => q.band === p.band).map((q) => q.x2));
      return ends.length > 0 && p.x2 <= Math.max(...ends) + 6;
    };
    return groups.length > 2 && gap <= usualGap * 1.15 + 1 && g.every((k) => Math.abs(domOf(lines[k]) - size) < 0.6 && segs[k].length === 1 && placed.get(k)!.length === 1 && fits(k));
  };
  while (groups.length > 1 && !groups[groups.length - 1].some((k) => segs[k].length >= 2) && !rowLike(groups[groups.length - 1], groups[groups.length - 2])) groups.pop();
  // A header of two tiers (a heading over each pair of columns, the columns' own headings
  // under it): the upper tier is a row of its own, so its headings can span their columns.
  let tiers = 1;
  if (groups.length > 1 && groups[0].length >= 2) {
    const g = groups[0];
    const tier = g.filter((k) => placed.get(k)!.some((p) => p.span) && g.some((j) => j !== k && lines[j].y > lines[k].y + lines[k].h * 0.5 && placed.get(j)!.some((q) => placed.get(k)!.some((p) => p.span && q.band >= p.band && q.x < p.x2))));
    if (tier.length) {
      const bottom = Math.max(...tier.map((k) => lines[k].y + lines[k].h));
      const upper = g.filter((k) => tier.includes(k) || lines[k].y + lines[k].h / 2 < bottom - lines[k].h * 0.25);
      const lower = g.filter((k) => !upper.includes(k));
      if (lower.length) {
        groups.splice(0, 1, upper, lower);
        tiers = 2;
      }
    }
  }
  if (groups.length < 2) return null;

  // 4. Cells, with any shading drawn behind them.
  // Text in a column wraps where its longest lines end (a line of one long code, which may run
  // past the column's edge, doesn't count).
  const wrapAt = bands.map((_, b) => {
    const ends = region.flatMap((k) => placed.get(k)!.filter((p) => p.band === b && !p.span && /\s/.test(p.text.trim())).map((p) => p.x2));
    return ends.length ? Math.max(...ends) : bands[b].x1;
  });
  const cells = groups.map((g) =>
    bands.map((_, b) => {
      const parts = g.flatMap((k) => placed.get(k)!.filter((p) => p.band === b));
      const fill = parts.length ? ctx?.fills.find((f) => parts.every((p) => centerIn(f, (p.x + p.x2) / 2, p.y + p.h / 2)))?.fill : undefined;
      return cellOf(parts, fill, wrapAt[b]);
    }),
  );
  const filled = cells.flat().filter((c) => c.paras.length).length;
  if (filled / (cells.length * bands.length) < 0.35) return null;
  // Text set across several columns spans them: a heading over columns, or a group's name on
  // its own band across the whole table.
  groups.forEach((g, ri) => {
    for (const p of g.flatMap((k) => placed.get(k)!)) {
      if (!p.span) continue;
      // (Columns meet halfway across the space between their text.)
      let n = 1;
      while (p.band + n < bands.length && (bands[p.band + n - 1].x1 + bands[p.band + n].x0) / 2 < p.x2 - 3) n++;
      if (n > 1 && cells[ri].slice(p.band + 1, p.band + n).every((c) => !c.paras.length)) cells[ri][p.band].span = n;
    }
    const used = cells[ri].filter((c) => c.paras.length);
    if (used.length === 1 && cells[ri][0].paras.length && g.length === 1 && acrossTable(lines[g[0]], tx0, tx1)) cells[ri][0].span = bands.length;
  });
  // Text set in the middle (or at the foot) of a row made taller by another cell.
  groups.forEach((g, ri) => {
    const all = g.flatMap((k) => placed.get(k)!);
    const top = Math.min(...all.map((p) => p.y));
    const bottom = Math.max(...all.map((p) => p.y + p.h));
    const words = all.filter((p) => !p.items.some((i) => (i as Item).pic));
    if (!words.length || bottom - top < median(words.map((p) => p.h)) * 1.8) return;
    bands.forEach((_, b) => {
      const ps = all.filter((p) => p.band === b);
      if (!ps.length) return;
      const a = Math.min(...ps.map((p) => p.y)) - top;
      const z = bottom - Math.max(...ps.map((p) => p.y + p.h));
      if (a > 3 && Math.abs(a - z) < Math.max(2.5, (bottom - top) * 0.12)) cells[ri][b].valign = "center";
      else if (a > 3 && z < 1.5) cells[ri][b].valign = "bottom";
    });
  });
  // Columns set flush right (figures) or centred: every piece of text ends (or centres) at
  // the same place while their starts wander.
  bands.forEach((_, b) => {
    // Judged on the body rows; a header cell follows when it lines up the same way.
    const pieces = (gs: number[][]) => gs.flatMap((g) => g.flatMap((k) => placed.get(k)!.filter((p) => p.band === b && !p.span)));
    const body = pieces(groups.length >= 3 ? groups.slice(1) : groups);
    if (body.length < 2) return;
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    const starts = spread(body.map((p) => p.x));
    // Figures of equal width line up both ways: then the heading over them tells (flush with
    // their start or their end); without one, figures are set flush right by convention.
    const figures = body.every((p) => /^[-+(]?[₹$€£]?\s?[\d.,]+\s?%?\)?$/.test(p.text.trim()));
    const headCell = groups.length >= 3 ? pieces(groups.slice(0, 1))[0] : undefined;
    const headLeft = !!headCell && starts < 1 && Math.abs(headCell.x - body[0].x) < 2 && Math.abs(headCell.x2 - body[0].x2) > 2;
    // Text of near-equal widths, centred under a heading of another width, is centred.
    const mids = body.map((p) => (p.x + p.x2) / 2);
    const headCentre = !!headCell && starts <= 4 && spread(mids) < 2.5 && Math.abs((headCell.x + headCell.x2) / 2 - median(mids)) < 2 && Math.abs(headCell.x - median(body.map((p) => p.x))) > 3;
    const right = !headCentre && spread(body.map((p) => p.x2)) < 2.5 && (starts > 4 || (figures && !headLeft));
    const centre = !right && spread(mids) < 2.5 && (starts > 4 || headCentre);
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
  // A header row: its text bold, every cell of it (a bold name beside a plain label is a row like the others).
  const header = head.filter((p) => p.bold).reduce((n, p) => n + p.text.length, 0) / headChars >= 0.6 && head.every((p) => p.bold);
  const gutter = bands.length > 1 ? median(bands.slice(1).map((b, k) => b.x0 - bands[k].x1)) : 0;
  const top = lines[region[0]].y;
  const bottomY = Math.max(...groups[groups.length - 1].map((k) => lines[k].y + lines[k].h));
  const end = groups[groups.length - 1][groups[groups.length - 1].length - 1] + 1;
  // Lines drawn in the PDF: a grid (ruled columns, or every cell outlined), or rules above,
  // between and below the rows, each in its own colour.
  // Lines down the sides may stand well off the text (a wide cell with its text centred).
  const within = (r: Rect) => r.y < bottomY + 2 && r.y + r.h > top - 2 && r.x + r.w > Math.min(tx0 - 12, (ctx?.x0 ?? tx0) - 4) && r.x < Math.max(tx1 + 12, (ctx?.x1 ?? tx1) + 4);
  const vr = (ctx?.vrules ?? []).filter(within);
  const ol = (ctx?.outlines ?? []).filter(within);
  // The table's edges: its outer lines down the sides, else the rules across it, else its text.
  const shade = (ctx?.fills ?? []).filter((f) => f.y < bottomY + 2 && f.y + f.h > top - lineH * 2.5 && f.x < tx1 && f.x + f.w > tx0 - 12);
  const across = [...hr.filter((r) => r.y >= top - lineH * 2.5 && r.y <= bottomY + lineH * 2.5 && r.x < tx1 && r.x + r.w > tx0 - 12), ...shade];
  const sides = [...vr, ...ol];
  const gridded = vr.length >= 2 || ol.length >= 2;
  const e0 = gridded ? Math.min(...sides.map((r) => r.x)) : across.length ? Math.min(...across.map((r) => r.x)) : tx0;
  const e1 = gridded ? Math.max(...sides.map((r) => r.x + r.w)) : across.length ? Math.max(...across.map((r) => r.x + r.w)) : tx1 + Math.min(gutter, 12);
  const inset = Math.max(0, Math.min(72, tx0 - e0));
  // Where the columns meet: at an edge drawn between them (a cell's shading or lines, a rule
  // down the side), else at the next column's text, less its padding where lines are drawn.
  const shapes = [...vr, ...ol, ...shade, ...hr.filter((r) => r.y >= top - lineH * 2.5 && r.y <= bottomY + lineH * 2.5)];
  const drawnCut = (k: number) => {
    const lo = bands[k - 1].x1 - 1;
    const hi = bands[k].x0 + 1;
    const xs = shapes.flatMap((o) => [o.x, o.x + o.w]).filter((x) => x > lo && x < hi);
    if (!xs.length) return undefined;
    const counts = new Map<number, number>();
    for (const x of xs) tally(counts, Math.round(x), 1);
    return mode(counts);
  };
  // (Only lines down the sides or shading mark cell edges; rules across rows leave the text where it starts.)
  const shaded = cells.some((row) => row.some((c) => c.fill));
  const drawnCuts = bands.slice(1).map((_, k) => (gridded || shaded ? drawnCut(k + 1) : undefined));
  const insetsDrawn = drawnCuts.flatMap((c, k) => (c !== undefined && cells.every((row) => !row[k + 1].align) ? [bands[k + 1].x0 - c] : []));
  let padX = insetsDrawn.length ? Math.min(12, Math.max(2, Math.min(...insetsDrawn))) : Math.min(10, Math.max(3, gutter / 2));
  const cuts = [e0, ...bands.slice(1).map((b, k) => drawnCuts[k] ?? b.x0 - (gridded ? padX : 0)), Math.max(e1, bands[bands.length - 1].x1)];
  // Padding no wider than leaves room for each column's widest text.
  for (let k = 0; k < bands.length; k++) padX = Math.max(1.5, Math.min(padX, (cuts[k + 1] - cuts[k] - (bands[k].x1 - bands[k].x0)) / 2 - 0.5));
  // Where the cells' edges are drawn, text that sits as far from both edges is centred, and
  // text close to the right edge is flush right (when the text alone couldn't tell).
  if (gridded) {
    bands.forEach((_, b) => {
      // (The last column's far edge unknown, its text would seem flush with it.)
      if (cells.some((row) => row[b].align) || cuts[b + 1] - bands[b].x1 < 1) return;
      const ps = groups.flatMap((g) => g.flatMap((k) => placed.get(k)!.filter((p) => p.band === b && !p.span)));
      if (!ps.length) return;
      const lg = median(ps.map((p) => p.x - cuts[b]));
      const rg = median(ps.map((p) => cuts[b + 1] - p.x2));
      const align = Math.abs(lg - rg) < 3 && lg > padX + 3 ? "center" : rg + 4 < lg && rg < padX + 4 ? "right" : undefined;
      if (align) cells.forEach((row) => row[b].text && (row[b].align = align));
    });
  }
  // Text set further in than the rest of its column (items under their group's name).
  groups.forEach((g, ri) =>
    bands.forEach((band, b) => {
      const c = cells[ri][b];
      if (!c.paras.length || c.align || c.span) return;
      const x = Math.min(...g.flatMap((k) => placed.get(k)!.filter((p) => p.band === b).map((p) => p.x)));
      const ind = x - band.x0;
      if (ind >= 4 && ind < (band.x1 - band.x0) * 0.5) c.indent = Math.round(ind * 10) / 10;
    }),
  );
  const raw = cuts.slice(1).map((c, k) => Math.max(1, c - cuts[k]));
  const total = raw.reduce((a, b) => a + b, 0);
  const floored = raw.map((w) => Math.max(w / total, 0.05));
  const sum = floored.reduce((a, b) => a + b, 0);
  const span = { x: e0 - (ctx?.x0 ?? e0), w: total };
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
  const drawn = gridded
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
  const pad = rowGaps.length ? { x: padX, y: Math.min(14, Math.max(0.3, median(rowGaps) / 2)) } : undefined;
  // Rows set further apart than usual (space left to sign in) keep their extra space.
  const extra = pad ? rowGaps.map((g) => Math.max(0, g - pad.y * 2)) : [];
  // The rules this table draws (across its columns, from just above it to just below).
  const rules = drawn.lines ? hr.filter((r) => r.y >= top - lineH * 2.5 && r.y <= bottomY + lineH * 2.5 && Math.min(r.x + r.w, tx1) - Math.max(r.x, tx0) > r.w * 0.5) : [];
  // A rule drawn in pieces (one under each cell) is the table's all along.
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of hr) {
      if (rules.includes(r) || !rules.some((o) => Math.abs(o.y - r.y) < 1 && r.x < o.x + o.w + 2 && r.x + r.w > o.x - 2)) continue;
      rules.push(r);
      grew = true;
    }
  }
  const twoTier = header && tiers === 2 && groups[1].flatMap((k) => placed.get(k)!).every((p) => p.bold) ? { head: 2 } : {};
  return { end, cells, header, ...twoTier, widths: floored.map((w) => w / sum), bands, span, pad, inset, leading: steps.length ? median(steps) : undefined, rules, ...(extra.some((e) => e > 4) ? { rowSpace: extra } : {}), ...drawn };
}

const p0size = (ps: Placed[]) => (ps.length ? median(ps.map((p) => p.size)) : 10);
