/**
 * PDF/A: files that will open the same way decades from now. Everything they draw must be in the
 * file itself (fonts embedded), nothing in them may act (scripts, launch actions), every
 * annotation prints with its own appearance, colours are described by the file's colour profile,
 * and PDF/A-1 has no transparency. pdf-lib's convertToPDFA writes the metadata, colour profile
 * and identifiers; the content is put right here:
 *
 * - a font the file only names (Helvetica, Arial, Times, Courier, Calibri, Cambria, Georgia) gets
 *   a font with the same letter widths embedded, so the text stays text and stays in place;
 * - scripts and actions PDF/A doesn't allow are removed, and embedded files (PDF/A-3 keeps them);
 * - annotations are set to print; check boxes and radio buttons drawn with the Zapf Dingbats
 *   symbol font get the same mark from an embedded font;
 * - a page that still can't comply (a font that can't be embedded, transparency in PDF/A-1, CMYK
 *   colours under the RGB colour profile) is redrawn as an image, with its words kept as
 *   invisible, searchable text.
 */
import fontkit from "@cantoo/fontkit";
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  beginMarkedContent,
  beginText,
  endMarkedContent,
  endText,
  fill,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingGrayscaleColor,
  setFillingRgbColor,
  setFontAndSize,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  type PDFContext,
  type PDFOperator,
} from "@cantoo/pdf-lib";
import { dropUnreferenced, pdfOut, saveDoc, stem, tick, type OutFile, type PDFDocument, type ProgressFn } from "./core";
import { resourcesOf, streamBytes, tokenize } from "./contentstream";
import { FontSet, fontBytes, matchFace, type Face } from "./fonts";
import { STANDARD, unicodeOf, winAnsi } from "./glyphnames";
import { open, type Src } from "./pages";
import { pageText, renderPage, withPdfjs } from "./pdfjs";
import { redrawPage } from "./raster";
import { showOps } from "./textops";

export type PdfALevel = "1B" | "2B" | "3B";

