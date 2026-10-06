/**
 * Real redaction. Covering words with a filled box only hides them on screen;
 * the characters remain in the file's content and can still be copied. Here every page that has a redaction is
 * re-created from a rendered image with the boxes burned in, so the original
 * glyphs, vectors and images under the boxes are gone. The page's remaining
 * text is then laid back on top as an invisible layer, minus the redacted
 * characters, so everything outside the boxes can still be searched and copied.
 */
import {
  appendPages,
  canvasToBytes,
  newDoc,
  pdfOut,
  saveDoc,
  stem,
  tick,
  type OutFile,
  type ProgressFn,
} from "./core";
import { FontSet, advances } from "./fonts";
import { pageFrame, place } from "./geometry";
import { open, type Src } from "./pages";
import { extractPages, rangeBox, renderPage, toLines, withPdfjs, type PageText, type TextItem } from "./pdfjs";
import { findPii, PII_LABEL, type FindOpts, type PiiHit } from "./pii";

/**
 * A rectangle in the visual frame of a page, PDF points, top-left origin.
 * `snap` boxes come from text matches: their left/right edges are pushed out
 * to the nearest whitespace on the rendered page so no partial glyph survives.
 */
export type Box = {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  snap?: boolean;
  /** Text-match source, used to re-measure the box against the rendered page. */
  ref?: { item: TextItem; start: number; end: number; adv: number[] };
};

export type RedactOpts = { color?: string; dpi?: number; keepText?: boolean; scrubMetadata?: boolean };

export async function redactBoxes(src: Src, boxes: Box[], o: RedactOpts = {}, onProgress?: ProgressFn): Promise<OutFile> {
  if (!boxes.length) throw new Error("Mark at least one area to redact.");
  const doc = await open(src);
  const n = doc.getPageCount();
  const byPage = new Map<number, Box[]>();
  for (const b of boxes) {
    if (b.page < 0 || b.page >= n || b.w <= 0 || b.h <= 0) continue;
    byPage.set(b.page, [...(byPage.get(b.page) ?? []), b]);
  }
  const texts = o.keepText !== false ? await extractPages(src.bytes, { password: src.password }) : [];
  const out = await newDoc();
  const fonts = new FontSet(out);
  const fill = o.color || "#000000";
  const dpi = o.dpi ?? 200;
  await withPdfjs(
    src.bytes,
    async ({ pdf }) => {
      let done = 0;
      for (let i = 0; i < n; i++) {
        const list = byPage.get(i);
        if (!list) {
          await appendPages(out, doc, [i]);
          continue;
        }
        onProgress?.(done++ / byPage.size, `Redacting page ${i + 1}`);
        const page = await pdf.getPage(i + 1);
        const scale = dpi / 72;
        const canvas = await renderPage(page, scale, { annotations: true, readback: true });
        page.cleanup();
        const ctx = canvas.getContext("2d")!;
        const final = list.map((b) => (b.snap ? snapToWhitespace(ctx, b.ref ? calibrate(ctx, b, scale) : b, scale) : b));
        ctx.fillStyle = fill;
        for (const b of final) ctx.fillRect(Math.floor(b.x * scale), Math.floor(b.y * scale), Math.ceil(b.w * scale) + 1, Math.ceil(b.h * scale) + 1);
        const f = pageFrame(doc.getPage(i));
        const img = await out.embedJpg(await canvasToBytes(canvas, "image/jpeg", 0.9));
        canvas.width = canvas.height = 0;
        const np = out.addPage([f.width, f.height]);
        np.drawImage(img, { x: 0, y: 0, width: f.width, height: f.height });
        if (o.keepText !== false && texts[i]) await restoreText(np, fonts, texts[i], final);
        await tick();
      }
    },
    src.password,
  );
  copyMeta(doc, out, o.scrubMetadata !== false);
  return pdfOut(`${stem(src.name)}-redacted.pdf`, await saveDoc(out), `${boxes.length} area${boxes.length === 1 ? "" : "s"} redacted on ${byPage.size} page${byPage.size === 1 ? "" : "s"}`);
}

