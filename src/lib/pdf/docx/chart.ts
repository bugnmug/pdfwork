/**
 * Office charts (c:chartSpace) drawn as vector graphics: column and bar
 * (clustered, stacked, 100%), line, area, scatter, pie and doughnut, with
 * title, value axis and gridlines, category labels, legend and data labels.
 */
import type { PDFPage } from "@cantoo/pdf-lib";
import { rgb } from "../core";
import { attr, drawingColor, kid, kids, num, path, type El, type Theme } from "../ooxml";

export type ChartText = (text: string, x: number, baseline: number, size: number, opt: { bold?: boolean; color?: string; align?: "left" | "center" | "right" }) => Promise<void>;
export type ChartMeasure = (text: string, size: number, bold?: boolean) => Promise<number>;

type Series = { name: string; cats: string[]; vals: (number | null)[]; xs?: number[]; color?: string; line?: string; lineW?: number; points: Map<number, string>; fmt?: string; labels: boolean; marker: boolean };
type Plot = { kind: string; dir: string; grouping: string; series: Series[]; gap: number; overlap: number; hole: number; vary: boolean };

const hex = (h: string) => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);

function strCache(el: El | null): string[] {
  const cache = el?.getElementsByTagNameNS("*", "strCache")[0] ?? el?.getElementsByTagNameNS("*", "numCache")[0] ?? el?.getElementsByTagNameNS("*", "strLit")[0] ?? el?.getElementsByTagNameNS("*", "numLit")[0];
  if (!cache) {
    const lvl = el?.getElementsByTagNameNS("*", "lvl")[0];
    if (!lvl) return [];
    return kids(lvl, "pt").map((p) => kid(p, "v")?.textContent ?? "");
  }
  const n = num(attr(kid(cache, "ptCount"), "val"), 0);
  const out: string[] = Array(n).fill("");
  for (const p of kids(cache, "pt")) out[num(attr(p, "idx"))] = kid(p, "v")?.textContent ?? "";
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

/** Number formats as Excel writes them, the common cases. */
export function formatValue(v: number, code?: string): string {
  const c = (code ?? "General").split(";")[0];
  if (/%/.test(c)) {
    const d = (c.split(".")[1]?.match(/0/g) ?? []).length;
    return `${(v * 100).toFixed(d)}%`;
  }
  if (c === "General" || !c) {
    const r = Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 1000) / 1000;
    return String(r);
  }
  const d = (c.split(".")[1]?.match(/[0#]/g) ?? []).length;
  const grouped = /#,##|0,0/.test(c);
  let s = Math.abs(v).toFixed(d);
  if (grouped) {
    const [i, f] = s.split(".");
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? `.${f}` : "");
  }
  const prefix = (c.match(/^"?([$₹€£¥])"?/) ?? c.match(/\[\$([^\]-]+)/))?.[1] ?? "";
  return `${v < 0 ? "-" : ""}${prefix}${s}`;
}

function niceScale(min: number, max: number, ticks = 6): { lo: number; hi: number; step: number } {
  if (min === max) {
    if (max === 0) return { lo: 0, hi: 1, step: 0.2 };
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  const raw = (max - min) / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { lo: Math.floor(min / step + 1e-9) * step, hi: Math.ceil(max / step - 1e-9) * step, step };
}

function readPlot(pa: El, theme: Theme): Plot[] {
  const plots: Plot[] = [];
  let si = 0;
  for (const p of Array.from(pa.children)) {
    if (!/Chart$/.test(p.localName)) continue;
    const kind = p.localName.replace(/3DChart$/, "Chart");
    const series: Series[] = [];
    for (const s of kids(p, "ser")) {
      const spPr = kid(s, "spPr");
      const fill = drawingColor(kid(spPr, "solidFill"), theme)?.hex;
      const line = drawingColor(kid(kid(spPr, "ln"), "solidFill"), theme)?.hex;
      const points = new Map<number, string>();
      for (const dp of kids(s, "dPt")) {
        const c = drawingColor(kid(kid(dp, "spPr"), "solidFill"), theme)?.hex;
        if (c) points.set(num(attr(kid(dp, "idx"), "val")), c);
      }
      const cats = strCache(kid(s, "cat") ?? kid(s, "xVal"));
      const v = numCache(kid(s, "val") ?? kid(s, "yVal"));
      const xs = kid(s, "xVal") ? numCache(kid(s, "xVal")).vals.map((x, i) => x ?? i) : undefined;
      const dl = kid(s, "dLbls") ?? kid(p, "dLbls");
      series.push({
        name: strCache(kid(s, "tx"))[0] ?? kid(kid(s, "tx"), "v")?.textContent ?? `Series ${si + 1}`,
        cats,
        vals: v.vals,
        xs,
        color: fill,
        line,
        lineW: kid(spPr, "ln") && attr(kid(spPr, "ln"), "w") ? num(attr(kid(spPr, "ln"), "w")) / 12700 : undefined,
        points,
        fmt: v.fmt,
        labels: attr(kid(dl, "showVal"), "val") === "1",
        marker: attr(path(s, "marker", "symbol"), "val") !== "none" && (kind === "lineChart" || kind === "scatterChart" || kind === "radarChart"),
      });
      si++;
    }
    plots.push({
      kind,
      dir: attr(kid(p, "barDir"), "val") ?? "col",
      grouping: attr(kid(p, "grouping"), "val") ?? "clustered",
      series,
      gap: num(attr(kid(p, "gapWidth"), "val"), 150),
      overlap: num(attr(kid(p, "overlap"), "val"), 0),
      hole: num(attr(kid(p, "holeSize"), "val"), 50),
      vary: attr(kid(p, "varyColors"), "val") === "1",
    });
  }
  return plots;
}

function richText(el: El | null): string {
  if (!el) return "";
  return Array.from(el.getElementsByTagNameNS("*", "p"))
    .map((p) => Array.from(p.getElementsByTagNameNS("*", "t")).map((t) => t.textContent ?? "").join(""))
    .join(" ");
}

export async function drawChart(page: PDFPage, chartDoc: Document, theme: Theme, box: { x: number; y: number; w: number; h: number }, text: ChartText, measure: ChartMeasure) {
  const H = page.getHeight();
  const root = chartDoc.documentElement;
  const chart = kid(root, "chart");
  if (!chart) return;
  const accent = (i: number) => {
    const base = theme.colors[`accent${(i % 6) + 1}`] ?? "4472C4";
    if (i < 6) return base;
    // Later series: darker shades of the accents, as Office does.
    const k = Math.floor(i / 6);
    const f = k % 2 ? 0.6 : 0.8;
    return [0, 2, 4].map((j) => Math.round(parseInt(base.slice(j, j + 2), 16) * f).toString(16).padStart(2, "0")).join("");
  };
  const defSz = num(attr(root.getElementsByTagNameNS("*", "defRPr")[0], "sz"), 1000) / 100 || 10;
  const fs = Math.max(6, Math.min(14, defSz));
  const ink = "595959";
  // Chart area.
  const area = kid(root, "spPr");
  const areaFill = drawingColor(kid(area, "solidFill"), theme)?.hex;
  const areaLine = kid(kid(area, "ln"), "noFill") ? undefined : (drawingColor(kid(kid(area, "ln"), "solidFill"), theme)?.hex ?? (kid(area, "ln") ? undefined : "D9D9D9"));
  if (areaFill || !kid(area, "noFill")) page.drawRectangle({ x: box.x, y: H - box.y - box.h, width: box.w, height: box.h, color: areaFill ? hex(areaFill) : rgb(1, 1, 1), borderColor: areaLine ? hex(areaLine) : undefined, borderWidth: areaLine ? 0.75 : 0 });
  let top = box.y + 8;
  let bottom = box.y + box.h - 6;
  let left = box.x + 8;
  let right = box.x + box.w - 8;
  // Title.
  const titleEl = kid(chart, "title");
  const autoDeleted = attr(kid(chart, "autoTitleDeleted"), "val") === "1";
  const pa = kid(chart, "plotArea");
  if (!pa) return;
  const plots = readPlot(pa, theme);
  const allSeries = plots.flatMap((p) => p.series);
  let title = richText(kid(kid(titleEl, "tx"), "rich"));
  if (!title && titleEl && !autoDeleted && allSeries.length === 1) title = allSeries[0].name;
  if (title) {
    const ts = fs * 1.4;
    await text(title, box.x + box.w / 2, top + ts, ts, { color: ink, align: "center" });
    top += ts * 1.6;
  }
  // Legend.
  const legend = kid(chart, "legend");
  const legendPos = attr(kid(legend, "legendPos"), "val") ?? "r";
  const pie = plots.some((p) => p.kind === "pieChart" || p.kind === "doughnutChart");
  const entries = pie ? (allSeries[0]?.cats ?? []).map((c, i) => ({ name: c, color: allSeries[0].points.get(i) ?? accent(i) })) : allSeries.map((s, i) => ({ name: s.name, color: s.color ?? s.line ?? accent(i) }));
  if (legend && entries.length) {
    const sw = fs * 0.7;
    if (legendPos === "b" || legendPos === "t") {
      const widths = await Promise.all(entries.map(async (e) => sw + 4 + (await measure(e.name, fs)) + 12));
      const total = widths.reduce((a, b) => a + b, 0);
      let x = box.x + Math.max(8, (box.w - total) / 2);
      const y = legendPos === "b" ? bottom - fs * 0.3 : top + fs;
      for (let i = 0; i < entries.length; i++) {
        page.drawRectangle({ x, y: H - y - sw * 0.1, width: sw, height: sw, color: hex(entries[i].color) });
        await text(entries[i].name, x + sw + 4, y + sw * 0.05, fs, { color: ink });
        x += widths[i];
      }
      if (legendPos === "b") bottom -= fs * 2;
      else top += fs * 2;
    } else {
      const widest = Math.max(...(await Promise.all(entries.map((e) => measure(e.name, fs)))));
      const lw = Math.min(box.w * 0.4, sw + 6 + widest);
      const lx = legendPos === "l" ? box.x + 8 : box.x + box.w - 8 - lw;
      let y = top + (bottom - top) / 2 - (entries.length * fs * 1.5) / 2 + fs;
      for (const e of entries) {
        page.drawRectangle({ x: lx, y: H - y - sw * 0.1, width: sw, height: sw, color: hex(e.color) });
        await text(e.name, lx + sw + 5, y + sw * 0.05, fs, { color: ink });
        y += fs * 1.5;
      }
      if (legendPos === "l") left += lw + 10;
      else right -= lw + 10;
    }
  }
  if (!allSeries.length || right - left < 20 || bottom - top < 20) return;

  /* ----- pie and doughnut */
  if (pie) {
    const p = plots.find((q) => q.kind === "pieChart" || q.kind === "doughnutChart")!;
    const s = p.series[0];
    const vals = s.vals.map((v) => Math.max(0, v ?? 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const r = Math.min(right - left, bottom - top) / 2 - 2;
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const hole = p.kind === "doughnutChart" ? (r * p.hole) / 100 : 0;
    let ang = -Math.PI / 2;
    for (let i = 0; i < vals.length; i++) {
      const sweep = (vals[i] / total) * Math.PI * 2;
      if (sweep <= 0) continue;
      const steps = Math.max(2, Math.ceil(sweep / 0.05));
      let d = hole ? `M ${cx + hole * Math.cos(ang)} ${cy + hole * Math.sin(ang)}` : `M ${cx} ${cy}`;
      for (let k = 0; k <= steps; k++) {
        const a = ang + (sweep * k) / steps;
        d += ` L ${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
      }
      if (hole) for (let k = steps; k >= 0; k--) {
        const a = ang + (sweep * k) / steps;
        d += ` L ${cx + hole * Math.cos(a)} ${cy + hole * Math.sin(a)}`;
      }
      d += " Z";
      page.drawSvgPath(d, { x: 0, y: H, color: hex(s.points.get(i) ?? accent(i)), borderColor: rgb(1, 1, 1), borderWidth: 1 });
      if (s.labels) {
        const mid = ang + sweep / 2;
        const lr = hole ? (r + hole) / 2 : r * 0.65;
        await text(formatValue(s.vals[i] ?? 0, s.fmt), cx + lr * Math.cos(mid), cy + lr * Math.sin(mid) + fs * 0.35, fs, { color: "FFFFFF", align: "center" });
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
  // Value range, stacked where the chart stacks.
  let vmin = 0;
  let vmax = 0;
  for (const p of plots) {
    if (p.grouping === "percentStacked") {
      vmax = Math.max(vmax, 1);
      continue;
    }
    if (p.grouping === "stacked") {
      for (let i = 0; i < nCat; i++) {
        let pos = 0;
        let neg = 0;
        for (const s of p.series) {
          const v = s.vals[i] ?? 0;
          if (v >= 0) pos += v;
          else neg += v;
        }
        vmax = Math.max(vmax, pos);
        vmin = Math.min(vmin, neg);
      }
    } else for (const s of p.series) for (const v of s.vals) if (v !== null) {
      vmax = Math.max(vmax, v);
      vmin = Math.min(vmin, v);
    }
  }
  const valAx = kid(pa, "valAx");
  const scaling = kid(valAx, "scaling");
  const fixedMin = kid(scaling, "min") ? num(attr(kid(scaling, "min"), "val")) : undefined;
  const fixedMax = kid(scaling, "max") ? num(attr(kid(scaling, "max"), "val")) : undefined;
  const sc = niceScale(fixedMin ?? vmin, fixedMax ?? vmax);
  const lo = fixedMin ?? sc.lo;
  const hi = fixedMax ?? sc.hi;
  const valFmt = attr(kid(valAx, "numFmt"), "formatCode") ?? (plots.some((p) => p.grouping === "percentStacked") ? "0%" : allSeries[0]?.fmt);
  const valDeleted = attr(kid(valAx, "delete"), "val") === "1";
  const ticks: number[] = [];
  for (let v = lo; v <= hi + sc.step * 1e-6; v += sc.step) ticks.push(Math.round(v / sc.step) * sc.step);
  const tickLabels = ticks.map((t) => formatValue(t, valFmt));
  const labelW = valDeleted ? 0 : Math.max(...(await Promise.all(tickLabels.map((t) => measure(t, fs)))));
  // Plot box.
  const catDeleted = attr(kid(kid(pa, "catAx") ?? kid(pa, "dateAx"), "delete"), "val") === "1";
  const plot = horizontal
    ? { x: left + (catDeleted ? 0 : Math.min((right - left) * 0.3, Math.max(...(await Promise.all(cats.map((c) => measure(c, fs))))) + 6)), y: top, w: 0, h: 0 }
    : { x: left + labelW + (valDeleted ? 0 : 6), y: top, w: 0, h: 0 };
  plot.w = right - plot.x;
  plot.h = bottom - top - (horizontal ? (valDeleted ? 0 : fs * 1.6) : catDeleted ? 0 : fs * 1.8);
  if (plot.w < 10 || plot.h < 10) return;
  const vToX = (v: number) => plot.x + ((v - lo) / (hi - lo || 1)) * plot.w;
  const vToY = (v: number) => plot.y + plot.h - ((v - lo) / (hi - lo || 1)) * plot.h;
  // Gridlines and value labels.
  const grid = valAx ? !!kid(valAx, "majorGridlines") : true;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    if (horizontal) {
      const x = vToX(t);
      if (grid) page.drawLine({ start: { x, y: H - plot.y }, end: { x, y: H - plot.y - plot.h }, thickness: 0.5, color: hex("D9D9D9") });
      if (!valDeleted) await text(tickLabels[i], x, plot.y + plot.h + fs * 1.2, fs, { color: ink, align: "center" });
    } else {
      const y = vToY(t);
      if (grid) page.drawLine({ start: { x: plot.x, y: H - y }, end: { x: plot.x + plot.w, y: H - y }, thickness: 0.5, color: hex("D9D9D9") });
      if (!valDeleted) await text(tickLabels[i], plot.x - 6, y + fs * 0.35, fs, { color: ink, align: "right" });
    }
  }
  // Category axis line at zero.
  if (horizontal) page.drawLine({ start: { x: vToX(Math.max(lo, Math.min(hi, 0))), y: H - plot.y }, end: { x: vToX(Math.max(lo, Math.min(hi, 0))), y: H - plot.y - plot.h }, thickness: 0.75, color: hex("BFBFBF") });
  else page.drawLine({ start: { x: plot.x, y: H - vToY(Math.max(lo, Math.min(hi, 0))) }, end: { x: plot.x + plot.w, y: H - vToY(Math.max(lo, Math.min(hi, 0))) }, thickness: 0.75, color: hex("BFBFBF") });
  // Category labels.
  if (!catDeleted && !scatter) {
    const band = (horizontal ? plot.h : plot.w) / nCat;
    const step = Math.max(1, Math.ceil(nCat / Math.max(1, Math.floor((horizontal ? plot.h : plot.w) / (fs * (horizontal ? 1.4 : 4))))));
    for (let i = 0; i < nCat; i += step) {
      const label = cats[i] ?? "";
      if (horizontal) await text(label, plot.x - 6, plot.y + plot.h - (i + 0.5) * band + fs * 0.35, fs, { color: ink, align: "right" });
      else await text(label, plot.x + (i + 0.5) * band, plot.y + plot.h + fs * 1.3, fs, { color: ink, align: "center" });
    }
  }

  /* ----- series */
  let seriesBase = 0;
  for (const p of plots) {
    const n = p.series.length;
    if (p.kind === "barChart") {
      const band = (horizontal ? plot.h : plot.w) / nCat;
      const stacked = p.grouping === "stacked" || p.grouping === "percentStacked";
      const slots = stacked ? 1 : n;
      const ov = stacked ? 0 : p.overlap / 100;
      const barW = band / (slots - ov * (slots - 1) + p.gap / 100);
      for (let i = 0; i < nCat; i++) {
        let pos = 0;
        let neg = 0;
        const total = p.grouping === "percentStacked" ? p.series.reduce((t, s) => t + Math.abs(s.vals[i] ?? 0), 0) || 1 : 1;
        for (let k = 0; k < n; k++) {
          const s = p.series[k];
          const raw = s.vals[i];
          if (raw === null || raw === undefined) continue;
          const v = raw / total;
          const color = s.points.get(i) ?? s.color ?? (p.vary && n === 1 ? accent(i) : accent(seriesBase + k));
          const start = (band - (slots * barW - ov * barW * (slots - 1))) / 2 + (stacked ? 0 : k * barW * (1 - ov));
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
          if (horizontal) {
            const x0 = vToX(Math.max(lo, Math.min(a0, a1)));
            const x1 = vToX(Math.min(hi, Math.max(a0, a1)));
            const y = plot.y + plot.h - (i + 1) * band + start;
            page.drawRectangle({ x: x0, y: H - y - barW, width: Math.max(0, x1 - x0), height: barW, color: hex(color) });
            if (s.labels) await text(formatValue(raw, s.fmt), x1 + 3, y + barW / 2 + fs * 0.35, fs, { color: ink });
          } else {
            const y0 = vToY(Math.min(hi, Math.max(a0, a1)));
            const y1 = vToY(Math.max(lo, Math.min(a0, a1)));
            const x = plot.x + i * band + start;
            page.drawRectangle({ x, y: H - y1, width: barW, height: Math.max(0, y1 - y0), color: hex(color) });
            if (s.labels) await text(formatValue(raw, s.fmt), x + barW / 2, (stacked ? (y0 + y1) / 2 + fs * 0.35 : y0 - 3), fs, { color: stacked ? "FFFFFF" : ink, align: "center" });
          }
        }
      }
    } else if (p.kind === "lineChart" || p.kind === "areaChart" || p.kind === "radarChart" || p.kind === "scatterChart") {
      const band = plot.w / nCat;
      const stacked = p.grouping === "stacked" || p.grouping === "percentStacked";
      const sums = Array(nCat).fill(0);
      const xs = scatter ? allSeries.flatMap((s) => s.xs ?? []) : [];
      const xsc = scatter ? niceScale(Math.min(...xs, 0), Math.max(...xs, 1)) : null;
      for (let k = 0; k < n; k++) {
        const s = p.series[k];
        const color = s.line ?? s.color ?? accent(seriesBase + k);
        const pts: { x: number; y: number; v: number }[] = [];
        s.vals.forEach((raw, i) => {
          if (raw === null) return;
          let v = raw;
          if (stacked) {
            sums[i] += raw;
            v = sums[i];
          }
          const x = scatter && xsc && s.xs ? plot.x + ((s.xs[i] - xsc.lo) / (xsc.hi - xsc.lo || 1)) * plot.w : plot.x + (i + 0.5) * band;
          pts.push({ x, y: vToY(v), v: raw });
        });
        if (!pts.length) continue;
        if (p.kind === "areaChart") {
          const base = vToY(Math.max(lo, 0));
          const d = `M ${pts[0].x} ${base} ` + pts.map((q) => `L ${q.x} ${q.y}`).join(" ") + ` L ${pts[pts.length - 1].x} ${base} Z`;
          page.drawSvgPath(d, { x: 0, y: H, color: hex(color), opacity: 0.85 });
        } else {
          const w = s.lineW ?? 2.25;
          if (!(p.kind === "scatterChart" && !s.line)) for (let j = 1; j < pts.length; j++) page.drawLine({ start: { x: pts[j - 1].x, y: H - pts[j - 1].y }, end: { x: pts[j].x, y: H - pts[j].y }, thickness: w, color: hex(color) });
          if (s.marker || p.kind === "scatterChart") for (const q of pts) page.drawEllipse({ x: q.x, y: H - q.y, xScale: 2.5, yScale: 2.5, color: hex(color) });
        }
        if (s.labels) for (const q of pts) await text(formatValue(q.v, s.fmt), q.x, q.y - 5, fs, { color: ink, align: "center" });
      }
    }
    seriesBase += n;
  }
}
