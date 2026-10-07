/**
 * Writes on-screen edits (text, shapes, ink, images, whiteout, highlights)
 * into a PDF. Objects are positioned in each page's visual frame: PDF points,
 * origin at the top-left of the page as displayed, y growing downward. Pages
 * with /Rotate or offset crop boxes are handled, so what you place on screen
 * lands in the same spot in the file.
 */
import { BlendMode, LineCapStyle } from "@cantoo/pdf-lib";
import { degrees, embedImage, hexToRgb, pdfOut, saveDoc, stem, type OutFile, type ProgressFn } from "./core";
import { FontSet, matchFace, type Face, type Family } from "./fonts";
import { pageFrame, place, type Frame } from "./geometry";
import { open, type Src } from "./pages";
import { removeTextIn } from "./textedit";

type Base = { id: string; page: number };
/**
 * Text placed on a page. A line retyped with Edit text has `coverId`, the whiteout over the old
 * line, and `face`, a face with the widths of the line's own font when there is one.
 */
export type TextObj = Base & { type: "text"; x: number; y: number; text: string; size: number; color: string; family: Family; face?: Face; bold?: boolean; italic?: boolean; coverId?: string; original?: string };
/** `erase`: the whiteout over a line deleted with Edit text (only there to take the old words away). */
export type RectObj = Base & { type: "rect"; x: number; y: number; w: number; h: number; mode: "whiteout" | "highlight" | "box" | "redact"; color: string; strokeWidth?: number; fill?: boolean; erase?: boolean };
export type EllipseObj = Base & { type: "ellipse"; x: number; y: number; w: number; h: number; color: string; strokeWidth: number; fill?: boolean };
export type LineObj = Base & { type: "line"; x1: number; y1: number; x2: number; y2: number; color: string; strokeWidth: number; arrow?: boolean };
export type InkObj = Base & { type: "ink"; points: [number, number][]; color: string; strokeWidth: number; opacity?: number };
export type ImageObj = Base & { type: "image"; x: number; y: number; w: number; h: number; src: string; opacity?: number };
export type EditObject = TextObj | RectObj | EllipseObj | LineObj | InkObj | ImageObj;

/** Line height and Noto vertical metrics, shared with the on-screen editor so placement matches. */
export const LINE_HEIGHT = 1.25;
const ASC = 1.069;
const DESC = 0.293;
export const BASELINE = (LINE_HEIGHT - (ASC + DESC)) / 2 + ASC;

const f2 = (n: number) => (Math.round(n * 100) / 100).toString();

function svgRect(x: number, y: number, w: number, h: number) {
  return `M ${f2(x)} ${f2(y)} H ${f2(x + w)} V ${f2(y + h)} H ${f2(x)} Z`;
}

function svgEllipse(x: number, y: number, w: number, h: number) {
  const rx = w / 2;
  const ry = h / 2;
  const cx = x + rx;
  const cy = y + ry;
  const k = 0.5522847498;
  return [
    `M ${f2(cx + rx)} ${f2(cy)}`,
    `C ${f2(cx + rx)} ${f2(cy + ry * k)} ${f2(cx + rx * k)} ${f2(cy + ry)} ${f2(cx)} ${f2(cy + ry)}`,
    `C ${f2(cx - rx * k)} ${f2(cy + ry)} ${f2(cx - rx)} ${f2(cy + ry * k)} ${f2(cx - rx)} ${f2(cy)}`,
    `C ${f2(cx - rx)} ${f2(cy - ry * k)} ${f2(cx - rx * k)} ${f2(cy - ry)} ${f2(cx)} ${f2(cy - ry)}`,
    `C ${f2(cx + rx * k)} ${f2(cy - ry)} ${f2(cx + rx)} ${f2(cy - ry * k)} ${f2(cx + rx)} ${f2(cy)} Z`,
  ].join(" ");
}