function copyMeta(from: Awaited<ReturnType<typeof open>>, to: Awaited<ReturnType<typeof newDoc>>, scrub: boolean) {
  if (scrub) return;
  const t = from.getTitle();
  if (t) to.setTitle(t);
  const a = from.getAuthor();
  if (a) to.setAuthor(a);
}

function intersects(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Invisible text layer with redacted characters removed. */
async function restoreText(page: ReturnType<Awaited<ReturnType<typeof newDoc>>["addPage"]>, fonts: FontSet, pt: PageText, boxes: Box[]) {
  const f = pageFrame(page);
  for (const it of pt.items) {
    if (!it.str.trim()) continue;
    let text = it.str;
    if (boxes.some((b) => intersects(it.bbox, b))) {
      const adv = await advances(it.str, it.family);
      let out = "";
      for (let k = 0; k < it.str.length; k++) {
        const cb = rangeBox(it, k, k + 1, 0, adv);
        out += boxes.some((b) => intersects(shrink(cb), b)) ? " " : it.str[k];
      }
      text = out;
      if (!text.trim()) continue;
    }
    // Visual (y down) → visual (y up) for placement.
    const p = place(f, it.ox, f.height - it.oy, -it.dir);
    await fonts.drawInvisible(page, text, { x: p.x, y: p.y, size: it.fontSize, width: it.w, rotate: p.rotate });
  }
}

const shrink = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w * 0.35, y: r.y + r.h * 0.3, w: r.w * 0.3, h: r.h * 0.4 });

/**
 * Re-measure a text match against the rendered page. Character positions are
 * first estimated from font metrics; each run of spaces in the text is then
 * matched to the visible gap between words on the page, and positions are
 * interpolated between those anchors. Word boundaries end up exact.
 */
function calibrate(ctx: CanvasRenderingContext2D, b: Box, scale: number): Box {
  const ref = b.ref!;
  const it = ref.item;
  if (it.dir !== 0 || it.w <= 0) return b;
  const total = ref.adv.reduce((s, x) => s + x, 0) || 1;
  const est = (n: number) => (ref.adv.slice(0, n).reduce((s, x) => s + x, 0) / total) * it.w; // points from item start
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const y0 = Math.max(0, Math.floor((it.oy - it.fontSize * 0.75) * scale));
  const y1 = Math.min(H, Math.ceil((it.oy + it.fontSize * 0.15) * scale));
  const x0 = Math.max(0, Math.floor((it.ox - it.fontSize) * scale));
  const x1 = Math.min(W, Math.ceil((it.ox + it.w + it.fontSize) * scale));
  if (y1 - y0 < 2 || x1 - x0 < 4) return b;
  const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const bw = x1 - x0;
  const rows = y1 - y0;
  const ink: boolean[] = new Array(bw).fill(false);
  for (let cx = 0; cx < bw; cx++) {
    for (let r = 0; r < rows; r++) {
      const k = (r * bw + cx) * 4;
      if (data[k] * 0.3 + data[k + 1] * 0.59 + data[k + 2] * 0.11 < 170) {
        ink[cx] = true;
        break;
      }
    }
  }
  const start = (it.ox * scale) - x0;
  const end = ((it.ox + it.w) * scale) - x0;
  // Blank runs wide enough to be word gaps, inside the item's span.
  const em = it.fontSize * scale;
  const minGap = Math.max(2, em * 0.12);
  const gaps: { c: number; w: number }[] = [];
  let run = -1;
  for (let cx = Math.max(0, Math.floor(start)); cx <= Math.min(bw - 1, Math.ceil(end)); cx++) {
    if (!ink[cx]) {
      if (run < 0) run = cx;
    } else if (run >= 0) {
      if (cx - run >= minGap && run > start + 1) gaps.push({ c: (run + cx) / 2, w: cx - run });
      run = -1;
    }
  }
  // Space runs in the string, with their estimated centres (points from item start).
  const spaces: number[] = [];
  const re = / +/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(it.str))) if (m.index > 0 && m.index + m[0].length < it.str.length) spaces.push((est(m.index) + est(m.index + m[0].length)) / 2);
  // Walk left to right, predicting each space from the previous anchor so
  // metric differences between fonts cannot accumulate along the line.
  const anchors: [number, number][] = [[0, start]];
  let lastEst = 0;
  let lastPx = start;
  let gi = 0;
  for (const sp of spaces) {
    const expected = lastPx + (sp - lastEst) * scale;
    let best = -1;
    let bestScore = -Infinity;
    for (let k = gi; k < gaps.length; k++) {
      const d = Math.abs(gaps[k].c - expected);
      if (gaps[k].c > expected + em * 0.45) break;
      if (d > em * 0.45) continue;
      const score = gaps[k].w * 0.6 - d;
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (best >= 0) {
      anchors.push([sp, gaps[best].c]);
      lastEst = sp;
      lastPx = gaps[best].c;
      gi = best + 1;
    }
  }
  anchors.push([it.w, end]);
  anchors.sort((a, c) => a[0] - c[0]);
  const map = (pt: number) => {
    for (let k = 1; k < anchors.length; k++) {
      const [ea, pa] = anchors[k - 1];
      const [eb, pb] = anchors[k];
      if (pt <= eb || k === anchors.length - 1) {
        const t = eb - ea > 1e-6 ? (pt - ea) / (eb - ea) : 0;
        return pa + t * (pb - pa);
      }
    }
    return start + pt * scale;
  };
  const left = (map(est(ref.start)) + x0) / scale;
  const right = (map(est(ref.end)) + x0) / scale;
  // Edges now sit in the middle of word gaps (or inside a word for partial matches,
  // where snapping widens them to the next glyph boundary), so no padding is needed.
  return { ...b, x: left, w: right - left };
}

