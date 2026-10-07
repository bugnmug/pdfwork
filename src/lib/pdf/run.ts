/** Runs a catalogue tool against files + options. Every result is a list of files to download. */
import type { Tool, Values } from "@/lib/tools/catalog";
import { TOOL_BY_SLUG } from "@/lib/tools/catalog";
import { pdfOut, type OutFile, type ProgressFn } from "./core";
import type { Src } from "./pages";

export type RunCtx = {
  files: File[];
  options: Values;
  /** Passwords keyed by file name, collected when a file turns out to be protected. */
  passwords?: Record<string, string>;
  onProgress?: ProgressFn;
};

const str = (o: Values, k: string, d = "") => (o[k] == null || o[k] === "" ? d : String(o[k]));
const num = (o: Values, k: string, d = 0) => {
  const v = o[k];
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : d;
};
const bool = (o: Values, k: string, d = false) => (typeof o[k] === "boolean" ? (o[k] as boolean) : o[k] === "true" ? true : o[k] === "false" ? false : d);

async function bytesOf(f: File | Blob) {
  return new Uint8Array(await f.arrayBuffer());
}

const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";
const isImage = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name);

async function srcOf(f: File, ctx: RunCtx): Promise<Src> {
  return { bytes: await bytesOf(f), name: f.name, password: ctx.passwords?.[f.name] };
}

function pdfFiles(ctx: RunCtx, min = 1): File[] {
  const list = ctx.files.filter(isPdf);
  if (list.length < min) throw new Error(min > 1 ? `Add at least ${min} PDF files.` : "Add a PDF file first.");
  return list;
}

/** Apply fn to each file; combine outputs, adding a ZIP when there are several. */
async function each(files: File[], ctx: RunCtx, fn: (src: Src, i: number, report: ProgressFn) => Promise<OutFile | OutFile[]>): Promise<OutFile[]> {
  const out: OutFile[] = [];
  for (let i = 0; i < files.length; i++) {
    const report: ProgressFn = (f, l) => ctx.onProgress?.((i + f) / files.length, files.length > 1 ? `${files[i].name}: ${l}` : l);
    report(0, "Starting");
    const r = await fn(await srcOf(files[i], ctx), i, report);
    out.push(...(Array.isArray(r) ? r : [r]));
  }
  if (files.length > 1 && out.length > 1) {
    const { withZip } = await import("./pages");
    return withZip(out.filter((f) => f.mime !== "application/zip"), "results.zip");
  }
  return out;
}

async function imageOpt(o: Values, key: string): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
  const f = o[key];
  if (f instanceof File) return { bytes: await bytesOf(f), mime: f.type || "image/png" };
  return undefined;
}