const N = (s: string) => PDFName.of(s);
const nameOf = (o: unknown) => (o instanceof PDFName ? o.decodeText() : undefined);
const look = (ctx: PDFContext, o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
const num = (o: unknown, d = 0) => (o instanceof PDFNumber ? o.asNumber() : d);
const isStream = (o: unknown): o is PDFRawStream | PDFStream => o instanceof PDFRawStream || o instanceof PDFStream;

/* --------------------------------------------------------------------------- walking the file */

type PageNeeds = { fonts: Set<PDFDict>; transparency: boolean; cmyk: boolean };

/** What one page draws with: its fonts, and whether it uses transparency or device CMYK colour. */
function pageNeeds(doc: PDFDocument, pageIndex: number): PageNeeds {
  const ctx = doc.context;
  const out: PageNeeds = { fonts: new Set(), transparency: false, cmyk: false };
  const seen = new Set<unknown>();
  const isCmyk = (cs: unknown): boolean => {
    const c = look(ctx, cs);
    if (nameOf(c) === "DeviceCMYK") return true;
    if (c instanceof PDFArray) {
      const kind = nameOf(look(ctx, c.get(0)));
      if (kind === "Indexed") return isCmyk(c.get(1));
      if (kind === "Separation" || kind === "DeviceN") return isCmyk(c.get(kind === "Separation" ? 2 : 2));
    }
    return false;
  };
  const content = (bytes: Uint8Array, res: PDFDict | undefined) => {
    const toks = tokenize(bytes);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.t === "op" && (t.v === "k" || t.v === "K")) out.cmyk = true;
      else if (t.t === "op" && (t.v === "cs" || t.v === "CS")) {
        const n = toks[i - 1]?.t === "name" ? toks[i - 1].v : "";
        const named = res ? look(ctx, (look(ctx, res.get(N("ColorSpace"))) as PDFDict | undefined)?.get?.(N(n))) : undefined;
        if (n === "DeviceCMYK" || (named !== undefined && isCmyk(named))) out.cmyk = true;
      } else if (t.t === "inline") {
        const head = new TextDecoder("latin1").decode(bytes.subarray(t.s, Math.min(t.e, t.s + 400)));
        if (/\/(CS|ColorSpace)\s*\/(CMYK|DeviceCMYK)/.test(head)) out.cmyk = true;
      }
    }
  };
  const resources = (res: PDFDict | undefined, depth: number) => {
    if (!res || depth > 10 || seen.has(res)) return;
    seen.add(res);
    const fonts = look(ctx, res.get(N("Font")));
    if (fonts instanceof PDFDict)
      for (const [, f] of fonts.entries()) {
        const fd = look(ctx, f);
        if (!(fd instanceof PDFDict)) continue;
        out.fonts.add(fd);
        if (nameOf(look(ctx, fd.get(N("Subtype")))) === "Type3") resources(resourcesOf(fd, ctx), depth + 1);
      }
    const gs = look(ctx, res.get(N("ExtGState")));
    if (gs instanceof PDFDict)
      for (const [, g] of gs.entries()) {
        const gd = look(ctx, g);
        if (!(gd instanceof PDFDict)) continue;
        const sm = look(ctx, gd.get(N("SMask")));
        const bm = nameOf(look(ctx, gd.get(N("BM"))));
        if (num(look(ctx, gd.get(N("CA"))), 1) < 1 || num(look(ctx, gd.get(N("ca"))), 1) < 1 || (sm !== undefined && nameOf(sm) !== "None") || (bm && bm !== "Normal" && bm !== "Compatible")) out.transparency = true;
      }
    const cs = look(ctx, res.get(N("ColorSpace")));
    if (cs instanceof PDFDict) for (const [, c] of cs.entries()) if (isCmyk(c)) out.cmyk = true;
    const xo = look(ctx, res.get(N("XObject")));
    if (xo instanceof PDFDict)
      for (const [, x] of xo.entries()) {
        const s = look(ctx, x);
        if (!isStream(s) || seen.has(s)) continue;
        seen.add(s);
        const sub = nameOf(look(ctx, s.dict.get(N("Subtype"))));
        if (sub === "Image") {
          if (s.dict.has(N("SMask"))) out.transparency = true;
          if (isCmyk(s.dict.get(N("ColorSpace")))) out.cmyk = true;
        } else if (sub === "Form") {
          const grp = look(ctx, s.dict.get(N("Group")));
          if (grp instanceof PDFDict && nameOf(look(ctx, grp.get(N("S")))) === "Transparency") out.transparency = true;
          try {
            content(streamBytes(ctx, s), resourcesOf(s.dict, ctx) ?? res);
          } catch {
            /* unreadable form */
          }
          resources(resourcesOf(s.dict, ctx), depth + 1);
        }
      }
    const pats = look(ctx, res.get(N("Pattern")));
    if (pats instanceof PDFDict)
      for (const [, pt] of pats.entries()) {
        const p = look(ctx, pt);
        if (isStream(p)) resources(resourcesOf(p.dict, ctx), depth + 1);
        const sh = p instanceof PDFDict ? look(ctx, p.get(N("Shading"))) : isStream(p) ? undefined : undefined;
        if (sh instanceof PDFDict && isCmyk(sh.get(N("ColorSpace")))) out.cmyk = true;
      }
    const shs = look(ctx, res.get(N("Shading")));
    if (shs instanceof PDFDict)
      for (const [, sh] of shs.entries()) {
        const sd = look(ctx, sh);
        const d = isStream(sd) ? sd.dict : sd;
        if (d instanceof PDFDict && isCmyk(d.get(N("ColorSpace")))) out.cmyk = true;
      }
  };
  const page = doc.getPage(pageIndex);
  const res = resourcesOf(page.node, ctx) ?? (page.node.Resources() as PDFDict | undefined);
  const grp = look(ctx, page.node.get(N("Group")));
  if (grp instanceof PDFDict && nameOf(look(ctx, grp.get(N("S")))) === "Transparency") out.transparency = true;
  try {
    const contents = look(ctx, page.node.get(N("Contents")));
    const parts = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    for (const c of parts) content(streamBytes(ctx, c), res);
  } catch {
    /* unreadable content */
  }
  resources(res, 0);
  // Annotation appearances draw with fonts too.
  for (const a of page.node.lookupMaybe(N("Annots"), PDFArray)?.asArray() ?? []) {
    const ad = look(ctx, a);
    if (!(ad instanceof PDFDict)) continue;
    for (const s of apStreams(ctx, ad)) resources(resourcesOf(s.dict, ctx), 1);
  }
  return out;
}

