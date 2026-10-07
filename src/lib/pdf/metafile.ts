/**
 * Windows metafiles (WMF and EMF): the vector pictures older Office files are full of
 * (clipart, logos, pasted charts, OLE objects' previews), played onto a canvas the way
 * GDI plays them: the object table, pens, brushes and fonts, mapping modes and the world
 * transform, shapes, paths, text, bitmaps and clipping. EMF+ records are skipped; files
 * that carry them also carry the plain GDI drawing.
 */
import { gunzipSync } from "fflate";
import { isSymbolFont, mapSymbols } from "./docx/symbols";

type Mat = [number, number, number, number, number, number];
type Pen = { style: number; width: number; color: string; cosmetic: boolean };
type Brush = { style: number; color: string; hatch: number; image?: HTMLCanvasElement };
type Font = { height: number; weight: number; italic: boolean; underline: boolean; strike: boolean; escapement: number; face: string; charset: number };
type Obj = { kind: "pen"; v: Pen } | { kind: "brush"; v: Brush } | { kind: "font"; v: Font } | { kind: "other" };
/** A clip in canvas pixels: keep inside a path, or keep outside a rectangle. */
type Clip = { keep: "in"; path: Path2D } | { keep: "out"; rect: [number, number, number, number] };
type State = {
  pen: Pen;
  brush: Brush;
  font: Font;
  text: string;
  bk: string;
  bkMode: number;
  align: number;
  fillRule: CanvasFillRule;
  mapMode: number;
  winOrg: [number, number];
  winExt: [number, number];
  vpOrg: [number, number];
  vpExt: [number, number];
  xform: Mat;
  clips: Clip[];
  cur: [number, number];
  arcCcw: boolean;
  rop2: number;
};

export type Metafile = { canvas: HTMLCanvasElement; w: number; h: number };

const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mul = (a: Mat, b: Mat): Mat => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const rgb = (r: number, g: number, b: number) => `rgb(${r},${g},${b})`;
const NULL_PEN: Pen = { style: 5, width: 0, color: "#000", cosmetic: true };
const BLACK_PEN: Pen = { style: 0, width: 0, color: "#000", cosmetic: true };
const WHITE_BRUSH: Brush = { style: 0, color: "#fff", hatch: 0 };
const NULL_BRUSH: Brush = { style: 1, color: "#fff", hatch: 0 };
const DEFAULT_FONT: Font = { height: -12, weight: 400, italic: false, underline: false, strike: false, escapement: 0, face: "Arial", charset: 0 };

/** GDI's stock objects (SelectObject with the high bit set). */
function stock(i: number): Obj {
  switch (i) {
    case 0:
      return { kind: "brush", v: WHITE_BRUSH };
    case 1:
      return { kind: "brush", v: { style: 0, color: rgb(192, 192, 192), hatch: 0 } };
    case 2:
      return { kind: "brush", v: { style: 0, color: rgb(128, 128, 128), hatch: 0 } };
    case 3:
      return { kind: "brush", v: { style: 0, color: rgb(64, 64, 64), hatch: 0 } };
    case 4:
      return { kind: "brush", v: { style: 0, color: "#000", hatch: 0 } };
    case 5:
      return { kind: "brush", v: NULL_BRUSH };
    case 6:
      return { kind: "pen", v: { ...BLACK_PEN, color: "#fff" } };
    case 7:
      return { kind: "pen", v: BLACK_PEN };
    case 8:
      return { kind: "pen", v: NULL_PEN };
    case 10:
    case 11:
    case 16:
      return { kind: "font", v: { ...DEFAULT_FONT, face: "Courier New" } };
    case 12:
    case 13:
    case 14:
      return { kind: "font", v: DEFAULT_FONT };
    default:
      return { kind: "other" };
  }
}

/** Fonts the browser is sure to have, for the faces metafiles name. */
function cssFont(f: Font, px: number): string {
  const face = f.face.trim();
  const generic = /mono|courier|consol|lucida console|fixedsys|terminal/i.test(face) ? "monospace" : /times|roman|serif|georgia|garamond|book|cambria|palatino|century/i.test(face) && !/sans/i.test(face) ? "serif" : "sans-serif";
  const fam = face && !/^(system|fixedsys|terminal|ms shell dlg)/i.test(face) ? `"${face.replace(/"/g, "")}", ${generic}` : generic;
  return `${f.italic ? "italic " : ""}${f.weight >= 600 ? "bold " : ""}${Math.max(1, px).toFixed(2)}px ${fam}`;
}

