/** Repair damaged PDFs: rebuild structure, or fall back to a faithful page-image copy with searchable text. */
import { PDFDocument } from "@cantoo/pdf-lib";
import { appendPages, canvasToBytes, newDoc, pdfOut, saveDoc, stem, tick, type OutFile, type ProgressFn } from "./core";
import { FontSet } from "./fonts";
import { place, pageFrame } from "./geometry";
import { pageText, renderPage, withPdfjs } from "./pdfjs";
import type { Src } from "./pages";

export async function repairPdf(src: Src, onProgress?: ProgressFn): Promise<OutFile> {
  const bytes = trimToPdf(src.bytes);
  // 1) Structural rebuild: parse leniently and copy every page into a clean file.
  try {
    onProgress?.(0.1, "Rebuilding the file structure");
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: false, updateMetadata: false, password: src.password });
    const out = await newDoc();
    await appendPages(out, doc);
    const t = doc.getTitle();
    if (t) out.setTitle(t);
    if (out.getPageCount() > 0) {
      const saved = await saveDoc(out);
      // Validate by opening the result with the other engine.
      await withPdfjs(saved, async ({ pageCount }) => {
        if (pageCount !== out.getPageCount()) throw new Error("page count mismatch");
      });
      return pdfOut(`${stem(src.name)}-repaired.pdf`, saved, `Rebuilt cleanly · ${out.getPageCount()} pages`);
    }
  } catch {
    /* fall through to the page-image rebuild */
  }
  // 2) PDF.js reconstructs broken cross-reference tables; redraw what it can see.
  const out = await newDoc();
  const fonts = new FontSet(out);
  let ok = 0;
  let failed = 0;
  try {
    await withPdfjs(
      bytes,
      async ({ pdf, pageCount }) => {
        for (let i = 1; i <= pageCount; i++) {
          onProgress?.(i / pageCount, `Recovering page ${i} of ${pageCount}`);
          try {
            const page = await pdf.getPage(i);
            const canvas = await renderPage(page, 2);
            const text = await pageText(page).catch(() => null);
            page.cleanup();
            const vp = page.getViewport({ scale: 1 });
            const img = await out.embedJpg(await canvasToBytes(canvas, "image/jpeg", 0.9));
            const np = out.addPage([vp.width, vp.height]);
            np.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
            if (text) {
              const f = pageFrame(np);
              for (const it of text.items) {
                if (!it.str.trim()) continue;
                const p = place(f, it.ox, f.height - it.oy, -it.dir);
                await fonts.drawInvisible(np, it.str, { x: p.x, y: p.y, size: it.fontSize, width: it.w, rotate: p.rotate });
              }
            }
            ok++;
          } catch {
            failed++;
          }
          await tick();
        }
      },
      src.password,
    );
  } catch (e) {
    throw new Error(`This file is too damaged to recover (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!ok) throw new Error("No pages could be recovered from this file.");
  return pdfOut(`${stem(src.name)}-repaired.pdf`, await saveDoc(out), `Recovered ${ok} page${ok === 1 ? "" : "s"}${failed ? `, ${failed} unreadable` : ""} as page images with searchable text`);
}

/** Drop junk before %PDF (e.g. mail headers) so parsers can find the file. */
function trimToPdf(b: Uint8Array): Uint8Array {
  const head = new TextDecoder("latin1").decode(b.subarray(0, Math.min(b.length, 2048)));
  const at = head.indexOf("%PDF-");
  return at > 0 ? b.subarray(at) : b;
}
