/**
 * Compression that keeps the document a document: images are downsampled to
 * a target resolution based on how large they are actually drawn, re-encoded
 * only when that makes them smaller, duplicate images are merged, unused
 * objects are dropped and everything is packed into object streams. Text,
 * vectors, links, bookmarks and forms are untouched.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from "@cantoo/pdf-lib";
import { zlibSync } from "fflate";
import { canvasToBytes, newDoc, pdfOut, saveDoc, stem, tick, type OutFile, type PDFDocument, type ProgressFn } from "./core";
import { imageDisplaySizes } from "./contentstream";
import { pageFrame } from "./geometry";
import { open, type Src } from "./pages";
import { decodePixels, jpegBytes, listImages, pixelsToCanvas, type ImgObj } from "./pdfimages";
import { renderPage, withPdfjs } from "./pdfjs";

export type CompressLevel = "lossless" | "recommended" | "strong" | "extreme";

const PRESETS: Record<Exclude<CompressLevel, "extreme">, { dpi: number; quality: number } | null> = {
  lossless: null,
  recommended: { dpi: 150, quality: 0.72 },
  strong: { dpi: 100, quality: 0.55 },
};

export type CompressOpts = { level: CompressLevel; dpi?: number; quality?: number; grayscale?: boolean };

export async function compressPdf(src: Src, o: CompressOpts, onProgress?: ProgressFn): Promise<OutFile> {
  const before = src.bytes.byteLength;
  if (o.level === "extreme") return rasterCompress(src, o, onProgress);
  const doc = await open(src);
  const preset = PRESETS[o.level];
  const dpi = o.dpi ?? preset?.dpi;
  const quality = o.quality ?? preset?.quality ?? 0.75;
  let recoded = 0;
  if (dpi || o.grayscale) recoded = await recodeImages(doc, { dpi: dpi ?? 300, quality, grayscale: !!o.grayscale }, onProgress);
  const merged = dedupeStreams(doc);
  deflateLooseStreams(doc);
  removeUnused(doc);
  doc.catalog.delete(PDFName.of("PieceInfo"));
  for (const p of doc.getPages()) {
    p.node.delete(PDFName.of("Thumb"));
    p.node.delete(PDFName.of("PieceInfo"));
  }
  let bytes = await saveDoc(doc, { objectStreams: true });
  let note: string;
  if (bytes.byteLength >= before) {
    bytes = src.bytes;
    note = "Already well compressed. Returned unchanged; try a stronger level.";
  } else {
    const pct = Math.round((1 - bytes.byteLength / before) * 100);
    note = `${pct}% smaller${recoded ? ` · ${recoded} image${recoded === 1 ? "" : "s"} optimised` : ""}${merged ? ` · ${merged} duplicate${merged === 1 ? "" : "s"} merged` : ""}`;
  }
  return pdfOut(`${stem(src.name)}-compressed.pdf`, bytes, note);
}

async function recodeImages(doc: PDFDocument, o: { dpi: number; quality: number; grayscale: boolean }, onProgress?: ProgressFn): Promise<number> {
  const sizes = imageDisplaySizes(doc);
  const images = listImages(doc).filter((im) => !im.isMask && !im.usedAsMask && im.width * im.height > 64 * 64);
  let done = 0;
  for (let k = 0; k < images.length; k++) {
    const im = images[k];
    onProgress?.(k / Math.max(1, images.length), `Optimising image ${k + 1} of ${images.length}`);
    try {
      if (await recodeOne(doc, im, sizes.get(im.ref.toString()), o)) done++;
    } catch {
      /* leave this image as it was */
    }
    if (k % 3 === 2) await tick();
  }
  return done;
}

