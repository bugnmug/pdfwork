/**
 * Fonts for Office documents drawn straight to PDF (spreadsheet cells, slide
 * text): Office font names to the faces we ship (the common ones metric-
 * compatible), measured with the glyph advances PDF text will use, split into
 * runs by which face has each character, and drawn with fake bold or italic
 * where a face lacks the style.
 */
import fontkit from "@cantoo/fontkit";
import {
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setFontAndSize,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  setTextRenderingMode,
  PDFArray,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  type PDFFont,
  type PDFName,
  type PDFPage,
} from "@cantoo/pdf-lib";
import type { PDFDocument } from "./core";
import { faceFile, faceStack, isNeutral, wordFont, type Face } from "./docx/fonts";
import { fontBytes } from "./fonts";
import { showOps } from "./textops";

/** What TextKit needs to know about a font. */
export type FontSpec = { name: string; size: number; bold: boolean; italic: boolean };

type FkPath = { commands: { command: string; args: number[] }[] };
type Fk = {
  layout(s: string, features?: Record<string, boolean>): { glyphs: { advanceWidth: number; path: FkPath }[]; positions: { xAdvance: number }[] };
  unitsPerEm: number;
  hasGlyphForCodePoint(cp: number): boolean;
  glyphForCodePoint(cp: number): { advanceWidth: number };
  ascent: number;
  descent: number;
  underlinePosition: number;
  underlineThickness: number;
  "OS/2"?: { winAscent?: number; winDescent?: number };
};

export type Run = { text: string; key: string; fakeBold: boolean; fakeItalic: boolean };
export type OutlineSeg = { t: "M" | "L"; x: number; y: number } | { t: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number } | { t: "Z" };

const featuresFor = (key: string) => (key.startsWith("deva/") ? undefined : { liga: false, clig: false, calt: false, dlig: false });
const rgbParts = (hex: string): [number, number, number] => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255 || 0) as [number, number, number];

export class TextKit {
  private fk = new Map<string, Promise<Fk>>();
  private pdf = new Map<string, Promise<PDFFont>>();
  private widths = new Map<string, number>();
  private runCache = new Map<string, Run[]>();
  private keys = new WeakMap<PDFPage, Map<string, PDFName>>();

  constructor(private doc: PDFDocument) {
    doc.registerFontkit(fontkit as never);
  }

  parsed(key: string): Promise<Fk> {
    let p = this.fk.get(key);
    if (!p) {
      p = fontBytes(key).then((b) => fontkit.create(b as never) as unknown as Fk);
      this.fk.set(key, p);
    }
    return p;
  }

  embed(key: string): Promise<PDFFont> {
    let p = this.pdf.get(key);
    if (!p) {
      p = fontBytes(key).then((b) => this.doc.embedFont(b, { subset: true, features: featuresFor(key) }));
      this.pdf.set(key, p);
    }
    return p;
  }

  stack(f: FontSpec): Face[] {
    const w = wordFont(f.name);
    return faceStack(w.face, w.generic);
  }

  /** Text split by the first face in the stack that has each character. */
  async runs(text: string, f: FontSpec): Promise<Run[]> {
    const ck = `${f.name}|${f.bold ? 1 : 0}${f.italic ? 1 : 0}|${text}`;
    const hit = this.runCache.get(ck);
    if (hit) return hit;
    const faces = await Promise.all(this.stack(f).map(async (face) => ({ face, file: faceFile(face, f.bold, f.italic), font: await this.parsed(faceFile(face, f.bold, f.italic).key) })));
    const out: (Run & { face: Face })[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      let pick = faces[0];
      if (isNeutral(cp) && out.length) pick = faces.find((x) => x.face === out[out.length - 1].face) ?? faces[0];
      else pick = faces.find((x) => x.font.hasGlyphForCodePoint(cp)) ?? faces[0];
      const last = out[out.length - 1];
      if (last && last.face === pick.face) last.text += ch;
      else out.push({ text: ch, key: pick.file.key, fakeBold: pick.file.fakeBold, fakeItalic: pick.file.fakeItalic, face: pick.face });
    }
    const runs = out.map(({ text: t, key, fakeBold, fakeItalic }) => ({ text: t, key, fakeBold, fakeItalic }));
    if (this.runCache.size > 20000) this.runCache.clear();
    this.runCache.set(ck, runs);
    return runs;
  }

