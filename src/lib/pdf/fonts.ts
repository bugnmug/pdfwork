/**
 * Unicode text for generated PDFs.
 *
 * pdf-lib's built-in fonts only cover WinAnsi, so "₹", Hindi, arrows or emoji
 * either crash or turn into "?". Here every document gets Noto fonts (Latin,
 * Greek, Cyrillic, ₹), Noto Sans Devanagari (shaped properly by fontkit) and
 * DejaVu Sans as a symbol fallback. Text is split into runs per font based on
 * real glyph coverage, then drawn run by run. Fonts are subset on save, so a
 * one-line stamp adds a few KB, not the whole font file.
 */
import fontkit from "@cantoo/fontkit";
import {
  TextRenderingMode,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
} from "@cantoo/pdf-lib";
import { degrees, type PDFDocument, type PDFFont, type PDFPage, type RGB } from "./core";

export type Family = "sans" | "serif" | "mono";
export type TextStyle = { family?: Family; bold?: boolean; italic?: boolean };

const FILES: Record<string, string> = {
  "sans/r": "NotoSans-Regular.ttf",
  "sans/b": "NotoSans-Bold.ttf",
  "sans/i": "NotoSans-Italic.ttf",
  "sans/bi": "NotoSans-BoldItalic.ttf",
  "serif/r": "NotoSerif-Regular.ttf",
  "serif/b": "NotoSerif-Bold.ttf",
  "serif/i": "NotoSerif-Italic.ttf",
  "serif/bi": "NotoSerif-BoldItalic.ttf",
  "mono/r": "NotoSansMono-Regular.ttf",
  "mono/b": "NotoSansMono-Bold.ttf",
  "mono/i": "NotoSansMono-Regular.ttf",
  "mono/bi": "NotoSansMono-Bold.ttf",
  "deva/r": "NotoSansDevanagari-Regular.ttf",
  "deva/b": "NotoSansDevanagari-Bold.ttf",
  "sym/r": "DejaVuSans.ttf",
  "sym/b": "DejaVuSans-Bold.ttf",
  "hand/caveat": "Caveat.ttf",
  "hand/kalam": "Kalam-Regular.ttf",
};

type FkFont = {
  hasGlyphForCodePoint(cp: number): boolean;
  glyphForCodePoint(cp: number): { advanceWidth: number };
  unitsPerEm: number;
};

const bytesCache = new Map<string, Promise<Uint8Array>>();
const parsedCache = new Map<string, Promise<FkFont>>();

function fontUrl(file: string): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? "/";
  return `${base.replace(/\/?$/, "/")}fonts/${file}`;
}

export function fontBytes(key: string): Promise<Uint8Array> {
  const file = FILES[key];
  if (!file) return Promise.reject(new Error(`Unknown font ${key}`));
  let p = bytesCache.get(file);
  if (!p) {
    p = fetch(fontUrl(file)).then(async (r) => {
      if (!r.ok) throw new Error(`Font ${file} failed to load (${r.status}).`);
      return new Uint8Array(await r.arrayBuffer());
    });
    p.catch(() => bytesCache.delete(file));
    bytesCache.set(file, p);
  }
  return p;
}

export function parsed(key: string): Promise<FkFont> {
  const file = FILES[key];
  let p = parsedCache.get(file);
  if (!p) {
    p = fontBytes(key).then((b) => fontkit.create(b) as unknown as FkFont);
    parsedCache.set(file, p);
  }
  return p;
}

export function faceKey(style: TextStyle = {}): string {
  const fam = style.family ?? "sans";
  const s = style.bold && style.italic ? "bi" : style.bold ? "b" : style.italic ? "i" : "r";
  return `${fam}/${s}`;
}

const isDevanagari = (cp: number) =>
  (cp >= 0x0900 && cp <= 0x097f) || (cp >= 0xa8e0 && cp <= 0xa8ff) || (cp >= 0x1cd0 && cp <= 0x1cff);
/** Characters that should stay in whatever font the surrounding run uses. */
const isNeutral = (cp: number) =>
  cp <= 0x20 ||
  cp === 0xa0 ||
  (cp >= 0x0300 && cp <= 0x036f) ||
  cp === 0x200c ||
  cp === 0x200d ||
  (cp >= 0xfe00 && cp <= 0xfe0f);

export type Run = { text: string; key: string };

/** Split text into runs, each drawable by one font. */
export async function splitRuns(text: string, style: TextStyle = {}): Promise<Run[]> {
  const primaryKey = faceKey(style);
  const bold = !!style.bold;
  const devaKey = bold ? "deva/b" : "deva/r";
  const symKey = bold ? "sym/b" : "sym/r";
  const primary = await parsed(primaryKey);
  let sym: FkFont | null = null;
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let key: string;
    if (isDevanagari(cp)) key = devaKey;
    else if (isNeutral(cp)) key = cur?.key ?? primaryKey;
    else if (primary.hasGlyphForCodePoint(cp)) key = primaryKey;
    else {
      sym ??= await parsed(symKey);
      key = sym.hasGlyphForCodePoint(cp) ? symKey : primaryKey;
    }
    if (cur && cur.key === key) cur.text += ch;
    else {
      cur = { text: ch, key };
      runs.push(cur);
    }
  }
  return runs;
}

export type DrawTextOpts = {
  x: number;
  y: number;
  size: number;
  style?: TextStyle;
  color?: RGB;
  opacity?: number;
  /** Counter-clockwise rotation of the baseline, in degrees. */
  rotate?: number;
};

/** Per-document font manager. Create one per output PDFDocument. */
export class FontSet {
  private embedded = new Map<string, Promise<PDFFont>>();
  private widths = new Map<string, number>();

