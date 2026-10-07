/**
 * Grayscale that stays a document. Colours are turned grey in the file itself: text, lines and
 * fills, pictures, gradients, patterns, spot colours and annotations. Text stays sharp,
 * selectable and searchable, links and bookmarks keep working, and the file stays small. A page
 * holding something that can't be converted this way (a CMYK JPEG, a JPEG 2000 picture, a mesh
 * gradient with colours inside its data) is redrawn as a grey image with its words kept as
 * invisible text.
 *
 * Grey is the colour's luminance (Rec. 709 weights, as the page images use), so a colour and
 * its grey version look equally light.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
} from "@cantoo/pdf-lib";
import { zlibSync } from "fflate";
import { encodeGrayJpeg } from "../jpeggray";
import { dropUnreferenced, parsePageList, pdfOut, saveDoc, stem, tick, type OutFile, type PDFDocument, type ProgressFn } from "./core";
import { pageContent, resourcesOf, spliced, streamBytes, tokenize, type Tok } from "./contentstream";
import { FontSet } from "./fonts";
import { open, type Src } from "./pages";
import { readFunction, sampledGray, type Fn } from "./pdffunc";
import { decodePixels, jpegBytes, listImages, type ImgObj } from "./pdfimages";
import { pageText, renderPage, withPdfjs } from "./pdfjs";
import { redrawPage } from "./raster";

const N = (s: string) => PDFName.of(s);
const look = (ctx: PDFContext, o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
const nameOf = (o: unknown) => (o instanceof PDFName ? o.decodeText() : undefined);
const numOf = (o: unknown, d = 0) => (o instanceof PDFNumber ? o.asNumber() : d);
const isStream = (o: unknown): o is PDFRawStream | PDFStream => o instanceof PDFRawStream || o instanceof PDFStream;
const fmt = (n: number) => String(Math.round(n * 10000) / 10000);

/** Rec. 709 luminance of an RGB colour (0 to 1). */
const lum = (r: number, g: number, b: number) => Math.min(1, Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b));
const cmykLum = (c: number, m: number, y: number, k: number) => lum((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));

/** A colour space as far as turning its colours grey goes. */
type Space =
  | { kind: "gray" }
  | { kind: "rgb" }
  | { kind: "cmyk" }
  | { kind: "lab"; range: number[] }
  | { kind: "indexed"; base: Space; hival: number; lookup: Uint8Array; obj: PDFArray }
  | { kind: "tint"; n: number; alt: Space; fn: Fn; obj: PDFArray }
  | { kind: "pattern"; base?: Space; obj?: PDFArray }
  | { kind: "unknown"; why: string };

class Problem extends Error {}

export class GrayConverter {
  private readonly ctx: PDFContext;
  /** Objects already turned grey (streams, colour spaces, shadings), so shared ones are done once. */
  private readonly done = new Set<unknown>();
  /** Pictures drawn by the converted content (and the pages drawing them), turned grey at the end. */
  readonly images = new Map<string, { ref: PDFRef; pages: Set<number> }>();
  /** Colour spaces as they were before any was turned grey (shared definitions change in place). */
  private readonly spaces = new Map<unknown, Space>();
  private pageNow = -1;
  constructor(private readonly doc: PDFDocument) {
    this.ctx = doc.context;
  }

  /** Classifies a colour space (a name, an array, or a resource name). */
  space(raw: unknown, res: PDFDict | undefined, depth = 0): Space {
    const ctx = this.ctx;
    const v = look(ctx, raw);
    const name = nameOf(v);
    if (name) {
      if (["DeviceGray", "G", "CalGray"].includes(name)) return { kind: "gray" };
      if (["DeviceRGB", "RGB", "CalRGB"].includes(name)) return { kind: "rgb" };
      if (["DeviceCMYK", "CMYK"].includes(name)) return { kind: "cmyk" };
      if (name === "Pattern") return { kind: "pattern" };
      const named = res ? look(ctx, (look(ctx, res.get(N("ColorSpace"))) as PDFDict | undefined)?.get?.(N(name))) : undefined;
      if (named === undefined || depth > 6) return { kind: "unknown", why: `colour space ${name}` };
      return this.space(named, res, depth + 1);
    }
    if (!(v instanceof PDFArray) || !v.size()) return { kind: "unknown", why: "colour space" };
    const known = this.spaces.get(v);
    if (known) return known;
    const s = this.arraySpace(v, res, depth);
    this.spaces.set(v, s);
    return s;
  }