/**
 * Push a text box's left and right edges outward until each lands in a blank
 * column of the rendered page (between glyphs), so estimated character
 * positions can never leave half a letter visible.
 */
function snapToWhitespace(ctx: CanvasRenderingContext2D, b: Box, scale: number): Box {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const y0 = Math.max(0, Math.floor(b.y * scale));
  const y1 = Math.min(H, Math.ceil((b.y + b.h) * scale));
  if (y1 - y0 < 2 || b.w > b.h * 60) return b;
  const x0 = Math.max(0, Math.floor(b.x * scale) - Math.ceil(b.h * scale * 1.2));
  const x1 = Math.min(W, Math.ceil((b.x + b.w) * scale) + Math.ceil(b.h * scale * 1.2));
  const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const bw = x1 - x0;
  const rows = y1 - y0;
  // Background = brightest common value in the band; ink = clearly darker or different.
  let bgSum = 0;
  let bgN = 0;
  for (let i = 0; i < img.length; i += 16) {
    const l = img[i] * 0.3 + img[i + 1] * 0.59 + img[i + 2] * 0.11;
    if (l > 200) {
      bgSum += l;
      bgN++;
    }
  }
  const bg = bgN ? bgSum / bgN : 255;
  const inkCol = (cx: number) => {
    for (let r = 0; r < rows; r++) {
      const k = (r * bw + cx) * 4;
      const l = img[k] * 0.3 + img[k + 1] * 0.59 + img[k + 2] * 0.11;
      if (Math.abs(bg - l) > 70) return true;
    }
    return false;
  };
  const limit = Math.ceil(b.h * scale * 1.2);
  let left = Math.floor(b.x * scale) - x0;
  for (let k = 0; k < limit && left > 0 && inkCol(left); k++) left--;
  let right = Math.ceil((b.x + b.w) * scale) - x0;
  for (let k = 0; k < limit && right < bw - 1 && inkCol(right); k++) right++;
  const nx = (left + x0) / scale;
  const nr = (right + x0) / scale;
  return { ...b, x: Math.min(b.x, nx), w: Math.max(b.x + b.w, nr) - Math.min(b.x, nx) };
}

export type Finding = PiiHit & { page: number; boxes: Box[] };

