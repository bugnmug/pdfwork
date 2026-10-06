/**
 * PDF.js wrapper. Uses the "legacy" build, which ships polyfills for the
 * newest JavaScript built-ins the modern build assumes (the modern build
 * crashed on any browser older than a few months). Character maps, standard
 * fonts and image decoders are served from this site, not a CDN. The worker is
 * a patched copy (scripts/copy-assets.mjs) that reads a PDF's ActualText and
 * marks the spaces it infers, so text comes back as the document says it.
 */
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { Placement } from "./contentstream";

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
  /**
   * `text: false`: leave the text out (see textless), and the shapes inside `erase` (page
   * points, top-left origin): bullets and underlines drawn as shapes that the text now carries.
   * `snap`: align the edges of filled boxes with whole pixels (see textless). `skip`: pictures
   * to leave out (taken off the page, see loosePictures).
   */
  opts: { background?: string; pixelBudget?: number; annotations?: boolean; readback?: boolean; text?: boolean; erase?: { x: number; y: number; w: number; h: number }[]; snap?: boolean; skip?: LoosePicture[] } = {},
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
  const operationsFilter =
    opts.text === false || opts.snap || opts.skip?.length
      ? textless((await getPdfjs()).OPS as unknown as Record<string, number>, base.transform, { text: opts.text !== false, erase: opts.erase ?? [], snap: opts.snap ? s : 0, skip: opts.skip ?? [] })
      : undefined;
  const task = page.render({
    canvasContext: ctx,
    canvas,
    viewport,
    annotationMode: opts.annotations === false ? 0 : 2, // 2 = ENABLE_FORMS: draw annotation appearances
    ...(operationsFilter ? { operationsFilter } : {}),
  } as Parameters<PDFPageProxy["render"]>[0]);
  keepRenderingWhenHidden(task);
  await task.promise;
  return canvas;
}

/**
 * Move the corners of a box-like path (straight edges, square to the pixel grid) to whole
 * pixels, in place. `m` maps the path's space to pixels. Curves and thin shapes stay.
 */
function snapPath(d: Float32Array | number[], m: number[]) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-9) return;
  const pts: number[] = [];
  for (let k = 0; k < d.length; ) {
    const op = d[k++];
    if (op === 0 || op === 1) {
      pts.push(k);
      k += 2;
    } else if (op === 4) continue;
    else return;
  }
  if (pts.length < 3) return;
  const dev = pts.map((k) => [m[0] * d[k] + m[2] * d[k + 1] + m[4], m[1] * d[k] + m[3] * d[k + 1] + m[5]]);
  for (let i = 1; i < dev.length; i++) if (Math.abs(dev[i][0] - dev[i - 1][0]) > 0.01 && Math.abs(dev[i][1] - dev[i - 1][1]) > 0.01) return;
  const xs = dev.map((p) => p[0]);
  const ys = dev.map((p) => p[1]);
  if (Math.max(...xs) - Math.min(...xs) < 3 || Math.max(...ys) - Math.min(...ys) < 3) return;
  pts.forEach((k, i) => {
    const X = Math.round(dev[i][0]) - m[4];
    const Y = Math.round(dev[i][1]) - m[5];
    d[k] = (m[3] * X - m[2] * Y) / det;
    d[k + 1] = (m[0] * Y - m[1] * X) / det;
  });
}

/** Characters with no meaning of their own: private-use code points (icon fonts, symbol bullets), or none at all. */
export const PICTORIAL = /^[\s\uE000-\uF8FF\uFFFD\u{F0000}-\u{FFFFD}]*$/u;

/**
 * An operator filter for page.render that leaves the page's text out, for a background that
 * editable text will sit on. What can't come back as text stays: glyphs from icon fonts
 * (pictures, not characters) and annotations (form field values). Text used as a clipping
 * path (lettering filled with a gradient or a photo) is left out with what is painted
 * through it, up to where the PDF restores the graphics state. Shapes that lie inside an
 * `erase` box are left out as well. With `text`, the text stays and only the rest applies.
 *
 * `snap` (the render's scale): filled boxes get their edges moved to whole pixels. A table's
 * cells are boxes drawn edge to edge; where an edge falls between pixels, both boxes cover that
 * pixel partly and the background shows through, a faint line down the table. Boxes thinner
 * than a few pixels (rules) are left as they are. Calls arrive in drawing order, once per operator.
 */
