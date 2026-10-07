/**
 * One worksheet, printed the way Excel prints it: column widths from the
 * default font's digit width, row heights (fitted to wrapped text where the
 * file leaves them open), the print area or used range, print titles, scaling
 * and fit-to-page, page breaks and page order; then each page painted: fills,
 * gridlines, borders, text with Excel's alignment, overflow, wrapping and
 * number formats, data bars, pictures, charts and shapes, and links.
 */
import { clip, concatTransformationMatrix, endPath, popGraphicsState, pushGraphicsState, rectangle, rgb, LineCapStyle, PDFName, PDFString, type PDFPage } from "@cantoo/pdf-lib";
import { embedImage, type PDFDocument } from "../core";
import { drawChart } from "../docx/chart";
import { metafileToPng } from "../metafile";
import { shapePath } from "../docx/paint";
import type { ShapeNode } from "../docx/model";
import { Looks, type Look } from "./format";
import type { Cell, Range, Sheet, Workbook, XAlign, XBorderSide, XDrawing, XFont } from "./model";
import { FILL, PAD, formatValue, general, type Formatted } from "./numfmt";
import type { TextKit } from "../textkit";

const PX = 0.75; // one 96-dpi pixel, in points
const PAD_L = 2 * PX;
const PAD_R = 3 * PX;
const key = (r: number, c: number) => r * 16384 + c;
const hex = (h: string) => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);

export type PageSpec = { rows: [number, number]; cols: [number, number]; titleRows?: [number, number]; titleCols?: [number, number] };

/** A run of text in one font (rich text has several). */
type Piece = { text: string; font: XFont; color?: string };
/** Something on a line: text, or a blank as wide as some text (number format padding). */
type Atom = { text: string; font: XFont; color?: string; blank?: boolean; fill?: boolean; w: number };
type Line = { atoms: Atom[]; w: number; asc: number; desc: number; h: number };

const BORDER_W: Record<string, number> = { thin: 0.75, hair: 0.5, dotted: 0.75, dashed: 0.75, dashDot: 0.75, dashDotDot: 0.75, medium: 1.5, mediumDashed: 1.5, mediumDashDot: 1.5, mediumDashDotDot: 1.5, slantDashDot: 1.5, thick: 2.25, double: 0.75 };
const DASH: Record<string, number[]> = { dotted: [0.75, 0.75], hair: [0.5, 0.5], dashed: [2.25, 0.75], mediumDashed: [6, 2.25], dashDot: [6, 2.25, 0.75, 2.25], mediumDashDot: [6, 2.25, 1.5, 2.25], dashDotDot: [6, 2.25, 0.75, 2.25, 0.75, 2.25], mediumDashDotDot: [6, 2.25, 1.5, 2.25, 1.5, 2.25], slantDashDot: [6, 1.5, 3, 1.5] };

export class SheetPrinter {
  scale = 1;
  pages: PageSpec[] = [];
  private mdw = 7;
  private defaultRowH = 15;
  private autoH = new Map<number, number>();
  /** Column widths fitted to content, for sheets that never had widths set (exports from other programs). */
  private fitted = new Map<number, number>();
  private colX: number[] = [0];
  private rowY: number[] = [0];
  private mergeTL = new Map<number, Range>();
  private mergeRows = new Map<number, Range[]>();
  private looks: Looks;
  private images = new Map<string, Promise<Awaited<ReturnType<typeof embedImage>> | null>>();

  constructor(
    public wb: Workbook,
    public sheet: Sheet,
    private kit: TextKit,
    private doc: PDFDocument,
  ) {
    this.looks = new Looks(wb, sheet);
    for (const m of sheet.merges) {
      this.mergeTL.set(key(m.r0, m.c0), m);
      for (let r = m.r0; r <= Math.min(m.r1, m.r0 + 5000); r++) {
        let list = this.mergeRows.get(r);
        if (!list) this.mergeRows.set(r, (list = []));
        list.push(m);
      }
    }
  }

  /* ----------------------------------------------------------------- sizes */

  private colInfo(c: number) {
    return this.sheet.cols.find((x) => c >= x.min && c <= x.max);
  }

  /** Column width in points: Excel's character width, in whole pixels of the default font's widest digit. */
  colW(c: number): number {
    const info = this.colInfo(c);
    if (info?.hidden) return 0;
    const fitted = this.fitted.get(c);
    if (fitted !== undefined) return fitted;
    const w = info?.width ?? this.sheet.defaultColWidth;
    if (w == null) {
      // Standard width: base characters plus 5 pixels, rounded up to a multiple of 8 pixels.
      return Math.ceil((this.sheet.baseColWidth * this.mdw + 5) / 8) * 8 * PX;
    }
    if (w <= 0) return 0;
    return Math.trunc(((256 * w + Math.trunc(128 / this.mdw)) / 256) * this.mdw) * PX;
  }

  rowH(r: number): number {
    const info = this.sheet.rows.get(r);
    if (info?.hidden) return 0;
    if (this.sheet.zeroHeight && !info) return 0;
    if (info?.ht != null) return info.ht;
    return this.autoH.get(r) ?? this.defaultRowH;
  }

  private x(c: number): number {
    while (this.colX.length <= c) this.colX.push(this.colX[this.colX.length - 1] + this.colW(this.colX.length - 1));
    return this.colX[c];
  }
  private y(r: number): number {
    while (this.rowY.length <= r) this.rowY.push(this.rowY[this.rowY.length - 1] + this.rowH(this.rowY.length - 1));
    return this.rowY[r];
  }

  merge(r: number, c: number): Range | undefined {
    const list = this.mergeRows.get(r);
    if (!list) return undefined;
    for (const m of list) if (c >= m.c0 && c <= m.c1) return m;
    return undefined;
  }

  /* ------------------------------------------------------------- content */

  formatted(cell: Cell, fmt: string): Formatted {
    return formatValue(cell.v, cell.t, fmt, this.wb.date1904);
  }

  /** The pieces of text a cell shows. */
  private pieces(cell: Cell, look: Look, f: Formatted): Piece[] {
    if (cell.rich && cell.t === "s" && !f.pads.length && !f.fill) {
      return cell.rich.map((r) => ({ text: r.text, font: { ...r.font, size: r.font.size }, color: r.font.color }));
    }
    return [{ text: f.text, font: look.font, color: f.color ?? look.font.color }];
  }

