/**
 * PDF structure → spreadsheet. Tables become rows and columns with their header, shading and
 * lines; figures become numbers, percentages and amounts with the format they were printed in;
 * dates become dates. Codes that only look like numbers (leading zeros, account numbers) stay
 * text. Text around the tables keeps its place and look, one block per row.
 */
import { listLabel, luminance, type BodyStyle, type Cell, type Furniture, type Run, type SBlock } from "./structure";
import type { Border, XCell, XSheet, XStyle } from "./xlsx";

/* ------------------------------------------------------------------ values */

/** How the document writes numbers and dates: its decimal mark, and the order of day and month. */
export type Locale = { decimal: "." | ","; dates: "dmy" | "mdy" | null };
export type Value = { v: number; fmt?: string };

const SYMBOLS = "$€£¥₹₩₽₺₦₱฿₫₪₴₸";
const CODES = "USD|EUR|GBP|INR|AUD|CAD|JPY|CHF|CNY|SGD|AED|NZD|HKD|ZAR|SEK|NOK|DKK|SAR|MYR|IDR|PHP|THB|KRW|BRL|MXN|PKR|LKR|BDT|NPR";
const PREFIX = new RegExp(`^([${SYMBOLS}]|Rs\\.?|₨|(?:${CODES})(?= ))\\s?`);
const SUFFIX = new RegExp(`\\s?([${SYMBOLS}]|(?:${CODES}))$`);
/** Lakh and crore grouping (12,34,567): Excel groups in thousands unless told otherwise. */
const INDIAN = (f: string) => `[>=10000000]##\\,##\\,##\\,##0${f};[>=100000]##\\,##\\,##0${f};##,##0${f}`;
const quote = (s: string) => `"${s.replace(/"/g, "")}"`;

/**
 * A figure as a number and the Excel format that prints it the same way: grouping, decimals,
 * a currency sign, a percent sign, and how negatives were shown (a minus, brackets, a trailing
 * minus, or Dr and Cr). Null for anything else, and for codes that only look like numbers.
 */
