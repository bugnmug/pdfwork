/**
 * Showing text in a content stream so it copies and searches correctly.
 *
 * Indic scripts draw some vowel signs before the letter they follow (हि is
 * drawn as ि then ह), so each such cluster carries its letters as ActualText.
 * Clusters are shown one after another in the same text object, so the glyphs
 * and their advances are those of the whole run.
 */
import { PDFHexString, PDFName, PDFOperator, PDFOperatorNames, endMarkedContent, showText, type PDFFont } from "@cantoo/pdf-lib";

/** Scripts whose glyphs can come out in another order than their letters (Indic scripts). */
export const COMPLEX = /[\u0900-\u0dff]/;

type Segmenter = new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> };

export function showOps(font: PDFFont, text: string): PDFOperator[] {
  const whole = font.encodeText(text);
  const Seg = (Intl as { Segmenter?: Segmenter }).Segmenter;
  if (!COMPLEX.test(text) || !Seg) return [showText(whole)];
  const span = (t: string) => PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of("Span"), `<</ActualText ${PDFHexString.fromText(t).toString()}>>`]);
  const clusters = [...new Seg(undefined, { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  const parts = clusters.map((c) => font.encodeText(c));
  // Shaping that reaches across clusters would change the glyphs: then one span for the run.
  if (parts.map((p) => p.asString()).join("") !== whole.asString()) return [span(text), showText(whole), endMarkedContent()];
  const ops: PDFOperator[] = [];
  clusters.forEach((c, i) => {
    if (COMPLEX.test(c) && [...c].length > 1) ops.push(span(c), showText(parts[i]), endMarkedContent());
    else ops.push(showText(parts[i]));
  });
  return ops;
}
