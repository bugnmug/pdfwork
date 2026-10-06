/**
 * PDF.js wrapper. Uses the "legacy" build, which ships polyfills for the
 * newest JavaScript built-ins the modern build assumes (the modern build
 * crashed on any browser older than a few months). Character maps, standard
 * fonts and image decoders are served from this site, not a CDN. The worker is
 * a patched copy (scripts/copy-assets.mjs) that reads a PDF's ActualText and
 * marks the spaces it infers, so text comes back as the document says it.
 */
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

type PdfjsMod = typeof import("pdfjs-dist");
let cached: Promise<PdfjsMod> | null = null;

const base = () => ((import.meta.env?.BASE_URL as string | undefined) ?? "/").replace(/\/?$/, "/");

export function getPdfjs(): Promise<PdfjsMod> {
  if (!cached) {
    cached = (async () => {
      const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsMod;
      pdfjs.GlobalWorkerOptions.workerSrc = `${base()}vendor/pdfjs/pdf.worker.mjs`;
      return pdfjs;
    })();
    cached.catch(() => (cached = null));
  }
  return cached;
}

export type OpenedPdf = { pdf: PDFDocumentProxy; pageCount: number; close: () => Promise<void> };

export class PdfjsPasswordError extends Error {
  constructor(public readonly wrong: boolean) {
    super(wrong ? "That isn't the password for this PDF." : "This PDF is locked. It needs its password before it can be opened.");
    this.name = "PasswordError";
  }
}

export async function openPdfjs(bytes: Uint8Array, password?: string): Promise<OpenedPdf> {
  const pdfjs = await getPdfjs();
  const vendor = `${base()}vendor/pdfjs/`;
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: `${vendor}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${vendor}standard_fonts/`,
    wasmUrl: `${vendor}wasm/`,
    iccUrl: `${vendor}iccs/`,
    useSystemFonts: false,
    isEvalSupported: false,
    enableXfa: false,
    // Keeps font names and bold/italic flags, used to preserve styling in conversions and Edit text.
    fontExtraProperties: true,
  } as Parameters<PdfjsMod["getDocument"]>[0]);
  try {
    const pdf = await task.promise;
    return { pdf, pageCount: pdf.numPages, close: () => task.destroy() };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === "PasswordException") {
      const code = (e as { code?: number }).code;
      throw new PdfjsPasswordError(code === 2);
    }
    throw e;
  }
}

/** Run fn with an open document and always release the worker memory afterwards. */
export async function withPdfjs<T>(bytes: Uint8Array, fn: (o: OpenedPdf) => Promise<T>, password?: string): Promise<T> {
  const o = await openPdfjs(bytes, password);
  try {
    return await fn(o);
  } finally {
    await o.close().catch(() => undefined);
  }
}

/** Largest canvas iPhone and iPad Safari will draw (4096 × 4096); bigger ones come out blank. */
const CANVAS_AREA_LIMIT = 4096 * 4096;

export async function renderPage(
  page: PDFPageProxy,
  scale: number,
  opts: { background?: string; pixelBudget?: number; annotations?: boolean; readback?: boolean } = {},
): Promise<HTMLCanvasElement> {
  let s = scale;
  const base = page.getViewport({ scale: 1 });
  // Shrink the scale when the page would exceed its pixel budget (never more than the canvas limit).
  const budget = Math.min(opts.pixelBudget ?? CANVAS_AREA_LIMIT, CANVAS_AREA_LIMIT);
  const area = base.width * base.height;
  if (area * s * s > budget) s = Math.sqrt(budget / area);
  const viewport = page.getViewport({ scale: s });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  // `readback`: the caller will read pixels back (redaction, OCR, cropping), so keep the canvas on the CPU.
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: !!opts.readback });
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  ctx.fillStyle = opts.background ?? "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({
    canvasContext: ctx,
    canvas,
    viewport,
    annotationMode: opts.annotations === false ? 0 : 2, // 2 = ENABLE_FORMS: draw annotation appearances
  } as Parameters<PDFPageProxy["render"]>[0]);
  keepRenderingWhenHidden(task);
  await task.promise;
  return canvas;
}

