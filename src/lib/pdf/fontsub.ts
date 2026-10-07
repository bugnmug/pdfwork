/**
 * Fonts whose program is damaged or lost, replaced by one with the same letters.
 *
 * Text in a PDF is a string of codes; the font's program draws them. When the program is damaged
 * a strict viewer draws nothing (others guess), although the file still says which character each
 * code stands for (its ToUnicode map, or the glyph names of its encoding). That is enough to put
 * a working font in its place: a typeface of the same kind (with the letter widths of Arial,
 * Times, Courier, Calibri, Cambria or Georgia where the name says so), each code mapped to the
 * same character, and the original's widths kept, so every letter lands where it did.
 */
import fontkit from "@cantoo/fontkit";
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext } from "@cantoo/pdf-lib";
import type { PDFDocument } from "./core";
import { fontBytes, matchFace, type Face } from "./fonts";
import { STANDARD, glyphNameOf, unicodeOf, winAnsi } from "./glyphnames";
import { decodeStream } from "./salvage";

const N = (s: string) => PDFName.of(s);
const nameOf = (o: unknown) => (o instanceof PDFName ? o.decodeText() : undefined);
const numOf = (o: unknown, d = 0) => (o instanceof PDFNumber ? o.asNumber() : d);
const isStream = (o: unknown): o is PDFRawStream | PDFStream => o instanceof PDFRawStream || o instanceof PDFStream;
const look = (ctx: PDFContext, o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

type Fk = {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  numGlyphs: number;
  postscriptName: string;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  hasGlyphForCodePoint(cp: number): boolean;
  glyphForCodePoint(cp: number): { id: number; advanceWidth: number };
};

/* ------------------------------------------------------------------------- what codes mean */

/** A font's ToUnicode map: code to text. */
export function readToUnicode(ctx: PDFContext, raw: unknown): Map<number, string> | undefined {
  const s = look(ctx, raw);
  if (!isStream(s)) return undefined;
  const text = latin1(decodeStream(s).bytes);
  const utf16 = (hex: string) => {
    if (hex.length <= 2) return hex ? String.fromCharCode(parseInt(hex, 16)) : "";
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
  };
  const map = new Map<number, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), utf16(m[2]));
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (!(hi >= lo) || hi - lo > 65535) continue;
      if (m[3] !== undefined) {
        const base = utf16(m[3]);
        if (!base) continue;
        const head = base.slice(0, -1);
        const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(last + c - lo));
      } else [...m[4].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((x, k) => lo + k <= hi && map.set(lo + k, utf16(x[1])));
    }
  return map.size ? map : undefined;
}

/**
 * A damaged ToUnicode map is written again from the entries that can still be read, or taken out
 * when none can, so readers don't stop at it (and copied text isn't garbled).
 */
export function mendToUnicode(ctx: PDFContext, font: PDFDict) {
  const raw = font.get(N("ToUnicode"));
  if (raw === undefined) return;
  const s = look(ctx, raw);
  if (s instanceof PDFName) return;
  if (!isStream(s)) {
    font.delete(N("ToUnicode"));
    return;
  }
  if (decodeStream(s).intact) return;
  const map = readToUnicode(ctx, s);
  if (!map?.size) {
    font.delete(N("ToUnicode"));
    return;
  }
  const wide = nameOf(look(ctx, font.get(N("Subtype")))) === "Type0" || [...map.keys()].some((c) => c > 0xff);
  font.set(N("ToUnicode"), toUnicodeStream(ctx, map, wide));
}

