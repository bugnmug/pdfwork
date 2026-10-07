/**
 * A small PDF painter for DrawingML content, working in y-down coordinates
 * (as Office lays things out): paths, fills and strokes with transparency,
 * clipping, images, axial and radial shadings (with soft masks for gradient
 * transparency) and tiling patterns.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames as Ops,
  PDFRef,
  appendBezierCurve,
  clip,
  clipEvenOdd,
  closePath,
  concatTransformationMatrix,
  endPath,
  fill,
  fillEvenOdd,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setDashPattern,
  setFillingRgbColor,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  LineCapStyle,
  LineJoinStyle,
  type PDFDocument,
  type PDFImage,
  type PDFPage,
} from "@cantoo/pdf-lib";
import type { Seg } from "./geometry";

/** An affine map [a b c d e f]: (x, y) to (a x + c y + e, b x + d y + f). */
export type Mat = [number, number, number, number, number, number];
export const IDENT: Mat = [1, 0, 0, 1, 0, 0];

/** First `m1`, then `m2`. */
export function then(m1: Mat, m2: Mat): Mat {
  const [a, b, c, d, e, f] = m1;
  const [A, B, C, D, E, F] = m2;
  return [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
}
export const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];
/** Clockwise on screen (y down), in degrees. */
export function rotate(deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
}
export function invert(m: Mat): Mat {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * Where a shape's own box (0..w, 0..h) lands: rotated about its centre (clockwise,
 * degrees) and flipped, then placed with its top-left corner at (x, y).
 */
export function boxMatrix(x: number, y: number, w: number, h: number, rot = 0, flipH = false, flipV = false): Mat {
  let m = translate(-w / 2, -h / 2);
  if (flipH || flipV) m = then(m, scale(flipH ? -1 : 1, flipV ? -1 : 1));
  if (rot) m = then(m, rotate(rot));
  return then(m, translate(x + w / 2, y + h / 2));
}

export type RGBA = { hex: string; alpha: number };
const parts = (hex: string): [number, number, number] => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255 || 0) as [number, number, number];

export type StrokeStyle = { width: number; cap?: "flat" | "rnd" | "sq"; join?: "round" | "bevel" | "miter"; dash?: number[]; miter?: number };

export class Pen {
  private gsCache = new Map<string, PDFName>();
  readonly ctx;
  constructor(
    readonly doc: PDFDocument,
    readonly page: PDFPage,
    readonly H: number,
  ) {
    this.ctx = doc.context;
  }

