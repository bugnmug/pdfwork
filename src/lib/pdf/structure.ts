/**
 * Recover document structure from positioned PDF text: headings, paragraphs,
 * bullet/numbered lists and tables, with running headers, footers and page
 * numbers removed. Used by PDF → Word / HTML / EPUB / Markdown / Excel.
 */
import { toLines, type Line, type PageText, type TextItem } from "./pdfjs";

export type Run = { text: string; bold: boolean; italic: boolean };
/** One table cell: its paragraphs (each a list of styled runs) and the plain text. */
export type Cell = { paras: Run[][]; text: string };
export type SBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string; page: number }
  | { kind: "para"; runs: Run[]; page: number; align?: "left" | "center" | "right" }
  | { kind: "list"; ordered: boolean; items: Run[][]; page: number }
  | {
      kind: "table";
      /** Plain text of each cell; paragraphs inside a cell are separated by "\n". */
      rows: string[][];
      cells: Cell[][];
      /** The first row is a header row. */
      header: boolean;
      /** Relative column widths, summing to 1. */
      widths: number[];
      page: number;
    }
  | { kind: "pagebreak"; page: number };

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


const normalize = (s: string) => s.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

/** Lines that repeat at the top or bottom of many pages (running heads, page numbers). */
function furniture(pages: { lines: Line[]; height: number }[]): Set<string> {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const edge = p.lines.filter((l) => l.y < p.height * 0.1 || l.y + l.h > p.height * 0.9);
    for (const key of new Set(edge.map((l) => normalize(l.text)))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const min = Math.max(3, Math.ceil(pages.length * 0.5));
  const out = new Set<string>();
  for (const [k, n] of counts) if (n >= min || /^(page )?#( (of|\/) #)?$/.test(k) || /^- # -$/.test(k)) out.add(k);
  return out;
}

const BULLET = /^([•●▪■◦○‣∙·\-–—*➢►✓✔])\s+/;
const NUMBERED = /^(\(?(\d{1,3}|[a-z]|[ivxlc]{1,5})[.)])\s+/i;

export function analyze(pagesText: PageText[]): SBlock[] {
  const pages = pagesText.map((p) => {
    const all = toLines(p);
    const dir = all[0]?.dir;
    return { lines: all.filter((l) => l.dir === dir), height: p.height, width: p.width, page: p.page };
  });
  const skip = pages.length >= 3 ? furniture(pages) : new Set<string>();
  // Body size: the most common size weighted by characters.
  const sizeHist = new Map<number, number>();
  for (const p of pages) for (const l of p.lines) sizeHist.set(Math.round(l.size * 2) / 2, (sizeHist.get(Math.round(l.size * 2) / 2) ?? 0) + l.text.length);
  const body = [...sizeHist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;

  const out: SBlock[] = [];
  pages.forEach((p, pi) => {
    if (pi > 0) out.push({ kind: "pagebreak", page: pi });
    const lines = p.lines.filter((l) => !(skip.has(normalize(l.text)) && (l.y < p.height * 0.1 || l.y + l.h > p.height * 0.9)));
    const segs = lines.map(segments);
    let i = 0;
    let para: { runs: Run[]; last: Line; page: number } | null = null;
    let list: { ordered: boolean; items: Run[][]; last: Line; indent: number; page: number } | null = null;
    const flushPara = () => {
      if (para) out.push({ kind: "para", runs: mergeRuns(para.runs), page: para.page });
      para = null;
    };
    const flushList = () => {
      if (list) out.push({ kind: "list", ordered: list.ordered, items: list.items.map(mergeRuns), page: list.page });
      list = null;
    };
    while (i < lines.length) {
      const l = lines[i];
      const t = findTable(lines, segs, i);
      if (t) {
        flushPara();
        flushList();
        out.push({ kind: "table", rows: t.cells.map((r) => r.map((c) => c.text)), cells: t.cells, header: t.header, widths: t.widths, page: pi });
        i = t.end;
        continue;
      }
      const text = l.text;
      const ratio = l.size / body;
      const short = text.length < 120;
      const level = ratio >= 1.6 ? 1 : ratio >= 1.25 ? 2 : (ratio >= 1.08 || (l.bold && text.length < 70 && !/[.:,;]$/.test(text))) && short ? 3 : 0;
      if (level && short && !BULLET.test(text)) {
        flushPara();
        flushList();
        // Join a heading that wraps onto a second line of the same size.
        const prev = out[out.length - 1];
        if (prev?.kind === "heading" && prev.level === level && i > 0 && l.y - (lines[i - 1].y + lines[i - 1].h) < l.h * 0.8) prev.text += " " + text;
        else out.push({ kind: "heading", level: level as 1 | 2 | 3, text, page: pi });
        i++;
        continue;
      }
      const runs = lineRuns(l);
      const bm = text.match(BULLET);
      const nm = text.match(NUMBERED);
      if (bm || (nm && (list?.ordered || /^\(?\d/.test(nm[1]) || /^[a-z][.)]/i.test(nm[1])))) {
        flushPara();
        const ordered = !bm;
        const marker = (bm ?? nm)![0];
        const first = stripPrefix(runs, marker.length);
        if (list && list.ordered === ordered) list.items.push(first);
        else {
          flushList();
          list = { ordered, items: [first], last: l, indent: l.x, page: pi };
        }
        list.last = l;
        i++;
        continue;
      }
      if (list) {
        const gap = l.y - (list.last.y + list.last.h);
        if (l.x > list.indent + 4 && gap < l.h * 0.8) {
          const item = list.items[list.items.length - 1];
          joinRuns(item, runs);
          list.last = l;
          i++;
          continue;
        }
        flushList();
      }
      if (para) {
        const gap = l.y - (para.last.y + para.last.h);
        const sameSize = Math.abs(l.size - para.last.size) < 0.6;
        const indented = l.x - para.last.x > l.size * 1.5;
        const prevShort = para.last.x + para.last.w < p.width * 0.55 && /[.!?:]$/.test(para.last.text);
        if (gap < l.h * 0.75 && sameSize && !indented && !prevShort) {
          joinRuns(para.runs, runs);
          para.last = l;
          i++;
          continue;
        }
        flushPara();
      }
      para = { runs, last: l, page: pi };
      i++;
    }
    flushPara();
    flushList();
  });
  return out;
}

function lineRuns(l: Line): Run[] {
  const runs: Run[] = [];
  let prevEnd = -Infinity;
  for (const it of l.items) {
    if (!it.str) continue;
    const gap = it.x - prevEnd;
    let text = it.str;
    if (runs.length && gap > it.fontSize * 0.18 && !/\s$/.test(runs[runs.length - 1].text) && !/^\s/.test(text)) text = " " + text;
    const last = runs[runs.length - 1];
    if (last && last.bold === it.bold && last.italic === it.italic) last.text += text;
    else runs.push({ text, bold: it.bold, italic: it.italic });
    prevEnd = it.x + it.w;
  }
  for (const r of runs) r.text = r.text.replace(/\s+/g, " ");
  if (runs.length) runs[0].text = runs[0].text.trimStart();
  return runs;
}

function stripPrefix(runs: Run[], n: number): Run[] {
  const out = runs.map((r) => ({ ...r }));
  let left = n;
  while (left > 0 && out.length) {
    if (out[0].text.length <= left) {
      left -= out[0].text.length;
      out.shift();
    } else {
      out[0].text = out[0].text.slice(left).trimStart();
      left = 0;
    }
  }
  return out;
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
    if (last && last.bold === r.bold && last.italic === r.italic) last.text += r.text;
    else out.push({ ...r });
  }
  for (const r of out) r.text = r.text.replace(/\s+/g, " ");
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.trimEnd();
  return out.filter((r) => r.text);
}

export const runsText = (runs: Run[]) => runs.map((r) => r.text).join("");

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

/* --------------------------------------------------------------- tables */

const median = (a: number[]) => {
  if (!a.length) return 0;
  const v = [...a].sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)];
};

