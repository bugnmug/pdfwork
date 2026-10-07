/**
 * Office charts (c:chartSpace) drawn as vector graphics, for Word, Excel and
 * PowerPoint: column and bar (clustered, stacked, 100%), line, area, scatter,
 * radar (as lines), pie and doughnut, combined charts with a secondary axis.
 * Titles, axes with their own fonts, colours, lines, tick marks and number
 * formats, gridlines, markers, legends and data labels follow the chart's own
 * formatting, manual layouts included.
 */
import { concatTransformationMatrix, popGraphicsState, pushGraphicsState, type PDFPage } from "@cantoo/pdf-lib";
import { rgb } from "../core";
import { attr, drawingColor, kid, kids, num, path, type El, type Theme } from "../ooxml";

export type ChartTextOpt = { bold?: boolean; italic?: boolean; color?: string; align?: "left" | "center" | "right"; font?: string };
export type ChartText = (text: string, x: number, baseline: number, size: number, opt: ChartTextOpt) => Promise<void>;
export type ChartMeasure = (text: string, size: number, bold?: boolean, font?: string) => Promise<number>;

type Tx = { size: number; color: string; bold: boolean; italic: boolean; font?: string };
type Stroke = { color: string; width: number; alpha: number; dash?: number[] } | null;
type Marker = { symbol: string; size: number; fill?: string | null; line?: string | null };
type Labels = { val: boolean; pct: boolean; cat: boolean; ser: boolean; pos: string; tx: Tx; fmt?: string };
type Series = {
  name: string;
  cats: string[];
  vals: (number | null)[];
  xs?: number[];
  fill?: string | null;
  line?: Stroke;
  points: Map<number, string>;
  pointLines: Map<number, Stroke>;
  explode: Map<number, number>;
  explosion: number;
  fmt?: string;
  labels: Labels | null;
  pointLabels: Map<number, Labels | null>;
  marker: Marker | null;
  smooth: boolean;
  idx: number;
};
type Plot = { kind: string; dir: string; grouping: string; series: Series[]; gap: number; overlap: number; hole: number; vary: boolean; firstAng: number; axIds: string[]; markersOn: boolean; radar: string };

const hex = (h: string) => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
const on = (el: El | null | undefined, d = false) => (el ? attr(el, "val") !== "0" && attr(el, "val") !== "false" : d);

function strCache(el: El | null): string[] {
  const cache = el?.getElementsByTagNameNS("*", "strCache")[0] ?? el?.getElementsByTagNameNS("*", "numCache")[0] ?? el?.getElementsByTagNameNS("*", "strLit")[0] ?? el?.getElementsByTagNameNS("*", "numLit")[0];
  if (!cache) {
    const lvl = el?.getElementsByTagNameNS("*", "lvl")[0];
    if (!lvl) return [];
    return kids(lvl, "pt").map((p) => kid(p, "v")?.textContent ?? "");
  }
  const n = num(attr(kid(cache, "ptCount"), "val"), 0);
  const out: string[] = Array(n).fill("");
  const fmt = kid(cache, "formatCode")?.textContent ?? undefined;
  for (const p of kids(cache, "pt")) {
    const v = kid(p, "v")?.textContent ?? "";
    const pf = attr(p, "formatCode") ?? fmt;
    out[num(attr(p, "idx"))] = cache.localName === "numCache" && pf && v !== "" && Number.isFinite(Number(v)) ? formatValue(Number(v), pf) : v;
  }
  return out;
}

function numCache(el: El | null): { vals: (number | null)[]; fmt?: string } {
  const cache = el?.getElementsByTagNameNS("*", "numCache")[0] ?? el?.getElementsByTagNameNS("*", "numLit")[0];
  if (!cache) return { vals: [] };
  const n = num(attr(kid(cache, "ptCount"), "val"), 0);
  const vals: (number | null)[] = Array(n).fill(null);
  for (const p of kids(cache, "pt")) {
    const v = Number(kid(p, "v")?.textContent);
    vals[num(attr(p, "idx"))] = Number.isFinite(v) ? v : null;
  }
  return { vals, fmt: kid(cache, "formatCode")?.textContent ?? undefined };
}

/** Excel's serial date to a JavaScript date (1900 system). */
const serialDate = (v: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000));

/** Number formats as Excel writes them, the common cases (dates included). */
export function formatValue(v: number, code?: string): string {
  const c = (code ?? "General").split(";")[v < 0 && (code ?? "").includes(";") ? 1 : 0] ?? "General";
  const clean = c.replace(/\[\$-[0-9A-Fa-f]+\]/g, "").replace(/\[[^\]]*\]/g, "");
  if (/[dmyhs]/i.test(clean.replace(/"[^"]*"/g, "")) && !/0|#/.test(clean)) {
    const d = serialDate(v);
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return clean.replace(/"([^"]*)"|yyyy|yy|mmmm|mmm|mm|m|dd|d/gi, (t, lit) => {
      if (lit !== undefined) return lit;
      switch (t.toLowerCase()) {
        case "yyyy":
          return String(d.getUTCFullYear());
        case "yy":
          return String(d.getUTCFullYear()).slice(2);
        case "mmmm":
          return months[d.getUTCMonth()];
        case "mmm":
          return mon[d.getUTCMonth()];
        case "mm":
          return String(d.getUTCMonth() + 1).padStart(2, "0");
        case "m":
          return String(d.getUTCMonth() + 1);
        case "dd":
          return String(d.getUTCDate()).padStart(2, "0");
        case "d":
          return String(d.getUTCDate());
      }
      return t;
    });
  }
  if (/%/.test(clean)) {
    const d = (clean.split(".")[1]?.match(/0/g) ?? []).length;
    return `${(v * 100).toFixed(d)}%`;
  }
  if (clean === "General" || !clean || !/[0#]/.test(clean)) {
    const r = Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 1000) / 1000;
    return String(r);
  }
  const d = (clean.split(".")[1]?.match(/[0#]/g) ?? []).length;
  const grouped = /#,##|0,0/.test(clean);
  let s = Math.abs(v).toFixed(d);
  if (grouped) {
    const [i, f] = s.split(".");
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? `.${f}` : "");
  }
  const prefix = (c.match(/^"?([$₹€£¥])"?/) ?? c.match(/\[\$([^\]-]+)/))?.[1] ?? "";
  const suffix = /"([^"]*)"\s*$/.exec(clean)?.[1] ?? "";
  return `${v < 0 ? "-" : ""}${prefix}${s}${suffix}`;
}

/**
 * Excel's automatic value axis: from zero unless the data sit far from it (all within the top
 * sixth), a twentieth of the data's span as headroom past them, and the finest 1-2-5 step that
 * gives at most `maxN` intervals whose labels fit. Fixed bounds and a fixed step are kept as set.
 */
export function axisScale(vmin: number, vmax: number, o: { min?: number; max?: number; unit?: number; maxN?: number; fits?: (lo: number, hi: number, step: number) => boolean } = {}): { lo: number; hi: number; step: number } {
  let a = Number.isFinite(vmin) ? vmin : 0;
  let b = Number.isFinite(vmax) ? vmax : 1;
  if (a > b) [a, b] = [b, a];
  if (a === b) {
    if (a === 0) b = 1;
    else if (a > 0) a = 0;
    else b = 0;
  }
  const span = b - a;
  let lo: number;
  let hi: number;
  // (Peltier's description of Excel: from zero unless the minimum is at least 5/6 of the
  // maximum; the maximum a twentieth of the data's span past the highest value.)
  if (o.min !== undefined) lo = o.min;
  else if (a >= 0) lo = a < (b * 5) / 6 ? 0 : a - span / 20;
  else lo = a - span / 20;
  if (o.max !== undefined) hi = o.max;
  else if (b <= 0) hi = -b < (-a * 5) / 6 ? 0 : b + span / 20;
  else hi = b + (b - (o.min ?? a)) / 20;
  const maxN = Math.max(1, o.maxN ?? 10);
  let step = o.unit && o.unit > 0 ? o.unit : 0;
  if (!step) {
    const mag = Math.pow(10, Math.floor(Math.log10((hi - lo) / maxN || 1)));
    const ok = (u: number) => {
      const l = o.min ?? Math.floor(lo / u + 1e-9) * u;
      const h = o.max ?? Math.ceil(hi / u - 1e-9) * u;
      return Math.round((h - l) / u) <= maxN && (!o.fits || o.fits(l, h, u));
    };
    step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].map((m) => m * mag).find(ok) ?? 1000 * mag;
  }
  return { lo: o.min ?? Math.floor(lo / step + 1e-9) * step, hi: o.max ?? Math.ceil(hi / step - 1e-9) * step, step };
}

/** Optional painting the host can do better: picture, gradient and pattern fills of the chart and plot areas. */
export type ChartHost = {
  fill?: (spPr: El, rect: { x: number; y: number; w: number; h: number }) => Promise<boolean>;
  /** The text size of a chart that sets none: 10 pt in Word and Excel, the presentation's default (18 pt) in PowerPoint. */
  textSize?: number;
};