  op(...ops: PDFOperator[]) {
    this.page.pushOperators(...ops);
  }
  /** Start drawing in y-down coordinates. */
  begin() {
    this.op(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, 0, this.H));
  }
  end() {
    this.op(popGraphicsState());
  }
  save() {
    this.op(pushGraphicsState());
  }
  restore() {
    this.op(popGraphicsState());
  }
  concat(m: Mat) {
    this.op(concatTransformationMatrix(...m));
  }

  /** Path operators for segments, mapped through `m`. */
  path(segs: Seg[], m: Mat = IDENT) {
    const ops: PDFOperator[] = [];
    for (const s of segs) {
      if (s.t === "Z") ops.push(closePath());
      else if (s.t === "C") {
        const [x1, y1] = apply(m, s.x1, s.y1);
        const [x2, y2] = apply(m, s.x2, s.y2);
        const [x, y] = apply(m, s.x, s.y);
        ops.push(appendBezierCurve(x1, y1, x2, y2, x, y));
      } else {
        const [x, y] = apply(m, s.x, s.y);
        ops.push(s.t === "M" ? moveTo(x, y) : lineTo(x, y));
      }
    }
    this.op(...ops);
  }
  rectPath(x: number, y: number, w: number, h: number, m: Mat = IDENT) {
    this.path(
      [
        { t: "M", x, y },
        { t: "L", x: x + w, y },
        { t: "L", x: x + w, y: y + h },
        { t: "L", x, y: y + h },
        { t: "Z" },
      ],
      m,
    );
  }

  fillWith(color: RGBA, evenOdd = false) {
    if (color.alpha < 1) this.alpha(color.alpha, undefined);
    this.op(setFillingRgbColor(...parts(color.hex)), evenOdd ? fillEvenOdd() : fill());
  }
  strokeWith(color: RGBA, s: StrokeStyle) {
    if (color.alpha < 1) this.alpha(undefined, color.alpha);
    this.op(setStrokingRgbColor(...parts(color.hex)), setLineWidth(s.width));
    this.op(setLineCap(s.cap === "rnd" ? LineCapStyle.Round : s.cap === "sq" ? LineCapStyle.Projecting : LineCapStyle.Butt));
    this.op(setLineJoin(s.join === "bevel" ? LineJoinStyle.Bevel : s.join === "miter" ? LineJoinStyle.Miter : LineJoinStyle.Round));
    if (s.join === "miter") this.op(PDFOperator.of(Ops.SetLineMiterLimit, [PDFNumber.of(Math.max(1, s.miter ?? 8))]));
    this.op(setDashPattern(s.dash?.length ? s.dash : [], 0), stroke());
  }
  clip(evenOdd = false) {
    this.op(evenOdd ? clipEvenOdd() : clip(), endPath());
  }
  noPaint() {
    this.op(endPath());
  }

  /** Constant transparency for fills (ca) and strokes (CA). */
  alpha(fillA?: number, strokeA?: number) {
    const k = `${fillA ?? ""}/${strokeA ?? ""}`;
    let name = this.gsCache.get(k);
    if (!name) {
      const d: Record<string, number> = {};
      if (fillA !== undefined) d.ca = Math.max(0, Math.min(1, fillA));
      if (strokeA !== undefined) d.CA = Math.max(0, Math.min(1, strokeA));
      name = this.page.node.newExtGState("GSa", this.ctx.obj({ Type: "ExtGState", ...d }));
      this.gsCache.set(k, name);
    }
    this.op(setGraphicsState(name));
  }

  /** A named resource of any kind (Shading, Pattern, XObject...). */
  resource(kind: string, obj: PDFRef | PDFDict, tag: string): PDFName {
    const res = this.page.node.normalizedEntries().Resources;
    let dict = res.lookupMaybe(PDFName.of(kind), PDFDict);
    if (!dict) {
      dict = this.ctx.obj({});
      res.set(PDFName.of(kind), dict);
    }
    const key = dict.uniqueKey(tag);
    dict.set(key, obj);
    return key;
  }

  image(img: PDFImage, m: Mat) {
    const name = this.page.node.newXObject("Im", img.ref);
    this.op(pushGraphicsState(), concatTransformationMatrix(...m), PDFOperator.of(Ops.DrawObject, [name]), popGraphicsState());
  }

  /** Paint a shading (already registered) over the current clip. */
  shade(name: PDFName) {
    this.op(PDFOperator.of(Ops.ShadingFill, [name]));
  }

  /** An interpolating function over stops (positions 0..1) of colour components. */
  stopsFunction(stops: { pos: number; c: number[] }[]): PDFRef {
    const ctx = this.ctx;
    const s = normalizeStops(stops);
    const fns = [];
    for (let i = 0; i < s.length - 1; i++) fns.push(ctx.register(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: s[i].c, C1: s[i + 1].c, N: 1 })));
    if (fns.length === 1) return fns[0];
    const bounds = s.slice(1, -1).map((x) => x.pos);
    const encode: number[] = [];
    for (let i = 0; i < fns.length; i++) encode.push(0, 1);
    return ctx.register(ctx.obj({ FunctionType: 3, Domain: [0, 1], Functions: fns, Bounds: bounds, Encode: encode }));
  }

  /** Axial (type 2) or radial (type 3) shading in the current user space. */
  shading(type: 2 | 3, coords: number[], stops: { pos: number; c: number[] }[], gray = false): PDFRef {
    const fn = this.stopsFunction(stops);
    return this.ctx.register(this.ctx.obj({ ShadingType: type, ColorSpace: gray ? "DeviceGray" : "DeviceRGB", Coords: coords, Function: fn, Extend: [true, true] }));
  }

  /**
   * A soft mask from a gray shading (gray = opacity), painted over `bbox` in the
   * user space current when the returned graphics state is set.
   */
  softMask(shading: PDFRef, bbox: [number, number, number, number], extraOps = ""): PDFName {
    const ctx = this.ctx;
    const res = ctx.obj({ Shading: { Sh0: shading } });
    const content = `q ${extraOps} /Sh0 sh Q`;
    const form = ctx.stream(content, {
      Type: "XObject",
      Subtype: "Form",
      BBox: bbox,
      Group: { S: "Transparency", CS: "DeviceGray" },
      Resources: res,
    });
    const formRef = ctx.register(form);
    const gs = ctx.obj({ Type: "ExtGState", SMask: { Type: "Mask", S: "Luminosity", G: formRef } });
    return this.page.node.newExtGState("GSm", gs);
  }

  setGS(name: PDFName) {
    this.op(setGraphicsState(name));
  }

  /** A coloured tiling pattern from a content stream (in pattern space), for `scn`. */
  tilingPattern(content: string, w: number, h: number, matrix: Mat, resources: Record<string, unknown> = {}): PDFName {
    const ctx = this.ctx;
    const stream = ctx.stream(content, { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, w, h], XStep: w, YStep: h, Matrix: matrix, Resources: ctx.obj(resources as never) });
    return this.resource("Pattern", ctx.register(stream), "P");
  }

  fillPattern(name: PDFName, evenOdd = false) {
    this.op(PDFOperator.of(Ops.NonStrokingColorspace, [PDFName.of("Pattern")]), PDFOperator.of(Ops.NonStrokingColorN, [name]), evenOdd ? fillEvenOdd() : fill());
  }
}

/** Stops sorted, covering 0..1, strictly increasing. */
function normalizeStops(stops: { pos: number; c: number[] }[]): { pos: number; c: number[] }[] {
  const s = [...stops].sort((a, b) => a.pos - b.pos).map((x) => ({ pos: Math.max(0, Math.min(1, x.pos)), c: x.c }));
  if (!s.length) return [
    { pos: 0, c: [0, 0, 0] },
    { pos: 1, c: [0, 0, 0] },
  ];
  if (s[0].pos > 0) s.unshift({ pos: 0, c: s[0].c });
  if (s[s.length - 1].pos < 1) s.push({ pos: 1, c: s[s.length - 1].c });
  if (s.length === 1) s.push({ pos: 1, c: s[0].c });
  for (let i = 1; i < s.length; i++) if (s[i].pos <= s[i - 1].pos) s[i].pos = Math.min(1, s[i - 1].pos + 1e-6);
  // A run of stops squeezed at 1 keeps the last colour.
  return s.filter((x, i) => i === 0 || x.pos > s[i - 1].pos || i === s.length - 1);
}

export { PDFArray };
