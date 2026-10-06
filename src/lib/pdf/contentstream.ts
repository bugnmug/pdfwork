/**
 * Minimal PDF content-stream tokenizer and walker. Enough to follow the
 * graphics state (q/Q/cm), find where images are drawn and at what size, and
 * rewrite colour operators.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
} from "@cantoo/pdf-lib";
import type { PDFDocument } from "./core";

export type TokType = "num" | "name" | "str" | "hex" | "op" | "arrS" | "arrE" | "dictS" | "dictE" | "inline";
export type Tok = { t: TokType; s: number; e: number; v: string };

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

export function tokenize(b: Uint8Array): Tok[] {
  const out: Tok[] = [];
  const n = b.length;
  let i = 0;
  const str = (s: number, e: number) => {
    let r = "";
    for (let k = s; k < e; k++) r += String.fromCharCode(b[k]);
    return r;
  };
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) {
      i++;
      continue;
    }
    if (c === 37) {
      while (i < n && b[i] !== 10 && b[i] !== 13) i++;
      continue;
    }
    const s = i;
    if (c === 40) {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (b[i] === 92) i += 2;
        else {
          if (b[i] === 40) depth++;
          else if (b[i] === 41) depth--;
          i++;
        }
      }
      out.push({ t: "str", s, e: i, v: "" });
      continue;
    }
    if (c === 60) {
      if (b[i + 1] === 60) {
        out.push({ t: "dictS", s, e: i + 2, v: "<<" });
        i += 2;
        continue;
      }
      while (i < n && b[i] !== 62) i++;
      i++;
      out.push({ t: "hex", s, e: i, v: "" });
      continue;
    }
    if (c === 62 && b[i + 1] === 62) {
      out.push({ t: "dictE", s, e: i + 2, v: ">>" });
      i += 2;
      continue;
    }
    if (c === 91 || c === 93) {
      out.push({ t: c === 91 ? "arrS" : "arrE", s, e: i + 1, v: String.fromCharCode(c) });
      i++;
      continue;
    }
    if (c === 123 || c === 125 || c === 41 || c === 62) {
      i++;
      continue;
    }
    if (c === 47) {
      i++;
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      out.push({ t: "name", s, e: i, v: str(s + 1, i) });
      continue;
    }
    while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    const word = str(s, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      out.push({ t: "num", s, e: i, v: word });
      continue;
    }
    if (word === "BI") {
      // Inline image: skip to "ID", then binary data until whitespace + "EI" + whitespace/EOF.
      let k = i;
      while (k < n - 1 && !(b[k] === 73 && b[k + 1] === 68 && WS.has(b[k - 1]) && (WS.has(b[k + 2]) || k + 2 >= n))) k++;
      k += 3;
      while (k < n - 1 && !(WS.has(b[k - 1]) && b[k] === 69 && b[k + 1] === 73 && (k + 2 >= n || WS.has(b[k + 2]) || DELIM.has(b[k + 2])))) k++;
      i = Math.min(n, k + 2);
      out.push({ t: "inline", s, e: i, v: "BI" });
      continue;
    }
    out.push({ t: "op", s, e: i, v: word || String.fromCharCode(c) });
    if (!word) i++;
  }
  return out;
}

export function streamBytes(ctx: PDFContext, obj: unknown): Uint8Array {
  const s = obj instanceof PDFRef ? ctx.lookup(obj) : obj;
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFStream) return s.getContents();
  return new Uint8Array();
}

/** Concatenated, decoded content of a page. */
export function pageContent(doc: PDFDocument, pageIndex: number): Uint8Array {
  const page = doc.getPage(pageIndex);
  const ctx = doc.context;
  const contents = page.node.get(PDFName.of("Contents"));
  const resolved = contents instanceof PDFRef ? ctx.lookup(contents) : contents;
  const parts: Uint8Array[] = [];
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) parts.push(streamBytes(ctx, resolved.get(i)));
  } else if (resolved) parts.push(streamBytes(ctx, resolved));
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 10;
  }
  return out;
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

