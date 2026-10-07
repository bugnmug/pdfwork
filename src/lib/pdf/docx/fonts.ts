/**
 * Word font names to the fonts we ship. Calibri, Cambria, Arial, Times New
 * Roman and Courier New have metric-compatible stand-ins (same character
 * widths), so lines break where Word breaks them. Other fonts get the closest
 * shape. `lh` is Word's single line height for the real font, in ems, which we
 * use for line spacing even when we draw with the stand-in.
 */

export type Face = "carlito" | "caladea" | "msans" | "mserif" | "mmono" | "gelasio" | "sans" | "serif" | "mono" | "deva" | "sym";
/** `lh`: Word's single line height; `above`: its ascent plus line gap (where the baseline sits), in ems. */
export type WordFont = { face: Face; lh: number; generic: "sans" | "serif" | "mono"; above?: number };

/** Which styles each face has as real files (others are synthesised). */
export const FACE_STYLES: Record<Face, ("r" | "b" | "i" | "bi")[]> = {
  carlito: ["r", "b", "i", "bi"],
  caladea: ["r", "b", "i", "bi"],
  msans: ["r", "b", "i", "bi"],
  mserif: ["r", "b", "i", "bi"],
  mmono: ["r", "b", "i", "bi"],
  gelasio: ["r", "b", "i", "bi"],
  sans: ["r", "b", "i", "bi"],
  serif: ["r", "b", "i", "bi"],
  mono: ["r", "b"],
  deva: ["r", "b"],
  sym: ["r", "b"],
};

/** Ascent, descent and line gap (ems) as browsers use them for each face's text boxes. */
export const FACE_METRICS: Record<Face, [number, number, number]> = {
  carlito: [0.9521, 0.2686, 0],
  caladea: [0.9, 0.25, 0],
  msans: [0.9053, 0.2119, 0.0327],
  mserif: [0.8911, 0.2163, 0.0425],
  mmono: [0.8325, 0.3003, 0],
  gelasio: [0.9277, 0.3418, 0],
  sans: [1.069, 0.293, 0],
  serif: [1.069, 0.293, 0],
  mono: [1.069, 0.293, 0],
  deva: [0.896, 0.408, 0],
  sym: [0.9282, 0.2358, 0],
};

/** Natural line height of each face as browsers compute `line-height: normal`. */
export const FACE_LH: Record<Face, number> = {
  carlito: 1.2207, caladea: 1.15, msans: 1.1499, mserif: 1.1499, mmono: 1.1328, gelasio: 1.2695, sans: 1.362, serif: 1.362, mono: 1.362, deva: 1.304, sym: 1.1641,
};

