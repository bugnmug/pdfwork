/**
 * What a cell looks like once table styles and conditional formats are laid
 * over its own style: font, fill, borders, and a data bar if it has one.
 */
import { hexOf, rgbOf, type Theme } from "../ooxml";
import { cellRef } from "./read";
import { applyTint } from "./read";
import type { Cell, CfRule, Dxf, Range, Sheet, Workbook, XBorder, XBorderSide, XFont, XStyle, XTable } from "./model";
import { TABLE_STYLES, type TsColor, type TsDxf } from "./tablestyles";

export type Look = { font: XFont; fill?: string; border: XBorder; bar?: { frac: number; color: string; gradient: boolean } };
type Overlay = { font?: Partial<XFont>; fill?: string; border?: XBorder; bar?: Look["bar"] };

const THEME_ORDER = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
const key = (r: number, c: number) => r * 16384 + c;
const inRange = (rg: Range, r: number, c: number) => r >= rg.r0 && r <= rg.r1 && c >= rg.c0 && c <= rg.c1;

function tsColor(c: TsColor | null | undefined, theme: Theme): string | undefined {
  if (c == null) return undefined;
  if (typeof c === "string") return c.startsWith("i") ? (c === "i64" ? "000000" : undefined) : c.toUpperCase();
  const base = theme.colors[THEME_ORDER[c[0]] ?? "dk1"] ?? "000000";
  return applyTint(base.toUpperCase(), c[1] ?? 0);
}

/* ---------------------------------------------------------------- tables */