/** A ToUnicode map written out as a CMap stream: each code (one or two bytes) to its text. */
function toUnicodeStream(ctx: PDFContext, map: Map<number, string>, wide: boolean): PDFRef {
  const hex = (n: number, bytes: number) => n.toString(16).toUpperCase().padStart(bytes * 2, "0");
  // The text as UTF-16 code units, four hex digits each.
  const utf16 = (t: string) => Array.from({ length: t.length }, (_, i) => hex(t.charCodeAt(i), 2)).join("");
  const entries = [...map].filter(([, t]) => t.length).sort((a, b) => a[0] - b[0]).map(([c, t]) => `<${hex(c, wide ? 2 : 1)}> <${utf16(t)}>`);
  let blocks = "";
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    blocks += `${part.length} beginbfchar\n${part.join("\n")}\nendbfchar\n`;
  }
  const range = wide ? "<0000> <FFFF>" : "<00> <FF>";
  const text = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n${range}\nendcodespacerange\n${blocks}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
  return ctx.register(ctx.flateStream(text));
}

/** The glyph names of a simple font's codes: its encoding, with differences. */
function encodingNames(ctx: PDFContext, font: PDFDict): Map<number, string> {
  const raw = look(ctx, font.get(N("Encoding")));
  const base = nameOf(raw) ?? (raw instanceof PDFDict ? nameOf(look(ctx, raw.get(N("BaseEncoding")))) : undefined);
  const names = new Map(winAnsi().byCode);
  if (!base || base === "StandardEncoding") for (const [c, n] of Object.entries(STANDARD)) names.set(Number(c), n);
  if (raw instanceof PDFDict) {
    const diff = look(ctx, raw.get(N("Differences")));
    if (diff instanceof PDFArray) {
      let code = 0;
      for (const v0 of diff.asArray()) {
        const v = look(ctx, v0);
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) names.set(code++, v.decodeText());
      }
    }
  }
  return names;
}

/** Code to CID for a composite font's encoding; undefined for named CMaps other than Identity. */
function cidOf(ctx: PDFContext, font: PDFDict): ((code: number) => number) | undefined {
  const enc = look(ctx, font.get(N("Encoding")));
  const name = nameOf(enc);
  if (name === "Identity-H" || name === "Identity-V") return (c) => c;
  if (!isStream(enc)) return undefined;
  const text = latin1(decodeStream(enc).bytes);
  const single = new Map<number, number>();
  const ranges: { lo: number; hi: number; to: number }[] = [];
  for (const block of text.matchAll(/begincidrange([\s\S]*?)endcidrange/g))
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\d+)/g)) ranges.push({ lo: parseInt(m[1], 16), hi: parseInt(m[2], 16), to: Number(m[3]) });
  for (const block of text.matchAll(/begincidchar([\s\S]*?)endcidchar/g)) for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*(\d+)/g)) single.set(parseInt(m[1], 16), Number(m[2]));
  if (!single.size && !ranges.length) return undefined;
  return (c) => {
    const s = single.get(c);
    if (s !== undefined) return s;
    const r = ranges.find((x) => c >= x.lo && c <= x.hi);
    return r ? r.to + c - r.lo : -1;
  };
}

/* ------------------------------------------------------------------- checking the program */

/** The font's descriptor (a composite font's is on its descendant). */
function descriptorOf(ctx: PDFContext, font: PDFDict): { desc?: PDFDict; cid?: PDFDict } {
  if (nameOf(look(ctx, font.get(N("Subtype")))) === "Type0") {
    const kids = look(ctx, font.get(N("DescendantFonts")));
    const cid = kids instanceof PDFArray ? look(ctx, kids.get(0)) : undefined;
    if (!(cid instanceof PDFDict)) return {};
    const d = look(ctx, cid.get(N("FontDescriptor")));
    return { desc: d instanceof PDFDict ? d : undefined, cid };
  }
  const d = look(ctx, font.get(N("FontDescriptor")));
  return { desc: d instanceof PDFDict ? d : undefined };
}

/**
 * Whether a font's program can draw: "ok", "damaged" (it is there but broken), "lost" (the file
 * points to it but it is gone), or "none" (not embedded on purpose, or a Type 3 font drawn by
 * the page itself; viewers supply such fonts).
 */
