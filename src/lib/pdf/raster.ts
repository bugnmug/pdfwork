/** Pixel work: page renders, images → PDF, colour transforms. */
import {
  MM,
  appendPages,
  canvasToBytes,
  degrees,
  embedImage,
  imageToCanvas,
  newDoc,
  paperSize,
  parsePageList,
  pdfOut,
  saveDoc,
  stem,
  tick,
  type OutFile,
  type PDFDocument,
  type ProgressFn,
} from "./core";
import { pageFrame } from "./geometry";
import { open, withZip, type Src } from "./pages";
import { renderPage, withPdfjs } from "./pdfjs";

export async function pdfToImages(
  src: Src,
  o: { format?: "jpg" | "png" | "webp"; dpi?: number; quality?: number; pages?: string },
  onProgress?: ProgressFn,
): Promise<OutFile[]> {
  const fmt = o.format ?? "jpg";
  const mime = fmt === "png" ? "image/png" : fmt === "webp" ? "image/webp" : "image/jpeg";
  const scale = (o.dpi ?? 150) / 72;
  const files = await withPdfjs(
    src.bytes,
    async ({ pdf, pageCount }) => {
      const list = parsePageList(o.pages || "all", pageCount);
      const pad = String(pageCount).length;
      const out: OutFile[] = [];
      for (let k = 0; k < list.length; k++) {
        const i = list[k] + 1;
        onProgress?.(k / list.length, `Rendering page ${i} of ${pageCount}`);
        const page = await pdf.getPage(i);
        const canvas = await renderPage(page, scale);
        // The resolution it came out at (a very large page is drawn smaller, within what browsers allow).
        const dpi = (canvas.width / page.getViewport({ scale: 1 }).width) * 72;
        page.cleanup();
        const bytes = withDpi(await canvasToBytesAny(canvas, mime, o.quality ?? 0.9), mime, dpi);
        out.push({ filename: `${stem(src.name)}-page-${String(i).padStart(pad, "0")}.${fmt}`, bytes, mime, note: `${canvas.width}×${canvas.height}px` });
        canvas.width = canvas.height = 0;
        await tick();
      }
      return out;
    },
    src.password,
  );
  return withZip(files, `${stem(src.name)}-${fmt}.zip`);
}

/**
 * The image's resolution written into the file (JPEG's JFIF header, PNG's pHYs chunk), so a page
 * drawn at 300 dpi prints, and goes into Word, at the page's own size rather than 3 times it.
 */
export function withDpi(bytes: Uint8Array, mime: string, dpi: number): Uint8Array {
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  if (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // JFIF: units 1 (dots per inch), then the densities across and down.
    if (bytes[2] === 0xff && bytes[3] === 0xe0 && String.fromCharCode(...bytes.subarray(6, 11)) === "JFIF\0") {
      const out = bytes.slice();
      out[13] = 1;
      out[14] = d >> 8;
      out[15] = d & 255;
      out[16] = d >> 8;
      out[17] = d & 255;
      return out;
    }
    const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 255, d >> 8, d & 255, 0, 0]);
    const out = new Uint8Array(bytes.length + app0.length);
    out.set(bytes.subarray(0, 2));
    out.set(app0, 2);
    out.set(bytes.subarray(2), 2 + app0.length);
    return out;
  }
  if (mime === "image/png" && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    // pHYs (pixels per metre, unit 1) right after the IHDR chunk, unless there is one already.
    const ihdrEnd = 8 + 4 + 4 + 13 + 4;
    if (String.fromCharCode(...bytes.subarray(ihdrEnd + 4, ihdrEnd + 8)) === "pHYs") return bytes;
    const ppm = Math.round(d / 0.0254);
    const chunk = new Uint8Array(21);
    const v = new DataView(chunk.buffer);
    v.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4);
    v.setUint32(8, ppm);
    v.setUint32(12, ppm);
    chunk[16] = 1;
    v.setUint32(17, crc32(chunk.subarray(4, 17)));
    const out = new Uint8Array(bytes.length + chunk.length);
    out.set(bytes.subarray(0, ihdrEnd));
    out.set(chunk, ihdrEnd);
    out.set(bytes.subarray(ihdrEnd), ihdrEnd + chunk.length);
    return out;
  }
  return bytes;
}

