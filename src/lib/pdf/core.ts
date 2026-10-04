import {
  PDFDocument,
  PDFName,
  StandardFonts,
  degrees,
  rgb,
  PageSizes,
  type PDFFont,
  type PDFPage,
  type RGB,
} from "@cantoo/pdf-lib";
import { BRAND } from "@/lib/brand";

export { PDFDocument, PDFName, StandardFonts, rgb, degrees, PageSizes };
export type { PDFFont, PDFPage, RGB };

export const black = rgb(0, 0, 0);
export const ink = rgb(22 / 255, 20 / 255, 16 / 255);
export const accent = rgb(180 / 255, 35 / 255, 24 / 255);
export const grey = rgb(0.45, 0.45, 0.45);
export const hairline = rgb(0.78, 0.78, 0.78);
export const white = rgb(1, 1, 1);

/** One produced file. Every tool returns a list of these. */
export type OutFile = { filename: string; bytes: Uint8Array; mime: string; note?: string };

export function pdfOut(filename: string, bytes: Uint8Array, note?: string): OutFile {
  return { filename, bytes, mime: "application/pdf", note };
}

/** Thrown when a PDF needs a password we were not given (or the given one is wrong). */
export class PasswordError extends Error {
  constructor(
    public readonly fileName: string,
    public readonly wrong: boolean,
  ) {
    super(
      wrong
        ? `The password for “${fileName}” is not correct.`
        : `“${fileName}” is password-protected. Enter its password to continue.`,
    );
    this.name = "PasswordError";
  }
}

export type LoadOpts = {
  /** Password for an encrypted file. Owner-restricted files open without one. */
  password?: string;
  /** Used in error messages. */
  name?: string;
};

/**
 * Load a PDF for editing. Encrypted files are decrypted (empty user password is
 * tried automatically, which covers "owner restricted" files); if a real
 * password is needed a PasswordError says so instead of producing garbage pages.
 */
export async function loadPdf(bytes: Uint8Array, opts: LoadOpts = {}): Promise<PDFDocument> {
  const name = opts.name ?? "This PDF";
  let probe: PDFDocument;
  try {
    probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    throw new Error(`Could not read “${name}”. It may be damaged or not a PDF. Try the Repair tool. (${errText(e)})`);
  }
  if (!probe.isEncrypted) return probe;
  const attempts = opts.password ? [opts.password, ""] : [""];
  for (const pw of attempts) {
    try {
      const doc = await PDFDocument.load(bytes, { password: pw, updateMetadata: false });
      stripEncryption(doc);
      // Verify decryption produced readable structure.
      doc.getPageCount();
      return doc;
    } catch (e) {
      if (!/password/i.test(errText(e))) throw new Error(`Could not decrypt “${name}”: ${errText(e)}`);
    }
  }
  throw new PasswordError(name, !!opts.password);
}

function stripEncryption(doc: PDFDocument) {
  const trailer = doc.context.trailerInfo as { Encrypt?: unknown };
  delete trailer.Encrypt;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function newDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.setProducer(BRAND.name);
  doc.setCreator(BRAND.name);
  doc.setCreationDate(new Date());
  doc.setModificationDate(new Date());
  return doc;
}

export async function saveDoc(doc: PDFDocument, opts: { objectStreams?: boolean } = {}): Promise<Uint8Array> {
  const saved = await doc.save({ useObjectStreams: opts.objectStreams ?? true, updateFieldAppearances: false });
  return saved instanceof Uint8Array ? saved : new Uint8Array(saved);
}

/** Copy pages (by zero-based index) from src into target, appending them. */
export async function appendPages(target: PDFDocument, src: PDFDocument, indices?: number[]): Promise<PDFPage[]> {
  const copied = await target.copyPages(src, indices ?? src.getPageIndices());
  for (const p of copied) target.addPage(p);
  return copied;
}

export function hexToRgb(hex: string): RGB {
  const h = (hex || "#000000").replace("#", "").trim();
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0");
  const v = (i: number) => {
    const x = parseInt(n.slice(i, i + 2), 16) / 255;
    return Number.isFinite(x) ? x : 0;
  };
  return rgb(v(0), v(2), v(4));
}

export const PAPER: Record<string, [number, number]> = {
  A3: PageSizes.A3,
  A4: PageSizes.A4,
  A5: PageSizes.A5,
  Letter: PageSizes.Letter,
  Legal: PageSizes.Legal,
};

