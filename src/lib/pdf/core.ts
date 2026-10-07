import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
  PageSizes,
  type PDFFont,
  type PDFObject,
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
        ? `That isn't the password for “${fileName}”.`
        : `“${fileName}” is locked. It needs its password before it can be opened.`,
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
    throw new Error(`“${name}” couldn't be opened as a PDF. If it is one, the Repair tool can often fix it. (${errText(e)})`);
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

/**
 * Removes the objects nothing in the file refers to any more (the fonts and pictures of a page
 * that was redrawn), so saving doesn't carry them along.
 */
export async function dropUnreferenced(doc: PDFDocument): Promise<void> {
  await doc.flush();
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: unknown[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt];
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      const k = o.toString();
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push(ctx.lookup(o));
    } else if (o instanceof PDFDict) for (const [, v] of o.entries()) stack.push(v);
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    else if (o instanceof PDFRawStream || o instanceof PDFStream) stack.push(o.dict);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) ctx.delete(ref);
}

/**
 * Copy pages (by zero-based index) from src into target, appending them, with what points
 * between pages kept working: a link to a page that comes along goes to its copy (a link to a
 * page left behind is dropped), and the form fields on the pages stay fields of the new
 * document (one named like a field already there gets a new name, so each keeps its own value).
 * Without this a link's destination, or a field's page, would drag a stray copy of its page
 * into the file, and the fields would stop being fields.
 */
export async function appendPages(target: PDFDocument, src: PDFDocument, indices?: number[]): Promise<PDFPage[]> {
  const copied = await copyPages(target, src, indices);
  for (const p of copied) target.addPage(p);
  return copied;
}

/** Pages copied as appendPages does, for the caller to place (in another order, between others). */
export async function copyPages(target: PDFDocument, src: PDFDocument, indices?: number[]): Promise<PDFPage[]> {
  const idx = indices ?? src.getPageIndices();
  const ctx = src.context;
  const pages = src.getPages();
  const pageOf = new Map(pages.map((p, i) => [p.ref.toString(), i]));
  const named = namedDestinations(src);
  const DEST = PDFName.of("Dest");
  const A = PDFName.of("A");
  const P = PDFName.of("P");
  // Entries taken off the source while copying, put back afterwards (the source may be copied from again).
  const taken: { dict: PDFDict; key: PDFName; value: PDFObject }[] = [];
  const take = (dict: PDFDict, key: PDFName) => {
    const value = dict.get(key);
    if (value === undefined) return;
    taken.push({ dict, key, value });
    dict.delete(key);
  };
  type Jump = { at: number; annot: number; page: number; tail: PDFObject[] };
  const jumps: Jump[] = [];
  const roots = new Set<PDFDict>();
  const parentOf = (d: PDFDict) => d.lookupMaybe(PDFName.of("Parent"), PDFDict);
  idx.forEach((pi, at) => {
    const annots = pages[pi].node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    annots?.asArray().forEach((ref, j) => {
      const a = ctx.lookup(ref);
      if (!(a instanceof PDFDict)) return;
      take(a, P);
      const sub = a.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
      if (sub === "/Widget") {
        let f = a;
        for (let up = parentOf(f), k = 0; up && k < 50; up = parentOf(f), k++) f = up;
        roots.add(f);
        return;
      }
      if (sub !== "/Link") return;
      const action = a.lookupMaybe(A, PDFDict);
      const goTo = action?.lookupMaybe(PDFName.of("S"), PDFName)?.asString() === "/GoTo";
      const dest = resolveDest(ctx, goTo ? action!.get(PDFName.of("D")) : a.get(DEST), named);
      if (!dest) return;
      // (Its page by reference, or, from some writers, by number.)
      const first = dest.get(0);
      const page = first instanceof PDFRef ? pageOf.get(first.toString()) : first instanceof PDFNumber && first.asNumber() >= 0 && first.asNumber() < pages.length ? first.asNumber() : undefined;
      if (page === undefined) return;
      jumps.push({ at, annot: j, page, tail: dest.asArray().slice(1) });
      if (goTo) take(a, A);
      else take(a, DEST);
    });
  });
  // The fields' other widgets (a field shown on another page too) mustn't bring their pages either.
  const walk = (f: PDFDict, depth = 0) => {
    take(f, P);
    if (depth < 20) for (const k of f.lookupMaybe(PDFName.of("Kids"), PDFArray)?.asArray() ?? []) {
      const kid = ctx.lookup(k);
      if (kid instanceof PDFDict) walk(kid, depth + 1);
    }
  };
  for (const r of roots) walk(r);
  let copied: PDFPage[];
  try {
    copied = await target.copyPages(src, idx);
  } finally {
    for (const t of taken) t.dict.set(t.key, t.value);
  }
  const tctx = target.context;
  const at = new Map<number, number>();
  idx.forEach((pi, k) => (at.has(pi) ? undefined : at.set(pi, k)));
  // Links go to the copies of their pages; links to pages left behind go.
  const dropped = new Map<number, Set<number>>();
  for (const j of jumps) {
    const annots = copied[j.at].node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    const a = annots ? tctx.lookup(annots.get(j.annot)) : undefined;
    if (!(a instanceof PDFDict)) continue;
    const to = at.get(j.page);
    if (to === undefined) dropped.set(j.at, (dropped.get(j.at) ?? new Set()).add(j.annot));
    else a.set(DEST, tctx.obj([copied[to].ref, ...j.tail]));
  }
  for (const [k, gone] of dropped) {
    const annots = copied[k].node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;
    const keep = annots.asArray().filter((_, j) => !gone.has(j));
    copied[k].node.set(PDFName.of("Annots"), tctx.obj(keep));
  }
  // Every annotation knows its page again.
  for (const p of copied) for (const r of p.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? []) {
    const a = tctx.lookup(r);
    if (a instanceof PDFDict) a.set(P, p.ref);
  }
  if (roots.size) carryFields(target, src, copied);
  return copied;
}