function textless(OPS: Record<string, number>, vt: number[], o: { text: boolean; erase: { x: number; y: number; w: number; h: number }[]; snap: number; skip: LoosePicture[] }) {
  const erase = o.erase;
  const structural = new Set([OPS.dependency, OPS.save, OPS.restore, OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd, OPS.beginGroup, OPS.endGroup, OPS.beginMarkedContent, OPS.beginMarkedContentProps, OPS.endMarkedContent, OPS.beginCompat, OPS.endCompat, OPS.beginText, OPS.endText]);
  const opens = new Set([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup]);
  const closes = new Set([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup]);
  const shows = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  const modes = [0];
  // The transformation in force (for shapes to erase), saved and restored with the graphics state.
  const ctms: number[][] = [[1, 0, 0, 1, 0, 0]];
  let depth = 0;
  let clipAt = -1;
  let annot = 0;
  /** Whether a path, in user space bounds `mm`, is one of the shapes to erase. */
  const erased = (mm: ArrayLike<number> | null | undefined) => {
    if (!erase.length || !mm || !(mm[2] >= mm[0]) || !(mm[3] >= mm[1])) return false;
    const m = multiply(vt, ctms[depth]);
    const xs = [m[0] * mm[0] + m[2] * mm[1] + m[4], m[0] * mm[2] + m[2] * mm[1] + m[4], m[0] * mm[0] + m[2] * mm[3] + m[4], m[0] * mm[2] + m[2] * mm[3] + m[4]];
    const ys = [m[1] * mm[0] + m[3] * mm[1] + m[5], m[1] * mm[2] + m[3] * mm[1] + m[5], m[1] * mm[0] + m[3] * mm[3] + m[5], m[1] * mm[2] + m[3] * mm[3] + m[5]];
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    return erase.some((r) => x0 >= r.x - 1 && x1 <= r.x + r.w + 1 && y0 >= r.y - 1 && y1 <= r.y + r.h + 1 && (x1 - x0 + 0.5) * (y1 - y0 + 0.5) >= (r.w * r.h) * 0.3);
  };
  const pictorial = (glyphs: unknown) => {
    if (!Array.isArray(glyphs)) return false;
    let n = 0;
    let icons = 0;
    for (const g of glyphs) {
      if (!g || typeof g !== "object") continue;
      const u = (g as { unicode?: string }).unicode ?? "";
      if ((g as { isSpace?: boolean }).isSpace || (u && !u.trim())) continue;
      n++;
      if (PICTORIAL.test(u)) icons++;
    }
    return n > 0 && icons * 2 >= n;
  };
  return (i: number, ops: { fnArray: number[]; argsArray: unknown[] }): boolean => {
    const fn = ops.fnArray[i];
    if (fn === OPS.beginAnnotation) {
      // Annotations start from the page's initial state: no clip from the content applies.
      annot++;
      clipAt = -1;
      return true;
    }
    if (fn === OPS.endAnnotation) {
      annot = Math.max(0, annot - 1);
      return true;
    }
    if (annot) return true;
    const args = ops.argsArray[i] as unknown[];
    if (opens.has(fn)) {
      depth++;
      modes[depth] = modes[depth - 1];
      ctms[depth] = ctms[depth - 1];
      const m = fn === OPS.paintFormXObjectBegin ? (args?.[0] as number[] | null) : null;
      if (m && m.length === 6) ctms[depth] = multiply(ctms[depth], Array.from(m));
    } else if (closes.has(fn)) {
      if (clipAt >= depth) clipAt = -1;
      depth = Math.max(0, depth - 1);
    } else if (fn === OPS.setTextRenderingMode) modes[depth] = Number(args?.[0]) | 0;
    else if (fn === OPS.transform && args?.length === 6) ctms[depth] = multiply(ctms[depth], args as number[]);
    if (structural.has(fn) || fn === OPS.setTextRenderingMode) return true;
    if (fn === OPS.constructPath && clipAt < 0 && erased(args?.[2] as ArrayLike<number> | null)) return false;
    if (fn === OPS.paintImageXObject && o.skip.length) {
      // A picture taken off the page: the same image, drawn in the same place.
      const m = multiply(vt, ctms[depth]);
      const x0 = Math.min(m[4], m[0] + m[4]);
      const y0 = Math.min(m[5], m[3] + m[5]);
      if (o.skip.some((p) => p.id === args?.[0] && Math.abs(p.box[0] - x0) < 0.5 && Math.abs(p.box[1] - y0) < 0.5 && Math.abs(p.box[2] - p.box[0] - Math.abs(m[0])) < 0.5 && Math.abs(p.box[3] - p.box[1] - Math.abs(m[3])) < 0.5)) return false;
    }
    if (fn === OPS.constructPath && o.snap && (args?.[0] === OPS.fill || args?.[0] === OPS.eoFill)) {
      const data = args[1] as unknown[] | undefined;
      const m = multiply(vt, ctms[depth]).map((v) => v * o.snap);
      if (data && data[0] && typeof (data[0] as ArrayLike<number>).length === "number") snapPath(data[0] as Float32Array, m);
    }
    if (o.text) return clipAt < 0;
    if (shows.has(fn)) {
      // Outlined lettering stays a picture too (editable text can't carry its outline).
      if (clipAt < 0 && ((modes[depth] & 3) === 1 || pictorial(args?.[args.length - 1]))) return true;
      if (modes[depth] & 4) clipAt = clipAt < 0 ? depth : Math.min(clipAt, depth);
      return false;
    }
    return clipAt < 0;
  };
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
  /**
   * Gaps the reader closed up with a space inside this item (two table cells set close
   * together come through as one item): the space's index in `str`, where the gap starts
   * and how wide it is, in the upright frame (points).
   */
  gaps?: { at: number; x: number; w: number }[];
  /**
   * How the text is painted, where not simply filled: 1 outlined, 2 filled and outlined,
   * 3 invisible (the text layer over a scan), 4–7 the same and also clipping what follows.
   */
  mode?: number;
};

