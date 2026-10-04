/** Whiteboard model, drawing and export. Shared by the board UI and its PDF export. */
import { markerPath, polygonPath, strokeOutline, type DrawPoint } from "./pdf/draw";

export const BW = 1600;
export const BH = 1000;

export type El =
  | { id: string; page: string; kind: "pen" | "marker"; color: string; width: number; points: DrawPoint[] }
  | { id: string; page: string; kind: "rect" | "ellipse" | "line" | "arrow"; color: string; width: number; x1: number; y1: number; x2: number; y2: number; fill?: boolean }
  | { id: string; page: string; kind: "text"; color: string; size: number; x: number; y: number; text: string }
  | { id: string; page: string; kind: "note"; color: string; x: number; y: number; w: number; h: number; text: string };

export type BoardPage = { id: string; bg?: string };
export type Board = { pages: BoardPage[]; els: Record<string, El> };

export type Op = { type: "put"; el: El } | { type: "remove"; ids: string[] } | { type: "page"; page: BoardPage; after?: string } | { type: "drop-page"; id: string } | { type: "clear"; page: string };

export function applyOp(b: Board, op: Op): Board {
  switch (op.type) {
    case "put":
      return { ...b, els: { ...b.els, [op.el.id]: op.el } };
    case "remove": {
      const els = { ...b.els };
      for (const id of op.ids) delete els[id];
      return { ...b, els };
    }
    case "page": {
      if (b.pages.some((p) => p.id === op.page.id)) return b;
      const i = op.after ? b.pages.findIndex((p) => p.id === op.after) : -1;
      const pages = b.pages.slice();
      pages.splice(i >= 0 ? i + 1 : pages.length, 0, op.page);
      return { ...b, pages };
    }
    case "drop-page": {
      if (b.pages.length <= 1) return b;
      const els = Object.fromEntries(Object.entries(b.els).filter(([, e]) => e.page !== op.id));
      return { pages: b.pages.filter((p) => p.id !== op.id), els };
    }
    case "clear":
      return { ...b, els: Object.fromEntries(Object.entries(b.els).filter(([, e]) => e.page !== op.page)) };
  }
}

const NOTE_FONT = (size: number) => `${size}px "Doc Sans", system-ui, sans-serif`;

