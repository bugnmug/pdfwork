/**
 * DrawingML fills, outlines and shadows: read from spPr-like elements (with
 * theme style references and placeholder colours) and painted with a Pen.
 * Solid fills, linear and path gradients (transparency included), pattern
 * fills, picture fills (stretched, cropped or tiled), dashed lines with caps,
 * joins and arrowheads, and outer shadows.
 */
import type { PDFImage } from "@cantoo/pdf-lib";
import { attr, drawingColor, kid, kids, num, type El, type Theme } from "../ooxml";
import type { Seg } from "./geometry";
import { IDENT, apply, invert, rotate, scale, then, translate, type Mat, type Pen, type RGBA, type StrokeStyle } from "./pen";

export type ColorCtx = { theme: Theme; map: Record<string, string> };
export type Stop = { pos: number; color: RGBA };
/** Fractions of the box, inset from each side (negative: outset). */
export type Insets = { l: number; t: number; r: number; b: number };

export type Fill =
  | { kind: "none" }
  | { kind: "solid"; color: RGBA }
  | { kind: "grad"; stops: Stop[]; path: "lin" | "circle" | "rect" | "shape"; angle: number; scaled: boolean; focus: Insets; rotWithShape: boolean }
  | { kind: "patt"; prst: string; fg: RGBA; bg: RGBA }
  | { kind: "blip"; blip: El; src?: Insets; stretch?: Insets; tile?: { tx: number; ty: number; sx: number; sy: number; flip: string; algn: string }; rotWithShape: boolean; owner: unknown; /** The style colour its effects (a duotone) are made of, for a theme's picture fills. */ phClr?: string }
  | { kind: "grp" };

export type ArrowEnd = { type: string; w: string; len: string };
export type Line = { fill?: Fill; width?: number; cap?: "flat" | "rnd" | "sq"; join?: "round" | "bevel" | "miter"; dash?: string | number[]; head?: ArrowEnd; tail?: ArrowEnd; cmpd?: string };
export type Shadow = { color: RGBA; blur: number; dist: number; dir: number; sx: number; sy: number; kx: number; ky: number; algn: string };

const FILL_TAGS = ["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"];
const pct = (v: string | null, d = 0) => num(v, d * 100000) / 100000;

export function colorIn(el: El | null, cc: ColorCtx, phClr?: string): RGBA | null {
  return drawingColor(el, cc.theme, cc.map, phClr);
}

function insets(el: El | null): Insets | undefined {
  if (!el) return undefined;
  return { l: pct(attr(el, "l")), t: pct(attr(el, "t")), r: pct(attr(el, "r")), b: pct(attr(el, "b")) };
}

/** A fill element itself (a:solidFill, a:gradFill...). */
export function fillFrom(f: El, cc: ColorCtx, phClr?: string, owner?: unknown): Fill | undefined {
  switch (f.localName) {
    case "noFill":
      return { kind: "none" };
    case "solidFill": {
      const c = colorIn(f, cc, phClr);
      return c ? { kind: "solid", color: c } : { kind: "none" };
    }
    case "gradFill": {
      const stops: Stop[] = [];
      for (const gs of kids(kid(f, "gsLst"), "gs")) {
        const c = colorIn(gs, cc, phClr);
        if (c) stops.push({ pos: pct(attr(gs, "pos")), color: c });
      }
      if (!stops.length) return undefined;
      stops.sort((a, b) => a.pos - b.pos);
      const lin = kid(f, "lin");
      const path = kid(f, "path");
      return {
        kind: "grad",
        stops,
        path: path ? ((attr(path, "path") as "circle" | "rect" | "shape") ?? "circle") : "lin",
        angle: num(attr(lin, "ang")) / 60000,
        scaled: attr(lin, "scaled") === "1" || attr(lin, "scaled") === "true",
        focus: insets(kid(path, "fillToRect")) ?? { l: 0, t: 0, r: 0, b: 0 },
        rotWithShape: attr(f, "rotWithShape") !== "0" && attr(f, "rotWithShape") !== "false",
      };
    }
    case "pattFill": {
      const fg = colorIn(kid(f, "fgClr"), cc, phClr) ?? { hex: "000000", alpha: 1 };
      const bg = colorIn(kid(f, "bgClr"), cc, phClr) ?? { hex: "FFFFFF", alpha: 1 };
      return { kind: "patt", prst: attr(f, "prst") ?? "pct5", fg, bg };
    }
    case "blipFill": {
      const blip = kid(f, "blip");
      if (!blip) return undefined;
      const tile = kid(f, "tile");
      const stretch = kid(f, "stretch");
      return {
        kind: "blip",
        blip,
        src: insets(kid(f, "srcRect")),
        stretch: stretch ? (insets(kid(stretch, "fillRect")) ?? { l: 0, t: 0, r: 0, b: 0 }) : tile ? undefined : { l: 0, t: 0, r: 0, b: 0 },
        tile: tile
          ? { tx: num(attr(tile, "tx")) / 12700, ty: num(attr(tile, "ty")) / 12700, sx: pct(attr(tile, "sx"), 1), sy: pct(attr(tile, "sy"), 1), flip: attr(tile, "flip") ?? "none", algn: attr(tile, "algn") ?? "tl" }
          : undefined,
        rotWithShape: attr(f, "rotWithShape") !== "0",
        owner,
        ...(phClr ? { phClr } : {}),
      };
    }
    case "grpFill":
      return { kind: "grp" };
  }
  return undefined;
}