const KNOWN: Record<string, WordFont> = {
  calibri: { face: "carlito", lh: 1.2207, generic: "sans", above: 0.9521 },
  "calibri light": { face: "carlito", lh: 1.2207, generic: "sans", above: 0.9521 },
  carlito: { face: "carlito", lh: 1.2207, generic: "sans" },
  lato: { face: "carlito", lh: 1.2, generic: "sans" },
  cambria: { face: "caladea", lh: 1.1724, generic: "serif", above: 0.9502 },
  "cambria math": { face: "caladea", lh: 1.1724, generic: "serif" },
  caladea: { face: "caladea", lh: 1.1724, generic: "serif" },
  arial: { face: "msans", lh: 1.1499, generic: "sans", above: 0.9380 },
  "arial mt": { face: "msans", lh: 1.1499, generic: "sans" },
  arimo: { face: "msans", lh: 1.1499, generic: "sans" },
  "liberation sans": { face: "msans", lh: 1.1499, generic: "sans" },
  helvetica: { face: "msans", lh: 1.1499, generic: "sans" },
  "helvetica neue": { face: "msans", lh: 1.1499, generic: "sans" },
  "arial narrow": { face: "msans", lh: 1.1499, generic: "sans" },
  "arial unicode ms": { face: "msans", lh: 1.3401, generic: "sans" },
  aptos: { face: "msans", lh: 1.2, generic: "sans" },
  "aptos display": { face: "msans", lh: 1.2, generic: "sans" },
  "aptos narrow": { face: "carlito", lh: 1.2, generic: "sans" },
  "times new roman": { face: "mserif", lh: 1.1499, generic: "serif", above: 0.9336 },
  times: { face: "mserif", lh: 1.1499, generic: "serif" },
  tinos: { face: "mserif", lh: 1.1499, generic: "serif" },
  "liberation serif": { face: "mserif", lh: 1.1499, generic: "serif" },
  garamond: { face: "mserif", lh: 1.1206, generic: "serif" },
  "eb garamond": { face: "mserif", lh: 1.3, generic: "serif" },
  "courier new": { face: "mmono", lh: 1.1328, generic: "mono", above: 0.8325 },
  courier: { face: "mmono", lh: 1.1328, generic: "mono" },
  cousine: { face: "mmono", lh: 1.1328, generic: "mono" },
  "liberation mono": { face: "mmono", lh: 1.1328, generic: "mono" },
  consolas: { face: "mmono", lh: 1.1709, generic: "mono" },
  "lucida console": { face: "mmono", lh: 1.0, generic: "mono" },
  georgia: { face: "gelasio", lh: 1.1362, generic: "serif", above: 0.917 },
  gelasio: { face: "gelasio", lh: 1.1362, generic: "serif", above: 0.917 },
  "book antiqua": { face: "serif", lh: 1.1699, generic: "serif" },
  "palatino linotype": { face: "serif", lh: 1.3496, generic: "serif" },
  palatino: { face: "serif", lh: 1.3496, generic: "serif" },
  "bookman old style": { face: "serif", lh: 1.1699, generic: "serif" },
  "century schoolbook": { face: "serif", lh: 1.2, generic: "serif" },
  century: { face: "serif", lh: 1.2, generic: "serif" },
  constantia: { face: "caladea", lh: 1.2207, generic: "serif" },
  "baskerville old face": { face: "mserif", lh: 1.14, generic: "serif" },
  verdana: { face: "sym", lh: 1.2153, generic: "sans" },
  tahoma: { face: "sym", lh: 1.207, generic: "sans" },
  "segoe ui": { face: "sans", lh: 1.3301, generic: "sans" },
  "trebuchet ms": { face: "sans", lh: 1.1611, generic: "sans" },
  "century gothic": { face: "sans", lh: 1.2246, generic: "sans" },
  "gill sans mt": { face: "carlito", lh: 1.1499, generic: "sans" },
  corbel: { face: "carlito", lh: 1.2207, generic: "sans" },
  candara: { face: "carlito", lh: 1.2207, generic: "sans" },
  "franklin gothic book": { face: "msans", lh: 1.1338, generic: "sans" },
  "comic sans ms": { face: "sans", lh: 1.3936, generic: "sans" },
  "open sans": { face: "sans", lh: 1.362, generic: "sans" },
  "noto sans": { face: "sans", lh: 1.362, generic: "sans" },
  roboto: { face: "msans", lh: 1.1719, generic: "sans" },
  montserrat: { face: "sans", lh: 1.219, generic: "sans" },
  poppins: { face: "sans", lh: 1.5, generic: "sans" },
  raleway: { face: "sans", lh: 1.174, generic: "sans" },
  "source sans pro": { face: "carlito", lh: 1.257, generic: "sans" },
  inter: { face: "sans", lh: 1.21, generic: "sans" },
  nunito: { face: "sans", lh: 1.364, generic: "sans" },
  "noto serif": { face: "serif", lh: 1.362, generic: "serif" },
  merriweather: { face: "serif", lh: 1.257, generic: "serif" },
  "playfair display": { face: "serif", lh: 1.333, generic: "serif" },
  mangal: { face: "deva", lh: 1.6, generic: "sans" },
  "nirmala ui": { face: "deva", lh: 1.3301, generic: "sans" },
  kokila: { face: "deva", lh: 1.3, generic: "serif" },
  aparajita: { face: "deva", lh: 1.3, generic: "serif" },
  utsaah: { face: "deva", lh: 1.3, generic: "sans" },
  "noto sans devanagari": { face: "deva", lh: 1.304, generic: "sans" },
  "symbol mapped": { face: "sym", lh: 1.1641, generic: "sans" },
  symbol: { face: "sym", lh: 1.2266, generic: "serif" },
  wingdings: { face: "sym", lh: 1.1, generic: "sans" },
  "ms gothic": { face: "sym", lh: 1.0, generic: "sans" },
  "segoe ui symbol": { face: "sym", lh: 1.3301, generic: "sans" },
};

