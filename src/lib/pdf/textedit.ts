/**
 * Taking words out of a page. Covering a line with a box and typing over it leaves the old words
 * in the file, where anyone can still copy, search or extract them. Here the glyphs inside the
 * given boxes are removed from the page's content itself: the rest of each line keeps its place
 * (the gap is closed with a positioning offset, nothing moves), and backgrounds, rules and
 * pictures are left as they are.
 *
 * Glyph positions follow the PDF text model: the text and graphics state, each font's widths
 * (simple fonts, the standard 14 by their metrics, CID fonts with their code-space ranges, Type 3
 * fonts) and the page's crop box and rotation, so boxes are given as the page is seen.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext } from "@cantoo/pdf-lib";
import { Encodings, Font as StdFont, type IFontNames } from "@cantoo/pdf-lib/standard-fonts";
import type { PDFDocument } from "./core";
import { apply, mul, pageContent, resourcesOf, spliced, streamBytes, tokenize, viewTransform, type M, type Tok } from "./contentstream";

/** A box on the page as seen: points from its top-left corner, y down (the editor's frame). */
export type VisBox = { x: number; y: number; w: number; h: number };
/**
 * Per box: glyphs taken out; glyphs inside it that could not be (in a form shared by other
 * pages, or in a font whose metrics are unknown); and removed glyphs that were invisible (an OCR
 * layer over a scan, whose visible words are in the picture and still need covering).
 */
export type BoxResult = { removed: number; missed: number; invisible: number };

type FontInfo = {
  /** Bytes in the character code starting at i. */
  codeLen: (b: Uint8Array, i: number) => number;
  /** Advance of a code, in text space units at size 1. */
  width: (code: number) => number;
  /** Positions can be followed (metrics known, horizontal writing). */
  ok: boolean;
};

const UNKNOWN: FontInfo = { codeLen: () => 1, width: () => 0, ok: false };
const nameOf = (o: unknown) => (o instanceof PDFName ? o.decodeText() : undefined);
const numOf = (o: unknown, d = 0) => (o instanceof PDFNumber ? o.asNumber() : d);

function look(ctx: PDFContext, o: unknown): unknown {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}

/** Character code to glyph name for the base encodings of simple fonts. */
const baseNames = (() => {
  let win: Map<number, string> | null = null;
  const fromEncoding = (enc: { supportedCodePoints: number[]; encodeUnicodeCodePoint: (cp: number) => { code: number; name: string } }) => {
    const m = new Map<number, string>();
    for (const cp of enc.supportedCodePoints) {
      const { code, name } = enc.encodeUnicodeCodePoint(cp);
      if (!m.has(code)) m.set(code, name);
    }
    return m;
  };
  return (enc: string | undefined, base: string): Map<number, string> => {
    if (base === "Symbol") return fromEncoding(Encodings.Symbol);
    if (base === "ZapfDingbats") return fromEncoding(Encodings.ZapfDingbats);
    win ??= fromEncoding(Encodings.WinAnsi);
    if (enc === "WinAnsiEncoding" || enc === "MacRomanEncoding") return win;
    // StandardEncoding: as WinAnsi for letters and digits; its quotes are curly.
    const std = new Map(win);
    std.set(0x27, "quoteright");
    std.set(0x60, "quoteleft");
    return std;
  };
})();