  private arraySpace(v: PDFArray, res: PDFDict | undefined, depth: number): Space {
    const ctx = this.ctx;
    const head = nameOf(look(ctx, v.get(0))) ?? "";
    if (head === "ICCBased") {
      const s = look(ctx, v.get(1));
      const n = isStream(s) ? numOf(look(ctx, s.dict.get(N("N"))), 3) : 3;
      return n === 1 ? { kind: "gray" } : n === 4 ? { kind: "cmyk" } : n === 3 ? { kind: "rgb" } : { kind: "unknown", why: `ICC colour with ${n} channels` };
    }
    if (head === "CalRGB") return { kind: "rgb" };
    if (head === "CalGray") return { kind: "gray" };
    if (head === "Lab") {
      const d = look(ctx, v.get(1));
      const range = d instanceof PDFDict ? (look(ctx, d.get(N("Range"))) as PDFArray | undefined)?.asArray().map((x) => numOf(look(ctx, x))) : undefined;
      return { kind: "lab", range: range ?? [-100, 100, -100, 100] };
    }
    if (head === "Indexed" || head === "I") {
      const base = this.space(v.get(1), res, depth + 1);
      const lk = look(ctx, v.get(3));
      const lookup = lk instanceof PDFString || lk instanceof PDFHexString ? lk.asBytes() : isStream(lk) ? streamBytes(ctx, lk) : new Uint8Array();
      return { kind: "indexed", base, hival: numOf(look(ctx, v.get(2))), lookup, obj: v };
    }
    if (head === "Separation" || head === "DeviceN") {
      const names = look(ctx, v.get(1));
      const n = head === "Separation" ? 1 : names instanceof PDFArray ? names.size() : 1;
      const alt = this.space(v.get(2), res, depth + 1);
      const fn = readFunction(ctx, v.get(3));
      if (!fn) return { kind: "unknown", why: "spot colour" };
      return { kind: "tint", n, alt, fn, obj: v };
    }
    if (head === "Pattern") return { kind: "pattern", base: v.size() > 1 ? this.space(v.get(1), res, depth + 1) : undefined, obj: v };
    return { kind: "unknown", why: `colour space ${head}` };
  }

  /** How many components a colour in the space has. */
  private comps(s: Space): number {
    return s.kind === "gray" || s.kind === "indexed" ? 1 : s.kind === "rgb" || s.kind === "lab" ? 3 : s.kind === "cmyk" ? 4 : s.kind === "tint" ? s.n : 0;
  }