  private async atoms(pieces: Piece[], pads: string[]): Promise<Atom[]> {
    const out: Atom[] = [];
    let p = 0;
    for (const pc of pieces) {
      let buf = "";
      const flush = async () => {
        if (buf) out.push({ text: buf, font: pc.font, color: pc.color, w: await this.kit.width(buf, pc.font) });
        buf = "";
      };
      for (const ch of pc.text) {
        if (ch === PAD) {
          await flush();
          const padCh = pads[p++] ?? " ";
          out.push({ text: padCh, font: pc.font, blank: true, w: await this.kit.width(padCh, pc.font) });
        } else if (ch === FILL) {
          await flush();
          out.push({ text: "", font: pc.font, blank: true, fill: true, w: 0 });
        } else buf += ch;
      }
      await flush();
    }
    return out;
  }

  /** Break atoms into lines no wider than `width` (at spaces, or inside a word that is too long). */
  private async wrap(atoms: Atom[], width: number): Promise<Atom[][]> {
    const lines: Atom[][] = [[]];
    let lineW = 0;
    const newLine = () => {
      // Spaces at the end of a line take no room.
      const cur = lines[lines.length - 1];
      while (cur.length && /^\s+$/.test(cur[cur.length - 1].text) && !cur[cur.length - 1].blank) cur.pop();
      lines.push([]);
      lineW = 0;
    };
    for (const a of atoms) {
      if (a.blank) {
        lines[lines.length - 1].push(a);
        lineW += a.w;
        continue;
      }
      const parts = a.text.split(/(\n|\s+)/).filter((s) => s !== "");
      for (const part of parts) {
        if (part === "\n") {
          newLine();
          continue;
        }
        const w = await this.kit.width(part, a.font);
        const fw = await this.kit.fitWidth(part, a.font);
        const isSpace = /^\s+$/.test(part);
        if (isSpace) {
          if (lines[lines.length - 1].length) {
            lines[lines.length - 1].push({ ...a, text: part, w });
            lineW += fw;
          }
          continue;
        }
        if (lineW + fw <= width + 0.01 || !lines[lines.length - 1].length) {
          if (fw <= width + 0.01) {
            lines[lines.length - 1].push({ ...a, text: part, w });
            lineW += fw;
            continue;
          }
        } else {
          newLine();
          if (fw <= width + 0.01) {
            lines[lines.length - 1].push({ ...a, text: part, w });
            lineW = fw;
            continue;
          }
        }
        // A word longer than the line: split it by characters.
        let chunk = "";
        for (const ch of part) {
          const cw = await this.kit.fitWidth(chunk + ch, a.font);
          if (lineW + cw > width + 0.01 && (chunk || lines[lines.length - 1].length)) {
            if (chunk) lines[lines.length - 1].push({ ...a, text: chunk, w: await this.kit.width(chunk, a.font) });
            newLine();
            chunk = ch;
          } else chunk += ch;
        }
        if (chunk) {
          lines[lines.length - 1].push({ ...a, text: chunk, w: await this.kit.width(chunk, a.font) });
          lineW += await this.kit.fitWidth(chunk, a.font);
        }
      }
    }
    const last = lines[lines.length - 1];
    while (last.length && /^\s+$/.test(last[last.length - 1].text) && !last[last.length - 1].blank) last.pop();
    return lines;
  }

  private async measureLine(atoms: Atom[], fallback: XFont): Promise<Line> {
    let asc = 0;
    let desc = 0;
    let h = 0;
    const fonts = atoms.length ? atoms.map((a) => a.font) : [fallback];
    for (const f of fonts) {
      const m = await this.kit.metrics(f);
      asc = Math.max(asc, Math.round((m.ascent * 96) / 72) * PX);
      desc = Math.max(desc, Math.round((m.descent * 96) / 72) * PX);
      h = Math.max(h, await this.kit.lineHeight(f));
    }
    return { atoms, w: atoms.reduce((s, a) => s + a.w, 0), asc, desc, h };
  }

  /* --------------------------------------------------------------- prepare */

