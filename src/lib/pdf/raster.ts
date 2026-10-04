/** Pixel work: page renders, images → PDF, colour transforms. */
import {
  MM,
  appendPages,
  canvasToBytes,
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
        page.cleanup();
        const bytes = await canvasToBytesAny(canvas, mime, o.quality ?? 0.9);
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

async function canvasToBytesAny(canvas: HTMLCanvasElement, mime: string, quality: number) {
  const blob: Blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Encoding failed"))), mime, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

export type ImagesToPdfOpts = {
  /** "fit" = page matches each image; otherwise a paper size. */
  pageSize?: "fit" | "A4" | "Letter" | "Legal" | "A3" | "A5";
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
      const img = await embedImage(doc, list[k].bytes, list[k].mime);
      const mg = (o.marginMm ?? 0) * MM;
      if (!o.pageSize || o.pageSize === "fit") {
        // 1 image pixel = 1 pt at 96 dpi feel: cap very large photos to a sane page size.
        const maxSide = 1440;
        const s = Math.min(1, maxSide / Math.max(img.width, img.height)) * 0.75;
        const w = img.width * s;
        const h = img.height * s;
        const page = doc.addPage([w + mg * 2, h + mg * 2]);
        page.drawImage(img, { x: mg, y: mg, width: w, height: h });
      } else {
        const land = o.orientation === "landscape" || (o.orientation !== "portrait" && img.width > img.height);
        const [pw, ph] = paperSize(o.pageSize, land);
        const s = Math.min((pw - mg * 2) / img.width, (ph - mg * 2) / img.height);
        const w = img.width * s;
        const h = img.height * s;
        const page = doc.addPage([pw, ph]);
        page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      }
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

type PixelFn = (d: Uint8ClampedArray) => void;

export const invertPixels: PixelFn = (d) => {
  for (let p = 0; p < d.length; p += 4) {
    d[p] = 255 - d[p];
    d[p + 1] = 255 - d[p + 1];
    d[p + 2] = 255 - d[p + 2];
  }
};

/** Invert lightness but keep hues (dark mode that does not turn photos into negatives). */
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