export function parseNumber(raw: string, decimal: "." | "," = "."): Value | null {
  let s = raw
    .trim()
    .replace(/[\u00a0\u202f\u2009\u2007]/g, " ")
    .replace(/[\u2212\u2012\u2013]/g, "-");
  if (!s || s.length > 40 || !/\d/.test(s)) return null;
  let neg: "minus" | "paren" | "trail" | null = null;
  let side: string | null = null;
  const dc = s.match(/^(.*?\d.*?)\s*(?<![A-Za-z])(cr|dr)\.?$/i);
  if (dc) {
    side = dc[2].charAt(0).toUpperCase() + dc[2].slice(1).toLowerCase();
    s = dc[1].trim();
  }
  let pre = "";
  let suf = "";
  let pct = false;
  // Signs, brackets, currency and percent around the digits, in any order.
  for (let k = 0; k < 6; k++) {
    const before = s;
    if (/^\(.*\)$/.test(s) && !neg) {
      neg = "paren";
      s = s.slice(1, -1).trim();
    }
    if (/^-\s?/.test(s) && !neg) {
      neg = "minus";
      s = s.replace(/^-\s?/, "");
    } else if (/^\+\s?/.test(s)) s = s.replace(/^\+\s?/, "");
    if (/\s?-$/.test(s) && !neg) {
      neg = "trail";
      s = s.replace(/\s?-$/, "");
    }
    if (/\s?%$/.test(s) && !pct) {
      pct = true;
      s = s.replace(/\s?%$/, "");
    }
    const p = !pre && s.match(PREFIX);
    if (p) {
      pre = p[0].endsWith(" ") ? `${p[1]} ` : p[1];
      s = s.slice(p[0].length);
    }
    const q = !suf && s.match(SUFFIX);
    if (q) {
      suf = q[0].startsWith(" ") ? ` ${q[1]}` : q[1];
      s = s.slice(0, -q[0].length);
    }
    s = s.trim();
    if (s === before) break;
  }
  const grp = decimal === "." ? "," : "[. ]";
  const dm = decimal === "." ? "\\." : ",";
  const lakhs = decimal === "." ? "|\\d{1,2}(?:,\\d{2})+,\\d{3}" : "";
  const m = s.match(new RegExp(`^(\\d{1,3}(?:${grp}\\d{3})+${lakhs}|\\d+)?(?:${dm}(\\d+))?$`));
  if (!m || (!m[1] && !m[2])) return null;
  const whole = m[1] ?? "0";
  const digits = whole.replace(/\D/g, "");
  const grouped = whole.length !== digits.length;
  const indian = grouped && decimal === "." && /^\d{1,2}(,\d{2})+,\d{3}$/.test(whole) && !/^\d{1,3}(,\d{3})+$/.test(whole);
  // Codes: a leading zero (000142), or too many digits for an amount (an account number).
  if (!grouped && m[1] && ((digits.length > 1 && digits[0] === "0") || (digits.length >= 12 && !m[2]))) return null;
  if (pct && (pre || suf)) return null;
  const frac = m[2] ?? "";
  // (Percentages scaled in the text, so 5.6% is exactly 0.056.)
  let v = Number(`${digits}.${frac || "0"}${pct ? "e-2" : ""}`);
  if (!Number.isFinite(v)) return null;
  if (neg || side === "Dr") v = -v;
  const dec = frac ? "." + "0".repeat(frac.length) : "";
  const plain = !grouped && !frac && !pre && !suf && !pct && !side && neg !== "paren" && neg !== "trail";
  if (plain) return { v };
  // Lakh grouping only where it shows (from 1,00,000), for positive amounts.
  let f = indian && v >= 1e5 && !side && !pct ? INDIAN(dec) : (grouped ? "#,##0" : "0") + dec;
  if (pct) f += "%";
  if (pre) f = f.includes(";") ? f.replace(/(^|;)(\[[^\]]*\])?/g, `$1$2${quote(pre)}`) : quote(pre) + f;
  if (suf) f = f.includes(";") ? f.split(";").map((x) => x + quote(suf)).join(";") : f + quote(suf);
  if (side) f = `${f}${quote(" Cr")};${f}${quote(" Dr")}`;
  else if (neg === "paren") f = `${f};(${f})`;
  else if (neg === "trail") f = `${f};${f}-`;
  return { v, fmt: f };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** "mmmm" for a month written in full, "mmm" for one cut short (Sep, Sept). */
const monthFmt = (w: string, mo: number) => (w.toLowerCase().replace(/\.$/, "") === MONTHS[mo - 1] ? "mmmm" : "mmm");
function monthOf(w: string): number | null {
  const k = w.toLowerCase().replace(/\.$/, "");
  if (k.length < 3) return null;
  if (k === "sept") return 9;
  const i = MONTHS.findIndex((m) => m.startsWith(k));
  return i >= 0 ? i + 1 : null;
}
const year = (y: string) => (y.length === 2 ? (+y < 50 ? 2000 : 1900) + +y : +y);
/** Excel's day number for a date (days since 30 December 1899). */
const serial = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5;
const valid = (y: number, m: number, d: number) => y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const esc = (sep: string) => (sep === " " || sep === ", " ? sep : `\\${sep}`);