/** Table style formats for every cell of a table. */
function tableOverlays(t: XTable, wb: Workbook, out: Map<number, Overlay>) {
  if (!t.style) return;
  const name = t.style.replace(/^TableStyle/, "");
  const custom = wb.customTableStyles.get(t.style);
  const preset = TABLE_STYLES[name];
  if (!custom && !preset) return;
  const theme = wb.theme;
  // Each part of the style as an overlay (custom styles come as dxfs already resolved).
  const part = (type: string): (Overlay & { n?: number }) | null => {
    if (custom) {
      const d = custom[type];
      return d ? { font: d.font, fill: d.fill, border: d.border, n: d.size } : null;
    }
    const d: TsDxf | undefined = preset?.[type];
    if (!d) return null;
    const side = (k: "l" | "r" | "t" | "b" | "h" | "v"): XBorderSide | undefined => (d.bd?.[k] ? { style: d.bd[k]![0], color: tsColor(d.bd[k]![1], theme) ?? "000000" } : undefined);
    const font: Partial<XFont> = {};
    if (d.b) font.bold = true;
    if (d.i) font.italic = true;
    if (d.c) font.color = tsColor(d.c, theme);
    return {
      font: Object.keys(font).length ? font : undefined,
      fill: tsColor(d.f, theme),
      border: d.bd ? { left: side("l"), right: side("r"), top: side("t"), bottom: side("b"), insideH: side("h"), insideV: side("v") } as XBorder & { insideH?: XBorderSide; insideV?: XBorderSide } : undefined,
      n: d.n,
    };
  };
  const { r0, c0, r1, c1 } = t.ref;
  const hdr = t.header > 0 ? r0 : -1;
  const tot = t.totals > 0 ? r1 : -1;
  const bodyR0 = r0 + (t.header > 0 ? 1 : 0);
  const bodyR1 = r1 - (t.totals > 0 ? 1 : 0);
  // Parts in increasing precedence, each over the block of cells it covers.
  const blocks: { o: Overlay; rg: Range }[] = [];
  const add = (type: string, rg: Range | null) => {
    const o = part(type);
    if (o && rg && rg.r0 <= rg.r1 && rg.c0 <= rg.c1) blocks.push({ o, rg });
  };
  add("wholeTable", t.ref);
  if (t.colStripes) {
    const a = part("firstColumnStripe")?.n ?? 1;
    const b = part("secondColumnStripe")?.n ?? 1;
    for (let c = c0, i = 0; c <= c1; i++) {
      const n = i % 2 ? b : a;
      add(i % 2 ? "secondColumnStripe" : "firstColumnStripe", { r0: bodyR0, r1: bodyR1, c0: c, c1: Math.min(c1, c + n - 1) });
      c += n;
    }
  }
  if (t.rowStripes) {
    const a = part("firstRowStripe")?.n ?? 1;
    const b = part("secondRowStripe")?.n ?? 1;
    for (let r = bodyR0, i = 0; r <= bodyR1; i++) {
      const n = i % 2 ? b : a;
      add(i % 2 ? "secondRowStripe" : "firstRowStripe", { r0: r, r1: Math.min(bodyR1, r + n - 1), c0, c1 });
      r += n;
    }
  }
  if (t.firstCol) add("firstColumn", { r0, r1, c0, c1: c0 });
  if (t.lastCol) add("lastColumn", { r0, r1, c0: c1, c1 });
  if (hdr >= 0) add("headerRow", { r0: hdr, r1: hdr, c0, c1 });
  if (tot >= 0) add("totalRow", { r0: tot, r1: tot, c0, c1 });
  if (hdr >= 0 && t.firstCol) add("firstHeaderCell", { r0: hdr, r1: hdr, c0, c1: c0 });
  if (hdr >= 0 && t.lastCol) add("lastHeaderCell", { r0: hdr, r1: hdr, c0: c1, c1 });
  if (tot >= 0 && t.firstCol) add("firstTotalCell", { r0: tot, r1: tot, c0, c1: c0 });
  if (tot >= 0 && t.lastCol) add("lastTotalCell", { r0: tot, r1: tot, c0: c1, c1 });
  for (const { o, rg } of blocks) {
    const bd = o.border as (XBorder & { insideH?: XBorderSide; insideV?: XBorderSide }) | undefined;
    for (let r = rg.r0; r <= rg.r1; r++) {
      for (let c = rg.c0; c <= rg.c1; c++) {
        const k = key(r, c);
        const cur = out.get(k) ?? {};
        if (o.font) cur.font = { ...cur.font, ...o.font };
        if (o.fill) cur.fill = o.fill;
        if (bd) {
          const b: XBorder = { ...cur.border };
          const pick = (edge: boolean, outer?: XBorderSide, inner?: XBorderSide) => (edge ? outer : inner);
          const l = pick(c === rg.c0, bd.left, bd.insideV);
          const rr = pick(c === rg.c1, bd.right, bd.insideV);
          const tp = pick(r === rg.r0, bd.top, bd.insideH);
          const bt = pick(r === rg.r1, bd.bottom, bd.insideH);
          if (l) b.left = l;
          if (rr) b.right = rr;
          if (tp) b.top = tp;
          if (bt) b.bottom = bt;
          cur.border = b;
        }
        out.set(k, cur);
      }
    }
  }
}

/* -------------------------------------------------------- conditional formats */

const numOf = (cell: Cell | undefined): number | null => (cell && cell.t === "n" && typeof cell.v === "number" ? cell.v : null);
const textOf = (cell: Cell | undefined): string => (cell?.v == null ? "" : typeof cell.v === "boolean" ? (cell.v ? "TRUE" : "FALSE") : String(cell.v));

/** A rule's formula as a value: a number, a quoted string, or a reference to a cell (relative to the range's corner). */
function operand(f: string, sheet: Sheet, rg: Range, r: number, c: number): number | string | null {
  const s = f.trim().replace(/^=/, "");
  if (/^-?\d+(\.\d+)?(E[-+]?\d+)?$/i.test(s)) return Number(s);
  const q = /^"(.*)"$/.exec(s);
  if (q) return q[1].replace(/""/g, '"');
  const m = /^(?:'?[^!']*'?!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(s);
  if (m) {
    const ref = cellRef(`${m[2]}${m[4]}`)!;
    const rr = m[3] ? ref.r : ref.r + (r - rg.r0);
    const cc = m[1] ? ref.c : ref.c + (c - rg.c0);
    const cell = sheet.cells.get(rr)?.get(cc);
    return cell?.v == null ? 0 : typeof cell.v === "number" ? cell.v : typeof cell.v === "boolean" ? (cell.v ? 1 : 0) : String(cell.v);
  }
  return null;
}