  constructor(public readonly doc: PDFDocument) {
    doc.registerFontkit(fontkit as never);
  }

  font(key: string): Promise<PDFFont> {
    let p = this.embedded.get(key);
    if (!p) {
      p = fontBytes(key).then((b) => this.doc.embedFont(b, { subset: true }));
      this.embedded.set(key, p);
    }
    return p;
  }

  /** Make sure the fonts for a style are ready (lets later calls be cheap). */
  async prepare(...styles: TextStyle[]) {
    await Promise.all(styles.map((s) => this.font(faceKey(s))));
  }

  async width(text: string, size: number, style: TextStyle = {}): Promise<number> {
    if (!text) return 0;
    const cacheKey = faceKey(style) + "\u0000" + text;
    const hit = this.widths.get(cacheKey);
    if (hit !== undefined) return hit * size;
    let w = 0;
    for (const run of await splitRuns(text, style)) {
      const f = await this.font(run.key);
      w += f.widthOfTextAtSize(run.text, 1);
    }
    if (this.widths.size < 50000) this.widths.set(cacheKey, w);
    return w * size;
  }

  /** Cap height-ish ascent used to vertically centre text. */
  async ascent(size: number, style: TextStyle = {}): Promise<number> {
    const f = await this.font(faceKey(style));
    return f.heightAtSize(size, { descender: false });
  }

  async draw(page: PDFPage, text: string, o: DrawTextOpts): Promise<number> {
    const rot = ((o.rotate ?? 0) * Math.PI) / 180;
    let x = o.x;
    let y = o.y;
    let total = 0;
    for (const run of await splitRuns(text, o.style ?? {})) {
      const font = await this.font(run.key);
      page.drawText(run.text, {
        x,
        y,
        size: o.size,
        font,
        color: o.color,
        opacity: o.opacity,
        rotate: degrees(o.rotate ?? 0),
      });
      const w = font.widthOfTextAtSize(run.text, o.size);
      x += w * Math.cos(rot);
      y += w * Math.sin(rot);
      total += w;
    }
    return total;
  }

  /**
   * Invisible but selectable/searchable text (render mode 3), squeezed
   * horizontally so it spans exactly `width` points. Used for OCR layers and
   * for keeping redacted pages searchable.
   */
  async drawInvisible(page: PDFPage, text: string, o: { x: number; y: number; size: number; width?: number; rotate?: number }) {
    const runs = await splitRuns(text, {});
    if (!runs.length) return;
    let natural = 0;
    const fontsUsed: PDFFont[] = [];
    for (const r of runs) {
      const f = await this.font(r.key);
      fontsUsed.push(f);
      natural += f.widthOfTextAtSize(r.text, o.size);
    }
    const squeeze = o.width && natural > 0 ? Math.max(10, Math.min(1000, (o.width / natural) * 100)) : 100;
    const a = ((o.rotate ?? 0) * Math.PI) / 180;
    const ops = [
      pushGraphicsState(),
      beginText(),
      setTextRenderingMode(TextRenderingMode.Invisible),
      setCharacterSqueeze(squeeze),
      setTextMatrix(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), o.x, o.y),
    ];
    runs.forEach((r, i) => {
      const f = fontsUsed[i];
      const key = page.node.newFontDictionary(f.name, f.ref);
      ops.push(setFontAndSize(key, o.size), showText(f.encodeText(r.text)));
    });
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
  }

  /** Word-wrap text to a width. Keeps explicit newlines. */
  async wrap(text: string, size: number, maxWidth: number, style: TextStyle = {}): Promise<string[]> {
    const lines: string[] = [];
    for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
      if (!para.trim()) {
        lines.push("");
        continue;
      }
      const words = para.split(/(\s+)/).filter((w) => w.length);
      let line = "";
      for (const word of words) {
        const next = line + word;
        if ((await this.width(next.trimEnd(), size, style)) <= maxWidth || !line.trim()) {
          if (!line.trim() && (await this.width(word, size, style)) > maxWidth) {
            // A single token wider than the line: break it by grapheme.
            for (const g of graphemes(word)) {
              if ((await this.width(line + g, size, style)) > maxWidth && line) {
                lines.push(line);
                line = g;
              } else line += g;
            }
          } else line = next;
        } else {
          lines.push(line.trimEnd());
          line = word.trimStart();
        }
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }

  /** Shorten text with an ellipsis so it fits a width. */
  async fit(text: string, size: number, maxWidth: number, style: TextStyle = {}): Promise<string> {
    if ((await this.width(text, size, style)) <= maxWidth) return text;
    const gs = graphemes(text);
    let lo = 0;
    let hi = gs.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((await this.width(gs.slice(0, mid).join("") + "…", size, style)) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return gs.slice(0, lo).join("") + "…";
  }
}

export function graphemes(s: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);
  return Array.from(s);
}

/**
 * Approximate advance widths (in em) for each UTF-16 unit of `text`, using a
 * metrically similar font. Used to locate characters inside PDF text runs
 * (for redaction), which is far more accurate than assuming equal widths.
 */
export async function advances(text: string, family: Family = "sans"): Promise<number[]> {
  const f = await parsed(`${family}/r`);
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let w = 0.5;
    try {
      if (f.hasGlyphForCodePoint(cp)) w = f.glyphForCodePoint(cp).advanceWidth / f.unitsPerEm;
      else if (cp >= 0x0300 && cp <= 0x036f) w = 0;
    } catch {
      w = 0.5;
    }
    out.push(w);
    for (let k = 1; k < ch.length; k++) out.push(0);
  }
  return out;
}
