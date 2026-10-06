/** First-page previews and page counts for files in a list, rendered one at a time. */
import { kindOf } from "./files";

export type FileInfo = { url?: string; pages?: number; locked?: boolean; broken?: boolean; w?: number; h?: number };

const cache = new WeakMap<File, Map<string, Promise<FileInfo>>>();
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const p = queue.then(job, job);
  queue = p.catch(() => undefined);
  return p;
}

async function canvasUrl(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.8));
  return blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/jpeg", 0.8);
}

export function fileInfo(file: File, password = "", width = 220): Promise<FileInfo> {
  let per = cache.get(file);
  if (!per) {
    per = new Map();
    cache.set(file, per);
  }
  const key = `${password}|${width}`;
  const hit = per.get(key);
  if (hit) return hit;
  const job = (async (): Promise<FileInfo> => {
    const kind = kindOf(file);
    if (kind === "image") {
      if (/\.(heic|heif|tiff?)$/i.test(file.name)) return {};
      const url = URL.createObjectURL(file);
      const dims = await new Promise<{ w: number; h: number } | null>((res) => {
        const img = new Image();
        img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => res(null);
        img.src = url;
      });
      return dims ? { url, ...dims } : { broken: true };
    }
    if (kind !== "pdf") return {};
    return enqueue(async () => {
      const { openPdfjs, renderPage, PdfjsPasswordError } = await import("./pdf/pdfjs");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let opened;
      try {
        opened = await openPdfjs(bytes, password || undefined);
      } catch (e) {
        if (e instanceof PdfjsPasswordError) return { locked: true };
        return { broken: true };
      }
      try {
        const page = await opened.pdf.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const canvas = await renderPage(page, (width * dpr) / vp.width, { pixelBudget: 1_200_000 });
        page.cleanup();
        return { url: await canvasUrl(canvas), pages: opened.pageCount, w: vp.width, h: vp.height };
      } catch {
        return { pages: opened.pageCount };
      } finally {
        await opened.close().catch(() => undefined);
      }
    });
  })();
  per.set(key, job);
  return job;
}