/** The appearance streams of an annotation (normal, rollover, down; each state). */
function apStreams(ctx: PDFContext, a: PDFDict): (PDFRawStream | PDFStream)[] {
  const ap = look(ctx, a.get(N("AP")));
  if (!(ap instanceof PDFDict)) return [];
  const out: (PDFRawStream | PDFStream)[] = [];
  for (const k of ["N", "R", "D"]) {
    const v = look(ctx, ap.get(N(k)));
    if (isStream(v)) out.push(v);
    else if (v instanceof PDFDict) for (const [, s] of v.entries()) if (isStream(look(ctx, s))) out.push(look(ctx, s) as PDFRawStream);
  }
  return out;
}

const embedded = (ctx: PDFContext, f: PDFDict): boolean => {
  const sub = nameOf(look(ctx, f.get(N("Subtype"))));
  if (sub === "Type3") return true;
  let d = f;
  if (sub === "Type0") {
    const kids = look(ctx, f.get(N("DescendantFonts")));
    const k = kids instanceof PDFArray ? look(ctx, kids.get(0)) : undefined;
    if (!(k instanceof PDFDict)) return false;
    d = k;
  }
  const fd = look(ctx, d.get(N("FontDescriptor")));
  return fd instanceof PDFDict && (fd.has(N("FontFile")) || fd.has(N("FontFile2")) || fd.has(N("FontFile3")));
};

/* ------------------------------------------------------------------------- embedding fonts */

type Fk = {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  hasGlyphForCodePoint(cp: number): boolean;
  glyphForCodePoint(cp: number): { advanceWidth: number };
  postscriptName: string;
};

/**
 * Embeds a font with the same widths as the one a simple font dictionary names: the TrueType
 * program goes in, with its own widths for every code and an encoding PDF/A accepts (WinAnsi,
 * with differences where the font's encoding differs). Returns false when the font can't be
 * served this way.
 */
async function embedSubstitute(doc: PDFDocument, f: PDFDict, face: Face, cache: Map<string, Promise<{ ref: PDFRef; fk: Fk }>>, level: PdfALevel): Promise<boolean> {
  const ctx = doc.context;
  const base = nameOf(look(ctx, f.get(N("BaseFont")))) ?? "";
  const bold = /bold|black|heavy|semibold|demi/i.test(base) || false;
  const italic = /italic|oblique/i.test(base);
  const key = `${face}/${bold && italic ? "bi" : bold ? "b" : italic ? "i" : "r"}`;
  let job = cache.get(key);
  if (!job) {
    job = fontBytes(key).then((bytes) => ({ ref: ctx.register(ctx.flateStream(bytes, { Length1: bytes.length })), fk: fontkit.create(bytes) as unknown as Fk }));
    cache.set(key, job);
  }
  const { ref, fk } = await job;
  // The codes' glyph names: the font's encoding (base encoding and differences).
  const encRaw = look(ctx, f.get(N("Encoding")));
  const encName = nameOf(encRaw) ?? (encRaw instanceof PDFDict ? nameOf(look(ctx, encRaw.get(N("BaseEncoding")))) : undefined);
  const names = new Map(winAnsi().byCode);
  if (!encName || encName === "StandardEncoding") for (const [c, n] of Object.entries(STANDARD)) names.set(Number(c), n);
  if (encRaw instanceof PDFDict) {
    const diff = look(ctx, encRaw.get(N("Differences")));
    if (diff instanceof PDFArray) {
      let code = 0;
      for (const v0 of diff.asArray()) {
        const v = look(ctx, v0);
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) names.set(code++, v.decodeText());
      }
    }
  }
  // Codes whose glyph the font lacks would draw nothing: then this font can't stand in.
  // PDF/A-1 allows plain WinAnsi only for these fonts (no differences): codes take its glyphs.
  const win = winAnsi().byCode;
  if (level === "1B") for (const c of [...names.keys()]) names.set(c, win.get(c) ?? "");
  const scale = 1000 / fk.unitsPerEm;
  const widths: number[] = [];
  const diffs: (number | PDFName)[] = [];
  let last = -2;
  for (let c = 0; c < 256; c++) {
    const name = names.get(c);
    const cp = name ? unicodeOf(name) : undefined;
    widths.push(cp !== undefined && fk.hasGlyphForCodePoint(cp) ? Math.round(fk.glyphForCodePoint(cp).advanceWidth * scale) : 0);
    if (name && win.get(c) !== name && unicodeOf(name) !== undefined) {
      if (c !== last + 1) diffs.push(c);
      diffs.push(N(name));
      last = c;
    }
  }
  const flags = (face === "mmono" ? 1 : 0) | (face === "mserif" || face === "caladea" || face === "gelasio" ? 2 : 0) | 32 | (italic ? 64 : 0);
  const desc = ctx.obj({
    Type: "FontDescriptor",
    FontName: N(fk.postscriptName || base || "Font"),
    Flags: flags,
    FontBBox: [fk.bbox.minX * scale, fk.bbox.minY * scale, fk.bbox.maxX * scale, fk.bbox.maxY * scale].map(Math.round),
    ItalicAngle: fk.italicAngle || 0,
    Ascent: Math.round(fk.ascent * scale),
    Descent: Math.round(fk.descent * scale),
    CapHeight: Math.round((fk.capHeight || fk.ascent * 0.7) * scale),
    StemV: bold ? 120 : 80,
    FontFile2: ref,
  });
  f.set(N("Subtype"), N("TrueType"));
  f.set(N("BaseFont"), N(fk.postscriptName || base));
  f.set(N("FirstChar"), PDFNumber.of(0));
  f.set(N("LastChar"), PDFNumber.of(255));
  f.set(N("Widths"), ctx.obj(widths));
  f.set(N("FontDescriptor"), ctx.register(desc));
  f.set(N("Encoding"), diffs.length ? ctx.obj({ Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: diffs }) : N("WinAnsiEncoding"));
  f.delete(N("ToUnicode"));
  return true;
}