  /** The grey (0 to 1) of a colour in a space. */
  gray(s: Space, c: number[]): number {
    switch (s.kind) {
      case "gray":
        return c[0] ?? 0;
      case "rgb":
        return lum(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
      case "cmyk":
        return cmykLum(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 0);
      case "lab":
        return Math.min(1, Math.max(0, (c[0] ?? 0) / 100));
      case "indexed": {
        const i = Math.max(0, Math.min(s.hival, Math.round(c[0] ?? 0)));
        const n = this.comps(s.base);
        return this.gray(s.base, Array.from({ length: n }, (_, k) => (s.lookup[i * n + k] ?? 0) / 255));
      }
      case "tint":
        return this.gray(s.alt, s.fn(c));
      default:
        throw new Problem(s.kind === "unknown" ? s.why : "pattern colour");
    }
  }

  /**
   * Turns an indexed or spot colour space grey where it is defined, so colours given in it (and
   * pictures stored in it) come out grey without touching them.
   */
  private convertSpace(s: Space) {
    if (this.done.has((s as { obj?: unknown }).obj)) return;
    const ctx = this.ctx;
    if (s.kind === "indexed") {
      this.done.add(s.obj);
      const grey = new Uint8Array(s.hival + 1);
      for (let i = 0; i <= s.hival; i++) grey[i] = Math.round(this.gray(s, [i]) * 255);
      s.obj.set(1, N("DeviceGray"));
      s.obj.set(3, PDFHexString.of(Array.from(grey, (b) => b.toString(16).padStart(2, "0")).join("")));
    } else if (s.kind === "tint") {
      this.done.add(s.obj);
      const domain = new Array(s.n).fill(0).flatMap(() => [0, 1]);
      s.obj.set(2, N("DeviceGray"));
      s.obj.set(3, sampledGray(ctx, s.n, domain, (x) => this.gray(s, x)));
    } else if (s.kind === "pattern" && s.obj && s.base && s.base.kind !== "gray") {
      this.done.add(s.obj);
      if (s.base.kind === "indexed" || s.base.kind === "tint") this.convertSpace(s.base);
      else s.obj.set(1, N("DeviceGray"));
    }
  }

  /** Turns a shading grey where it is defined (its colour space and function). */
  private shading(raw: unknown, res: PDFDict | undefined) {
    const sh = look(this.ctx, raw);
    if (this.done.has(sh)) return;
    this.done.add(sh);
    const dict = isStream(sh) ? sh.dict : sh instanceof PDFDict ? sh : null;
    if (!dict) return;
    const cs = this.space(dict.get(N("ColorSpace")), res);
    if (cs.kind === "gray") return;
    const type = numOf(look(this.ctx, dict.get(N("ShadingType"))));
    const fnRaw = dict.get(N("Function"));
    if (!fnRaw) throw new Problem("a gradient with its colours in its data");
    const fn = readFunction(this.ctx, fnRaw);
    if (!fn) throw new Problem("a gradient's colour function");
    const nums = (k: string, d: number[]) => (look(this.ctx, dict.get(N(k))) as PDFArray | undefined)?.asArray().map((x) => numOf(look(this.ctx, x))) ?? d;
    if (type === 1) {
      const domain = nums("Domain", [0, 1, 0, 1]);
      dict.set(N("Function"), sampledGray(this.ctx, 2, domain, (x) => this.gray(cs, fn(x))));
    } else {
      // Axial, radial and meshes with a parametric function: one input, t.
      const fnDict = (o: unknown): PDFDict | undefined => {
        const v = look(this.ctx, o);
        return v instanceof PDFDict ? v : isStream(v) ? v.dict : v instanceof PDFArray ? fnDict(v.get(0)) : undefined;
      };
      const own = (look(this.ctx, fnDict(fnRaw)?.get(N("Domain"))) as PDFArray | undefined)?.asArray().map((x) => numOf(look(this.ctx, x)));
      const domain = type === 2 || type === 3 ? nums("Domain", [0, 1]) : (own ?? [0, 1]);
      dict.set(N("Function"), sampledGray(this.ctx, 1, domain.slice(0, 2), (x) => this.gray(cs, fn(x))));
    }
    const bg = nums("Background", []);
    if (bg.length) dict.set(N("Background"), this.ctx.obj([this.gray(cs, bg)]));
    dict.set(N("ColorSpace"), N("DeviceGray"));
  }

  /** Every colour-bearing thing a resource dictionary lists (forms and patterns are visited when drawn). */
  private resources(res: PDFDict | undefined) {
    if (!res || this.done.has(res)) return;
    this.done.add(res);
    const ctx = this.ctx;
    const dictOf = (k: string) => look(ctx, res.get(N(k))) as PDFDict | undefined;
    const cs = dictOf("ColorSpace");
    if (cs instanceof PDFDict)
      for (const [, v] of cs.entries()) {
        const s = this.space(v, res);
        if (s.kind === "indexed" || s.kind === "tint" || s.kind === "pattern") this.convertSpace(s);
      }
    const sh = dictOf("Shading");
    if (sh instanceof PDFDict) for (const [, v] of sh.entries()) this.shading(v, res);
    const pats = dictOf("Pattern");
    if (pats instanceof PDFDict)
      for (const [, v] of pats.entries()) {
        const p = look(ctx, v);
        if (isStream(p)) this.stream(v, resourcesOf(p.dict, ctx) ?? res);
        else if (p instanceof PDFDict) this.shading(p.get(N("Shading")), res);
      }
    const gs = dictOf("ExtGState");
    if (gs instanceof PDFDict)
      for (const [, v] of gs.entries()) {
        const g = look(ctx, v);
        const sm = g instanceof PDFDict ? look(ctx, g.get(N("SMask"))) : undefined;
        if (sm instanceof PDFDict && sm.get(N("G"))) {
          const grp = look(ctx, sm.get(N("G")));
          if (isStream(grp)) this.stream(sm.get(N("G")), resourcesOf(grp.dict, ctx) ?? res);
        }
      }
    const fonts = dictOf("Font");
    if (fonts instanceof PDFDict)
      for (const [, v] of fonts.entries()) {
        const f = look(ctx, v);
        if (!(f instanceof PDFDict) || nameOf(look(ctx, f.get(N("Subtype")))) !== "Type3") continue;
        const procs = look(ctx, f.get(N("CharProcs")));
        if (procs instanceof PDFDict) for (const [, p] of procs.entries()) this.stream(p, resourcesOf(f, ctx) ?? res);
      }
  }

  /** Turns the colours drawn by one content stream (a form, pattern, glyph or appearance) grey. */
  stream(raw: unknown, res: PDFDict | undefined) {
    const s = look(this.ctx, raw);
    if (!isStream(s) || this.done.has(s)) return;
    this.done.add(s);
    const own = resourcesOf(s.dict, this.ctx) ?? res;
    const bytes = streamBytes(this.ctx, s);
    const out = this.content(bytes, own);
    if (out && raw instanceof PDFRef) {
      const fresh = this.ctx.flateStream(out);
      for (const [k, v] of s.dict.entries()) if (!["Filter", "DecodeParms", "Length"].includes(k.decodeText())) fresh.dict.set(k, v);
      this.ctx.assign(raw, fresh);
    }
  }

  /** The content with its colour operators made grey; null when nothing changed. */
  content(bytes: Uint8Array, res: PDFDict | undefined): Uint8Array | null {
    this.resources(res);
    const ctx = this.ctx;
    const toks: Tok[] = tokenize(bytes);
    const edits: { s: number; e: number; text: string }[] = [];
    type St = { fill: Space; stroke: Space };
    const gray: Space = { kind: "gray" };
    let st: St = { fill: gray, stroke: gray };
    const stack: St[] = [];
    const xo = res ? (look(ctx, res.get(N("XObject"))) as PDFDict | undefined) : undefined;
    let from = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === "inline") {
        const head = new TextDecoder("latin1").decode(bytes.subarray(t.s, Math.min(t.e, t.s + 300)));
        const csm = /\/(?:CS|ColorSpace)\s*\/(\w+)/.exec(head);
        if (csm && !/^(G|DeviceGray|CalGray)$/.test(csm[1]) && !/\/(IM|ImageMask)\s+true/.test(head)) throw new Problem("a picture stored in the page's content");
        from = i + 1;
        continue;
      }
      if (t.t !== "op") continue;
      const ops = toks.slice(from, i);
      const start = toks[from]?.s ?? t.s;
      from = i + 1;
      const nums = ops.filter((x) => x.t === "num").map((x) => Number(x.v));
      const lastName = [...ops].reverse().find((x) => x.t === "name")?.v;
      const stroking = t.v === t.v.toUpperCase() && t.v !== "sh" && t.v !== "Do";
      switch (t.v) {
        case "q":
          stack.push({ ...st });
          break;
        case "Q":
          st = stack.pop() ?? { fill: gray, stroke: gray };
          break;
        case "g":
        case "G":
          st = stroking ? { ...st, stroke: gray } : { ...st, fill: gray };
          break;
        case "rg":
        case "RG":
          if (nums.length >= 3) edits.push({ s: start, e: t.e, text: `${fmt(lum(nums[0], nums[1], nums[2]))} ${stroking ? "G" : "g"}` });
          st = stroking ? { ...st, stroke: gray } : { ...st, fill: gray };
          break;
        case "k":
        case "K":
          if (nums.length >= 4) edits.push({ s: start, e: t.e, text: `${fmt(cmykLum(nums[0], nums[1], nums[2], nums[3]))} ${stroking ? "G" : "g"}` });
          st = stroking ? { ...st, stroke: gray } : { ...st, fill: gray };
          break;
        case "cs":
        case "CS": {
          if (!lastName) break;
          const sp = this.space(PDFName.of(lastName), res);
          if (sp.kind === "unknown") throw new Problem(sp.why);
          if (sp.kind === "indexed" || sp.kind === "tint" || sp.kind === "pattern") this.convertSpace(sp);
          else if (sp.kind !== "gray") edits.push({ s: start, e: t.e, text: `/DeviceGray ${t.v}` });
          st = stroking ? { ...st, stroke: sp } : { ...st, fill: sp };
          break;
        }
        case "sc":
        case "scn":
        case "SC":
        case "SCN": {
          const sp = stroking ? st.stroke : st.fill;
          if (sp.kind === "rgb" || sp.kind === "cmyk" || sp.kind === "lab") {
            edits.push({ s: start, e: t.e, text: `${fmt(this.gray(sp, nums))} ${t.v}` });
          } else if (sp.kind === "pattern" && sp.base && (sp.base.kind === "rgb" || sp.base.kind === "cmyk" || sp.base.kind === "lab") && nums.length && lastName) {
            edits.push({ s: start, e: t.e, text: `${fmt(this.gray(sp.base, nums))} /${lastName} ${t.v}` });
          }
          if (sp.kind === "pattern" && lastName) {
            const pats = res ? (look(ctx, res.get(N("Pattern"))) as PDFDict | undefined) : undefined;
            const pr = pats?.get?.(N(lastName));
            const p = look(ctx, pr);
            if (isStream(p)) this.stream(pr, resourcesOf(p.dict, ctx) ?? res);
            else if (p instanceof PDFDict) this.shading(p.get(N("Shading")), res);
          }
          break;
        }
        case "sh": {
          const shs = res ? (look(ctx, res.get(N("Shading"))) as PDFDict | undefined) : undefined;
          if (lastName && shs) this.shading(shs.get(N(lastName)), res);
          break;
        }
        case "Do": {
          if (!lastName || !xo) break;
          const ref = xo.get(N(lastName));
          const x = look(ctx, ref);
          if (!isStream(x)) break;
          const sub = nameOf(look(ctx, x.dict.get(N("Subtype"))));
          if (sub === "Form") this.stream(ref, resourcesOf(x.dict, ctx) ?? res);
          else if (sub === "Image" && ref instanceof PDFRef) {
            const e = this.images.get(ref.toString()) ?? { ref, pages: new Set<number>() };
            e.pages.add(this.pageNow);
            this.images.set(ref.toString(), e);
          }
          break;
        }
      }
    }
    return edits.length ? spliced(bytes, edits) : null;
  }

  /** A page: its content (as one stream), its resources and its annotations. */
  page(index: number) {
    this.pageNow = index;
    const page = this.doc.getPage(index);
    const ctx = this.ctx;
    const res = resourcesOf(page.node, ctx) ?? (page.node.Resources() as PDFDict | undefined);
    const bytes = pageContent(this.doc, index);
    const out = this.content(bytes, res);
    if (out) page.node.set(N("Contents"), ctx.register(ctx.flateStream(out)));
    for (const r of page.node.lookupMaybe(N("Annots"), PDFArray)?.asArray() ?? []) {
      const a = look(ctx, r);
      if (!(a instanceof PDFDict)) continue;
      // Colour entries: the annotation's colour, its interior, a field's border and background.
      const greyArray = (d: PDFDict, k: string) => {
        const arr = look(ctx, d.get(N(k)));
        if (!(arr instanceof PDFArray) || ![3, 4].includes(arr.size())) return;
        const c = arr.asArray().map((v) => numOf(look(ctx, v)));
        d.set(N(k), ctx.obj([c.length === 3 ? lum(c[0], c[1], c[2]) : cmykLum(c[0], c[1], c[2], c[3])]));
      };
      greyArray(a, "C");
      greyArray(a, "IC");
      const mk = look(ctx, a.get(N("MK")));
      if (mk instanceof PDFDict) {
        greyArray(mk, "BG");
        greyArray(mk, "BC");
      }
      const ap = look(ctx, a.get(N("AP")));
      if (!(ap instanceof PDFDict)) continue;
      for (const k of ["N", "R", "D"]) {
        const v = ap.get(N(k));
        const vv = look(ctx, v);
        if (isStream(vv)) this.stream(v, res);
        else if (vv instanceof PDFDict) for (const [, sref] of vv.entries()) this.stream(sref, res);
      }
    }
  }

  /** Turns the pictures the converted content draws grey; returns the pages drawing one that couldn't be, and why. */
  async picturesToGray(onPicture?: (k: number, n: number) => void): Promise<Map<number, string>> {
    const all = new Map(listImages(this.doc).map((im) => [im.ref.toString(), im]));
    const list = [...this.images.values()];
    const failed = new Map<number, string>();
    let k = 0;
    for (const { ref, pages } of list) {
      onPicture?.(k++, list.length);
      const im = all.get(ref.toString());
      if (!im) continue;
      try {
        await this.picture(im);
      } catch (e) {
        if (!(e instanceof Problem)) throw e;
        for (const p of pages) failed.set(p, e.message);
      }
      if (k % 3 === 0) await tick();
    }
    return failed;
  }

  private async picture(im: ImgObj) {
    const ctx = this.ctx;
    if (im.isMask || this.done.has(im.ref.toString())) return;
    this.done.add(im.ref.toString());
    const raw = im.stream.dict.get(N("ColorSpace"));
    const sp = raw ? this.space(raw, undefined) : ({ kind: "gray" } as Space);
    if (sp.kind === "gray") return;
    // Indexed and spot-colour pictures: their colour space turns grey, the samples stay.
    if (sp.kind === "indexed" || sp.kind === "tint") {
      this.convertSpace(sp);
      return;
    }
    if (sp.kind === "unknown" || sp.kind === "pattern") throw new Problem(sp.kind === "unknown" ? sp.why : "a picture's colours");
    if (im.stream.dict.get(N("Mask")) instanceof PDFArray) throw new Problem("a picture with a colour-key mask");
    const jpeg = jpegBytes(im);
    if (jpeg && sp.kind === "cmyk") throw new Problem("a CMYK JPEG picture");
    if (sp.kind === "lab") throw new Problem("a Lab picture");
    let pixels: ImageData | null;
    if (jpeg) {
      const bmp = await createImageBitmap(new Blob([jpeg.slice()], { type: "image/jpeg" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(bmp, 0, 0);
      bmp.close();
      pixels = g.getImageData(0, 0, c.width, c.height);
      c.width = c.height = 0;
    } else pixels = decodePixels(this.doc, { ...im, smask: undefined });
    if (!pixels) throw new Problem("a picture in a format that can't be read here (JPEG 2000, JBIG2 or CCITT)");
    const n = pixels.width * pixels.height;
    const grey = new Uint8Array(n);
    const d = pixels.data;
    for (let i = 0; i < n; i++) grey[i] = Math.round(255 * lum(d[i * 4] / 255, d[i * 4 + 1] / 255, d[i * 4 + 2] / 255));
    // Photos as grey JPEG, drawings and screenshots without loss.
    const data = jpeg ? encodeGrayJpeg(grey, pixels.width, pixels.height, 88) : zlibSync(grey, { level: 9 });
    const dict = ctx.obj({ Type: "XObject", Subtype: "Image", Width: pixels.width, Height: pixels.height, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: jpeg ? "DCTDecode" : "FlateDecode", Length: data.byteLength }) as PDFDict;
    for (const keep of ["SMask", "Intent", "Interpolate", "Mask", "Metadata", "OC", "StructParent"]) {
      const v = im.stream.dict.get(N(keep));
      if (v) dict.set(N(keep), v);
    }
    ctx.assign(im.ref, PDFRawStream.of(dict, data));
  }
}

/** Grayscale: the selected pages turned grey in place (see the module's comment). */
export async function grayscalePdf(src: Src, o: { pages?: string } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const doc = await open(src);
  const n = doc.getPageCount();
  const pages = parsePageList(o.pages || "all", n);
  const conv = new GrayConverter(doc);
  // Everything a page draws with is shared with the pages left in colour only when all pages
  // are converted; a page whose resources others share is redrawn instead when only some are.
  const redraw = new Map<number, string>();
  const partial = pages.length < n;
  const shared = partial ? sharedResources(doc, new Set(pages)) : new Set<number>();
  for (const i of pages) {
    onProgress?.((0.5 * pages.indexOf(i)) / pages.length, `Page ${i + 1} of ${n}`);
    if (shared.has(i)) {
      redraw.set(i, "shared");
      continue;
    }
    try {
      conv.page(i);
    } catch (e) {
      if (!(e instanceof Problem)) throw e;
      redraw.set(i, e.message);
    }
  }
  // A picture that can't be converted: the pages that draw it are redrawn.
  const failed = await conv.picturesToGray((k, total) => onProgress?.(0.5 + (0.3 * k) / Math.max(1, total), `Picture ${k + 1} of ${total}`));
  for (const [i, why] of failed) if (!redraw.has(i)) redraw.set(i, why);
  if (redraw.size) {
    const fonts = new FontSet(doc);
    await withPdfjs(
      src.bytes,
      async ({ pdf }) => {
        let k = 0;
        for (const i of redraw.keys()) {
          onProgress?.(0.8 + (0.15 * k++) / redraw.size, `Redrawing page ${i + 1}`);
          const page = await pdf.getPage(i + 1);
          const canvas = await renderPage(page, 200 / 72, { readback: true });
          const text = await pageText(page).catch(() => null);
          page.cleanup();
          const g = canvas.getContext("2d")!;
          const img = g.getImageData(0, 0, canvas.width, canvas.height);
          const d = img.data;
          for (let p = 0; p < d.length; p += 4) d[p] = d[p + 1] = d[p + 2] = Math.round(255 * lum(d[p] / 255, d[p + 1] / 255, d[p + 2] / 255));
          g.putImageData(img, 0, 0);
          await redrawPage(doc, i, canvas, text, fonts, { gray: true });
          canvas.width = canvas.height = 0;
          await tick();
        }
      },
      src.password,
    );
  }
  await dropUnreferenced(doc);
  const note = redraw.size ? `${pages.length - redraw.size} page${pages.length - redraw.size === 1 ? "" : "s"} converted as they are, ${redraw.size} redrawn as grey images with searchable text` : `${pages.length} page${pages.length === 1 ? "" : "s"} converted, text kept as text`;
  return pdfOut(`${stem(src.name)}-grayscale.pdf`, await saveDoc(doc), note);
}

/** Pages (of those selected) drawing with an object that a page left in colour also uses. */
function sharedResources(doc: PDFDocument, selected: Set<number>): Set<number> {
  const ctx = doc.context;
  const users = new Map<unknown, Set<number>>();
  // What draws colour: content, forms, pictures, colour spaces, shadings and patterns (fonts,
  // shared by every page, don't).
  const visit = (o: unknown, page: number, depth: number, seen: Set<unknown>, count = true) => {
    if (depth > 12) return;
    const v = look(ctx, o);
    if (seen.has(v)) return;
    seen.add(v);
    if (count && (v instanceof PDFArray || v instanceof PDFDict || isStream(v))) {
      const set = users.get(v) ?? new Set<number>();
      set.add(page);
      users.set(v, set);
    }
    if (v instanceof PDFDict) {
      for (const [k, x] of v.entries()) {
        const key = k.decodeText();
        // (The lists of a kind of resource are containers; what they list is what's shared.)
        if (!["Parent", "P", "Font", "ProcSet"].includes(key)) visit(x, page, depth + 1, seen, !["XObject", "ColorSpace", "Pattern", "Shading", "ExtGState"].includes(key));
      }
    } else if (v instanceof PDFArray) for (const x of v.asArray()) visit(x, page, depth + 1, seen);
    else if (isStream(v)) visit(v.dict, page, depth + 1, seen);
  };
  doc.getPages().forEach((p, i) => {
    const seen = new Set<unknown>();
    visit(p.node.get(N("Contents")), i, 0, seen);
    visit(resourcesOf(p.node, ctx) ?? p.node.Resources(), i, 0, seen, false);
  });
  const out = new Set<number>();
  for (const pages of users.values()) {
    const sel = [...pages].filter((p) => selected.has(p));
    if (sel.length && sel.length < pages.size) for (const p of sel) out.add(p);
  }
  return out;
}