/** Smooth an ink stroke with quadratic curves through midpoints. */
export function svgInk(points: [number, number][]) {
  if (!points.length) return "";
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M ${f2(x)} ${f2(y)} L ${f2(x + 0.01)} ${f2(y + 0.01)}`;
  }
  let d = `M ${f2(points[0][0])} ${f2(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += ` Q ${f2(x)} ${f2(y)} ${f2((x + nx) / 2)} ${f2((y + ny) / 2)}`;
  }
  const last = points[points.length - 1];
  return d + ` L ${f2(last[0])} ${f2(last[1])}`;
}

export function arrowHead(x1: number, y1: number, x2: number, y2: number, width: number) {
  const len = Math.max(8, width * 4.5);
  const a = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  const p1 = [x2 - len * Math.cos(a - spread), y2 - len * Math.sin(a - spread)];
  const p2 = [x2 - len * Math.cos(a + spread), y2 - len * Math.sin(a + spread)];
  return `M ${f2(x2)} ${f2(y2)} L ${f2(p1[0])} ${f2(p1[1])} L ${f2(p2[0])} ${f2(p2[1])} Z`;
}

/** Draws an SVG path given in the page's visual top-left frame. */
function drawPath(page: import("./core").PDFPage, f: Frame, d: string, o: { fill?: string; stroke?: string; width?: number; opacity?: number; blend?: BlendMode; round?: boolean }) {
  const origin = place(f, 0, f.height);
  page.drawSvgPath(d, {
    x: origin.x,
    y: origin.y,
    rotate: degrees(origin.rotate),
    color: o.fill ? hexToRgb(o.fill) : undefined,
    opacity: o.fill ? o.opacity : undefined,
    borderColor: o.stroke ? hexToRgb(o.stroke) : undefined,
    borderWidth: o.stroke ? (o.width ?? 1) : undefined,
    borderOpacity: o.stroke ? o.opacity : undefined,
    borderLineCap: o.round ? LineCapStyle.Round : undefined,
    blendMode: o.blend,
  });
}

/** A line of a page's text as Edit text offers it (see editlines.ts). */
export type LineRef = { text: string; x: number; y: number; w: number; h: number; base: number; size: number; family: Family; face?: string; bold: boolean; italic: boolean };

/**
 * Edit text's two objects for a line: a whiteout over the old words (in `bg`, the colour behind
 * them, while editing; when saving takes the words out of the page it isn't drawn) and the new
 * text at the line's place and size, in a face with the widths of the line's font when there is
 * one. An empty `text` deletes the line.
 */
export function retypeLine(line: LineRef, page: number, o: { coverId: string; textId: string; bg: string; fg: string; text?: string }): [RectObj, TextObj] {
  // A little wider than the words, for slanted letters and scans (where the cover stays).
  const padX = Math.max(1, line.size * 0.12);
  const padY = Math.max(0.5, line.size * 0.06);
  return [
    { id: o.coverId, page, type: "rect", mode: "whiteout", x: line.x - padX, y: line.y - padY, w: line.w + padX * 2, h: line.h + padY * 2, color: o.bg },
    { id: o.textId, page, type: "text", x: line.x, y: line.base - BASELINE * line.size, text: o.text ?? line.text, original: line.text, size: Math.round(line.size * 10) / 10, color: o.fg, family: line.family, face: matchFace(line.face), bold: line.bold, italic: line.italic, coverId: o.coverId },
  ];
}

function dataUrlBytes(src: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
  if (!m) throw new Error("An image could not be read.");
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  return { bytes: Uint8Array.from(raw, (c) => c.charCodeAt(0)), mime: m[1] };
}

export async function applyEdits(src: Src, objects: EditObject[], onProgress?: ProgressFn): Promise<OutFile> {
  const doc = await open(src);
  const fonts = new FontSet(doc);
  const images = new Map<string, Promise<Awaited<ReturnType<typeof embedImage>>>>();
  const pages = doc.getPages();
  const byPage = new Map<number, EditObject[]>();
  for (const o of objects) {
    if (o.page < 0 || o.page >= pages.length) continue;
    const list = byPage.get(o.page) ?? [];
    list.push(o);
    byPage.set(o.page, list);
  }
  // Words under a whiteout are taken out of the page itself, not just covered, so they can no
  // longer be copied, searched or extracted. A whiteout that only hid a line retyped (or deleted)
  // with Edit text is then left out, so the page's own background shows; it stays when some of
  // the words couldn't be taken out (inside a form shared with other pages, or in a font whose
  // widths are unknown), or were an invisible layer over a scan, whose visible words are in
  // the picture.
  const retyped = new Set(objects.flatMap((o) => (o.type === "text" && o.coverId ? [o.coverId] : o.type === "rect" && o.erase ? [o.id] : [])));
  const dropped = new Set<string>();
  for (const [pi, list] of byPage) {
    const whiteouts = list.filter((o): o is RectObj => o.type === "rect" && o.mode === "whiteout");
    if (!whiteouts.length) continue;
    try {
      removeTextIn(doc, pi, whiteouts).forEach((r, k) => {
        if (retyped.has(whiteouts[k].id) && r.removed > 0 && !r.missed && !r.invisible) dropped.add(whiteouts[k].id);
      });
    } catch {
      /* the cover still hides them */
    }
  }
  // Paint order: covers first, then shapes and ink, highlights, images, text on top.
  const rank = (o: EditObject) => (o.type === "rect" && o.mode === "whiteout" ? 0 : o.type === "rect" && o.mode === "highlight" ? 2 : o.type === "image" ? 3 : o.type === "text" ? 4 : 1);
  let done = 0;
  for (const [pi, list] of byPage) {
    const page = pages[pi];
    const f = pageFrame(page);
    for (const o of [...list].sort((a, b) => rank(a) - rank(b))) {
      if (dropped.has(o.id)) continue;
      switch (o.type) {
        case "rect": {
          if (o.mode === "whiteout") drawPath(page, f, svgRect(o.x, o.y, o.w, o.h), { fill: o.color || "#ffffff" });
          else if (o.mode === "highlight") drawPath(page, f, svgRect(o.x, o.y, o.w, o.h), { fill: o.color || "#fde047", opacity: 0.45, blend: BlendMode.Multiply });
          else if (o.mode === "redact") drawPath(page, f, svgRect(o.x, o.y, o.w, o.h), { fill: "#000000" });
          else drawPath(page, f, svgRect(o.x, o.y, o.w, o.h), o.fill ? { fill: o.color } : { stroke: o.color, width: o.strokeWidth ?? 2 });
          break;
        }
        case "ellipse":
          drawPath(page, f, svgEllipse(o.x, o.y, o.w, o.h), o.fill ? { fill: o.color } : { stroke: o.color, width: o.strokeWidth });
          break;
        case "line":
          drawPath(page, f, `M ${f2(o.x1)} ${f2(o.y1)} L ${f2(o.x2)} ${f2(o.y2)}`, { stroke: o.color, width: o.strokeWidth, round: true });
          if (o.arrow) drawPath(page, f, arrowHead(o.x1, o.y1, o.x2, o.y2, o.strokeWidth), { fill: o.color });
          break;
        case "ink":
          if (o.points.length) drawPath(page, f, svgInk(o.points), { stroke: o.color, width: o.strokeWidth, opacity: o.opacity, round: true, blend: o.opacity && o.opacity < 1 ? BlendMode.Multiply : undefined });
          break;
        case "image": {
          let p = images.get(o.src);
          if (!p) {
            const { bytes, mime } = dataUrlBytes(o.src);
            p = embedImage(doc, bytes, mime);
            images.set(o.src, p);
          }
          const img = await p;
          const at = place(f, o.x, f.height - o.y - o.h);
          page.drawImage(img, { x: at.x, y: at.y, width: o.w, height: o.h, rotate: degrees(at.rotate), opacity: o.opacity });
          break;
        }
        case "text": {
          const style = { family: o.face ?? o.family, bold: o.bold, italic: o.italic };
          const lines = o.text.replace(/\r\n?/g, "\n").split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            const baseline = o.y + (BASELINE + i * LINE_HEIGHT) * o.size;
            const at = place(f, o.x, f.height - baseline);
            await fonts.draw(page, lines[i], { x: at.x, y: at.y, size: o.size, style, color: hexToRgb(o.color), rotate: at.rotate });
          }
          break;
        }
      }
    }
    done++;
    onProgress?.(done / byPage.size, `Page ${pi + 1}`);
  }
  return pdfOut(`${stem(src.name)}-edited.pdf`, await saveDoc(doc), `${objects.length} change${objects.length === 1 ? "" : "s"}`);
}
