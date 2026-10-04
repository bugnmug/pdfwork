/**
 * Place things on existing pages the way a reader sees them.
 *
 * A PDF page can carry /Rotate and a CropBox that does not start at (0,0).
 * Stamps drawn in raw page coordinates then end up sideways or off-page (the
 * classic "page number running down the left edge of a landscape scan"). This
 * module converts between the visual frame (what the viewer shows, origin at
 * the visual bottom-left, y up) and PDF user space.
 */
import type { PDFPage } from "./core";

export type Frame = {
  /** Visual width/height (after rotation). */
  width: number;
  height: number;
  /** Page rotation, normalised to 0/90/180/270. */
  rotation: 0 | 90 | 180 | 270;
  /** Visible box in user space. */
  box: { x: number; y: number; width: number; height: number };
};

export function pageFrame(page: PDFPage): Frame {
  const raw = page.getRotation().angle;
  const rotation = ((((Math.round(raw / 90) * 90) % 360) + 360) % 360) as Frame["rotation"];
  let box = page.getCropBox();
  const media = page.getMediaBox();
  // Clamp crop box to media box (some files have bogus crop boxes).
  const x0 = Math.max(box.x, media.x);
  const y0 = Math.max(box.y, media.y);
  const x1 = Math.min(box.x + box.width, media.x + media.width);
  const y1 = Math.min(box.y + box.height, media.y + media.height);
  if (x1 - x0 > 1 && y1 - y0 > 1) box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  else box = media;
  const swap = rotation === 90 || rotation === 270;
  return { width: swap ? box.height : box.width, height: swap ? box.width : box.height, rotation, box };
}

/** Visual point (origin bottom-left, y up) → user space point. */
export function toUser(f: Frame, u: number, v: number): { x: number; y: number } {
  const { x: cx, y: cy, width: w, height: h } = f.box;
  switch (f.rotation) {
    case 90:
      return { x: cx + w - v, y: cy + u };
    case 180:
      return { x: cx + w - u, y: cy + h - v };
    case 270:
      return { x: cx + v, y: cy + h - u };
    default:
      return { x: cx + u, y: cy + v };
  }
}

/** User space point → visual point (origin bottom-left, y up). */
export function toVisual(f: Frame, x: number, y: number): { u: number; v: number } {
  const { x: cx, y: cy, width: w, height: h } = f.box;
  const a = x - cx;
  const b = y - cy;
  switch (f.rotation) {
    case 90:
      return { u: b, v: w - a };
    case 180:
      return { u: w - a, v: h - b };
    case 270:
      return { u: h - b, v: a };
    default:
      return { u: a, v: b };
  }
}

/**
 * Placement for drawing something whose own frame is axis-aligned in the
 * visual frame: returns the user-space origin and the rotation to pass to
 * pdf-lib's drawText / drawRectangle / drawImage (all rotate about origin).
 */
export function place(f: Frame, u: number, v: number, extraRotate = 0) {
  const p = toUser(f, u, v);
  return { x: p.x, y: p.y, rotate: (f.rotation + extraRotate) % 360 };
}

/** Visual top-left based rectangle (as used by on-screen editors, y down) → visual bottom-left. */
export function fromTopLeft(f: Frame, left: number, top: number, w: number, h: number) {
  return { u: left, v: f.height - top - h, w, h };
}

export type Anchor =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right";

/** Where to put a box of size (w,h) at an anchor with a margin, in visual coords (bottom-left origin). */
export function anchorPoint(f: Frame, anchor: Anchor, w: number, h: number, margin: number) {
  const col = anchor.endsWith("left") ? 0 : anchor.endsWith("right") ? 2 : 1;
  const row = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? 2 : 1;
  const u = col === 0 ? margin : col === 2 ? f.width - margin - w : (f.width - w) / 2;
  const v = row === 0 ? f.height - margin - h : row === 2 ? margin : (f.height - h) / 2;
  return { u, v };
}