export function programState(ctx: PDFContext, font: PDFDict): "ok" | "damaged" | "lost" | "none" {
  const sub = nameOf(look(ctx, font.get(N("Subtype"))));
  if (sub === "Type3") return "none";
  const { desc, cid } = descriptorOf(ctx, font);
  if (sub === "Type0" && !cid) return "lost";
  if (!desc) return "none";
  for (const key of ["FontFile", "FontFile2", "FontFile3"]) {
    const raw = desc.get(N(key));
    if (raw === undefined) continue;
    const s = look(ctx, raw);
    if (!isStream(s)) return "lost";
    const d = decodeStream(s);
    // Broken: it stops decoding, or zeros were wiped over it. One that decodes to the end but
    // fails its checksum (some writers get it wrong) is judged by whether it reads as a font.
    if (!d.whole || d.damageAt !== undefined || !d.bytes.length) return "damaged";
    const kind = nameOf(look(ctx, s.dict.get(N("Subtype"))));
    if (key === "FontFile2" || kind === "OpenType") {
      try {
        const f = fontkit.create(d.bytes) as unknown as Fk;
        if (!f || !(f.numGlyphs > 0)) return "damaged";
      } catch {
        return "damaged";
      }
    } else if (key === "FontFile" && !/%!|eexec/.test(latin1(d.bytes.subarray(0, Math.min(d.bytes.length, 65536))))) return "damaged";
    return "ok";
  }
  return "none";
}

/* ------------------------------------------------------------------ the font put in its place */

type Sub = { ref: PDFRef; font: Fk };
const embedded = new WeakMap<PDFDocument, Map<string, Promise<Sub>>>();
const programs = new Map<string, Promise<Fk>>();

function program(key: string): Promise<Fk> {
  let p = programs.get(key);
  if (!p) {
    p = fontBytes(key).then((b) => fontkit.create(b) as unknown as Fk);
    p.catch(() => programs.delete(key));
    programs.set(key, p);
  }
  return p;
}

function embed(doc: PDFDocument, key: string): Promise<Sub> {
  let m = embedded.get(doc);
  if (!m) embedded.set(doc, (m = new Map()));
  let p = m.get(key);
  if (!p) {
    p = Promise.all([fontBytes(key), program(key)]).then(([bytes, font]) => ({ ref: doc.context.register(doc.context.flateStream(bytes, { Length1: bytes.length })), font }));
    m.set(key, p);
  }
  return p;
}

const LIGATURES: Record<string, number> = { ff: 0xfb00, fi: 0xfb01, fl: 0xfb02, ffi: 0xfb03, ffl: 0xfb04, st: 0xfb06 };

/**
 * The character a code's text is drawn with: the text's own if it is one, a ligature's when the
 * font has it (where a ligature can't be shown as its letters, see Split; some viewers don't map
 * ligature glyphs by name, so letters are preferred).
 */
function charOf(text: string, f: Fk): number | undefined {
  const cps = [...text].map((c) => c.codePointAt(0)!);
  if (!cps.length) return undefined;
  if (cps.length > 1) {
    const lig = LIGATURES[text];
    if (lig && f.hasGlyphForCodePoint(lig)) return lig;
  }
  return cps[0];
}