/** The standard 14 font a simple font without widths stands for. */
function standardName(base: string): IFontNames | undefined {
  const b = base.replace(/^[A-Z]{6}\+/, "").replace(/[\s_]/g, "");
  const bold = /bold|black|heavy/i.test(b);
  const italic = /italic|oblique/i.test(b);
  const pick = (fam: "Helvetica" | "Times" | "Courier") => {
    if (fam === "Times") return (bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman") as IFontNames;
    return (`${fam}${bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : ""}`) as IFontNames;
  };
  if (/^(helvetica|arial)/i.test(b)) return pick("Helvetica");
  if (/^times/i.test(b)) return pick("Times");
  if (/^courier/i.test(b)) return pick("Courier");
  if (/^symbol/i.test(b)) return "Symbol";
  if (/^zapfdingbats/i.test(b)) return "ZapfDingbats";
  return undefined;
}

function simpleFont(ctx: PDFContext, dict: PDFDict, type3: boolean): FontInfo {
  const first = numOf(look(ctx, dict.get(PDFName.of("FirstChar"))));
  const widths = look(ctx, dict.get(PDFName.of("Widths")));
  const desc = look(ctx, dict.get(PDFName.of("FontDescriptor")));
  const missing = desc instanceof PDFDict ? numOf(look(ctx, desc.get(PDFName.of("MissingWidth")))) : 0;
  const one = () => 1;
  if (type3) {
    const fm = look(ctx, dict.get(PDFName.of("FontMatrix")));
    const scale = fm instanceof PDFArray ? numOf(look(ctx, fm.get(0)), 0.001) : 0.001;
    if (!(widths instanceof PDFArray)) return UNKNOWN;
    return { codeLen: one, width: (c) => numOf(look(ctx, widths.get(c - first))) * scale, ok: true };
  }
  if (widths instanceof PDFArray) {
    const n = widths.size();
    return { codeLen: one, width: (c) => (c >= first && c < first + n ? numOf(look(ctx, widths.get(c - first))) : missing) / 1000, ok: true };
  }
  const std = standardName(nameOf(look(ctx, dict.get(PDFName.of("BaseFont")))) ?? "");
  if (!std) return UNKNOWN;
  const afm = StdFont.load(std);
  const encRaw = look(ctx, dict.get(PDFName.of("Encoding")));
  const names = new Map(baseNames(nameOf(encRaw) ?? (encRaw instanceof PDFDict ? nameOf(look(ctx, encRaw.get(PDFName.of("BaseEncoding")))) : undefined), std));
  if (encRaw instanceof PDFDict) {
    const diff = look(ctx, encRaw.get(PDFName.of("Differences")));
    if (diff instanceof PDFArray) {
      let code = 0;
      for (let i = 0; i < diff.size(); i++) {
        const v = look(ctx, diff.get(i));
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) names.set(code++, v.decodeText());
      }
    }
  }
  return { codeLen: one, width: (c) => ((names.has(c) ? afm.getWidthOfGlyph(names.get(c)!) : undefined) ?? missing) / 1000, ok: true };
}

/** Code-space ranges and CID mappings of an embedded CMap. */
function parseCMap(text: string) {
  const ranges: { n: number; lo: number; hi: number }[] = [];
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g))
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) ranges.push({ n: m[1].length / 2, lo: parseInt(m[1], 16), hi: parseInt(m[2], 16) });
  const cid = new Map<number, number>();
  const cidRanges: { lo: number; hi: number; to: number }[] = [];
  for (const block of text.matchAll(/begincidrange([\s\S]*?)endcidrange/g))
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\d+)/g)) cidRanges.push({ lo: parseInt(m[1], 16), hi: parseInt(m[2], 16), to: Number(m[3]) });
  for (const block of text.matchAll(/begincidchar([\s\S]*?)endcidchar/g)) for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*(\d+)/g)) cid.set(parseInt(m[1], 16), Number(m[2]));
  return { ranges, cid, cidRanges };
}