function resourcesOf(node: PDFDict | undefined, ctx: PDFContext): PDFDict | undefined {
  if (!node) return undefined;
  const r = node.get(PDFName.of("Resources"));
  const d = r instanceof PDFRef ? ctx.lookup(r) : r;
  return d instanceof PDFDict ? d : undefined;
}

function xobjects(res: PDFDict | undefined, ctx: PDFContext): PDFDict | undefined {
  if (!res) return undefined;
  const x = res.get(PDFName.of("XObject"));
  const d = x instanceof PDFRef ? ctx.lookup(x) : x;
  return d instanceof PDFDict ? d : undefined;
}

/** A rectangle as [x0, y0, x1, y1]. */
export type Rect4 = [number, number, number, number];

/** One image drawn on a page: the image object, the matrix that maps its unit square onto the page, and the clip in force around it (page space). */
export type ImageDraw = { page: number; ref: PDFRef; m: M; clip?: Rect4 };

const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const grow = (r: Rect4 | undefined, [x, y]: [number, number]): Rect4 => (r ? [Math.min(r[0], x), Math.min(r[1], y), Math.max(r[2], x), Math.max(r[3], y)] : [x, y, x, y]);
const meet = (a: Rect4 | undefined, b: Rect4): Rect4 => (a ? [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])] : b);
const PAINT = new Set(["n", "f", "F", "f*", "S", "s", "B", "B*", "b", "b*"]);

/**
 * Every image drawn on every page, inside forms too, with the matrix it is drawn with and the
 * clip around it (the bounding box of each clipping path, so a photo cropped to a frame shows
 * only the frame).
 */
export function walkImages(doc: PDFDocument, visit: (d: ImageDraw) => void) {
  const ctx = doc.context;
  const run = (page: number, bytes: Uint8Array, res: PDFDict | undefined, base: M, clip0: Rect4 | undefined, depth: number) => {
    if (depth > 12) return;
    const xo = xobjects(res, ctx);
    const toks = tokenize(bytes);
    type St = { ctm: M; clip?: Rect4 };
    const stack: St[] = [];
    let st: St = { ctm: base, clip: clip0 };
    const nums: number[] = [];
    let lastName = "";
    // The current path's bounding box on the page, and whether it clips once painted.
    let path: Rect4 | undefined;
    let clips = false;
    const pt = (x: number, y: number) => (path = grow(path, apply(st.ctm, x, y)));
    for (const t of toks) {
      if (t.t === "num") {
        nums.push(Number(t.v));
        continue;
      }
      if (t.t === "name") {
        lastName = t.v;
        nums.length = 0;
        continue;
      }
      if (t.t !== "op") {
        nums.length = 0;
        continue;
      }
      const a = nums.slice(-6);
      switch (t.v) {
        case "q":
          stack.push({ ...st });
          break;
        case "Q":
          st = stack.pop() ?? { ctm: base, clip: clip0 };
          break;
        case "cm":
          if (nums.length >= 6) st.ctm = mul(a as M, st.ctm);
          break;
        case "re":
          if (nums.length >= 4) {
            const [x, y, w, h] = nums.slice(-4);
            pt(x, y);
            pt(x + w, y);
            pt(x, y + h);
            pt(x + w, y + h);
          }
          break;
        case "m":
        case "l":
          if (nums.length >= 2) pt(nums[nums.length - 2], nums[nums.length - 1]);
          break;
        case "c":
        case "v":
        case "y":
          for (let k = 0; k + 1 < nums.length; k += 2) pt(nums[k], nums[k + 1]);
          break;
        case "W":
        case "W*":
          clips = true;
          break;
        case "Do": {
          const raw = xo?.get(PDFName.of(lastName));
          if (raw instanceof PDFRef) {
            const obj = ctx.lookup(raw);
            if (obj instanceof PDFRawStream || obj instanceof PDFStream) {
              const sub = obj.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
              if (sub === "/Image") visit({ page, ref: raw, m: st.ctm, clip: st.clip });
              else if (sub === "/Form") {
                const num = (arr: PDFArray | undefined, k: number, dflt: number) => (arr?.lookup(k) as PDFNumber | undefined)?.asNumber?.() ?? dflt;
                const mArr = obj.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray);
                const fm: M = mArr ? (Array.from({ length: 6 }, (_, k) => num(mArr, k, k === 0 || k === 3 ? 1 : 0)) as M) : [1, 0, 0, 1, 0, 0];
                const m = mul(fm, st.ctm);
                // A form draws only inside its bounding box.
                const bb = obj.dict.lookupMaybe(PDFName.of("BBox"), PDFArray);
                let clip = st.clip;
                if (bb && bb.size() === 4) {
                  const [x0, y0, x1, y1] = [0, 1, 2, 3].map((k) => num(bb, k, 0));
                  clip = meet(clip, [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)].reduce<Rect4 | undefined>((r, p) => grow(r, p), undefined)!);
                }
                try {
                  run(page, streamBytes(ctx, obj), resourcesOf(obj.dict, ctx) ?? res, m, clip, depth + 1);
                } catch {
                  /* undecodable form: ignore */
                }
              }
            }
          }
          break;
        }
        default:
          if (PAINT.has(t.v)) {
            if (clips && path) st.clip = meet(st.clip, path);
            path = undefined;
            clips = false;
          }
      }
      nums.length = 0;
    }
  };
  doc.getPages().forEach((p, i) => {
    try {
      run(i, pageContent(doc, i), resourcesOf(p.node, ctx) ?? (p.node.Resources() as PDFDict | undefined), [1, 0, 0, 1, 0, 0], undefined, 0);
    } catch {
      /* skip page */
    }
  });
}