function richText(el: El | null): string {
  if (!el) return "";
  return Array.from(el.getElementsByTagNameNS("*", "p"))
    .map((p) => Array.from(p.getElementsByTagNameNS("*", "t")).map((t) => t.textContent ?? "").join(""))
    .join(" ");
}

export async function drawChart(page: PDFPage, chartDoc: Document, theme: Theme, box: { x: number; y: number; w: number; h: number }, text: ChartText, measure: ChartMeasure, map: Record<string, string> = {}, host: ChartHost = {}) {
  const H = page.getHeight();
  const root = chartDoc.documentElement;
  // pdf-lib's path parser reads neither exponents nor NaN: write plain numbers.
  const svgPath = (d: string, o: Parameters<PDFPage["drawSvgPath"]>[1]) => page.drawSvgPath(d.replace(/-?[\d.]+e[-+]?\d+|NaN|-?Infinity/gi, (m) => (Number.isFinite(Number(m)) ? Number(m).toFixed(4) : "0")), o);
  const chart = kid(root, "chart");
  if (!chart) return;
  const color = (el: El | null | undefined) => (el ? (drawingColor(el, theme, map)?.hex ?? null) : null);
  // Automatic colours follow the chart style (c:style 1..48): a grey ramp, the six accents,
  // or one accent in shades, darker for the first series and lighter for the last.
  let styleN = 2;
  for (const el of Array.from(root.children)) {
    if (el.localName === "style") styleN = num(attr(el, "val"), 2);
    if (el.localName === "AlternateContent") {
      const st = el.getElementsByTagNameNS("*", "style")[0];
      if (st) styleN = num(attr(st, "val"), 2);
    }
  }
  if (styleN > 100) styleN -= 100;
  styleN = Math.max(1, Math.min(48, styleN));
  const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const scratch = new DOMParser().parseFromString(`<w xmlns:a="${A_NS}"/>`, "application/xml");
  const modHex = (node: string, val: string, mods: [string, number][]) => {
    const w = scratch.createElementNS(A_NS, "a:w");
    const c = scratch.createElementNS(A_NS, `a:${node}`);
    c.setAttribute("val", val);
    for (const [k, v] of mods) {
      const m = scratch.createElementNS(A_NS, `a:${k}`);
      m.setAttribute("val", String(Math.round(v)));
      c.appendChild(m);
    }
    w.appendChild(c);
    return drawingColor(w, theme, map)?.hex ?? "4472C4";
  };
  const GREYS = styleN === 41 ? [5000, 55000, 78000, 15000, 70000, 30000] : [88500, 55000, 78000, 92500, 70000, 30000];
  const totalSeries = Math.max(1, chart.getElementsByTagNameNS("*", "ser").length);
  const accent = (i: number, n = totalSeries) => {
    const col = (styleN - 1) % 8;
    let base: string;
    let cycle: number;
    let maxCycle: number;
    if (col <= 1) {
      base = col === 1 || styleN === 42 ? modHex("schemeClr", `accent${(i % 6) + 1}`, []) : modHex("schemeClr", "dk1", [["tint", GREYS[i % 6]]]);
      cycle = Math.floor(i / 6);
      maxCycle = Math.floor((n - 1) / 6);
    } else {
      base = modHex("schemeClr", `accent${col - 1}`, []);
      cycle = i;
      maxCycle = n - 1;
    }
    const t = ((cycle + 1) / (maxCycle + 2)) * 1.4 - 0.7;
    if (Math.abs(t) < 1e-6) return base;
    return modHex("srgbClr", base, [[t < 0 ? "shade" : "tint", t < 0 ? (1 + t) * 100000 : (1 - t) * 100000]]);
  };
  // What an element looks like when the chart leaves it unformatted: the chart style's
  // automatic formatting (ECMA-376's table, as Office has drawn it since 2007).
  const sch = (v: string, mods: [string, number][] = []) => modHex("schemeClr", v, mods);
  const auto = {
    text: sch(styleN >= 41 ? "lt1" : "tx1"),
    area: sch(styleN <= 32 ? "bg1" : styleN <= 40 ? "lt1" : "dk1"),
    plot: styleN <= 32 ? sch("bg1") : styleN <= 34 ? sch("dk1", [["tint", 20000]]) : styleN <= 40 ? sch(`accent${styleN - 34}`, [["tint", 20000]]) : sch("dk1", [["tint", 95000]]),
    axis: { color: sch(styleN <= 32 ? "tx1" : "dk1", [["tint", 75000]]), width: 0.75, alpha: 1 } as Stroke,
    minor: { color: sch("tx1", [["tint", styleN <= 40 ? 50000 : 90000]]), width: 0.75, alpha: 1 } as Stroke,
    lineW: styleN <= 8 ? 2.25 : styleN >= 25 && styleN <= 32 ? 5.25 : 3.75,
    /** Outline of bars and slices; series `i` matters for style 34. */
    border: (i: number): Stroke | undefined => {
      const w = 0.75;
      if (styleN >= 9 && styleN <= 16) return { color: sch("lt1"), width: w, alpha: 1 };
      if (styleN === 33) return { color: sch("dk1", [["shade", 50000]]), width: w, alpha: 1 };
      if (styleN === 34) return { color: sch(`accent${(i % 6) + 1}`, [["shade", 50000]]), width: w, alpha: 1 };
      if (styleN >= 35 && styleN <= 40) return { color: sch(`accent${styleN - 34}`, [["shade", 50000]]), width: w, alpha: 1 };
      return undefined;
    },
  };
  /* ----- formatting readers */
  const txOf = (el: El | null | undefined, base: Tx): Tx => {
    if (!el) return base;
    const r = el.getElementsByTagNameNS("*", "defRPr")[0] ?? el.getElementsByTagNameNS("*", "rPr")[0];
    if (!r) return base;
    const sz = attr(r, "sz");
    const b = attr(r, "b");
    const i = attr(r, "i");
    const c = color(kid(r, "solidFill"));
    const font = attr(kid(r, "latin"), "typeface") ?? undefined;
    return { size: sz ? Math.max(4, Math.min(40, num(sz) / 100)) : base.size, bold: b !== null ? b === "1" || b === "true" : base.bold, italic: i !== null ? i === "1" || i === "true" : base.italic, color: c ?? base.color, font: font && !font.startsWith("+") ? font : base.font };
  };
  const strokeOf = (spPr: El | null | undefined, d: Stroke | undefined): Stroke | undefined => {
    const ln = kid(spPr, "ln");
    if (!ln) return d;
    if (kid(ln, "noFill")) return null;
    const sf = kid(ln, "solidFill") ?? kid(ln, "gradFill")?.getElementsByTagNameNS("*", "gs")[0] ?? null;
    const c = sf ? drawingColor(sf, theme, map) : null;
    if (!c && !d) return d;
    const w = attr(ln, "w");
    const dashV = attr(kid(ln, "prstDash"), "val");
    const width = w !== null ? Math.max(0.25, num(w) / 12700) : (d?.width ?? 0.75);
    const dash = dashV && dashV !== "solid" ? (/dot/i.test(dashV) ? [width, width * 2] : [width * 4, width * 3]) : undefined;
    return { color: c?.hex ?? d!.color, width, alpha: c?.alpha ?? 1, dash };
  };
  const fillOf = (spPr: El | null | undefined): string | null | undefined => {
    if (!spPr) return undefined;
    if (kid(spPr, "noFill")) return null;
    const sf = kid(spPr, "solidFill") ?? kid(spPr, "gradFill")?.getElementsByTagNameNS("*", "gs")[0] ?? kid(spPr, "pattFill") ?? null;
    if (!sf) return undefined;
    return sf.localName === "pattFill" ? color(kid(sf, "fgClr")) : color(sf);
  };
  const line = (x1: number, y1: number, x2: number, y2: number, s: Stroke | undefined) => {
    if (!s) return;
    page.drawLine({ start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 }, thickness: s.width, color: hex(s.color), opacity: s.alpha < 1 ? s.alpha : undefined, dashArray: s.dash });
  };

  const baseTx = txOf(kid(root, "txPr"), { size: host.textSize ?? 10, color: auto.text, bold: false, italic: false });
  const globalSize = attr(kid(root, "txPr")?.getElementsByTagNameNS("*", "defRPr")[0], "sz");
  const say = (t: string, x: number, base: number, tx: Tx, align: ChartTextOpt["align"] = "left") => text(t, x, base, tx.size, { color: tx.color, bold: tx.bold, italic: tx.italic, align, font: tx.font });
  const width = (t: string, tx: Tx) => measure(t, tx.size, tx.bold, tx.font);

  // Chart area: its fill (a picture or gradient through the host, when it can), then its outline.
  const area = kid(root, "spPr");
  const areaFill = fillOf(area);
  const areaLine = strokeOf(area, null);
  if (areaFill !== null && !(area && host.fill && (await host.fill(area, box)))) page.drawRectangle({ x: box.x, y: H - box.y - box.h, width: box.w, height: box.h, color: hex(areaFill ?? auto.area) });
  if (areaLine) {
    const i = areaLine.width / 2;
    const r = on(kid(root, "roundedCorners")) ? Math.min(box.w, box.h) * 0.06 : 0;
    const [x0, y0, x1, y1] = [box.x + i, box.y + i, box.x + box.w - i, box.y + box.h - i];
    const k = r * 0.5523;
    const d = r
      ? `M ${x0 + r} ${y0} L ${x1 - r} ${y0} C ${x1 - r + k} ${y0} ${x1} ${y0 + r - k} ${x1} ${y0 + r} L ${x1} ${y1 - r} C ${x1} ${y1 - r + k} ${x1 - r + k} ${y1} ${x1 - r} ${y1} L ${x0 + r} ${y1} C ${x0 + r - k} ${y1} ${x0} ${y1 - r + k} ${x0} ${y1 - r} L ${x0} ${y0 + r} C ${x0} ${y0 + r - k} ${x0 + r - k} ${y0} ${x0 + r} ${y0} Z`
      : `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`;
    svgPath(d, { x: 0, y: H, borderColor: hex(areaLine.color), borderWidth: areaLine.width, borderOpacity: areaLine.alpha < 1 ? areaLine.alpha : undefined, borderDashArray: areaLine.dash });
  }
  const pa = kid(chart, "plotArea");
  if (!pa) return;
  const manual = (el: El | null) => {
    const m = kid(kid(el, "layout"), "manualLayout");
    if (!m) return null;
    const v = (k: string) => (kid(m, k) ? num(attr(kid(m, k), "val")) : null);
    return { x: v("x"), y: v("y"), w: v("w"), h: v("h"), inner: attr(kid(m, "layoutTarget"), "val") === "inner" };
  };

  /* ----- series */
  const axes = new Map<string, El>();
  for (const ax of Array.from(pa.children)) if (/Ax$/.test(ax.localName)) axes.set(attr(kid(ax, "axId"), "val") ?? "", ax);
  const plots: Plot[] = [];
  for (const p of Array.from(pa.children)) {
    if (!/Chart$/.test(p.localName)) continue;
    const kind = p.localName.replace(/3DChart$/, "Chart");
    const pie = kind === "pieChart" || kind === "doughnutChart" || kind === "ofPieChart";
    const vary = attr(kid(p, "varyColors"), "val") !== null ? on(kid(p, "varyColors")) : pie;
    const markersOn = kind === "scatterChart" ? true : kind === "lineChart" ? on(kid(p, "marker"), true) : kind === "radarChart" ? attr(kid(p, "radarStyle"), "val") === "marker" : false;
    const scatterStyle = attr(kid(p, "scatterStyle"), "val") ?? "lineMarker";
    const series: Series[] = [];
    for (const s of kids(p, "ser")) {
      const idx = num(attr(kid(s, "idx"), "val"), series.length);
      const spPr = kid(s, "spPr");
      const lineKind = kind === "lineChart" || kind === "radarChart" || (kind === "scatterChart" && scatterStyle !== "marker");
      const defColor = accent(idx);
      const fill = fillOf(spPr);
      const ln = strokeOf(spPr, lineKind ? { color: fill ?? defColor, width: auto.lineW, alpha: 1 } : auto.border(idx));
      const points = new Map<number, string>();
      const pointLines = new Map<number, Stroke>();
      const explode = new Map<number, number>();
      for (const dp of kids(s, "dPt")) {
        const i = num(attr(kid(dp, "idx"), "val"));
        const c = fillOf(kid(dp, "spPr"));
        if (c) points.set(i, c);
        const pl = strokeOf(kid(dp, "spPr"), undefined);
        if (pl !== undefined) pointLines.set(i, pl);
        if (kid(dp, "explosion")) explode.set(i, num(attr(kid(dp, "explosion"), "val")));
      }
      const v = numCache(kid(s, "val") ?? kid(s, "yVal"));
      // x values: numbers, or 1, 2, 3... when they are text (as Excel plots them).
      const xNums = numCache(kid(s, "xVal")).vals;
      const xs = kind === "scatterChart" || kind === "bubbleChart" ? (xNums.some((x) => x !== null) ? xNums.map((x, i) => x ?? i + 1) : v.vals.map((_, i) => i + 1)) : undefined;
      const readLabels = (dl: El | null | undefined, base: Labels | null): Labels | null => {
        if (!dl) return base;
        if (on(kid(dl, "delete"))) return null;
        const flag = (k: string, d: boolean) => (kid(dl, k) ? on(kid(dl, k)) : d);
        const l: Labels = {
          val: flag("showVal", base?.val ?? false),
          pct: flag("showPercent", base?.pct ?? false),
          cat: flag("showCatName", base?.cat ?? false),
          ser: flag("showSerName", base?.ser ?? false),
          pos: attr(kid(dl, "dLblPos"), "val") ?? base?.pos ?? "",
          tx: txOf(kid(dl, "txPr"), base?.tx ?? baseTx),
          fmt: attr(kid(dl, "numFmt"), "formatCode") ?? base?.fmt,
        };
        return l;
      };
      const chartLabels = readLabels(kid(p, "dLbls"), null);
      const serDl = kid(s, "dLbls");
      const labels = readLabels(serDl, chartLabels);
      const pointLabels = new Map<number, Labels | null>();
      for (const d of kids(serDl, "dLbl")) pointLabels.set(num(attr(kid(d, "idx"), "val")), readLabels(d, labels));
      const mk = kid(s, "marker");
      const sym = attr(kid(mk, "symbol"), "val");
      const symbols = ["diamond", "square", "triangle", "x", "star", "circle", "plus", "dash"];
      let marker: Marker | null = null;
      if ((markersOn || sym) && sym !== "none" && (kind === "lineChart" || kind === "scatterChart" || kind === "radarChart")) {
        const mfill = fillOf(kid(mk, "spPr"));
        const mline = strokeOf(kid(mk, "spPr"), undefined);
        marker = { symbol: sym ?? symbols[idx % symbols.length], size: num(attr(kid(mk, "size"), "val"), 5), fill: mfill === undefined ? (ln?.color ?? fill ?? defColor) : mfill, line: mline === undefined ? (ln?.color ?? fill ?? defColor) : mline ? mline.color : null };
      }
      series.push({
        name: strCache(kid(s, "tx"))[0] ?? kid(kid(s, "tx"), "v")?.textContent ?? `Series ${idx + 1}`,
        cats: strCache(kid(s, "cat") ?? kid(s, "xVal")),
        vals: v.vals,
        xs,
        fill: fill === undefined ? undefined : fill,
        line: ln,
        points,
        pointLines,
        explode,
        explosion: num(attr(kid(s, "explosion"), "val")),
        fmt: v.fmt,
        labels,
        pointLabels,
        marker,
        smooth: on(kid(s, "smooth")),
        idx,
      });
    }
    plots.push({
      kind,
      dir: attr(kid(p, "barDir"), "val") ?? "col",
      grouping: attr(kid(p, "grouping"), "val") ?? "clustered",
      series,
      gap: num(attr(kid(p, "gapWidth"), "val"), 150),
      overlap: num(attr(kid(p, "overlap"), "val"), 0),
      hole: num(attr(kid(p, "holeSize"), "val"), 50),
      vary,
      firstAng: num(attr(kid(p, "firstSliceAng"), "val")),
      axIds: kids(p, "axId").map((a) => attr(a, "val") ?? ""),
      markersOn,
      radar: attr(kid(p, "radarStyle"), "val") ?? "standard",
    });
  }
  const allSeries = plots.flatMap((p) => p.series);
  const pie = plots.some((p) => p.kind === "pieChart" || p.kind === "doughnutChart" || p.kind === "ofPieChart");
  const seriesColor = (p: Plot, s: Series, k: number) => s.fill ?? s.line?.color ?? (p.vary && p.series.length === 1 ? accent(0) : accent(s.idx ?? k));

  let top = box.y + 7;
  let bottom = box.y + box.h - 7;
  let left = box.x + 7;
  let right = box.x + box.w - 7;

  /* ----- title */
  const titleEl = kid(chart, "title");
  const autoDeleted = on(kid(chart, "autoTitleDeleted"));
  let title = richText(path(titleEl, "tx", "rich"));
  // A title with no text of its own shows the series name, or "Chart Title" for several.
  if (!title && titleEl && !autoDeleted && !on(kid(titleEl, "delete"))) title = allSeries.length === 1 ? allSeries[0].name : !pie && allSeries.length > 1 ? "Chart Title" : (allSeries[0]?.name ?? "");
  if (title) {
    // Unformatted, a title is bold and a fifth larger than the chart's text (18 pt by default).
    const ttx = txOf(path(titleEl, "tx", "rich") ?? kid(titleEl, "txPr"), { ...baseTx, bold: true, size: globalSize ? Math.round(num(globalSize) * 1.2) / 100 : host.textSize ? Math.round(host.textSize * 12) / 10 : 18 });
    const ml = manual(titleEl);
    const tx = ml?.x !== null && ml?.x !== undefined ? box.x + ml.x * box.w + (await width(title, ttx)) / 2 : box.x + box.w / 2;
    const ty = ml?.y !== null && ml?.y !== undefined ? box.y + ml.y * box.h + ttx.size : top + ttx.size;
    await say(title, tx, ty, ttx, "center");
    if (!on(kid(titleEl, "overlay"))) top = Math.max(top, ty + ttx.size * 0.6);
  }

  /* ----- legend */
  const legend = kid(chart, "legend");
  const legendPos = attr(kid(legend, "legendPos"), "val") ?? "r";
  const deleted = new Set(kids(legend, "legendEntry").filter((le) => on(kid(le, "delete"))).map((le) => num(attr(kid(le, "idx"), "val"))));
  type Entry = { name: string; fill?: string | null; line?: Stroke; marker?: Marker | null };
  let entries: Entry[] = [];
  if (pie) {
    const p = plots.find((q) => q.kind === "pieChart" || q.kind === "doughnutChart" || q.kind === "ofPieChart")!;
    const s = p.series[0];
    entries = (s?.cats ?? []).map((c, i) => ({ name: c, fill: s.points.get(i) ?? (p.vary ? accent(i, Math.max(1, s.vals.length)) : seriesColor(p, s, 0)) }));
  } else
    for (const p of plots)
      p.series.forEach((s, k) => {
        const lineKind = p.kind === "lineChart" || p.kind === "radarChart" || (p.kind === "scatterChart" && !!s.line);
        entries.push(lineKind ? { name: s.name, line: s.line ?? { color: seriesColor(p, s, k), width: 2, alpha: 1 }, marker: s.marker } : { name: s.name, fill: seriesColor(p, s, k), line: s.line });
      });
  entries = entries.filter((_, i) => !deleted.has(i));
  const keyOf = (x: number, base: number, sw: number, e: Entry) => {
    if (e.line && e.fill === undefined) {
      line(x, base - sw * 0.35, x + sw * 1.8, base - sw * 0.35, e.line && { ...e.line, width: Math.min(e.line.width, 2.25) });
      if (e.marker) marker(x + sw * 0.9, base - sw * 0.35, { ...e.marker, size: Math.min(e.marker.size, 7) });
      return sw * 1.8;
    }
    page.drawRectangle({ x, y: H - base + sw * 0.05, width: sw, height: sw * 0.85, color: e.fill ? hex(e.fill) : undefined, borderColor: e.line ? hex(e.line.color) : undefined, borderWidth: e.line ? Math.min(1, e.line.width) : 0 });
    return sw;
  };
  const marker = (x: number, y: number, m: Marker) => {
    const r = Math.max(1.5, m.size * 0.75) / 2 + 0.5;
    const fill = m.fill ? hex(m.fill) : undefined;
    const border = m.line ? hex(m.line) : undefined;
    const opts = { color: fill, borderColor: border, borderWidth: border ? 0.75 : 0 };
    switch (m.symbol) {
      case "circle":
      case "dot":
        page.drawEllipse({ x, y: H - y, xScale: r, yScale: r, ...opts });
        break;
      case "square":
        page.drawRectangle({ x: x - r, y: H - y - r, width: 2 * r, height: 2 * r, ...opts });
        break;
      case "diamond":
        svgPath(`M ${x} ${y - r * 1.2} L ${x + r * 1.2} ${y} L ${x} ${y + r * 1.2} L ${x - r * 1.2} ${y} Z`, { x: 0, y: H, ...opts });
        break;
      case "triangle":
        svgPath(`M ${x} ${y - r * 1.2} L ${x + r * 1.1} ${y + r * 0.9} L ${x - r * 1.1} ${y + r * 0.9} Z`, { x: 0, y: H, ...opts });
        break;
      case "x":
      case "star":
      case "plus":
      case "dash": {
        const c = border ?? fill ?? rgb(0.3, 0.3, 0.3);
        const segs = m.symbol === "dash" ? [[-r, 0, r, 0]] : m.symbol === "plus" ? [[-r, 0, r, 0], [0, -r, 0, r]] : m.symbol === "x" ? [[-r, -r, r, r], [-r, r, r, -r]] : [[-r, -r, r, r], [-r, r, r, -r], [0, -r, 0, r]];
        for (const [a, b, cc, d] of segs) page.drawLine({ start: { x: x + a, y: H - y - b }, end: { x: x + cc, y: H - y - d }, thickness: 1, color: c });
        break;
      }
      default:
        page.drawEllipse({ x, y: H - y, xScale: r, yScale: r, ...opts });
    }
  };
  if (legend && entries.length) {
    const ltx = txOf(kid(legend, "txPr"), baseTx);
    const sw = ltx.size * 0.7;
    const ml = manual(legend);
    const widths = await Promise.all(entries.map(async (e) => (e.line && e.fill === undefined ? sw * 1.8 : sw) + 4 + (await width(e.name, ltx)) + 10));
    const lineH = ltx.size * 1.35;
    const horizontal = legendPos === "b" || legendPos === "t";
    if (ml && ml.x !== null && ml.y !== null) {
      // Placed where the chart says, entries in rows that fit its width.
      const lx = box.x + ml.x * box.w;
      const ly = box.y + ml.y * box.h;
      const lw = ml.w !== null ? ml.w * box.w : box.w - (lx - box.x);
      let x = lx;
      let y = ly + lineH * 0.8;
      const rowW = widths.reduce((a, b) => a + b, 0);
      if (horizontal && rowW <= lw) x = lx + (lw - rowW) / 2;
      for (let i = 0; i < entries.length; i++) {
        if (!horizontal && i) {
          x = lx;
          y += lineH;
        } else if (x + widths[i] > lx + lw + 1 && x > lx) {
          x = lx;
          y += lineH;
        }
        const kw = keyOf(x, y, sw, entries[i]);
        await say(entries[i].name, x + kw + 4, y, ltx);
        x += widths[i];
      }
      if (!on(kid(legend, "overlay"))) {
        if (legendPos === "b") bottom = Math.min(bottom, ly - 2);
        else if (legendPos === "t") top = Math.max(top, ly + lineH + 2);
        else if (legendPos === "r") right = Math.min(right, lx - 6);
        else if (legendPos === "l") left = Math.max(left, lx + Math.max(...widths) + 4);
      }
    } else if (horizontal) {
      const total = widths.reduce((a, b) => a + b, 0);
      let x = box.x + Math.max(8, (box.w - total) / 2);
      const y = legendPos === "b" ? bottom - ltx.size * 0.25 : top + ltx.size;
      for (let i = 0; i < entries.length; i++) {
        const kw = keyOf(x, y, sw, entries[i]);
        await say(entries[i].name, x + kw + 4, y, ltx);
        x += widths[i];
      }
      if (legendPos === "b") bottom -= ltx.size * 1.9;
      else top += ltx.size * 1.9;
    } else {
      const widest = Math.max(...widths);
      const lw = Math.min(box.w * 0.4, widest);
      const lx = legendPos === "l" ? box.x + 8 : box.x + box.w - 8 - lw;
      let y = top + (bottom - top) / 2 - (entries.length * lineH) / 2 + ltx.size;
      for (const e of entries) {
        const kw = keyOf(lx, y, sw, e);
        await say(e.name, lx + kw + 4, y, ltx);
        y += lineH;
      }
      if (legendPos === "l") left += lw + 8;
      else right -= lw + 8;
    }
  }
  if (!allSeries.length || right - left < 20 || bottom - top < 20) return;
  const plotML = manual(pa);

  /* ----- pie and doughnut */
  if (pie) {
    const p = plots.find((q) => q.kind === "pieChart" || q.kind === "doughnutChart" || q.kind === "ofPieChart")!;
    const s = p.series[0];
    if (!s) return;
    const vals = s.vals.map((v) => Math.max(0, v ?? 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    let cx = (left + right) / 2;
    let cy = (top + bottom) / 2;
    let r = Math.min(right - left, bottom - top) / 2 - 4;
    if (plotML && plotML.x !== null && plotML.y !== null && plotML.w && plotML.h) {
      const pw = plotML.w * box.w;
      const ph = plotML.h * box.h;
      cx = box.x + plotML.x * box.w + pw / 2;
      cy = box.y + plotML.y * box.h + ph / 2;
      r = Math.min(pw, ph) / 2;
    }
    const anyExplode = s.explosion > 0 || s.explode.size > 0;
    if (anyExplode) r *= 0.85;
    const hole = p.kind === "doughnutChart" ? (r * p.hole) / 100 : 0;
    const border = s.line ?? undefined;
    let ang = ((p.firstAng - 90) * Math.PI) / 180;
    for (let i = 0; i < vals.length; i++) {
      const sweep = (vals[i] / total) * Math.PI * 2;
      if (sweep <= 0) continue;
      const ex = ((s.explode.get(i) ?? s.explosion) / 100) * r;
      const mid = ang + sweep / 2;
      const ox = cx + ex * Math.cos(mid);
      const oy = cy + ex * Math.sin(mid);
      const steps = Math.max(2, Math.ceil(sweep / 0.05));
      let d = hole ? `M ${ox + hole * Math.cos(ang)} ${oy + hole * Math.sin(ang)}` : `M ${ox} ${oy}`;
      for (let k = 0; k <= steps; k++) {
        const a = ang + (sweep * k) / steps;
        d += ` L ${ox + r * Math.cos(a)} ${oy + r * Math.sin(a)}`;
      }
      if (hole)
        for (let k = steps; k >= 0; k--) {
          const a = ang + (sweep * k) / steps;
          d += ` L ${ox + hole * Math.cos(a)} ${oy + hole * Math.sin(a)}`;
        }
      d += " Z";
      const fill = s.points.get(i) ?? (p.vary ? accent(i, Math.max(1, vals.length)) : seriesColor(p, s, 0));
      const edge = s.pointLines.has(i) ? s.pointLines.get(i) : border;
      svgPath(d, { x: 0, y: H, color: hex(fill), borderColor: edge ? hex(edge.color) : undefined, borderWidth: edge ? edge.width : 0 });
      const lb = s.pointLabels.has(i) ? s.pointLabels.get(i)! : s.labels;
      if (lb && (lb.val || lb.pct || lb.cat || lb.ser)) {
        const parts: string[] = [];
        if (lb.ser) parts.push(s.name);
        if (lb.cat) parts.push(s.cats[i] ?? "");
        if (lb.val) parts.push(formatValue(s.vals[i] ?? 0, lb.fmt ?? s.fmt));
        if (lb.pct) parts.push(`${Math.round((vals[i] / total) * 100)}%`);
        const outside = lb.pos === "outEnd" || lb.pos === "bestFit" && sweep < 0.35;
        const lr = outside ? r + lb.tx.size * 1.2 : hole ? (r + hole) / 2 : lb.pos === "inEnd" ? r * 0.8 : r * 0.62;
        await say(parts.join(" "), ox + lr * Math.cos(mid), oy + lr * Math.sin(mid) + lb.tx.size * 0.35, lb.tx, "center");
      }
      ang += sweep;
    }
    return;
  }

  /* ----- axes */
  const horizontal = plots.some((p) => p.kind === "barChart" && p.dir === "bar");
  const scatter = plots.every((p) => p.kind === "scatterChart" || p.kind === "bubbleChart");
  const nCat = Math.max(...allSeries.map((s) => Math.max(s.cats.length, s.vals.length)), 1);
  const cats = allSeries.find((s) => s.cats.length)?.cats ?? Array.from({ length: nCat }, (_, i) => String(i + 1));
  // Which value axis each plot uses: the first is primary, another one secondary.
  const valAxes = [...axes.values()].filter((a) => a.localName === "valAx");
  const catAxEl = [...axes.values()].find((a) => a.localName === "catAx" || a.localName === "dateAx") ?? (scatter ? valAxes.find((a) => /^[bt]$/.test(attr(kid(a, "axPos"), "val") ?? "")) : undefined) ?? null;
  const valOf = (p: Plot) => p.axIds.map((id) => axes.get(id)).find((a) => a && a.localName === "valAx" && a !== catAxEl) ?? valAxes.find((a) => a !== catAxEl) ?? null;
  const primaryVal = valOf(plots[0]);
  type Scale = { lo: number; hi: number; step: number; el: El | null; fmt?: string; deleted: boolean; tx: Tx; reversed: boolean; labels: string[]; secondary: boolean };
  const scales = new Map<El | null, Scale>();
  // Data extents per value axis (plots sharing an axis share its scale).
  const extents = new Map<El | null, { min: number; max: number; pct: boolean; fmt?: string }>();
  for (const p of plots) {
    const ax = valOf(p);
    const e = extents.get(ax) ?? { min: Infinity, max: -Infinity, pct: true, fmt: undefined };
    const take = (v: number) => {
      e.min = Math.min(e.min, v);
      e.max = Math.max(e.max, v);
    };
    if (p.grouping === "percentStacked") {
      take(0);
      take(1);
    } else {
      e.pct = false;
      if (p.grouping === "stacked") {
        for (let i = 0; i < nCat; i++) {
          let pos = 0;
          let neg = 0;
          for (const s of p.series) {
            const v = s.vals[i] ?? 0;
            if (v >= 0) pos += v;
            else neg += v;
          }
          take(pos);
          take(neg);
        }
      } else for (const s of p.series) for (const v of s.vals) if (v !== null) take(v);
    }
    e.fmt ??= p.series[0]?.fmt;
    extents.set(ax, e);
  }
  const barsAcross = plots.some((q) => q.kind === "barChart" && q.dir === "bar");
  const radarOnly = plots.every((q) => q.kind === "radarChart");
  for (const [ax, e] of extents) {
    const scaling = kid(ax, "scaling");
    const fixedMin = kid(scaling, "min") ? num(attr(kid(scaling, "min"), "val")) : undefined;
    const fixedMax = kid(scaling, "max") ? num(attr(kid(scaling, "max"), "val")) : undefined;
    const unitV = kid(ax, "majorUnit") ? num(attr(kid(ax, "majorUnit"), "val")) : 0;
    const unit = unitV > 0 ? unitV : undefined;
    const axTx = txOf(kid(ax, "txPr"), baseTx);
    const fmtEl = kid(ax, "numFmt");
    const fmt = fmtEl && attr(fmtEl, "sourceLinked") !== "1" ? (attr(fmtEl, "formatCode") ?? undefined) : e.pct ? "0%" : (e.fmt ?? attr(fmtEl, "formatCode") ?? undefined);
    // At most ten steps, and fewer when the labels would collide on a short axis.
    const fits = (l: number, h: number, u: number) => {
      const n = Math.round((h - l) / u) + 1;
      // A radar's value axis is only a radius long.
      if (radarOnly) return n * axTx.size * 1.25 <= Math.min(box.w, box.h) * 0.3;
      if (!barsAcross) return n * axTx.size * 1.25 <= box.h * 0.8;
      const chars = Math.max(...[l, h, l + u].map((v) => formatValue(v, fmt).length));
      return n * (chars * axTx.size * 0.55 + axTx.size * 0.9) <= box.w * 0.8;
    };
    const { lo, hi, step } = e.pct
      ? { lo: fixedMin ?? 0, hi: fixedMax ?? 1, step: unit ?? ([0.1, 0.2, 0.25, 0.5].find((u) => fits(0, 1, u)) ?? 0.5) }
      : axisScale(Number.isFinite(e.min) ? e.min : 0, Number.isFinite(e.max) ? e.max : 1, { min: fixedMin, max: fixedMax, unit, fits });
    const ticks: number[] = [];
    for (let v = lo; v <= hi + step * 1e-6 && ticks.length < 200; v += step) ticks.push(Math.round(v / step) * step);
    scales.set(ax, {
      lo,
      hi,
      step,
      el: ax,
      fmt,
      deleted: on(kid(ax, "delete")),
      tx: axTx,
      reversed: attr(kid(scaling, "orientation"), "val") === "maxMin",
      labels: ticks.map((t) => formatValue(t, fmt)),
      secondary: ax !== primaryVal,
    });
  }
  const primary = scales.get(primaryVal) ?? [...scales.values()][0];
  // A scatter chart's x axis is a value axis too, scaled the same way.
  const xScale = scatter
    ? (() => {
        const xs = allSeries.flatMap((s) => s.xs ?? []);
        const sc = kid(catAxEl, "scaling");
        const unit = num(attr(kid(catAxEl, "majorUnit"), "val"));
        return axisScale(xs.length ? Math.min(...xs) : 0, xs.length ? Math.max(...xs) : 1, {
          min: kid(sc, "min") ? num(attr(kid(sc, "min"), "val")) : undefined,
          max: kid(sc, "max") ? num(attr(kid(sc, "max"), "val")) : undefined,
          unit: unit > 0 ? unit : undefined,
          fits: (l, h, u) => (Math.round((h - l) / u) + 1) * (Math.max(...[l, h, l + u].map((v) => formatValue(v, attr(kid(catAxEl, "numFmt"), "formatCode") ?? undefined).length)) * baseTx.size * 0.55 + baseTx.size * 0.9) <= box.w * 0.8,
        });
      })()
    : null;
  const secondary = [...scales.values()].find((s) => s.secondary && !s.deleted);
  const catTx = txOf(kid(catAxEl, "txPr"), baseTx);
  const catDeleted = !catAxEl || on(kid(catAxEl, "delete"));
  const catReversed = attr(path(catAxEl, "scaling", "orientation"), "val") === "maxMin";
  /* ----- radar: categories clockwise from the top, values out from the centre */
  if (plots.every((p) => p.kind === "radarChart") && primary) {
    const catTxR = txOf(kid(catAxEl, "txPr"), baseTx);
    const showCats = !!catAxEl && !on(kid(catAxEl, "delete"));
    const catW = showCats ? Math.max(0, ...(await Promise.all(cats.map((c) => width(c, catTxR))))) : 0;
    const ml = manual(pa);
    let cx = (left + right) / 2;
    let cy = (top + bottom) / 2;
    let r = Math.min((right - left) / 2 - catW - 6, (bottom - top) / 2 - (showCats ? catTxR.size * 1.5 : 0) - 2);
    if (ml && ml.x !== null && ml.y !== null && ml.w && ml.h) {
      cx = box.x + (ml.x + ml.w / 2) * box.w;
      cy = box.y + (ml.y + ml.h / 2) * box.h;
      r = (Math.min(ml.w * box.w, ml.h * box.h) / 2) * (ml.inner ? 1 : 0.8);
    }
    if (r < 8) return;
    const n = Math.max(nCat, 3);
    const ang = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const frac = (v: number) => Math.max(0, Math.min(1, (v - primary.lo) / (primary.hi - primary.lo || 1)));
    const at = (i: number, v: number): [number, number] => [cx + r * frac(v) * Math.cos(ang(i)), cy + r * frac(v) * Math.sin(ang(i))];
    const ring = (v: number) => Array.from({ length: n }, (_, i) => at(i, v));
    const poly = (pts: [number, number][], close: boolean) => `M ${pts[0][0]} ${pts[0][1]} ` + pts.slice(1).map((q) => `L ${q[0]} ${q[1]}`).join(" ") + (close ? " Z" : "");
    const ticks: number[] = [];
    for (let v = primary.lo; v <= primary.hi + primary.step * 1e-6 && ticks.length < 200; v += primary.step) ticks.push(Math.round(v / primary.step) * primary.step);
    // The web: value gridlines as rings, category gridlines as spokes, the category axis as the rim.
    const vg = kid(primary.el, "majorGridlines");
    const ringStroke = vg ? strokeOf(kid(vg, "spPr"), auto.axis) : undefined;
    if (ringStroke) for (const t of ticks) if (t > primary.lo) svgPath(poly(ring(t), true), { x: 0, y: H, borderColor: hex(ringStroke.color), borderWidth: ringStroke.width, borderOpacity: ringStroke.alpha < 1 ? ringStroke.alpha : undefined, borderDashArray: ringStroke.dash });
    const cg = kid(catAxEl, "majorGridlines");
    const spoke = cg ? strokeOf(kid(cg, "spPr"), auto.axis) : undefined;
    if (spoke) for (let i = 0; i < n; i++) line(cx, cy, ...at(i, primary.hi), spoke);
    const rim = showCats ? strokeOf(kid(catAxEl, "spPr"), auto.axis) : undefined;
    if (rim) svgPath(poly(ring(primary.hi), true), { x: 0, y: H, borderColor: hex(rim.color), borderWidth: rim.width, borderOpacity: rim.alpha < 1 ? rim.alpha : undefined });
    // The value axis up the first spoke, labelled on its left.
    if (!primary.deleted) {
      const axLine = strokeOf(kid(primary.el, "spPr"), auto.axis);
      if (axLine) line(cx, cy, cx, cy - r, axLine);
      const tm = attr(kid(primary.el, "majorTickMark"), "val") ?? "cross";
      for (let k = 0; k < ticks.length; k++) {
        const y = cy - r * frac(ticks[k]);
        if (axLine && tm !== "none") line(cx - (tm === "in" ? 0 : 3), y, cx + (tm === "out" ? 0 : 3), y, axLine);
        await say(primary.labels[k] ?? formatValue(ticks[k], primary.fmt), cx - 5, y + primary.tx.size * 0.35, primary.tx, "right");
      }
    }
    // Category names just outside the rim.
    if (showCats)
      for (let i = 0; i < nCat; i++) {
        const a = ang(i);
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const x = cx + (r + 5) * c;
        const y = cy + (r + 5) * sn;
        const align = c > 0.15 ? "left" : c < -0.15 ? "right" : "center";
        const base = sn < -0.15 ? y - catTxR.size * 0.25 : sn > 0.15 ? y + catTxR.size * 0.95 : y + catTxR.size * 0.35;
        await say(cats[i] ?? "", x, base, catTxR, align);
      }
    // The series: closed outlines (filled for a filled radar), with their markers.
    for (const p of plots)
      for (let k = 0; k < p.series.length; k++) {
        const s = p.series[k];
        const color = seriesColor(p, s, k);
        const pts = Array.from({ length: n }, (_, i) => at(i, s.vals[i] ?? primary.lo));
        if (!pts.length) continue;
        if (p.radar === "filled") {
          const edge = s.line ?? undefined;
          svgPath(poly(pts, true), { x: 0, y: H, color: hex(s.fill ?? color), borderColor: edge ? hex(edge.color) : undefined, borderWidth: edge ? edge.width : 0 });
        } else {
          const ln = s.line === undefined ? { color, width: auto.lineW, alpha: 1 } : s.line;
          if (ln) svgPath(poly(pts, true), { x: 0, y: H, borderColor: hex(ln.color), borderWidth: ln.width, borderOpacity: ln.alpha < 1 ? ln.alpha : undefined, borderDashArray: ln.dash });
          if (s.marker) for (const q of pts) marker(q[0], q[1], s.marker);
        }
      }
    return;
  }
  const between = (attr(kid(primary?.el ?? null, "crossBetween"), "val") ?? (plots.some((p) => p.kind === "barChart") ? "between" : plots.every((p) => p.kind === "areaChart") ? "midCat" : "between")) === "between";
  // Axis titles.
  const axisTitle = (ax: El | null | undefined) => (ax && !on(kid(ax, "delete")) ? richText(path(ax, "title", "tx", "rich")) : "");
  const rotated = async (angle: number, x: number, baseline: number, draw: () => Promise<void>) => {
    const r = (angle * Math.PI) / 180;
    const c = Math.cos(r);
    const sn = Math.sin(r);
    const px = x;
    const py = H - baseline;
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(c, sn, -sn, c, px - c * px + sn * py, py - sn * px - c * py));
    await draw();
    page.pushOperators(popGraphicsState());
  };
  const vTitle = axisTitle(primary?.el);
  const cTitle = axisTitle(catAxEl);
  const vTx = txOf(path(primary?.el ?? null, "title", "tx", "rich") ?? kid(kid(primary?.el ?? null, "title"), "txPr"), { ...baseTx, bold: true });
  const cTx = txOf(path(catAxEl, "title", "tx", "rich") ?? kid(kid(catAxEl, "title"), "txPr"), { ...baseTx, bold: true });
  const sideTitle = horizontal ? cTitle : vTitle;
  const sideTx = horizontal ? cTx : vTx;
  const footTitle = horizontal ? vTitle : cTitle;
  const footTx = horizontal ? vTx : cTx;
  if (sideTitle) {
    await rotated(90, left + sideTx.size, (top + bottom) / 2, () => say(sideTitle, left + sideTx.size, (top + bottom) / 2, sideTx, "center"));
    left += sideTx.size * 1.7;
  }
  if (footTitle) {
    await say(footTitle, (left + right) / 2, bottom - footTx.size * 0.25, footTx, "center");
    bottom -= footTx.size * 1.7;
  }
  // Plot box: room for the value labels and the category labels.
  const valLabelW = primary && !primary.deleted ? Math.max(0, ...(await Promise.all(primary.labels.map((t) => width(t, primary.tx))))) : 0;
  const secLabelW = secondary ? Math.max(0, ...(await Promise.all(secondary.labels.map((t) => width(t, secondary.tx))))) : 0;
  const catLabelW = !catDeleted && !scatter ? Math.max(0, ...(await Promise.all(cats.map((c) => width(c, catTx))))) : 0;
  const plot = { x: 0, y: top, w: 0, h: 0 };
  if (horizontal) {
    plot.x = left + (catDeleted ? 0 : Math.min((right - left) * 0.35, catLabelW + 6));
    plot.w = right - plot.x;
  } else {
    plot.x = left + valLabelW + (primary && !primary.deleted ? 6 : 0);
    plot.w = right - plot.x - (secondary ? secLabelW + 6 : 0);
  }
  // Category labels: one line each when they fit, wrapped at spaces when that is enough
  // (up to three lines), else turned 45 degrees.
  const wrapTo = async (t: string, w: number) => {
    const lines: string[] = [];
    let cur = "";
    for (const wd of t.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${wd}` : wd;
      if (cur && (await width(next, catTx)) > w) {
        lines.push(cur);
        cur = wd;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [t];
  };
  const wrapAll = async (room: number) => {
    const wrapped = await Promise.all(cats.map((c) => wrapTo(c, room)));
    const widths = await Promise.all(wrapped.flat().map((l) => width(l, catTx)));
    return widths.every((w) => w <= room + 0.5) && Math.max(1, ...wrapped.map((l) => l.length)) <= 3 ? wrapped : null;
  };
  let catLines: string[][] | null = null;
  let rotateCats = false;
  if (!catDeleted && !scatter && nCat >= 1) {
    if (horizontal) {
      const room = plot.x - left - 6;
      if (catLabelW > room + 0.5) catLines = await wrapAll(room);
    } else {
      const room = plot.w / Math.max(1, between ? nCat : nCat - 1) - catTx.size * 0.4;
      if (catLabelW > room) {
        catLines = await wrapAll(room);
        if (!catLines) rotateCats = nCat > 1 && nCat <= 40;
      }
    }
  }
  const catRows = catLines ? Math.max(1, ...catLines.map((l) => l.length)) : 1;
  const catSpace = rotateCats ? Math.min((bottom - top) * 0.45, catLabelW * 0.71 + catTx.size * 1.4) : catTx.size * (1.7 + 1.2 * (catRows - 1));
  plot.h = bottom - top - (horizontal ? (primary?.deleted ? 0 : primary.tx.size * 1.6) : catDeleted ? 0 : catSpace);
  if (plotML && plotML.x !== null && plotML.y !== null && plotML.w && plotML.h) {
    // The chart's own plot-area layout (the inner box, or the box with its labels).
    const x = box.x + plotML.x * box.w;
    const y = box.y + plotML.y * box.h;
    const w = plotML.w * box.w;
    const h = plotML.h * box.h;
    if (plotML.inner) Object.assign(plot, { x, y, w, h });
    else if (horizontal) Object.assign(plot, { x: x + (catDeleted ? 0 : Math.min(w * 0.35, catLabelW + 6)), y, w: w - (catDeleted ? 0 : Math.min(w * 0.35, catLabelW + 6)), h: h - (primary?.deleted ? 0 : primary.tx.size * 1.6) });
    else Object.assign(plot, { x: x + valLabelW + 6, y, w: w - valLabelW - 6 - (secondary ? secLabelW + 6 : 0), h: h - (catDeleted ? 0 : catSpace) });
  }
  if (plot.w < 10 || plot.h < 10 || !primary) return;
  // Plot area fill and border.
  const plotSp = kid(pa, "spPr");
  const plotFill = fillOf(plotSp);
  const plotLine = strokeOf(plotSp, undefined);
  if (plotFill !== null && !(plotSp && host.fill && (await host.fill(plotSp, plot)))) page.drawRectangle({ x: plot.x, y: H - plot.y - plot.h, width: plot.w, height: plot.h, color: hex(plotFill ?? auto.plot) });
  const vPos = (sc: Scale, v: number) => {
    const t = (v - sc.lo) / (sc.hi - sc.lo || 1);
    const u = sc.reversed ? 1 - t : t;
    return horizontal ? plot.x + u * plot.w : plot.y + plot.h - u * plot.h;
  };
  // Category positions: bands (bars, and lines between ticks) or ticks (midCat).
  const band = (horizontal ? plot.h : plot.w) / Math.max(1, between ? nCat : nCat - 1);
  const cPos = (i: number) => {
    const k = catReversed ? nCat - 1 - i : i;
    const off = between ? (k + 0.5) * band : k * band;
    return horizontal ? plot.y + plot.h - off : plot.x + off;
  };
  // Gridlines: value gridlines across, category gridlines along.
  const majorGrid = kid(primary.el, "majorGridlines");
  const gridStroke = majorGrid ? strokeOf(kid(majorGrid, "spPr"), auto.axis) : undefined;
  const minorGrid = kid(primary.el, "minorGridlines");
  const minorStroke = minorGrid ? strokeOf(kid(minorGrid, "spPr"), auto.minor) : undefined;
  const ticks: number[] = [];
  for (let v = primary.lo; v <= primary.hi + primary.step * 1e-6 && ticks.length < 200; v += primary.step) ticks.push(Math.round(v / primary.step) * primary.step);
  if (minorStroke)
    for (let i = 0; i + 1 < ticks.length; i++)
      for (let k = 1; k < 5; k++) {
        const v = ticks[i] + (primary.step * k) / 5;
        const p = vPos(primary, v);
        if (horizontal) line(p, plot.y, p, plot.y + plot.h, minorStroke);
        else line(plot.x, p, plot.x + plot.w, p, minorStroke);
      }
  for (const t of ticks) {
    const p = vPos(primary, t);
    if (horizontal) line(p, plot.y, p, plot.y + plot.h, gridStroke);
    else line(plot.x, p, plot.x + plot.w, p, gridStroke);
  }
  const catGrid = kid(catAxEl, "majorGridlines");
  if (catGrid && !scatter) {
    const cs = strokeOf(kid(catGrid, "spPr"), auto.axis);
    const n = between ? nCat + 1 : nCat;
    for (let i = 0; i < n; i++) {
      const off = i * band;
      if (horizontal) line(plot.x, plot.y + plot.h - off, plot.x + plot.w, plot.y + plot.h - off, cs);
      else line(plot.x + off, plot.y, plot.x + off, plot.y + plot.h, cs);
    }
  }
  if (plotLine) page.drawRectangle({ x: plot.x, y: H - plot.y - plot.h, width: plot.w, height: plot.h, borderColor: hex(plotLine.color), borderWidth: plotLine.width });
  // Value labels (and the secondary axis on the far side).
  const tickLen = 4;
  for (const sc of [primary, secondary]) {
    if (!sc || sc.deleted) continue;
    const axLine = strokeOf(kid(sc.el, "spPr"), auto.axis);
    const tickMark = attr(kid(sc.el, "majorTickMark"), "val") ?? "cross";
    const far = sc.secondary;
    const vt: number[] = [];
    for (let v = sc.lo; v <= sc.hi + sc.step * 1e-6 && vt.length < 200; v += sc.step) vt.push(Math.round(v / sc.step) * sc.step);
    for (let i = 0; i < vt.length; i++) {
      const p = vPos(sc, vt[i]);
      const label = sc.labels[i] ?? formatValue(vt[i], sc.fmt);
      if (horizontal) {
        if (tickMark !== "none" && axLine) line(p, plot.y + plot.h + (tickMark === "out" ? 0 : -tickLen), p, plot.y + plot.h + (tickMark === "in" ? 0 : tickLen), axLine);
        await say(label, p, plot.y + plot.h + sc.tx.size * 1.25, sc.tx, "center");
      } else {
        const ax = far ? plot.x + plot.w : plot.x;
        const sgn = far ? 1 : -1;
        if (tickMark !== "none" && axLine) line(ax + sgn * (tickMark === "out" ? 0 : -tickLen), p, ax + sgn * (tickMark === "in" ? 0 : tickLen), p, axLine);
        await say(label, far ? ax + 6 : ax - 6, p + sc.tx.size * 0.35, sc.tx, far ? "left" : "right");
      }
    }
    if (axLine) {
      if (horizontal) line(plot.x, plot.y + plot.h, plot.x + plot.w, plot.y + plot.h, axLine);
      else {
        const ax = far ? plot.x + plot.w : plot.x;
        line(ax, plot.y, ax, plot.y + plot.h, axLine);
      }
    }
  }
  // Category axis line where the values cross zero, its ticks and labels.
  const zero = vPos(primary, Math.max(primary.lo, Math.min(primary.hi, 0)));
  const catLine = catAxEl && !catDeleted ? strokeOf(kid(catAxEl, "spPr"), auto.axis) : undefined;
  if (catLine && !scatter) {
    if (horizontal) line(zero, plot.y, zero, plot.y + plot.h, catLine);
    else line(plot.x, zero, plot.x + plot.w, zero, catLine);
    const tm = attr(kid(catAxEl, "majorTickMark"), "val") ?? "cross";
    if (tm !== "none") {
      const n = between ? nCat + 1 : nCat;
      const d0 = tm === "out" ? 0 : -tickLen;
      const d1 = tm === "in" ? 0 : tickLen;
      for (let i = 0; i < n; i++) {
        const off = i * band;
        if (horizontal) line(zero - d0, plot.y + plot.h - off, zero - d1, plot.y + plot.h - off, catLine);
        else line(plot.x + off, zero + d0, plot.x + off, zero + d1, catLine);
      }
    }
  }
  if (!catDeleted && !scatter) {
    const widest = horizontal ? catTx.size * 1.2 * catRows + catTx.size * 0.2 : rotateCats ? catTx.size * 1.3 : catLines ? 0 : catLabelW + catTx.size * 0.6;
    const step = Math.max(1, Math.ceil(widest / Math.max(1, band)));
    for (let i = 0; i < nCat; i += step) {
      const label = cats[i] ?? "";
      const p = cPos(i);
      const lines = catLines?.[i];
      if (horizontal) {
        const ls = lines ?? [label];
        const y0 = p + catTx.size * 0.35 - ((ls.length - 1) * catTx.size * 1.2) / 2;
        for (let k = 0; k < ls.length; k++) await say(ls[k], plot.x - 6, y0 + k * catTx.size * 1.2, catTx, "right");
      } else if (lines) {
        for (let k = 0; k < lines.length; k++) await say(lines[k], p, plot.y + plot.h + catTx.size * (1.25 + 1.2 * k), catTx, "center");
      } else if (rotateCats) {
        const ax = p + catTx.size * 0.3;
        const ay = plot.y + plot.h + catTx.size * 0.9;
        await rotated(45, ax, ay, () => say(label, ax, ay, catTx, "right"));
      } else await say(label, p, plot.y + plot.h + catTx.size * 1.25, catTx, "center");
    }
  }
  if (scatter && catAxEl && !on(kid(catAxEl, "delete")) && xScale) {
    // The x axis of a scatter chart is a value axis of its own.
    const xsc = xScale;
    const xtx = txOf(kid(catAxEl, "txPr"), baseTx);
    const fmt = attr(kid(catAxEl, "numFmt"), "formatCode") ?? undefined;
    for (let v = xsc.lo; v <= xsc.hi + xsc.step * 1e-6; v += xsc.step) {
      const x = plot.x + ((v - xsc.lo) / (xsc.hi - xsc.lo || 1)) * plot.w;
      await say(formatValue(Math.round(v / xsc.step) * xsc.step, fmt), x, plot.y + plot.h + xtx.size * 1.25, xtx, "center");
    }
    const xl = strokeOf(kid(catAxEl, "spPr"), auto.axis);
    line(plot.x, zero, plot.x + plot.w, zero, xl);
  }

  /* ----- series */
  const labelText = (lb: Labels, s: Series, i: number, raw: number) => {
    const parts: string[] = [];
    if (lb.ser) parts.push(s.name);
    if (lb.cat) parts.push(s.cats[i] ?? "");
    if (lb.val) parts.push(formatValue(raw, lb.fmt ?? s.fmt));
    return parts.join(" ");
  };
  for (const p of plots) {
    const sc = scales.get(valOf(p)) ?? primary;
    const n = p.series.length;
    if (p.kind === "barChart") {
      const stacked = p.grouping === "stacked" || p.grouping === "percentStacked";
      const slots = stacked ? 1 : n;
      const ov = stacked ? 0 : Math.max(-1, Math.min(1, p.overlap / 100));
      const bandW = (horizontal ? plot.h : plot.w) / nCat;
      const barW = bandW / (slots - ov * (slots - 1) + p.gap / 100);
      for (let i = 0; i < nCat; i++) {
        let pos = 0;
        let neg = 0;
        const total = p.grouping === "percentStacked" ? p.series.reduce((t, s) => t + Math.abs(s.vals[i] ?? 0), 0) || 1 : 1;
        for (let k = 0; k < n; k++) {
          const s = p.series[k];
          const raw = s.vals[i];
          if (raw === null || raw === undefined) continue;
          const v = raw / total;
          const color = s.points.get(i) ?? (p.vary && n === 1 ? accent(i, nCat) : seriesColor(p, s, k));
          const start = (bandW - (slots * barW - ov * barW * (slots - 1))) / 2 + (stacked ? 0 : k * barW * (1 - ov));
          let a0 = 0;
          let a1 = v;
          if (stacked) {
            if (v >= 0) {
              a0 = pos;
              a1 = pos + v;
              pos += v;
            } else {
              a0 = neg;
              a1 = neg + v;
              neg += v;
            }
          }
          const ci = catReversed ? nCat - 1 - i : i;
          const border = (s.pointLines.has(i) ? s.pointLines.get(i) : s.line) ?? undefined;
          if (horizontal) {
            const x0 = vPos(sc, Math.max(sc.lo, Math.min(a0, a1)));
            const x1 = vPos(sc, Math.min(sc.hi, Math.max(a0, a1)));
            const y = plot.y + plot.h - (ci + 1) * bandW + start;
            page.drawRectangle({ x: Math.min(x0, x1), y: H - y - barW, width: Math.abs(x1 - x0), height: barW, color: color ? hex(color) : undefined, borderColor: border ? hex(border.color) : undefined, borderWidth: border ? border.width : 0 });
            const lb = s.pointLabels.has(i) ? s.pointLabels.get(i) : s.labels;
            if (lb && (lb.val || lb.cat || lb.ser)) await say(labelText(lb, s, i, raw), stacked || lb.pos === "ctr" ? (x0 + x1) / 2 : Math.max(x0, x1) + 3, y + barW / 2 + lb.tx.size * 0.35, lb.tx, stacked || lb.pos === "ctr" ? "center" : "left");
          } else {
            const y0 = vPos(sc, Math.min(sc.hi, Math.max(a0, a1)));
            const y1 = vPos(sc, Math.max(sc.lo, Math.min(a0, a1)));
            const x = plot.x + ci * bandW + start;
            page.drawRectangle({ x, y: H - Math.max(y0, y1), width: barW, height: Math.abs(y1 - y0), color: color ? hex(color) : undefined, borderColor: border ? hex(border.color) : undefined, borderWidth: border ? border.width : 0 });
            const lb = s.pointLabels.has(i) ? s.pointLabels.get(i) : s.labels;
            if (lb && (lb.val || lb.cat || lb.ser)) {
              const inside = stacked || lb.pos === "ctr" || lb.pos === "inEnd" || lb.pos === "inBase";
              await say(labelText(lb, s, i, raw), x + barW / 2, inside ? (y0 + y1) / 2 + lb.tx.size * 0.35 : Math.min(y0, y1) - 3, lb.tx, "center");
            }
          }
        }
      }
    } else if (p.kind === "lineChart" || p.kind === "areaChart" || p.kind === "radarChart" || p.kind === "scatterChart" || p.kind === "bubbleChart") {
      const stacked = p.grouping === "stacked" || p.grouping === "percentStacked";
      const sums = Array(nCat).fill(0);
      const totals = Array.from({ length: nCat }, (_, i) => p.series.reduce((t, s) => t + Math.abs(s.vals[i] ?? 0), 0) || 1);
      const xsc = xScale;
      const prevTop: number[][] = [];
      for (let k = 0; k < n; k++) {
        const s = p.series[k];
        const color = seriesColor(p, s, k);
        const pts: { x: number; y: number; v: number; i: number }[] = [];
        s.vals.forEach((raw, i) => {
          if (raw === null) return;
          let v = p.grouping === "percentStacked" ? raw / totals[i] : raw;
          if (stacked) {
            sums[i] += v;
            v = sums[i];
          }
          const x = scatter && xsc && s.xs ? plot.x + ((s.xs[i] - xsc.lo) / (xsc.hi - xsc.lo || 1)) * plot.w : cPos(i);
          pts.push({ x, y: vPos(sc, v), v: raw, i });
        });
        if (!pts.length) continue;
        if (p.kind === "areaChart") {
          const base = vPos(sc, Math.max(sc.lo, 0));
          const lower = stacked && prevTop.length ? [...prevTop[prevTop.length - 1]].reverse() : null;
          let d = `M ${pts[0].x} ${lower ? lower[lower.length - 1] : base} ` + pts.map((q) => `L ${q.x} ${q.y}`).join(" ");
          if (lower) d += " " + pts.map((q, j) => `L ${pts[pts.length - 1 - j].x} ${lower[j]}`).join(" ");
          else d += ` L ${pts[pts.length - 1].x} ${base}`;
          d += " Z";
          svgPath(d, { x: 0, y: H, color: hex(s.fill ?? color), borderColor: s.line ? hex(s.line.color) : undefined, borderWidth: s.line ? s.line.width : 0 });
          prevTop.push(pts.map((q) => q.y));
        } else {
          const ln = s.line === undefined ? { color, width: auto.lineW, alpha: 1 } : s.line;
          if (ln && pts.length > 1) {
            if (s.smooth && pts.length > 2) {
              // Smoothed lines: a curve through every point (Catmull-Rom, as cubic Béziers).
              let d = `M ${pts[0].x} ${pts[0].y}`;
              for (let j = 0; j < pts.length - 1; j++) {
                const p0 = pts[Math.max(0, j - 1)];
                const p1 = pts[j];
                const p2 = pts[j + 1];
                const p3 = pts[Math.min(pts.length - 1, j + 2)];
                d += ` C ${p1.x + (p2.x - p0.x) / 6} ${p1.y + (p2.y - p0.y) / 6} ${p2.x - (p3.x - p1.x) / 6} ${p2.y - (p3.y - p1.y) / 6} ${p2.x} ${p2.y}`;
              }
              svgPath(d, { x: 0, y: H, borderColor: hex(ln.color), borderWidth: ln.width, borderOpacity: ln.alpha < 1 ? ln.alpha : undefined, borderDashArray: ln.dash });
            } else svgPath(`M ${pts[0].x} ${pts[0].y} ` + pts.slice(1).map((q) => `L ${q.x} ${q.y}`).join(" "), { x: 0, y: H, borderColor: hex(ln.color), borderWidth: ln.width, borderOpacity: ln.alpha < 1 ? ln.alpha : undefined, borderDashArray: ln.dash });
          }
          if (s.marker) for (const q of pts) marker(q.x, q.y, s.marker);
        }
        for (const q of pts) {
          const lb = s.pointLabels.has(q.i) ? s.pointLabels.get(q.i) : s.labels;
          if (lb && (lb.val || lb.cat || lb.ser)) {
            const below = lb.pos === "b";
            const side = lb.pos === "r" ? "left" : lb.pos === "l" ? "right" : "center";
            await say(labelText(lb, s, q.i, q.v), q.x + (side === "left" ? 5 : side === "right" ? -5 : 0), below ? q.y + lb.tx.size + 3 : lb.pos === "ctr" || side !== "center" ? q.y + lb.tx.size * 0.35 : q.y - 5, lb.tx, side);
          }
        }
      }
    }
  }
}