/** Picks the typeface for a font: the same kind and style, covering the most of its characters. */
async function pick(ctx: PDFContext, font: PDFDict, desc: PDFDict | undefined, chars: number[]): Promise<string> {
  const base = (nameOf(look(ctx, font.get(N("BaseFont")))) ?? "").replace(/^[A-Z]{6}\+/, "");
  const flags = numOf(look(ctx, desc?.get(N("Flags"))));
  const weight = numOf(look(ctx, desc?.get(N("FontWeight"))));
  const bold = /bold|black|heavy|semibold|demi/i.test(base) || weight >= 600 || (flags & (1 << 18)) !== 0;
  const italic = /italic|oblique/i.test(base) || numOf(look(ctx, desc?.get(N("ItalicAngle")))) !== 0 || (flags & 64) !== 0;
  const face: Face = matchFace(base) ?? (flags & 1 ? "mmono" : flags & 2 || /serif|times|roman|georgia|garamond|book/i.test(base) ? "mserif" : "msans");
  const style = bold && italic ? "bi" : bold ? "b" : italic ? "i" : "r";
  const keys = [`${face}/${style}`, `sans/${style}`, `deva/${bold ? "b" : "r"}`, `sym/${bold ? "b" : "r"}`];
  let best = keys[0];
  let bestCover = -1;
  for (const key of keys) {
    const f = await program(key).catch(() => null);
    if (!f) continue;
    const cover = chars.length ? chars.filter((c) => c <= 0x20 || f.hasGlyphForCodePoint(c)).length / chars.length : 1;
    if (cover > bestCover + 0.02) {
      best = key;
      bestCover = cover;
    }
    if (cover >= 0.98) break;
  }
  return best;
}

function descriptor(ctx: PDFContext, f: Fk, ref: PDFRef, old: PDFDict | undefined): PDFRef {
  const scale = 1000 / f.unitsPerEm;
  const flags = (numOf(look(ctx, old?.get(N("Flags")))) & (1 | 2 | 64 | (1 << 16) | (1 << 17) | (1 << 18))) | 32;
  return ctx.register(
    ctx.obj({
      Type: "FontDescriptor",
      FontName: N(f.postscriptName || "Font"),
      Flags: flags,
      FontBBox: [f.bbox.minX, f.bbox.minY, f.bbox.maxX, f.bbox.maxY].map((v) => Math.round(v * scale)),
      ItalicAngle: f.italicAngle || 0,
      Ascent: Math.round(f.ascent * scale),
      Descent: Math.round(f.descent * scale),
      CapHeight: Math.round((f.capHeight || f.ascent * 0.7) * scale),
      StemV: numOf(look(ctx, old?.get(N("StemV"))), 80),
      FontFile2: ref,
    }),
  );
}

/**
 * A code that stood for several characters (a ligature such as "ti") which the new font has no
 * single glyph for: it is shown as these codes instead, then moved back by `back` (thousandths
 * of an em) so that what follows keeps its place.
 */
export type Split = { codes: number[]; back: number };

/** A composite font's widths by CID (its W array), and the default width. */
function cidWidths(ctx: PDFContext, cid: PDFDict): { w: Map<number, number>; dw: number } {
  const w = new Map<number, number>();
  const arr = look(ctx, cid.get(N("W")));
  if (arr instanceof PDFArray)
    for (let i = 0; i < arr.size(); ) {
      const a = numOf(look(ctx, arr.get(i)));
      const b = look(ctx, arr.get(i + 1));
      if (b instanceof PDFArray) {
        b.asArray().forEach((v, k) => w.set(a + k, numOf(look(ctx, v))));
        i += 2;
      } else {
        const v = numOf(look(ctx, arr.get(i + 2)));
        for (let c = a; c <= numOf(b) && c - a < 65536; c++) w.set(c, v);
        i += 3;
      }
    }
  return { w, dw: numOf(look(ctx, cid.get(N("DW"))), 1000) };
}

/**
 * Puts a working font program in place of a damaged or lost one, keeping what each code stands
 * for and the widths. Returns the ligature codes to show as several (see Split) and whether
 * codes are two bytes; null when the file doesn't say what the codes mean (then nothing can
 * stand in).
 */