/** For every image XObject, the largest size (in points) it is drawn at anywhere in the document. */
export function imageDisplaySizes(doc: PDFDocument): Map<string, { w: number; h: number }> {
  const sizes = new Map<string, { w: number; h: number }>();
  walkImages(doc, ({ ref, m }) => {
    const w = Math.hypot(m[0], m[1]);
    const h = Math.hypot(m[2], m[3]);
    const key = ref.toString();
    const cur = sizes.get(key);
    if (!cur || w * h > cur.w * cur.h) sizes.set(key, { w, h });
  });
  return sizes;
}

/**
 * The matrix pdf.js uses to show a page (scale 1): page space to the page as seen, with the
 * origin at its top-left corner and y running down, after the crop box and /Rotate.
 */
export function viewTransform(page: ReturnType<PDFDocument["getPage"]>): M {
  const box = (r: { x: number; y: number; width: number; height: number }): Rect4 => [r.x, r.y, r.x + r.width, r.y + r.height];
  const media = box(page.getMediaBox());
  const both = meet(box(page.getCropBox()), media);
  const [x0, y0, x1, y1] = both[2] > both[0] && both[3] > both[1] ? both : media;
  let rot = page.getRotation().angle;
  rot = rot % 90 ? 0 : ((rot % 360) + 360) % 360;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const [A, B, C, D] = rot === 90 ? [0, 1, 1, 0] : rot === 180 ? [-1, 0, 0, 1] : rot === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1];
  const [ox, oy] = A === 0 ? [Math.abs(cy - y0), Math.abs(cx - x0)] : [Math.abs(cx - x0), Math.abs(cy - y0)];
  return [A, B, C, D, ox - A * cx - C * cy, oy - B * cx - D * cy];
}