/** A device-independent bitmap (BITMAPINFO and bits) as a canvas; null for formats we can't read. */
async function dib(buf: DataView, bmi: number, bmiSize: number, bits: number, bitsSize: number, usagePalette: boolean, alpha = false): Promise<HTMLCanvasElement | null> {
  if (bmi + 12 > buf.byteLength) return null;
  const hsize = buf.getUint32(bmi, true);
  let w: number, h: number, bpp: number, comp: number, used: number;
  let palAt: number;
  let quad = 4;
  if (hsize === 12) {
    w = buf.getUint16(bmi + 4, true);
    h = buf.getInt16(bmi + 6, true);
    bpp = buf.getUint16(bmi + 10, true);
    comp = 0;
    used = 0;
    palAt = bmi + 12;
    quad = 3;
  } else {
    w = buf.getInt32(bmi + 4, true);
    h = buf.getInt32(bmi + 8, true);
    bpp = buf.getUint16(bmi + 14, true);
    comp = buf.getUint32(bmi + 16, true);
    used = buf.getUint32(bmi + 32, true);
    palAt = bmi + hsize;
  }
  const topDown = h < 0;
  h = Math.abs(h);
  if (w <= 0 || h <= 0 || w * h > 40e6) return null;
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset + bits, Math.max(0, Math.min(bitsSize || buf.byteLength - bits, buf.byteLength - bits)));
  // Compressed bitmaps that are whole JPEG or PNG files.
  if (comp === 4 || comp === 5) {
    const blob = new Blob([bytes.slice()], { type: comp === 4 ? "image/jpeg" : "image/png" });
    const img = await createImageBitmap(blob).catch(() => null);
    if (!img) return null;
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d")!.drawImage(img, 0, 0);
    return c;
  }
  const colors = bpp <= 8 ? used || 1 << bpp : 0;
  const pal: number[][] = [];
  for (let i = 0; i < colors && palAt + i * quad + 3 <= bmi + Math.max(bmiSize, hsize + colors * quad); i++) {
    const o = palAt + i * quad;
    if (o + 3 > buf.byteLength) break;
    pal.push(usagePalette ? [i, i, i] : [buf.getUint8(o + 2), buf.getUint8(o + 1), buf.getUint8(o)]);
  }
  let masks: [number, number, number, number] | null = null;
  if (comp === 3 && (bpp === 16 || bpp === 32)) {
    const at = hsize >= 52 ? bmi + 40 : palAt;
    masks = [buf.getUint32(at, true), buf.getUint32(at + 4, true), buf.getUint32(at + 8, true), hsize >= 56 ? buf.getUint32(bmi + 52, true) : 0];
  } else if (comp !== 0 && comp !== 1 && comp !== 2) return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const px = img.data;
  const set = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
    if (x >= w || y >= h) return;
    const row = topDown ? y : h - 1 - y;
    const i = (row * w + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };
  const palSet = (x: number, y: number, k: number) => {
    const p = pal[k] ?? [0, 0, 0];
    set(x, y, p[0], p[1], p[2]);
  };
  if (comp === 1 || comp === 2) {
    // Run-length encoded 8 or 4 bit.
    let x = 0;
    let y = 0;
    let i = 0;
    const four = comp === 2;
    while (i + 1 < bytes.length && y < h) {
      const n = bytes[i];
      const v = bytes[i + 1];
      i += 2;
      if (n > 0) {
        for (let k = 0; k < n; k++) palSet(x++, y, four ? (k % 2 === 0 ? v >> 4 : v & 15) : v);
      } else if (v === 0) {
        x = 0;
        y++;
      } else if (v === 1) break;
      else if (v === 2) {
        x += bytes[i];
        y += bytes[i + 1];
        i += 2;
      } else {
        for (let k = 0; k < v; k++) {
          const byte = bytes[i + (four ? k >> 1 : k)];
          palSet(x++, y, four ? (k % 2 === 0 ? byte >> 4 : byte & 15) : byte);
        }
        i += four ? (((v + 1) >> 1) + 1) & ~1 : (v + 1) & ~1;
      }
    }
  } else {
    const stride = Math.floor((w * bpp + 31) / 32) * 4;
    const shift = (m: number) => (m ? Math.log2(m & -m) : 0);
    const scale = (m: number) => (m ? 255 / (m >>> shift(m)) : 0);
    for (let y = 0; y < h; y++) {
      const r0 = y * stride;
      if (r0 + Math.ceil((w * bpp) / 8) > bytes.length) break;
      for (let x = 0; x < w; x++) {
        if (bpp === 1) palSet(x, y, (bytes[r0 + (x >> 3)] >> (7 - (x & 7))) & 1);
        else if (bpp === 4) palSet(x, y, (bytes[r0 + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15);
        else if (bpp === 8) palSet(x, y, bytes[r0 + x]);
        else if (bpp === 16) {
          const v = bytes[r0 + x * 2] | (bytes[r0 + x * 2 + 1] << 8);
          const m = masks ?? [0x7c00, 0x03e0, 0x001f, 0];
          set(x, y, ((v & m[0]) >>> shift(m[0])) * scale(m[0]), ((v & m[1]) >>> shift(m[1])) * scale(m[1]), ((v & m[2]) >>> shift(m[2])) * scale(m[2]));
        } else if (bpp === 24) set(x, y, bytes[r0 + x * 3 + 2], bytes[r0 + x * 3 + 1], bytes[r0 + x * 3]);
        else if (bpp === 32) {
          const o = r0 + x * 4;
          if (masks) {
            const v = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
            set(x, y, ((v & masks[0]) >>> shift(masks[0])) * scale(masks[0]), ((v & masks[1]) >>> shift(masks[1])) * scale(masks[1]), ((v & masks[2]) >>> shift(masks[2])) * scale(masks[2]));
          } else if (alpha) {
            // Premultiplied colour with its alpha (AlphaBlend's bitmaps).
            const al = bytes[o + 3];
            const k = al ? 255 / al : 0;
            set(x, y, Math.min(255, bytes[o + 2] * k), Math.min(255, bytes[o + 1] * k), Math.min(255, bytes[o] * k), al);
          } else set(x, y, bytes[o + 2], bytes[o + 1], bytes[o]);
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** The size of a metafile in points, or null when the bytes aren't one. */
export function metafileKind(b: Uint8Array): "wmf" | "emf" | null {
  if (b.length < 44) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) === 0x9ac6cdd7) return "wmf";
  if (dv.getUint32(0, true) === 1 && dv.getUint32(40, true) === 0x464d4520) return "emf";
  const t = dv.getUint16(0, true);
  if ((t === 1 || t === 2) && dv.getUint16(2, true) === 9) return "wmf";
  return null;
}

/**
 * Play a WMF or EMF (gzipped ones too) onto a canvas at about `dpi` dots per inch of the size
 * it will be shown at (`shown`: its longer side in points; its own size by default), never
 * more than `maxPx` on its longer side. Returns the canvas and the picture's own size in points.
 */
export async function playMetafile(input: Uint8Array, o: { shown?: number; dpi?: number; maxPx?: number } = {}): Promise<Metafile | null> {
  let bytes = input;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes);
    } catch {
      return null;
    }
  }
  const kind = metafileKind(bytes);
  if (!kind) return null;
  try {
    // Canvas pixels per point of the picture's own size, and per screen pixel (1/96 inch) as shown.
    const scale = (wPt: number, hPt: number) => {
      const natural = Math.max(wPt, hPt);
      const shown = o.shown && o.shown > 0 ? o.shown : natural;
      const long = Math.min((shown * (o.dpi ?? 200)) / 72, o.maxPx ?? 3000);
      return { k: long / natural, screen: (long / shown) * 0.75 };
    };
    return kind === "emf" ? await playEmf(bytes, scale) : await playWmf(bytes, scale);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ player */

/** What WMF and EMF share: the device context and the drawing. */
class Player {
  st: State;
  stack: State[] = [];
  objects = new Map<number, Obj>();
  path: Path2D | null = null;
  pathOpen = false;
  /** Device pixels to canvas pixels. */
  devToCanvas: Mat;
  constructor(
    public ctx: CanvasRenderingContext2D,
    devToCanvas: Mat,
    /** Canvas pixels in a screen pixel (1/96 inch): the thinnest line, a pattern's dot. */
    public px: number,
    /** Device pixels per millimetre, for the metric and English mapping modes. */
    public pxPerMm: [number, number] = [96 / 25.4, 96 / 25.4],
  ) {
    this.devToCanvas = devToCanvas;
    this.st = {
      pen: BLACK_PEN,
      brush: WHITE_BRUSH,
      font: DEFAULT_FONT,
      text: "#000",
      bk: "#fff",
      bkMode: 2,
      align: 0,
      fillRule: "evenodd",
      mapMode: 1,
      winOrg: [0, 0],
      winExt: [1, 1],
      vpOrg: [0, 0],
      vpExt: [1, 1],
      xform: IDENT,
      clips: [],
      cur: [0, 0],
      arcCcw: true,
      rop2: 13,
    };
  }

  /** Page (after the world transform) to device. */
  pageToDev(): Mat {
    const s = this.st;
    switch (s.mapMode) {
      case 7:
      case 8: {
        let sx = s.vpExt[0] / (s.winExt[0] || 1);
        let sy = s.vpExt[1] / (s.winExt[1] || 1);
        if (s.mapMode === 7) {
          // Isotropic: one scale, the smaller, keeping each axis's direction.
          const k = Math.min(Math.abs(sx), Math.abs(sy));
          sx = Math.sign(sx || 1) * k;
          sy = Math.sign(sy || 1) * k;
        }
        return [sx, 0, 0, sy, s.vpOrg[0] - s.winOrg[0] * sx, s.vpOrg[1] - s.winOrg[1] * sy];
      }
      case 2:
      case 3:
      case 4:
      case 5:
      case 6: {
        // Fixed units, y up: 0.1 mm, 0.01 mm, 0.01 inch, 0.001 inch, a twip.
        const mm = [0, 0, 0.1, 0.01, 0.254, 0.0254, 25.4 / 1440][s.mapMode];
        const sx = mm * this.pxPerMm[0];
        const sy = -mm * this.pxPerMm[1];
        return [sx, 0, 0, sy, s.vpOrg[0] - s.winOrg[0] * sx, s.vpOrg[1] - s.winOrg[1] * sy];
      }
      default:
        return [1, 0, 0, 1, s.vpOrg[0] - s.winOrg[0], s.vpOrg[1] - s.winOrg[1]];
    }
  }

  /** Logical coordinates to canvas pixels. */
  matrix(): Mat {
    return mul(mul(this.st.xform, this.pageToDev()), this.devToCanvas);
  }

  apply() {
    const m = this.matrix();
    this.ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }

  /** Canvas pixels per logical unit (for cosmetic pens and text). */
  scale() {
    const m = this.matrix();
    return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  }

  save() {
    this.stack.push({ ...this.st, clips: [...this.st.clips] });
  }

  restore(n: number) {
    // Negative: that many levels back; positive: that saved level.
    const k = n < 0 ? this.stack.length + n : n - 1;
    if (k < 0 || k >= this.stack.length) return;
    this.st = this.stack[k];
    this.stack.length = k;
  }

  create(i: number, o: Obj) {
    this.objects.set(i, o);
  }

  select(i: number) {
    const o = i & 0x80000000 ? stock(i & 0x7fffffff) : this.objects.get(i);
    if (!o) return;
    if (o.kind === "pen") this.st.pen = o.v;
    else if (o.kind === "brush") this.st.brush = o.v;
    else if (o.kind === "font") this.st.font = o.v;
  }

  /* ----- clipping (kept in canvas pixels, so later mapping changes don't move it) */

  clipRect(l: number, t: number, r: number, b: number, keep: "in" | "out") {
    const m = this.matrix();
    const pts = [
      [l, t],
      [r, t],
      [r, b],
      [l, b],
    ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    if (keep === "out") {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      this.st.clips = [...this.st.clips, { keep: "out", rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }];
      return;
    }
    const p = new Path2D();
    p.moveTo(pts[0][0], pts[0][1]);
    for (const q of pts.slice(1)) p.lineTo(q[0], q[1]);
    p.closePath();
    this.st.clips = [...this.st.clips, { keep: "in", path: p }];
  }

  /** Clip to the current path (logical coordinates), as SelectClipPath does. */
  clipPath(path: Path2D, replace: boolean) {
    const m = this.matrix();
    const p = new Path2D();
    p.addPath(path, new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]));
    this.st.clips = replace ? [{ keep: "in", path: p }] : [...this.st.clips, { keep: "in", path: p }];
  }

  /** Run a drawing with the clips set and the logical transform applied. */
  draw(fn: () => void) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const c of this.st.clips) {
      if (c.keep === "in") ctx.clip(c.path);
      else {
        const p = new Path2D();
        p.rect(-1e6, -1e6, 2e6, 2e6);
        p.rect(c.rect[0], c.rect[1], c.rect[2] - c.rect[0], c.rect[3] - c.rect[1]);
        ctx.clip(p, "evenodd");
      }
    }
    this.apply();
    fn();
    ctx.restore();
  }

  /* ----- painting */

  brushStyle(b: Brush): string | CanvasPattern | null {
    if (b.style === 1) return null;
    if (b.style === 2) return this.hatch(b);
    if ((b.style === 3 || b.style === 5 || b.style === 6) && b.image) {
      const pat = this.ctx.createPattern(b.image, "repeat");
      if (pat) {
        // A pattern's pixels are screen pixels, square on the canvas whatever the mapping.
        pat.setTransform(this.canvasSpace());
        return pat;
      }
    }
    return b.color;
  }

  hatch(b: Brush): CanvasPattern | string {
    const c = document.createElement("canvas");
    const n = 8;
    c.width = c.height = n;
    const g = c.getContext("2d")!;
    if (this.st.bkMode === 2) {
      g.fillStyle = this.st.bk;
      g.fillRect(0, 0, n, n);
    }
    g.strokeStyle = b.color;
    g.lineWidth = 1;
    g.beginPath();
    const h = b.hatch;
    const seg = (x0: number, y0: number, x1: number, y1: number) => {
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
    };
    // Horizontal, vertical, the two diagonals, a cross and a diagonal cross.
    if (h === 0 || h === 4) seg(0, 3.5, n, 3.5);
    if (h === 1 || h === 4) seg(3.5, 0, 3.5, n);
    if (h === 2 || h === 5) seg(0, 0, n, n);
    if (h === 3 || h === 5) seg(n, 0, 0, n);
    g.stroke();
    const pat = this.ctx.createPattern(c, "repeat");
    if (!pat) return b.color;
    pat.setTransform(this.canvasSpace());
    return pat;
  }

  /** From pattern pixels (screen pixels) to the current logical space. */
  canvasSpace(): DOMMatrix {
    const m = this.matrix();
    return new DOMMatrix([m[0], m[1], m[2], m[3], m[4], m[5]]).inverse().multiply(new DOMMatrix([this.px, 0, 0, this.px, 0, 0]));
  }

  stroke(p: Path2D) {
    const pen = this.st.pen;
    if (pen.style === 5 || this.st.rop2 === 11) return;
    const ctx = this.ctx;
    const sc = this.scale();
    // Cosmetic pens are a screen pixel wide, and no line is thinner.
    const thin = Math.max(1, this.px) / sc;
    const lw = pen.cosmetic || pen.width <= 0 ? thin : Math.max(pen.width, thin);
    ctx.lineWidth = lw;
    ctx.strokeStyle = pen.color;
    const unit = Math.max(lw, 1 / sc);
    const dash: Record<number, number[]> = { 1: [18, 6], 2: [3, 3], 3: [9, 6, 3, 6], 4: [9, 3, 3, 3, 3, 3] };
    ctx.setLineDash((dash[pen.style & 15] ?? []).map((v) => v * unit));
    const cap = pen.style & 0xf00;
    ctx.lineCap = cap === 0x100 ? "square" : cap === 0x200 ? "butt" : "round";
    const join = pen.style & 0xf000;
    ctx.lineJoin = join === 0x1000 ? "bevel" : join === 0x2000 ? "miter" : "round";
    ctx.stroke(p);
  }

  fill(p: Path2D) {
    const style = this.brushStyle(this.st.brush);
    if (!style || this.st.rop2 === 11) return;
    this.ctx.fillStyle = style;
    this.ctx.fill(p, this.st.fillRule);
  }

  /** A closed shape: filled with the brush, outlined with the pen (or added to the open path). */
  shape(p: Path2D, closed = true) {
    if (this.pathOpen && this.path) {
      this.path.addPath(p);
      return;
    }
    this.draw(() => {
      if (closed) this.fill(p);
      this.stroke(p);
    });
  }

  poly(pts: number[], close: boolean, fill: boolean) {
    if (pts.length < 4) return;
    const p = new Path2D();
    p.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
    if (close) p.closePath();
    if (this.pathOpen && this.path) {
      this.path.addPath(p);
      return;
    }
    this.draw(() => {
      if (fill) this.fill(p);
      this.stroke(p);
    });
  }

  polyPoly(groups: number[][], close: boolean) {
    const p = new Path2D();
    for (const pts of groups) {
      if (pts.length < 4) continue;
      p.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
      if (close) p.closePath();
    }
    if (this.pathOpen && this.path) {
      this.path.addPath(p);
      return;
    }
    this.draw(() => {
      if (close) this.fill(p);
      this.stroke(p);
    });
  }

  rect(l: number, t: number, r: number, b: number) {
    const p = new Path2D();
    p.rect(Math.min(l, r), Math.min(t, b), Math.abs(r - l), Math.abs(b - t));
    this.shape(p);
  }

  roundRect(l: number, t: number, r: number, b: number, cw: number, ch: number) {
    const p = new Path2D();
    const x0 = Math.min(l, r);
    const y0 = Math.min(t, b);
    const w = Math.abs(r - l);
    const h = Math.abs(b - t);
    const rx = Math.min(Math.abs(cw) / 2, w / 2);
    const ry = Math.min(Math.abs(ch) / 2, h / 2);
    p.moveTo(x0 + rx, y0);
    p.lineTo(x0 + w - rx, y0);
    p.ellipse(x0 + w - rx, y0 + ry, rx, ry, 0, -Math.PI / 2, 0);
    p.lineTo(x0 + w, y0 + h - ry);
    p.ellipse(x0 + w - rx, y0 + h - ry, rx, ry, 0, 0, Math.PI / 2);
    p.lineTo(x0 + rx, y0 + h);
    p.ellipse(x0 + rx, y0 + h - ry, rx, ry, 0, Math.PI / 2, Math.PI);
    p.lineTo(x0, y0 + ry);
    p.ellipse(x0 + rx, y0 + ry, rx, ry, 0, Math.PI, Math.PI * 1.5);
    p.closePath();
    this.shape(p);
  }

  ellipse(l: number, t: number, r: number, b: number) {
    const p = new Path2D();
    p.ellipse((l + r) / 2, (t + b) / 2, Math.abs(r - l) / 2, Math.abs(b - t) / 2, 0, 0, Math.PI * 2);
    this.shape(p);
  }

  /** Arc, chord or pie: counterclockwise on the page from the start radial to the end one. */
  arc(kind: "arc" | "chord" | "pie" | "arcto", l: number, t: number, r: number, b: number, xs: number, ys: number, xe: number, ye: number) {
    const cx = (l + r) / 2;
    const cy = (t + b) / 2;
    const rx = Math.abs(r - l) / 2 || 1;
    const ry = Math.abs(b - t) / 2 || 1;
    const a0 = Math.atan2((ys - cy) / ry, (xs - cx) / rx);
    const a1 = Math.atan2((ye - cy) / ry, (xe - cx) / rx);
    const m = this.matrix();
    // Counterclockwise as seen on the device: mirrored mappings turn it round.
    const ccw = (m[0] * m[3] - m[1] * m[2] > 0) === this.st.arcCcw;
    const p = new Path2D();
    if (kind === "pie") p.moveTo(cx, cy);
    else if (kind === "arcto") p.moveTo(this.st.cur[0], this.st.cur[1]);
    p.ellipse(cx, cy, rx, ry, 0, a0, a1 === a0 ? a0 + (ccw ? -2 * Math.PI : 2 * Math.PI) : a1, ccw);
    if (kind === "pie" || kind === "chord") p.closePath();
    if (kind === "arcto") this.st.cur = [cx + rx * Math.cos(a1), cy + ry * Math.sin(a1)];
    if (this.pathOpen && this.path) {
      this.path.addPath(p);
      return;
    }
    this.draw(() => {
      if (kind === "pie" || kind === "chord") this.fill(p);
      this.stroke(p);
    });
  }

  lineTo(x: number, y: number) {
    const [x0, y0] = this.st.cur;
    this.st.cur = [x, y];
    if (this.pathOpen && this.path) {
      this.path.lineTo(x, y);
      return;
    }
    const p = new Path2D();
    p.moveTo(x0, y0);
    p.lineTo(x, y);
    this.draw(() => this.stroke(p));
  }

  moveTo(x: number, y: number) {
    this.st.cur = [x, y];
    if (this.pathOpen && this.path) this.path.moveTo(x, y);
  }

  /**
   * Text at (x, y) with its alignment; `dx` gives each character's advance (logical units),
   * so the text keeps its width whatever font stands in for the original.
   */
  text(x: number, y: number, s: string, dx: number[] | null, opaque: [number, number, number, number] | null, clip: [number, number, number, number] | null) {
    if (!s) return;
    const f = this.st.font;
    const st = this.st;
    if (st.align & 1) [x, y] = st.cur;
    this.draw(() => {
      const ctx = this.ctx;
      const m = this.matrix();
      // A mapping with y up would turn the letters over: turn them back.
      const flipY = m[0] * m[3] - m[1] * m[2] < 0 ? -1 : 1;
      if (opaque) {
        ctx.fillStyle = st.bk;
        ctx.fillRect(Math.min(opaque[0], opaque[2]), Math.min(opaque[1], opaque[3]), Math.abs(opaque[2] - opaque[0]), Math.abs(opaque[3] - opaque[1]));
      }
      if (clip) {
        ctx.beginPath();
        ctx.rect(Math.min(clip[0], clip[2]), Math.min(clip[1], clip[3]), Math.abs(clip[2] - clip[0]), Math.abs(clip[3] - clip[1]));
        ctx.clip();
      }
      // Height: negative is the character height, positive the cell height (about 1.2 of it).
      const size = f.height < 0 ? -f.height : f.height > 0 ? f.height * 0.85 : 12;
      ctx.translate(x, y);
      ctx.scale(1, flipY);
      if (f.escapement) ctx.rotate((-f.escapement / 10) * (Math.PI / 180));
      // Dingbat fonts fill their em with the picture; the Unicode signs that stand in for
      // them are smaller in ordinary fonts.
      const dingbat = /^webdings/i.test(f.face.trim()) ? 1.7 : /^wingdings/i.test(f.face.trim()) ? 1.35 : 1;
      ctx.font = cssFont(isSymbolFont(f.face) ? { ...f, face: "" } : f, size * dingbat);
      const chars = [...s];
      const adv = dx && dx.length >= chars.length ? dx.slice(0, chars.length) : chars.map((c) => ctx.measureText(c).width);
      const width = dx && dx.length >= chars.length ? adv.reduce((a, b) => a + b, 0) : ctx.measureText(s).width;
      const h = st.align & 6;
      const x0 = h === 6 ? -width / 2 : h === 2 ? -width : 0;
      const v = st.align & 24;
      const met = ctx.measureText("Hg");
      const asc = met.fontBoundingBoxAscent || size * 0.9;
      const desc = met.fontBoundingBoxDescent || size * 0.22;
      const baseline = v === 24 ? 0 : v === 8 ? -desc : asc;
      if (st.bkMode === 2 && !opaque) {
        ctx.fillStyle = st.bk;
        ctx.fillRect(x0, baseline - asc, width, asc + desc);
      }
      ctx.fillStyle = st.text;
      ctx.textBaseline = "alphabetic";
      if (dx && dx.length >= chars.length) {
        let cx = x0;
        chars.forEach((c, i) => {
          ctx.fillText(c, cx, baseline);
          cx += adv[i];
        });
      } else ctx.fillText(s, x0, baseline);
      if (f.underline || f.strike) {
        ctx.fillStyle = st.text;
        const t = Math.max(size / 18, 0.5 / this.scale());
        if (f.underline) ctx.fillRect(x0, baseline + size * 0.12, width, t);
        if (f.strike) ctx.fillRect(x0, baseline - size * 0.3, width, t);
      }
      if (st.align & 1) st.cur = [x + x0 + width, y];
    });
  }

  /** A bitmap into the logical rectangle (x, y, w, h), as the raster operation says. */
  blit(img: HTMLCanvasElement | null, x: number, y: number, w: number, h: number, sx: number, sy: number, sw: number, sh: number, rop: number) {
    const ctx = this.ctx;
    const op = rop >>> 16;
    if (!img) {
      // No source: a pattern fill (PatBlt), or black or white.
      if (op === 0x42 || op === 0xff) {
        this.draw(() => {
          ctx.fillStyle = op === 0x42 ? "#000" : "#fff";
          ctx.fillRect(x, y, w, h);
        });
      } else if (op === 0xf0 || op === 0x5a) {
        const style = this.brushStyle(this.st.brush);
        if (style)
          this.draw(() => {
            ctx.fillStyle = style;
            ctx.fillRect(x, y, w, h);
          });
      }
      return;
    }
    if (op === 0xaa) return;
    this.draw(() => {
      // Masks drawn with AND, OR and XOR (clipart's way to be transparent): multiply,
      // lighten and difference do the same for black-and-white masks.
      ctx.globalCompositeOperation = op === 0x88 ? "multiply" : op === 0xee ? "lighter" : op === 0x66 ? "difference" : op === 0x33 ? "difference" : "source-over";
      ctx.imageSmoothingEnabled = true;
      const fx = w < 0;
      const fy = h < 0;
      ctx.translate(x + (fx ? w : 0), y + (fy ? h : 0));
      ctx.scale(fx ? -1 : 1, fy ? -1 : 1);
      try {
        ctx.drawImage(img, Math.max(0, sx), Math.max(0, sy), Math.max(1, Math.min(sw || img.width, img.width)), Math.max(1, Math.min(sh || img.height, img.height)), 0, 0, Math.abs(w), Math.abs(h));
      } catch {
        /* a bitmap we can't draw */
      }
    });
  }
}

