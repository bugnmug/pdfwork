/** Read image XObjects straight out of the PDF (original quality, no re-render). */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, PDFHexString, decodePDFRawStream } from "@cantoo/pdf-lib";
import { unzlibSync } from "fflate";
import type { PDFDocument } from "./core";

export type ImgObj = {
  ref: PDFRef;
  stream: PDFRawStream;
  width: number;
  height: number;
  bpc: number;
  filters: string[];
  colorSpace: ColorSpace;
  smask?: PDFRef;
  isMask: boolean;
  usedAsMask: boolean;
};

export type ColorSpace =
  | { kind: "gray" | "rgb" | "cmyk"; n: 1 | 3 | 4 }
  | { kind: "indexed"; base: ColorSpace; hival: number; lookup: Uint8Array<ArrayBufferLike>; n: 1 }
  | { kind: "unsupported"; n: number; name: string };

function filtersOf(dict: PDFDict): string[] {
  const f = dict.lookup(PDFName.of("Filter"));
  if (f instanceof PDFName) return [f.asString().slice(1)];
  if (f instanceof PDFArray) return Array.from({ length: f.size() }, (_, i) => (f.lookup(i) as PDFName).asString().slice(1));
  return [];
}

function resolveCS(doc: PDFDocument, cs: unknown, depth = 0): ColorSpace {
  const ctx = doc.context;
  const v = cs instanceof PDFRef ? ctx.lookup(cs) : cs;
  if (v instanceof PDFName) {
    const n = v.asString();
    if (n === "/DeviceGray" || n === "/CalGray" || n === "/G") return { kind: "gray", n: 1 };
    if (n === "/DeviceRGB" || n === "/CalRGB" || n === "/RGB") return { kind: "rgb", n: 3 };
    if (n === "/DeviceCMYK" || n === "/CMYK") return { kind: "cmyk", n: 4 };
    return { kind: "unsupported", n: 3, name: n };
  }
  if (v instanceof PDFArray && v.size() && depth < 4) {
    const head = (v.lookup(0) as PDFName).asString();
    if (head === "/ICCBased") {
      const s = v.lookup(1);
      const n = s instanceof PDFRawStream ? (s.dict.lookupMaybe(PDFName.of("N"), PDFNumber)?.asNumber() ?? 3) : 3;
      return n === 1 ? { kind: "gray", n: 1 } : n === 4 ? { kind: "cmyk", n: 4 } : { kind: "rgb", n: 3 };
    }
    if (head === "/CalRGB" || head === "/Lab") return head === "/Lab" ? { kind: "unsupported", n: 3, name: head } : { kind: "rgb", n: 3 };
    if (head === "/CalGray") return { kind: "gray", n: 1 };
    if (head === "/Indexed" || head === "/I") {
      const base = resolveCS(doc, v.get(1), depth + 1);
      const hival = (v.lookup(2) as PDFNumber).asNumber();
      const lk = v.lookup(3);
      let lookup: Uint8Array = new Uint8Array();
      if (lk instanceof PDFRawStream) lookup = decodePDFRawStream(lk).decode();
      else if (lk instanceof PDFString || lk instanceof PDFHexString) lookup = lk.asBytes();
      return { kind: "indexed", base, hival, lookup, n: 1 };
    }
    return { kind: "unsupported", n: 3, name: head };
  }
  return { kind: "rgb", n: 3 };
}

export function listImages(doc: PDFDocument): ImgObj[] {
  const out: ImgObj[] = [];
  const maskRefs = new Set<string>();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString() !== "/Image") continue;
    const sm = d.get(PDFName.of("SMask"));
    if (sm instanceof PDFRef) maskRefs.add(sm.toString());
    const mk = d.get(PDFName.of("Mask"));
    if (mk instanceof PDFRef) maskRefs.add(mk.toString());
    const isMask = d.get(PDFName.of("ImageMask"))?.toString() === "true";
    out.push({
      ref,
      stream: obj,
      width: d.lookupMaybe(PDFName.of("Width"), PDFNumber)?.asNumber() ?? 0,
      height: d.lookupMaybe(PDFName.of("Height"), PDFNumber)?.asNumber() ?? 0,
      bpc: d.lookupMaybe(PDFName.of("BitsPerComponent"), PDFNumber)?.asNumber() ?? (isMask ? 1 : 8),
      filters: filtersOf(d),
      colorSpace: isMask ? { kind: "gray", n: 1 } : resolveCS(doc, d.get(PDFName.of("ColorSpace"))),
      smask: sm instanceof PDFRef ? sm : undefined,
      isMask,
      usedAsMask: false,
    });
  }
  for (const im of out) im.usedAsMask = maskRefs.has(im.ref.toString());
  return out;
}

function unpredict(data: Uint8Array, parms: PDFDict | undefined, colors: number, bpc: number, columns: number): Uint8Array {
  const predictor = parms?.lookupMaybe(PDFName.of("Predictor"), PDFNumber)?.asNumber() ?? 1;
  if (predictor < 10) return data;
  const c = parms?.lookupMaybe(PDFName.of("Colors"), PDFNumber)?.asNumber() ?? colors;
  const b = parms?.lookupMaybe(PDFName.of("BitsPerComponent"), PDFNumber)?.asNumber() ?? bpc;
  const cols = parms?.lookupMaybe(PDFName.of("Columns"), PDFNumber)?.asNumber() ?? columns;
  const bpp = Math.max(1, Math.ceil((c * b) / 8));
  const rowLen = Math.ceil((cols * c * b) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  const prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const row = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (type === 1) v += a;
      else if (type === 2) v += up;
      else if (type === 3) v += (a + up) >> 1;
      else if (type === 4) {
        const p = a + up - ul;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      }
      row[i] = v & 0xff;
    }
    prev.set(row);
  }
  return out;
}