function type0Font(ctx: PDFContext, dict: PDFDict): FontInfo {
  const enc = look(ctx, dict.get(PDFName.of("Encoding")));
  const descs = look(ctx, dict.get(PDFName.of("DescendantFonts")));
  const desc = descs instanceof PDFArray ? look(ctx, descs.get(0)) : undefined;
  if (!(desc instanceof PDFDict)) return UNKNOWN;
  let codeLen: FontInfo["codeLen"];
  let toCid: (code: number) => number = (c) => c;
  const encName = nameOf(enc);
  if (encName === "Identity-H") codeLen = () => 2;
  else if (encName && /-(UCS2|UTF16)-H$/.test(encName)) codeLen = () => 2;
  else if (enc instanceof PDFRawStream || enc instanceof PDFStream) {
    let text = "";
    try {
      text = new TextDecoder("latin1").decode(streamBytes(ctx, enc));
    } catch {
      return UNKNOWN;
    }
    if (/\/WMode\s+1/.test(text)) return UNKNOWN;
    const cm = parseCMap(text);
    if (!cm.ranges.length) return UNKNOWN;
    codeLen = (b, i) => {
      for (let n = 1; n <= 4; n++) {
        if (i + n > b.length) break;
        let v = 0;
        for (let k = 0; k < n; k++) v = v * 256 + b[i + k];
        if (cm.ranges.some((r) => r.n === n && v >= r.lo && v <= r.hi)) return n;
      }
      return 1;
    };
    if (cm.cid.size || cm.cidRanges.length)
      toCid = (c) => {
        const direct = cm.cid.get(c);
        if (direct !== undefined) return direct;
        const r = cm.cidRanges.find((x) => c >= x.lo && c <= x.hi);
        return r ? r.to + c - r.lo : c;
      };
  } else return UNKNOWN; // vertical or predefined CMaps whose code space isn't known here
  const dw = numOf(look(ctx, desc.get(PDFName.of("DW"))), 1000);
  const widths = new Map<number, number>();
  const w = look(ctx, desc.get(PDFName.of("W")));
  if (w instanceof PDFArray) {
    for (let i = 0; i < w.size(); ) {
      const a = numOf(look(ctx, w.get(i)));
      const b = look(ctx, w.get(i + 1));
      if (b instanceof PDFArray) {
        for (let k = 0; k < b.size(); k++) widths.set(a + k, numOf(look(ctx, b.get(k))));
        i += 2;
      } else {
        const last = numOf(b);
        const v = numOf(look(ctx, w.get(i + 2)));
        for (let c = a; c <= last && c - a < 65536; c++) widths.set(c, v);
        i += 3;
      }
    }
  }
  return { codeLen, width: (c) => (widths.get(toCid(c)) ?? dw) / 1000, ok: true };
}

function fontInfo(ctx: PDFContext, raw: unknown): FontInfo {
  const dict = look(ctx, raw);
  if (!(dict instanceof PDFDict)) return UNKNOWN;
  const sub = nameOf(look(ctx, dict.get(PDFName.of("Subtype"))));
  try {
    if (sub === "Type0") return type0Font(ctx, dict);
    return simpleFont(ctx, dict, sub === "Type3");
  } catch {
    return UNKNOWN;
  }
}

/** The bytes of a literal string token "(...)". */
function literalBytes(b: Uint8Array, s: number, e: number): number[] {
  const out: number[] = [];
  for (let i = s + 1; i < e - 1; i++) {
    const c = b[i];
    if (c !== 92) {
      // A bare line end inside a string reads as a newline.
      if (c === 13) {
        out.push(10);
        if (b[i + 1] === 10) i++;
      } else out.push(c);
      continue;
    }
    const d = b[++i];
    if (d === undefined) break;
    const simple: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
    if (simple[d] !== undefined) out.push(simple[d]);
    else if (d >= 48 && d <= 55) {
      let v = d - 48;
      for (let k = 0; k < 2 && b[i + 1] >= 48 && b[i + 1] <= 55; k++) v = v * 8 + (b[++i] - 48);
      out.push(v & 255);
    } else if (d === 13) {
      if (b[i + 1] === 10) i++;
    } else if (d !== 10) out.push(d);
  }
  return out;
}

function hexBytes(b: Uint8Array, s: number, e: number): number[] {
  let h = "";
  for (let i = s + 1; i < e - 1; i++) if (/[0-9a-fA-F]/.test(String.fromCharCode(b[i]))) h += String.fromCharCode(b[i]);
  if (h.length % 2) h += "0";
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

const hexOf = (bytes: number[]) => "<" + bytes.map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase() + ">";
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

type TextState = { tc: number; tw: number; th: number; tl: number; ts: number; tr: number; font: FontInfo; fs: number };
type GState = { ctm: M } & TextState;
type Marked = { actual: boolean; from: number; to: number; glyphs: number; removed: number };

/** How many times each indirect object is listed as an XObject anywhere in the document. */
function xobjectUses(ctx: PDFContext): Map<string, number> {
  const uses = new Map<string, number>();
  const seen = new Set<unknown>();
  const visit = (o: unknown, inXObjects: boolean, depth: number) => {
    if (depth > 6 || o instanceof PDFRef || seen.has(o)) return;
    if (o instanceof PDFDict) {
      seen.add(o);
      for (const [k, v] of o.entries()) {
        if (inXObjects && v instanceof PDFRef) uses.set(v.toString(), (uses.get(v.toString()) ?? 0) + 1);
        else visit(v, k.decodeText() === "XObject", depth + 1);
      }
    } else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) visit(o.get(i), false, depth + 1);
    else if (o instanceof PDFRawStream || o instanceof PDFStream) visit(o.dict, false, depth + 1);
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj, false, 0);
  return uses;
}