export async function replaceProgram(doc: PDFDocument, font: PDFDict): Promise<{ splits: Map<number, Split>; wide: boolean } | null> {
  const ctx = doc.context;
  const sub = nameOf(look(ctx, font.get(N("Subtype"))));
  if (sub === "Type3") return null;
  const { desc, cid } = descriptorOf(ctx, font);
  const uni = readToUnicode(ctx, font.get(N("ToUnicode"))) ?? new Map<number, string>();
  const splits = new Map<number, Split>();
  /** Codes standing for exactly one character, by that character. */
  const single = (m: Map<number, string>) => {
    const out = new Map<string, number>();
    for (const [c, t] of m) if ([...t].length === 1 && !out.has(t)) out.set(t, c);
    return out;
  };
  if (sub === "Type0") {
    const toCid = cidOf(ctx, font);
    if (!cid || !toCid || !uni.size) return null;
    const chars = [...uni.values()].map((t) => t.codePointAt(0) ?? 0);
    const key = await pick(ctx, font, desc, chars);
    const s = await embed(doc, key);
    const scale = 1000 / s.font.unitsPerEm;
    const gids = new Map<number, number>();
    let max = 0;
    for (const [code, text] of uni) {
      const c = toCid(code);
      const cp = charOf(text, s.font);
      if (c < 0 || c > 65535 || cp === undefined || !s.font.hasGlyphForCodePoint(cp)) continue;
      gids.set(c, s.font.glyphForCodePoint(cp).id);
      max = Math.max(max, c);
    }
    // Ligatures the new font can't draw as one glyph: their characters' own codes (new ones
    // where the font had none), when codes are CIDs (an identity encoding).
    const identity = /^Identity-[HV]$/.test(nameOf(look(ctx, font.get(N("Encoding")))) ?? "");
    const widths = cidWidths(ctx, cid);
    const added: number[] = [];
    const have = single(uni);
    if (identity) {
      for (const [code, text] of uni) {
        const parts = [...text];
        if (parts.length < 2 || parts.length > 4) continue;
        if (!parts.every((ch) => s.font.hasGlyphForCodePoint(ch.codePointAt(0)!))) continue;
        const codes = parts.map((ch) => {
          let c = have.get(ch);
          if (c === undefined && max < 65535) {
            c = ++max;
            const g = s.font.glyphForCodePoint(ch.codePointAt(0)!);
            gids.set(c, g.id);
            widths.w.set(c, Math.round(g.advanceWidth * scale));
            added.push(c);
            have.set(ch, c);
          }
          return c ?? -1;
        });
        if (codes.includes(-1)) continue;
        const wOf = (c: number) => widths.w.get(c) ?? widths.dw;
        splits.set(code, { codes, back: codes.reduce((n, c) => n + wOf(c), 0) - wOf(code) });
      }
    }
    const map = new Uint8Array((max + 1) * 2);
    for (const [c, g] of gids) {
      map[c * 2] = g >> 8;
      map[c * 2 + 1] = g & 255;
    }
    if (added.length) {
      const w = look(ctx, cid.get(N("W")));
      const list = w instanceof PDFArray ? w : ctx.obj([]);
      for (const c of added) {
        list.push(PDFNumber.of(c));
        list.push(ctx.obj([widths.w.get(c) ?? 0]));
      }
      cid.set(N("W"), list);
      // Copied text reads the same: the new codes stand for their characters.
      const tu = new Map(uni);
      for (const [ch, c] of have) if (!tu.has(c)) tu.set(c, ch);
      font.set(N("ToUnicode"), toUnicodeStream(ctx, tu, true));
    }
    cid.set(N("Subtype"), N("CIDFontType2"));
    cid.set(N("BaseFont"), N(s.font.postscriptName));
    cid.set(N("CIDToGIDMap"), ctx.register(ctx.flateStream(map)));
    cid.set(N("FontDescriptor"), descriptor(ctx, s.font, s.ref, desc));
    font.set(N("BaseFont"), N(s.font.postscriptName));
    return { splits, wide: true };
  }
  // A simple font: what each code stands for, from its ToUnicode map or its glyph names.
  const named = encodingNames(ctx, font);
  const symbolic = !font.has(N("Encoding")) && sub === "TrueType";
  for (let c = 0; c < 256; c++) {
    if (uni.has(c) || symbolic) continue;
    const n = named.get(c);
    const cp = n ? unicodeOf(n, true) : undefined;
    if (cp !== undefined) uni.set(c, String.fromCodePoint(cp));
  }
  if (!uni.size) return null;
  const key = await pick(ctx, font, desc, [...uni.values()].map((t) => t.codePointAt(0) ?? 0));
  const s = await embed(doc, key);
  const scale = 1000 / s.font.unitsPerEm;
  const advance = (cp: number | undefined) => (cp !== undefined && s.font.hasGlyphForCodePoint(cp) ? Math.round(s.font.glyphForCodePoint(cp).advanceWidth * scale) : 0);
  // Widths by code: the font's own, or the new font's where it had none.
  let first = numOf(look(ctx, font.get(N("FirstChar"))));
  const wArr = look(ctx, font.get(N("Widths")));
  const widths = new Map<number, number>();
  if (wArr instanceof PDFArray) wArr.asArray().forEach((v, k) => widths.set(first + k, numOf(look(ctx, v))));
  else {
    first = 0;
    for (let c = 0; c < 256; c++) widths.set(c, advance(uni.has(c) ? charOf(uni.get(c)!, s.font) : undefined));
  }
  // Ligatures the new font can't draw as one glyph: their characters' own codes, or free codes
  // (past the font's last one, else unused control codes) given those characters.
  const text = new Map(uni);
  const have = single(uni);
  const last = Math.max(...widths.keys(), numOf(look(ctx, font.get(N("LastChar")))));
  const free = [...Array(256).keys()].filter((c) => !uni.has(c) && (c > last || c < 32) && c > 0).sort((a, b) => (a > last ? 0 : 1) - (b > last ? 0 : 1) || a - b);
  for (const [code, t] of uni) {
    const parts = [...t];
    if (parts.length < 2 || parts.length > 4) continue;
    if (!parts.every((ch) => s.font.hasGlyphForCodePoint(ch.codePointAt(0)!))) continue;
    const codes = parts.map((ch) => {
      let c = have.get(ch);
      if (c === undefined && free.length) {
        c = free.shift()!;
        text.set(c, ch);
        widths.set(c, advance(ch.codePointAt(0)));
        have.set(ch, c);
      }
      return c ?? -1;
    });
    if (codes.includes(-1)) continue;
    splits.set(code, { codes, back: codes.reduce((n, c) => n + (widths.get(c) ?? 0), 0) - (widths.get(code) ?? 0) });
  }
  const win = winAnsi().byCode;
  const diffs: (number | PDFName)[] = [];
  let prev = -2;
  for (let c = 0; c < 256; c++) {
    const t = text.get(c);
    const cp = t ? charOf(t, s.font) : undefined;
    if (cp === undefined) continue;
    const name = glyphNameOf(cp);
    if (win.get(c) === name) continue;
    if (c !== prev + 1) diffs.push(c);
    diffs.push(N(name));
    prev = c;
  }
  const lastCode = Math.max(...widths.keys());
  const firstCode = Math.min(first, ...widths.keys());
  font.set(N("FirstChar"), PDFNumber.of(firstCode));
  font.set(N("LastChar"), PDFNumber.of(lastCode));
  font.set(N("Widths"), ctx.obj(Array.from({ length: lastCode - firstCode + 1 }, (_, k) => widths.get(firstCode + k) ?? 0)));
  font.set(N("Subtype"), N("TrueType"));
  font.set(N("BaseFont"), N(s.font.postscriptName));
  font.set(N("Encoding"), diffs.length ? ctx.obj({ Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: diffs }) : N("WinAnsiEncoding"));
  font.set(N("FontDescriptor"), descriptor(ctx, s.font, s.ref, desc));
  if (font.has(N("ToUnicode")) && text.size > uni.size) font.set(N("ToUnicode"), toUnicodeStream(ctx, text, false));
  return { splits, wide: false };
}
