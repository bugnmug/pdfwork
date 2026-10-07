/** AcroForm filling and flattening (fields and annotations). */
import {
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFString,
  PDFTextField,
  TextAlignment,
  beginMarkedContent,
  beginText,
  clip,
  concatTransformationMatrix,
  drawObject,
  endMarkedContent,
  endPath,
  endText,
  fill,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingCmykColor,
  setFillingGrayscaleColor,
  setFillingRgbColor,
  setFontAndSize,
  setLineWidth,
  setStrokingCmykColor,
  setStrokingGrayscaleColor,
  setStrokingRgbColor,
  stroke,
  type PDFForm,
  type PDFOperator,
} from "@cantoo/pdf-lib";
import { pdfOut, saveDoc, stem, type OutFile, type PDFDocument } from "./core";
import { FontSet, splitRuns } from "./fonts";
import { open, type Src } from "./pages";
import { showOps } from "./textops";

export type FieldInfo = {
  name: string;
  kind: "text" | "multiline" | "checkbox" | "radio" | "dropdown" | "list" | "button" | "signature" | "other";
  value: string;
  options?: string[];
  readOnly: boolean;
  required: boolean;
  maxLength?: number;
  page?: number;
};

export async function listFields(src: Src): Promise<FieldInfo[]> {
  const doc = await open(src);
  let form;
  try {
    form = doc.getForm();
  } catch {
    return [];
  }
  const pages = doc.getPages();
  // Widgets often lack /P, so also map every annotation reference to its page.
  const annotPage = new Map<string, number>();
  pages.forEach((p, i) => {
    const annots = p.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) {
      const r = annots.get(k);
      if (r instanceof PDFRef) annotPage.set(r.toString(), i);
    }
  });
  const pageOf = (field: { acroField: { getWidgets(): { P(): PDFRef | undefined; dict: unknown }[] } }) => {
    const w = field.acroField.getWidgets()[0];
    if (!w) return undefined;
    const ref = w.P();
    const idx = ref ? pages.findIndex((p) => p.ref === ref) : -1;
    if (idx >= 0) return idx;
    const wref = doc.context.getObjectRef(w.dict as never);
    const hit = wref ? annotPage.get(wref.toString()) : undefined;
    return hit;
  };
  return form.getFields().map((f) => {
    const base = { name: f.getName(), readOnly: f.isReadOnly(), required: f.isRequired(), page: pageOf(f as never) };
    try {
      if (f instanceof PDFTextField)
        return { ...base, kind: f.isMultiline() ? "multiline" : "text", value: f.getText() ?? "", maxLength: f.getMaxLength() } as FieldInfo;
      if (f instanceof PDFCheckBox) return { ...base, kind: "checkbox", value: f.isChecked() ? "true" : "false" } as FieldInfo;
      if (f instanceof PDFRadioGroup) return { ...base, kind: "radio", value: f.getSelected() ?? "", options: f.getOptions() } as FieldInfo;
      if (f instanceof PDFDropdown) return { ...base, kind: "dropdown", value: f.getSelected()[0] ?? "", options: f.getOptions() } as FieldInfo;
      if (f instanceof PDFOptionList) return { ...base, kind: "list", value: f.getSelected().join("\n"), options: f.getOptions() } as FieldInfo;
    } catch {
      /* fall through */
    }
    // instanceof, not constructor names: production builds rename classes.
    const kind = f instanceof PDFSignature ? "signature" : f instanceof PDFButton ? "button" : "other";
    return { ...base, kind, value: "" } as FieldInfo;
  });
}