/** A filled or stroked shape (rectangle, rule, box), as its bounding box in the visual frame; `round` when drawn with curves. */
export type Shape = { x: number; y: number; w: number; h: number; fill?: string; stroke?: string; round?: boolean };

/** A picture drawn on the page: which image (`id`, see export's image list) and where it shows (contentstream's Placement). */
export type Pic = Placement & { id: string };

export type PageText = { page: number; width: number; height: number; items: TextItem[]; shapes?: Shape[]; pics?: Pic[] };

/** Names of serif faces, for PDFs that don't flag their fonts as serif. */
const SERIF = /serif|times|roman|georgia|garamond|cambria|bookantiqua|bookman|minion|palatino|lora|merriweather|playfair|baskerville|caslon|bodoni|didot|charter|crimson|spectral|literata|newsreader|fraunces|cormorant|bitter|slab|alegreya|cardo|gelasio|tinos|domine|vollkorn|noticia|constantia|sabon|utopia|perpetua|rockwell|tiempos|chronicle|schoolbook|goudy|janson|plantin|joanna|calisto|libertin|kepler|warnock|stix|lmroman|cmr\d/i;

const ASC = 0.82;
const DESC = 0.22;

/**
 * A space the worker inferred from a gap between glyphs: a marker, then the gap's width
 * in thousandths of the font size as one private-use character and, after a second marker,
 * where in the item the gap starts (hundredths of a unit of its width, two 12-bit
 * characters; scripts/copy-assets.mjs).
 */
const INFERRED = /\u0091([\uE000-\uEFFF])(?:\u0092([\uE000-\uEFFF])([\uE000-\uEFFF]))?/g;

/**
 * Settle inferred spaces. In letter-spaced text (tracked-out labels) nearly every pair
 * of letters has a gap of the same width; only the wider gaps between words are spaces.
 * Elsewhere every inferred gap is a word space. Also maps stand-in characters some
 * fonts report for curly quotes.
 */
export function cleanItemText(str: string): string {
  return settleItemText(str).str;
}

/**
 * cleanItemText, also giving the letter-spacing of tracked-out text (a fraction of the font
 * size) and the spaces that stand for gaps: their index in the text, the gap's width (a
 * fraction of the font size) and, where known, where it starts in the item (its width's units).
 */
