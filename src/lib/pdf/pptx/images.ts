/**
 * Pictures for slides: each image part embedded once (per set of picture
 * effects), sized by its own resolution, SVG pictures drawn from the SVG
 * itself (sharper than the PNG copy Office keeps beside it), and PowerPoint's
 * recolouring (grayscale, duotone, black and white, brightness and contrast,
 * a colour made transparent) applied on a canvas.
 */
import type { PDFImage } from "@cantoo/pdf-lib";
import { canvasToBytes, embedImage, imageToCanvas, sniffImage, type PDFDocument } from "../core";
import { metafileKind, playMetafile } from "../metafile";
import { attr, kid, num, type El, type Package, type Part } from "../ooxml";
import { colorIn, type ColorCtx } from "../drawingml/fill";

/** `w`/`h`: the picture's own size in points; `mask`: its pixels, for shadows that follow transparency. */
export type Loaded = { img: PDFImage; w: number; h: number; alpha?: number; transparent: boolean; mask: () => Promise<HTMLCanvasElement | null> };

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EFFECTS = ["grayscl", "biLevel", "duotone", "lum", "clrChange", "clrRepl"];

/** The resolution an image declares (PNG pHYs, JPEG JFIF), in dots per inch. */
export function imageDpi(b: Uint8Array): number | null {
  if (b[0] === 0x89 && b[1] === 0x50) {
    let i = 8;
    while (i + 12 <= b.length) {
      const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
      const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      if (type === "pHYs" && len >= 9) {
        const ppu = ((b[i + 8] << 24) | (b[i + 9] << 16) | (b[i + 10] << 8) | b[i + 11]) >>> 0;
        return b[i + 16] === 1 && ppu > 0 ? ppu * 0.0254 : null;
      }
      if (type === "IDAT" || type === "IEND") break;
      i += 12 + len;
    }
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 14 < b.length && b[i] === 0xff) {
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker === 0xe0 && b[i + 4] === 0x4a && b[i + 5] === 0x46 && b[i + 6] === 0x49 && b[i + 7] === 0x46) {
        const units = b[i + 11];
        const x = (b[i + 12] << 8) | b[i + 13];
        if (x > 1 && units === 1) return x;
        if (x > 1 && units === 2) return x * 2.54;
        return null;
      }
      if (marker === 0xda) break;
      i += 2 + len;
    }
  }
  return null;
}

/** Does a PNG carry transparency (an alpha channel or a transparent colour)? */
function pngTransparent(b: Uint8Array): boolean {
  if (!(b[0] === 0x89 && b[1] === 0x50)) return false;
  const colorType = b[25];
  if (colorType === 4 || colorType === 6) return true;
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") break;
    i += 12 + len;
  }
  return false;
}