/** Map regex hits on page text back to character boxes on the page. */
export async function findOnPage(pt: PageText, pageIndex: number, opts: FindOpts): Promise<Finding[]> {
  const lines = toLines(pt);
  let text = "";
  const map: { item: TextItem; ch: number }[] = [];
  for (const line of lines) {
    let prevEnd = -Infinity;
    for (const it of line.items) {
      if (text && !text.endsWith("\n")) {
        const gap = it.x - prevEnd;
        if (gap > it.fontSize * 0.18 && !/\s$/.test(text) && !/^\s/.test(it.str)) {
          text += " ";
          map.push({ item: it, ch: -1 });
        }
      }
      let k = 0;
      for (const ch of it.str) {
        text += ch;
        map.push({ item: it, ch: k });
        for (let extra = 1; extra < ch.length; extra++) map.push({ item: it, ch: k });
        k += ch.length;
      }
      prevEnd = it.x + it.w;
    }
    text += "\n";
    map.push({ item: line.items[0], ch: -1 });
  }
  const hits = findPii(text, opts);
  const advCache = new Map<TextItem, number[]>();
  for (const h of hits) {
    for (let k = h.index; k < h.index + h.length; k++) {
      const m = map[k];
      if (m && m.ch >= 0 && !advCache.has(m.item)) advCache.set(m.item, await advances(m.item.str, m.item.family));
    }
  }
  return hits.map((h) => {
    const spans = new Map<TextItem, [number, number]>();
    for (let k = h.index; k < h.index + h.length; k++) {
      const m = map[k];
      if (!m || m.ch < 0) continue;
      const cur = spans.get(m.item);
      if (!cur) spans.set(m.item, [m.ch, m.ch + 1]);
      else {
        cur[0] = Math.min(cur[0], m.ch);
        cur[1] = Math.max(cur[1], m.ch + 1);
      }
    }
    const boxes: Box[] = [];
    for (const [item, [a, b]] of spans) {
      const r = rangeBox(item, a, b, 1.2, advCache.get(item));
      boxes.push({ page: pageIndex, ...r, label: PII_LABEL[h.kind], snap: item.dir === 0, ref: { item, start: a, end: b, adv: advCache.get(item) ?? [] } });
    }
    return { ...h, page: pageIndex, boxes };
  });
}

export async function scanDocument(src: Src, opts: FindOpts, onProgress?: ProgressFn): Promise<{ findings: Finding[]; pages: number; textPages: number }> {
  const pages = await extractPages(src.bytes, { password: src.password, onProgress });
  const findings: Finding[] = [];
  let textPages = 0;
  for (let i = 0; i < pages.length; i++) {
    const pt = pages[i];
    if (pt.items.some((it) => it.str.trim())) textPages++;
    findings.push(...(await findOnPage(pt, i, opts)));
  }
  return { findings, pages: pages.length, textPages };
}

export async function autoRedact(src: Src, opts: FindOpts & RedactOpts, onProgress?: ProgressFn): Promise<OutFile[]> {
  const { findings, textPages, pages } = await scanDocument(src, opts, (f, l) => onProgress?.(f * 0.3, l));
  if (!textPages) throw new Error("This looks like a scan, so there's no text to search. Open it in OCR: Searchable PDF first, then redact.");
  if (!findings.length) throw new Error("Nothing matched, so nothing was redacted. Add custom words or patterns if you expected matches.");
  const boxes = findings.flatMap((f) => f.boxes);
  const pdf = await redactBoxes(src, boxes, opts, (f, l) => onProgress?.(0.3 + f * 0.7, l));
  const report = redactionReport(src.name, findings, pages);
  pdf.note = `${findings.length} item${findings.length === 1 ? "" : "s"} redacted`;
  return [pdf, { filename: `${stem(src.name)}-redaction-log.txt`, bytes: new TextEncoder().encode(report), mime: "text/plain", note: "What was removed (masked)" }];
}

export function mask(v: string): string {
  const s = v.trim();
  if (s.length <= 4) return "•".repeat(s.length);
  return s.slice(0, 2) + "•".repeat(Math.max(1, s.length - 4)) + s.slice(-2);
}

export function redactionReport(name: string, findings: Finding[], pages: number, title = "Redaction log"): string {
  const by = new Map<string, number>();
  for (const f of findings) by.set(PII_LABEL[f.kind], (by.get(PII_LABEL[f.kind]) ?? 0) + 1);
  return [
    `${title} for ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Pages scanned: ${pages}`,
    "",
    ...[...by.entries()].map(([k, n]) => `${k}: ${n}`),
    "",
    ...findings.map((f) => `p.${f.page + 1}  ${PII_LABEL[f.kind].padEnd(20)} ${mask(f.value)}`),
  ].join("\n");
}