/**
 * pdf.js paces screen rendering with animation frames, and browsers stop delivering frames to
 * background tabs (embedded browsers also do when their pane isn't painted). A long job would
 * freeze the moment someone switched tabs and resume only when they came back. This keeps
 * frame pacing while the page is visible and switches to plain tasks once it is hidden.
 * It replaces one method on this render task only; if pdf.js internals change, the guard
 * leaves the default behaviour in place.
 */
type RenderInternals = { _scheduleNext: () => void; _nextBound: () => Promise<void>; _cancelBound: (e: unknown) => void };

function keepRenderingWhenHidden(task: unknown) {
  const internal = (task as { _internalRenderTask?: Partial<RenderInternals> } | null)?._internalRenderTask;
  if (!internal || typeof internal._scheduleNext !== "function" || typeof internal._nextBound !== "function" || typeof internal._cancelBound !== "function") return;
  const it = internal as RenderInternals;
  it._scheduleNext = () => {
    const run = () => {
      it._nextBound().catch(it._cancelBound);
    };
    if (document.visibilityState !== "visible") return soon(run);
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      document.removeEventListener("visibilitychange", go);
      run();
    };
    // Whichever comes first: the next frame, or the page being hidden (frames then stop).
    document.addEventListener("visibilitychange", go);
    requestAnimationFrame(go);
  };
}

/** Run fn as a separate task. Unlike timers, message tasks aren't throttled in background tabs. */
const soonQueue: (() => void)[] = [];
let soonChannel: MessageChannel | null = null;
function soon(fn: () => void) {
  if (!soonChannel) {
    soonChannel = new MessageChannel();
    soonChannel.port1.onmessage = () => soonQueue.shift()?.();
  }
  soonQueue.push(fn);
  soonChannel.port2.postMessage(0);
}

export async function renderPageCanvas(pdf: PDFDocumentProxy, pageNumber: number, scale = 1.4): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageNumber);
  try {
    return await renderPage(page, scale);
  } finally {
    page.cleanup();
  }
}

export type Dir = 0 | 90 | 180 | 270;

export type TextItem = {
  str: string;
  /** Reading direction in the visual frame, clockwise degrees (0 = normal left-to-right). */
  dir: Dir;
  /** Upright frame (text reads left to right, y grows downward): */
  x: number;
  w: number;
  /** Baseline position along the "down" axis of the upright frame. */
  base: number;
  /** Top of the glyph box (base - ascent) in the upright frame. */
  y: number;
  h: number;
  fontSize: number;
  /** Visual frame (as displayed, top-left origin, y down): baseline origin and unit direction. */
  ox: number;
  oy: number;
  ax: number;
  ay: number;
  /** Axis-aligned visual bounding box. */
  bbox: { x: number; y: number; w: number; h: number };
  fontName: string;
  /** Closest generic family, used for character-position estimates. */
  family: "sans" | "serif" | "mono";
  bold: boolean;
  italic: boolean;
  hasEOL: boolean;
  /** Fill colour as #rrggbb; missing when the PDF uses a colour space that can't be read directly. */
  color?: string;
  /** Font family name from the PDF (see fontFace), when known. */
  face?: string;
  /** Letter-spacing: extra space after each character, as a fraction of the font size (tracked-out labels). */
  track?: number;
};

/** A filled or stroked shape (rectangle, rule, box), as its bounding box in the visual frame; `round` when drawn with curves. */
export type Shape = { x: number; y: number; w: number; h: number; fill?: string; stroke?: string; round?: boolean };

export type PageText = { page: number; width: number; height: number; items: TextItem[]; shapes?: Shape[] };