export function settleItemText(str: string): { str: string; track?: number; gaps?: { at: number; em: number; off?: number }[] } {
  let out = str;
  let track: number | undefined;
  const found: { at: number; em: number; off?: number }[] = [];
  if (out.includes("\u0091")) {
    const ms = [...out.matchAll(INFERRED)];
    const gaps = ms.map((m) => (m[1].charCodeAt(0) - 0xe000) / 1000);
    const letters = out.replace(INFERRED, "").replace(/\s+/g, "").length;
    let word = 0;
    if (gaps.length >= 3 && gaps.length >= (letters - 1) * 0.5) {
      // Tracking is the common, smallest gap; a word break adds roughly a space to it.
      const sorted = [...gaps].sort((a, b) => a - b);
      word = sorted[Math.floor(sorted.length * 0.25)] + 0.12;
      const within = sorted.filter((g) => g <= word);
      track = within.length ? within[Math.floor(within.length / 2)] : undefined;
    }
    let res = "";
    let last = 0;
    ms.forEach((m, k) => {
      res += out.slice(last, m.index);
      last = m.index! + m[0].length;
      if (gaps[k] <= word) return;
      found.push({ at: res.length, em: gaps[k], ...(m[2] ? { off: ((m[2].charCodeAt(0) - 0xe000) * 4096 + (m[3].charCodeAt(0) - 0xe000)) / 100 } : {}) });
      res += " ";
    });
    out = res + out.slice(last);
  }
  return { str: out.replace(/\u02BC/g, "\u2019").replace(/\u02EE/g, "\u201D"), ...(track && track > 0.02 ? { track } : {}), ...(found.length ? { gaps: found } : {}) };
}

/** Text items with geometry in the visual frame (handles /Rotate, crop offsets and rotated text). */
export async function pageText(page: PDFPageProxy): Promise<PageText> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ includeMarkedContent: false } as never);
  const styles = (content as unknown as { styles: Record<string, { fontFamily?: string }> }).styles ?? {};
  const items: TextItem[] = [];
  for (const raw of content.items) {
    if (!("str" in raw)) continue;
    const item = raw as { str: string; dir?: string; transform: number[]; width: number; height: number; fontName: string; hasEOL: boolean; color?: string; mode?: number };
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
    const unit = len / Math.max(1e-6, Math.hypot(item.transform[0], item.transform[1]));
    const w = Math.abs(item.width) * unit;
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
      ...(item.mode ? { mode: item.mode } : {}),
      ...(settled.track ? { track: settled.track } : {}),
      // (Where each closed-up gap sits; text set right to left is reordered, so its gaps are left out.)
      ...(settled.gaps?.some((g) => g.off !== undefined) && item.dir !== "rtl" ? { gaps: settled.gaps.flatMap((g) => (g.off !== undefined ? [{ at: g.at, x: X + g.off * unit, w: g.em * fontSize }] : [])) } : {}),
    });
  }
  return { page: page.pageNumber, width: viewport.width, height: viewport.height, items };
}

type OpList = { fnArray: number[]; argsArray: unknown[] };

/** A picture that can come off its page: which drawing operator and image it is, and where it shows (points, top-left origin). `crop`: the share of the image cut off each side by a clip. */
export type LoosePicture = { index: number; id: string; x: number; y: number; w: number; h: number; box: [number, number, number, number]; crop?: { l: number; t: number; r: number; b: number } };

/**
 * Pictures on a page that can stand on their own (to move, resize or replace in another app):
 * drawn upright and opaque, clipped by rectangles at most, smaller than the page, and with
 * nothing drawn over them afterwards (text aside). The operator indices are those of the list
 * that render (forms drawn) uses, so they can be skipped there.
 */