/* --------------------------------------------------------------------- annotations and actions */

const BAD_ACTIONS = new Set(["JavaScript", "Launch", "Sound", "Movie", "ResetForm", "ImportData", "Hide", "SetOCGState", "Rendition", "Trans", "GoTo3DView"]);

/** Takes out what PDF/A forbids from active content; returns how many things were removed. */
function removeActive(doc: PDFDocument, level: PdfALevel): number {
  const ctx = doc.context;
  const cat = doc.catalog;
  let n = 0;
  const drop = (d: PDFDict, k: string) => {
    if (d.has(N(k))) {
      d.delete(N(k));
      n++;
    }
  };
  drop(cat, "AA");
  const oa = look(ctx, cat.get(N("OpenAction")));
  if (oa instanceof PDFDict && BAD_ACTIONS.has(nameOf(look(ctx, oa.get(N("S")))) ?? "")) drop(cat, "OpenAction");
  const names = look(ctx, cat.get(N("Names")));
  if (names instanceof PDFDict) {
    drop(names, "JavaScript");
    if (level !== "3B") drop(names, "EmbeddedFiles");
  }
  const acro = look(ctx, cat.get(N("AcroForm")));
  if (acro instanceof PDFDict) {
    drop(acro, "XFA");
    acro.delete(N("NeedAppearances"));
    // Field actions (calculations, validation, formatting scripts).
    const fields = look(ctx, acro.get(N("Fields")));
    const visit = (o: unknown, depth: number) => {
      const d = look(ctx, o);
      if (!(d instanceof PDFDict) || depth > 30) return;
      drop(d, "AA");
      const kids = look(ctx, d.get(N("Kids")));
      if (kids instanceof PDFArray) for (const k of kids.asArray()) visit(k, depth + 1);
    };
    if (fields instanceof PDFArray) for (const f of fields.asArray()) visit(f, 0);
  }
  if (level === "1B") drop(cat, "OCProperties");
  for (const page of doc.getPages()) {
    drop(page.node, "AA");
    const annots = page.node.lookupMaybe(N("Annots"), PDFArray);
    if (!annots) continue;
    const keep: unknown[] = [];
    for (const r of annots.asArray()) {
      const a = look(ctx, r);
      if (!(a instanceof PDFDict)) continue;
      const sub = nameOf(look(ctx, a.get(N("Subtype")))) ?? "";
      if (["Movie", "Sound", "Screen", "3D", "RichMedia"].includes(sub) || (sub === "FileAttachment" && level !== "3B")) {
        n++;
        continue;
      }
      drop(a, "AA");
      const act = look(ctx, a.get(N("A")));
      if (act instanceof PDFDict && BAD_ACTIONS.has(nameOf(look(ctx, act.get(N("S")))) ?? "")) drop(a, "A");
      // Printed, and not hidden.
      if (sub !== "Popup") {
        const flags = num(look(ctx, a.get(N("F"))));
        const fixed = (flags | 4) & ~(1 | 2 | 32 | 256);
        if (fixed !== flags) a.set(N("F"), PDFNumber.of(fixed));
      }
      // An annotation that shows something needs its own appearance.
      if (!["Popup", "Link"].includes(sub) && !a.has(N("AP"))) {
        const r4 = look(ctx, a.get(N("Rect")));
        const rr = r4 instanceof PDFArray ? r4.asArray().map((v) => num(look(ctx, v))) : [0, 0, 0, 0];
        if (Math.abs(rr[2] - rr[0]) > 0 && Math.abs(rr[3] - rr[1]) > 0 && sub !== "Widget") {
          n++;
          continue;
        }
      }
      keep.push(r);
    }
    if (keep.length !== annots.size()) page.node.set(N("Annots"), ctx.obj(keep as never[]));
  }
  // Images must not ask to be smoothed.
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (isStream(obj) && obj.dict.has(N("Interpolate"))) obj.dict.delete(N("Interpolate"));
  }
  return n;
}