/** A destination as an explicit array (named destinations looked up in the document). */
function resolveDest(ctx: PDFDocument["context"], d: PDFObject | undefined, named: Map<string, PDFObject>): PDFArray | undefined {
  const v = d instanceof PDFRef ? ctx.lookup(d) : d;
  if (v instanceof PDFArray) return v;
  if (v instanceof PDFDict) return resolveDest(ctx, v.get(PDFName.of("D")), named);
  const name = v instanceof PDFName ? v.decodeText() : v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
  if (name === undefined) return undefined;
  const hit = named.get(name);
  return hit && hit !== d ? resolveDest(ctx, hit, named) : undefined;
}

/** The document's named destinations: the Dests name tree, and the older Dests dictionary. */
function namedDestinations(doc: PDFDocument): Map<string, PDFObject> {
  const out = new Map<string, PDFObject>();
  const ctx = doc.context;
  const old = doc.catalog.lookupMaybe(PDFName.of("Dests"), PDFDict);
  if (old) for (const [k, v] of old.entries()) out.set(k.decodeText(), v);
  const tree = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict)?.lookupMaybe(PDFName.of("Dests"), PDFDict);
  const walk = (node: PDFDict, depth: number) => {
    const names = node.lookupMaybe(PDFName.of("Names"), PDFArray);
    if (names)
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const k = names.lookup(i);
        if (k instanceof PDFString || k instanceof PDFHexString) out.set(k.decodeText(), names.get(i + 1));
      }
    if (depth < 30) for (const kid of node.lookupMaybe(PDFName.of("Kids"), PDFArray)?.asArray() ?? []) {
      const n = ctx.lookup(kid);
      if (n instanceof PDFDict) walk(n, depth + 1);
    }
  };
  if (tree) walk(tree, 0);
  return out;
}

/**
 * The form fields of copied pages, made fields of the target: each field's top (its widget or
 * the field above it) joins the target's form, renamed where a field there has the name already,
 * with the source form's defaults (fonts, text look) where the target has none. Widgets of a
 * field left on pages not copied are left out.
 */