let crcTable: Uint32Array | undefined;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of data) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function canvasToBytesAny(canvas: HTMLCanvasElement, mime: string, quality: number) {
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Encoding failed"))), mime, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

export type ImagesToPdfOpts = {
  /** "fit" = page matches each image; otherwise a paper size. */
  pageSize?: "fit" | "A4" | "A3" | "A5" | "Letter" | "Legal";
  orientation?: "auto" | "portrait" | "landscape";
  marginMm?: number;
  /** Combine all into one PDF (default) or one PDF per image. */
  separate?: boolean;
};

export async function imagesToPdf(images: { bytes: Uint8Array; mime: string; name: string }[], o: ImagesToPdfOpts = {}, onProgress?: ProgressFn): Promise<OutFile[]> {
  if (!images.length) throw new Error("Add one or more images.");
  const build = async (list: typeof images) => {
    const doc = await newDoc();
    for (let k = 0; k < list.length; k++) {
      onProgress?.(k / images.length, `Adding ${list[k].name}`);
      const meta = imageMeta(list[k].bytes);
      // A photo taken with the phone turned is stored on its side, with a note of how to turn it
      // (PDF readers don't read the note): turned or flipped ones are drawn upright; mirrored
      // ones (rare) are decoded upright instead.
      let turn = meta.orientation;
      const img = [2, 4, 5, 7].includes(turn) ? ((turn = 1), await embedUpright(doc, list[k].bytes, list[k].mime)) : await embedImage(doc, list[k].bytes, list[k].mime);
      const sideways = turn === 6 || turn === 8;
      const iw = sideways ? img.height : img.width;
      const ih = sideways ? img.width : img.height;
      const mg = (o.marginMm ?? 0) * MM;
      let page;
      let box: { x: number; y: number; w: number; h: number };
      if (!o.pageSize || o.pageSize === "fit") {
        // At the resolution the image says it has (a scan at 300 dpi comes out at its paper size);
        // otherwise 1 pixel to 1 pt at a 96 dpi feel, very large photos capped to a sane page.
        const s = meta.dpi ? 72 / meta.dpi : Math.min(1, 1440 / Math.max(iw, ih)) * 0.75;
        box = { x: mg, y: mg, w: iw * s, h: ih * s };
        page = doc.addPage([box.w + mg * 2, box.h + mg * 2]);
      } else {
        const land = o.orientation === "landscape" || (o.orientation !== "portrait" && iw > ih);
        const [pw, ph] = paperSize(o.pageSize, land);
        const s = Math.min((pw - mg * 2) / iw, (ph - mg * 2) / ih);
        box = { x: (pw - iw * s) / 2, y: (ph - ih * s) / 2, w: iw * s, h: ih * s };
        page = doc.addPage([pw, ph]);
      }
      const { x, y, w, h } = box;
      if (turn === 6) page.drawImage(img, { x, y: y + h, width: h, height: w, rotate: degrees(-90) });
      else if (turn === 8) page.drawImage(img, { x: x + w, y, width: h, height: w, rotate: degrees(90) });
      else if (turn === 3) page.drawImage(img, { x: x + w, y: y + h, width: w, height: h, rotate: degrees(180) });
      else page.drawImage(img, { x, y, width: w, height: h });
      await tick();
    }
    return saveDoc(doc);
  };
  if (o.separate) {
    const out: OutFile[] = [];
    for (const im of images) out.push(pdfOut(`${stem(im.name)}.pdf`, await build([im])));
    return withZip(out, "images-pdf.zip");
  }
  return [pdfOut(images.length === 1 ? `${stem(images[0].name)}.pdf` : "images.pdf", await build(images), `${images.length} page${images.length === 1 ? "" : "s"}`)];
}

/** An image decoded with its orientation note applied, then embedded. */
async function embedUpright(doc: PDFDocument, bytes: Uint8Array, mime: string) {
  const canvas = await imageToCanvas(bytes, mime);
  const img = await doc.embedJpg(await canvasToBytes(canvas, "image/jpeg", 0.92));
  canvas.width = canvas.height = 0;
  return img;
}

/**
 * What a photo's or scan's file says about it: how to turn it to view it (EXIF orientation, 1 =
 * as stored) and its resolution in dots per inch (JFIF or EXIF for a JPEG, pHYs for a PNG), when
 * that is a real one (100 to 1200 dpi: cameras write a meaningless 72).
 */
export function imageMeta(b: Uint8Array): { orientation: number; dpi?: number } {
  let orientation = 1;
  let dpi: number | undefined;
  const real = (d: number) => (d >= 100 && d <= 1200 ? d : undefined);
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 4 < b.length && b[i] === 0xff; ) {
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker === 0xda || marker === 0xd9) break;
      const seg = i + 4;
      if (marker === 0xe0 && String.fromCharCode(...b.subarray(seg, seg + 5)) === "JFIF\0") {
        const units = b[seg + 7];
        const x = (b[seg + 8] << 8) | b[seg + 9];
        if (units === 1) dpi ??= real(x);
        else if (units === 2) dpi ??= real(x * 2.54);
      } else if (marker === 0xe1 && String.fromCharCode(...b.subarray(seg, seg + 6)) === "Exif\0\0") {
        const t = seg + 6;
        const le = b[t] === 0x49;
        const u16 = (o: number) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
        const u32 = (o: number) => (le ? (b[t + o] | (b[t + o + 1] << 8) | (b[t + o + 2] << 16) | (b[t + o + 3] << 24)) >>> 0 : ((b[t + o] << 24) | (b[t + o + 1] << 16) | (b[t + o + 2] << 8) | b[t + o + 3]) >>> 0);
        const ifd = u32(4);
        const n = u16(ifd);
        let res: number | undefined;
        let unit = 2;
        for (let e = 0; e < n && t + ifd + 2 + e * 12 + 12 <= b.length; e++) {
          const at = ifd + 2 + e * 12;
          const tag = u16(at);
          if (tag === 0x0112) orientation = u16(at + 8) || 1;
          else if (tag === 0x0128) unit = u16(at + 8);
          else if (tag === 0x011a) {
            const off = u32(at + 8);
            const den = u32(off + 4);
            if (den) res = u32(off) / den;
          }
        }
        if (res) dpi ??= real(unit === 3 ? res * 2.54 : res);
      }
      i = seg + len - 2;
    }
  } else if (b[0] === 0x89 && b[1] === 0x50) {
    for (let i = 8; i + 12 <= b.length; ) {
      const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
      const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
      if (type === "pHYs" && b[i + 16] === 1) dpi = real((((b[i + 8] << 24) | (b[i + 9] << 16) | (b[i + 10] << 8) | b[i + 11]) >>> 0) * 0.0254);
      if (type === "IDAT" || type === "IEND") break;
      i += 12 + len;
    }
  }
  return { orientation: orientation >= 1 && orientation <= 8 ? orientation : 1, dpi };
}