export async function fillForm(src: Src, values: Record<string, string>, opts: { flatten?: boolean } = {}): Promise<OutFile> {
  const doc = await open(src);
  const form = doc.getForm();
  const fonts = new FontSet(doc);
  let filled = 0;
  for (const f of form.getFields()) {
    const v = values[f.getName()];
    if (v === undefined) continue;
    try {
      if (f instanceof PDFTextField) {
        const max = f.getMaxLength();
        f.setText(max ? v.slice(0, max) : v);
      } else if (f instanceof PDFCheckBox) {
        if (v === "true") f.check();
        else f.uncheck();
      } else if (f instanceof PDFRadioGroup) {
        if (v) f.select(v);
        else f.clear();
      } else if (f instanceof PDFDropdown) {
        if (v) f.select(v);
        else f.clear();
      } else if (f instanceof PDFOptionList) {
        const sel = v.split("\n").filter(Boolean);
        if (sel.length) f.select(sel);
        else f.clear();
      } else continue;
      filled++;
    } catch {
      /* incompatible value: skip */
    }
  }
  // Standard fonts only cover WinAnsi; switch to an embedded Unicode font when needed (₹, Hindi…),
  // and draw text that needs more than one font (Hindi with English) run by run.
  if (Object.values(values).some((v) => !isWinAnsi(v))) {
    form.updateFieldAppearances(await fonts.font("sans/r"));
    await drawUnicodeFields(doc, form, fonts);
  } else form.updateFieldAppearances();
  if (opts.flatten) form.flatten({ updateFieldAppearances: false });
  return pdfOut(`${stem(src.name)}-filled.pdf`, await saveDoc(doc), `${filled} field${filled === 1 ? "" : "s"} filled${opts.flatten ? " · flattened" : ""}`);
}

/**
 * Flatten: bake form fields and annotation appearances (comments, stamps,
 * highlights, ink, signatures) into the page content so they print the same
 * everywhere and can no longer be edited.
 */
export async function flattenPdf(src: Src, opts: { forms?: boolean; annotations?: boolean; keepLinks?: boolean } = {}): Promise<OutFile> {
  const doc = await open(src);
  let fields = 0;
  if (opts.forms !== false) {
    try {
      const form = doc.getForm();
      fields = form.getFields().length;
      if (fields) {
        const needsUnicode = form.getFields().some((f) => f instanceof PDFTextField && !isWinAnsi(f.getText() ?? ""));
        if (needsUnicode) {
          const fonts = new FontSet(doc);
          form.updateFieldAppearances(await fonts.font("sans/r"));
          await drawUnicodeFields(doc, form, fonts);
        }
        form.flatten({ updateFieldAppearances: !needsUnicode });
      }
    } catch {
      /* no AcroForm */
    }
    doc.catalog.delete(PDFName.of("AcroForm"));
  }
  const annots = opts.annotations !== false ? flattenAnnotations(doc, opts.keepLinks !== false) : 0;
  return pdfOut(`${stem(src.name)}-flattened.pdf`, await saveDoc(doc), `${fields} field${fields === 1 ? "" : "s"}, ${annots} annotation${annots === 1 ? "" : "s"} flattened`);
}

/** A colour from a widget's /MK entry (gray, RGB or CMYK components), as fill or stroke operators. */
function colourOps(c: number[] | undefined, stroking: boolean): PDFOperator[] | null {
  if (!c?.length) return null;
  if (c.length === 1) return [stroking ? setStrokingGrayscaleColor(c[0]) : setFillingGrayscaleColor(c[0])];
  if (c.length === 3) return [stroking ? setStrokingRgbColor(c[0], c[1], c[2]) : setFillingRgbColor(c[0], c[1], c[2])];
  if (c.length === 4) return [stroking ? setStrokingCmykColor(c[0], c[1], c[2], c[3]) : setFillingCmykColor(c[0], c[1], c[2], c[3])];
  return null;
}

/** Text colour from a default appearance string ("/Helv 11 Tf 0 g", "... 0.2 0.3 0.4 rg"). */
function daColour(da: string): PDFOperator {
  const rgb = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+rg\b/.exec(da);
  if (rgb) return setFillingRgbColor(+rgb[1], +rgb[2], +rgb[3]);
  const k = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+k\b/.exec(da);
  if (k) return setFillingCmykColor(+k[1], +k[2], +k[3], +k[4]);
  const g = /(-?[\d.]+)\s+g\b/.exec(da);
  return setFillingGrayscaleColor(g ? +g[1] : 0);
}