export function wordFont(name: string | undefined): WordFont {
  const key = (name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return KNOWN.calibri;
  const hit = KNOWN[key];
  if (hit) return hit;
  if (/mono|courier|consol|code/.test(key)) return { face: "mmono", lh: 1.1328, generic: "mono" };
  if (/serif|times|roman|garamond|georgia|book|antiqua|cambria|baskerville|bodoni|caslon|minion|mincho|song|ming|batang|serif/.test(key) && !/sans/.test(key)) return { face: "mserif", lh: 1.1499, generic: "serif" };
  if (/devanagari|hindi|marathi|sanskrit|mangal|kruti/.test(key)) return { face: "deva", lh: 1.6, generic: "sans" };
  if (/arial|helvet|narrow|gothic|grotesk/.test(key)) return { face: "msans", lh: 1.1499, generic: "sans" };
  return { face: "carlito", lh: 1.2207, generic: "sans" };
}

/** CSS family name we register in the measuring frame. */
export const cssFamily = (f: Face) => `dyp-${f}`;

/** The fallback faces after the primary, tried in order for missing characters. */
export function faceStack(primary: Face, generic: "sans" | "serif" | "mono"): Face[] {
  const out: Face[] = [primary];
  const add = (f: Face) => {
    if (!out.includes(f)) out.push(f);
  };
  add(generic === "serif" ? "serif" : generic === "mono" ? "mono" : "sans");
  add("sans");
  add("deva");
  add("sym");
  return out;
}

export const styleKey = (bold: boolean, italic: boolean): "r" | "b" | "i" | "bi" => (bold && italic ? "bi" : bold ? "b" : italic ? "i" : "r");

/** The real file for a face and style; synthetic bold/italic when the face lacks it. */
export function faceFile(face: Face, bold: boolean, italic: boolean): { key: string; fakeBold: boolean; fakeItalic: boolean } {
  const want = styleKey(bold, italic);
  const have = FACE_STYLES[face];
  if (have.includes(want)) return { key: `${face}/${want}`, fakeBold: false, fakeItalic: false };
  if (want === "bi" && have.includes("b")) return { key: `${face}/b`, fakeBold: false, fakeItalic: true };
  if (want === "bi" && have.includes("i")) return { key: `${face}/i`, fakeBold: true, fakeItalic: false };
  if (want === "i") return { key: `${face}/r`, fakeBold: false, fakeItalic: true };
  if (want === "b") return { key: `${face}/r`, fakeBold: true, fakeItalic: false };
  return { key: `${face}/r`, fakeBold: bold, fakeItalic: italic };
}

/** Unicode classes Word picks fonts by: East Asian, complex scripts, or Latin. */
export function scriptOf(cp: number): "ea" | "cs" | "latin" {
  if (
    (cp >= 0x0590 && cp <= 0x08ff) || // Hebrew, Arabic, Syriac, Thaana
    (cp >= 0x0900 && cp <= 0x0dff) || // Indic scripts
    (cp >= 0x0e00 && cp <= 0x0eff) || // Thai, Lao
    (cp >= 0x0f00 && cp <= 0x0fff) || // Tibetan
    (cp >= 0x1000 && cp <= 0x109f) || // Myanmar
    (cp >= 0x1780 && cp <= 0x17ff) || // Khmer
    (cp >= 0xa8e0 && cp <= 0xa8ff) || // Devanagari extended
    (cp >= 0xfb1d && cp <= 0xfdff) || // Hebrew and Arabic presentation forms
    (cp >= 0xfe70 && cp <= 0xfeff)
  )
    return "cs";
  if (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2ffff)
  )
    return "ea";
  return "latin";
}

/** Characters that take the font of their neighbours (spaces, marks, joiners). */
export const isNeutral = (cp: number) => cp <= 0x20 || cp === 0xa0 || (cp >= 0x0300 && cp <= 0x036f) || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || (cp >= 0xfe00 && cp <= 0xfe0f);