/** A date, as Excel's day number and a format that prints it as it was written. */
export function parseDate(raw: string, order: Locale["dates"]): Value | null {
  const s = raw.trim().replace(/\s+/g, " ");
  if (s.length > 24) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return valid(+m[1], +m[2], +m[3]) ? { v: serial(+m[1], +m[2], +m[3]), fmt: "yyyy\\-mm\\-dd" } : null;
  m = s.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})$/);
  if (m) {
    if (!order) return null;
    const [dd, mm] = order === "dmy" ? [m[1], m[3]] : [m[3], m[1]];
    const y = year(m[4]);
    if (!valid(y, +mm, +dd)) return null;
    const d = dd.length === 2 ? "dd" : "d";
    const mo = mm.length === 2 ? "mm" : "m";
    const yy = m[4].length === 2 ? "yy" : "yyyy";
    const sep = esc(m[2]);
    return { v: serial(y, +mm, +dd), fmt: order === "dmy" ? `${d}${sep}${mo}${sep}${yy}` : `${mo}${sep}${d}${sep}${yy}` };
  }
  m = s.match(/^(\d{1,2})([ -])([A-Za-z]{3,9})\.?\2(\d{4}|\d{2})$/);
  if (m) {
    const mo = monthOf(m[3]);
    const y = year(m[4]);
    if (!mo || !valid(y, mo, +m[1])) return null;
    return { v: serial(y, mo, +m[1]), fmt: `${m[1].length === 2 ? "dd" : "d"}${esc(m[2])}${monthFmt(m[3], mo)}${esc(m[2])}${m[4].length === 2 ? "yy" : "yyyy"}` };
  }
  m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2})(,?) (\d{4})$/);
  if (m) {
    const mo = monthOf(m[1]);
    if (!mo || !valid(+m[4], mo, +m[2])) return null;
    return { v: serial(+m[4], mo, +m[2]), fmt: `${monthFmt(m[1], mo)} d${m[3] ? "," : ""} yyyy` };
  }
  return null;
}

/**
 * The document's way with numbers and dates, from all its text: a comma or a point before the
 * decimals, and whether 03/04 is the 3rd of April or the 4th of March (decided only when some
 * date settles it, like 25/08).
 */
export function localeOf(texts: string[]): Locale {
  let us = 0;
  let eu = 0;
  let dmy = 0;
  let mdy = 0;
  for (const t of texts) {
    us += (t.match(/\d,\d{3}\.\d|(?:^|[^\d.,])\d+\.\d{2}(?![\d.,])/g) ?? []).length;
    eu += (t.match(/\d\.\d{3},\d|(?:^|[^\d.,])\d+,\d{2}(?![\d.,])/g) ?? []).length;
    for (const m of t.matchAll(/(?:^|[^\d/.-])(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})(?![\d/.-])/g)) {
      const a = +m[1];
      const b = +m[3];
      if (a > 12 && a <= 31 && b <= 12) dmy++;
      else if (b > 12 && b <= 31 && a <= 12) mdy++;
    }
  }
  const dates = dmy > 0 && dmy >= mdy * 5 ? "dmy" : mdy > 0 && mdy >= dmy * 5 ? "mdy" : null;
  return { decimal: eu > us ? "," : ".", dates };
}

/* ------------------------------------------------------------------ text */

/** Plain text of runs: tabs as `tab` (a space by default), line breaks as newlines, no pictures. */
export const plain = (runs: Run[], tab = " ") =>
  runs
    .map((r) => (r.br ? "\n" : "") + (r.tab !== undefined && r.text.trim() ? tab : "") + (r.pic ? "" : r.text))
    .join("")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();

const hex = (c?: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c.slice(1).toUpperCase() : undefined);

/* ------------------------------------------------------------------ sheets */

type Opts = { oneSheet?: boolean; name: string; font: string; fontOf: (face?: string, family?: BodyStyle["family"]) => string; landscape?: boolean; letter?: boolean };
/** A row of the sheet being built. `span`: a text row that may run across the table columns. `gap`: space above it. */
type Line = { cells: (XCell | null)[]; span?: boolean; gap?: boolean; table?: TableOut; at?: number };
/** A table placed on the sheet: its rows (header first), and how many header rows. */
type TableOut = {
  rows: (XCell | null)[][];
  head: number;
  cols: number;
  widths: number[];
  heights: (number | undefined)[];
  /** Relative column widths, and where it sat across the page (points): to know a table carried on, or set under another. */
  rel: number[];
  x?: { x0: number; x1: number };
  first: string;
  /** Cells across several columns: row, column, how many. */
  spans: [number, number, number][];
};
/** A table carried on from the page before: the same header repeated, or the same columns at (nearly) the same places. */
const sameColumns = (a: TableOut, b: TableOut) => a.cols === b.cols && ((!!a.head && a.first === b.first) || a.rel.every((w, i) => Math.abs(w - (b.rel[i] ?? 0)) < 0.05));