type Band = { x0: number; x1: number };
/** A piece of text placed in a column; `span` marks a heading that stretches over several columns. */
type Placed = Segment & { y: number; h: number; base: number; size: number; bold: boolean; band: number; span: boolean };
type TableHit = { end: number; cells: Cell[][]; header: boolean; widths: number[] };

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
  const chars = sg.items.reduce((n, i) => n + i.str.length, 0) || 1;
  return {
    ...sg,
    band,
    span,
    y,
    h: Math.max(...sg.items.map((i) => i.y + i.h)) - y,
    base: sg.items.reduce((n, i) => n + i.base, 0) / sg.items.length,
    size: sg.items.reduce((n, i) => n + i.fontSize * i.str.length, 0) / chars,
    bold: sg.items.filter((i) => i.bold).reduce((n, i) => n + i.str.length, 0) / chars > 0.6,
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

/** Turn a cell's text pieces (top to bottom) into paragraphs of styled runs. */
function cellOf(parts: Placed[]): Cell {
  const paras: { runs: Run[]; last: Placed; lines: number }[] = [];
  for (const p of parts.sort((a, b) => a.base - b.base || a.x - b.x)) {
    const runs = segmentRuns(p);
    const prev = paras[paras.length - 1];
    if (prev) {
      const sameLine = Math.abs(p.base - prev.last.base) < Math.max(2, p.size * 0.3);
      const gap = p.y - (prev.last.y + prev.last.h);
      const styleBreak = (prev.lines === 1 && prev.last.bold !== p.bold && runsText(prev.runs).length < 40) || p.span || prev.last.span;
      if (sameLine || (Math.abs(p.size - prev.last.size) <= 0.8 && gap < p.h * 0.9 && !styleBreak)) {
        joinRuns(prev.runs, runs);
        prev.last = p;
        if (!sameLine) prev.lines++;
        continue;
      }
    }
    paras.push({ runs, last: p, lines: 1 });
  }
  const out = paras.map((p) => mergeRuns(p.runs)).filter((r) => r.length);
  return { paras: out, text: out.map(runsText).join("\n") };
}

function segmentRuns(sg: Segment): Run[] {
  const runs: Run[] = [];
  let prevEnd = -Infinity;
  for (const it of sg.items) {
    let text = it.str;
    if (runs.length && it.x - prevEnd > it.fontSize * 0.18 && !/\s$/.test(runs[runs.length - 1].text) && !/^\s/.test(text)) text = " " + text;
    const last = runs[runs.length - 1];
    if (last && last.bold === it.bold && last.italic === it.italic) last.text += text;
    else runs.push({ text, bold: it.bold, italic: it.italic });
    prevEnd = it.x + it.w;
  }
  for (const r of runs) r.text = r.text.replace(/\s+/g, " ");
  if (runs.length) runs[0].text = runs[0].text.trimStart();
  return runs;
}

/**
 * A table starting at line `start`, if there is one. Columns come from the gutters
 * between text; rows from the spacing between lines (cell padding) or, in tightly
 * set tables, from a new entry in the first column. Wrapped text stays in its cell.
 */
export function findTable(lines: Line[], segs: Segment[][], start: number): TableHit | null {
  if (segs[start].length < 2) return null;
  // 1. Grow the region: lines with several cells, plus lone lines that sit inside one column.
  const region = [start];
  let bottom = lines[start].y + lines[start].h;
  let left = segs[start][0].x;
  const multi = () => region.filter((k) => segs[k].length >= 2);
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j];
    const sg = segs[j];
    if (!sg.length) break;
    const m = multi();
    const lineH = median(m.map((k) => lines[k].h));
    if (l.y - bottom > lineH * 2.6) break;
    if (l.size > median(m.map((k) => lines[k].size)) * 1.35) break;
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
    } else left = Math.min(left, sg[0].x);
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

  // 3. Rows.
  const lineH = median(region.map((k) => lines[k].h));
  const gaps: number[] = [];
  let low = lines[region[0]].y + lines[region[0]].h;
  for (const k of region.slice(1)) {
    gaps.push(Math.max(0, lines[k].y - low));
    low = Math.max(low, lines[k].y + lines[k].h);
  }
  const cut = rowGapThreshold(gaps, lineH);
  const hasFirst = (k: number) => placed.get(k)!.some((p) => p.band === 0);
  let groups: number[][] = [[region[0]]];
  region.slice(1).forEach((k, gi) => {
    const breakRow = cut !== null ? gaps[gi] > cut : hasFirst(k);
    if (breakRow) groups.push([k]);
    else groups[groups.length - 1].push(k);
  });
  // Padded tables whose rows are single lines anyway, apart from a gap under the header:
  // if nearly every following line starts a new entry, each line is its own row.
  if (cut !== null) {
    groups = groups.flatMap((g) => {
      const rest = g.slice(1);
      const full = rest.filter((k) => hasFirst(k) && segs[k].length >= 2).length;
      return rest.length >= 2 && full / rest.length >= 0.8 ? g.map((k) => [k]) : [g];
    });
  }
  // A lone line under the table (a note or caption) is not a row.
  while (groups.length > 1 && !groups[groups.length - 1].some((k) => segs[k].length >= 2)) groups.pop();
  if (groups.length < 2) return null;

  // 4. Cells.
  const cells = groups.map((g) =>
    bands.map((_, b) => cellOf(g.flatMap((k) => placed.get(k)!.filter((p) => p.band === b)))),
  );
  const filled = cells.flat().filter((c) => c.text).length;
  if (filled / (cells.length * bands.length) < 0.35) return null;
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
  return { end, cells, header, widths: floored.map((w) => w / sum) };
}