export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const next = line + w;
      if (ctx.measureText(next.trimEnd()).width > maxW && line.trim()) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function bbox(e: El, ctx?: CanvasRenderingContext2D): { x: number; y: number; w: number; h: number } {
  switch (e.kind) {
    case "pen":
    case "marker": {
      const xs = e.points.map((p) => p[0]);
      const ys = e.points.map((p) => p[1]);
      const pad = e.width;
      return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
    }
    case "text": {
      let w = e.text.length * e.size * 0.55;
      if (ctx) {
        ctx.font = NOTE_FONT(e.size);
        w = Math.max(...e.text.split("\n").map((l) => ctx.measureText(l).width));
      }
      return { x: e.x, y: e.y, w: Math.max(10, w), h: e.text.split("\n").length * e.size * 1.25 };
    }
    case "note":
      return { x: e.x, y: e.y, w: e.w, h: e.h };
    default:
      return { x: Math.min(e.x1, e.x2) - e.width, y: Math.min(e.y1, e.y2) - e.width, w: Math.abs(e.x2 - e.x1) + e.width * 2, h: Math.abs(e.y2 - e.y1) + e.width * 2 };
  }
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hit(e: El, x: number, y: number, tol = 8, ctx?: CanvasRenderingContext2D): boolean {
  if (e.kind === "pen" || e.kind === "marker") {
    for (let i = 1; i < e.points.length; i++) if (distToSeg(x, y, e.points[i - 1][0], e.points[i - 1][1], e.points[i][0], e.points[i][1]) < tol + e.width / 2) return true;
    return e.points.length === 1 && Math.hypot(x - e.points[0][0], y - e.points[0][1]) < tol + e.width;
  }
  if (e.kind === "line" || e.kind === "arrow") return distToSeg(x, y, e.x1, e.y1, e.x2, e.y2) < tol + e.width / 2;
  const b = bbox(e, ctx);
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
}

export function moved(e: El, dx: number, dy: number): El {
  switch (e.kind) {
    case "pen":
    case "marker":
      return { ...e, points: e.points.map(([x, y, p]) => [x + dx, y + dy, p] as DrawPoint) };
    case "text":
    case "note":
      return { ...e, x: e.x + dx, y: e.y + dy };
    default:
      return { ...e, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy };
  }
}

export function arrowHeadPts(x1: number, y1: number, x2: number, y2: number, w: number): [number, number][] {
  const len = Math.max(14, w * 4);
  const a = Math.atan2(y2 - y1, x2 - x1);
  return [
    [x2, y2],
    [x2 - len * Math.cos(a - Math.PI / 7), y2 - len * Math.sin(a - Math.PI / 7)],
    [x2 - len * Math.cos(a + Math.PI / 7), y2 - len * Math.sin(a + Math.PI / 7)],
  ];
}

export function drawEl(ctx: CanvasRenderingContext2D, e: El) {
  ctx.save();
  switch (e.kind) {
    case "pen": {
      const poly = strokeOutline(e.points, e.width);
      if (poly.length) {
        ctx.fillStyle = e.color;
        ctx.fill(new Path2D(polygonPath(poly)));
      }
      break;
    }
    case "marker":
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = "multiply";
      ctx.strokeStyle = e.color;
      ctx.lineWidth = e.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke(new Path2D(markerPath(e.points)));
      break;
    case "rect":
    case "ellipse": {
      const x = Math.min(e.x1, e.x2);
      const y = Math.min(e.y1, e.y2);
      const w = Math.abs(e.x2 - e.x1);
      const h = Math.abs(e.y2 - e.y1);
      ctx.beginPath();
      if (e.kind === "rect") ctx.roundRect(x, y, w, h, 4);
      else ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      if (e.fill) {
        ctx.fillStyle = e.color;
        ctx.globalAlpha = 0.25;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = e.color;
      ctx.lineWidth = e.width;
      ctx.stroke();
      break;
    }
    case "line":
    case "arrow":
      ctx.strokeStyle = e.color;
      ctx.fillStyle = e.color;
      ctx.lineWidth = e.width;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
      if (e.kind === "arrow") {
        const p = arrowHeadPts(e.x1, e.y1, e.x2, e.y2, e.width);
        ctx.beginPath();
        ctx.moveTo(p[0][0], p[0][1]);
        ctx.lineTo(p[1][0], p[1][1]);
        ctx.lineTo(p[2][0], p[2][1]);
        ctx.closePath();
        ctx.fill();
      }
      break;
    case "text":
      ctx.fillStyle = e.color;
      ctx.font = NOTE_FONT(e.size);
      ctx.textBaseline = "top";
      e.text.split("\n").forEach((l, i) => ctx.fillText(l, e.x, e.y + i * e.size * 1.25));
      break;
    case "note": {
      ctx.shadowColor = "rgb(0 0 0 / 0.18)";
      ctx.shadowBlur = 12;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = e.color;
      ctx.fillRect(e.x, e.y, e.w, e.h);
      ctx.shadowColor = "transparent";
      ctx.fillStyle = "#1f2937";
      ctx.font = NOTE_FONT(22);
      ctx.textBaseline = "top";
      const lines = wrapText(ctx, e.text, e.w - 28);
      lines.slice(0, Math.floor((e.h - 24) / 28)).forEach((l, i) => ctx.fillText(l, e.x + 14, e.y + 14 + i * 28));
      break;
    }
  }
  ctx.restore();
}

/** Vector PDF of every page (backgrounds as images, ink and shapes as paths, text as real text). */
export async function boardToPdf(board: Board): Promise<import("./pdf/core").OutFile> {
  const { newDoc, saveDoc, pdfOut, hexToRgb, embedImage } = await import("./pdf/core");
  const { FontSet } = await import("./pdf/fonts");
  const { BlendMode, LineCapStyle } = await import("@cantoo/pdf-lib");
  const doc = await newDoc();
  const fonts = new FontSet(doc);
  const s = 842 / BW;
  const W = BW * s;
  const H = BH * s;
  const els = Object.values(board.els);
  for (const pg of board.pages) {
    const page = doc.addPage([W, H]);
    if (pg.bg) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(pg.bg);
      if (m) {
        const img = await embedImage(doc, Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)), m[1]);
        const k = Math.min(W / img.width, H / img.height);
        page.drawImage(img, { x: (W - img.width * k) / 2, y: (H - img.height * k) / 2, width: img.width * k, height: img.height * k });
      }
    }
    const path = (d: string, o: { fill?: string; stroke?: string; width?: number; opacity?: number; blend?: boolean }) =>
      page.drawSvgPath(d, {
        x: 0,
        y: H,
        scale: s,
        color: o.fill ? hexToRgb(o.fill) : undefined,
        opacity: o.fill ? o.opacity : undefined,
        borderColor: o.stroke ? hexToRgb(o.stroke) : undefined,
        borderWidth: o.stroke ? o.width : undefined,
        borderOpacity: o.stroke ? o.opacity : undefined,
        borderLineCap: o.stroke ? LineCapStyle.Round : undefined,
        blendMode: o.blend ? BlendMode.Multiply : undefined,
      });
    for (const e of els.filter((x) => x.page === pg.id)) {
      switch (e.kind) {
        case "pen":
          path(polygonPath(strokeOutline(e.points, e.width)), { fill: e.color });
          break;
        case "marker":
          path(markerPath(e.points), { stroke: e.color, width: e.width, opacity: 0.35, blend: true });
          break;
        case "rect":
        case "ellipse": {
          const x = Math.min(e.x1, e.x2);
          const y = Math.min(e.y1, e.y2);
          const w = Math.abs(e.x2 - e.x1);
          const h = Math.abs(e.y2 - e.y1);
          const k = 0.5522847498;
          const d =
            e.kind === "rect"
              ? `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`
              : `M ${x + w} ${y + h / 2} C ${x + w} ${y + h / 2 + (h / 2) * k} ${x + w / 2 + (w / 2) * k} ${y + h} ${x + w / 2} ${y + h} C ${x + w / 2 - (w / 2) * k} ${y + h} ${x} ${y + h / 2 + (h / 2) * k} ${x} ${y + h / 2} C ${x} ${y + h / 2 - (h / 2) * k} ${x + w / 2 - (w / 2) * k} ${y} ${x + w / 2} ${y} C ${x + w / 2 + (w / 2) * k} ${y} ${x + w} ${y + h / 2 - (h / 2) * k} ${x + w} ${y + h / 2} Z`;
          if (e.fill) path(d, { fill: e.color, opacity: 0.25 });
          path(d, { stroke: e.color, width: e.width });
          break;
        }
        case "line":
        case "arrow":
          path(`M ${e.x1} ${e.y1} L ${e.x2} ${e.y2}`, { stroke: e.color, width: e.width });
          if (e.kind === "arrow") {
            const p = arrowHeadPts(e.x1, e.y1, e.x2, e.y2, e.width);
            path(`M ${p[0].join(" ")} L ${p[1].join(" ")} L ${p[2].join(" ")} Z`, { fill: e.color });
          }
          break;
        case "text":
          for (const [i, line] of e.text.split("\n").entries()) {
            if (!line) continue;
            await fonts.draw(page, line, { x: e.x * s, y: H - (e.y + i * e.size * 1.25 + e.size * 0.95) * s, size: e.size * s, color: hexToRgb(e.color) });
          }
          break;
        case "note": {
          path(`M ${e.x} ${e.y} H ${e.x + e.w} V ${e.y + e.h} H ${e.x} Z`, { fill: e.color });
          const lines = await fonts.wrap(e.text, 22 * s, (e.w - 28) * s);
          for (const [i, line] of lines.slice(0, Math.floor((e.h - 24) / 28)).entries()) await fonts.draw(page, line, { x: (e.x + 14) * s, y: H - (e.y + 14 + i * 28 + 20) * s, size: 22 * s, color: hexToRgb("#1f2937") });
          break;
        }
      }
    }
  }
  return pdfOut(`whiteboard-${new Date().toISOString().slice(0, 10)}.pdf`, await saveDoc(doc), `${board.pages.length} page${board.pages.length === 1 ? "" : "s"}`);
}