export async function loosePictures(page: PDFPageProxy): Promise<LoosePicture[]> {
  const OPS = (await getPdfjs()).OPS as unknown as Record<string, number>;
  let ops: OpList;
  try {
    ops = (await page.getOperatorList({ annotationMode: 2 } as never)) as unknown as OpList;
  } catch {
    return [];
  }
  const vp = page.getViewport({ scale: 1 });
  const vt = vp.transform;
  type Box = [number, number, number, number];
  type St = { ctm: number[]; clip: Box | null; shaped: boolean; plain: boolean };
  let st: St = { ctm: [1, 0, 0, 1, 0, 0], clip: null, shaped: false, plain: true };
  const stack: St[] = [];
  const boxOf = (m: number[], x0: number, y0: number, x1: number, y1: number): Box => {
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  };
  const cut = (a: Box, b: Box | null): Box | null => {
    if (!b) return a;
    const r: Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    return r[2] > r[0] && r[3] > r[1] ? r : null;
  };
  const PAINT = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintInlineImageXObjectGroup, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask]);
  const paints: { i: number; box: Box }[] = [];
  const cands: { i: number; id: string; box: Box; clip: Box | null }[] = [];
  let pendingClip = false;
  let annot = false;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const a = ops.argsArray[i] as unknown[];
    if (fn === OPS.beginAnnotation) {
      // A form field or stamp drawn over the page: covers its rectangle.
      annot = true;
      const r = a?.[1] as number[] | null;
      if (r && r.length === 4) paints.push({ i, box: boxOf(vt, r[0], r[1], r[2], r[3]) });
      continue;
    }
    if (fn === OPS.endAnnotation) {
      annot = false;
      continue;
    }
    if (annot) continue;
    if (fn === OPS.save) stack.push({ ...st });
    else if (fn === OPS.restore || fn === OPS.endGroup || fn === OPS.paintFormXObjectEnd) st = stack.pop() ?? st;
    else if (fn === OPS.beginGroup) {
      // Transparency groups blend what's in them with what's under: their pictures stay on the page.
      stack.push({ ...st });
      st = { ...st, plain: false };
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ...st });
      const m = a?.[0] as number[] | null;
      if (m && m.length === 6) st = { ...st, ctm: multiply(st.ctm, Array.from(m)) };
      const bb = a?.[1] as number[] | null;
      if (bb && bb.length === 4) st = { ...st, clip: cut(boxOf(multiply(vt, st.ctm), bb[0], bb[1], bb[2], bb[3]), st.clip) ?? [0, 0, 0, 0] };
    } else if (fn === OPS.transform && a?.length === 6) st = { ...st, ctm: multiply(st.ctm, a as number[]) };
    else if (fn === OPS.setGState) {
      for (const [k, v] of (a?.[0] as [string, unknown][]) ?? []) {
        if ((k === "ca" && Number(v) < 0.999) || (k === "SMask" && v) || (k === "BM" && v !== "source-over")) st = { ...st, plain: false };
        else if (k === "ca" || (k === "SMask" && !v) || k === "BM") st = { ...st, plain: true };
      }
    } else if (fn === OPS.clip || fn === OPS.eoClip) pendingClip = true;
    else if (fn === OPS.constructPath) {
      const m = multiply(vt, st.ctm);
      const mm = a?.[2] as ArrayLike<number> | null;
      const box = mm && mm[2] >= mm[0] && mm[3] >= mm[1] ? boxOf(m, mm[0], mm[1], mm[2], mm[3]) : null;
      if (pendingClip) {
        pendingClip = false;
        const path = (a?.[1] as ArrayLike<number>[] | undefined)?.[0];
        st = { ...st, clip: box ? (cut(box, st.clip) ?? [0, 0, 0, 0]) : st.clip, shaped: st.shaped || !rectangular(path, m) };
      }
      if (a?.[0] !== OPS.endPath && box) paints.push({ i, box: [box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1] });
    } else if (fn === OPS.shadingFill) paints.push({ i, box: st.clip ?? [0, 0, vp.width, vp.height] });
    else if (PAINT.has(fn)) {
      const m = multiply(vt, st.ctm);
      const box = boxOf(m, 0, 0, 1, 1);
      paints.push({ i, box });
      const upright = m[0] > 0 && m[3] < 0 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6;
      if (fn === OPS.paintImageXObject && typeof a?.[0] === "string" && upright && st.plain && !st.shaped) cands.push({ i, id: a[0] as string, box, clip: st.clip });
    }
  }
  const out: LoosePicture[] = [];
  for (const c of cands) {
    const vis = cut(c.box, c.clip);
    if (!vis) continue;
    const w = vis[2] - vis[0];
    const h = vis[3] - vis[1];
    if (w < 8 || h < 8 || w * h > vp.width * vp.height * 0.85) continue;
    // Anything drawn over it afterwards (a caption bar, a frame, another picture) keeps it on the page.
    if (paints.some((p) => p.i > c.i && Math.min(p.box[2], vis[2]) - Math.max(p.box[0], vis[0]) > 1 && Math.min(p.box[3], vis[3]) - Math.max(p.box[1], vis[1]) > 1)) continue;
    const bw = c.box[2] - c.box[0];
    const bh = c.box[3] - c.box[1];
    const crop = { l: (vis[0] - c.box[0]) / bw, t: (vis[1] - c.box[1]) / bh, r: (c.box[2] - vis[2]) / bw, b: (c.box[3] - vis[3]) / bh };
    const cropped = Object.values(crop).some((v) => v > 0.002);
    out.push({ index: c.i, id: c.id, x: vis[0], y: vis[1], w, h, box: c.box, ...(cropped ? { crop } : {}) });
  }
  return out;
}