/** Puts new content into a stream object, keeping its dictionary (a form's box, matrix, resources). */
function replaceStream(ctx: PDFContext, ref: PDFRef, old: PDFRawStream | PDFStream, bytes: Uint8Array) {
  const fresh = ctx.flateStream(bytes);
  for (const [k, v] of old.dict.entries()) if (!["Filter", "DecodeParms", "Length"].includes(k.decodeText())) fresh.dict.set(k, v);
  ctx.assign(ref, fresh);
}

/**
 * Removes the glyphs whose centres fall inside any of the boxes from page `pageIndex`, rewriting
 * its content when anything was removed. Text in a form (an XObject) is removed too when that
 * form is drawn only once in the whole document (pages wrapped in a form by tools that resize or
 * impose them); a form shared with other places is left alone and its boxed glyphs count as
 * missed.
 */
export function removeTextIn(doc: PDFDocument, pageIndex: number, boxes: VisBox[]): BoxResult[] {
  const ctx = doc.context;
  const page = doc.getPage(pageIndex);
  const results: BoxResult[] = boxes.map(() => ({ removed: 0, missed: 0, invisible: 0 }));
  if (!boxes.length) return results;
  let uses: Map<string, number> | null = null;
  const view = viewTransform(page);
  const boxAt = (x: number, y: number) => boxes.findIndex((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  const fontsIn = new Map<PDFDict | undefined, Map<string, FontInfo>>();
  const fontFor = (res: PDFDict | undefined, name: string): FontInfo => {
    let m = fontsIn.get(res);
    if (!m) fontsIn.set(res, (m = new Map()));
    let f = m.get(name);
    if (!f) {
      const fonts = res ? look(ctx, res.get(PDFName.of("Font"))) : undefined;
      f = fonts instanceof PDFDict ? fontInfo(ctx, fonts.get(PDFName.of(name))) : UNKNOWN;
      m.set(name, f);
    }
    return f;
  };

  /**
   * Walks one content stream. With `edit`, returns the replacements that take the boxed glyphs
   * out; without, only counts boxed glyphs as missed (text inside forms).
   */
  const walk = (bytes: Uint8Array, res: PDFDict | undefined, base: M, edit: boolean, depth: number): { s: number; e: number; text: string }[] => {
    const edits: { s: number; e: number; text: string }[] = [];
    if (depth > 8) return edits;
    const toks: Tok[] = tokenize(bytes);
    const fresh = (): TextState => ({ tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tr: 0, font: UNKNOWN, fs: 0 });
    let gs: GState = { ctm: base, ...fresh() };
    const stack: GState[] = [];
    let tm: M = [1, 0, 0, 1, 0, 0];
    let tlm: M = [1, 0, 0, 1, 0, 0];
    const marked: Marked[] = [];
    // After text in a font whose widths are unknown, positions on that line can't be trusted
    // until the next line or text position is set.
    let lost = false;
    let opStart = 0; // index of the first operand of the coming operator
    const xo = res ? look(ctx, res.get(PDFName.of("XObject"))) : undefined;
    // How often this stream draws each XObject (a form drawn twice can't change for one copy).
    const drawn = new Map<string, number>();
    toks.forEach((t, i) => {
      if (t.t === "op" && t.v === "Do" && toks[i - 1]?.t === "name") drawn.set(toks[i - 1].v, (drawn.get(toks[i - 1].v) ?? 0) + 1);
    });

    /** Shows the glyphs of one string; returns the TJ elements that keep only the unboxed ones. */
    const show = (raw: number[]): { parts: string[]; changed: boolean } => {
      const f = gs.font;
      const parts: string[] = [];
      let keep: number[] = [];
      let gap = 0; // thousandths of text space, closing removed glyphs
      let changed = false;
      const flushGap = () => {
        if (gap) parts.push(fmt(gap));
        gap = 0;
      };
      const u8 = Uint8Array.from(raw);
      for (let i = 0; i < u8.length; ) {
        const n = Math.max(1, Math.min(f.codeLen(u8, i), u8.length - i));
        let code = 0;
        for (let k = 0; k < n; k++) code = code * 256 + u8[i + k];
        const w0 = f.width(code);
        const adv = (w0 * gs.fs + gs.tc + (n === 1 && code === 32 ? gs.tw : 0)) * gs.th;
        const trm = mul(mul([gs.fs * gs.th, 0, 0, gs.fs, 0, gs.ts], tm), gs.ctm);
        const [ux, uy] = apply(trm, f.ok ? w0 / 2 : 0, 0.3);
        const [vx, vy] = apply(view, ux, uy);
        const at = boxAt(vx, vy);
        // Unknown metrics (or a line already lost): only the first glyph can be placed, and
        // nothing is removed; a box it lands in keeps its cover.
        const sure = f.ok && !lost;
        const hit = sure ? at : -1;
        if (!sure && at >= 0 && (f.ok || i === 0)) results[at].missed++;
        for (const mk of marked) mk.glyphs++;
        if (hit >= 0 && edit && gs.fs !== 0 && gs.th !== 0) {
          results[hit].removed++;
          if (gs.tr === 3 || gs.tr === 7) results[hit].invisible++;
          for (const mk of marked) mk.removed++;
          if (keep.length) parts.push(hexOf(keep));
          keep = [];
          gap -= (adv / gs.th / gs.fs) * 1000;
          changed = true;
        } else {
          if (hit >= 0) results[hit].missed++;
          flushGap();
          for (let k = 0; k < n; k++) keep.push(u8[i + k]);
        }
        tm = mul([1, 0, 0, 1, adv, 0], tm);
        i += n;
      }
      if (!f.ok) lost = true;
      if (keep.length) {
        flushGap();
        parts.push(hexOf(keep));
      }
      flushGap();
      return { parts, changed };
    };

    const nums = (k: number, from: number, to: number) => {
      const out: number[] = [];
      for (let i = from; i < to; i++) if (toks[i].t === "num") out.push(Number(toks[i].v));
      return out.slice(-k);
    };
    const tokText = (t: Tok) => new TextDecoder("latin1").decode(bytes.subarray(t.s, t.e));
    const stringAt = (t: Tok) => (t.t === "str" ? literalBytes(bytes, t.s, t.e) : t.t === "hex" ? hexBytes(bytes, t.s, t.e) : null);
    const td = (x: number, y: number) => {
      tlm = mul([1, 0, 0, 1, x, y], tlm);
      tm = tlm;
      lost = false;
    };

    for (let idx = 0; idx < toks.length; idx++) {
      const t = toks[idx];
      if (t.t !== "op") continue;
      const from = opStart;
      opStart = idx + 1;
      const a = nums(6, from, idx);
      const lastName = [...toks.slice(from, idx)].reverse().find((x) => x.t === "name")?.v ?? "";
      switch (t.v) {
        case "q":
          stack.push({ ...gs });
          break;
        case "Q":
          gs = stack.pop() ?? { ctm: base, ...fresh() };
          break;
        case "cm":
          if (a.length === 6) gs.ctm = mul(a as M, gs.ctm);
          break;
        case "BT":
          tm = tlm = [1, 0, 0, 1, 0, 0];
          lost = false;
          break;
        case "Tf":
          gs.font = fontFor(res, lastName);
          gs.fs = a[a.length - 1] ?? 0;
          break;
        case "Tc":
          gs.tc = a[a.length - 1] ?? 0;
          break;
        case "Tw":
          gs.tw = a[a.length - 1] ?? 0;
          break;
        case "Tz":
          gs.th = (a[a.length - 1] ?? 100) / 100;
          break;
        case "TL":
          gs.tl = a[a.length - 1] ?? 0;
          break;
        case "Ts":
          gs.ts = a[a.length - 1] ?? 0;
          break;
        case "Tr":
          gs.tr = a[a.length - 1] ?? 0;
          break;
        case "Td":
          if (a.length >= 2) td(a[a.length - 2], a[a.length - 1]);
          break;
        case "TD":
          if (a.length >= 2) {
            gs.tl = -a[a.length - 1];
            td(a[a.length - 2], a[a.length - 1]);
          }
          break;
        case "Tm":
          if (a.length === 6) tm = tlm = a as M;
          lost = false;
          break;
        case "T*":
          td(0, -gs.tl);
          break;
        case "Tj":
        case "'":
        case '"': {
          const strTok = [...toks.slice(from, idx)].reverse().find((x) => x.t === "str" || x.t === "hex");
          let pre = "";
          if (t.v === '"') {
            const [aw, ac] = nums(2, from, idx);
            gs.tw = aw ?? gs.tw;
            gs.tc = ac ?? gs.tc;
            pre = `${fmt(gs.tw)} Tw ${fmt(gs.tc)} Tc T* `;
            td(0, -gs.tl);
          } else if (t.v === "'") {
            pre = "T* ";
            td(0, -gs.tl);
          }
          const raw = strTok ? stringAt(strTok) : null;
          if (!raw) break;
          const r = show(raw);
          if (r.changed) edits.push({ s: toks[from]?.s ?? t.s, e: t.e, text: `${pre}[${r.parts.join(" ")}] TJ` });
          break;
        }
        case "TJ": {
          const arrS = toks.slice(from, idx).findIndex((x) => x.t === "arrS");
          if (arrS < 0) break;
          const parts: string[] = [];
          let changed = false;
          for (let k = from + arrS + 1; k < idx && toks[k].t !== "arrE"; k++) {
            const el = toks[k];
            if (el.t === "num") {
              const v = Number(el.v);
              tm = mul([1, 0, 0, 1, (-v / 1000) * gs.fs * gs.th, 0], tm);
              parts.push(tokText(el));
            } else {
              const raw = stringAt(el);
              if (!raw) continue;
              const r = show(raw);
              changed ||= r.changed;
              parts.push(...(r.changed ? r.parts : [tokText(el)]));
            }
          }
          if (changed) edits.push({ s: toks[from + arrS].s, e: t.e, text: `[${parts.join(" ")}] TJ` });
          break;
        }
        case "BDC":
        case "BMC": {
          const actual = t.v === "BDC" && toks.slice(from, idx).some((x) => x.t === "name" && x.v === "ActualText");
          marked.push({ actual, from: toks[from]?.s ?? t.s, to: t.e, glyphs: 0, removed: 0 });
          break;
        }
        case "EMC": {
          const mk = marked.pop();
          // Every glyph of a span with ActualText taken out: its text goes too.
          if (mk?.actual && mk.glyphs > 0 && mk.removed === mk.glyphs && edit) edits.push({ s: mk.from, e: mk.to, text: "/Span BMC" });
          break;
        }
        case "Do": {
          const ref = xo instanceof PDFDict ? xo.get(PDFName.of(lastName)) : undefined;
          const obj = look(ctx, ref);
          if (!(obj instanceof PDFRawStream || obj instanceof PDFStream)) break;
          if (nameOf(look(ctx, obj.dict.get(PDFName.of("Subtype")))) !== "Form") break;
          const mArr = look(ctx, obj.dict.get(PDFName.of("Matrix")));
          const fm: M = mArr instanceof PDFArray && mArr.size() === 6 ? (Array.from({ length: 6 }, (_, k) => numOf(look(ctx, mArr.get(k)))) as M) : [1, 0, 0, 1, 0, 0];
          const own = edit && ref instanceof PDFRef && drawn.get(lastName) === 1 && (uses ??= xobjectUses(ctx)).get(ref.toString()) === 1;
          try {
            const formBytes = streamBytes(ctx, obj);
            const formEdits = walk(formBytes, resourcesOf(obj.dict, ctx) ?? res, mul(fm, gs.ctm), own, depth + 1);
            if (own && formEdits.length) replaceStream(ctx, ref, obj, spliced(formBytes, formEdits));
          } catch {
            /* undecodable form */
          }
          break;
        }
      }
    }
    return edits;
  };

  const bytes = pageContent(doc, pageIndex);
  const res = resourcesOf(page.node, ctx) ?? (page.node.Resources() as PDFDict | undefined);
  const edits = walk(bytes, res, [1, 0, 0, 1, 0, 0], true, 0);
  if (edits.length) page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(spliced(bytes, edits))));
  return results;
}