/** Names of serif faces, for PDFs that don't flag their fonts as serif. */
const SERIF = /serif|times|roman|georgia|garamond|cambria|bookantiqua|bookman|minion|palatino|lora|merriweather|playfair|baskerville|caslon|bodoni|didot|charter|crimson|spectral|literata|newsreader|fraunces|cormorant|bitter|slab|alegreya|cardo|gelasio|tinos|domine|vollkorn|noticia|constantia|sabon|utopia|perpetua|rockwell|tiempos|chronicle|schoolbook|goudy|janson|plantin|joanna|calisto|libertin|kepler|warnock|stix|lmroman|cmr\d/i;

const ASC = 0.82;
const DESC = 0.22;

/**
 * A space the worker inferred from a gap between glyphs: a marker, then the gap's width
 * in thousandths of the font size as one private-use character (scripts/copy-assets.mjs).
 */
const INFERRED = /\u0091([\uE000-\uEFFF])/g;

/**
 * Settle inferred spaces. In letter-spaced text (tracked-out labels) nearly every pair
 * of letters has a gap of the same width; only the wider gaps between words are spaces.
 * Elsewhere every inferred gap is a word space. Also maps stand-in characters some
 * fonts report for curly quotes.
 */
export function cleanItemText(str: string): string {
  return settleItemText(str).str;
}

/** cleanItemText, also giving the letter-spacing of tracked-out text (a fraction of the font size). */
export function settleItemText(str: string): { str: string; track?: number } {
  let out = str;
  let track: number | undefined;
  if (out.includes("\u0091")) {
    const gaps = [...out.matchAll(INFERRED)].map((m) => (m[1].charCodeAt(0) - 0xe000) / 1000);
    const letters = out.replace(INFERRED, "").replace(/\s+/g, "").length;
    let word = 0;
    if (gaps.length >= 3 && gaps.length >= (letters - 1) * 0.5) {
      // Tracking is the common, smallest gap; a word break adds roughly a space to it.
      const sorted = [...gaps].sort((a, b) => a - b);
      word = sorted[Math.floor(sorted.length * 0.25)] + 0.12;
      const within = sorted.filter((g) => g <= word);
      track = within.length ? within[Math.floor(within.length / 2)] : undefined;
    }
    out = out.replace(INFERRED, (_, g: string) => ((g.charCodeAt(0) - 0xe000) / 1000 > word ? " " : ""));
  }
  return { str: out.replace(/\u02BC/g, "\u2019").replace(/\u02EE/g, "\u201D"), ...(track && track > 0.02 ? { track } : {}) };
}