async function svgToCanvas(bytes: Uint8Array, wantW: number, wantH: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/svg+xml" }));
  try {
    const im = new Image();
    await new Promise<void>((res, rej) => {
      im.onload = () => res();
      im.onerror = () => rej(new Error("svg"));
      im.src = url;
    });
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(wantW));
    c.height = Math.max(1, Math.round(wantH));
    c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class Images {
  private cache = new Map<string, Promise<Loaded | null>>();
  private masks = new Map<string, Promise<HTMLCanvasElement | null>>();
  skipped = 0;
  constructor(
    private pkg: Package,
    private doc: PDFDocument,
  ) {}

  /**
   * The picture an a:blip points at, with its effects, or null when we can't draw it.
   * `size` (points) is how big it will be drawn, which sets an SVG picture's resolution.
   */
  load(part: Part, blip: El, cc: ColorCtx, size?: { w: number; h: number }, phClr?: string): Promise<Loaded | null> {
    const id = blip.getAttributeNS(R_NS, "embed") || attr(blip, "embed");
    const rel = id ? part.rels.get(id) : undefined;
    const svgEl = Array.from(blip.getElementsByTagNameNS("*", "svgBlip"))[0];
    const svgId = svgEl ? svgEl.getAttributeNS(R_NS, "embed") || attr(svgEl, "embed") : null;
    const svgRel = svgId ? part.rels.get(svgId) : undefined;
    if ((!rel || rel.external) && !svgRel) return Promise.resolve(null);
    const effects = Array.from(blip.children).filter((c) => EFFECTS.includes(c.localName));
    const alphaFix = kid(blip, "alphaModFix");
    const alpha = alphaFix ? num(attr(alphaFix, "amt"), 100000) / 100000 : undefined;
    const sig = effects.map((e) => new XMLSerializer().serializeToString(e)).join("") + (phClr && effects.length ? `|ph:${phClr}` : "");
    // Vector pictures (SVG, WMF, EMF) are drawn at about 200 dpi of their size on the slide
    // (in steps, so copies share).
    const step = (v: number) => Math.pow(1.25, Math.ceil(Math.log(Math.max(8, v)) / Math.log(1.25)));
    let px: { w: number; h: number } | undefined;
    if (svgRel && !svgRel.external) {
      const s = size && size.w > 0 && size.h > 0 ? size : { w: 200, h: 200 };
      const k = Math.min(4096 / Math.max(s.w, s.h), 200 / 72);
      const w = step(s.w * k);
      px = { w, h: (w * s.h) / s.w };
    }
    const meta = !px && rel && /\.(emf|wmf|emz|wmz)$/i.test(rel.target) && size && size.w > 0 && size.h > 0 ? step(Math.max(size.w, size.h)) : undefined;
    const key = svgRel && px ? `svg:${svgRel.target}|${Math.round(px.w)}x${Math.round(px.h)}|${sig}` : meta ? `mf:${rel!.target}|${Math.round(meta)}|${sig}` : `${rel!.target}|${sig}`;
    let p = this.cache.get(key);
    if (!p) {
      p = svgRel && px ? this.embedSvg(svgRel.target, px, effects, cc, phClr).then((r) => r ?? (rel && !rel.external ? this.embed(rel.target, effects, cc, phClr) : null)) : this.embed(rel!.target, effects, cc, phClr, meta);
      this.cache.set(key, p);
    }
    return p.then((l) => (l ? { ...l, alpha } : null));
  }

  /** A picture by its part name (a VML preview's), without effects; `size` as for load. */
  loadTarget(target: string, cc: ColorCtx, size?: { w: number; h: number }): Promise<Loaded | null> {
    const meta = /\.(emf|wmf|emz|wmz)$/i.test(target) && size && size.w > 0 && size.h > 0 ? Math.ceil(Math.max(size.w, size.h) / 25) * 25 : undefined;
    const key = meta ? `mf:${target}|${meta}|` : `${target}|`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.embed(target, [], cc, undefined, meta);
      this.cache.set(key, p);
    }
    return p;
  }

  private mask(target: string, make: () => Promise<HTMLCanvasElement | null>): () => Promise<HTMLCanvasElement | null> {
    return () => {
      let m = this.masks.get(target);
      if (!m) {
        m = make().catch(() => null);
        this.masks.set(target, m);
      }
      return m;
    };
  }

  private async embed(target: string, effects: El[], cc: ColorCtx, phClr?: string, shown?: number): Promise<Loaded | null> {
    const bytes = await this.pkg.bytes(target);
    if (!bytes) return null;
    const ext = target.split(".").pop()?.toLowerCase() ?? "";
    const kind = sniffImage(bytes);
    if (!kind && ext === "svg") return this.embedSvg(target, null, effects, cc, phClr);
    if (!kind && (["emf", "wmf", "emz", "wmz"].includes(ext) || metafileKind(bytes))) return this.embedMetafile(bytes, effects, cc, phClr, shown);
    if (!kind && ["wdp", "jxr", "tif", "tiff"].includes(ext)) {
      this.skipped++;
      return null;
    }
    const dpi = imageDpi(bytes) ?? 96;
    const transparent = pngTransparent(bytes) || kind === "image/gif";
    try {
      if (effects.length) {
        const canvas = await imageToCanvas(bytes, kind ?? "");
        recolour(canvas, effects, cc, phClr);
        const img = await this.doc.embedPng(await canvasToBytes(canvas, "image/png"));
        return { img, w: (canvas.width * 72) / dpi, h: (canvas.height * 72) / dpi, transparent: true, mask: async () => canvas };
      }
      const img = await embedImage(this.doc, bytes, kind ?? "");
      return { img, w: (img.width * 72) / dpi, h: (img.height * 72) / dpi, transparent, mask: this.mask(target, () => imageToCanvas(bytes, kind ?? "")) };
    } catch {
      this.skipped++;
      return null;
    }
  }

  /** A WMF or EMF picture (clipart, a logo, an OLE object's preview), played onto a canvas. */
  private async embedMetafile(bytes: Uint8Array, effects: El[], cc: ColorCtx, phClr?: string, shown?: number): Promise<Loaded | null> {
    const mf = await playMetafile(bytes, { shown });
    if (!mf) {
      this.skipped++;
      return null;
    }
    try {
      if (effects.length) recolour(mf.canvas, effects, cc, phClr);
      const img = await this.doc.embedPng(await canvasToBytes(mf.canvas, "image/png"));
      return { img, w: mf.w, h: mf.h, transparent: true, mask: async () => mf.canvas };
    } catch {
      this.skipped++;
      return null;
    }
  }

  private async embedSvg(target: string, px: { w: number; h: number } | null, effects: El[], cc: ColorCtx, phClr?: string): Promise<Loaded | null> {
    const bytes = await this.pkg.bytes(target);
    if (!bytes) return null;
    try {
      // The SVG's own size, for tiling and when no slide size is known.
      const head = new TextDecoder().decode(bytes.subarray(0, 4000));
      const dim = (n: string) => Number(/^\s*([\d.]+)\s*(px)?\s*$/.exec(new RegExp(`<svg[^>]*\\s${n}="([^"]+)"`).exec(head)?.[1] ?? "")?.[1] ?? NaN);
      const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(head);
      const nw = dim("width") || (vb ? Number(vb[1]) : 300);
      const nh = dim("height") || (vb ? Number(vb[2]) : 150);
      const size = px ?? { w: Math.min(2048, nw * 2), h: Math.min(2048, nw * 2) * (nh / nw) };
      const canvas = await svgToCanvas(bytes, size.w, size.h);
      if (effects.length) recolour(canvas, effects, cc, phClr);
      const img = await this.doc.embedPng(await canvasToBytes(canvas, "image/png"));
      return { img, w: (nw * 72) / 96, h: (nh * 72) / 96, transparent: true, mask: async () => canvas };
    } catch {
      return null;
    }
  }
}