/** The fill set directly in a container (spPr, bgPr, tcPr, rPr), if any. */
export function readFill(container: El | null | undefined, cc: ColorCtx, phClr?: string, owner?: unknown): Fill | undefined {
  if (!container) return undefined;
  for (const c of Array.from(container.children)) if (FILL_TAGS.includes(c.localName)) return fillFrom(c, cc, phClr, owner);
  return undefined;
}

/** An a:ln element's settings (only those it sets). */
export function readLine(ln: El | null | undefined, cc: ColorCtx, phClr?: string): Line {
  if (!ln) return {};
  const out: Line = {};
  const w = attr(ln, "w");
  if (w !== null) out.width = num(w) / 12700;
  const cap = attr(ln, "cap");
  if (cap) out.cap = cap as Line["cap"];
  const cmpd = attr(ln, "cmpd");
  if (cmpd) out.cmpd = cmpd;
  const f = readFill(ln, cc, phClr);
  if (f) out.fill = f;
  if (kid(ln, "round")) out.join = "round";
  else if (kid(ln, "bevel")) out.join = "bevel";
  else if (kid(ln, "miter")) out.join = "miter";
  const pd = kid(ln, "prstDash");
  if (pd) out.dash = attr(pd, "val") ?? "solid";
  const cd = kid(ln, "custDash");
  if (cd) out.dash = kids(cd, "ds").flatMap((d) => [num(attr(d, "d")) / 100000, num(attr(d, "sp")) / 100000]);
  for (const end of ["headEnd", "tailEnd"] as const) {
    const e = kid(ln, end);
    if (e) out[end === "headEnd" ? "head" : "tail"] = { type: attr(e, "type") ?? "none", w: attr(e, "w") ?? "med", len: attr(e, "len") ?? "med" };
  }
  return out;
}

export function mergeLine(base: Line, over: Line): Line {
  return { ...base, ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)) };
}

export function readShadow(effectLst: El | null | undefined, cc: ColorCtx, phClr?: string): Shadow | undefined {
  const s = kid(effectLst, "outerShdw");
  if (!s) return undefined;
  const color = colorIn(s, cc, phClr);
  if (!color) return undefined;
  return {
    color,
    blur: num(attr(s, "blurRad")) / 12700,
    dist: num(attr(s, "dist")) / 12700,
    dir: num(attr(s, "dir")) / 60000,
    sx: pct(attr(s, "sx"), 1),
    sy: pct(attr(s, "sy"), 1),
    kx: num(attr(s, "kx")) / 60000,
    ky: num(attr(s, "ky")) / 60000,
    algn: attr(s, "algn") ?? "b",
  };
}

/* ------------------------------------------------------------- painting */

/** A shape's own box (0..w, 0..h) and where it lands on the page. */
export type Frame = { m: Mat; w: number; h: number };
/** A picture fill's image; `size` is roughly how big it will be drawn (points). */
export type ImageLoader = (fill: Extract<Fill, { kind: "blip" }>, size?: { w: number; h: number }) => Promise<{ img: PDFImage; w: number; h: number; alpha?: number } | null>;