function compare(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1; // numbers sort before text
  if (typeof b === "number") return 1;
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function threshold(v: { type: string; val?: string }, sorted: number[], fallback: number, sheet: Sheet, rg: Range): number {
  const n = Number(v.val);
  switch (v.type) {
    case "min":
      return sorted[0] ?? fallback;
    case "max":
      return sorted[sorted.length - 1] ?? fallback;
    case "num":
      return Number.isFinite(n) ? n : (Number(operand(v.val ?? "", sheet, rg, rg.r0, rg.c0)) || fallback);
    case "percent":
      return (sorted[0] ?? 0) + ((sorted[sorted.length - 1] ?? 0) - (sorted[0] ?? 0)) * ((Number.isFinite(n) ? n : 50) / 100);
    case "percentile":
      return quantile(sorted, (Number.isFinite(n) ? n : 50) / 100);
    case "formula": {
      const x = operand(v.val ?? "", sheet, rg, rg.r0, rg.c0);
      return typeof x === "number" ? x : fallback;
    }
    default:
      return fallback;
  }
}

const mix = (a: string, b: string, t: number) => {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return hexOf(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
};

function cfOverlays(sheet: Sheet, wb: Workbook, out: Map<number, Overlay>) {
  type Hit = { rule: CfRule; o: Overlay };
  const hits = new Map<number, Hit[]>();
  const push = (r: number, c: number, rule: CfRule, o: Overlay) => {
    const k = key(r, c);
    let list = hits.get(k);
    if (!list) hits.set(k, (list = []));
    list.push({ rule, o });
  };
  const dxfOverlay = (d?: Dxf): Overlay => ({ font: d?.font, fill: d?.fill, border: d?.border });
  for (const block of sheet.cf) {
    // The values a rule ranks or averages over: all its ranges together.
    const cells: { r: number; c: number; cell?: Cell }[] = [];
    for (const rg of block.ranges) {
      for (let r = rg.r0; r <= Math.min(rg.r1, rg.r0 + 100000); r++) {
        const row = sheet.cells.get(r);
        for (let c = rg.c0; c <= Math.min(rg.c1, rg.c0 + 1000); c++) cells.push({ r, c, cell: row?.get(c) });
      }
    }
    const nums = cells.map((x) => numOf(x.cell)).filter((v): v is number => v !== null);
    const sorted = [...nums].sort((a, b) => a - b);
    const rg0 = block.ranges[0];
    for (const rule of block.rules) {
      switch (rule.type) {
        case "cellIs": {
          for (const x of cells) {
            if (x.cell?.v == null || x.cell.v === "") continue;
            const v = typeof x.cell.v === "number" ? x.cell.v : typeof x.cell.v === "boolean" ? (x.cell.v ? 1 : 0) : String(x.cell.v);
            const a = operand(rule.formulas[0] ?? "", sheet, rg0, x.r, x.c);
            const b = operand(rule.formulas[1] ?? "", sheet, rg0, x.r, x.c);
            if (a === null) continue;
            const ca = compare(v, a);
            let ok = false;
            switch (rule.operator) {
              case "lessThan":
                ok = ca < 0;
                break;
              case "lessThanOrEqual":
                ok = ca <= 0;
                break;
              case "greaterThan":
                ok = ca > 0;
                break;
              case "greaterThanOrEqual":
                ok = ca >= 0;
                break;
              case "equal":
                ok = ca === 0;
                break;
              case "notEqual":
                ok = ca !== 0;
                break;
              case "between":
              case "notBetween": {
                if (b === null) break;
                const lo = compare(a, b) <= 0 ? a : b;
                const hi = lo === a ? b : a;
                const inside = compare(v, lo) >= 0 && compare(v, hi) <= 0;
                ok = rule.operator === "between" ? inside : !inside;
                break;
              }
            }
            if (ok) push(x.r, x.c, rule, dxfOverlay(rule.dxf));
          }
          break;
        }
        case "containsText":
        case "notContainsText":
        case "beginsWith":
        case "endsWith": {
          const needle = (rule.text ?? "").toLowerCase();
          for (const x of cells) {
            const t = textOf(x.cell).toLowerCase();
            const ok = rule.type === "containsText" ? t.includes(needle) : rule.type === "notContainsText" ? !t.includes(needle) : rule.type === "beginsWith" ? t.startsWith(needle) : t.endsWith(needle);
            if (ok && (rule.type === "notContainsText" || t)) push(x.r, x.c, rule, dxfOverlay(rule.dxf));
          }
          break;
        }
        case "containsBlanks":
        case "notContainsBlanks":
          for (const x of cells) if ((textOf(x.cell).trim() === "") === (rule.type === "containsBlanks")) push(x.r, x.c, rule, dxfOverlay(rule.dxf));
          break;
        case "containsErrors":
        case "notContainsErrors":
          for (const x of cells) if ((x.cell?.t === "e") === (rule.type === "containsErrors")) push(x.r, x.c, rule, dxfOverlay(rule.dxf));
          break;
        case "top10": {
          if (!sorted.length) break;
          const rank = rule.rank ?? 10;
          const count = rule.percent ? Math.max(1, Math.floor((sorted.length * rank) / 100)) : rank;
          const cut = rule.bottom ? sorted[Math.min(sorted.length, count) - 1] : sorted[Math.max(0, sorted.length - count)];
          for (const x of cells) {
            const v = numOf(x.cell);
            if (v !== null && (rule.bottom ? v <= cut : v >= cut)) push(x.r, x.c, rule, dxfOverlay(rule.dxf));
          }
          break;
        }
        case "aboveAverage": {
          if (!nums.length) break;
          const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
          for (const x of cells) {
            const v = numOf(x.cell);
            if (v === null) continue;
            const ok = rule.aboveAverage !== false ? v > avg || (!!rule.equalAverage && v === avg) : v < avg || (!!rule.equalAverage && v === avg);
            if (ok) push(x.r, x.c, rule, dxfOverlay(rule.dxf));
          }
          break;
        }
        case "duplicateValues":
        case "uniqueValues": {
          const counts = new Map<string, number>();
          for (const x of cells) {
            const t = textOf(x.cell).toLowerCase();
            if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
          }
          for (const x of cells) {
            const t = textOf(x.cell).toLowerCase();
            if (t && ((counts.get(t) ?? 0) > 1) === (rule.type === "duplicateValues")) push(x.r, x.c, rule, dxfOverlay(rule.dxf));
          }
          break;
        }
        case "colorScale": {
          const cv = rule.cfvos ?? [];
          const cols = rule.colors ?? [];
          if (cv.length < 2 || cols.length < 2 || !sorted.length) break;
          const t0 = threshold(cv[0], sorted, sorted[0], sheet, rg0);
          const tN = threshold(cv[cv.length - 1], sorted, sorted[sorted.length - 1], sheet, rg0);
          const tM = cv.length === 3 ? threshold(cv[1], sorted, (t0 + tN) / 2, sheet, rg0) : null;
          for (const x of cells) {
            const v = numOf(x.cell);
            if (v === null) continue;
            let color: string;
            if (tM === null) color = mix(cols[0], cols[1], tN === t0 ? 0 : Math.min(1, Math.max(0, (v - t0) / (tN - t0))));
            else if (v <= tM) color = mix(cols[0], cols[1], tM === t0 ? 1 : Math.min(1, Math.max(0, (v - t0) / (tM - t0))));
            else color = mix(cols[1], cols[2], tN === tM ? 1 : Math.min(1, Math.max(0, (v - tM) / (tN - tM))));
            push(x.r, x.c, rule, { fill: color });
          }
          break;
        }
        case "dataBar": {
          const cv = rule.cfvos ?? [];
          if (!sorted.length) break;
          const lo = threshold(cv[0] ?? { type: "min" }, sorted, sorted[0], sheet, rg0);
          const hi = threshold(cv[1] ?? { type: "max" }, sorted, sorted[sorted.length - 1], sheet, rg0);
          for (const x of cells) {
            const v = numOf(x.cell);
            if (v === null) continue;
            // Excel keeps every bar at least a tenth long.
            const f = hi === lo ? 1 : Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
            push(x.r, x.c, rule, { bar: { frac: 0.1 + 0.9 * f, color: rule.barColor ?? "638EC6", gradient: rule.gradient !== false } });
          }
          break;
        }
        case "iconSet":
          wb.warnings.add("icon sets");
          break;
        case "expression":
        case "timePeriod":
          wb.warnings.add("formula-based conditional formats");
          break;
      }
    }
  }
  // Apply in priority order: the highest priority (lowest number) wins each property.
  for (const [k, list] of hits) {
    list.sort((a, b) => b.rule.priority - a.rule.priority);
    const cur = out.get(k) ?? {};
    let stopAt = Infinity;
    for (const h of [...list].reverse()) if (h.rule.stop) stopAt = Math.min(stopAt, h.rule.priority);
    for (const h of list) {
      if (h.rule.priority > stopAt) continue;
      if (h.o.font) cur.font = { ...cur.font, ...h.o.font };
      if (h.o.fill) cur.fill = h.o.fill;
      if (h.o.border) cur.border = { ...cur.border, ...Object.fromEntries(Object.entries(h.o.border).filter(([, v]) => v)) };
      if (h.o.bar) cur.bar = h.o.bar;
    }
    out.set(k, cur);
  }
}

/* --------------------------------------------------------------- the look */

export class Looks {
  private tables = new Map<number, Overlay>();
  private cf = new Map<number, Overlay>();
  constructor(
    private wb: Workbook,
    private sheet: Sheet,
  ) {
    for (const t of sheet.tables) tableOverlays(t, wb, this.tables);
    cfOverlays(sheet, wb, this.cf);
  }

  /** The style index a cell shows: its own, else its row's, else its column's. */
  styleIndex(r: number, c: number, cell?: Cell): number {
    if (cell) return cell.s;
    const row = this.sheet.rows.get(r);
    if (row?.s != null) return row.s;
    const col = this.sheet.cols.find((x) => c >= x.min && c <= x.max);
    return col?.s ?? 0;
  }

  style(r: number, c: number, cell?: Cell): XStyle {
    return this.wb.styles[this.styleIndex(r, c, cell)] ?? this.wb.styles[0];
  }

  look(r: number, c: number, cell?: Cell): Look {
    const st = this.style(r, c, cell);
    const k = key(r, c);
    const t = this.tables.get(k);
    const f = this.cf.get(k);
    if (!t && !f) return { font: st.font, fill: st.fill, border: st.border };
    let font = st.font;
    let fill = st.fill;
    const border: XBorder = { ...st.border };
    if (t) {
      // A table's look gives way to the cell's own formatting.
      const plain = font.name === this.wb.defaultFont.name && font.size === this.wb.defaultFont.size && !font.bold && !font.italic && (font.color ?? "000000") === (this.wb.defaultFont.color ?? "000000");
      if (t.font && plain) font = { ...font, ...t.font };
      if (!fill && t.fill) fill = t.fill;
      for (const s of ["left", "right", "top", "bottom"] as const) if (!border[s] && t.border?.[s]) border[s] = t.border[s];
    }
    if (f) {
      if (f.font) font = { ...font, ...f.font };
      if (f.fill) fill = f.fill;
      for (const s of ["left", "right", "top", "bottom"] as const) if (f.border?.[s]) border[s] = f.border[s];
    }
    return { font, fill, border, bar: f?.bar };
  }

  /** Cells with a table or conditional look (to count them as printed). */
  hasOverlay(r: number, c: number): boolean {
    const k = key(r, c);
    return !!this.tables.get(k)?.fill || !!this.cf.get(k)?.fill;
  }
}

export { inRange };
