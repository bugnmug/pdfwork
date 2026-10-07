/**
 * Cuts the laid-out document into pages. Every place a page may end is a
 * candidate (between blocks, between lines, between table rows, between
 * lines inside a row); keep-with-next, keep-lines, widow control and rows
 * that cannot split make candidates "soft" (used only if nothing else fits),
 * page and column breaks force them. A page skips the white space at a break,
 * so a paragraph's space before is not repeated at the top of the next page.
 */
import type { Line, MBlock, Measured } from "./measure";
import type { Section } from "./model";

export type Cand = { y: number; next: number; soft: boolean; forced?: "page" | "column"; band?: { top: number; bottom: number } };

export function candidates(m: Measured): Cand[] {
  const out: Cand[] = [];
  walk(m.blocks, out, undefined);
  const hard = m.hard;
  const ok = out.filter((c) => !hard.some((h) => h.top + 0.5 < c.y && c.y < h.bottom - 0.5));
  return ok.sort((a, b) => a.y - b.y || (a.forced ? -1 : 0));
}

function walk(blocks: MBlock[], out: Cand[], band: Cand["band"]) {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (i > 0) {
      const a = blocks[i - 1];
      const before = a.kind === "p" ? a.info.breakAfter : a.kind === "group" ? lastPara(a)?.info.breakAfter : undefined;
      const forced = before ?? (b.kind === "p" ? (b.info.brk ?? (b.info.pageBreakBefore ? "page" : undefined)) : undefined);
      const soft = (a.kind === "p" && a.info.keepNext) || (a.kind === "group" && lastPara(a)?.info.keepNext === true);
      // "Page break before" keeps the paragraph's space before; other breaks drop it.
      const next = b.kind === "p" && b.info.pageBreakBefore && !before && !b.info.brk ? b.top - b.info.before : b.top;
      out.push({ y: a.bottom, next, soft: !!soft, forced, band });
    }
    inner(b, out, band);
  }
}

function lastPara(b: MBlock): Extract<MBlock, { kind: "p" }> | undefined {
  if (b.kind === "p") return b;
  if (b.kind === "group") return b.children.length ? lastPara(b.children[b.children.length - 1]) : undefined;
  return undefined;
}

function inner(b: MBlock, out: Cand[], band: Cand["band"]) {
  if (b.kind === "p") {
    const n = b.lines.length;
    for (let k = 1; k < n; k++) {
      const soft = b.info.keepLines || (b.info.widow && (k === 1 || k === n - 1));
      out.push({ y: b.lines[k].top, next: b.lines[k].top, soft, band });
    }
  } else if (b.kind === "group") walk(b.children, out, band);
  else if (b.kind === "table") {
    let headers = 0;
    while (headers < b.rows.length && b.rows[headers].header) headers++;
    const tBand = headers && headers < b.rows.length ? { top: b.rows[0].top, bottom: b.rows[headers - 1].bottom } : band;
    b.rows.forEach((row, r) => {
      if (r > 0) out.push({ y: b.rows[r - 1].bottom, next: row.top, soft: r <= headers, band: r > headers ? tBand : band });
      if (row.cantSplit || r < headers) return;
      // Inside a row: only where no cell has a line running across.
      const lines: Line[] = [];
      const cand: Cand[] = [];
      for (const cell of row.cells) {
        collectLines(cell.blocks, lines);
        walk(cell.blocks, cand, tBand);
      }
      for (const c of cand) {
        if (c.forced) continue;
        if (lines.some((l) => l.top + 0.3 < c.y && c.y < l.bottom - 0.3)) continue;
        out.push({ y: c.y, next: c.y, soft: c.soft, band: r >= headers ? tBand : band });
      }
    });
  }
}

function collectLines(blocks: MBlock[], out: Line[]) {
  for (const b of blocks) {
    if (b.kind === "p") out.push(...b.lines);
    else if (b.kind === "group") collectLines(b.children, out);
    else if (b.kind === "table") for (const r of b.rows) for (const c of r.cells) collectLines(c.blocks, out);
    else if (b.kind === "draw") out.push({ top: b.top, bottom: b.bottom });
  }
}

/** The next cut: a forced break if one comes before the limit, else the lowest cut that fits. */
export function nextCut(cands: Cand[], pos: number, limit: number, end: number): Cand | null {
  const fits = (c: Cand) => c.y > pos + 0.5 && c.y <= limit + 0.01;
  const forced = cands.find((c) => c.forced && c.y > pos + 0.01 && c.y <= Math.min(limit, end) + 0.01);
  if (forced) return forced;
  if (end <= limit + 0.01) return null;
  let best: Cand | null = null;
  for (const c of cands) if (!c.soft && fits(c)) best = c;
  if (!best) for (const c of cands) if (fits(c)) best = c;
  return best ?? { y: limit, next: limit, soft: true };
}