async function recodeOne(doc: PDFDocument, im: ImgObj, shown: { w: number; h: number } | undefined, o: { dpi: number; quality: number; grayscale: boolean }): Promise<boolean> {
  // Target pixel size from the displayed size (or the page size if we never saw it drawn).
  const fallback = doc.getPageCount() ? pageFrame(doc.getPage(0)) : { width: 595, height: 842 };
  const dispW = shown?.w || Math.min(fallback.width, (im.width / Math.max(im.width, im.height)) * Math.max(fallback.width, fallback.height));
  const dispH = shown?.h || (dispW * im.height) / im.width;
  const maxW = Math.max(16, Math.round((dispW / 72) * o.dpi));
  const maxH = Math.max(16, Math.round((dispH / 72) * o.dpi));
  const scale = Math.min(1, maxW / im.width, maxH / im.height);
  const jpeg = jpegBytes(im);
  const isCmyk = im.colorSpace.kind === "cmyk" || (im.colorSpace.kind === "indexed" && im.colorSpace.base.kind === "cmyk");
  const needsResize = scale < 0.87;
  // At the right size already: JPEGs may still shrink at a lower quality; lossless
  // images are only worth touching when they are photos stored without JPEG.
  if (!needsResize && !o.grayscale && !jpeg && !looksPhotographic(doc, im)) return false;
  if (jpeg && isCmyk) return false; // browsers decode CMYK JPEGs inconsistently
  let canvas: HTMLCanvasElement;
  if (jpeg) {
    const bmp = await createImageBitmap(new Blob([jpeg.slice()], { type: "image/jpeg" }));
    canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
  } else {
    const px = decodePixels(doc, im);
    if (!px) return false;
    if (im.smask) {
      // Keep transparency: decode carried alpha; drop it again (the SMask stays attached).
      for (let i = 3; i < px.data.length; i += 4) px.data[i] = 255;
    }
    canvas = pixelsToCanvas(px);
  }
  const tw = Math.max(1, Math.round(im.width * scale));
  const th = Math.max(1, Math.round(im.height * scale));
  let out = canvas;
  if (tw !== canvas.width || th !== canvas.height) out = downscale(canvas, tw, th);
  const gray = o.grayscale || im.colorSpace.kind === "gray" || (im.colorSpace.kind === "indexed" && im.colorSpace.base.kind === "gray");
  if (o.grayscale) toGray(out);
  const fewColors = !jpeg && !looksPhotographic(doc, im);
  let data: Uint8Array;
  let filter: string;
  if (fewColors) {
    data = zlibSync(rgbBytes(out, gray), { level: 9 });
    filter = "FlateDecode";
  } else {
    data = await canvasToBytes(out, "image/jpeg", o.quality);
    filter = "DCTDecode";
  }
  if (data.byteLength >= im.stream.contents.byteLength * 0.92) return false;
  const dict = doc.context.obj({
    Type: "XObject",
    Subtype: "Image",
    Width: tw,
    Height: th,
    ColorSpace: gray && filter === "FlateDecode" ? "DeviceGray" : "DeviceRGB",
    BitsPerComponent: 8,
    Filter: filter,
    Length: data.byteLength,
  }) as PDFDict;
  for (const keep of ["SMask", "Interpolate", "Intent", "Mask"]) {
    const v = im.stream.dict.get(PDFName.of(keep));
    if (v) dict.set(PDFName.of(keep), v);
  }
  doc.context.assign(im.ref, PDFRawStream.of(dict, data));
  return true;
}

function looksPhotographic(doc: PDFDocument, im: ImgObj): boolean {
  if (jpegBytes(im)) return true;
  if (im.bpc < 8 || im.colorSpace.kind === "indexed") return false;
  const px = decodePixels(doc, { ...im, smask: undefined });
  if (!px) return false;
  const seen = new Set<number>();
  const step = Math.max(1, Math.floor(px.data.length / 4 / 6000));
  for (let i = 0; i < px.data.length; i += 4 * step) {
    seen.add((px.data[i] >> 3) * 1024 + (px.data[i + 1] >> 3) * 32 + (px.data[i + 2] >> 3));
    if (seen.size > 600) return true;
  }
  return false;
}

function downscale(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  // Halve repeatedly for quality, then finish with one smooth step.
  let cur = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const half = document.createElement("canvas");
    half.width = Math.max(1, Math.floor(cur.width / 2));
    half.height = Math.max(1, Math.floor(cur.height / 2));
    const g = half.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const g = out.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(cur, 0, 0, w, h);
  return out;
}

function toGray(c: HTMLCanvasElement) {
  const g = c.getContext("2d")!;
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  g.putImageData(img, 0, 0);
}

function rgbBytes(c: HTMLCanvasElement, gray: boolean): Uint8Array {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  const n = c.width * c.height;
  const out = new Uint8Array(n * (gray ? 1 : 3));
  for (let i = 0, o = 0; i < n; i++) {
    if (gray) out[o++] = d[i * 4];
    else {
      out[o++] = d[i * 4];
      out[o++] = d[i * 4 + 1];
      out[o++] = d[i * 4 + 2];
    }
  }
  return out;
}