/**
 * Appearances for text fields holding characters beyond WinAnsi. pdf-lib draws a field in one
 * font, and no single font has both Hindi and English letters, so these are drawn here run by
 * run, each in a font that has its letters (with ActualText, so the words copy correctly), at
 * the field's size, colour and alignment, over its background and border. Combed and turned
 * fields keep pdf-lib's appearance.
 */
async function drawUnicodeFields(doc: PDFDocument, form: PDFForm, fonts: FontSet) {
  const ASC = 1.069;
  const DESC = 0.293;
  const daObj = form.acroForm.dict.lookup(PDFName.of("DA"));
  const formDa = daObj instanceof PDFString || daObj instanceof PDFHexString ? daObj.decodeText() : undefined;
  for (const f of form.getFields()) {
    if (!(f instanceof PDFTextField) || f.isCombed()) continue;
    const text = f.getText() ?? "";
    if (!text || isWinAnsi(text)) continue;
    const runs = await splitRuns(text);
    for (const w of f.acroField.getWidgets()) {
      const mk = w.getAppearanceCharacteristics();
      if ((mk?.getRotation() ?? 0) % 360) continue;
      const { width, height } = w.getRectangle();
      if (width <= 0 || height <= 0) continue;
      const da = w.getDefaultAppearance() ?? f.acroField.getDefaultAppearance() ?? formDa ?? "/Helv 0 Tf 0 g";
      const bw = mk?.getBorderColor()?.length ? (w.getBorderStyle()?.getWidth() ?? 1) : 0;
      const pad = bw + 2;
      const inner = width - pad * 2;
      const natural = await fonts.width(text.replace(/\s*\n\s*/g, " "), 1);
      const daSize = Number(/(-?[\d.]+)\s+Tf\b/.exec(da)?.[1] ?? 0);
      const multiline = f.isMultiline();
      // Automatic size (0): fit the height, then the width (one line), as viewers do.
      let size = daSize > 0 ? daSize : multiline ? 12 : Math.min(12, (height - pad * 2) / (ASC + DESC));
      if (daSize <= 0 && !multiline && natural > 0) size = Math.min(size, inner / natural);
      size = Math.max(4, size);
      const lines = multiline ? await fonts.wrap(text, size, inner) : [text.replace(/\s*\n\s*/g, " ")];
      const ops: PDFOperator[] = [beginMarkedContent("Tx"), pushGraphicsState()];
      const bg = colourOps(mk?.getBackgroundColor(), false);
      if (bg) ops.push(...bg, rectangle(0, 0, width, height), fill());
      const bc = colourOps(mk?.getBorderColor(), true);
      if (bc && bw > 0) ops.push(...bc, setLineWidth(bw), rectangle(bw / 2, bw / 2, width - bw, height - bw), stroke());
      ops.push(rectangle(bw, bw, width - bw * 2, height - bw * 2), clip(), endPath(), beginText(), daColour(da));
      const names = new Map<string, string>();
      const resources: Record<string, PDFRef> = {};
      const lineHeight = size * 1.2;
      let y = multiline ? height - pad - ASC * size : (height - (ASC + DESC) * size) / 2 + DESC * size;
      let lastX = 0;
      let lastY = 0;
      for (const line of lines) {
        const lineRuns = line === text ? runs : await splitRuns(line);
        const lw = (await fonts.width(line, 1)) * size;
        const align = f.getAlignment();
        const x = align === TextAlignment.Center ? (width - lw) / 2 : align === TextAlignment.Right ? width - pad - lw : pad;
        ops.push(moveText(x - lastX, y - lastY));
        lastX = x;
        lastY = y;
        for (const r of lineRuns) {
          const font = await fonts.font(r.key);
          let name = names.get(r.key);
          if (!name) {
            name = `F${names.size}`;
            names.set(r.key, name);
            resources[name] = font.ref;
          }
          ops.push(setFontAndSize(name, size), ...showOps(font, r.text));
        }
        y -= lineHeight;
      }
      ops.push(endText(), popGraphicsState(), endMarkedContent());
      const stream = doc.context.formXObject(ops, { BBox: [0, 0, width, height], Resources: { Font: doc.context.obj(resources) } });
      w.setNormalAppearance(doc.context.register(stream));
    }
  }
}