/** Where an image shows on its page, in the page's visual frame (points, origin top-left). */
export type Placement = {
  /** Visible part: its bounding box. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Its own width and height as drawn (after any crop), rotation clockwise in degrees, and whether it is mirrored. */
  ow: number;
  oh: number;
  rot: number;
  flip: boolean;
  /** Fractions trimmed off each side of the image by a clip (image's own sides). */
  crop?: { left: number; top: number; right: number; bottom: number };
};

/** An image draw mapped onto the page as seen; null when nothing of it shows. */
export function placementOf(d: ImageDraw, view: M, page: { width: number; height: number }): Placement | null {
  const m = mul(d.m, view);
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-6) return null;
  // The visible part of the unit square: the clip (and the page) mapped back into image space.
  const inv = (x: number, y: number): [number, number] => {
    const dx = x - m[4];
    const dy = y - m[5];
    return [(m[3] * dx - m[2] * dy) / det, (-m[1] * dx + m[0] * dy) / det];
  };
  let vis: Rect4 = [0, 0, 1, 1];
  const fence = (r: Rect4) => {
    const uv = [inv(r[0], r[1]), inv(r[2], r[1]), inv(r[0], r[3]), inv(r[2], r[3])].reduce<Rect4 | undefined>((acc, p) => grow(acc, p), undefined)!;
    vis = meet(vis, uv);
  };
  if (d.clip) {
    const c = d.clip;
    const corners = [apply(view, c[0], c[1]), apply(view, c[2], c[1]), apply(view, c[0], c[3]), apply(view, c[2], c[3])];
    fence(corners.reduce<Rect4 | undefined>((acc, p) => grow(acc, p), undefined)!);
  }
  fence([0, 0, page.width, page.height]);
  const [u0, v0, u1, v1] = vis;
  if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) return null;
  const shown = [apply(m, u0, v0), apply(m, u1, v0), apply(m, u0, v1), apply(m, u1, v1)].reduce<Rect4 | undefined>((acc, p) => grow(acc, p), undefined)!;
  // The image's rightward and downward directions on the page (its top row is at v = 1).
  let rx = m[0];
  let ry = m[1];
  const flip = rx * -m[3] - ry * -m[2] < 0;
  if (flip) [rx, ry] = [-rx, -ry];
  const rot = Math.round(((Math.atan2(ry, rx) * 180) / Math.PI + 360) % 360);
  const crop = u0 > 0.002 || v0 > 0.002 || u1 < 0.998 || v1 < 0.998 ? { left: u0, right: 1 - u1, bottom: v0, top: 1 - v1 } : undefined;
  return {
    x: shown[0],
    y: shown[1],
    w: shown[2] - shown[0],
    h: shown[3] - shown[1],
    ow: Math.hypot(m[0], m[1]) * (u1 - u0),
    oh: Math.hypot(m[2], m[3]) * (v1 - v0),
    rot: rot === 360 ? 0 : rot,
    flip,
    ...(crop ? { crop } : {}),
  };
}

/** Which pages draw which image refs (for listing extracted images by page). */
export function imagesByPage(doc: PDFDocument): Map<string, number> {
  const ctx = doc.context;
  const first = new Map<string, number>();
  doc.getPages().forEach((p, i) => {
    const visit = (res: PDFDict | undefined, depth: number) => {
      const xo = xobjects(res, ctx);
      if (!xo || depth > 8) return;
      for (const key of xo.keys()) {
        const ref = xo.get(key);
        if (!(ref instanceof PDFRef)) continue;
        const obj = ctx.lookup(ref);
        if (!(obj instanceof PDFRawStream || obj instanceof PDFStream)) continue;
        const sub = obj.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
        if (sub === "/Image") {
          if (!first.has(ref.toString())) first.set(ref.toString(), i);
        } else if (sub === "/Form") visit(resourcesOf(obj.dict, ctx), depth + 1);
      }
    };
    visit(resourcesOf(p.node, ctx) ?? (p.node.Resources() as PDFDict | undefined), 0);
  });
  return first;
}