/** Point every reference to an identical stream at a single copy. */
function dedupeStreams(doc: PDFDocument): number {
  const ctx = doc.context;
  const byHash = new Map<string, PDFRef>();
  const remap = new Map<string, PDFRef>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const sub = obj.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
    if (sub !== "/Image") continue;
    const c = obj.contents;
    if (c.length < 2048) continue;
    let h = 2166136261;
    const step = Math.max(1, Math.floor(c.length / 4096));
    for (let i = 0; i < c.length; i += step) h = Math.imul(h ^ c[i], 16777619);
    const key = `${c.length}:${h >>> 0}:${obj.dict.toString().length}`;
    const prev = byHash.get(key);
    if (prev) {
      const p = ctx.lookup(prev) as PDFRawStream;
      if (p.contents.length === c.length && p.contents.every((b, i) => b === c[i])) remap.set(ref.toString(), prev);
    } else byHash.set(key, ref);
  }
  if (!remap.size) return 0;
  const fix = (v: unknown): unknown => (v instanceof PDFRef && remap.has(v.toString()) ? remap.get(v.toString()) : v);
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream || obj instanceof PDFRawStream ? obj.dict : null;
    if (!dict) continue;
    const xo = dict.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (xo) for (const k of xo.keys()) xo.set(k, fix(xo.get(k)) as PDFRef);
    const res = dict.lookupMaybe(PDFName.of("Resources"), PDFDict);
    const rxo = res?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (rxo) for (const k of rxo.keys()) rxo.set(k, fix(rxo.get(k)) as PDFRef);
  }
  for (const k of remap.keys()) {
    const [num, gen] = k.split(" ").map(Number);
    ctx.delete(PDFRef.of(num, gen));
  }
  return remap.size;
}

/** Flate-compress streams stored without any filter (common in naive generators). */
function deflateLooseStreams(doc: PDFDocument) {
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.has(PDFName.of("Filter")) || obj.contents.length < 512) continue;
    const t = obj.dict.lookupMaybe(PDFName.of("Type"), PDFName)?.asString();
    if (t === "/XRef" || t === "/ObjStm" || t === "/Metadata") continue;
    const packed = zlibSync(obj.contents, { level: 9 });
    if (packed.length < obj.contents.length * 0.9) {
      const dict = obj.dict.clone(ctx);
      dict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
      dict.set(PDFName.of("Length"), PDFNumber.of(packed.length));
      dict.delete(PDFName.of("DecodeParms"));
      ctx.assign(ref, PDFRawStream.of(dict, packed));
    }
  }
}

/** Drop objects nothing points at any more (after replacing or merging). */
export function removeUnused(doc: PDFDocument) {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: unknown[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt].filter(Boolean);
  while (stack.length) {
    const v = stack.pop();
    if (v instanceof PDFRef) {
      const k = v.toString();
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push(ctx.lookup(v));
    } else if (v instanceof PDFDict) {
      for (const val of v.values()) stack.push(val);
    } else if (v instanceof PDFArray) {
      for (let i = 0; i < v.size(); i++) stack.push(v.get(i));
    } else if (v instanceof PDFRawStream || v instanceof PDFStream) {
      stack.push(v.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) ctx.delete(ref);
}

/** Last resort: every page becomes a compressed picture. Text is no longer selectable. */
async function rasterCompress(src: Src, o: CompressOpts, onProgress?: ProgressFn): Promise<OutFile> {
  const doc = await open(src);
  const out = await newDoc();
  const n = doc.getPageCount();
  const dpi = o.dpi ?? 96;
  await withPdfjs(
    src.bytes,
    async ({ pdf }) => {
      for (let i = 1; i <= n; i++) {
        onProgress?.(i / n, `Flattening page ${i} of ${n}`);
        const f = pageFrame(doc.getPage(i - 1));
        const page = await pdf.getPage(i);
        const canvas = await renderPage(page, dpi / 72);
        page.cleanup();
        if (o.grayscale) toGray(canvas);
        const jpg = await out.embedJpg(await canvasToBytes(canvas, "image/jpeg", o.quality ?? 0.5));
        const np = out.addPage([f.width, f.height]);
        np.drawImage(jpg, { x: 0, y: 0, width: f.width, height: f.height });
        canvas.width = canvas.height = 0;
        await tick();
      }
    },
    src.password,
  );
  const bytes = await saveDoc(out);
  const pct = Math.round((1 - bytes.byteLength / src.bytes.byteLength) * 100);
  return pdfOut(`${stem(src.name)}-compressed.pdf`, bytes, pct > 0 ? `${pct}% smaller · pages flattened to images` : "Flattening made it larger; use another level.");
}