/* ------------------------------------------------------------------ pages */

export type Chunk = { m: number; y0: number; y1: number; x: number; y: number; w: number; band?: { top: number; bottom: number; y: number } };
export type Page = {
  sect: number;
  w: number;
  h: number;
  chunks: Chunk[];
  notes: string[];
  firstOfSection: boolean;
  /** Page number as printed (restarts per section when the section asks). */
  num: number;
  fmt: string;
  variant: "first" | "even" | "default";
  bodyTop: number;
  bodyBottom: number;
  colX: number[];
  colW: number[];
  /** Total pages and the section's own count (filled in at the end). */
  total?: number;
  sectionPages?: number;
};

export type SectionFlow = {
  sect: Section;
  m: number; // measured container index
  measured: Measured;
  /** Header/footer height per variant (points). */
  header: Record<"first" | "even" | "default", number>;
  footer: Record<"first" | "even" | "default", number>;
};

export type PaginateOpts = {
  evenAndOdd: boolean;
  noteHeight: (key: string) => number;
  separator: number;
};

export function columnsOf(s: Section): { x: number[]; w: number[] } {
  const body = s.pageW - s.margin.left - s.margin.right;
  const n = Math.max(1, s.cols.num);
  if (n === 1) return { x: [s.margin.left], w: [body] };
  if (!s.cols.equal && s.cols.widths?.length === n) {
    const x: number[] = [];
    let cx = s.margin.left;
    for (const c of s.cols.widths) {
      x.push(cx);
      cx += c.w + c.space;
    }
    return { x, w: s.cols.widths.map((c) => c.w) };
  }
  const w = (body - s.cols.space * (n - 1)) / n;
  return { x: Array.from({ length: n }, (_, i) => s.margin.left + i * (w + s.cols.space)), w: Array(n).fill(w) };
}