/** Raw sample bytes after all non-image filters (Flate/LZW/ASCII85/…). */
function rawSamples(im: ImgObj): Uint8Array | null {
  const f = im.filters;
  if (f.some((x) => ["DCTDecode", "DCT", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode", "CCF"].includes(x))) return null;
  let data: Uint8Array;
  try {
    data = decodePDFRawStream(im.stream).decode();
  } catch {
    try {
      data = f.length === 1 && f[0] === "FlateDecode" ? unzlibSync(im.stream.contents) : im.stream.contents;
    } catch {
      return null;
    }
  }
  const parms = im.stream.dict.lookupMaybe(PDFName.of("DecodeParms"), PDFDict);
  return unpredict(data, parms, im.colorSpace.n, im.bpc, im.width);
}

/** Decode an image XObject to RGBA pixels (null when the encoding is not supported in-browser). */
export function decodePixels(doc: PDFDocument, im: ImgObj): ImageData | null {
  const data = rawSamples(im);
  if (!data || !im.width || !im.height) return null;
  const { width: w, height: h, bpc } = im;
  const cs = im.colorSpace;
  if (cs.kind === "unsupported") return null;
  const out = new ImageData(w, h);
  const px = out.data;
  const comps = cs.n;
  const rowBytes = Math.ceil((w * comps * bpc) / 8);
  const decodeArr = im.stream.dict.lookupMaybe(PDFName.of("Decode"), PDFArray);
  const invert = !!decodeArr && (decodeArr.lookup(0) as PDFNumber)?.asNumber?.() === 1;
  const sample = (row: number, idx: number): number => {
    if (bpc === 8) return data[row * rowBytes + idx];
    if (bpc === 16) return data[row * rowBytes + idx * 2];
    const bit = idx * bpc;
    const byte = data[row * rowBytes + (bit >> 3)] ?? 0;
    const shift = 8 - bpc - (bit & 7);
    return (byte >> shift) & ((1 << bpc) - 1);
  };
  const scale = bpc === 16 ? 1 : 255 / ((1 << bpc) - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r: number, g: number, b: number;
      if (cs.kind === "indexed") {
        const i = Math.min(cs.hival, sample(y, x));
        const bn = cs.base.n;
        const c0 = cs.lookup[i * bn] ?? 0;
        if (cs.base.kind === "gray") r = g = b = c0;
        else if (cs.base.kind === "cmyk") [r, g, b] = cmyk(c0, cs.lookup[i * 4 + 1] ?? 0, cs.lookup[i * 4 + 2] ?? 0, cs.lookup[i * 4 + 3] ?? 0);
        else [r, g, b] = [c0, cs.lookup[i * 3 + 1] ?? 0, cs.lookup[i * 3 + 2] ?? 0];
      } else if (cs.kind === "gray") {
        let v = sample(y, x) * (bpc === 16 ? 1 : scale);
        if (invert) v = 255 - v;
        r = g = b = v;
      } else if (cs.kind === "cmyk") {
        [r, g, b] = cmyk(sample(y, x * 4) * scale, sample(y, x * 4 + 1) * scale, sample(y, x * 4 + 2) * scale, sample(y, x * 4 + 3) * scale);
      } else {
        r = sample(y, x * 3) * scale;
        g = sample(y, x * 3 + 1) * scale;
        b = sample(y, x * 3 + 2) * scale;
      }
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  }
  // Soft mask → alpha.
  if (im.smask) {
    const smObj = doc.context.lookup(im.smask);
    if (smObj instanceof PDFRawStream) {
      const sm: ImgObj = { ref: im.smask, stream: smObj, width: smObj.dict.lookupMaybe(PDFName.of("Width"), PDFNumber)?.asNumber() ?? 0, height: smObj.dict.lookupMaybe(PDFName.of("Height"), PDFNumber)?.asNumber() ?? 0, bpc: smObj.dict.lookupMaybe(PDFName.of("BitsPerComponent"), PDFNumber)?.asNumber() ?? 8, filters: filtersOf(smObj.dict), colorSpace: { kind: "gray", n: 1 }, isMask: false, usedAsMask: true };
      const a = decodePixels(doc, sm);
      if (a) {
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const sx = Math.min(a.width - 1, Math.floor((x * a.width) / w));
            const sy = Math.min(a.height - 1, Math.floor((y * a.height) / h));
            px[(y * w + x) * 4 + 3] = a.data[(sy * a.width + sx) * 4];
          }
      }
    }
  }
  return out;
}

function cmyk(c: number, m: number, y: number, k: number): [number, number, number] {
  return [255 - Math.min(255, c + k), 255 - Math.min(255, m + k), 255 - Math.min(255, y + k)];
}

export function isJpeg(im: ImgObj) {
  return im.filters.length >= 1 && ["DCTDecode", "DCT"].includes(im.filters[im.filters.length - 1]) && im.filters.slice(0, -1).every((f) => f === "FlateDecode");
}

/** JPEG bytes for DCT images (decoding any outer Flate layer). */
export function jpegBytes(im: ImgObj): Uint8Array | null {
  if (!isJpeg(im)) return null;
  if (im.filters.length === 1) return im.stream.contents;
  try {
    return unzlibSync(im.stream.contents);
  } catch {
    return null;
  }
}

export function pixelsToCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(img, 0, 0);
  return c;
}
