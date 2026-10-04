/**
 * Freehand drawing pages → vector PDF. Pen strokes are turned into filled
 * outlines whose width follows pressure (or speed, for a mouse), so the PDF
 * looks like the screen and stays sharp at any zoom.
 */
import { BlendMode, LineCapStyle } from "@cantoo/pdf-lib";
import { hexToRgb, newDoc, pdfOut, saveDoc, type OutFile } from "./core";

export type DrawPoint = [number, number, number]; // x, y (points, top-left origin), pressure 0..1
export type Stroke = { kind: "pen" | "marker"; color: string; width: number; points: DrawPoint[] };
export type DrawPage = { strokes: Stroke[] };
export type Paper = "plain" | "ruled" | "grid" | "dots";

export const PAGE_SIZES = { portrait: [595.28, 841.89] as [number, number], landscape: [841.89, 595.28] as [number, number] };

/** Outline polygon of a variable-width pen stroke. */
export function strokeOutline(pts: DrawPoint[], width: number): [number, number][] {
  if (!pts.length) return [];
  const half = (p: number) => (width / 2) * (0.35 + 0.65 * Math.max(0, Math.min(1, p)));
  if (pts.length === 1) {
    const [x, y, p] = pts[0];
    const r = half(p);
    return Array.from({ length: 12 }, (_, i) => [x + r * Math.cos((i / 12) * Math.PI * 2), y + r * Math.sin((i / 12) * Math.PI * 2)] as [number, number]);
  }
  // Light smoothing removes the jitter of fast mouse moves.
  const sm = pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    const a = pts[i - 1];
    const b = pts[i + 1];
    return [(a[0] + p[0] * 2 + b[0]) / 4, (a[1] + p[1] * 2 + b[1]) / 4, p[2]] as DrawPoint;
  });
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < sm.length; i++) {
    const prev = sm[Math.max(0, i - 1)];
    const next = sm[Math.min(sm.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const h = half(sm[i][2]);
    left.push([sm[i][0] - dy * h, sm[i][1] + dx * h]);
    right.push([sm[i][0] + dy * h, sm[i][1] - dx * h]);
  }
  const cap = (c: DrawPoint, from: [number, number], to: [number, number]): [number, number][] => {
    const r = half(c[2]);
    const a0 = Math.atan2(from[1] - c[1], from[0] - c[0]);
    let a1 = Math.atan2(to[1] - c[1], to[0] - c[0]);
    if (a1 > a0) a1 -= Math.PI * 2;
    return Array.from({ length: 6 }, (_, i) => {
      const a = a0 + ((a1 - a0) * (i + 1)) / 7;
      return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)] as [number, number];
    });
  };
  const end = sm[sm.length - 1];
  const start = sm[0];
  return [...left, ...cap(end, left[left.length - 1], right[right.length - 1]), ...right.reverse(), ...cap(start, right[right.length - 1], left[0])];
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

export function polygonPath(poly: [number, number][]): string {
  if (!poly.length) return "";
  return `M ${poly.map(([x, y]) => `${f(x)} ${f(y)}`).join(" L ")} Z`;
}

export function markerPath(pts: DrawPoint[]): string {
  if (!pts.length) return "";
  if (pts.length === 1) return `M ${f(pts[0][0])} ${f(pts[0][1])} L ${f(pts[0][0] + 0.01)} ${f(pts[0][1])}`;
  return `M ${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join(" L ")}`;
}

/** Paper pattern as line segments (x1, y1, x2, y2) plus dots, in page points. */
export function paperPattern(paper: Paper, w: number, h: number) {
  const lines: { x1: number; y1: number; x2: number; y2: number; color: string; width: number }[] = [];
  const dots: [number, number][] = [];
  if (paper === "ruled") {
    for (let y = 96; y < h - 30; y += 26) lines.push({ x1: 0, y1: y, x2: w, y2: y, color: "#b9c9ea", width: 0.6 });
    lines.push({ x1: 64, y1: 0, x2: 64, y2: h, color: "#f0a8a8", width: 0.8 });
  } else if (paper === "grid") {
    for (let y = 18; y < h; y += 18) lines.push({ x1: 0, y1: y, x2: w, y2: y, color: "#d9dee8", width: 0.4 });
    for (let x = 18; x < w; x += 18) lines.push({ x1: x, y1: 0, x2: x, y2: h, color: "#d9dee8", width: 0.4 });
  } else if (paper === "dots") {
    for (let y = 18; y < h; y += 18) for (let x = 18; x < w; x += 18) dots.push([x, y]);
  }
  return { lines, dots };
}

export async function drawingToPdf(pages: DrawPage[], o: { paper: Paper; orientation: "portrait" | "landscape"; name?: string }): Promise<OutFile> {
  const doc = await newDoc();
  const [w, h] = PAGE_SIZES[o.orientation];
  for (const pg of pages) {
    const page = doc.addPage([w, h]);
    const { lines, dots } = paperPattern(o.paper, w, h);
    for (const l of lines) page.drawLine({ start: { x: l.x1, y: h - l.y1 }, end: { x: l.x2, y: h - l.y2 }, thickness: l.width, color: hexToRgb(l.color) });
    for (const [x, y] of dots) page.drawCircle({ x, y: h - y, size: 0.7, color: hexToRgb("#c3c9d6") });
    for (const s of pg.strokes) {
      if (s.kind === "marker") {
        page.drawSvgPath(markerPath(s.points), { x: 0, y: h, borderColor: hexToRgb(s.color), borderWidth: s.width, borderOpacity: 0.35, borderLineCap: LineCapStyle.Round, blendMode: BlendMode.Multiply });
      } else {
        // borderColor must be present (even undefined) or pdf-lib adds a black outline.
        page.drawSvgPath(polygonPath(strokeOutline(s.points, s.width)), { x: 0, y: h, color: hexToRgb(s.color), borderColor: undefined });
      }
    }
  }
  return pdfOut(`${o.name ?? "drawing"}.pdf`, await saveDoc(doc), `${pages.length} page${pages.length === 1 ? "" : "s"}`);
}