/** Text items with geometry in the visual frame (handles /Rotate, crop offsets and rotated text). */
export async function pageText(page: PDFPageProxy): Promise<PageText> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ includeMarkedContent: false } as never);
  const styles = (content as unknown as { styles: Record<string, { fontFamily?: string }> }).styles ?? {};
  const items: TextItem[] = [];
  for (const raw of content.items) {
    if (!("str" in raw)) continue;
    const item = raw as { str: string; transform: number[]; width: number; height: number; fontName: string; hasEOL: boolean; color?: string };
    const settled = settleItemText(item.str);
    item.str = settled.str;
    if (!item.str) continue;
    const m = multiply(viewport.transform, item.transform);
    const fontSize = Math.hypot(m[2], m[3]) || item.height || 1;
    const len = Math.hypot(m[0], m[1]) || 1;
    // Direction of the text baseline in visual space (y down), snapped to 90° steps.
    const ang = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    const dir = ((((Math.round(ang / 90) * 90) % 360) + 360) % 360) as Dir;
    const ax = m[0] / len;
    const ay = m[1] / len;
    const w = Math.abs(item.width) * (len / Math.max(1e-6, Math.hypot(item.transform[0], item.transform[1])));
    const ox = m[4];
    const oy = m[5];
    // Upright frame: rotate the page so this text reads left to right, origin at its top-left.
    const VW = viewport.width;
    const VH = viewport.height;
    const X = dir === 0 ? ox : dir === 90 ? oy : dir === 180 ? VW - ox : VH - oy;
    const Y = dir === 0 ? oy : dir === 90 ? VW - ox : dir === 180 ? VH - oy : ox;
    // Visual bbox from the corner points of the glyph box.
    const px = -ay;
    const py = ax; // "down" perpendicular in visual space
    const corners = [
      [ox - px * fontSize * ASC, oy - py * fontSize * ASC],
      [ox + px * fontSize * DESC, oy + py * fontSize * DESC],
    ].flatMap(([x, y]) => [
      [x, y],
      [x + ax * w, y + ay * w],
    ]);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const fam = `${item.fontName} ${styles[item.fontName]?.fontFamily ?? ""}`;
    items.push({
      str: item.str,
      dir,
      x: X,
      w,
      base: Y,
      y: Y - fontSize * ASC,
      h: fontSize * (ASC + DESC),
      fontSize,
      ox,
      oy,
      ax,
      ay,
      bbox: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
      fontName: item.fontName,
      family: /mono|courier|consol|menlo|typewriter/i.test(fam) ? "mono" : SERIF.test(fam) && !/sans/i.test(fam) ? "serif" : "sans",
      bold: /bold|black|heavy|semibold|demi/i.test(fam),
      italic: /italic|oblique/i.test(fam),
      hasEOL: item.hasEOL,
      ...(item.color && /^#[0-9a-f]{6}$/.test(item.color) ? { color: item.color } : {}),
      ...(settled.track ? { track: settled.track } : {}),
    });
  }
  return { page: page.pageNumber, width: viewport.width, height: viewport.height, items };
}

type OpList = { fnArray: number[]; argsArray: unknown[] };

/**
 * Filled and stroked shapes on a page (backgrounds, boxes, rules, check boxes), from its
 * operator list. Shapes inside annotations are left out; clipping paths are ignored.
 */
function shapesOf(ops: OpList, OPS: Record<string, number>, vt: number[]): Shape[] {
  const out: Shape[] = [];
  type St = { ctm: number[]; fill?: string; stroke?: string; lw: number };
  let st: St = { ctm: [1, 0, 0, 1, 0, 0], fill: "#000000", stroke: "#000000", lw: 1 };
  const stack: St[] = [];
  const FILL = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  let annot = 0;
  for (let i = 0; i < ops.fnArray.length && out.length < 5000; i++) {
    const fn = ops.fnArray[i];
    const a = ops.argsArray[i] as unknown[];
    if (fn === OPS.beginAnnotation) annot++;
    else if (fn === OPS.endAnnotation) annot = Math.max(0, annot - 1);
    if (annot) continue;
    if (fn === OPS.save || fn === OPS.beginGroup) stack.push({ ...st });
    else if (fn === OPS.restore || fn === OPS.endGroup || fn === OPS.paintFormXObjectEnd) st = stack.pop() ?? st;
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ...st });
      const m = a?.[0] as number[] | null;
      if (m && m.length === 6) st.ctm = multiply(st.ctm, Array.from(m));
    } else if (fn === OPS.transform) st.ctm = multiply(st.ctm, Array.from(a as number[]));
    else if (fn === OPS.setFillRGBColor) st.fill = typeof a[0] === "string" ? a[0] : undefined;
    else if (fn === OPS.setStrokeRGBColor) st.stroke = typeof a[0] === "string" ? a[0] : undefined;
    else if (fn === OPS.setFillTransparent) st.fill = undefined;
    else if (fn === OPS.setStrokeTransparent) st.stroke = undefined;
    else if (fn === OPS.setLineWidth) st.lw = Number(a[0]) || 0;
    else if (fn === OPS.constructPath) {
      const paint = a[0] as number;
      const path = (a[1] as ArrayLike<number>[] | undefined)?.[0];
      const mm = a[2] as ArrayLike<number> | null;
      const fill = FILL.has(paint) ? st.fill : undefined;
      const stroke = STROKE.has(paint) ? st.stroke : undefined;
      if (!mm || (!fill && !stroke) || !(mm[2] >= mm[0]) || !(mm[3] >= mm[1])) continue;
      const m = multiply(vt, st.ctm);
      const pts = [
        [mm[0], mm[1]],
        [mm[2], mm[1]],
        [mm[0], mm[3]],
        [mm[2], mm[3]],
      ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      // A stroke reaches half the line width past the path.
      const pad = stroke ? (Math.max(st.lw, 0.5) * Math.hypot(m[0], m[1])) / 2 : 0;
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad;
      // Path data: 0 move (2 numbers), 1 line (2), 2 curve (6), 3 quadratic curve (4), 4 close.
      // Round: curves and no straight sides (a circle, not a rounded rectangle).
      let curves = 0;
      let straight = 0;
      for (let k = 0; path && k < path.length; ) {
        const op = path[k++];
        if (op === 2 || op === 3) curves++;
        else if (op === 1) straight++;
        k += op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 3 ? 4 : 0;
      }
      const round = curves > 0 && straight === 0;
      out.push({ x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y, ...(fill ? { fill } : {}), ...(stroke ? { stroke } : {}), ...(round ? { round } : {}) });
    }
  }
  return out;
}