export function paperSize(name: string, landscape = false): [number, number] {
  const [w, h] = PAPER[name] ?? PageSizes.A4;
  return landscape ? [h, w] : [w, h];
}

export const MM = 72 / 25.4;

/** Parse "1-3, 5, 8-" into zero-based page indices (in the order given). */
export function parsePageList(spec: string, pageCount: number): number[] {
  const out: number[] = [];
  const s = spec.trim().toLowerCase();
  if (!s || s === "all") return Array.from({ length: pageCount }, (_, i) => i);
  for (const raw of s.split(/[,;\s]+/)) {
    const part = raw.trim();
    if (!part) continue;
    if (part === "odd" || part === "even") {
      for (let i = part === "odd" ? 0 : 1; i < pageCount; i += 2) out.push(i);
      continue;
    }
    const m = part.match(/^(\d*|last|z)\s*-\s*(\d*|last|z)$/);
    const num = (t: string, d: number) => (t === "" ? d : t === "last" || t === "z" ? pageCount : parseInt(t, 10));
    if (m) {
      const a = num(m[1], 1);
      const b = num(m[2], pageCount);
      const step = a <= b ? 1 : -1;
      for (let i = a; step > 0 ? i <= b : i >= b; i += step) if (i >= 1 && i <= pageCount) out.push(i - 1);
    } else {
      const n = part === "last" || part === "z" ? pageCount : parseInt(part, 10);
      if (n >= 1 && n <= pageCount) out.push(n - 1);
    }
  }
  return out;
}

/** Groups for "custom ranges" splitting: each comma-separated range becomes one file. */
export function parseRangeGroups(spec: string, pageCount: number): number[][] {
  const groups: number[][] = [];
  for (const part of spec.split(/[,;]+/)) {
    const g = parsePageList(part, pageCount);
    if (part.trim() && g.length) groups.push(g);
  }
  return groups;
}

export function stem(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "document";
}

export function withSuffix(name: string, suffix: string, ext = ".pdf"): string {
  return `${stem(name)}${suffix}${ext}`;
}

export function safeFileName(s: string, max = 60): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[^\w\s.-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, max) || "untitled"
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when a PDF page dictionary carries any annotations. */
export function pageHasAnnots(page: PDFPage): boolean {
  return !!page.node.lookup(PDFName.of("Annots"));
}

export async function canvasToBytes(canvas: HTMLCanvasElement, mime: "image/jpeg" | "image/png", quality = 0.9) {
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image encoding failed"))), mime, quality),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/** Decode any browser-supported image (png, jpg, webp, gif, bmp, avif, svg) to a canvas. */
export async function imageToCanvas(bytes: Uint8Array, mime = ""): Promise<HTMLCanvasElement> {
  const blob = new Blob([bytes.slice()], mime ? { type: mime } : undefined);
  let source: CanvasImageSource & { width: number; height: number };
  try {
    source = await createImageBitmap(blob, { imageOrientation: "from-image" } as ImageBitmapOptions);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      source = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("This image format could not be read."));
        img.src = url;
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, source.width);
  canvas.height = Math.max(1, source.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  ctx.drawImage(source, 0, 0);
  if ("close" in source && typeof source.close === "function") source.close();
  return canvas;
}

/** Embed an image in a PDF, keeping JPEG bytes as-is and PNG transparency intact. */
export async function embedImage(doc: PDFDocument, bytes: Uint8Array, mime = "") {
  const kind = sniffImage(bytes) ?? mime.toLowerCase();
  if (kind.includes("jpeg") || kind.includes("jpg")) {
    try {
      return await doc.embedJpg(bytes);
    } catch {
      /* CMYK or progressive oddities: fall through to re-encode */
    }
  }
  if (kind.includes("png")) {
    try {
      return await doc.embedPng(bytes);
    } catch {
      /* 16-bit or interlaced PNG: re-encode below */
    }
  }
  const canvas = await imageToCanvas(bytes, mime);
  const hasAlpha = canvasHasAlpha(canvas);
  return hasAlpha
    ? doc.embedPng(await canvasToBytes(canvas, "image/png"))
    : doc.embedJpg(await canvasToBytes(canvas, "image/jpeg", 0.92));
}

export function sniffImage(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  return null;
}

function canvasHasAlpha(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const step = Math.max(1, Math.floor((canvas.width * canvas.height) / 40000));
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4 * step) if (data[i] < 250) return true;
  return false;
}

export type ProgressFn = (fraction: number, label: string) => void;

/** Let the UI breathe during long loops. */
export function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
