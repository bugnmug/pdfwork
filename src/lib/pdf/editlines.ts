/**
 * The lines Edit text offers for retyping: each run of words on a line (cells of a table row
 * are separate), with its box, baseline, size and the font it is set in.
 */
import type { PDFPageProxy } from "pdfjs-dist";
import type { Family } from "./fonts";

export type EditLine = {
  text: string;
  /** Box of the words on the page as seen: points from the top left, y down. */
  x: number;
  y: number;
  w: number;
  h: number;
  base: number;
  size: number;
  family: Family;
  /** The font's own name (for matchFace), e.g. "LiberationSans" or "Calibri". */
  face?: string;
  bold: boolean;
  italic: boolean;
};

export async function editableLines(page: PDFPageProxy): Promise<EditLine[]> {
  const { pageText, toLines, enrichFontStyles } = await import("./pdfjs");
  const { segments, segmentOf } = await import("./structure");
  const pt = await pageText(page);
  await enrichFontStyles(page, pt.items);
  const out: EditLine[] = [];
  for (const line of toLines(pt)) {
    if (line.dir !== 0) continue;
    for (const whole of segments(line)) {
      // A list's bullet, one symbol in a font of its own, stays as it is: only the words are retyped.
      const first = whole.items[0];
      const s = whole.items.length > 1 && [...first.str.trim()].length === 1 && first.fontName !== whole.items[1].fontName && !/[\p{L}\p{N}]/u.test(first.str) ? segmentOf(whole.items.slice(1)) : whole;
      const its = s.items;
      if (!its.length || !s.text.trim()) continue;
      // The line's own font: the one most of its letters are set in.
      const count = new Map<string, number>();
      for (const i of its) count.set(i.fontName, (count.get(i.fontName) ?? 0) + i.str.trim().length);
      const main = its.reduce((m, i) => ((count.get(i.fontName) ?? 0) > (count.get(m.fontName) ?? 0) ? i : m), its[0]);
      const y = Math.min(...its.map((i) => i.y));
      const h = Math.max(...its.map((i) => i.y + i.h)) - y;
      const chars = its.reduce((n, i) => n + i.str.length, 0) || 1;
      out.push({
        text: s.text.replace(/\s+/g, " ").trim(),
        x: s.x,
        y,
        w: s.x2 - s.x,
        h,
        base: its.reduce((n, i) => n + i.base, 0) / its.length,
        size: its.reduce((n, i) => n + i.fontSize * i.str.length, 0) / chars,
        family: main.family,
        face: main.face,
        bold: its.filter((i) => i.bold).length > its.length / 2,
        italic: its.filter((i) => i.italic).length > its.length / 2,
      });
    }
  }
  return out;
}
