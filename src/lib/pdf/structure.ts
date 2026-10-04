/**
 * Recover document structure from positioned PDF text: headings, paragraphs,
 * bullet/numbered lists and tables, with running headers, footers and page
 * numbers removed. Used by PDF → Word / HTML / EPUB / Markdown / Excel.
 */
import { toLines, type Line, type PageText, type TextItem } from "./pdfjs";

export type Run = { text: string; bold: boolean; italic: boolean };
export type SBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string; page: number }
  | { kind: "para"; runs: Run[]; page: number; align?: "left" | "center" | "right" }
  | { kind: "list"; ordered: boolean; items: Run[][]; page: number }
  | { kind: "table"; rows: string[][]; page: number }
  | { kind: "pagebreak"; page: number };

export type Segment = { text: string; x: number; x2: number; items: TextItem[] };

/** Split a line into cells wherever there is a wide horizontal gap. */
export function segments(line: Line): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | null = null;
  for (const it of line.items) {
    if (!it.str.trim()) continue;
    const gapLimit = Math.max(it.fontSize * 1.3, 9);
    if (cur && it.x - cur.x2 <= gapLimit) {
      const needsSpace = it.x - cur.x2 > it.fontSize * 0.18 && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
      cur.text += (needsSpace ? " " : "") + it.str;
      cur.x2 = Math.max(cur.x2, it.x + it.w);
      cur.items.push(it);
    } else {
      cur = { text: it.str, x: it.x, x2: it.x + it.w, items: [it] };
      out.push(cur);
    }
  }
  for (const s of out) s.text = s.text.replace(/\s+/g, " ").trim();
  return out.filter((s) => s.text);
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

export function toGrid(rows: Segment[][], cols: number[], tol = 10): string[][] {
  return rows.map((r) => {
    const cells = new Array(cols.length).fill("");
    for (const s of r) {
      let ci = 0;
      for (let k = 0; k < cols.length; k++) if (cols[k] <= s.x + tol) ci = k;
      cells[ci] = cells[ci] ? `${cells[ci]} ${s.text}` : s.text;
    }
    return cells;
  });
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
      // Table: two or more consecutive multi-cell rows that share columns.
      if (segs[i].length >= 2) {
        let j = i;
        while (j < lines.length && segs[j].length >= 2 && (j === i || lines[j].y - (lines[j - 1].y + lines[j - 1].h) < lines[j].h * 2.2)) j++;
        // Allow trailing summary rows with fewer cells (e.g. "Total  40197.50") to join.
        if (j - i >= 2) {
          const rows = segs.slice(i, j);
          const cols = columnStarts(rows);
          const aligned = rows.filter((r) => r.every((s) => cols.some((c) => Math.abs(c - s.x) < 12))).length;
          if (cols.length >= 2 && cols.length <= 20 && aligned / rows.length >= 0.7) {
            flushPara();
            flushList();
            out.push({ kind: "table", rows: toGrid(rows, cols), page: pi });
            i = j;
            continue;
          }
        }
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
    if (segs[i].length >= 2) {
      let j = i;
      while (j < lines.length && segs[j].length >= 1 && (j === i || lines[j].y - (lines[j - 1].y + lines[j - 1].h) < lines[j].h * 2.2) && (segs[j].length >= 2 || j > i)) {
        if (segs[j].length < 2 && j > i) {
          // A single-cell line inside a table run only continues it if it aligns with a later column.
          const cols = columnStarts(segs.slice(i, j));
          if (!cols.slice(1).some((c) => Math.abs(c - segs[j][0].x) < 12)) break;
        }
        j++;
      }
      if (j - i >= 2) {
        const cols = columnStarts(segs.slice(i, j));
        rows.push(...toGrid(segs.slice(i, j), cols));
        i = j;
        continue;
      }
    }
    rows.push([lines[i].text]);
    i++;
  }
  return rows;
}
