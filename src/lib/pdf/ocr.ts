/**
 * OCR with Tesseract (WebAssembly) served from this site. Original pages are
 * kept exactly as they are; recognised words are added as an invisible text
 * layer positioned over the scanned words, so the file becomes searchable and
 * copyable without losing image quality.
 */
import { appendPages, embedImage, newDoc, pdfOut, saveDoc, stem, tick, type OutFile, type ProgressFn } from "./core";
import { FontSet } from "./fonts";
import { pageFrame, place } from "./geometry";
import { open, type Src } from "./pages";
import { pageText, renderPage, withPdfjs } from "./pdfjs";

export const OCR_LANGS = [
  { value: "eng", label: "English" },
  { value: "hin", label: "Hindi" },
  { value: "eng+hin", label: "English + Hindi" },
] as const;

type Word = { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence: number };
type TessWorker = {
  recognize: (img: HTMLCanvasElement, opts?: object, output?: object) => Promise<{ data: { text: string; confidence: number; blocks?: Block[] | null } }>;
  terminate: () => Promise<unknown>;
};
type Block = { paragraphs: { lines: { words: Word[]; bbox: Word["bbox"]; baseline?: { x0: number; y0: number; x1: number; y1: number } }[] }[] };

function abs(path: string) {
  const base = ((import.meta.env?.BASE_URL as string | undefined) ?? "/").replace(/\/?$/, "/");
  return new URL(`${base}${path}`, globalThis.location?.href ?? "http://localhost/").href;
}

export async function createOcrWorker(lang: string, onProgress?: ProgressFn): Promise<TessWorker> {
  const { createWorker } = await import("tesseract.js");
  const langs = lang.split("+").filter((l) => ["eng", "hin"].includes(l));
  const worker = await createWorker(langs.length ? langs : ["eng"], 1, {
    workerPath: abs("vendor/tesseract/worker.min.js"),
    corePath: abs("vendor/tesseract/core"),
    langPath: abs("vendor/tesseract/lang"),
    gzip: true,
    cacheMethod: "write",
    logger: (m: { status: string; progress: number }) => {
      if (/loading|initializ/i.test(m.status)) onProgress?.(0, `Preparing OCR engine (${Math.round(m.progress * 100)}%)`);
    },
  });
  return worker as unknown as TessWorker;
}

export type OcrOpts = { lang?: string; dpi?: number; skipText?: boolean; pages?: number[] };

/** OCR a PDF: same pages, plus an invisible text layer. */
export async function ocrPdf(src: Src, o: OcrOpts = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const doc = await open(src);
  const out = await newDoc();
  await appendPages(out, doc);
  const fonts = new FontSet(out);
  const n = out.getPageCount();
  const worker = await createOcrWorker(o.lang ?? "eng", onProgress);
  let ocrd = 0;
  let skipped = 0;
  let confSum = 0;
  try {
    await withPdfjs(
      src.bytes,
      async ({ pdf }) => {
        for (let i = 0; i < n; i++) {
          if (o.pages && !o.pages.includes(i)) continue;
          const page = await pdf.getPage(i + 1);
          if (o.skipText !== false) {
            const t = await pageText(page);
            const chars = t.items.reduce((s, it) => s + it.str.trim().length, 0);
            if (chars > 40) {
              skipped++;
              page.cleanup();
              continue;
            }
          }
          onProgress?.(i / n, `Reading text on page ${i + 1} of ${n}`);
          const scale = (o.dpi ?? 300) / 72;
          const canvas = await renderPage(page, scale, { readback: true });
          page.cleanup();
          const res = await worker.recognize(canvas, {}, { blocks: true, text: true });
          confSum += res.data.confidence || 0;
          const target = out.getPage(i);
          await addTextLayer(target, fonts, res.data.blocks ?? [], canvas.width, canvas.height);
          canvas.width = canvas.height = 0;
          ocrd++;
          await tick();
        }
      },
      src.password,
    );
  } finally {
    await worker.terminate().catch(() => undefined);
  }
  if (!ocrd && skipped) throw new Error("Every page already has selectable text, so OCR was not needed. Untick “Skip pages that already have text” to force it.");
  const note = `${ocrd} page${ocrd === 1 ? "" : "s"} recognised${ocrd ? ` · ${Math.round(confSum / ocrd)}% avg confidence` : ""}${skipped ? ` · ${skipped} already had text` : ""}`;
  return pdfOut(`${stem(src.name)}-searchable.pdf`, await saveDoc(out), note);
}

