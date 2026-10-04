/**
 * Handwriting pages as real vector text (crisp at any zoom, selectable, tiny
 * files): ruled/plain/grid paper, ink colours, and small per-word wobble in
 * angle, size and baseline so it reads like a hand rather than a font.
 * Caveat for Latin, Kalam for Hindi (Devanagari) text.
 */
import { degrees, hexToRgb, newDoc, pdfOut, saveDoc, type OutFile } from "./core";
import { FontSet, graphemes, parsed } from "./fonts";

export type HandOpts = {
  paper?: "ruled" | "plain" | "grid";
  ink?: string;
  size?: number;
  font?: "caveat" | "kalam";
  wobble?: number; // 0..2
  margin?: boolean;
  heading?: string;
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

const isDeva = (cp: number) => cp >= 0x0900 && cp <= 0x097f;

export async function handwritingPdf(text: string, o: HandOpts = {}): Promise<Uint8Array> {
  const doc = await newDoc();
  const fonts = new FontSet(doc);
  const primaryKey = o.font === "kalam" ? "hand/kalam" : "hand/caveat";
  const primary = await parsed(primaryKey);
  const W = 595.28;
  const H = 841.89;
  const size = o.size ?? 17;
  const lineGap = size * 1.55;
  const left = o.margin === false ? 48 : 78;
  const right = W - 44;
  const top = 86;
  const ink = hexToRgb(o.ink || "#1b3a8a");
  const wob = o.wobble ?? 1;
  const rand = rng(text.length * 7919 + 17);
  const keyFor = (word: string) => {
    for (const ch of word) {
      const cp = ch.codePointAt(0)!;
      if (isDeva(cp)) return "hand/kalam";
      if (cp > 0x20 && !primary.hasGlyphForCodePoint(cp)) return "sans/r";
    }
    return primaryKey;
  };
  const widthOf = async (word: string, s: number) => (await fonts.font(keyFor(word))).widthOfTextAtSize(word, s);

  let page = doc.addPage([W, H]);
  const paper = () => {
    if (o.paper === "grid") {
      const step = lineGap / 2;
      for (let x = 30; x < W - 20; x += step) page.drawLine({ start: { x, y: 30 }, end: { x, y: H - 30 }, thickness: 0.35, color: hexToRgb("#cfdbea") });
      for (let y = H - 30; y > 30; y -= step) page.drawLine({ start: { x: 30, y }, end: { x: W - 30, y }, thickness: 0.35, color: hexToRgb("#cfdbea") });
    } else if (o.paper !== "plain") {
      for (let y = H - top; y > 40; y -= lineGap) page.drawLine({ start: { x: 24, y }, end: { x: W - 24, y }, thickness: 0.5, color: hexToRgb("#b9cce4") });
    }
    if (o.margin !== false && o.paper !== "grid") page.drawLine({ start: { x: left - 14, y: 20 }, end: { x: left - 14, y: H - 20 }, thickness: 0.8, color: hexToRgb("#e08a8a") });
  };
  paper();
  let baseline = H - top - 4;
  let x = left;
  const newLine = () => {
    x = left;
    baseline -= lineGap;
    if (baseline < 48) {
      page = doc.addPage([W, H]);
      paper();
      baseline = H - top - 4;
    }
  };
  const drawWord = async (word: string) => {
    const s = size * (1 + (rand() - 0.5) * 0.06 * wob);
    const key = keyFor(word);
    const font = await fonts.font(key);
    const w = font.widthOfTextAtSize(word, s);
    const angle = (rand() - 0.5) * 2.4 * wob;
    const dy = (rand() - 0.5) * 1.6 * wob;
    page.drawText(word, { x, y: baseline + dy + 3, size: s, font, color: ink, rotate: degrees(angle), opacity: 0.92 + rand() * 0.08 });
    x += w;
  };
  if (o.heading?.trim()) {
    const hw = await widthOf(o.heading.trim(), size * 1.25);
    const f = await fonts.font(keyFor(o.heading));
    page.drawText(o.heading.trim(), { x: (W - hw) / 2, y: baseline + 3, size: size * 1.25, font: f, color: ink });
    page.drawLine({ start: { x: (W - hw) / 2, y: baseline }, end: { x: (W + hw) / 2, y: baseline }, thickness: 0.8, color: ink });
    newLine();
    newLine();
  }
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!para.trim()) {
      newLine();
      continue;
    }
    x = left + size * 0.8; // paragraph indent
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const space = size * (0.28 + rand() * 0.08 * wob);
      const w = await widthOf(word, size);
      if (x + w > right && x > left + size) newLine();
      if (w > right - left) {
        // Very long token: break it.
        let chunk = "";
        for (const g of graphemes(word)) {
          if (x + (await widthOf(chunk + g, size)) > right && chunk) {
            await drawWord(chunk);
            newLine();
            chunk = g;
          } else chunk += g;
        }
        if (chunk) await drawWord(chunk);
      } else await drawWord(word);
      x += space;
    }
    newLine();
  }
  return saveDoc(doc);
}

export async function textToHandwriting(text: string, o: HandOpts = {}): Promise<OutFile> {
  if (!text.trim()) throw new Error("Type or paste the text to write out.");
  return pdfOut("handwritten.pdf", await handwritingPdf(text, o));
}