/** Where a stretched picture lands in its box (0..w, 0..h), after cropping and the fill rectangle. */
export function blipPlacement(f: Extract<Fill, { kind: "blip" }>, w: number, h: number): { ix: number; iy: number; iw: number; ih: number } | null {
  const s = f.stretch ?? { l: 0, t: 0, r: 0, b: 0 };
  const bx = s.l * w;
  const by = s.t * h;
  const bw = w * (1 - s.l - s.r);
  const bh = h * (1 - s.t - s.b);
  const c = f.src ?? { l: 0, t: 0, r: 0, b: 0 };
  const cw = 1 - c.l - c.r;
  const ch = 1 - c.t - c.b;
  if (bw <= 0 || bh <= 0 || cw <= 0 || ch <= 0) return null;
  const iw = bw / cw;
  const ih = bh / ch;
  return { ix: bx - c.l * iw, iy: by - c.t * ih, iw, ih };
}

const darken = (c: RGBA, f: number): RGBA => ({ ...c, hex: mapRgb(c.hex, (x) => x * f) });
const lighten = (c: RGBA, f: number): RGBA => ({ ...c, hex: mapRgb(c.hex, (x) => x + (1 - x) * f) });
function mapRgb(hex: string, fn: (x: number) => number): string {
  return [0, 2, 4]
    .map((i) => Math.round(Math.max(0, Math.min(1, fn(parseInt(hex.slice(i, i + 2), 16) / 255))) * 255).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
/** Preset shapes shade some of their parts (the side of a cube, the fold of a scroll). */
export function shadeColor(c: RGBA, mode: string): RGBA {
  switch (mode) {
    case "darken":
      return darken(c, 0.6);
    case "darkenLess":
      return darken(c, 0.8);
    case "lighten":
      return lighten(c, 0.4);
    case "lightenLess":
      return lighten(c, 0.2);
  }
  return c;
}
const rgbComps = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** Fill one path (local coordinates) with `fill`. */
export async function paintFill(pen: Pen, segs: Seg[], fill: Fill, frame: Frame, mode: string, images: ImageLoader, frameNoRot?: Frame) {
  if (fill.kind === "none" || fill.kind === "grp") return;
  if (fill.kind === "solid") {
    pen.save();
    pen.path(segs, frame.m);
    pen.fillWith(shadeColor(fill.color, mode), true);
    pen.restore();
    return;
  }
  if (fill.kind === "grad") {
    paintGradient(pen, segs, fill, fill.rotWithShape || !frameNoRot ? frame : frameNoRot, mode, frame);
    return;
  }
  if (fill.kind === "patt") {
    paintPattern(pen, segs, fill, frame, mode);
    return;
  }
  if (fill.kind === "blip") await paintBlip(pen, segs, fill, frame, images);
}

function paintGradient(pen: Pen, segs: Seg[], g: Extract<Fill, { kind: "grad" }>, frame: Frame, mode: string, clipFrame: Frame) {
  const stops = g.stops.map((s) => ({ pos: s.pos, color: shadeColor(s.color, mode) }));
  const { w, h } = frame;
  if (w <= 0 || h <= 0) return;
  const alphas = stops.map((s) => s.color.alpha);
  const sameAlpha = alphas.every((a) => Math.abs(a - alphas[0]) < 0.004);
  pen.save();
  pen.path(segs, clipFrame.m);
  pen.clip(true);
  pen.concat(frame.m);
  // Work in the unit square for path gradients and scaled linear ones.
  const unit = g.path !== "lin" || g.scaled;
  if (unit) pen.concat(scale(w, h));
  const W = unit ? 1 : w;
  const H = unit ? 1 : h;
  const rgbStops = stops.map((s) => ({ pos: s.pos, c: rgbComps(s.color.hex) }));
  const grayStops = stops.map((s) => ({ pos: s.pos, c: [s.color.alpha] }));
  if (g.path === "lin") {
    const r = (g.angle * Math.PI) / 180;
    const dx = Math.cos(r);
    const dy = Math.sin(r);
    const half = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
    const coords = [W / 2 - half * dx, H / 2 - half * dy, W / 2 + half * dx, H / 2 + half * dy];
    if (!sameAlpha) pen.setGS(pen.softMask(pen.shading(2, coords, grayStops, true), [-1, -1, W + 2, H + 2]));
    else if (alphas[0] < 1) pen.alpha(alphas[0]);
    pen.shade(pen.resource("Shading", pen.shading(2, coords, rgbStops), "Sh"));
  } else if (g.path === "circle") {
    const f = g.focus;
    const cx = f.l + (1 - f.l - f.r) / 2;
    const cy = f.t + (1 - f.t - f.b) / 2;
    const rad = Math.max(...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
    const coords = [cx, cy, 0, cx, cy, rad];
    if (!sameAlpha) pen.setGS(pen.softMask(pen.shading(3, coords, grayStops, true), [-1, -1, 3, 3]));
    else if (alphas[0] < 1) pen.alpha(alphas[0]);
    pen.shade(pen.resource("Shading", pen.shading(3, coords, rgbStops), "Sh"));
  } else {
    // Rectangular: four regions from the focus rectangle out to each side.
    const f = g.focus;
    const L = f.l;
    const T = f.t;
    const R = 1 - f.r;
    const B = 1 - f.b;
    const avg = alphas.reduce((a, b) => a + b, 0) / alphas.length;
    if (avg < 1) pen.alpha(avg);
    const regions: { poly: [number, number][]; coords: number[] }[] = [
      { poly: [[0, 0], [1, 0], [R, T], [L, T]], coords: [0, T, 0, 0] },
      { poly: [[1, 0], [1, 1], [R, B], [R, T]], coords: [R, 0, 1, 0] },
      { poly: [[1, 1], [0, 1], [L, B], [R, B]], coords: [0, B, 0, 1] },
      { poly: [[0, 1], [0, 0], [L, T], [L, B]], coords: [L, 0, 0, 0] },
    ];
    for (const rg of regions) {
      if (Math.hypot(rg.coords[2] - rg.coords[0], rg.coords[3] - rg.coords[1]) < 1e-6) continue;
      pen.save();
      // A hair of overlap so the seams don't show.
      const cxp = rg.poly.reduce((a, p) => a + p[0], 0) / 4;
      const cyp = rg.poly.reduce((a, p) => a + p[1], 0) / 4;
      const grow = (p: [number, number]): [number, number] => [p[0] + (p[0] - cxp) * 0.002, p[1] + (p[1] - cyp) * 0.002];
      const pts = rg.poly.map(grow);
      pen.path([{ t: "M", x: pts[0][0], y: pts[0][1] }, ...pts.slice(1).map(([x, y]) => ({ t: "L" as const, x, y })), { t: "Z" }]);
      pen.clip();
      pen.shade(pen.resource("Shading", pen.shading(2, rg.coords, rgbStops), "Sh"));
      pen.restore();
    }
  }
  pen.restore();
}

/* Office's 8x8 pattern fills (rows top to bottom, high bit leftmost). */
const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];
const PATTERNS: Record<string, number[]> = {
  horz: [0xff, 0, 0, 0, 0, 0, 0, 0],
  vert: [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80],
  ltHorz: [0xff, 0, 0, 0, 0xff, 0, 0, 0],
  ltVert: [0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88],
  dkHorz: [0xff, 0xff, 0, 0, 0xff, 0xff, 0, 0],
  dkVert: [0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc],
  narHorz: [0xff, 0, 0xff, 0, 0xff, 0, 0xff, 0],
  narVert: [0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa],
  dashHorz: [0xf0, 0, 0, 0, 0x0f, 0, 0, 0],
  dashVert: [0x80, 0x80, 0x80, 0x80, 0x08, 0x08, 0x08, 0x08],
  cross: [0xff, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80],
  smGrid: [0xff, 0x88, 0x88, 0x88, 0xff, 0x88, 0x88, 0x88],
  lgGrid: [0xff, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80],
  dnDiag: [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01],
  upDiag: [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80],
  ltDnDiag: [0x88, 0x44, 0x22, 0x11, 0x88, 0x44, 0x22, 0x11],
  ltUpDiag: [0x11, 0x22, 0x44, 0x88, 0x11, 0x22, 0x44, 0x88],
  dkDnDiag: [0xcc, 0x66, 0x33, 0x99, 0xcc, 0x66, 0x33, 0x99],
  dkUpDiag: [0x33, 0x66, 0xcc, 0x99, 0x33, 0x66, 0xcc, 0x99],
  wdDnDiag: [0xe0, 0x70, 0x38, 0x1c, 0x0e, 0x07, 0x83, 0xc1],
  wdUpDiag: [0x07, 0x0e, 0x1c, 0x38, 0x70, 0xe0, 0xc1, 0x83],
  dashDnDiag: [0x88, 0x44, 0x22, 0x11, 0, 0, 0, 0],
  dashUpDiag: [0x11, 0x22, 0x44, 0x88, 0, 0, 0, 0],
  diagCross: [0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81],
  smCheck: [0xcc, 0xcc, 0x33, 0x33, 0xcc, 0xcc, 0x33, 0x33],
  lgCheck: [0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f],
  smConfetti: [0x80, 0x08, 0x40, 0x02, 0x10, 0x01, 0x20, 0x04],
  lgConfetti: [0xb1, 0x30, 0x03, 0x1b, 0xd8, 0xc0, 0x0c, 0x8d],
  horzBrick: [0xff, 0x80, 0x80, 0x80, 0xff, 0x08, 0x08, 0x08],
  diagBrick: [0x80, 0x40, 0x20, 0x10, 0x18, 0x24, 0x42, 0x81],
  solidDmnd: [0x10, 0x38, 0x7c, 0xfe, 0x7c, 0x38, 0x10, 0x00],
  openDmnd: [0x82, 0x44, 0x28, 0x10, 0x28, 0x44, 0x82, 0x01],
  dotDmnd: [0x80, 0x00, 0x22, 0x00, 0x08, 0x00, 0x22, 0x00],
  plaid: [0xaa, 0x55, 0xaa, 0x55, 0xf0, 0xf0, 0xf0, 0xf0],
  sphere: [0x77, 0x89, 0x8f, 0x8f, 0x77, 0x98, 0xf8, 0xf8],
  weave: [0x88, 0x54, 0x22, 0x45, 0x88, 0x14, 0x22, 0x51],
  divot: [0x00, 0x10, 0x08, 0x10, 0x00, 0x01, 0x80, 0x01],
  shingle: [0x03, 0x84, 0x48, 0x30, 0x0c, 0x02, 0x01, 0x01],
  wave: [0x00, 0x18, 0xa4, 0x03, 0x00, 0x18, 0xa4, 0x03],
  trellis: [0xff, 0x66, 0xff, 0x99, 0xff, 0x66, 0xff, 0x99],
  zigZag: [0x81, 0x42, 0x24, 0x18, 0x81, 0x42, 0x24, 0x18],
  dotGrid: [0xaa, 0x00, 0x80, 0x00, 0x80, 0x00, 0x80, 0x00],
};
function patternBits(prst: string): number[] {
  const hit = PATTERNS[prst];
  if (hit) return hit;
  const m = /^pct(\d+)$/.exec(prst);
  const level = m ? Number(m[1]) / 100 : 0.5;
  return BAYER.map((row) => row.reduce((acc, t, i) => (t < level * 64 ? acc | (0x80 >> i) : acc), 0));
}

function paintPattern(pen: Pen, segs: Seg[], p: Extract<Fill, { kind: "patt" }>, frame: Frame, mode: string) {
  const px = 0.75;
  const bits = patternBits(p.prst);
  const fg = shadeColor(p.fg, mode);
  const bg = shadeColor(p.bg, mode);
  const c = (hex: string) => rgbComps(hex).map((v) => v.toFixed(4)).join(" ");
  // Foreground and background each keep their own transparency (a clear background is common).
  const gs: Record<string, unknown> = {};
  // A tile of 4 x 4 cells, each row's pixels joined into runs: fewer edges for a viewer's
  // smoothing to show as faint seams.
  const REP = 4;
  const n = 8 * REP;
  let content = "";
  if (bg.alpha > 0.004) {
    if (bg.alpha < 1) gs.Gb = { Type: "ExtGState", ca: bg.alpha };
    content += `q ${bg.alpha < 1 ? "/Gb gs " : ""}${c(bg.hex)} rg 0 0 ${n * px} ${n * px} re f Q `;
  }
  if (fg.alpha > 0.004) {
    if (fg.alpha < 1) gs.Gf = { Type: "ExtGState", ca: fg.alpha };
    content += `q ${fg.alpha < 1 ? "/Gf gs " : ""}${c(fg.hex)} rg`;
    for (let y = 0; y < n; y++) {
      const row = bits[y % 8];
      for (let x = 0; x < n; ) {
        if (!(row & (0x80 >> (x % 8)))) {
          x++;
          continue;
        }
        let e = x;
        while (e < n && row & (0x80 >> (e % 8))) e++;
        content += ` ${x * px} ${y * px} ${(e - x) * px} ${px} re`;
        x = e;
      }
    }
    content += " f Q";
  }
  if (!content) return;
  // Pattern space is the page's default space: flip it so row 0 is on top, as in ours.
  const name = pen.tilingPattern(content, n * px, n * px, [1, 0, 0, -1, 0, pen.H], Object.keys(gs).length ? { ExtGState: gs } : {});
  pen.save();
  pen.path(segs, frame.m);
  pen.fillPattern(name, true);
  pen.restore();
}

async function paintBlip(pen: Pen, segs: Seg[], f: Extract<Fill, { kind: "blip" }>, frame: Frame, images: ImageLoader) {
  const { w, h } = frame;
  const k = Math.max(Math.hypot(frame.m[0], frame.m[1]), Math.hypot(frame.m[2], frame.m[3]));
  const got = await images(f, { w: w * k, h: h * k });
  if (!got) return;
  pen.save();
  pen.path(segs, frame.m);
  pen.clip(true);
  pen.concat(frame.m);
  if (got.alpha !== undefined && got.alpha < 1) pen.alpha(got.alpha);
  if (f.tile) {
    const t = f.tile;
    const tw = got.w * t.sx;
    const th = got.h * t.sy;
    if (tw > 0.5 && th > 0.5) {
      const ax = /l$/.test(t.algn) || t.algn === "l" ? 0 : /r$/.test(t.algn) ? w : w / 2;
      const ay = /^t/.test(t.algn) ? 0 : /^b/.test(t.algn) ? h : h / 2;
      const ox = ax + t.tx - (t.algn === "ctr" || t.algn === "t" || t.algn === "b" ? tw / 2 : /r$/.test(t.algn) ? tw : 0);
      const oy = ay + t.ty - (t.algn === "ctr" || t.algn === "l" || t.algn === "r" ? th / 2 : /^b/.test(t.algn) ? th : 0);
      const x0 = ox - Math.ceil(ox / tw) * tw;
      const y0 = oy - Math.ceil(oy / th) * th;
      let count = 0;
      for (let y = y0, j = 0; y < h && count < 4000; y += th, j++) {
        for (let x = x0, i = 0; x < w && count < 4000; x += tw, i++) {
          const fx = (t.flip === "x" || t.flip === "xy") && i % 2 === 1;
          const fy = (t.flip === "y" || t.flip === "xy") && j % 2 === 1;
          pen.image(got.img, [fx ? -tw : tw, 0, 0, fy ? th : -th, fx ? x + tw : x, fy ? y : y + th]);
          count++;
        }
      }
    }
  } else {
    // Stretched into the fill rectangle, after cropping (srcRect) the picture.
    const pl = blipPlacement(f, w, h);
    if (pl) pen.image(got.img, [pl.iw, 0, 0, -pl.ih, pl.ix, pl.iy + pl.ih]);
  }
  pen.restore();
}

/* ------------------------------------------------------------------ lines */

const DASHES: Record<string, number[]> = {
  solid: [],
  dot: [1, 3],
  dash: [4, 3],
  lgDash: [8, 3],
  dashDot: [4, 3, 1, 3],
  lgDashDot: [8, 3, 1, 3],
  lgDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDash: [3, 1],
  sysDot: [1, 1],
  sysDashDot: [3, 1, 1, 1],
  sysDashDotDot: [3, 1, 1, 1, 1, 1],
};

export function strokeStyle(l: Line): StrokeStyle {
  // Zero width is a hairline: the thinnest line the device draws.
  const width = l.width === 0 ? 0 : Math.max(0.25, l.width ?? 0.75);
  const rel = typeof l.dash === "string" ? (DASHES[l.dash] ?? []) : (l.dash ?? []);
  let dash = rel.map((x) => x * (width || 1));
  // Round and square caps grow each dash by the line width: take it off the dash, give it to the gap.
  if (dash.length && l.cap && l.cap !== "flat") dash = dash.map((x, i) => (i % 2 === 0 ? Math.max(0.01, x - width) : x + width));
  return { width, cap: l.cap ?? "flat", join: l.join ?? "round", dash };
}

const END_SIZE: Record<string, number> = { sm: 2, med: 3, lg: 5 };

type Pt = [number, number];
/** The first and last tangents of a path (in page coordinates). */
function endTangents(segs: Seg[], m: Mat): { start?: { p: Pt; dir: Pt }; end?: { p: Pt; dir: Pt } } {
  const pts: Pt[] = [];
  for (const s of segs) {
    if (s.t === "Z") continue;
    if (s.t === "C") pts.push(apply(m, s.x1, s.y1), apply(m, s.x2, s.y2), apply(m, s.x, s.y));
    else pts.push(apply(m, s.x, s.y));
  }
  if (pts.length < 2) return {};
  const unit = (a: Pt, b: Pt): Pt | null => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return d > 1e-6 ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : null;
  };
  let sd: Pt | null = null;
  for (let i = 1; i < pts.length && !sd; i++) sd = unit(pts[i], pts[0]);
  let ed: Pt | null = null;
  for (let i = pts.length - 2; i >= 0 && !ed; i--) ed = unit(pts[i], pts[pts.length - 1]);
  return { start: sd ? { p: pts[0], dir: sd } : undefined, end: ed ? { p: pts[pts.length - 1], dir: ed } : undefined };
}

/** Arrowhead at `p` pointing along `dir`: returns how far to pull the line back. */
function arrowHead(pen: Pen, e: ArrowEnd, p: Pt, dir: Pt, width: number, color: RGBA, style: StrokeStyle): number {
  if (!e || e.type === "none") return 0;
  const lw = Math.max(width, 0.75);
  const hw = (END_SIZE[e.w] ?? 3) * lw * 0.5;
  const len = (END_SIZE[e.len] ?? 3) * lw;
  const [dx, dy] = dir;
  const nx = -dy;
  const ny = dx;
  const at = (a: number, b: number): Pt => [p[0] + dx * a + nx * b, p[1] + dy * a + ny * b];
  pen.save();
  if (e.type === "arrow") {
    // An open V, stroked with the line's own width.
    const a = at(-len, hw);
    const b = at(-len, -hw);
    pen.path([
      { t: "M", x: a[0], y: a[1] },
      { t: "L", x: p[0], y: p[1] },
      { t: "L", x: b[0], y: b[1] },
    ]);
    pen.strokeWith(color, { ...style, dash: [], join: "miter", cap: "flat" });
    pen.restore();
    return 0;
  }
  let pts: Pt[];
  let pull = len;
  if (e.type === "stealth") {
    pts = [p, at(-len, hw), at(-len * 0.6, 0), at(-len, -hw)];
    pull = len * 0.6;
  } else if (e.type === "diamond") {
    pts = [at(len / 2, 0), at(0, hw), at(-len / 2, 0), at(0, -hw)];
    pull = 0;
  } else if (e.type === "oval") {
    const k = 0.5523;
    const c = at(0, 0);
    const rx = len / 2;
    const ry = hw;
    const P = (a: number, b: number): Pt => [c[0] + dx * a + nx * b, c[1] + dy * a + ny * b];
    const q = [P(rx, 0), P(rx, ry * k), P(rx * k, ry), P(0, ry), P(-rx * k, ry), P(-rx, ry * k), P(-rx, 0), P(-rx, -ry * k), P(-rx * k, -ry), P(0, -ry), P(rx * k, -ry), P(rx, -ry * k)];
    pen.path([
      { t: "M", x: q[0][0], y: q[0][1] },
      { t: "C", x1: q[1][0], y1: q[1][1], x2: q[2][0], y2: q[2][1], x: q[3][0], y: q[3][1] },
      { t: "C", x1: q[4][0], y1: q[4][1], x2: q[5][0], y2: q[5][1], x: q[6][0], y: q[6][1] },
      { t: "C", x1: q[7][0], y1: q[7][1], x2: q[8][0], y2: q[8][1], x: q[9][0], y: q[9][1] },
      { t: "C", x1: q[10][0], y1: q[10][1], x2: q[11][0], y2: q[11][1], x: q[0][0], y: q[0][1] },
      { t: "Z" },
    ]);
    pen.fillWith(color);
    pen.restore();
    return 0;
  } else pts = [p, at(-len, hw), at(-len, -hw)];
  pen.path([{ t: "M", x: pts[0][0], y: pts[0][1] }, ...pts.slice(1).map(([x, y]) => ({ t: "L" as const, x, y })), { t: "Z" }]);
  pen.fillWith(color);
  pen.restore();
  return pull;
}

/** Pull a path's first (or last) point back along its tangent by `d`. */
function trim(segs: Seg[], atStart: boolean, d: number, m: Mat): Seg[] {
  if (d <= 0) return segs;
  const inv = invert(m);
  const out = segs.map((s) => ({ ...s })) as Seg[];
  const idx = atStart ? out.findIndex((s) => s.t !== "Z") : out.map((s) => s.t !== "Z").lastIndexOf(true);
  if (idx < 0) return segs;
  const s = out[idx];
  if (s.t === "Z") return segs;
  // Move the endpoint in page space, then back to local.
  const prev: Pt | null = atStart ? null : (() => {
    for (let i = idx - 1; i >= 0; i--) {
      const q = out[i];
      if (q.t !== "Z") return apply(m, q.x, q.y);
    }
    return null;
  })();
  const p = apply(m, s.x, s.y);
  let toward: Pt | null = null;
  if (atStart) {
    const n = out[idx + 1];
    if (n && n.t !== "Z") toward = n.t === "C" ? apply(m, n.x1, n.y1) : apply(m, n.x, n.y);
  } else toward = s.t === "C" ? apply(m, s.x2, s.y2) : prev;
  if (!toward) return segs;
  const len = Math.hypot(toward[0] - p[0], toward[1] - p[1]);
  if (len < 1e-6) return segs;
  const k = Math.min(d, len * 0.95) / len;
  const np: Pt = [p[0] + (toward[0] - p[0]) * k, p[1] + (toward[1] - p[1]) * k];
  const [lx, ly] = apply(inv, np[0], np[1]);
  (s as { x: number; y: number }).x = lx;
  (s as { x: number; y: number }).y = ly;
  return out;
}

/** Stroke a path (local coordinates) with an outline, arrowheads included. */
export function paintLine(pen: Pen, segs: Seg[], line: Line, frame: Frame, open: boolean) {
  const fill = line.fill;
  if (!fill || fill.kind === "none" || fill.kind === "grp") return;
  const color: RGBA = fill.kind === "solid" ? fill.color : fill.kind === "grad" ? (fill.stops[Math.floor(fill.stops.length / 2)]?.color ?? { hex: "000000", alpha: 1 }) : fill.kind === "patt" ? fill.fg : { hex: "000000", alpha: 1 };
  const style = strokeStyle(line);
  let path = segs;
  if (open && ((line.head && line.head.type !== "none") || (line.tail && line.tail.type !== "none"))) {
    const tg = endTangents(segs, frame.m);
    if (line.head && tg.start) path = trim(path, true, arrowHead(pen, line.head, tg.start.p, tg.start.dir, style.width, color, style), frame.m);
    if (line.tail && tg.end) path = trim(path, false, arrowHead(pen, line.tail, tg.end.p, tg.end.dir, style.width, color, style), frame.m);
  }
  pen.save();
  pen.path(path, frame.m);
  pen.strokeWith(color, style);
  pen.restore();
}

/** Does this path end where it starts (no arrowheads on closed outlines)? */
export const isOpen = (segs: Seg[]) => !segs.some((s) => s.t === "Z");

export { IDENT, rotate, translate, then };