export async function runTool(toolOrSlug: Tool | string, ctx: RunCtx): Promise<OutFile[]> {
  const tool = typeof toolOrSlug === "string" ? TOOL_BY_SLUG[toolOrSlug] : toolOrSlug;
  if (!tool) throw new Error("Unknown tool.");
  const o = ctx.options;
  const p = ctx.onProgress;
  switch (tool.slug) {
    /* organize */
    case "merge-pdf": {
      const { mergePdfs } = await import("./pages");
      const srcs = await Promise.all(pdfFiles(ctx, 2).map((f) => srcOf(f, ctx)));
      return [await mergePdfs(srcs, { bookmarks: bool(o, "bookmarks", true) }, p)];
    }
    case "split-pdf": {
      const { splitPdf } = await import("./pages");
      return splitPdf(await srcOf(pdfFiles(ctx)[0], ctx), { mode: str(o, "mode", "range"), ranges: str(o, "ranges"), every: num(o, "every", 2), merge: bool(o, "merge") });
    }
    case "remove-pages": {
      const { removePages } = await import("./pages");
      if (!str(o, "pages").trim()) throw new Error("List the pages to remove, e.g. 2, 5-7.");
      return [await removePages(await srcOf(pdfFiles(ctx)[0], ctx), str(o, "pages"))];
    }
    case "extract-pages": {
      const { extractSelected } = await import("./pages");
      if (!str(o, "pages").trim()) throw new Error("List the pages to keep, e.g. 1-3, 8.");
      return [await extractSelected(await srcOf(pdfFiles(ctx)[0], ctx), str(o, "pages"))];
    }
    case "organize-pages": {
      const { organizePdf } = await import("./pages");
      const plan = (o.plan as never[]) ?? [];
      const extras = ctx.files.slice(1).filter(isPdf);
      return [await organizePdf(await srcOf(pdfFiles(ctx)[0], ctx), plan, await Promise.all(extras.map((f) => srcOf(f, ctx))))];
    }
    case "rotate-pdf": {
      const { rotatePdf } = await import("./pages");
      return each(pdfFiles(ctx), ctx, (s) => rotatePdf(s, num(o, "angle", 90), str(o, "pages", "all")));
    }
    case "mix-pdf": {
      const { mixPdfs } = await import("./pages");
      const srcs = await Promise.all(pdfFiles(ctx, 2).map((f) => srcOf(f, ctx)));
      return [await mixPdfs(srcs, { reverseSecond: bool(o, "reverseSecond"), chunk: num(o, "chunk", 1) })];
    }
    case "split-by-text": {
      const { splitByText } = await import("./pages");
      return splitByText(await srcOf(pdfFiles(ctx)[0], ctx), str(o, "query"), { regex: bool(o, "regex"), caseSensitive: bool(o, "caseSensitive") });
    }
    case "split-by-bookmarks": {
      const { splitByBookmarks } = await import("./pages");
      return splitByBookmarks(await srcOf(pdfFiles(ctx)[0], ctx), num(o, "level", 0));
    }
    case "split-in-half": {
      const { splitInHalf } = await import("./pages");
      return [await splitInHalf(await srcOf(pdfFiles(ctx)[0], ctx), str(o, "axis", "v") as "v" | "h", { rtl: bool(o, "rtl") })];
    }
    case "split-by-size": {
      const { splitBySize } = await import("./pages");
      return splitBySize(await srcOf(pdfFiles(ctx)[0], ctx), num(o, "maxMb", 5), p);
    }
    case "n-up": {
      const { nUp } = await import("./pages");
      const orient = str(o, "orientation", "auto");
      return [await nUp(await srcOf(pdfFiles(ctx)[0], ctx), { n: num(o, "n", 4), paper: str(o, "paper", "A4"), landscape: orient === "auto" ? "auto" : orient === "landscape", border: bool(o, "border", true) })];
    }
    case "crop-pdf": {
      const { cropMargins, autoCrop } = await import("./pages");
      const s = await srcOf(pdfFiles(ctx)[0], ctx);
      if (str(o, "mode", "auto") === "auto") return [await autoCrop(s, num(o, "pad", 5), p)];
      return [await cropMargins(s, { top: num(o, "top", 10), right: num(o, "right", 10), bottom: num(o, "bottom", 10), left: num(o, "left", 10) }, str(o, "pages", "all"))];
    }
    case "resize-pdf": {
      const { fitToPaper } = await import("./pages");
      return each(pdfFiles(ctx), ctx, (s) => fitToPaper(s, str(o, "paper", "A4"), str(o, "orientation", "auto") as "auto", num(o, "margin", 0)));
    }
    case "flip-pdf": {
      const { flipPdf } = await import("./pages");
      return [await flipPdf(await srcOf(pdfFiles(ctx)[0], ctx), str(o, "dir", "h") as "h" | "v")];
    }
    case "pdf-to-zip": {
      const { pdfToZip } = await import("./pages");
      return [await pdfToZip(await srcOf(pdfFiles(ctx)[0], ctx))];
    }

    /* optimize */
    case "compress-pdf": {
      const { compressPdf } = await import("./compress");
      const level = str(o, "level", "recommended") as never;
      return each(pdfFiles(ctx), ctx, (s, _i, r) => compressPdf(s, { level, grayscale: bool(o, "grayscale"), flatten: level === "extreme" && bool(o, "flatten") }, r));
    }
    case "repair-pdf": {
      const { repairPdf } = await import("./repair");
      return each(ctx.files, ctx, (s, _i, r) => repairPdf(s, r));
    }
    case "ocr-pdf": {
      const { ocrPdf, ocrImages } = await import("./ocr");
      const opts = { lang: str(o, "lang", "eng"), skipText: bool(o, "skipText", true), dpi: num(o, "dpi", 300) };
      const images = ctx.files.filter(isImage);
      const out: OutFile[] = [];
      if (images.length) out.push(await ocrImages(await Promise.all(images.map(async (f) => ({ bytes: await bytesOf(f), mime: f.type, name: f.name }))), opts, p));
      const pdfs = ctx.files.filter(isPdf);
      if (pdfs.length) out.push(...(await each(pdfs, ctx, (s, _i, r) => ocrPdf(s, opts, r))));
      if (!out.length) throw new Error("Add a scanned PDF or an image.");
      return out;
    }
    case "grayscale-pdf": {
      const { grayscalePdf } = await import("./grayscale");
      return [await grayscalePdf(await srcOf(pdfFiles(ctx)[0], ctx), { pages: str(o, "pages", "all") }, p)];
    }
    case "pdf-to-pdfa": {
      const { toPdfA } = await import("./pdfa");
      return [await toPdfA(await srcOf(pdfFiles(ctx)[0], ctx), str(o, "level", "2B") as "2B", p)];
    }

    /* edit */
    case "watermark": {
      const { watermark } = await import("./stamp");
      const image = await imageOpt(o, "image");
      if (str(o, "kind") === "image" && !image) throw new Error("Choose the image to use as a watermark.");
      return each(pdfFiles(ctx), ctx, (s) =>
        watermark(s, {
          kind: str(o, "kind", "text") as "text",
          text: str(o, "text", "CONFIDENTIAL"),
          image,
          family: str(o, "family", "sans") as "sans",
          size: num(o, "size", 0) || undefined,
          color: str(o, "color", "#b42318"),
          opacity: num(o, "opacity", 0.2),
          angle: num(o, "angle", 45),
          position: str(o, "position", "center") as "center",
          scale: num(o, "scale", 0.4),
          behind: bool(o, "behind"),
          pages: str(o, "pages", "all"),
        }),
      );
    }
    case "page-numbers": {
      const { addPageNumbers } = await import("./stamp");
      return each(pdfFiles(ctx), ctx, (s) =>
        addPageNumbers(s, {
          format: str(o, "format", "{n}"),
          position: str(o, "position", "bottom") as "bottom",
          numerals: str(o, "numerals", "arabic") as "arabic",
          start: num(o, "start", 1),
          skipFirst: num(o, "skipFirst", 0),
          size: num(o, "size", 10),
          margin: num(o, "margin", 10),
          color: str(o, "color", "#222222"),
          mirror: bool(o, "mirror"),
        }),
      );
    }
    case "header-footer": {
      const { headerFooter } = await import("./stamp");
      return each(pdfFiles(ctx), ctx, (s) =>
        headerFooter(s, {
          headerLeft: str(o, "headerLeft"),
          headerCenter: str(o, "headerCenter"),
          headerRight: str(o, "headerRight"),
          footerLeft: str(o, "footerLeft"),
          footerCenter: str(o, "footerCenter"),
          footerRight: str(o, "footerRight"),
          size: num(o, "size", 9),
          margin: num(o, "margin", 10),
          color: str(o, "color", "#444444"),
          skipFirst: num(o, "skipFirst", 0),
        }),
      );
    }
    case "bates": {
      const { batesNumber } = await import("./stamp");
      const srcs = await Promise.all(pdfFiles(ctx).map((f) => srcOf(f, ctx)));
      const out = await batesNumber(srcs, { prefix: str(o, "prefix"), suffix: str(o, "suffix"), start: num(o, "start", 1), digits: num(o, "digits", 7), position: str(o, "position", "bottom-right") as "bottom-right", size: num(o, "size", 10) });
      if (out.length > 1) {
        const { withZip } = await import("./pages");
        return withZip(out, "bates-numbered.zip");
      }
      return out;
    }
    case "stamp-image": {
      const { stampImage } = await import("./stamp");
      const image = await imageOpt(o, "image");
      const imgFile = ctx.files.find(isImage);
      const img = image ?? (imgFile ? { bytes: await bytesOf(imgFile), mime: imgFile.type } : undefined);
      if (!img) throw new Error("Choose the image to place. A PNG without a background blends in cleanly.");
      return each(pdfFiles(ctx), ctx, (s) => stampImage(s, { image: img, where: str(o, "where", "last") as "last", pages: str(o, "pages", "all"), position: str(o, "position", "bottom-right") as "bottom-right", widthMm: num(o, "widthMm", 30), caption: str(o, "caption") }));
    }
    case "flatten-pdf": {
      const { flattenPdf } = await import("./forms");
      return each(pdfFiles(ctx), ctx, (s) => flattenPdf(s, { forms: bool(o, "forms", true), annotations: bool(o, "annotations", true), keepLinks: bool(o, "keepLinks", true) }));
    }
    case "invert-pdf": {
      const { transformPages, invertPixels, darkModePixels } = await import("./raster");
      const s = await srcOf(pdfFiles(ctx)[0], ctx);
      return [await transformPages(s, str(o, "mode", "smart") === "invert" ? invertPixels : darkModePixels, "dark", { pages: str(o, "pages", "all") }, p)];
    }
    case "pdf-to-handwriting": {
      const { extractPlainText } = await import("./pdfjs");
      const { textToHandwriting } = await import("./handwriting");
      const s = await srcOf(pdfFiles(ctx)[0], ctx);
      const text = (await extractPlainText(s.bytes, s.password)).replace(/\f/g, "");
      if (!text.trim()) throw new Error("This looks like a scan, so there's no text to work with. Open it in OCR: Searchable PDF first.");
      const out = await textToHandwriting(text, { font: str(o, "font", "caveat") as "caveat", paper: str(o, "paper", "ruled") as "ruled", ink: str(o, "ink", "#1e40af"), size: num(o, "size", 17) });
      out.filename = s.name.replace(/\.pdf$/i, "") + "-handwritten.pdf";
      return [out];
    }

    /* to pdf */
    case "images-to-pdf": {
      const { imagesToPdf } = await import("./raster");
      const imgs = ctx.files.filter(isImage);
      if (!imgs.length) throw new Error("Add one or more images.");
      return imagesToPdf(await Promise.all(imgs.map(async (f) => ({ bytes: await bytesOf(f), mime: f.type, name: f.name }))), { pageSize: str(o, "pageSize", "A4") as "A4", orientation: str(o, "orientation", "auto") as "auto", marginMm: num(o, "marginMm", 10), separate: bool(o, "separate") }, p);
    }
    case "word-to-pdf": {
      const { wordToPdf } = await import("./office");
      if (!ctx.files.length) throw new Error("Add a Word file (.docx).");
      return each(ctx.files, ctx, async (s, _i, r) => wordToPdf(s.bytes, s.name, {}, r));
    }
    case "excel-to-pdf": {
      const { excelToPdf, csvToPdf } = await import("./office");
      if (!ctx.files.length) throw new Error("Add a spreadsheet.");
      return each(ctx.files, ctx, async (s, _i, r) =>
        /\.(csv|tsv)$/i.test(s.name) ? csvToPdf(new TextDecoder().decode(s.bytes), s.name, { paper: str(o, "paper", "A4") }, r) : excelToPdf(s.bytes, s.name, { sheets: str(o, "sheets", "all") as "all", paper: str(o, "paper", "A4") }, r),
      );
    }
    case "ppt-to-pdf": {
      const { pptxToPdf } = await import("./pptx");
      if (!ctx.files.length) throw new Error("Add a PowerPoint file (.pptx).");
      return each(ctx.files, ctx, (s, _i, r) => pptxToPdf(s.bytes, s.name, r));
    }
    case "html-to-pdf": {
      const { htmlToPdf } = await import("./office");
      const { paperSize } = await import("./core");
      const file = ctx.files[0];
      const html = str(o, "html") || (file ? await file.text() : "");
      return [await htmlToPdf(html, file?.name ?? "page", { pageSize: paperSize(str(o, "paper", "A4")), family: str(o, "family", "sans") as "sans" })];
    }
    case "markdown-to-pdf": {
      const { markdownToPdf } = await import("./office");
      const { paperSize } = await import("./core");
      const file = ctx.files[0];
      const md = str(o, "md") || (file ? await file.text() : "");
      return [await markdownToPdf(md, file?.name ?? "document", { pageSize: paperSize(str(o, "paper", "A4")), family: str(o, "family", "sans") as "sans" })];
    }
    case "csv-to-pdf": {
      const { csvToPdf } = await import("./office");
      if (!ctx.files.length) throw new Error("Add a CSV file.");
      return each(ctx.files, ctx, async (s, _i, r) => csvToPdf(new TextDecoder().decode(s.bytes), s.name, { header: bool(o, "header", true), paper: str(o, "paper", "A4") }, r));
    }
    case "create-pdf": {
      const { markdownToPdf, textToPdf } = await import("./office");
      const { paperSize } = await import("./core");
      const file = ctx.files[0];
      const body = str(o, "body") || (file ? await file.text() : "");
      const title = str(o, "title");
      if (!body.trim() && !title.trim()) throw new Error("Type some text first.");
      const name = title || file?.name || "document";
      if (bool(o, "markdown", true)) return [await markdownToPdf(`${title ? `# ${title}\n\n` : ""}${body}`, name, { pageSize: paperSize(str(o, "paper", "A4")), family: str(o, "family", "sans") as "sans" })];
      return [await textToPdf(body, name, { title, paper: str(o, "paper", "A4"), family: str(o, "family", "sans") as "sans" })];
    }
    case "ebook-to-pdf": {
      const { epubToPdf } = await import("./epub");
      const f = ctx.files[0];
      if (!f) throw new Error("Add an EPUB file.");
      return [await epubToPdf(await bytesOf(f), f.name, { paper: str(o, "paper", "A5") }, p)];
    }
    case "text-to-handwriting": {
      const { textToHandwriting } = await import("./handwriting");
      return [await textToHandwriting(str(o, "body"), { heading: str(o, "heading"), font: str(o, "font", "caveat") as "caveat", paper: str(o, "paper", "ruled") as "ruled", ink: str(o, "ink", "#1e40af"), size: num(o, "size", 17), wobble: num(o, "wobble", 1) })];
    }
    case "audio-to-pdf": {
      const { textToPdf } = await import("./office");
      const body = str(o, "body");
      if (!body.trim()) throw new Error("Dictate or paste the transcript first.");
      return [await textToPdf(body, str(o, "title", "transcript"), { title: str(o, "title", "Transcript") })];
    }

    /* from pdf */
    case "pdf-to-word": {
      const { pdfToWord } = await import("./export");
      return each(pdfFiles(ctx), ctx, (s, _i, r) => pdfToWord(s, { mode: str(o, "mode", "editable") as "editable", pageBreaks: bool(o, "pageBreaks", true), images: bool(o, "images", true) }, r));
    }
    case "pdf-to-excel": {
      const { pdfToExcel } = await import("./export");
      return each(pdfFiles(ctx), ctx, (s, _i, r) => pdfToExcel(s, { oneSheet: bool(o, "oneSheet") }, r));
    }
    case "pdf-to-ppt": {
      const { pdfToPptx } = await import("./export");
      return each(pdfFiles(ctx), ctx, (s, _i, r) => pdfToPptx(s, { mode: str(o, "mode", "editable") as "editable", notes: bool(o, "notes", true) }, r));
    }
    case "pdf-to-jpg": {
      const { pdfToImages } = await import("./raster");
      return pdfToImages(await srcOf(pdfFiles(ctx)[0], ctx), { format: str(o, "format", "jpg") as "jpg", dpi: num(o, "dpi", 150), pages: str(o, "pages", "all") }, p);
    }
    case "extract-images": {
      const { extractImagesFiles } = await import("./export");
      return extractImagesFiles(await srcOf(pdfFiles(ctx)[0], ctx), { format: str(o, "format", "original") as "original" }, p);
    }
    case "extract-text": {
      const { pdfToText } = await import("./export");
      return each(pdfFiles(ctx), ctx, (s, _i, r) => pdfToText(s, { layout: str(o, "layout", "reading") === "layout", pageBreaks: bool(o, "pageBreaks", true) }, r));
    }
    case "pdf-to-html": {
      const { pdfToHtml } = await import("./export");
      return [await pdfToHtml(await srcOf(pdfFiles(ctx)[0], ctx), { mode: str(o, "mode", "reflow") as "reflow" }, p)];
    }
    case "pdf-to-markdown": {
      const { pdfToMarkdown } = await import("./export");
      return each(pdfFiles(ctx), ctx, (s, _i, r) => pdfToMarkdown(s, r));
    }
    case "pdf-to-csv": {
      const { pdfToCsv } = await import("./export");
      return each(pdfFiles(ctx), ctx, (s, _i, r) => pdfToCsv(s, r));
    }
    case "pdf-to-epub": {
      const { pdfToEpub } = await import("./export");
      return [await pdfToEpub(await srcOf(pdfFiles(ctx)[0], ctx), { title: str(o, "title"), author: str(o, "author") }, p)];
    }

    /* security */
    case "encrypt-pdf": {
      const { encryptPdf } = await import("./security");
      return each(pdfFiles(ctx), ctx, (s) =>
        encryptPdf(s, {
          userPassword: str(o, "userPassword"),
          ownerPassword: str(o, "ownerPassword") || undefined,
          printing: str(o, "printing", "high") as "high",
          copying: bool(o, "copying"),
          modifying: bool(o, "modifying"),
          fillingForms: bool(o, "fillingForms", true),
        }),
      );
    }
    case "remove-password": {
      const { decryptPdf } = await import("./security");
      return each(pdfFiles(ctx), ctx, (s) => decryptPdf(s, s.password ?? str(o, "password")));
    }
    case "auto-redact": {
      const { autoRedact } = await import("./redact");
      return autoRedact(await srcOf(pdfFiles(ctx)[0], ctx), { kinds: o.kinds as never, terms: (o.terms as string[]) ?? [], regex: str(o, "regex") }, p);
    }
    case "privacy-scanner": {
      const { scanDocument, redactionReport } = await import("./redact");
      const s = await srcOf(pdfFiles(ctx)[0], ctx);
      const r = await scanDocument(s, {}, p);
      return [{ filename: s.name.replace(/\.pdf$/i, "") + "-privacy-report.txt", bytes: new TextEncoder().encode(redactionReport(s.name, r.findings, r.pages, "Privacy scan")), mime: "text/plain", note: `${r.findings.length} item${r.findings.length === 1 ? "" : "s"} found` }];
    }
    case "sanitize-pdf": {
      const { sanitizePdf } = await import("./security");
      return each(pdfFiles(ctx), ctx, (s) => sanitizePdf(s, { metadata: bool(o, "metadata", true), javascript: bool(o, "javascript", true), attachments: bool(o, "attachments", true), annotations: bool(o, "annotations"), links: bool(o, "links"), forms: bool(o, "forms") }));
    }
    case "fingerprint": {
      const { fingerprint, fingerprintReport } = await import("./security");
      if (!ctx.files.length) throw new Error("Add a file.");
      const reports: string[] = [];
      for (const f of ctx.files) reports.push(fingerprintReport(await fingerprint(await bytesOf(f), f.name)));
      return [{ filename: ctx.files.length === 1 ? `${ctx.files[0].name}.fingerprint.txt` : "fingerprints.txt", bytes: new TextEncoder().encode(reports.join("\n\n" + "=".repeat(60) + "\n\n")), mime: "text/plain" }];
    }
    case "metadata": {
      const { setMetadata } = await import("./security");
      return [await setMetadata(await srcOf(pdfFiles(ctx)[0], ctx), { title: str(o, "title"), author: str(o, "author"), subject: str(o, "subject"), keywords: str(o, "keywords"), creator: str(o, "creator") })];
    }
    case "fill-form": {
      const { fillForm } = await import("./forms");
      return [await fillForm(await srcOf(pdfFiles(ctx)[0], ctx), (o.values as Record<string, string>) ?? {}, { flatten: bool(o, "flatten") })];
    }
    case "compare-pdfs": {
      const { compareText, compareReport } = await import("./compare");
      const [a, b] = await Promise.all(pdfFiles(ctx, 2).slice(0, 2).map((f) => srcOf(f, ctx)));
      const r = await compareText(a, b, p);
      const report = await compareReport(a, b, r);
      report.note = r.same ? "No text differences" : `${r.added} words added, ${r.removed} removed`;
      return [report];
    }
    case "gst-invoice": {
      const { gstInvoicePdf } = await import("./business");
      return [await gstInvoicePdf(o.invoice as never)];
    }
    case "pos-bill": {
      const { posBillPdf } = await import("./business");
      return [await posBillPdf(o.bill as never)];
    }
    case "gst-filing": {
      const { gstWorkingPaperPdf, gstCsv } = await import("./business");
      const rows = (o.rows as never[]) ?? [];
      return [await gstWorkingPaperPdf(rows, { business: str(o, "business"), gstin: str(o, "gstin"), period: str(o, "period") }), gstCsv(rows)];
    }
    case "resume": {
      const { resumePdf } = await import("./business");
      return [await resumePdf(o.resume as never)];
    }
    case "redact-pdf": {
      const { redactBoxes } = await import("./redact");
      return [await redactBoxes(await srcOf(pdfFiles(ctx)[0], ctx), (o.boxes as never[]) ?? [], {}, p)];
    }
  }
  throw new Error(`“${tool.name}” runs on its own screen.`);
}

export { pdfOut };