export function paginate(flows: SectionFlow[], o: PaginateOpts): Page[] {
  const pages: Page[] = [];
  let page: Page | null = null;
  let col = 0;
  let cursor = 0;
  /** Where the current section's columns start on the current page. */
  let secTop = 0;
  let notesH = 0;
  let pageNo = 0;

  const variantOf = (si: number, first: boolean, num: number): Page["variant"] => {
    const s = flows[si].sect;
    if (first && s.titlePg) return "first";
    if (o.evenAndOdd && num % 2 === 0) return "even";
    return "default";
  };

  const newPage = (si: number, first: boolean) => {
    const f = flows[si];
    const s = f.sect;
    if (first && s.pgNumStart !== undefined) pageNo = s.pgNumStart - 1;
    pageNo++;
    const variant = variantOf(si, first, pageNo);
    const cols = columnsOf(s);
    // A header taller than the top margin pushes the text down, as in Word.
    const top = Math.max(s.margin.top, s.margin.header + f.header[variant]);
    const bottom = Math.min(s.pageH - s.margin.bottom, s.pageH - s.margin.footer - f.footer[variant]);
    const pg: Page = { sect: si, w: s.pageW, h: s.pageH, chunks: [], notes: [], firstOfSection: first, num: pageNo, fmt: s.pgNumFmt ?? "decimal", variant, bodyTop: top, bodyBottom: Math.max(top + 36, bottom), colX: cols.x, colW: cols.w };
    pages.push(pg);
    page = pg;
    col = 0;
    cursor = pg.bodyTop;
    secTop = pg.bodyTop;
    notesH = 0;
  };

  const notesHeight = (keys: string[], fresh: boolean) => keys.reduce((h, k) => h + o.noteHeight(k), 0) + (keys.length && fresh ? o.separator : 0);

  flows.forEach((f, si) => {
    const s = f.sect;
    const m = f.measured;
    const cands = candidates(m);
    const end = Math.max(0, ...m.blocks.map((b) => b.bottom));
    const p0 = page as Page | null;
    const sameSize = !!p0 && Math.abs(p0.w - s.pageW) < 1 && Math.abs(p0.h - s.pageH) < 1;
    if (!p0 || !(s.type === "continuous" || s.type === "nextColumn") || !sameSize) {
      if (p0 && (s.type === "oddPage" || s.type === "evenPage")) {
        // Word inserts a blank page to land on the right side.
        const nextNo = s.pgNumStart ?? pageNo + 1;
        if ((nextNo % 2 === 1) !== (s.type === "oddPage")) newPage(si, false);
      }
      newPage(si, true);
    } else {
      // Continuous: the new section starts below what is already on the page, in its own columns.
      const cols = columnsOf(s);
      p0.colX = cols.x;
      p0.colW = cols.w;
      col = 0;
      secTop = cursor;
    }
    // A section starts with its first paragraph's space before, as Word does.
    let pos = 0;
    let guard = 0;
    while (pos < end - 0.5 && guard++ < 20000) {
      const pg = page as unknown as Page;
      const start = cursor;
      const room = pg.bodyBottom - cursor - notesH;
      let cut = nextCut(cands, pos, pos + room, end);
      let mine: string[] = [];
      // Footnotes referenced in this stretch take room at the foot of the page; settle in a few rounds.
      for (let round = 0; round < 6; round++) {
        const y1 = cut ? cut.y : end;
        const refs = [...new Set(m.notes.filter((n) => n.y >= pos && n.y < y1 && !pg.notes.includes(n.name)).map((n) => n.name))];
        const same = refs.length === mine.length && refs.every((k) => mine.includes(k));
        mine = refs;
        if (same && round > 0) break;
        const need = notesHeight(refs, pg.notes.length === 0);
        if (!need) break;
        cut = nextCut(cands, pos, pos + Math.max(24, room - need), end);
      }
      const y1 = cut ? cut.y : end;
      mine = [...new Set(m.notes.filter((n) => n.y >= pos && n.y < y1 && !pg.notes.includes(n.name)).map((n) => n.name))];
      notesH += notesHeight(mine, pg.notes.length === 0);
      pg.notes.push(...mine);
      pg.chunks.push({ m: f.m, y0: pos, y1, x: pg.colX[col], y: start, w: pg.colW[col] });
      cursor = start + (y1 - pos);
      if (!cut) break;
      pos = cut.next;
      if (pos >= end - 0.5) break;
      // Table header rows repeat at the top of the next page or column.
      const band = cut.band && cut.next > cut.band.bottom + 0.1 ? cut.band : undefined;
      if (col + 1 < pg.colX.length && cut.forced !== "page") {
        col++;
        cursor = secTop;
      } else newPage(si, false);
      if (band) {
        const pg2 = page as unknown as Page;
        pg2.chunks.push({ m: f.m, y0: band.top, y1: band.bottom, x: pg2.colX[col], y: cursor, w: pg2.colW[col] });
        cursor += band.bottom - band.top;
      }
    }
    // Columns ending at a continuous section break are balanced, as in Word.
    const nextFlow = flows[si + 1];
    const pgNow = page as unknown as Page | null;
    if (pgNow && pgNow.colX.length > 1 && nextFlow && nextFlow.sect.type === "continuous" && Math.abs(nextFlow.sect.pageW - s.pageW) < 1 && Math.abs(nextFlow.sect.pageH - s.pageH) < 1) {
      const mine = pgNow.chunks.filter((c) => c.m === f.m && c.y >= secTop - 0.01);
      const n = pgNow.colX.length;
      if (mine.length) {
        const from = mine[0].y0;
        const fits = (h: number) => {
          let p = from;
          for (let c = 0; c < n; c++) {
            const cut = nextCut(cands, p, p + h, end);
            if (!cut) return true;
            if (cut.forced === "page") return false;
            p = cut.next;
            if (p >= end - 0.5) return true;
          }
          return false;
        };
        let lo = Math.max(1, (end - from) / n);
        let hi = pgNow.bodyBottom - secTop - notesH;
        if (fits(hi)) {
          for (let k = 0; k < 20; k++) {
            const mid = (lo + hi) / 2;
            if (fits(mid)) hi = mid;
            else lo = mid;
          }
          pgNow.chunks = pgNow.chunks.filter((c) => !mine.includes(c));
          let p = from;
          let used = 0;
          for (let c = 0; c < n && p < end - 0.5; c++) {
            const cut = nextCut(cands, p, p + hi, end);
            const y1 = cut ? cut.y : end;
            pgNow.chunks.push({ m: f.m, y0: p, y1, x: pgNow.colX[c], y: secTop, w: pgNow.colW[c] });
            used = Math.max(used, y1 - p);
            if (!cut) break;
            p = cut.next;
          }
          cursor = secTop + used;
        }
      }
    }
    // Vertical alignment of a section's pages (title pages).
    if (s.vAlign === "center" || s.vAlign === "bottom") {
      for (const pg of pages.filter((p) => p.sect === si)) {
        const used = Math.max(...pg.chunks.map((c) => c.y + (c.y1 - c.y0)), pg.bodyTop);
        const free = pg.bodyBottom - used;
        const shift = s.vAlign === "center" ? free / 2 : free;
        if (shift > 0) for (const c of pg.chunks) c.y += shift;
      }
    }
  });

  if (!pages.length && flows.length) newPage(0, true);
  const total = pages.length;
  for (const p of pages) {
    p.total = total;
    p.sectionPages = pages.filter((q) => q.sect === p.sect).length;
  }
  return pages;
}