function recolour(canvas: HTMLCanvasElement, effects: El[], cc: ColorCtx, phClr?: string) {
  const ctx = canvas.getContext("2d")!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (const e of effects) {
    switch (e.localName) {
      case "grayscl":
        for (let i = 0; i < px.length; i += 4) {
          const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          px[i] = px[i + 1] = px[i + 2] = y;
        }
        break;
      case "biLevel": {
        const t = (num(attr(e, "thresh"), 50000) / 100000) * 255;
        for (let i = 0; i < px.length; i += 4) {
          const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
          px[i] = px[i + 1] = px[i + 2] = y >= t ? 255 : 0;
        }
        break;
      }
      case "duotone": {
        const cols = Array.from(e.children)
          .map((c) => {
            const wrap = e.ownerDocument.createElementNS(e.namespaceURI, "w");
            wrap.appendChild(c.cloneNode(true));
            return colorIn(wrap, cc, phClr);
          })
          .filter(Boolean) as { hex: string }[];
        if (cols.length < 2) break;
        const a = [0, 2, 4].map((k) => parseInt(cols[0].hex.slice(k, k + 2), 16));
        const b = [0, 2, 4].map((k) => parseInt(cols[1].hex.slice(k, k + 2), 16));
        for (let i = 0; i < px.length; i += 4) {
          const t = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
          for (let k = 0; k < 3; k++) px[i + k] = a[k] + (b[k] - a[k]) * t;
        }
        break;
      }
      case "lum": {
        const bright = num(attr(e, "bright")) / 100000;
        const contrast = num(attr(e, "contrast")) / 100000;
        const k = contrast >= 0 ? 1 / Math.max(0.01, 1 - contrast) : 1 + contrast;
        for (let i = 0; i < px.length; i += 4)
          for (let c = 0; c < 3; c++) {
            let v = px[i + c] / 255;
            v = (v - 0.5) * k + 0.5 + bright;
            px[i + c] = Math.max(0, Math.min(255, v * 255));
          }
        break;
      }
      case "clrChange": {
        const from = colorIn(kid(e, "clrFrom"), cc);
        const to = colorIn(kid(e, "clrTo"), cc);
        if (!from) break;
        const f = [0, 2, 4].map((k) => parseInt(from.hex.slice(k, k + 2), 16));
        const t = to ? [0, 2, 4].map((k) => parseInt(to.hex.slice(k, k + 2), 16)) : f;
        const ta = to ? Math.round(to.alpha * 255) : 0;
        for (let i = 0; i < px.length; i += 4) {
          if (Math.abs(px[i] - f[0]) < 8 && Math.abs(px[i + 1] - f[1]) < 8 && Math.abs(px[i + 2] - f[2]) < 8) {
            px[i] = t[0];
            px[i + 1] = t[1];
            px[i + 2] = t[2];
            px[i + 3] = ta;
          }
        }
        break;
      }
    }
  }
  ctx.putImageData(data, 0, 0);
}