function flattenAnnotations(doc: PDFDocument, keepLinks: boolean): number {
  let count = 0;
  const ctx = doc.context;
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;
    const keep: unknown[] = [];
    const ops = [];
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const a = ctx.lookup(ref);
      if (!(a instanceof PDFDict)) continue;
      const sub = a.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
      if (sub === "/Link" && keepLinks) {
        keep.push(ref);
        continue;
      }
      if (sub === "/Popup" || sub === "/Widget") continue; // widgets were handled by the form flattener
      const flags = a.lookupMaybe(PDFName.of("F"), PDFNumber)?.asNumber() ?? 0;
      if (flags & 2 || flags & 32) continue; // hidden / no-view
      const stream = appearanceStream(a);
      const rect = a.lookupMaybe(PDFName.of("Rect"), PDFArray);
      if (!stream || !rect) continue;
      const streamRef = stream.ref ?? ctx.register(stream.stream);
      const bbox = numArr(stream.stream.dict.lookupMaybe(PDFName.of("BBox"), PDFArray)) ?? [0, 0, 1, 1];
      const m = numArr(stream.stream.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray)) ?? [1, 0, 0, 1, 0, 0];
      const r = numArr(rect)!;
      const [rx1, ry1, rx2, ry2] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
      const pts = [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[1]],
        [bbox[0], bbox[3]],
        [bbox[2], bbox[3]],
      ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const tx1 = Math.min(...pts.map((p) => p[0]));
      const ty1 = Math.min(...pts.map((p) => p[1]));
      const tx2 = Math.max(...pts.map((p) => p[0]));
      const ty2 = Math.max(...pts.map((p) => p[1]));
      const sx = tx2 - tx1 > 1e-6 ? (rx2 - rx1) / (tx2 - tx1) : 1;
      const sy = ty2 - ty1 > 1e-6 ? (ry2 - ry1) / (ty2 - ty1) : 1;
      const name = page.node.newXObject("FlatAnnot", streamRef);
      ops.push(pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, rx1 - tx1 * sx, ry1 - ty1 * sy), drawObject(name), popGraphicsState());
      count++;
    }
    if (ops.length) page.pushOperators(...ops);
    page.node.set(PDFName.of("Annots"), ctx.obj(keep as never[]));
  }
  return count;
}

function appearanceStream(a: PDFDict): { stream: PDFStream; ref?: PDFRef } | null {
  const ap = a.lookupMaybe(PDFName.of("AP"), PDFDict);
  if (!ap) return null;
  const nRaw = ap.get(PDFName.of("N"));
  const n = a.context.lookup(nRaw);
  if (n instanceof PDFStream || n instanceof PDFRawStream) return { stream: n, ref: nRaw instanceof PDFRef ? nRaw : undefined };
  if (n instanceof PDFDict) {
    const as = a.lookupMaybe(PDFName.of("AS"), PDFName);
    const pickRaw = as ? n.get(as) : undefined;
    const pick = pickRaw ? a.context.lookup(pickRaw) : undefined;
    if (pick instanceof PDFStream) return { stream: pick, ref: pickRaw instanceof PDFRef ? pickRaw : undefined };
  }
  return null;
}

function numArr(arr: PDFArray | undefined): number[] | null {
  if (!arr) return null;
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.lookup(i);
    out.push(v instanceof PDFNumber ? v.asNumber() : 0);
  }
  return out;
}

const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
export function isWinAnsi(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(ch) || c === 0x0a || c === 0x0d) continue;
    return false;
  }
  return true;
}