/* --------------------------------------------------------------------- WMF */

async function playWmf(b: Uint8Array, scale: (wPt: number, hPt: number) => { k: number; screen: number }): Promise<Metafile | null> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 0;
  let bbox: [number, number, number, number] | null = null;
  let inch = 1440;
  if (dv.getUint32(0, true) === 0x9ac6cdd7) {
    bbox = [dv.getInt16(6, true), dv.getInt16(8, true), dv.getInt16(10, true), dv.getInt16(12, true)];
    inch = dv.getUint16(14, true) || 1440;
    off = 22;
  }
  const headerWords = dv.getUint16(off + 2, true);
  const nObjects = dv.getUint16(off + 10, true);
  off += headerWords * 2;
  // Without a placeable header, the window the file sets is its picture.
  if (!bbox) {
    let p = off;
    let org: [number, number] = [0, 0];
    let ext: [number, number] | null = null;
    while (p + 6 <= b.length) {
      const size = dv.getUint32(p, true);
      const fn = dv.getUint16(p + 4, true);
      if (size < 3 || fn === 0) break;
      if (fn === 0x020b) org = [dv.getInt16(p + 8, true), dv.getInt16(p + 6, true)];
      if (fn === 0x020c) ext = [dv.getInt16(p + 8, true), dv.getInt16(p + 6, true)];
      p += size * 2;
      if (ext) break;
    }
    if (!ext) return null;
    bbox = [org[0], org[1], org[0] + ext[0], org[1] + ext[1]];
    inch = 1440;
  }
  const bw = Math.abs(bbox[2] - bbox[0]) || 1;
  const bh = Math.abs(bbox[3] - bbox[1]) || 1;
  const wPt = (bw / inch) * 72;
  const hPt = (bh / inch) * 72;
  if (!(wPt > 0 && hPt > 0)) return null;
  const { k, screen } = scale(wPt, hPt);
  const W = Math.max(1, Math.round(wPt * k));
  const H = Math.max(1, Math.round(hPt * k));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  // The device is the placeable box: its logical units, scaled onto the canvas.
  const sx = W / (bbox[2] - bbox[0] || 1);
  const sy = H / (bbox[3] - bbox[1] || 1);
  const pl = new Player(ctx, [sx, 0, 0, sy, -bbox[0] * sx, -bbox[1] * sy], screen);
  pl.st.mapMode = 8;
  pl.st.winOrg = [bbox[0], bbox[1]];
  pl.st.winExt = [bbox[2] - bbox[0], bbox[3] - bbox[1]];
  pl.st.vpOrg = [bbox[0], bbox[1]];
  pl.st.vpExt = [bbox[2] - bbox[0], bbox[3] - bbox[1]];
  const slots: (Obj | null)[] = Array(Math.max(nObjects, 1)).fill(null);
  const add = (o: Obj) => {
    let i = slots.indexOf(null);
    if (i < 0) {
      i = slots.length;
      slots.push(null);
    }
    slots[i] = o;
    pl.create(i, o);
  };
  const i16 = (p: number) => dv.getInt16(p, true);
  const u16 = (p: number) => dv.getUint16(p, true);
  const color = (p: number) => rgb(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2));
  const ansi = new TextDecoder("windows-1252");
  let p = off;
  let guard = 0;
  while (p + 6 <= b.length && guard++ < 500000) {
    const size = dv.getUint32(p, true);
    const fn = u16(p + 4);
    if (size < 3) break;
    const a = p + 6;
    const end = Math.min(b.length, p + size * 2);
    const n = (end - a) >> 1;
    switch (fn) {
      case 0x0000:
        p = b.length;
        continue;
      case 0x001e:
        pl.save();
        break;
      case 0x0127:
        pl.restore(i16(a));
        break;
      case 0x0103:
        pl.st.mapMode = u16(a);
        break;
      case 0x020b:
        pl.st.winOrg = [i16(a + 2), i16(a)];
        break;
      case 0x020c:
        pl.st.winExt = [i16(a + 2), i16(a)];
        break;
      case 0x020f:
        pl.st.winOrg = [pl.st.winOrg[0] + i16(a + 2), pl.st.winOrg[1] + i16(a)];
        break;
      case 0x0410:
        pl.st.winExt = [(pl.st.winExt[0] * i16(a + 6)) / (i16(a + 4) || 1), (pl.st.winExt[1] * i16(a + 2)) / (i16(a) || 1)];
        break;
      case 0x0209:
        pl.st.text = color(a);
        break;
      case 0x0201:
        pl.st.bk = color(a);
        break;
      case 0x0102:
        pl.st.bkMode = u16(a);
        break;
      case 0x0106:
        pl.st.fillRule = u16(a) === 2 ? "nonzero" : "evenodd";
        break;
      case 0x0104:
        pl.st.rop2 = u16(a);
        break;
      case 0x012e:
        pl.st.align = u16(a);
        break;
      case 0x02fa: {
        const style = u16(a);
        const w = i16(a + 2);
        add({ kind: "pen", v: { style, width: Math.abs(w), color: color(a + 6), cosmetic: w <= 1 } });
        break;
      }
      case 0x02fc:
        add({ kind: "brush", v: { style: u16(a), color: color(a + 2), hatch: u16(a + 6) } });
        break;
      case 0x02fb: {
        let face = "";
        for (let q = a + 18; q < Math.min(end, a + 50) && dv.getUint8(q); q++) face += String.fromCharCode(dv.getUint8(q));
        add({ kind: "font", v: { height: i16(a), weight: i16(a + 8), italic: !!dv.getUint8(a + 10), underline: !!dv.getUint8(a + 11), strike: !!dv.getUint8(a + 12), escapement: i16(a + 4), face, charset: dv.getUint8(a + 13) } });
        break;
      }
      case 0x0142: {
        // A pattern brush from a bitmap: drawn as its pattern.
        const img = await dib(dv, a + 4, end - a - 4, a + 4 + dibHeaderSize(dv, a + 4, u16(a + 2) === 1), end - a, u16(a + 2) === 1);
        add({ kind: "brush", v: { style: 5, color: img ? averageColor(img) : "#808080", hatch: 0, image: img ?? undefined } });
        break;
      }
      case 0x01f9:
      case 0x00f7:
      case 0x06ff:
        add({ kind: "other" });
        break;
      case 0x012d: {
        const i = u16(a);
        const o = slots[i];
        if (o) pl.create(i, o);
        pl.select(i);
        break;
      }
      case 0x01f0: {
        const i = u16(a);
        if (i < slots.length) slots[i] = null;
        break;
      }
      case 0x0214:
        pl.moveTo(i16(a + 2), i16(a));
        break;
      case 0x0213:
        pl.lineTo(i16(a + 2), i16(a));
        break;
      case 0x0324:
      case 0x0325: {
        const count = u16(a);
        const pts: number[] = [];
        for (let k2 = 0; k2 < count && a + 2 + k2 * 4 + 3 < end; k2++) pts.push(i16(a + 2 + k2 * 4), i16(a + 4 + k2 * 4));
        pl.poly(pts, fn === 0x0324, fn === 0x0324);
        break;
      }
      case 0x0538: {
        const np = u16(a);
        const counts = Array.from({ length: np }, (_, k2) => u16(a + 2 + k2 * 2));
        let q = a + 2 + np * 2;
        const groups = counts.map((c) => {
          const g: number[] = [];
          for (let k2 = 0; k2 < c && q + 3 < end; k2++, q += 4) g.push(i16(q), i16(q + 2));
          return g;
        });
        pl.polyPoly(groups, true);
        break;
      }
      case 0x041b:
        pl.rect(i16(a + 6), i16(a + 4), i16(a + 2), i16(a));
        break;
      case 0x061c:
        pl.roundRect(i16(a + 10), i16(a + 8), i16(a + 6), i16(a + 4), i16(a + 2), i16(a));
        break;
      case 0x0418:
        pl.ellipse(i16(a + 6), i16(a + 4), i16(a + 2), i16(a));
        break;
      case 0x0817:
      case 0x081a:
      case 0x0830:
        pl.arc(fn === 0x0817 ? "arc" : fn === 0x081a ? "pie" : "chord", i16(a + 14), i16(a + 12), i16(a + 10), i16(a + 8), i16(a + 6), i16(a + 4), i16(a + 2), i16(a));
        break;
      case 0x0416:
      case 0x0415:
        pl.clipRect(i16(a + 6), i16(a + 4), i16(a + 2), i16(a), fn === 0x0416 ? "in" : "out");
        break;
      case 0x012c:
        if (u16(a) === 0) pl.st.clips = [];
        break;
      case 0x0521: {
        const len = u16(a);
        const s = ansi.decode(b.subarray(a + 2, a + 2 + len));
        const q = a + 2 + ((len + 1) & ~1);
        pl.text(i16(q + 2), i16(q), decodeSymbol(s, pl.st.font), null, null, null);
        break;
      }
      case 0x0a32: {
        const y = i16(a);
        const x = i16(a + 2);
        const len = u16(a + 4);
        const opts = u16(a + 6);
        let q = a + 8;
        let rect: [number, number, number, number] | null = null;
        if (opts & 6) {
          rect = [i16(q), i16(q + 2), i16(q + 4), i16(q + 6)];
          q += 8;
        }
        const s = ansi.decode(b.subarray(q, q + len));
        q += (len + 1) & ~1;
        let dx: number[] | null = null;
        if (q + len * 2 <= end) dx = Array.from({ length: len }, (_, k2) => i16(q + k2 * 2));
        pl.text(x, y, decodeSymbol(s, pl.st.font), dx, opts & 2 ? rect : null, opts & 4 ? rect : null);
        break;
      }
      case 0x061d: {
        const rop = dv.getUint32(a, true);
        pl.blit(null, i16(a + 10), i16(a + 8), i16(a + 6), i16(a + 4), 0, 0, 0, 0, rop);
        break;
      }
      case 0x0940:
      case 0x0b41:
      case 0x0f43: {
        const rop = dv.getUint32(a, true);
        if (fn === 0x0f43) {
          const usage = u16(a + 4);
          const [sh, sw, sy2, sx2, dh, dw, dy, dx2] = [6, 8, 10, 12, 14, 16, 18, 20].map((o) => i16(a + o));
          const at = a + 22;
          const img = await dib(dv, at, end - at, at + dibHeaderSize(dv, at, usage === 1), end - at, usage === 1);
          pl.blit(img, dx2, dy, dw, dh, sx2, img ? img.height - sy2 - sh : sy2, sw, sh, rop);
        } else if (fn === 0x0b41) {
          const withBits = n > 12;
          const vals = [4, 6, 8, 10, 12, 14, 16, 18].map((o) => i16(a + o));
          const [sh, sw, sy2, sx2] = vals;
          const [dh, dw, dy, dx2] = withBits ? vals.slice(4) : [14, 16, 18, 20].map((o) => i16(a + o));
          const at = a + 20;
          const img = withBits ? await dib(dv, at, end - at, at + dibHeaderSize(dv, at, false), end - at, false) : null;
          pl.blit(img, dx2, dy, dw, dh, sx2, sy2, sw, sh, rop);
        } else {
          const withBits = n > 10;
          const [sy2, sx2] = [i16(a + 4), i16(a + 6)];
          const base = withBits ? a + 8 : a + 10;
          const [h, w, dy, dx2] = [0, 2, 4, 6].map((o) => i16(base + o));
          const at = base + 8;
          const img = withBits ? await dib(dv, at, end - at, at + dibHeaderSize(dv, at, false), end - at, false) : null;
          pl.blit(img, dx2, dy, w, h, sx2, sy2, w, h, rop);
        }
        break;
      }
      default:
        break;
    }
    p += size * 2;
  }
  return { canvas, w: wPt, h: hPt };
}

