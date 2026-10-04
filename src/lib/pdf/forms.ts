/** AcroForm filling and flattening (fields and annotations). */
import {
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFTextField,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from "@cantoo/pdf-lib";
import { pdfOut, saveDoc, stem, type OutFile, type PDFDocument } from "./core";
import { FontSet } from "./fonts";
import { open, type Src } from "./pages";

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
  // Standard fonts only cover WinAnsi; switch to an embedded Unicode font when needed (₹, Hindi…).
  if (Object.values(values).some((v) => !isWinAnsi(v))) form.updateFieldAppearances(await fonts.font("sans/r"));
  else form.updateFieldAppearances();
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
        if (needsUnicode) form.updateFieldAppearances(await new FontSet(doc).font("sans/r"));
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