  /** Sizes, the area to print, scale and pages. False when the sheet has nothing to print. */
  async prepare(): Promise<boolean> {
    const { sheet, wb } = this;
    this.mdw = await this.kit.maxDigitWidth(wb.defaultFont);
    this.defaultRowH = sheet.defaultRowHeight ?? (await this.kit.lineHeight(wb.defaultFont)) + 2 * PX;
    // A sheet with no column widths at all was written by a program, never laid out in Excel:
    // its numbers and dates would print as #####. Widen those columns to their content
    // (text that can spill into empty neighbours is left alone).
    if (!sheet.cols.length && sheet.defaultColWidth == null) await this.fitColumns();
    // Rows the file leaves to fit their content.
    for (const [r, cells] of sheet.cells) {
      const info = sheet.rows.get(r);
      if (info?.ht != null || info?.hidden) continue;
      let need = 0;
      for (const [c, cell] of cells) {
        if (cell.v === null || cell.v === "") continue;
        if (this.merge(r, c)) continue; // Excel does not fit rows to merged cells
        const st = this.looks.style(r, c, cell);
        const look = this.looks.look(r, c, cell);
        need = Math.max(need, await this.cellHeight(cell, st.align, look, this.colW(c)));
      }
      if (need > this.defaultRowH + 0.01) this.autoH.set(r, need);
    }
    const areas = sheet.printArea ?? (this.used() ? [this.used()!] : []);
    if (!areas.length) return false;
    const m = sheet.setup.margins;
    const usableW = sheet.setup.paperW - m.left - m.right;
    const usableH = sheet.setup.paperH - m.top - m.bottom;
    if (usableW <= 10 || usableH <= 10) return false;
    let s = sheet.setup.scale / 100;
    if (sheet.setup.fitToPage) {
      const fits = (pct: number) =>
        areas.every((a) => {
          const sc = pct / 100;
          const cols = this.bands(a.c0, a.c1, usableW / sc, true, false);
          const rows = this.bands(a.r0, a.r1, usableH / sc, false, false);
          return (!sheet.setup.fitW || cols.length <= sheet.setup.fitW) && (!sheet.setup.fitH || rows.length <= sheet.setup.fitH);
        });
      let lo = 10;
      let hi = 100;
      if (fits(100)) lo = 100;
      else {
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (fits(mid)) lo = mid;
          else hi = mid;
        }
      }
      s = lo / 100;
    }
    this.scale = s;
    for (const a of areas) {
      const cols = this.bands(a.c0, a.c1, usableW / s, true, !sheet.setup.fitToPage);
      const rows = this.bands(a.r0, a.r1, usableH / s, false, !sheet.setup.fitToPage);
      const page = (rb: [number, number], cb: [number, number]): PageSpec => {
        const p: PageSpec = { rows: rb, cols: cb };
        if (sheet.titleRows && rb[0] > sheet.titleRows[1]) p.titleRows = sheet.titleRows;
        if (sheet.titleCols && cb[0] > sheet.titleCols[1]) p.titleCols = sheet.titleCols;
        return p;
      };
      if (sheet.setup.overThenDown) for (const rb of rows) for (const cb of cols) this.pages.push(page(rb, cb));
      else for (const cb of cols) for (const rb of rows) this.pages.push(page(rb, cb));
    }
    // Like Excel, pages with nothing on them are not printed.
    this.pages = this.pages.filter((p) => this.hasContent(p));
    return this.pages.length > 0;
  }

  /** Whether a page's own cells (not its print titles) show anything: values, fills, borders, drawings. */
  private hasContent(p: PageSpec): boolean {
    const [r0, r1] = p.rows;
    const [c0, c1] = p.cols;
    for (let r = r0; r <= r1; r++) {
      const row = this.sheet.cells.get(r);
      if (!row || !this.rowH(r)) continue;
      for (const [c, cell] of row) {
        if (c < c0 || c > c1 || !this.colW(c)) continue;
        if (cell.v !== null && cell.v !== "") return true;
        const look = this.looks.look(r, c, cell);
        if (look.fill || hasBorder(look.border)) return true;
      }
    }
    for (const m of this.sheet.merges) {
      if (m.r1 < r0 || m.r0 > r1 || m.c1 < c0 || m.c0 > c1) continue;
      const tl = this.sheet.cells.get(m.r0)?.get(m.c0);
      if (tl && tl.v !== null && tl.v !== "") return true;
    }
    const x0 = this.x(c0);
    const x1 = this.x(c1 + 1);
    const y0 = this.y(r0);
    const y1 = this.y(r1 + 1);
    for (const d of this.sheet.drawings) {
      const b = this.drawingBox(d);
      if (b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0) return true;
    }
    return false;
  }

  private async fitColumns() {
    const need = new Map<number, number>();
    const max = 60 * this.mdw * PX;
    for (const [r, cells] of this.sheet.cells) {
      for (const [c, cell] of cells) {
        if (cell.v === null || cell.v === "" || this.merge(r, c)) continue;
        const st = this.looks.style(r, c, cell);
        if (st.align.wrap || st.align.rotation) continue;
        const f = this.formatted(cell, st.numFmt);
        // Text spills into an empty neighbour; it only needs room when the next cell is taken.
        if (!f.numeric && this.empty(r, c + 1)) continue;
        let w = 0;
        for (const a of await this.atoms(this.pieces(cell, this.looks.look(r, c, cell), f), f.pads)) w += a.fill ? 0 : Math.max(a.w, await this.kit.fitWidth(a.text, a.font));
        need.set(c, Math.max(need.get(c) ?? 0, w + PAD_L + PAD_R + PX + (st.align.indent ?? 0) * this.indentW()));
      }
    }
    const base = this.colW(0);
    for (const [c, w] of need) if (w > base) this.fitted.set(c, Math.min(max, Math.ceil(w / PX) * PX));
  }

  /** Height a cell's content needs (row autofit). */
  private async cellHeight(cell: Cell, align: XAlign, look: Look, colW: number): Promise<number> {
    const f = this.formatted(cell, this.looks.style(0, 0, cell).numFmt);
    const pieces = this.pieces(cell, look, f);
    const atoms = await this.atoms(pieces, f.pads);
    const wrap = align.wrap || align.h === "justify" || align.h === "distributed" || align.v === "justify" || align.v === "distributed";
    const rot = align.rotation ?? 0;
    if (rot === 255) {
      const lh = await this.kit.lineHeight(look.font);
      return [...f.text].length * lh + 2 * PX;
    }
    if (rot) {
      const w = atoms.reduce((s, a) => s + a.w, 0);
      const lh = await this.kit.lineHeight(look.font);
      const rad = (Math.abs(rot) * Math.PI) / 180;
      return w * Math.sin(rad) + lh * Math.cos(rad) + 2 * PX;
    }
    const lines = wrap ? await this.wrap(atoms, Math.max(1, colW - PAD_L - PAD_R - (align.indent ?? 0) * this.indentW())) : [atoms];
    let h = 0;
    for (const l of lines) h += (await this.measureLine(l, look.font)).h;
    return h + 2 * PX;
  }

  private indentW(): number {
    // An indent level is three spaces of the default font (about 10 pixels for Calibri 11).
    return (this.mdw * 96) / 72 > 0 ? 3 * 3.32 * PX * (this.wb.defaultFont.size / 11) : 7.5;
  }

  /** The used range: cells with something to show, merges, tables, drawings. */
  private usedCache: Range | null | undefined;
  private used(): Range | null {
    if (this.usedCache !== undefined) return this.usedCache;
    let r1 = -1;
    let c1 = -1;
    for (const [r, cells] of this.sheet.cells) {
      for (const [c, cell] of cells) {
        const visible = (cell.v !== null && cell.v !== "") || !!this.looks.look(r, c, cell).fill || hasBorder(this.looks.style(r, c, cell).border) || this.looks.hasOverlay(r, c);
        if (!visible) continue;
        r1 = Math.max(r1, r);
        c1 = Math.max(c1, c);
      }
    }
    for (const m of this.sheet.merges) {
      const tl = this.sheet.cells.get(m.r0)?.get(m.c0);
      if (tl && tl.v !== null && tl.v !== "") {
        r1 = Math.max(r1, m.r1);
        c1 = Math.max(c1, m.c1);
      }
    }
    for (const t of this.sheet.tables) {
      r1 = Math.max(r1, t.ref.r1);
      c1 = Math.max(c1, t.ref.c1);
    }
    for (const d of this.sheet.drawings) {
      const end = this.drawingEnd(d);
      r1 = Math.max(r1, end.r);
      c1 = Math.max(c1, end.c);
    }
    this.usedCache = r1 < 0 ? null : { r0: 0, c0: 0, r1, c1 };
    return this.usedCache;
  }

  private drawingEnd(d: XDrawing): { r: number; c: number } {
    if (d.to) return { r: d.to.rowOff > 0 ? d.to.row : Math.max(d.from.row, d.to.row - 1), c: d.to.colOff > 0 ? d.to.col : Math.max(d.from.col, d.to.col - 1) };
    const box = this.drawingBox(d);
    let r = 0;
    while (this.y(r + 1) < box.y + box.h - 0.01 && r < 1048575) r++;
    let c = 0;
    while (this.x(c + 1) < box.x + box.w - 0.01 && c < 16383) c++;
    return { r, c };
  }

  /** Bands of rows or columns that fit `avail` (at 100%), breaking at manual breaks when asked. */
  private bands(start: number, end: number, avail: number, cols: boolean, manual: boolean): [number, number][] {
    const size = (i: number) => (cols ? this.colW(i) : this.rowH(i));
    const titles = cols ? this.sheet.titleCols : this.sheet.titleRows;
    const titleSize = titles ? Array.from({ length: titles[1] - titles[0] + 1 }, (_, k) => size(titles[0] + k)).reduce((a, b) => a + b, 0) : 0;
    const breaks = new Set(manual ? (cols ? this.sheet.colBreaks : this.sheet.rowBreaks) : []);
    const out: [number, number][] = [];
    let i = start;
    while (i <= end) {
      const room = avail - (titles && i > titles[1] ? titleSize : 0);
      let used = size(i);
      let j = i;
      while (j + 1 <= end && !breaks.has(j + 1) && used + size(j + 1) <= room + 0.01) {
        j++;
        used += size(j);
      }
      out.push([i, j]);
      i = j + 1;
      if (out.length > 20000) break;
    }
    // Pages of nothing but hidden rows or columns are not printed.
    return out.filter(([a, b]) => {
      for (let k = a; k <= b; k++) if (size(k) > 0) return true;
      return false;
    });
  }

  /* -------------------------------------------------------------- drawing */

  /** Where a drawing sits on the sheet (points at 100%, from A1's corner). */
  drawingBox(d: XDrawing): { x: number; y: number; w: number; h: number } {
    let box: { x: number; y: number; w: number; h: number };
    if (d.abs && d.ext) box = { x: d.abs.x, y: d.abs.y, w: d.ext.w, h: d.ext.h };
    else {
      const x0 = this.x(d.from.col) + Math.min(d.from.colOff, this.colW(d.from.col));
      const y0 = this.y(d.from.row) + Math.min(d.from.rowOff, this.rowH(d.from.row));
      if (d.to) {
        const x1 = this.x(d.to.col) + Math.min(d.to.colOff, this.colW(d.to.col));
        const y1 = this.y(d.to.row) + Math.min(d.to.rowOff, this.rowH(d.to.row));
        box = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
      } else box = { x: x0, y: y0, w: d.ext?.w ?? 0, h: d.ext?.h ?? 0 };
    }
    if (d.sub) box = { x: box.x + d.sub.x * box.w, y: box.y + d.sub.y * box.h, w: d.sub.w * box.w, h: d.sub.h * box.h };
    return box;
  }

  /**
   * Paint one page. Content goes in a transform that scales the sheet: inside it, a point
   * (x, y) measured down from the top-left of the printable area is drawn at (x, -y).
   */
  async paint(page: PDFPage, spec: PageSpec): Promise<{ x: number; y: number; w: number; h: number; url?: string; dest?: string }[]> {
    const { sheet } = this;
    const s = this.scale;
    const m = sheet.setup.margins;
    const H = page.getHeight();
    // Segments of rows and columns: print titles first, then the page's own band.
    const segs = (band: [number, number], titles?: [number, number]) => {
      const out: { a: number; b: number }[] = [];
      if (titles) out.push({ a: titles[0], b: titles[1] });
      out.push({ a: band[0], b: band[1] });
      return out;
    };
    const colSegs = segs(spec.cols, spec.titleCols);
    const rowSegs = segs(spec.rows, spec.titleRows);
    const span = (seg: { a: number; b: number }, cols: boolean) => (cols ? this.x(seg.b + 1) - this.x(seg.a) : this.y(seg.b + 1) - this.y(seg.a));
    const totalW = colSegs.reduce((t, g) => t + span(g, true), 0);
    const totalH = rowSegs.reduce((t, g) => t + span(g, false), 0);
    const usableW = sheet.setup.paperW - m.left - m.right;
    const usableH = sheet.setup.paperH - m.top - m.bottom;
    const ox = m.left + (sheet.setup.hCenter ? Math.max(0, (usableW - totalW * s) / 2) : 0);
    const oy = m.top + (sheet.setup.vCenter ? Math.max(0, (usableH - totalH * s) / 2) : 0);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(s, 0, 0, s, ox, H - oy));
    const links: { x: number; y: number; w: number; h: number; url?: string; dest?: string }[] = [];
    let by = 0;
    for (const rs of rowSegs) {
      let bx = 0;
      const bh = span(rs, false);
      for (const cs of colSegs) {
        const bw = span(cs, true);
        // The block's top-left on the page, minus the sheet position of its first cell.
        const dx = bx - this.x(cs.a);
        const dy = by - this.y(rs.a);
        await this.block(page, rs, cs, dx, dy, { x: bx, y: by, w: bw, h: bh }, links);
        bx += bw;
      }
      by += bh;
    }
    page.pushOperators(popGraphicsState());
    // Link rectangles back in page coordinates.
    return links.map((l) => ({ ...l, x: ox + l.x * s, y: oy + l.y * s, w: l.w * s, h: l.h * s }));
  }

  private clipTo(page: PDFPage, r: { x: number; y: number; w: number; h: number }) {
    page.pushOperators(pushGraphicsState(), rectangle(r.x, -(r.y + r.h), r.w, r.h), clip(), endPath());
  }

  private async block(page: PDFPage, rs: { a: number; b: number }, cs: { a: number; b: number }, dx: number, dy: number, area: { x: number; y: number; w: number; h: number }, links: { x: number; y: number; w: number; h: number; url?: string; dest?: string }[]) {
    const { sheet } = this;
    const X = (c: number) => this.x(c) + dx;
    const Y = (r: number) => this.y(r) + dy;
    this.clipTo(page, area);
    // 1. Fills (merged areas once, from their top-left cell).
    for (let r = rs.a; r <= rs.b; r++) {
      if (!this.rowH(r)) continue;
      const row = sheet.cells.get(r);
      for (let c = cs.a; c <= cs.b; c++) {
        if (!this.colW(c)) continue;
        const mg = this.merge(r, c);
        if (mg && !(r === Math.max(mg.r0, rs.a) && c === Math.max(mg.c0, cs.a))) continue;
        const rr = mg ? mg.r0 : r;
        const cc = mg ? mg.c0 : c;
        const cell = mg ? sheet.cells.get(rr)?.get(cc) : row?.get(c);
        const look = this.looks.look(rr, cc, cell);
        const x0 = mg ? X(mg.c0) : X(c);
        const y0 = mg ? Y(mg.r0) : Y(r);
        const w = mg ? X(mg.c1 + 1) - X(mg.c0) : this.colW(c);
        const h = mg ? Y(mg.r1 + 1) - Y(mg.r0) : this.rowH(r);
        if (look.fill) page.drawRectangle({ x: x0, y: -(y0 + h), width: w, height: h, color: hex(look.fill) });
        if (look.bar && cell) this.dataBar(page, look.bar, x0, y0, w, h, cell);
      }
    }
    // 2. Gridlines, when the sheet prints them.
    if (sheet.setup.gridLines) {
      const g = { thickness: 0.25, color: rgb(0, 0, 0) };
      const top = Y(rs.a);
      const bottom = Y(rs.b + 1);
      const left = X(cs.a);
      const right = X(cs.b + 1);
      page.drawLine({ start: { x: left, y: -top }, end: { x: right, y: -top }, ...g });
      page.drawLine({ start: { x: left, y: -top }, end: { x: left, y: -bottom }, ...g });
      for (let r = rs.a; r <= rs.b; r++) {
        if (!this.rowH(r)) continue;
        for (let c = cs.a; c <= cs.b; c++) {
          if (!this.colW(c)) continue;
          const mg = this.merge(r, c);
          const x1 = X(c + 1);
          const y1 = Y(r + 1);
          if (!mg || c === mg.c1) page.drawLine({ start: { x: x1, y: -Y(r) }, end: { x: x1, y: -y1 }, ...g });
          if (!mg || r === mg.r1) page.drawLine({ start: { x: X(c), y: -y1 }, end: { x: x1, y: -y1 }, ...g });
        }
      }
    }
    // 3. Borders.
    for (let r = rs.a; r <= rs.b; r++) {
      if (!this.rowH(r)) continue;
      const row = sheet.cells.get(r);
      for (let c = cs.a; c <= cs.b; c++) {
        if (!this.colW(c)) continue;
        const mg = this.merge(r, c);
        const cell = row?.get(c);
        const b = this.looks.look(r, c, cell).border;
        const x0 = X(c);
        const x1 = X(c + 1);
        const y0 = Y(r);
        const y1 = Y(r + 1);
        // Inside a merged area only its outline is drawn.
        if (b.top && (!mg || r === mg.r0)) this.edge(page, b.top, x0, y0, x1, y0, "h");
        if (b.bottom && (!mg || r === mg.r1)) this.edge(page, b.bottom, x0, y1, x1, y1, "h");
        if (b.left && (!mg || c === mg.c0)) this.edge(page, b.left, x0, y0, x0, y1, "v");
        if (b.right && (!mg || c === mg.c1)) this.edge(page, b.right, x1, y0, x1, y1, "v");
        if (b.diagonal && (b.diagDown || b.diagUp) && (!mg || (r === mg.r0 && c === mg.c0))) {
          const ex = mg ? X(mg.c1 + 1) : x1;
          const ey = mg ? Y(mg.r1 + 1) : y1;
          if (b.diagDown) this.edge(page, b.diagonal, x0, y0, ex, ey, "d");
          if (b.diagUp) this.edge(page, b.diagonal, x0, ey, ex, y0, "d");
        }
      }
    }
    // 4. Text, including text spilling in from cells left or right of the block.
    const lead = Math.max(0, cs.a - 40);
    const trail = cs.b + 40;
    for (let r = rs.a; r <= rs.b; r++) {
      if (!this.rowH(r)) continue;
      const row = sheet.cells.get(r);
      const merged = this.mergeRows.get(r) ?? [];
      // Merged areas starting above or left of the block still show their text here.
      for (const mg of merged) {
        if (r !== Math.max(mg.r0, rs.a) || mg.c1 < cs.a || mg.c0 > cs.b) continue;
        if (mg.r0 === r && mg.c0 >= cs.a) continue; // drawn below with its own cell
        const cell = sheet.cells.get(mg.r0)?.get(mg.c0);
        if (cell) await this.cellText(page, mg.r0, mg.c0, cell, X, Y, links);
      }
      if (!row) continue;
      for (const [c, cell] of row) {
        if (c < lead || c > trail) continue;
        const mg = this.merge(r, c);
        if (mg && (mg.r0 !== r || mg.c0 !== c)) continue;
        const outside = c < cs.a || c > cs.b;
        if (outside && mg) continue;
        if (!this.colW(c) && !mg) continue;
        await this.cellText(page, r, c, cell, X, Y, links, outside);
      }
    }
    // 5. Pictures, charts and shapes over the cells.
    for (const d of sheet.drawings) {
      const box = this.drawingBox(d);
      const bx = box.x + dx;
      const by = box.y + dy;
      if (bx > area.x + area.w || by > area.y + area.h || bx + box.w < area.x || by + box.h < area.y) continue;
      await this.drawing(page, d, { x: bx, y: by, w: box.w, h: box.h });
    }
    page.pushOperators(popGraphicsState());
  }

  private edge(page: PDFPage, side: XBorderSide, x0: number, y0: number, x1: number, y1: number, dir: "h" | "v" | "d") {
    const w = BORDER_W[side.style] ?? 0.75;
    const color = hex(side.color ?? "000000");
    if (side.style === "double") {
      const o = 0.75;
      const [ox, oy] = dir === "h" ? [0, o] : dir === "v" ? [o, 0] : [0, 0];
      for (const k of dir === "d" ? [0] : [-1, 1]) page.drawLine({ start: { x: x0 + ox * k, y: -(y0 + oy * k) }, end: { x: x1 + ox * k, y: -(y1 + oy * k) }, thickness: 0.6, color });
      return;
    }
    page.drawLine({ start: { x: x0, y: -y0 }, end: { x: x1, y: -y1 }, thickness: w, color, dashArray: DASH[side.style], lineCap: DASH[side.style] ? undefined : LineCapStyle.Projecting });
  }

  private dataBar(page: PDFPage, bar: NonNullable<Look["bar"]>, x: number, y: number, w: number, h: number, cell: Cell) {
    if (cell.v === null) return;
    const inset = 1.5;
    const bw = Math.max(0, (w - 2 * inset) * bar.frac);
    const bh = Math.max(0, h - 2 * inset - 1);
    if (!bw || !bh) return;
    const base = hex(bar.color);
    if (!bar.gradient) {
      page.drawRectangle({ x: x + inset, y: -(y + inset + bh), width: bw, height: bh, color: base });
      return;
    }
    // Gradient bars fade to white: drawn as thin vertical strips.
    const steps = 24;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(bar.color.slice(i, i + 2), 16) / 255);
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const c = rgb(r + (1 - r) * t * 0.9, g + (1 - g) * t * 0.9, b + (1 - b) * t * 0.9);
      page.drawRectangle({ x: x + inset + (bw * i) / steps, y: -(y + inset + bh), width: bw / steps + 0.05, height: bh, color: c });
    }
    page.drawRectangle({ x: x + inset, y: -(y + inset + bh), width: bw, height: bh, borderColor: base, borderWidth: 0.5 });
  }

  /** Is the cell at (r, c) empty, so text from a neighbour may spill into it? */
  private empty(r: number, c: number): boolean {
    const cell = this.sheet.cells.get(r)?.get(c);
    if (this.merge(r, c)) return false;
    return !cell || cell.v === null || cell.v === "";
  }

  private async cellText(page: PDFPage, r: number, c: number, cell: Cell, X: (c: number) => number, Y: (r: number) => number, links: { x: number; y: number; w: number; h: number; url?: string; dest?: string }[], spillOnly = false) {
    if (cell.v === null || cell.v === "") return;
    const st = this.looks.style(r, c, cell);
    const look = this.looks.look(r, c, cell);
    const al = st.align;
    const mg = this.merge(r, c);
    const x0 = X(c);
    const y0 = Y(r);
    const x1 = mg ? X(mg.c1 + 1) : X(c + 1);
    const y1 = mg ? Y(mg.r1 + 1) : Y(r + 1);
    const cw = x1 - x0;
    const chH = y1 - y0;
    if (cw <= 0 || chH <= 0) return;
    const f = this.formatted(cell, st.numFmt);
    if (!f.text) return;
    let hAlign = al.h ?? "general";
    if (hAlign === "general") hAlign = cell.t === "b" || cell.t === "e" ? "center" : f.numeric ? "right" : "left";
    const indent = (al.indent ?? 0) * this.indentW();
    const wrap = !f.numeric && (al.wrap || hAlign === "justify" || hAlign === "distributed" || al.v === "justify" || al.v === "distributed");
    const rot = al.rotation ?? 0;
    let font = look.font;
    let pieces = this.pieces(cell, look, f);
    let atoms = await this.atoms(pieces, f.pads);
    const avail = cw - PAD_L - PAD_R - (hAlign === "left" || hAlign === "right" || hAlign === "distributed" ? indent : 0);
    const fit = async (as: Atom[]) => {
      let t = 0;
      for (const a of as) t += a.fill ? 0 : await this.kit.fitWidth(a.text, a.font);
      return t;
    };
    let width = await fit(atoms);
    // Numbers that do not fit: General shows fewer digits, other formats show ####.
    // (A number may use the left margin too: it has to fit the cell less its right margin.)
    const numRoom = cw - PAD_R - (hAlign === "left" || hAlign === "right" ? indent : 0);
    if (f.numeric && !rot && width > numRoom + 0.01 && hAlign !== "fill") {
      let text = "";
      if (f.general && typeof cell.v === "number") {
        for (let n = 10; n >= 1; n--) {
          const t = general(cell.v, n);
          if ((await this.kit.fitWidth(t, font)) <= numRoom + 0.01) {
            text = t;
            break;
          }
        }
      }
      if (!text || text.startsWith("#")) {
        const hw = await this.kit.fitWidth("#", font);
        text = "#".repeat(Math.max(1, Math.floor(avail / hw)));
      }
      pieces = [{ text, font, color: f.color ?? font.color }];
      atoms = await this.atoms(pieces, []);
      width = await fit(atoms);
    }
    // Shrink to fit.
    if (al.shrink && !wrap && width > avail && width > 0) {
      const k = Math.max(0.1, avail / width);
      font = { ...font, size: font.size * k };
      pieces = pieces.map((p) => ({ ...p, font: { ...p.font, size: p.font.size * k } }));
      atoms = await this.atoms(pieces, f.pads);
      width = await fit(atoms);
    }
    if (rot) {
      if (!spillOnly) await this.rotatedText(page, atoms, font, rot, hAlign, al.v ?? "bottom", x0, y0, cw, chH);
      return;
    }
    // Lines and where the text may draw (its own cell, or spilling over empty neighbours).
    let lines: Atom[][];
    if (hAlign === "fill") {
      const unit = atoms.reduce((t, a) => t + a.w, 0);
      const times = unit > 0 ? Math.max(1, Math.floor(avail / unit)) : 1;
      lines = [Array.from({ length: times }, () => atoms).flat()];
    } else lines = wrap ? await this.wrap(atoms, Math.max(1, avail)) : [atoms.flatMap((a) => (a.text.includes("\n") && !a.blank ? [{ ...a, text: a.text.replace(/\n/g, "") }] : [a]))];
    let clipL = x0;
    let clipR = x1;
    const lineW = lines.length === 1 ? await fit(lines[0]) : 0;
    if (!wrap && !mg && !f.numeric && hAlign !== "fill" && lineW > avail) {
      // Text spills into empty cells beside it (right for left-aligned, left for right-aligned, both for centred).
      const spillR = hAlign === "left" || hAlign === "center" || hAlign === "centerContinuous" || hAlign === "justify" || hAlign === "distributed";
      const spillL = hAlign === "right" || hAlign === "center" || hAlign === "centerContinuous";
      const need = lineW - avail;
      if (spillR) {
        let cc = c + 1;
        let got = 0;
        const target = hAlign === "center" || hAlign === "centerContinuous" ? need / 2 : need;
        while (got < target && cc < c + 60 && this.empty(r, cc)) {
          got += this.colW(cc);
          clipR = X(cc + 1);
          cc++;
        }
      }
      if (spillL) {
        let cc = c - 1;
        let got = 0;
        const target = hAlign === "center" || hAlign === "centerContinuous" ? need / 2 : need;
        while (got < target && cc >= 0 && cc > c - 60 && this.empty(r, cc)) {
          got += this.colW(cc);
          clipL = X(cc);
          cc--;
        }
      }
    }
    // centerContinuous: centred across the empty cells to the right that share the alignment.
    const boxL = x0;
    let boxR = x1;
    if (hAlign === "centerContinuous") {
      let cc = c + 1;
      while (cc < c + 60 && this.empty(r, cc) && this.looks.style(r, cc, this.sheet.cells.get(r)?.get(cc)).align.h === "centerContinuous") {
        boxR = X(cc + 1);
        cc++;
      }
      clipR = Math.max(clipR, boxR);
    }
    // A cell beside the block shows here only through text spilling into it.
    if (spillOnly && clipL >= x0 - 0.01 && clipR <= X(c + 1) + 0.01) return;
    const measured: Line[] = [];
    for (const l of lines) measured.push(await this.measureLine(l, font));
    const blockH = measured.reduce((t, l) => t + l.h, 0);
    const vAlign = al.v ?? "bottom";
    // The first line's top: lines sit inside a one-pixel margin at top and bottom.
    let top: number;
    if (vAlign === "top") top = y0 + PX;
    else if (vAlign === "center" || vAlign === "distributed" || vAlign === "justify") top = y0 + (chH - blockH) / 2;
    else top = y1 - PX - blockH;
    this.clipTo(page, { x: clipL, y: y0, w: clipR - clipL, h: chH });
    let lineTop = top;
    for (let li = 0; li < measured.length; li++) {
      const L = measured[li];
      const base = lineTop + L.h - L.desc;
      let x: number;
      const innerL = boxL + PAD_L + (hAlign === "left" || hAlign === "distributed" || hAlign === "justify" ? indent : 0);
      const innerR = boxR - PAD_R - (hAlign === "right" ? indent : 0);
      // Accounting-style fill (*): what comes before it sits left, the rest right.
      const at = L.atoms.findIndex((a) => a.fill);
      if (at >= 0) {
        const left = L.atoms.slice(0, at);
        const right = L.atoms.slice(at + 1);
        const rw = right.reduce((t, a) => t + a.w, 0);
        let lx = innerL;
        for (const a of left) {
          if (!a.blank) await this.drawAtom(page, a, lx, base, look);
          lx += a.w;
        }
        let rx = Math.max(lx, innerR - rw);
        if (f.fill && f.fill !== " ") {
          const fw = await this.kit.width(f.fill, font);
          const n = fw > 0 ? Math.floor((rx - lx) / fw) : 0;
          if (n > 0) await this.drawAtom(page, { text: f.fill.repeat(n), font, w: n * fw }, rx - n * fw, base, look);
        }
        for (const a of right) {
          if (!a.blank) await this.drawAtom(page, a, rx, base, look);
          rx += a.w;
        }
      } else {
        const lw = L.w;
        if (hAlign === "right") x = innerR - lw;
        else if (hAlign === "center" || hAlign === "centerContinuous") x = (boxL + boxR) / 2 - lw / 2;
        else x = innerL;
        // Justified and distributed lines spread their words (not the last line of justify).
        const spread = (hAlign === "justify" && li < measured.length - 1) || hAlign === "distributed";
        const gaps = spread ? L.atoms.filter((a) => /^\s+$/.test(a.text)).length : 0;
        const extra = spread && gaps ? Math.max(0, innerR - innerL - lw) / gaps : 0;
        if (spread && gaps) x = innerL;
        for (const a of L.atoms) {
          if (!a.blank && a.text.trim()) await this.drawAtom(page, a, x, base, look);
          x += a.w + (extra && /^\s+$/.test(a.text) ? extra : 0);
        }
      }
      lineTop += L.h;
    }
    page.pushOperators(popGraphicsState());
    // Links on the cell.
    if (!spillOnly) for (const l of this.sheet.links) if (r >= l.range.r0 && r <= l.range.r1 && c >= l.range.c0 && c <= l.range.c1) links.push({ x: x0, y: y0, w: cw, h: chH, url: l.url, dest: l.location });
  }

  private async drawAtom(page: PDFPage, a: Atom, x: number, base: number, look: Look) {
    const f = a.font;
    let size = f.size;
    let shift = 0;
    if (f.vertAlign === "superscript") {
      size *= 0.65;
      shift = f.size * 0.33;
    } else if (f.vertAlign === "subscript") {
      size *= 0.65;
      shift = -f.size * 0.14;
    }
    const color = a.color ?? look.font.color ?? "000000";
    const w = await this.kit.draw(page, a.text, x, -(base - shift), f, size, color);
    if (f.underline || f.strike) {
      const m = await this.kit.metrics(f, size);
      const c = hex(color);
      if (f.underline) {
        const y = base - shift + m.underline;
        page.drawLine({ start: { x, y: -y }, end: { x: x + w, y: -y }, thickness: m.thickness, color: c });
        if (f.underline.startsWith("double")) page.drawLine({ start: { x, y: -(y + m.thickness * 2) }, end: { x: x + w, y: -(y + m.thickness * 2) }, thickness: m.thickness, color: c });
      }
      if (f.strike) {
        const y = base - shift - size * 0.27;
        page.drawLine({ start: { x, y: -y }, end: { x: x + w, y: -y }, thickness: m.thickness, color: c });
      }
    }
  }

  private async rotatedText(page: PDFPage, atoms: Atom[], font: XFont, rot: number, hAlign: string, vAlign: string, x0: number, y0: number, w: number, h: number) {
    const look: Look = { font, border: {} };
    this.clipTo(page, { x: x0, y: y0, w, h });
    const lh = await this.kit.lineHeight(font);
    const m = await this.kit.metrics(font);
    if (rot === 255) {
      // Letters stacked top to bottom, centred in the cell.
      const chars = [...atoms.map((a) => a.text).join("")];
      let yy = vAlign === "top" ? y0 + PX : vAlign === "center" ? y0 + (h - chars.length * lh) / 2 : y0 + h - PX - chars.length * lh;
      for (const ch of chars) {
        const cw = await this.kit.width(ch, font);
        await this.drawAtom(page, { text: ch, font, w: cw }, x0 + (w - cw) / 2, yy + lh - m.descent, look);
        yy += lh;
      }
      page.pushOperators(popGraphicsState());
      return;
    }
    const tw = atoms.reduce((t, a) => t + a.w, 0);
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // The rotated line's bounding box, placed by the cell's alignment.
    const bw = Math.abs(tw * cos) + Math.abs(lh * sin);
    const bh = Math.abs(tw * sin) + Math.abs(lh * cos);
    const left = hAlign === "center" ? x0 + (w - bw) / 2 : hAlign === "right" ? x0 + w - PAD_R - bw : x0 + PAD_L;
    const top = vAlign === "top" ? y0 + PX : vAlign === "center" ? y0 + (h - bh) / 2 : y0 + h - PX - bh;
    // Rotate about the box centre: the text's own centre goes there.
    const cx = left + bw / 2;
    const cy = top + bh / 2;
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(cos, sin, -sin, cos, cx, -cy));
    let x = -tw / 2;
    const base = lh / 2 - m.descent;
    for (const a of atoms) {
      if (!a.blank && a.text.trim()) await this.drawAtom(page, a, x, base, look);
      x += a.w;
    }
    page.pushOperators(popGraphicsState(), popGraphicsState());
  }

  /* ------------------------------------------------------- drawings on page */

  /** A picture, embedded once; `shown` (its longer side in points) sets a WMF or EMF picture's resolution. */
  private image(src: string, shown?: number) {
    const m = this.wb.media.get(src);
    const meta = !!m && /emf|wmf/.test(m.mime);
    const key = meta && shown ? `${src}|${Math.ceil(shown / 25) * 25}` : src;
    let p = this.images.get(key);
    if (!p) {
      p = (async () => {
        if (!m || /tiff/.test(m.mime)) return null;
        try {
          if (meta) {
            const png = await metafileToPng(m.bytes, shown);
            return png ? await this.doc.embedPng(png) : null;
          }
          return await embedImage(this.doc, m.bytes, m.mime);
        } catch {
          return null;
        }
      })();
      this.images.set(key, p);
    }
    return p;
  }

  private async drawing(page: PDFPage, d: XDrawing, box: { x: number; y: number; w: number; h: number }) {
    if (box.w <= 0 || box.h <= 0) return;
    if (d.kind === "pic" && d.image) {
      const img = await this.image(d.image, Math.max(box.w, box.h));
      if (!img) {
        this.wb.warnings.add("TIFF and damaged pictures");
        page.drawRectangle({ x: box.x, y: -(box.y + box.h), width: box.w, height: box.h, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5 });
        return;
      }
      const cr = d.crop;
      if (cr && (cr.l || cr.t || cr.r || cr.b)) {
        const fw = box.w / Math.max(0.01, 1 - cr.l - cr.r);
        const fh = box.h / Math.max(0.01, 1 - cr.t - cr.b);
        this.clipTo(page, box);
        page.drawImage(img, { x: box.x - cr.l * fw, y: -(box.y - cr.t * fh + fh), width: fw, height: fh });
        page.pushOperators(popGraphicsState());
      } else page.drawImage(img, { x: box.x, y: -(box.y + box.h), width: box.w, height: box.h });
      return;
    }
    if (d.kind === "chart" && d.chart) {
      const doc = this.wb.charts.get(d.chart);
      if (!doc) return;
      const proxy = new Proxy(page, { get: (t, k) => (k === "getHeight" ? () => 0 : (Reflect.get(t, k, t) as unknown)) }) as PDFPage;
      const chartFont = (bold?: boolean): XFont => ({ name: this.wb.theme.minor.latin || "Calibri", size: 10, bold: !!bold, italic: false, strike: false });
      await drawChart(
        proxy,
        doc,
        this.wb.theme,
        box,
        async (text, x, baseline, size, opt) => {
          const f = chartFont(opt.bold);
          const w = await this.kit.width(text, f, size);
          const left = opt.align === "center" ? x - w / 2 : opt.align === "right" ? x - w : x;
          await this.kit.draw(page, text, left, -baseline, f, size, opt.color ?? "000000");
        },
        (text, size, bold) => this.kit.width(text, chartFont(bold), size),
      );
      return;
    }
    if (d.kind === "shape" && d.shape) await this.shape(page, d.shape, box);
  }

  private async shape(page: PDFPage, sh: NonNullable<XDrawing["shape"]>, box: { x: number; y: number; w: number; h: number }) {
    const node: ShapeNode = { kind: "shape", x: 0, y: 0, w: box.w, h: box.h, geom: sh.geom, adj: sh.adj };
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const rot = sh.rot ?? 0;
    const transform = rot || sh.flipH || sh.flipV;
    if (transform) {
      const rad = (-rot * Math.PI) / 180;
      const fx = sh.flipH ? -1 : 1;
      const fy = sh.flipV ? -1 : 1;
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, cx, -cy), concatTransformationMatrix(Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0), concatTransformationMatrix(fx, 0, 0, fy, -cx, cy));
    }
    const fill = sh.fill ? hex(sh.fill) : undefined;
    const line = sh.line;
    if (sh.geom === "line" || sh.geom === "straightConnector1") {
      if (line) page.drawLine({ start: { x: box.x, y: -box.y }, end: { x: box.x + box.w, y: -(box.y + box.h) }, thickness: line.width, color: hex(line.color) });
    } else {
      const d = shapePath(node);
      if (d) page.drawSvgPath(d, { x: box.x, y: -box.y, color: fill, opacity: sh.fillAlpha, borderColor: line ? hex(line.color) : undefined, borderWidth: line?.width ?? 0 });
      else page.drawRectangle({ x: box.x, y: -(box.y + box.h), width: box.w, height: box.h, color: fill, opacity: sh.fillAlpha, borderColor: line ? hex(line.color) : undefined, borderWidth: line?.width ?? 0 });
    }
    if (transform) page.pushOperators(popGraphicsState());
    // Text inside the shape.
    const ins = sh.insets;
    const inner = { x: box.x + ins.l, y: box.y + ins.t, w: Math.max(1, box.w - ins.l - ins.r), h: Math.max(1, box.h - ins.t - ins.b) };
    const paras: { lines: Atom[][]; align: string }[] = [];
    for (const p of sh.paras) {
      const atoms: Atom[] = [];
      for (const r of p.runs) {
        const font: XFont = { name: r.font ?? this.wb.theme.minor.latin ?? "Calibri", size: r.size, bold: r.bold, italic: r.italic, strike: false, color: r.color };
        atoms.push({ text: r.text, font, color: r.color ?? "000000", w: await this.kit.width(r.text.replace(/\n/g, ""), font) });
      }
      paras.push({ lines: await this.wrap(atoms, inner.w), align: p.align });
    }
    if (!paras.some((p) => p.lines.some((l) => l.some((a) => a.text.trim())))) return;
    const measured: { L: Line; align: string }[] = [];
    for (const p of paras) for (const l of p.lines) measured.push({ L: await this.measureLine(l, l[0]?.font ?? this.wb.defaultFont), align: p.align });
    const total = measured.reduce((t, x) => t + x.L.h * 1.0, 0);
    let top = sh.anchor === "ctr" ? inner.y + (inner.h - total) / 2 : sh.anchor === "b" ? inner.y + inner.h - total : inner.y;
    this.clipTo(page, box);
    for (const { L, align } of measured) {
      const base = top + L.h - L.desc;
      let x = align === "ctr" ? inner.x + (inner.w - L.w) / 2 : align === "r" ? inner.x + inner.w - L.w : inner.x;
      for (const a of L.atoms) {
        if (a.text.trim()) await this.drawAtom(page, a, x, base, { font: a.font, border: {} });
        x += a.w;
      }
      top += L.h;
    }
    page.pushOperators(popGraphicsState());
  }
}

const hasBorder = (b: { left?: unknown; right?: unknown; top?: unknown; bottom?: unknown }) => !!(b.left || b.right || b.top || b.bottom);

/** Add link annotations to a page (rectangles in page coordinates, y down from the top). */
export function addLinks(doc: PDFDocument, page: PDFPage, links: { x: number; y: number; w: number; h: number; url?: string; dest?: string }[]) {
  if (!links.length) return;
  const H = page.getHeight();
  const ctx = doc.context;
  const annots = links
    .filter((l) => l.url)
    .map((l) =>
      ctx.register(
        ctx.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [l.x, H - l.y - l.h, l.x + l.w, H - l.y],
          Border: [0, 0, 0],
          A: { Type: "Action", S: "URI", URI: PDFString.of(l.url!) },
        }),
      ),
    );
  if (!annots.length) return;
  const existing = page.node.Annots();
  if (existing) for (const a of annots) existing.push(a);
  else page.node.set(PDFName.of("Annots"), ctx.obj(annots));
}
