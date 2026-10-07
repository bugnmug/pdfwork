/**
 * Glyph names and the characters they stand for, for reading and writing the encodings of simple
 * PDF fonts (codes 0 to 255 that name glyphs: "A", "eacute", "uni20B9").
 */
import { Encodings } from "@cantoo/pdf-lib/standard-fonts";

/** StandardEncoding where it differs from WinAnsi (the default of Type 1 fonts with no /Encoding). */
export const STANDARD: Record<number, string> = {
  0x27: "quoteright", 0x60: "quoteleft", 0xa1: "exclamdown", 0xa2: "cent", 0xa3: "sterling", 0xa4: "fraction", 0xa5: "yen", 0xa6: "florin",
  0xa7: "section", 0xa8: "currency", 0xa9: "quotesingle", 0xaa: "quotedblleft", 0xab: "guillemotleft", 0xac: "guilsinglleft", 0xad: "guilsinglright",
  0xae: "fi", 0xaf: "fl", 0xb1: "endash", 0xb2: "dagger", 0xb3: "daggerdbl", 0xb4: "periodcentered", 0xb6: "paragraph", 0xb7: "bullet",
  0xb8: "quotesinglbase", 0xb9: "quotedblbase", 0xba: "quotedblright", 0xbb: "guillemotright", 0xbc: "ellipsis", 0xbd: "perthousand",
  0xbf: "questiondown", 0xc1: "grave", 0xc2: "acute", 0xc3: "circumflex", 0xc4: "tilde", 0xc5: "macron", 0xc6: "breve", 0xc7: "dotaccent",
  0xc8: "dieresis", 0xca: "ring", 0xcb: "cedilla", 0xcd: "hungarumlaut", 0xce: "ogonek", 0xcf: "caron", 0xd0: "emdash", 0xe1: "AE",
  0xe3: "ordfeminine", 0xe8: "Lslash", 0xe9: "Oslash", 0xea: "OE", 0xeb: "ordmasculine", 0xf1: "ae", 0xf5: "dotlessi", 0xf8: "lslash",
  0xf9: "oslash", 0xfa: "oe", 0xfb: "germandbls",
};
const EXTRA_NAMES: Record<string, number> = { fi: 0xfb01, fl: 0xfb02, fraction: 0x2044, dotlessi: 0x131, Lslash: 0x141, lslash: 0x142, breve: 0x2d8, dotaccent: 0x2d9, ring: 0x2da, hungarumlaut: 0x2dd, ogonek: 0x2db, caron: 0x2c7, quotesingle: 0x27, grave: 0x60, minus: 0x2212, Euro: 0x20ac, rupee: 0x20b9, rupeeindian: 0x20b9, nbspace: 0xa0, sfthyphen: 0xad, middot: 0xb7 };

let winNames: { byCode: Map<number, string>; uni: Map<string, number>; nameOf: Map<number, string> } | null = null;
/** WinAnsi: each code's glyph name, each name's character, and each character's name. */
export function winAnsi() {
  if (!winNames) {
    const byCode = new Map<number, string>();
    const uni = new Map<string, number>(Object.entries(EXTRA_NAMES));
    const nameOf = new Map<number, string>();
    const enc = Encodings.WinAnsi;
    for (const cp of enc.supportedCodePoints) {
      const { code, name } = enc.encodeUnicodeCodePoint(cp);
      if (!byCode.has(code)) byCode.set(code, name);
      if (!uni.has(name)) uni.set(name, cp);
      if (!nameOf.has(cp)) nameOf.set(cp, name);
    }
    winNames = { byCode, uni, nameOf };
  }
  return winNames;
}

/**
 * Unicode of a glyph name (Adobe names, uniXXXX, uXXXX[XX]). `loose`: a variant such as "a.sc",
 * "one.oldstyle" or "f_i" counts as its base glyph's character.
 */
export function unicodeOf(name: string, loose = false): number | undefined {
  const w = winAnsi().uni.get(name);
  if (w !== undefined) return w;
  const m = /^uni([0-9A-F]{4})$/i.exec(name) ?? /^u([0-9A-F]{4,6})$/i.exec(name);
  if (m) return parseInt(m[1], 16);
  const base = loose ? /^([A-Za-z]+)[._]/.exec(name) : null;
  return base ? winAnsi().uni.get(base[1]) : undefined;
}

/** A glyph name for a character that readers map back to it: its Adobe name, else uniXXXX. */
export function glyphNameOf(cp: number): string {
  return winAnsi().nameOf.get(cp) ?? (cp <= 0xffff ? `uni${cp.toString(16).toUpperCase().padStart(4, "0")}` : `u${cp.toString(16).toUpperCase()}`);
}