/** Zapf Dingbats marks of check boxes and radio buttons, as the same signs in an embedded font. */
const DINGBATS: Record<string, string> = { "4": "✔", "3": "✓", "8": "✘", "7": "✗", u: "◆", l: "●", n: "■", H: "★" };

/**
 * Redraws the "on" appearance of check boxes and radio buttons whose mark comes from Zapf
 * Dingbats (not embedded) with the same sign from DejaVu Sans, which is.
 */
async function redrawMarks(doc: PDFDocument, fonts: FontSet): Promise<number> {
  const ctx = doc.context;
  let n = 0;
  for (const page of doc.getPages()) {
    for (const r of page.node.lookupMaybe(N("Annots"), PDFArray)?.asArray() ?? []) {
      const a = look(ctx, r);
      if (!(a instanceof PDFDict) || nameOf(look(ctx, a.get(N("Subtype")))) !== "Widget") continue;
      const ap = look(ctx, a.get(N("AP")));
      if (!(ap instanceof PDFDict)) continue;
      const mk = look(ctx, a.get(N("MK")));
      const ca = mk instanceof PDFDict ? look(ctx, mk.get(N("CA"))) : undefined;
      const sign = DINGBATS[ca instanceof PDFString || ca instanceof PDFHexString ? ca.decodeText() : "4"] ?? "✔";
      for (const k of ["N", "D"]) {
        const states = look(ctx, ap.get(N(k)));
        if (!(states instanceof PDFDict)) continue;
        for (const [state, sref] of states.entries()) {
          const s = look(ctx, sref);
          if (!isStream(s) || state.decodeText() === "Off") continue;
          const fontsRes = look(ctx, resourcesOf(s.dict, ctx)?.get(N("Font")));
          const usesDingbats =
            fontsRes instanceof PDFDict &&
            fontsRes.entries().some(([, f]) => {
              const fd = look(ctx, f);
              return fd instanceof PDFDict && !embedded(ctx, fd);
            });
          if (!usesDingbats) continue;
          const bb = look(ctx, s.dict.get(N("BBox")));
          const box = bb instanceof PDFArray ? bb.asArray().map((v) => num(look(ctx, v))) : [0, 0, 12, 12];
          const w = Math.abs(box[2] - box[0]);
          const h = Math.abs(box[3] - box[1]);
          const font = await fonts.font("sym/r");
          const size = Math.min(w, h) * 0.8;
          const sw = font.widthOfTextAtSize(sign, size);
          const ops: PDFOperator[] = [beginMarkedContent("Tx"), pushGraphicsState()];
          const bg = mk instanceof PDFDict ? look(ctx, mk.get(N("BG"))) : undefined;
          if (bg instanceof PDFArray && bg.size() === 3) ops.push(setFillingRgbColor(...(bg.asArray().map((v) => num(look(ctx, v))) as [number, number, number])), rectangle(0, 0, w, h), fill());
          const bc = mk instanceof PDFDict ? look(ctx, mk.get(N("BC"))) : undefined;
          if (bc instanceof PDFArray && bc.size() === 3) ops.push(setStrokingRgbColor(...(bc.asArray().map((v) => num(look(ctx, v))) as [number, number, number])), setLineWidth(1), rectangle(0.5, 0.5, w - 1, h - 1), stroke());
          ops.push(beginText(), setFillingGrayscaleColor(0), setFontAndSize("F0", size), moveText((w - sw) / 2, (h - size * 0.72) / 2), ...showOps(font, sign), endText(), popGraphicsState(), endMarkedContent());
          const stream = ctx.formXObject(ops, { BBox: [0, 0, w, h], Resources: { Font: ctx.obj({ F0: font.ref }) } });
          states.set(state, ctx.register(stream));
          n++;
        }
      }
    }
  }
  return n;
}