  async runWidth(r: Run, size: number, kern = false): Promise<number> {
    const font = await this.parsed(r.key);
    const run = font.layout(r.text, featuresFor(r.key));
    const k = kern ? await this.kerning(r) : null;
    let w = 0;
    run.glyphs.forEach((g, i) => (w += g.advanceWidth + (k ? k[i] : 0)));
    return (w * size) / font.unitsPerEm;
  }

  /**
   * Pair kerning of a run, per glyph in font units (what to add after each glyph), or null
   * when it has none or its glyphs don't map one to one onto its characters.
   */
  async kerning(r: Run): Promise<number[] | null> {
    if (r.key.startsWith("deva/")) return null;
    const font = await this.parsed(r.key);
    const run = font.layout(r.text, featuresFor(r.key));
    if (run.glyphs.length !== [...r.text].length || !run.positions) return null;
    const k = run.glyphs.map((g, i) => (run.positions[i]?.xAdvance ?? g.advanceWidth) - g.advanceWidth);
    return k.some((v) => v !== 0) ? k : null;
  }

  /** Text-showing operators for a run: one string, or with kerning a TJ array of glyphs and adjustments. */
  async show(font: PDFFont, r: Run, kern: boolean): Promise<PDFOperator[]> {
    const k = kern ? await this.kerning(r) : null;
    if (!k) return showOps(font, r.text);
    const upm = (await this.parsed(r.key)).unitsPerEm;
    const arr = PDFArray.withContext(this.doc.context);
    const chars = [...r.text];
    chars.forEach((ch, i) => {
      arr.push(font.encodeText(ch));
      if (k[i] && i < chars.length - 1) arr.push(PDFNumber.of(Math.round((-k[i] * 1000 * 100) / upm) / 100));
    });
    return [PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [arr])];
  }

  /**
   * The outlines of `text` as path segments (points; x to the right, y down from the
   * baseline), for drawing text as shapes: shadows that mustn't add to the text layer.
   */
  async outline(text: string, f: FontSpec, size: number, spacing = 0, kern = false): Promise<{ segs: OutlineSeg[]; width: number }> {
    const segs: OutlineSeg[] = [];
    let x0 = 0;
    for (const r of await this.runs(text, f)) {
      const font = await this.parsed(r.key);
      const k = size / font.unitsPerEm;
      const skew = r.fakeItalic ? 0.2 : 0;
      const kn = kern ? await this.kerning(r) : null;
      for (const [gi, g] of font.layout(r.text, featuresFor(r.key)).glyphs.entries()) {
        let cx = 0;
        let cy = 0;
        const X = (x: number, y: number) => x0 + x * k + skew * y * k;
        const Y = (y: number) => -y * k;
        for (const c of g.path?.commands ?? []) {
          const a = c.args;
          switch (c.command) {
            case "moveTo":
              segs.push({ t: "M", x: X(a[0], a[1]), y: Y(a[1]) });
              [cx, cy] = [a[0], a[1]];
              break;
            case "lineTo":
              segs.push({ t: "L", x: X(a[0], a[1]), y: Y(a[1]) });
              [cx, cy] = [a[0], a[1]];
              break;
            case "quadraticCurveTo": {
              const [qx, qy, x, y] = a;
              const c1x = cx + ((qx - cx) * 2) / 3;
              const c1y = cy + ((qy - cy) * 2) / 3;
              const c2x = x + ((qx - x) * 2) / 3;
              const c2y = y + ((qy - y) * 2) / 3;
              segs.push({ t: "C", x1: X(c1x, c1y), y1: Y(c1y), x2: X(c2x, c2y), y2: Y(c2y), x: X(x, y), y: Y(y) });
              [cx, cy] = [x, y];
              break;
            }
            case "bezierCurveTo":
              segs.push({ t: "C", x1: X(a[0], a[1]), y1: Y(a[1]), x2: X(a[2], a[3]), y2: Y(a[3]), x: X(a[4], a[5]), y: Y(a[5]) });
              [cx, cy] = [a[4], a[5]];
              break;
            case "closePath":
              segs.push({ t: "Z" });
              break;
          }
        }
        x0 += (g.advanceWidth + (kn ? kn[gi] : 0)) * k + spacing;
      }
    }
    return { segs, width: x0 };
  }

  /** Width in points, as drawn (with pair kerning when `kern`). */
  async width(text: string, f: FontSpec, size = f.size, kern = false): Promise<number> {
    if (!text) return 0;
    const ck = `${f.name}|${f.bold ? 1 : 0}${f.italic ? 1 : 0}|${size}|${kern ? "k" : ""}|${text}`;
    const hit = this.widths.get(ck);
    if (hit !== undefined) return hit;
    let w = 0;
    for (const r of await this.runs(text, f)) w += await this.runWidth(r, size, kern);
    if (this.widths.size > 50000) this.widths.clear();
    this.widths.set(ck, w);
    return w;
  }

  /**
   * Width as Excel judges fit (does it need #####, does it spill, where does it wrap): each
   * glyph a whole number of pixels at 96 dpi, as Windows lays text out on screen. In points.
   */
  async fitWidth(text: string, f: FontSpec, size = f.size): Promise<number> {
    if (!text) return 0;
    const ck = `fit|${f.name}|${f.bold ? 1 : 0}${f.italic ? 1 : 0}|${size}|${text}`;
    const hit = this.widths.get(ck);
    if (hit !== undefined) return hit;
    const px = (size * 96) / 72;
    let w = 0;
    for (const r of await this.runs(text, f)) {
      const font = await this.parsed(r.key);
      for (const g of font.layout(r.text, featuresFor(r.key)).glyphs) w += Math.round((g.advanceWidth * px) / font.unitsPerEm);
    }
    const pt = (w * 72) / 96;
    this.widths.set(ck, pt);
    return pt;
  }

  /** Windows ascent and descent of the face (what Excel lays text and rows out with), in points. */
  async metrics(f: FontSpec, size = f.size): Promise<{ ascent: number; descent: number; underline: number; thickness: number }> {
    const file = faceFile(this.stack(f)[0], f.bold, f.italic);
    const font = await this.parsed(file.key);
    const os2 = font["OS/2"];
    const asc = os2?.winAscent || font.ascent;
    const desc = os2?.winDescent || Math.abs(font.descent);
    const u = size / font.unitsPerEm;
    return { ascent: asc * u, descent: desc * u, underline: -font.underlinePosition * u || size * 0.1, thickness: Math.max(0.4, font.underlineThickness * u || size * 0.05) };
  }

  /** Excel's single-line height at 96 dpi (ascent and descent each rounded to pixels), in points. */
  async lineHeight(f: FontSpec, size = f.size): Promise<number> {
    const m = await this.metrics(f, size);
    const px = 96 / 72;
    return (Math.round(m.ascent * px) + Math.round(m.descent * px)) / px;
  }

  /** The widest digit, in whole pixels at 96 dpi: Excel's unit for column widths. */
  async maxDigitWidth(f: FontSpec): Promise<number> {
    let w = 0;
    for (const d of "0123456789") w = Math.max(w, await this.width(d, f));
    return Math.max(1, Math.round((w * 96) / 72));
  }

  fontKey(page: PDFPage, font: PDFFont): PDFName {
    let m = this.keys.get(page);
    if (!m) this.keys.set(page, (m = new Map()));
    let k = m.get(font.name);
    if (!k) {
      k = page.node.newFontDictionary(font.name, font.ref);
      m.set(font.name, k);
    }
    return k;
  }

  /** Draw `text` with its left end at x and baseline at y (PDF coordinates); returns its width. */
  async draw(page: PDFPage, text: string, x: number, y: number, f: FontSpec, size: number, color: string): Promise<number> {
    let cx = x;
    for (const r of await this.runs(text, f)) {
      const w = await this.runWidth(r, size);
      if (r.text.trim()) {
        const font = await this.embed(r.key);
        const key = this.fontKey(page, font);
        const ops = [pushGraphicsState(), setFillingRgbColor(...rgbParts(color)), beginText(), setFontAndSize(key, size)];
        if (r.fakeBold) ops.push(setTextRenderingMode(TextRenderingMode.FillAndOutline), setLineWidth(size * 0.03), setStrokingRgbColor(...rgbParts(color)));
        ops.push(setTextMatrix(1, 0, r.fakeItalic ? 0.2 : 0, 1, cx, y), ...showOps(font, r.text), endText(), popGraphicsState());
        page.pushOperators(...ops);
      }
      cx += w;
    }
    return cx - x;
  }
}