/** Where a DIB's bits start after its header and colour table. */
function dibHeaderSize(dv: DataView, at: number, paletteIndices: boolean): number {
  if (at + 4 > dv.byteLength) return 40;
  const hs = dv.getUint32(at, true);
  if (hs === 12) {
    const bpp = dv.getUint16(at + 10, true);
    return 12 + (bpp <= 8 ? (1 << bpp) * (paletteIndices ? 2 : 3) : 0);
  }
  const bpp = dv.getUint16(at + 14, true);
  const comp = dv.getUint32(at + 16, true);
  const used = dv.getUint32(at + 32, true);
  const colors = bpp <= 8 ? used || 1 << bpp : 0;
  const masks = comp === 3 && hs === 40 ? 12 : 0;
  return hs + masks + colors * (paletteIndices ? 2 : 4);
}

function averageColor(c: HTMLCanvasElement): string {
  const d = c.getContext("2d")!.getImageData(0, 0, Math.min(c.width, 64), Math.min(c.height, 64)).data;
  let r = 0;
  let g = 0;
  let bl = 0;
  const n = d.length / 4 || 1;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    g += d[i + 1];
    bl += d[i + 2];
  }
  return rgb(Math.round(r / n), Math.round(g / n), Math.round(bl / n));
}

/** Symbol-font text (Wingdings, Webdings, Symbol) shown as the nearest Unicode signs. */
function decodeSymbol(s: string, f: Font): string {
  if (isSymbolFont(f.face)) return mapSymbols(s, f.face) ?? s;
  if (f.charset !== 2) return s;
  return [...s].map((c) => SYMBOLS[c.charCodeAt(0)] ?? c).join("");
}
const SYMBOLS: Record<number, string> = { 0xa7: "▪", 0xa8: "◻", 0x6c: "●", 0x6e: "■", 0x71: "❑", 0x75: "◆", 0x76: "❖", 0xd8: "➢", 0xfc: "✔", 0xfb: "✖", 0xe0: "→", 0xe8: "➔", 0xf0: "⇨" };