type PixelFn = (d: Uint8ClampedArray) => void;

export const invertPixels: PixelFn = (d) => {
  for (let p = 0; p < d.length; p += 4) {
    d[p] = 255 - d[p];
    d[p + 1] = 255 - d[p + 1];
    d[p + 2] = 255 - d[p + 2];
  }
};

/** Invert lightness but keep hues (night mode that keeps photos looking natural). */
export const darkModePixels: PixelFn = (d) => {
  for (let p = 0; p < d.length; p += 4) {
    const r = d[p];
    const g = d[p + 1];
    const b = d[p + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const shift = 255 - max - min; // maps lightness L to 1-L, preserving chroma
    d[p] = clamp(r + shift);
    d[p + 1] = clamp(g + shift);
    d[p + 2] = clamp(b + shift);
  }
};

export const grayPixels: PixelFn = (d) => {
  for (let p = 0; p < d.length; p += 4) {
    const y = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
    d[p] = d[p + 1] = d[p + 2] = y;
  }
};

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Rebuild pages as processed images (used by invert / grayscale). */
export async function transformPages(src: Src, fn: PixelFn, suffix: string, o: { dpi?: number; pages?: string } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const doc = await open(src);
  const out = await newDoc();
  const n = doc.getPageCount();
  const selected = new Set(parsePageList(o.pages || "all", n));
  await withPdfjs(
    src.bytes,
    async ({ pdf }) => {
      for (let i = 0; i < n; i++) {
        if (!selected.has(i)) {
          await appendPages(out, doc, [i]);
          continue;
        }
        onProgress?.(i / n, `Processing page ${i + 1} of ${n}`);
        const f = pageFrame(doc.getPage(i));
        const page = await pdf.getPage(i + 1);
        const canvas = await renderPage(page, (o.dpi ?? 150) / 72, { readback: true });
        page.cleanup();
        const ctx = canvas.getContext("2d")!;
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        fn(img.data);
        ctx.putImageData(img, 0, 0);
        const jpg = await out.embedJpg(await canvasToBytes(canvas, "image/jpeg", 0.88));
        const np = out.addPage([f.width, f.height]);
        np.drawImage(jpg, { x: 0, y: 0, width: f.width, height: f.height });
        await tick();
      }
    },
    src.password,
  );
  return pdfOut(`${stem(src.name)}-${suffix}.pdf`, await saveDoc(out));
}

/** Grayscale that keeps text as text when possible: rasterises only if asked. */
export async function grayscalePdf(src: Src, onProgress?: ProgressFn): Promise<OutFile> {
  return transformPages(src, grayPixels, "grayscale", { dpi: 200 }, onProgress);
}

export async function imageFileToCanvas(bytes: Uint8Array, mime: string) {
  return imageToCanvas(bytes, mime);
}