/**
 * Visual bounding box of characters [start, end) of an item. With `adv`
 * (per-character advance estimates) positions follow real glyph widths;
 * without it they are proportional to character count.
 */
export function rangeBox(it: TextItem, start: number, end: number, pad = 1, adv?: number[]) {
  let a: number;
  let b: number;
  if (adv && adv.length === it.str.length) {
    const total = adv.reduce((s, x) => s + x, 0) || 1;
    const sum = (n: number) => adv.slice(0, n).reduce((s, x) => s + x, 0);
    a = (sum(start) / total) * it.w;
    b = (sum(end) / total) * it.w;
  } else {
    const n = Math.max(1, it.str.length);
    a = (start / n) * it.w;
    b = (end / n) * it.w;
  }
  const px = -it.ay;
  const py = it.ax;
  const pts: [number, number][] = [];
  for (const t of [a, b]) {
    const bx = it.ox + it.ax * t;
    const by = it.oy + it.ay * t;
    pts.push([bx - px * it.fontSize * ASC, by - py * it.fontSize * ASC]);
    pts.push([bx + px * it.fontSize * DESC, by + py * it.fontSize * DESC]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
}

function multiply(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/**
 * Resolve bold/italic from the actual font objects (fontName alone is often "g_d0_f3"),
 * and return the page's shapes (boxes, rules) from the same operator list.
 */
export async function enrichFontStyles(page: PDFPageProxy, items: TextItem[]): Promise<Shape[]> {
  const names = [...new Set(items.map((i) => i.fontName))];
  let ops: OpList;
  try {
    ops = (await page.getOperatorList()) as unknown as OpList;
  } catch {
    return [];
  }
  let shapes: Shape[] = [];
  try {
    const pdfjs = await getPdfjs();
    shapes = shapesOf(ops, pdfjs.OPS as unknown as Record<string, number>, page.getViewport({ scale: 1 }).transform);
  } catch {
    shapes = [];
  }
  if (!names.length) return shapes;
  const info = new Map<string, { bold: boolean; italic: boolean; family?: TextItem["family"]; face?: string }>();
  type FontObj = { name?: string; bold?: boolean; italic?: boolean; black?: boolean; isSerifFont?: boolean; isMonospace?: boolean };
  for (const n of names) {
    try {
      const objs = (page as unknown as { commonObjs: { has(n: string): boolean; get(n: string): FontObj } }).commonObjs;
      if (!objs.has(n)) continue;
      const f = objs.get(n);
      const nm = f?.name ?? "";
      const family =
        f?.isMonospace || /mono|courier|consol|menlo|typewriter/i.test(nm)
          ? "mono"
          : (f?.isSerifFont || SERIF.test(nm)) && !/sans/i.test(nm)
            ? "serif"
            : nm
              ? "sans"
              : undefined;
      info.set(n, { bold: !!f?.bold || !!f?.black || /bold|black|heavy|semibold|demi/i.test(nm), italic: !!f?.italic || /italic|oblique/i.test(nm), family, face: fontFace(nm) || undefined });
    } catch {
      /* ignore */
    }
  }
  for (const it of items) {
    const s = info.get(it.fontName);
    if (s) {
      it.bold = it.bold || s.bold;
      it.italic = it.italic || s.italic;
      if (s.family) it.family = s.family;
      if (s.face) it.face = s.face;
    }
  }
  return shapes;
}

/** The family part of a PDF font name: "ABCDEF+Lora-SemiBold" → "Lora", "TimesNewRomanPS-BoldMT" → "TimesNewRoman". */
export function fontFace(name: string): string {
  return name
    .replace(/^[A-Z]{6}\+/, "")
    .split(/[,-]/)[0]
    .replace(/(PSMT|PS|MT)$/, "")
    .trim();
}

export async function extractPages(
  bytes: Uint8Array,
  opts: { password?: string; styles?: boolean; onProgress?: (f: number, l: string) => void } = {},
): Promise<PageText[]> {
  return withPdfjs(
    bytes,
    async ({ pdf, pageCount }) => {
      const out: PageText[] = [];
      for (let i = 1; i <= pageCount; i++) {
        opts.onProgress?.(i / pageCount, `Reading page ${i} of ${pageCount}`);
        const page = await pdf.getPage(i);
        const t = await pageText(page);
        if (opts.styles) t.shapes = await enrichFontStyles(page, t.items);
        page.cleanup();
        out.push(t);
      }
      return out;
    },
    opts.password,
  );
}

export type Line = {
  text: string;
  dir: Dir;
  x: number;
  y: number;
  w: number;
  h: number;
  base: number;
  size: number;
  bold: boolean;
  italic: boolean;
  items: TextItem[];
};

/**
 * Group a page's text items into lines in reading order. Items are grouped
 * per reading direction (so text on rotated pages or rotated stamps is read
 * correctly); the dominant direction comes first.
 */
export function toLines(pt: PageText): Line[] {
  const byDir = new Map<Dir, TextItem[]>();
  for (const it of pt.items) {
    if (!it.str.trim() && !it.str.length) continue;
    const arr = byDir.get(it.dir) ?? [];
    arr.push(it);
    byDir.set(it.dir, arr);
  }
  const groups = [...byDir.entries()].sort((a, b) => count(b[1]) - count(a[1]));
  const out: Line[] = [];
  for (const [dir, items] of groups) {
    items.sort((a, b) => a.base - b.base || a.x - b.x);
    const lines: Line[] = [];
    for (const it of items) {
      const tol = Math.max(2, it.fontSize * 0.45);
      let line: Line | undefined;
      for (let k = lines.length - 1; k >= 0 && k >= lines.length - 6; k--) {
        const l = lines[k];
        if (Math.abs(l.base - it.base) <= tol && it.y < l.base + 2 && it.base > l.y - 2) {
          line = l;
          break;
        }
      }
      if (!line) {
        line = { text: "", dir, x: it.x, y: it.y, w: 0, h: it.h, base: it.base, size: it.fontSize, bold: it.bold, italic: it.italic, items: [] };
        lines.push(line);
      }
      line.items.push(it);
    }
    for (const l of lines) finishLine(l);
    out.push(...lines.filter((l) => l.text).sort((a, b) => a.y - b.y || a.x - b.x));
  }
  return out;
}

function count(items: TextItem[]) {
  return items.reduce((n, i) => n + i.str.length, 0);
}

function finishLine(l: Line) {
  l.items.sort((a, b) => a.x - b.x);
  let text = "";
  let prevEnd = -Infinity;
  for (const it of l.items) {
    const gap = it.x - prevEnd;
    if (text && gap > it.fontSize * 0.18 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
    text += it.str;
    prevEnd = it.x + it.w;
  }
  l.text = text.replace(/\s+/g, " ").trim();
  // Extents from the visible text: a space PDF.js puts in a wide gap can be far wider than the gap.
  const ink = l.items.filter((i) => i.str.trim());
  const shown = ink.length ? ink : l.items;
  const x0 = Math.min(...shown.map((i) => i.x));
  const x1 = Math.max(...shown.map((i) => i.x + i.w));
  l.x = x0;
  l.w = x1 - x0;
  l.y = Math.min(...shown.map((i) => i.y));
  l.h = Math.max(...shown.map((i) => i.y + i.h)) - l.y;
  l.base = l.items.reduce((s, i) => s + i.base, 0) / l.items.length;
  const weight = (pred: (i: TextItem) => boolean) => l.items.filter(pred).reduce((n, i) => n + i.str.length, 0);
  const total = weight(() => true) || 1;
  l.size = l.items.reduce((s, i) => s + i.fontSize * i.str.length, 0) / total;
  l.bold = weight((i) => i.bold) / total > 0.6;
  l.italic = weight((i) => i.italic) / total > 0.6;
}


/** Plain text in reading order (lines, blank line between paragraphs, page breaks as form feed). */
export async function extractPlainText(bytes: Uint8Array, password?: string): Promise<string> {
  const pages = await extractPages(bytes, { password });
  return pages.map((p) => linesToText(toLines(p))).join("\n\f\n").trim();
}

export function linesToText(lines: Line[]): string {
  let out = "";
  let prev: Line | null = null;
  for (const l of lines) {
    if (prev) {
      const gap = l.y - (prev.y + prev.h);
      out += gap > Math.max(prev.size, l.size) * 0.9 ? "\n\n" : "\n";
    }
    out += l.text;
    prev = l;
  }
  return out;
}

export async function getOutline(bytes: Uint8Array, password?: string): Promise<{ title: string; page: number; level: number }[]> {
  return withPdfjs(
    bytes,
    async ({ pdf }) => {
      const outline = await pdf.getOutline();
      if (!outline?.length) return [];
      const out: { title: string; page: number; level: number }[] = [];
      const walk = async (nodes: typeof outline, level: number) => {
        for (const n of nodes) {
          let page = -1;
          try {
            let dest = n.dest;
            if (typeof dest === "string") dest = await pdf.getDestination(dest);
            if (Array.isArray(dest) && dest[0]) {
              page = typeof dest[0] === "number" ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
            }
          } catch {
            page = -1;
          }
          out.push({ title: (n.title || "").trim() || `Section ${out.length + 1}`, page, level });
          if (n.items?.length) await walk(n.items, level + 1);
        }
      };
      await walk(outline, 0);
      return out;
    },
    password,
  );
}

export async function pageCountOf(bytes: Uint8Array, password?: string): Promise<number> {
  return withPdfjs(bytes, async ({ pageCount }) => pageCount, password);
}

/** Render thumbnails progressively (calls back as each page finishes). */
export async function renderThumbnails(
  bytes: Uint8Array,
  width: number,
  onPage: (index: number, url: string, size: { w: number; h: number }) => void,
  opts: { password?: string; signal?: AbortSignal } = {},
) {
  await withPdfjs(
    bytes,
    async ({ pdf, pageCount }) => {
      for (let i = 1; i <= pageCount; i++) {
        if (opts.signal?.aborted) return;
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const canvas = await renderPage(page, (width * (window.devicePixelRatio || 1)) / vp.width);
        page.cleanup();
        onPage(i - 1, canvas.toDataURL("image/jpeg", 0.75), { w: vp.width, h: vp.height });
      }
    },
    opts.password,
  );
}