/**
 * A cell as plain text for a CSV file: figures without grouping and with a minus sign
 * (keeping their decimals and a percent sign), dates as year-month-day, text as it is.
 */
export function csvValue(c: XCell): string {
  if (typeof c.v === "string") return c.v;
  const f = (c.style?.numFmt ?? "").split(";")[0].replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  if (/[dmy]/.test(f)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(c.v) * 864e5);
    return d.toISOString().slice(0, 10);
  }
  const dec = f.match(/\.(0+)/)?.[1].length ?? (Number.isInteger(c.v) ? 0 : undefined);
  const pct = f.includes("%");
  const v = pct ? c.v * 100 : c.v;
  const t = dec !== undefined ? v.toFixed(dec) : String(Math.round(v * 1e10) / 1e10);
  return pct ? `${t}%` : t;
}

/** How wide text shows in a sheet, in Excel's units (the width of a "0" in the sheet's font). */
export function textWidth(s: string, st?: XStyle): number {
  let w = 0;
  for (const ch of s) {
    if (/[A-Z]/.test(ch)) w += /[MW]/.test(ch) ? 1.6 : /[IJ]/.test(ch) ? 0.55 : 1.2;
    else if (/[a-z]/.test(ch)) w += /[mw]/.test(ch) ? 1.4 : /[ijl]/.test(ch) ? 0.42 : /[ftr]/.test(ch) ? 0.58 : 0.92;
    else if (/\d/.test(ch)) w += 1;
    else if (/[ .,:;'|!/]/.test(ch)) w += 0.5;
    else if (/[()\-[\]]/.test(ch)) w += 0.6;
    else w += /[@%&]/.test(ch) ? 1.6 : /[\u0900-\u0dff\u3000-\u9fff\uac00-\ud7af]/.test(ch) ? 1.8 : 1;
  }
  return w * ((st?.size ?? 10) / 10) * (st?.bold ? 1.08 : 1);
}

/** How many lines text takes in a column this wide (Excel's units), wrapped at words. */
function linesIn(text: string, width: number, st?: XStyle): number {
  const room = Math.max(3, width - 1.2);
  const space = textWidth(" ", st);
  let n = 0;
  for (const para of text.split("\n")) {
    let line = 0;
    n++;
    for (const w of para.split(" ")) {
      const ww = textWidth(w, st);
      if (line && line + space + ww > room) {
        n++;
        line = ww;
      } else line += (line ? space : 0) + ww;
    }
  }
  return n;
}
/** A row's height for this many lines of text in this size. */
const heightOf = (lines: number, size = 10) => Math.round((lines * size * 1.28 + 3.5) * 4) / 4;

/**
 * The sheets for a document's blocks: one per page, or one for the whole document, where a
 * table carried on from one page to the next is one table (its repeated header dropped).
 */
export function sheetsOf(blocks: SBlock[], body: BodyStyle, furniture: Furniture, o: Opts): XSheet[] {
  const scale = 10 / (body.size || 10);
  const size = (s?: number) => (s ? Math.max(6, Math.min(36, Math.round(s * scale * 2) / 2)) : 10);
  // Every table cell and line of text, to learn how the document writes numbers and dates.
  const texts: string[] = [];
  const collect = (bs: SBlock[]) => {
    for (const b of bs) {
      if (b.kind === "table") b.cells.forEach((r) => r.forEach((c) => (c?.blocks ? collect(c.blocks) : texts.push(c?.text ?? ""))));
      else if (b.kind === "box" || b.kind === "columns") collect(b.blocks);
      else if (b.kind === "para" || b.kind === "heading") texts.push(plain(b.runs));
      else if (b.kind === "list") texts.push(...b.items.map((it) => plain(it)));
    }
  };
  collect(blocks);
  for (const l of [...furniture.header, ...furniture.footer]) texts.push(l.parts.map((p) => p.text).join(" "));
  const loc = localeOf(texts);

  /** The look of a piece of text from its runs: weight, slant, size, colour, face. */
  const look = (runs: Run[], fill?: string): XStyle => {
    const words = runs.filter((r) => r.text.trim() && !r.pic);
    if (!words.length) return {};
    const chars = (f: (r: Run) => boolean) => words.filter(f).reduce((n, r) => n + r.text.trim().length, 0);
    const total = chars(() => true) || 1;
    const main = [...words].sort((a, b) => b.text.trim().length - a.text.trim().length)[0];
    const st: XStyle = {};
    if (chars((r) => r.bold) / total > 0.6) st.bold = true;
    if (chars((r) => r.italic) / total > 0.6) st.italic = true;
    const sz = size(main.size);
    if (sz !== 10) st.size = sz;
    const c = hex(main.color);
    // Light text shows only on the fill it was printed on.
    if (c && c !== "000000" && (luminance("#" + c) < 0.82 || (fill && luminance("#" + fill) < 0.6))) st.color = c;
    const font = o.fontOf(main.face, main.family);
    if (font !== o.font) st.font = font;
    return st;
  };

  /** One table: typed values, the header's look, shading and lines, as drawn. */
  const tableOf = (b: Extract<SBlock, { kind: "table" }>): TableOut => {
    const cols = Math.max(...b.cells.map((r) => r.length));
    const head = b.head ?? (b.header ? 1 : 0);
    const line = (color?: string | null): Border | undefined => (color ? { style: "thin", color: hex(color) ?? "000000" } : undefined);
    const grid = b.lines === "grid" ? line(b.lineColor ?? "#000000") : undefined;
    const rows = b.cells.map((r, ri) =>
      Array.from({ length: cols }, (_, ci): XCell | null => {
        const c: Cell | undefined = r[ci];
        const fill = hex(c?.fill);
        const runs = c ? c.paras.flat() : [];
        let text = c ? c.paras.map((p) => plain(p)).join("\n") : "";
        // A value written after its label's colon (Account No : 1234) without the colon.
        if (ri >= head && ci > 0 && /^:\s/.test(text) && r[ci - 1]?.text.trim()) text = text.replace(/^:\s+/, "");
        const st: XStyle = { ...look(runs, fill) };
        if (fill) st.fill = fill;
        if (c?.align) st.align = c.align;
        if (c?.valign) st.valign = c.valign;
        // Set in from the column's other text (an item under its group): Excel indents in steps of about 9 points.
        if (c?.indent) Object.assign(st, { indent: Math.max(1, Math.round((c.indent * scale) / 9)), align: st.align ?? "left" });
        const top = grid ?? (b.lines === "rows" ? line(b.rowRules?.[ri]) : undefined);
        const bottom = grid ?? (b.lines === "rows" && ri === b.cells.length - 1 ? line(b.rowRules?.[ri + 1]) : undefined);
        if (top || bottom || grid) st.border = { ...(top ? { top } : {}), ...(bottom ? { bottom } : {}), ...(grid ? { left: grid, right: grid } : {}) };
        let v: string | number = text;
        if (ri >= head && text && !text.includes("\n")) {
          const val = parseDate(text, loc.dates) ?? parseNumber(text, loc.decimal);
          if (val) {
            v = val.v;
            if (val.fmt) st.numFmt = val.fmt;
            // Figures printed flush left stay flush left (Excel would set them flush right).
            if (!st.align) st.align = "left";
          }
        }
        if (typeof v === "string" && v.includes("\n")) st.wrap = true;
        return v === "" && !Object.keys(st).length ? null : { v, style: st };
      }),
    );
    // A cell across several columns: the cells it covers take its look (its shading, its lines).
    const spans: [number, number, number][] = [];
    b.cells.forEach((r, ri) =>
      r.forEach((c, ci) => {
        const n = Math.min(c?.span ?? 1, cols - ci);
        if (n < 2 || !rows[ri][ci]) return;
        spans.push([ri, ci, n]);
        const st = rows[ri][ci]!.style ?? {};
        for (let k = 1; k < n; k++) rows[ri][ci + k] = { v: "", style: { ...st } };
        if (ri < head) rows[ri][ci] = { ...rows[ri][ci]!, style: { ...st, align: "center" } };
      }),
    );
    const spanAt = (ri: number, ci: number) => spans.find(([sr, sc]) => sr === ri && sc === ci);
    // Column widths: figures in full, a header wrapped at its words if need be, other text up
    // to a point (longer text wraps in its cell).
    const widths = Array.from({ length: cols }, (_, ci) => {
      let w = 3;
      rows.forEach((r, ri) => {
        const c = r[ci];
        if (!c || c.v === "" || spanAt(ri, ci)) return;
        const shown = typeof c.v === "number" ? textWidth(b.cells[ri][ci]?.text ?? String(c.v), c.style) + 1 : Math.max(...String(c.v).split("\n").map((t) => textWidth(t, c.style)));
        const want = ri < head ? Math.min(shown, Math.max(10, ...String(c.v).split(/\s+/).map((t) => textWidth(t, c.style)))) : Math.min(shown, 70);
        w = Math.max(w, want + 1.6);
      });
      return w;
    });
    // A table wider than a screen gives its widest text columns less room (their text wraps).
    for (let guard = 0; guard < 20 && widths.reduce((a, w) => a + w, 0) > 170; guard++) {
      const widest = widths.indexOf(Math.max(...widths));
      if (widths[widest] <= 30) break;
      widths[widest] = Math.max(30, widths[widest] - (widths.reduce((a, w) => a + w, 0) - 170));
    }
    // Room for a cell: its column, or all the columns it spans.
    const room = (ri: number, ci: number) => {
      const sp = spanAt(ri, ci);
      return sp ? widths.slice(ci, ci + sp[2]).reduce((a, w) => a + w, 0) : widths[ci];
    };
    rows.forEach((r, ri) =>
      r.forEach((c, ci) => {
        if (c && typeof c.v === "string" && c.v && textWidth(c.v, c.style) > room(ri, ci) - 1.2) c.style = { ...c.style, wrap: true };
      }),
    );
    // Rows with lines of text set at the top, as cells are in the PDF.
    rows.forEach((r) => {
      if (r.some((c) => c?.style?.wrap)) r.forEach((c) => c?.style && !c.style.valign && (c.style.valign = "top"));
    });
    const heights = rows.map((r, ri) => {
      const lines = Math.max(1, ...r.map((c, ci) => (c && typeof c.v === "string" && c.v && c.style?.wrap ? linesIn(c.v, room(ri, ci), c.style) : 1)));
      const big = Math.max(10, ...r.map((c) => c?.style?.size ?? 10));
      return lines > 1 || big > 10 ? heightOf(lines, big) : undefined;
    });
    const x = b.span ? { x0: b.span.x, x1: b.span.x + b.span.w } : undefined;
    return { rows, head, cols, widths, heights, rel: b.widths, x, first: b.cells[0]?.map((c) => c?.text ?? "").join("|") ?? "", spans };
  };

  const sheets: { name: string; lines: Line[] }[] = [];
  let cur: Line[] = [];
  const push = (l: Line) => cur.push(l);
  let lastTable: TableOut | null = null;
  let crossed = false;

  const textBlock = (runs: Run[], gap = false) => {
    const parts = plain(runs, "\t").split("\t").map((t) => t.trim());
    const st = look(runs);
    if (!parts.join("")) return;
    push({ cells: parts.map((t) => (t ? { v: t, style: st } : null)), gap, span: parts.length === 1 });
  };

  const walk = (bs: SBlock[]) => {
    bs.forEach((b, k) => {
      const prev = bs[k - 1];
      const spaced = !!prev && "geo" in prev && !!prev.geo && (prev.geo.gap ?? 0) > ((b as { geo?: { first: number } }).geo?.first || body.size) * 0.8;
      if (b.kind === "pagebreak") {
        if (!o.oneSheet) {
          sheets.push({ name: `Page ${sheets.length + 1}`, lines: cur });
          cur = [];
          lastTable = null;
        } else crossed = true;
        return;
      }
      if (b.kind === "heading") {
        textBlock(b.runs, cur.length > 0);
        lastTable = null;
      } else if (b.kind === "para") textBlock(b.runs, spaced);
      else if (b.kind === "list") {
        b.items.forEach((it, i) => {
          const label = listLabel(b, i);
          const st = { ...look(it), ...(b.levels[i] ? { indent: b.levels[i] * 2 } : {}) };
          const t = plain(it);
          if (t) push({ cells: [{ v: label ? `${label} ${t}` : t, style: st }], gap: i === 0 && spaced, span: true });
        });
      } else if (b.kind === "box" || b.kind === "columns") walk(b.blocks);
      else if (b.kind === "table" && (b.layout || b.lines === "cards" || b.cells.some((r) => r.some((c) => c?.blocks?.length)))) {
        // Content set side by side for the page's look: one part after the other.
        for (const r of b.cells) for (const c of r) if (c?.blocks?.length) walk(c.blocks);
      } else if (b.kind === "table") {
        const t = tableOf(b);
        // Carried on from the last page: the same columns. Its header, repeated, is dropped.
        if (o.oneSheet && crossed && lastTable && sameColumns(lastTable, t)) {
          const drop = t.first === lastTable.first ? Math.max(1, t.head) : 0;
          const at = lastTable.rows.length - drop;
          lastTable.spans.push(...t.spans.filter(([r]) => r >= drop).map(([r, c, n]): [number, number, number] => [r + at, c, n]));
          lastTable.rows.push(...t.rows.slice(drop));
          lastTable.heights.push(...t.heights.slice(drop));
          lastTable.widths = lastTable.widths.map((w, i) => Math.max(w, t.widths[i] ?? 0));
        } else {
          // A small table set under the right-hand end of the one before it (totals under an
          // invoice's amounts) keeps to those columns.
          const prevLine = [...cur].reverse().find((l) => l.table || l.cells.length);
          const above = prevLine?.table;
          const under = above && above.x && t.x && t.cols < above.cols && Math.abs(above.x.x1 - t.x.x1) < 8 && t.x.x0 - above.x.x0 > (above.x.x1 - above.x.x0) * 0.25;
          push({ cells: [], table: t, gap: cur.length > 0, at: under ? (prevLine!.at ?? 0) + above.cols - t.cols : 0 });
          lastTable = t;
        }
        crossed = false;
        return;
      }
      if (b.kind !== "rule" && b.kind !== "image") crossed = false;
    });
  };
  // The running header (letterhead) once at the top; page numbers left out.
  const furn = (lines: Furniture["header"]) =>
    lines.flatMap((l) => {
      const parts = l.parts.filter((p) => !/\{PAGES?\}/.test(p.text) && p.text.trim());
      if (!parts.length) return [];
      const st: XStyle = { ...(l.bold ? { bold: true } : {}), ...(l.italic ? { italic: true } : {}), ...(size(l.size) !== 10 ? { size: size(l.size) } : {}), ...(hex(l.color) && hex(l.color) !== "000000" && luminance(l.color!) < 0.82 ? { color: hex(l.color) } : {}) };
      return [{ parts: parts.map((p) => ({ text: p.text.trim(), at: p.at, style: st })) }];
    });
  const heads = furn(furniture.header);
  const feet = furn(furniture.footer);
  walk(blocks);
  sheets.push({ name: o.oneSheet ? o.name : `Page ${sheets.length + 1}`, lines: cur });

  return sheets.map((sh, si): XSheet => {
    const placed = sh.lines.filter((l) => l.table);
    const cols = Math.max(1, ...placed.map((l) => (l.at ?? 0) + l.table!.cols), ...sh.lines.map((l) => (l.span ? 1 : l.cells.length)));
    // Column widths: the widest any table needs there; a sheet of text alone gets one wide column.
    const widths = Array.from({ length: cols }, (_, c) => Math.max(8, ...placed.map((l) => l.table!.widths[c - (l.at ?? 0)] ?? 0)));
    if (!placed.length) widths[0] = Math.max(widths[0], 90);
    // Text in columns of its own (a line set with tabs) widens them as needed.
    for (const l of sh.lines) if (!l.table && !l.span) l.cells.forEach((c, k) => c && typeof c.v === "string" && (widths[k] = Math.max(widths[k], Math.min(60, textWidth(c.v, c.style) + 1.6))));
    const total = widths.reduce((a, b) => a + b, 0);
    const rows: (XCell | null)[][] = [];
    const heights: (number | undefined)[] = [];
    const merges: [number, number, number, number][] = [];
    let filter: XSheet["filter"];
    let best = 0;
    const blank = () => {
      rows.push([]);
      heights.push(undefined);
    };
    // A piece of the running header: left, centre or right across the sheet's columns.
    const place = (parts: { text: string; at: string; style: XStyle }[]) => {
      const row: (XCell | null)[] = [];
      for (const p of parts) {
        const c = p.at === "left" || cols === 1 ? 0 : p.at === "right" ? cols - 1 : Math.floor((cols - 1) / 2);
        row[c] = row[c] ? { v: `${row[c]!.v} ${p.text}`, style: row[c]!.style } : { v: p.text, style: { ...p.style, ...(p.at === "right" && c > 0 ? { align: "right" } : p.at === "center" && c > 0 ? { align: "center" } : {}) } };
      }
      rows.push(row);
      heights.push((Math.max(...parts.map((p) => p.style.size ?? 10)) > 10 ? heightOf(1, Math.max(...parts.map((p) => p.style.size ?? 10))) : undefined));
    };
    if (si === 0 && heads.length) {
      heads.forEach((l) => place(l.parts));
      blank();
    }
    sh.lines.forEach((l, li) => {
      if (l.gap && rows.length && rows[rows.length - 1].length) blank();
      if (l.table) {
        const t = l.table;
        const at = l.at ?? 0;
        const r0 = rows.length;
        t.rows.forEach((r, k) => {
          rows.push(at ? [...Array<XCell | null>(at).fill(null), ...r] : r);
          heights.push(t.heights[k]);
        });
        for (const [sr, sc, n] of t.spans) merges.push([r0 + sr, at + sc, r0 + sr, at + sc + n - 1]);
        if (t.head && t.rows.length - t.head >= 8 && t.rows.length > best) {
          best = t.rows.length;
          filter = [r0 + t.head - 1, at, rows.length - 1, at + t.cols - 1];
        }
        // A blank row after a table, before whatever follows.
        if (li < sh.lines.length - 1) blank();
        return;
      }
      const c0 = l.cells[0];
      if (l.span && c0 && typeof c0.v === "string") {
        // Text wider than the first column runs on across the columns, wrapped (and merged) if
        // wider still; lines broken on purpose stay broken.
        const lines = c0.v.includes("\n");
        const wide = textWidth(c0.v, c0.style) > widths[0] - 1.2;
        if (lines || (wide && textWidth(c0.v, c0.style) > total - 1.2)) {
          const span = cols > 1 && (wide || lines) ? total : widths[0];
          const style = { ...c0.style, wrap: true, valign: "top" as const };
          const r = rows.length;
          rows.push([{ v: c0.v, style }]);
          if (cols > 1 && span === total) merges.push([r, 0, r, cols - 1]);
          heights.push(heightOf(linesIn(c0.v, span, style), style.size ?? 10));
          return;
        }
        rows.push([c0]);
        heights.push((c0.style?.size ?? 10) > 10 ? heightOf(1, c0.style!.size!) : undefined);
        return;
      }
      rows.push(l.cells);
      heights.push(undefined);
    });
    if (si === sheets.length - 1 && feet.length) {
      blank();
      feet.forEach((l) => place(l.parts));
    }
    while (rows.length && !rows[rows.length - 1].length) {
      rows.pop();
      heights.pop();
    }
    // Printed across one page's width; turned sideways for a wide sheet or a page set sideways.
    return { name: sh.name, rows, widths, heights, merges, ...(filter ? { filter } : {}), print: { fitWidth: true, landscape: !!o.landscape || total > 120, letter: !!o.letter } };
  });
}