function carryFields(target: PDFDocument, src: PDFDocument, copied: PDFPage[]) {
  const tctx = target.context;
  const ACRO = PDFName.of("AcroForm");
  const FIELDS = PDFName.of("Fields");
  const T = PDFName.of("T");
  const srcForm = src.catalog.lookupMaybe(ACRO, PDFDict);
  let form = target.catalog.lookupMaybe(ACRO, PDFDict);
  if (!form) {
    form = tctx.obj({}) as PDFDict;
    target.catalog.set(ACRO, tctx.register(form));
  }
  if (!form.lookupMaybe(FIELDS, PDFArray)) form.set(FIELDS, tctx.obj([]));
  const fields = form.lookupMaybe(FIELDS, PDFArray)!;
  if (srcForm) {
    const copier = PDFObjectCopier.for(src.context, tctx);
    for (const key of ["DA", "Q", "NeedAppearances"]) {
      const v = srcForm.get(PDFName.of(key));
      if (v !== undefined && form.get(PDFName.of(key)) === undefined) form.set(PDFName.of(key), copier.copy(v));
    }
    // Default fonts: the target's, with the source's added under names it doesn't use yet.
    const dr = srcForm.lookupMaybe(PDFName.of("DR"), PDFDict);
    if (dr) {
      let tdr = form.lookupMaybe(PDFName.of("DR"), PDFDict);
      if (!tdr) form.set(PDFName.of("DR"), (tdr = tctx.obj({}) as PDFDict));
      for (const [kind, sub] of dr.entries()) {
        const s = src.context.lookup(sub);
        if (!(s instanceof PDFDict)) continue;
        let t = tdr.lookupMaybe(kind, PDFDict);
        if (!t) tdr.set(kind, (t = tctx.obj({}) as PDFDict));
        for (const [name, v] of s.entries()) if (t.get(name) === undefined) t.set(name, copier.copy(v));
      }
    }
  }
  const on = new Set<string>();
  for (const p of copied) for (const r of p.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? []) on.add(r.toString());
  const nameOf = (d: PDFDict) => {
    const t = d.lookup(T);
    return t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : undefined;
  };
  const taken = new Set<string>();
  for (const r of fields.asArray()) {
    const d = tctx.lookup(r);
    const n = d instanceof PDFDict ? nameOf(d) : undefined;
    if (n !== undefined) taken.add(n);
  }
  const listed = new Set(fields.asArray().map((r) => r.toString()));
  // Each copied widget's field, up to its top.
  const tops = new Map<string, PDFRef>();
  for (const p of copied)
    for (const r of p.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? []) {
      const a = tctx.lookup(r);
      if (!(a instanceof PDFDict) || a.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString() !== "/Widget") continue;
      let ref = r as PDFRef;
      let d: PDFDict = a;
      for (let k = 0; k < 50; k++) {
        const up = d.get(PDFName.of("Parent"));
        if (!(up instanceof PDFRef)) break;
        const u = tctx.lookup(up);
        if (!(u instanceof PDFDict)) break;
        [ref, d] = [up, u];
      }
      tops.set(ref.toString(), ref);
    }
  // Widgets of these fields that aren't on a copied page are left out of their field.
  const prune = (d: PDFDict, depth: number) => {
    const kids = d.lookupMaybe(PDFName.of("Kids"), PDFArray);
    if (!kids || depth > 20) return;
    const keep = kids.asArray().filter((k) => {
      const kd = tctx.lookup(k);
      if (!(kd instanceof PDFDict)) return false;
      if (kd.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString() === "/Widget") return on.has(k.toString());
      prune(kd, depth + 1);
      return true;
    });
    d.set(PDFName.of("Kids"), tctx.obj(keep));
  };
  for (const ref of tops.values()) {
    if (listed.has(ref.toString())) continue;
    const d = tctx.lookup(ref) as PDFDict;
    prune(d, 0);
    const name = nameOf(d);
    if (name !== undefined && taken.has(name)) {
      let n = 2;
      while (taken.has(`${name}_${n}`)) n++;
      d.set(T, PDFString.of(`${name}_${n}`));
      taken.add(`${name}_${n}`);
    } else if (name !== undefined) taken.add(name);
    fields.push(ref);
    listed.add(ref.toString());
  }
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