/** Whether a path is a rectangle square to the page (a clip that only crops). */
function rectangular(path: ArrayLike<number> | undefined, m: number[]): boolean {
  if (!path || typeof path.length !== "number") return false;
  const pts: [number, number][] = [];
  for (let k = 0; k < path.length; ) {
    const op = path[k++];
    if (op === 0 || op === 1) {
      pts.push([m[0] * path[k] + m[2] * path[k + 1] + m[4], m[1] * path[k] + m[3] * path[k + 1] + m[5]]);
      k += 2;
    } else if (op === 4) continue;
    else return false;
  }
  if (pts.length < 4 || pts.length > 5) return false;
  for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - pts[i - 1][0]) > 0.01 && Math.abs(pts[i][1] - pts[i - 1][1]) > 0.01) return false;
  return true;
}

/**
 * A page's picture (by its id in the drawing list) as a canvas, at most `max` pixels a side.
 * Null when it isn't available.
 */
export async function pictureCanvas(page: PDFPageProxy, id: string, max = 2400): Promise<HTMLCanvasElement | null> {
  type Img = { width: number; height: number; bitmap?: ImageBitmap; data?: Uint8Array | Uint8ClampedArray; kind?: number };
  const objs = (id.startsWith("g_") ? (page as unknown as { commonObjs: unknown }).commonObjs : (page as unknown as { objs: unknown }).objs) as { get(id: string, cb?: (v: unknown) => void): unknown };
  const img = await new Promise<Img | null>((res) => {
    const t = setTimeout(() => res(null), 4000);
    try {
      objs.get(id, (v) => {
        clearTimeout(t);
        res((v as Img) ?? null);
      });
    } catch {
      clearTimeout(t);
      res(null);
    }
  });
  if (!img || !img.width || !img.height) return null;
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * k));
  canvas.height = Math.max(1, Math.round(img.height * k));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let src: CanvasImageSource | null = img.bitmap ?? null;
  if (!src && img.data) {
    // Decoded pixels: 1 bit grey (rows padded to bytes), RGB or RGBA (pdf.js ImageKind 1, 2, 3).
    const full = document.createElement("canvas");
    full.width = img.width;
    full.height = img.height;
    const fctx = full.getContext("2d");
    if (!fctx) return null;
    const out = fctx.createImageData(img.width, img.height);
    const d = img.data;
    const n = img.width * img.height;
    if (img.kind === 3 && d.length >= n * 4) out.data.set(d.subarray(0, n * 4));
    else if (img.kind === 2 && d.length >= n * 3) for (let p = 0; p < n; p++) out.data.set([d[p * 3], d[p * 3 + 1], d[p * 3 + 2], 255], p * 4);
    else if (img.kind === 1) {
      const row = Math.ceil(img.width / 8);
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) {
          const v = d[y * row + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0;
          out.data.set([v, v, v, 255], (y * img.width + x) * 4);
        }
    } else return null;
    fctx.putImageData(out, 0, 0);
    src = full;
  }
  if (!src) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

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

/**
 * Whether the gap between two pieces of text on a line is a space: wider than a fifth of the
 * type size, or, after an opening bracket or before closing punctuation (a symbol drawn in
 * another font leaves a little gap), clearly wider.
 */
export function spaced(before: string, after: string, gap: number, size: number): boolean {
  if (!before || /\s$/.test(before) || /^\s/.test(after)) return false;
  const tight = /[([{“‘]$/.test(before) || /^[)\]}”’.,;:!?%]/.test(after);
  return gap > size * (tight ? 0.45 : 0.18);
}

function finishLine(l: Line) {
  l.items.sort((a, b) => a.x - b.x);
  let text = "";
  let prevEnd = -Infinity;
  for (const it of l.items) {
    const gap = it.x - prevEnd;
    if (spaced(text, it.str, gap, it.fontSize)) text += " ";
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