/**
 * The invisible text over a scanned page. Each word is set along its line's baseline (tilted with
 * it when the scan is a little crooked) and stretched to reach the next word, with a space after
 * it, so selecting follows the printed words and copied text keeps its spaces and line order.
 */
async function addTextLayer(page: ReturnType<Awaited<ReturnType<typeof newDoc>>["getPage"]>, fonts: FontSet, blocks: Block[], cw: number, ch: number) {
  const f = pageFrame(page);
  const sx = f.width / cw;
  const sy = f.height / ch;
  for (const b of blocks) {
    for (const para of b.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const words = (line.words ?? []).filter((w) => w.text?.trim());
        if (!words.length) continue;
        const lh = (line.bbox.y1 - line.bbox.y0) * sy;
        const bl = line.baseline && Math.abs(line.baseline.x1 - line.baseline.x0) > 1 ? line.baseline : null;
        // Slope of the baseline in the scan (y down); kept to small tilts, as scans are.
        const slope = bl ? Math.max(-0.2, Math.min(0.2, (bl.y1 - bl.y0) / (bl.x1 - bl.x0))) : 0;
        const angle = Math.atan(slope);
        for (let k = 0; k < words.length; k++) {
          const w = words[k];
          const next = words[k + 1];
          const text = w.text.trim() + (next ? " " : "");
          const height = (w.bbox.y1 - w.bbox.y0) * sy;
          const size = Math.max(3, Math.min(lh, height * 1.15) * 0.85);
          // Baseline under the word's start: on the line's baseline, else the box's bottom
          // nudged up for descenders.
          const by = bl ? bl.y0 + (w.bbox.x0 - bl.x0) * slope : w.bbox.y1 - (w.bbox.y1 - w.bbox.y0) * 0.12;
          const reach = ((next ? next.bbox.x0 : w.bbox.x1) - w.bbox.x0) / Math.cos(angle);
          const p = place(f, w.bbox.x0 * sx, f.height - by * sy, (-angle * 180) / Math.PI);
          await fonts.drawInvisible(page, text, { x: p.x, y: p.y, size, width: Math.max(1, reach * sx), rotate: p.rotate });
        }
      }
    }
  }
}

/** OCR images directly into a searchable PDF (one page per image). */
export async function ocrImages(images: { bytes: Uint8Array; mime: string; name: string }[], o: OcrOpts = {}, onProgress?: ProgressFn): Promise<OutFile> {
  const out = await newDoc();
  const fonts = new FontSet(out);
  const worker = await createOcrWorker(o.lang ?? "eng", onProgress);
  try {
    for (let k = 0; k < images.length; k++) {
      onProgress?.(k / images.length, `Reading ${images[k].name}`);
      const img = await embedImage(out, images[k].bytes, images[k].mime);
      const s = Math.min(1, 1440 / Math.max(img.width, img.height)) * 0.75;
      const page = out.addPage([img.width * s, img.height * s]);
      page.drawImage(img, { x: 0, y: 0, width: img.width * s, height: img.height * s });
      const { imageToCanvas } = await import("./core");
      const canvas = await imageToCanvas(images[k].bytes, images[k].mime);
      const res = await worker.recognize(canvas, {}, { blocks: true });
      await addTextLayer(page, fonts, res.data.blocks ?? [], canvas.width, canvas.height);
    }
  } finally {
    await worker.terminate().catch(() => undefined);
  }
  return pdfOut(images.length === 1 ? `${stem(images[0].name)}-searchable.pdf` : "scans-searchable.pdf", await saveDoc(out));
}

/** Plain-text OCR of a canvas (used by the scanner and Chat with PDF on scans). */
export async function ocrCanvasText(canvas: HTMLCanvasElement, lang = "eng"): Promise<string> {
  const worker = await createOcrWorker(lang);
  try {
    const res = await worker.recognize(canvas);
    return res.data.text;
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