/* --------------------------------------------------------------------- EMF */

async function playEmf(b: Uint8Array, scale: (wPt: number, hPt: number) => { k: number; screen: number }): Promise<Metafile | null> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const i32 = (p: number) => dv.getInt32(p, true);
  const u32 = (p: number) => dv.getUint32(p, true);
  const hsize = u32(4);
  const bounds = [i32(8), i32(12), i32(16), i32(20)];
  const frame = [i32(24), i32(28), i32(32), i32(36)];
  const devPx = [i32(72), i32(76)];
  const devMm = [i32(80), i32(84)];
  // Reference device pixels per millimetre: from its size in micrometres when given (and
  // agreeing with the millimetres; some writers fill that field with other numbers).
  const mic = hsize >= 108 ? [i32(100), i32(104)] : [0, 0];
  const mm = [0, 1].map((i) => (mic[i] > 0 && Math.abs(mic[i] / 1000 - devMm[i]) <= Math.max(1, devMm[i] * 0.02) ? mic[i] / 1000 : devMm[i] || 1));
  const pxPerMm = [devPx[0] / mm[0], devPx[1] / mm[1]];
  let fx0 = (frame[0] / 100) * pxPerMm[0];
  let fy0 = (frame[1] / 100) * pxPerMm[1];
  let fx1 = (frame[2] / 100) * pxPerMm[0];
  let fy1 = (frame[3] / 100) * pxPerMm[1];
  let wMm = (frame[2] - frame[0]) / 100;
  let hMm = (frame[3] - frame[1]) / 100;
  if (!(fx1 > fx0 && fy1 > fy0) || !(wMm > 0 && hMm > 0)) {
    // No usable frame: the bounds (device pixels).
    [fx0, fy0, fx1, fy1] = bounds;
    fx1 += 1;
    fy1 += 1;
    wMm = (fx1 - fx0) / pxPerMm[0];
    hMm = (fy1 - fy0) / pxPerMm[1];
  }
  const wPt = (wMm / 25.4) * 72;
  const hPt = (hMm / 25.4) * 72;
  if (!(wPt > 0 && hPt > 0) || !Number.isFinite(wPt + hPt)) return null;
  const { k, screen } = scale(wPt, hPt);
  const W = Math.max(1, Math.round(wPt * k));
  const H = Math.max(1, Math.round(hPt * k));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const sx = W / (fx1 - fx0);
  const sy = H / (fy1 - fy0);
  const pl = new Player(ctx, [sx, 0, 0, sy, -fx0 * sx, -fy0 * sy], screen, [pxPerMm[0], pxPerMm[1]]);
  const color = (p: number) => rgb(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2));
  const utf16 = new TextDecoder("utf-16le");
  const ansi = new TextDecoder("windows-1252");
  const points = (at: number, count: number, short: boolean, end: number) => {
    const pts: number[] = [];
    for (let q = 0; q < count; q++) {
      const o = at + q * (short ? 4 : 8);
      if (o + (short ? 4 : 8) > end) break;
      pts.push(short ? dv.getInt16(o, true) : i32(o), short ? dv.getInt16(o + 2, true) : i32(o + 4));
    }
    return pts;
  };
  const readDib = async (rec: number, offBmi: number, cbBmi: number, offBits: number, cbBits: number, usage: number, alpha = false) => (cbBmi ? dib(dv, rec + offBmi, cbBmi, rec + offBits, cbBits, usage === 1, alpha) : null);
  let p = 0;
  let guard = 0;
  while (p + 8 <= b.length && guard++ < 1000000) {
    const type = u32(p);
    const size = u32(p + 4);
    if (size < 8 || p + size > b.length) break;
    const a = p + 8;
    const end = p + size;
    switch (type) {
      case 14:
        p = b.length;
        continue;
      case 2:
      case 3:
      case 4:
      case 5:
      case 6:
      case 85:
      case 86:
      case 87:
      case 88:
      case 89: {
        const short = type >= 85;
        const t = short ? type - 83 : type;
        const count = u32(a + 16);
        const pts = points(a + 20, count, short, end);
        if (t === 2 || t === 5) {
          // Béziers: from the first point (or the current one, for PolyBezierTo).
          const path = new Path2D();
          let i = 0;
          if (t === 2) {
            path.moveTo(pts[0], pts[1]);
            i = 2;
          } else path.moveTo(pl.st.cur[0], pl.st.cur[1]);
          for (; i + 5 < pts.length; i += 6) path.bezierCurveTo(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
          if (pts.length >= 2) pl.st.cur = [pts[pts.length - 2], pts[pts.length - 1]];
          if (pl.pathOpen && pl.path) {
            if (t === 5) for (let q = 0; q + 5 < pts.length; q += 6) pl.path.bezierCurveTo(pts[q], pts[q + 1], pts[q + 2], pts[q + 3], pts[q + 4], pts[q + 5]);
            else pl.path.addPath(path);
          } else pl.draw(() => pl.stroke(path));
        } else if (t === 6) {
          // PolylineTo: from the current point.
          if (pl.pathOpen && pl.path) {
            for (let q = 0; q + 1 < pts.length; q += 2) pl.path.lineTo(pts[q], pts[q + 1]);
            if (pts.length >= 2) pl.st.cur = [pts[pts.length - 2], pts[pts.length - 1]];
          } else {
            pl.poly([...pl.st.cur, ...pts], false, false);
            if (pts.length >= 2) pl.st.cur = [pts[pts.length - 2], pts[pts.length - 1]];
          }
        } else pl.poly(pts, t === 3, t === 3);
        break;
      }
      case 7:
      case 8:
      case 90:
      case 91: {
        const short = type >= 90;
        const np = u32(a + 16);
        const counts = Array.from({ length: np }, (_, q) => u32(a + 24 + q * 4));
        let at = a + 24 + np * 4;
        const groups = counts.map((c) => {
          const g = points(at, c, short, end);
          at += c * (short ? 4 : 8);
          return g;
        });
        pl.polyPoly(groups, type === 8 || type === 91);
        break;
      }
      case 9:
        pl.st.winExt = [i32(a), i32(a + 4)];
        break;
      case 10:
        pl.st.winOrg = [i32(a), i32(a + 4)];
        break;
      case 11:
        pl.st.vpExt = [i32(a), i32(a + 4)];
        break;
      case 12:
        pl.st.vpOrg = [i32(a), i32(a + 4)];
        break;
      case 17:
        pl.st.mapMode = u32(a);
        break;
      case 18:
        pl.st.bkMode = u32(a);
        break;
      case 19:
        pl.st.fillRule = u32(a) === 2 ? "nonzero" : "evenodd";
        break;
      case 20:
        pl.st.rop2 = u32(a);
        break;
      case 22:
        pl.st.align = u32(a);
        break;
      case 24:
        pl.st.text = color(a);
        break;
      case 25:
        pl.st.bk = color(a);
        break;
      case 27:
        pl.moveTo(i32(a), i32(a + 4));
        break;
      case 54:
        pl.lineTo(i32(a), i32(a + 4));
        break;
      case 29:
      case 30:
        pl.clipRect(i32(a), i32(a + 4), i32(a + 8), i32(a + 12), type === 30 ? "in" : "out");
        break;
      case 31:
        pl.st.vpExt = [(pl.st.vpExt[0] * i32(a)) / (i32(a + 4) || 1), (pl.st.vpExt[1] * i32(a + 8)) / (i32(a + 12) || 1)];
        break;
      case 32:
        pl.st.winExt = [(pl.st.winExt[0] * i32(a)) / (i32(a + 4) || 1), (pl.st.winExt[1] * i32(a + 8)) / (i32(a + 12) || 1)];
        break;
      case 33:
        pl.save();
        break;
      case 34:
        pl.restore(i32(a));
        break;
      case 35:
      case 36: {
        const x: Mat = [0, 4, 8, 12, 16, 20].map((o) => dv.getFloat32(a + o, true)) as Mat;
        const mode = type === 35 ? 4 : u32(a + 24);
        if (mode === 1) pl.st.xform = IDENT;
        else if (mode === 2) pl.st.xform = mul(x, pl.st.xform);
        else if (mode === 3) pl.st.xform = mul(pl.st.xform, x);
        else if (mode === 4) pl.st.xform = x;
        break;
      }
      case 37:
        pl.select(u32(a));
        break;
      case 38: {
        const style = u32(a + 4);
        const w = i32(a + 8);
        pl.create(u32(a), { kind: "pen", v: { style, width: Math.abs(w), color: color(a + 16), cosmetic: w <= 1 && !(style & 0x10000) } });
        break;
      }
      case 95: {
        const style = u32(a + 20);
        const w = u32(a + 24);
        const brushStyle = u32(a + 28);
        pl.create(u32(a), { kind: "pen", v: { style: brushStyle === 1 ? 5 : style, width: w, color: color(a + 32), cosmetic: !(style & 0x10000) } });
        break;
      }
      case 39:
        pl.create(u32(a), { kind: "brush", v: { style: u32(a + 4), color: color(a + 8), hatch: u32(a + 12) } });
        break;
      case 93:
      case 94: {
        const img = await readDib(p, u32(a + 8), u32(a + 12), u32(a + 16), u32(a + 20), u32(a + 4));
        pl.create(u32(a), { kind: "brush", v: { style: 5, color: img ? averageColor(img) : "#808080", hatch: 0, image: img ?? undefined } });
        break;
      }
      case 82: {
        let face = utf16.decode(b.subarray(a + 32, a + 96));
        face = face.split("\0")[0];
        pl.create(u32(a), { kind: "font", v: { height: i32(a + 4), weight: i32(a + 20), italic: !!dv.getUint8(a + 24), underline: !!dv.getUint8(a + 25), strike: !!dv.getUint8(a + 26), escapement: i32(a + 12), face, charset: dv.getUint8(a + 27) } });
        break;
      }
      case 40:
        pl.objects.delete(u32(a));
        break;
      case 42:
        pl.ellipse(i32(a), i32(a + 4), i32(a + 8), i32(a + 12));
        break;
      case 43:
        pl.rect(i32(a), i32(a + 4), i32(a + 8), i32(a + 12));
        break;
      case 44:
        pl.roundRect(i32(a), i32(a + 4), i32(a + 8), i32(a + 12), i32(a + 16), i32(a + 20));
        break;
      case 45:
      case 46:
      case 47:
      case 55:
        pl.arc(type === 45 ? "arc" : type === 46 ? "chord" : type === 47 ? "pie" : "arcto", i32(a), i32(a + 4), i32(a + 8), i32(a + 12), i32(a + 16), i32(a + 20), i32(a + 24), i32(a + 28));
        break;
      case 57:
        pl.st.arcCcw = u32(a) !== 2;
        break;
      case 59:
        pl.path = new Path2D();
        pl.pathOpen = true;
        pl.path.moveTo(pl.st.cur[0], pl.st.cur[1]);
        break;
      case 60:
        pl.pathOpen = false;
        break;
      case 61:
        pl.path?.closePath();
        break;
      case 68:
        pl.path = null;
        pl.pathOpen = false;
        break;
      case 62:
      case 63:
      case 64: {
        const path = pl.path;
        if (path)
          pl.draw(() => {
            if (type !== 64) pl.fill(path);
            if (type !== 62) pl.stroke(path);
          });
        pl.path = null;
        pl.pathOpen = false;
        break;
      }
      case 67:
        if (pl.path) pl.clipPath(pl.path, u32(a) === 5);
        pl.path = null;
        pl.pathOpen = false;
        break;
      case 75: {
        // A clip region: reset, or its rectangles (in device pixels).
        const cb = u32(a);
        const mode = u32(a + 4);
        if (mode === 5 && cb === 0) {
          pl.st.clips = [];
          break;
        }
        const nRects = cb >= 32 ? u32(a + 8 + 8) : 0;
        const path = new Path2D();
        const dm = pl.devToCanvas;
        for (let q = 0; q < nRects; q++) {
          const o = a + 8 + 32 + q * 16;
          if (o + 16 > end) break;
          const [l, t, r, bt] = [i32(o), i32(o + 4), i32(o + 8), i32(o + 12)];
          path.rect(l * dm[0] + dm[4], t * dm[3] + dm[5], (r - l) * dm[0], (bt - t) * dm[3]);
        }
        if (mode === 5) pl.st.clips = [{ keep: "in", path }];
        else if (mode === 1) pl.st.clips = [...pl.st.clips, { keep: "in", path }];
        break;
      }
      case 71: {
        // FillRgn: the region's rectangles with a brush (device pixels).
        const brush = pl.objects.get(u32(a + 20));
        const cb = u32(a + 16);
        const nRects = cb >= 32 ? u32(a + 24 + 8) : 0;
        if (brush?.kind === "brush" && brush.v.style !== 1) {
          const dm = pl.devToCanvas;
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = brush.v.color;
          for (let q = 0; q < nRects; q++) {
            const o = a + 24 + 32 + q * 16;
            if (o + 16 > end) break;
            const [l, t, r, bt] = [i32(o), i32(o + 4), i32(o + 8), i32(o + 12)];
            ctx.fillRect(l * dm[0] + dm[4], t * dm[3] + dm[5], (r - l) * dm[0], (bt - t) * dm[3]);
          }
          ctx.restore();
        }
        break;
      }
      case 76:
      case 77: {
        const [dx2, dy, cx, cy] = [i32(a + 16), i32(a + 20), i32(a + 24), i32(a + 28)];
        const rop = u32(a + 32);
        const [sx2, sy2] = [i32(a + 36), i32(a + 40)];
        const usage = u32(a + 72);
        const [offBmi, cbBmi, offBits, cbBits] = [u32(a + 76), u32(a + 80), u32(a + 84), u32(a + 88)];
        const [csx, csy] = type === 77 ? [i32(a + 92), i32(a + 96)] : [cx, cy];
        const img = await readDib(p, offBmi, cbBmi, offBits, cbBits, usage);
        pl.blit(img, dx2, dy, cx, cy, sx2, sy2, csx, csy, rop);
        break;
      }
      case 80:
      case 81: {
        const [dx2, dy, sx2, sy2, csx, csy] = [i32(a + 16), i32(a + 20), i32(a + 24), i32(a + 28), i32(a + 32), i32(a + 36)];
        const [offBmi, cbBmi, offBits, cbBits, usage] = [u32(a + 40), u32(a + 44), u32(a + 48), u32(a + 52), u32(a + 56)];
        const img = await readDib(p, offBmi, cbBmi, offBits, cbBits, usage);
        if (type === 81) {
          const rop = u32(a + 60);
          const [cdx, cdy] = [i32(a + 64), i32(a + 68)];
          // Bitmaps are stored bottom-up: the source rectangle counts from the bottom row.
          const srcY = img ? img.height - sy2 - csy : sy2;
          pl.blit(img, dx2, dy, cdx, cdy, sx2, srcY, csx, csy, rop);
        } else pl.blit(img, dx2, dy, csx, csy, sx2, img ? img.height - sy2 - csy : sy2, csx, csy, 0xcc0020);
        break;
      }
      case 114:
      case 116: {
        const [dx2, dy, cx, cy] = [i32(a + 16), i32(a + 20), i32(a + 24), i32(a + 28)];
        const [sx2, sy2] = [i32(a + 36), i32(a + 40)];
        const usage = u32(a + 72);
        const [offBmi, cbBmi, offBits, cbBits] = [u32(a + 76), u32(a + 80), u32(a + 84), u32(a + 88)];
        const [csx, csy] = [i32(a + 92), i32(a + 96)];
        const blend = u32(a + 32);
        let img = await readDib(p, offBmi, cbBmi, offBits, cbBits, usage, type === 114 && ((blend >>> 24) & 1) === 1);
        if (img && type === 116) img = keyOut(img, blend);
        if (img && type === 114) {
          ctx.globalAlpha = ((blend >>> 16) & 255) / 255;
          pl.blit(img, dx2, dy, cx, cy, sx2, sy2, csx, csy, 0xcc0020);
          ctx.globalAlpha = 1;
          break;
        }
        pl.blit(img, dx2, dy, cx, cy, sx2, sy2, csx, csy, 0xcc0020);
        break;
      }
      case 118: {
        // GradientFill: rectangles (horizontal or vertical); triangles in their mean colour.
        const nVer = u32(a + 16);
        const nTri = u32(a + 20);
        const mode = u32(a + 24);
        const v = Array.from({ length: nVer }, (_, q) => {
          const o = a + 28 + q * 16;
          return { x: i32(o), y: i32(o + 4), c: [dv.getUint16(o + 8, true) >> 8, dv.getUint16(o + 10, true) >> 8, dv.getUint16(o + 12, true) >> 8] };
        });
        const idx = a + 28 + nVer * 16;
        pl.draw(() => {
          for (let q = 0; q < nTri; q++) {
            if (mode === 2) {
              const o = idx + q * 12;
              const [t0, t1, t2] = [u32(o), u32(o + 4), u32(o + 8)].map((i) => v[i]);
              if (!t0 || !t1 || !t2) continue;
              ctx.fillStyle = rgb(...([0, 1, 2].map((k2) => Math.round((t0.c[k2] + t1.c[k2] + t2.c[k2]) / 3)) as [number, number, number]));
              ctx.beginPath();
              ctx.moveTo(t0.x, t0.y);
              ctx.lineTo(t1.x, t1.y);
              ctx.lineTo(t2.x, t2.y);
              ctx.fill();
            } else {
              const o = idx + q * 8;
              const [r0, r1] = [v[u32(o)], v[u32(o + 4)]];
              if (!r0 || !r1) continue;
              const g = mode === 0 ? ctx.createLinearGradient(r0.x, 0, r1.x, 0) : ctx.createLinearGradient(0, r0.y, 0, r1.y);
              g.addColorStop(0, rgb(r0.c[0], r0.c[1], r0.c[2]));
              g.addColorStop(1, rgb(r1.c[0], r1.c[1], r1.c[2]));
              ctx.fillStyle = g;
              ctx.fillRect(Math.min(r0.x, r1.x), Math.min(r0.y, r1.y), Math.abs(r1.x - r0.x), Math.abs(r1.y - r0.y));
            }
          }
        });
        break;
      }
      case 83:
      case 84: {
        const t = a + 28;
        const [x, y] = [i32(t), i32(t + 4)];
        const nChars = u32(t + 8);
        const offString = u32(t + 12);
        const opts = u32(t + 16);
        const rect: [number, number, number, number] = [i32(t + 20), i32(t + 24), i32(t + 28), i32(t + 32)];
        const offDx = u32(t + 36);
        const so = p + offString;
        const s = type === 84 ? utf16.decode(b.subarray(so, Math.min(end, so + nChars * 2))) : ansi.decode(b.subarray(so, Math.min(end, so + nChars)));
        let dx: number[] | null = null;
        if (offDx && p + offDx + nChars * 4 <= end) {
          const step = opts & 0x2000 ? 8 : 4;
          dx = Array.from({ length: nChars }, (_, q) => i32(p + offDx + q * step));
        }
        // A rectangle given in device pixels (graphics mode 1 records keep it there).
        const hasRect = rect[2] > rect[0] && rect[3] > rect[1];
        pl.text(x, y, type === 83 ? decodeSymbol(s, pl.st.font) : s, dx, opts & 2 && hasRect ? rect : null, opts & 4 && hasRect ? rect : null);
        break;
      }
      default:
        break;
    }
    p += size;
  }
  return { canvas, w: wPt, h: hPt };
}

/** A bitmap with one colour made transparent (TransparentBlt). */
function keyOut(img: HTMLCanvasElement, colorRef: number): HTMLCanvasElement {
  const ctx = img.getContext("2d")!;
  const d = ctx.getImageData(0, 0, img.width, img.height);
  const [r, g, b] = [colorRef & 255, (colorRef >> 8) & 255, (colorRef >> 16) & 255];
  for (let i = 0; i < d.data.length; i += 4) if (d.data[i] === r && d.data[i + 1] === g && d.data[i + 2] === b) d.data[i + 3] = 0;
  ctx.putImageData(d, 0, 0);
  return img;
}

/**
 * A metafile as a picture for a PDF (PNG, transparent where it draws nothing), at about
 * 200 dpi of the size it is shown at (`shown`: its longer side in points). Null when it
 * isn't a metafile we can play.
 */
export async function metafileToPng(bytes: Uint8Array, shown?: number): Promise<Uint8Array | null> {
  const mf = await playMetafile(bytes, { shown });
  if (!mf) return null;
  const blob = await new Promise<Blob | null>((res) => mf.canvas.toBlob(res, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}