/* ------------------------------------------------------------------------------- converting */

export async function toPdfA(src: Src, level: PdfALevel = "2B", onProgress?: ProgressFn): Promise<OutFile> {
  const doc = await open(src);
  const ctx = doc.context;
  const fonts = new FontSet(doc);
  onProgress?.(0.05, "Checking what the file needs");
  const removed = removeActive(doc, level);
  // Form fields without an appearance get one, drawn with an embedded font.
  try {
    const form = doc.getForm();
    const font = await fonts.font("msans/r");
    for (const field of form.getFields()) {
      const widgets = (field.acroField as unknown as { getWidgets(): { dict: PDFDict }[] }).getWidgets();
      if (widgets.some((w) => !w.dict.has(N("AP")))) (field as unknown as { defaultUpdateAppearances(f: unknown): void }).defaultUpdateAppearances?.(font);
    }
  } catch {
    /* no form, or a field pdf-lib can't draw */
  }
  const marks = await redrawMarks(doc, fonts);
  const n = doc.getPageCount();
  const needs = Array.from({ length: n }, (_, i) => pageNeeds(doc, i));
  // Fonts the file only names: a font with the same widths, when there is one.
  const cache = new Map<string, Promise<{ ref: PDFRef; fk: Fk }>>();
  const fixed = new Set<PDFDict>();
  const unfixable = new Set<PDFDict>();
  for (const nd of needs)
    for (const f of nd.fonts) {
      if (fixed.has(f) || unfixable.has(f) || embedded(ctx, f)) continue;
      const sub = nameOf(look(ctx, f.get(N("Subtype"))));
      const face = sub === "Type1" || sub === "TrueType" || sub === "MMType1" ? matchFace(nameOf(look(ctx, f.get(N("BaseFont"))))) : undefined;
      if (face && (await embedSubstitute(doc, f, face, cache, level).catch(() => false))) fixed.add(f);
      else unfixable.add(f);
    }
  // Pages that still can't comply are redrawn.
  const why = new Map<number, string>();
  needs.forEach((nd, i) => {
    if ([...nd.fonts].some((f) => unfixable.has(f))) why.set(i, "font");
    else if (level === "1B" && nd.transparency) why.set(i, "transparency");
    else if (nd.cmyk) why.set(i, "cmyk");
  });
  if (why.size) {
    await withPdfjs(
      src.bytes,
      async ({ pdf }) => {
        let k = 0;
        for (const i of why.keys()) {
          onProgress?.(0.1 + (0.8 * k++) / why.size, `Redrawing page ${i + 1}`);
          const page = await pdf.getPage(i + 1);
          const canvas = await renderPage(page, 300 / 72, { pixelBudget: 36e6 });
          const text = await pageText(page).catch(() => null);
          page.cleanup();
          await redrawPage(doc, i, canvas, text, fonts, { quality: 0.92 });
          canvas.width = canvas.height = 0;
          await tick();
        }
      },
      src.password,
    );
  }
  onProgress?.(0.92, "Writing PDF/A");
  try {
    (doc as unknown as { convertToPDFA(o: { conformance: string }): void }).convertToPDFA({ conformance: level });
  } catch (e) {
    throw new Error(`PDF/A conversion failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await dropUnreferenced(doc);
  const bytes = await saveDoc(doc, { objectStreams: level !== "1B" });
  const parts = [`PDF/A-${level[0]}b`];
  if (fixed.size) parts.push(`${fixed.size} font${fixed.size === 1 ? "" : "s"} embedded`);
  if (marks) parts.push(`${marks} check mark${marks === 1 ? "" : "s"} redrawn`);
  if (removed) parts.push(`${removed} script${removed === 1 ? "" : "s"}, action${removed === 1 ? "" : "s"} or attachment${removed === 1 ? "" : "s"} removed`);
  if (why.size) {
    const reasons = [...new Set(why.values())].map((r) => (r === "font" ? "fonts that can't be embedded" : r === "transparency" ? "transparency (not allowed in PDF/A-1)" : "print (CMYK) colours")).join(", ");
    parts.push(`${why.size} page${why.size === 1 ? "" : "s"} redrawn as images with searchable text (${reasons})`);
  }
  return pdfOut(`${stem(src.name)}-pdfa.pdf`, bytes, parts.join(" · "));
}
