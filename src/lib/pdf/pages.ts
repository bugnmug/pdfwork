/** Page-level operations: merge, split, organize, rotate, crop, n-up and friends. */
import JSZip from "jszip";
import { pushGraphicsState, popGraphicsState, concatTransformationMatrix } from "@cantoo/pdf-lib";
import {
  MM,
  appendPages,
  copyPages,
  degrees,
  loadPdf,
  newDoc,
  paperSize,
  parsePageList,
  parseRangeGroups,
  pdfOut,
  safeFileName,
  saveDoc,
  stem,
  tick,
  hairline,
  type OutFile,
  type PDFDocument,
  type PDFPage,
  type ProgressFn,
} from "./core";
import { pageFrame, toUser, type Frame } from "./geometry";
import { extractPages, getOutline, renderPage, withPdfjs } from "./pdfjs";
import { setOutline, treeFromFlat, type OutlineEntry } from "./outline";

export type Src = { bytes: Uint8Array; name: string; password?: string };

export async function open(src: Src) {
  return loadPdf(src.bytes, { password: src.password, name: src.name });
}

export async function mergePdfs(srcs: Src[], opts: { bookmarks?: boolean; keepOutlines?: boolean } = {}, onProgress?: ProgressFn): Promise<OutFile> {
  if (srcs.length < 2) throw new Error("Merging needs two or more PDFs.");
  const out = await newDoc();
  const outline: OutlineEntry[] = [];
  for (let i = 0; i < srcs.length; i++) {
    onProgress?.((i + 0.5) / srcs.length, `Adding ${srcs[i].name}`);
    const doc = await open(srcs[i]);
    const offset = out.getPageCount();
    await appendPages(out, doc);
    if (opts.bookmarks !== false) {
      let children: OutlineEntry[] | undefined;
      if (opts.keepOutlines !== false) {
        try {
          children = treeFromFlat(await getOutline(srcs[i].bytes, srcs[i].password), offset);
        } catch {
          children = undefined;
        }
      }
      outline.push({ title: stem(srcs[i].name), pageIndex: offset, children: children?.length ? children : undefined });
    }
    await tick();
  }
  if (outline.length) setOutline(out, outline, false);
  return pdfOut("merged.pdf", await saveDoc(out));
}

/** Interleave pages: A1, B1, A2, B2… Optionally reverse B (for back sides scanned in reverse). */
export async function mixPdfs(srcs: Src[], opts: { reverseSecond?: boolean; chunk?: number } = {}): Promise<OutFile> {
  if (srcs.length < 2) throw new Error("Interleaving needs two or more PDFs.");
  const docs = await Promise.all(srcs.map(open));
  const orders = docs.map((d, i) => {
    const idx = d.getPageIndices();
    return i === 1 && opts.reverseSecond ? idx.reverse() : idx;
  });
  const chunk = Math.max(1, opts.chunk ?? 1);
  const out = await newDoc();
  const max = Math.max(...orders.map((o) => o.length));
  for (let i = 0; i < max; i += chunk) {
    for (let d = 0; d < docs.length; d++) {
      const take = orders[d].slice(i, i + chunk);
      if (take.length) await appendPages(out, docs[d], take);
    }
  }
  return pdfOut("mixed.pdf", await saveDoc(out));
}

/**
 * Bookmarks of the source that point at pages a new document takes (`order[k]`: the source
 * page that is its page k), pointing at those pages there.
 */
function carryOutline(doc: PDFDocument, outline: Flat[], order: number[]) {
  const at = new Map<number, number>();
  order.forEach((pi, k) => (at.has(pi) ? undefined : at.set(pi, k)));
  const kept = outline.flatMap((f) => (at.has(f.page - 1) ? [{ ...f, page: at.get(f.page - 1)! + 1 }] : []));
  const tree = treeFromFlat(kept);
  if (tree.length) setOutline(doc, tree, false);
}

type Flat = { title: string; page: number; level: number };
const outlineOf = (src: Src): Promise<Flat[]> => getOutline(src.bytes, src.password).catch(() => []);

async function writeParts(src: PDFDocument, groups: number[][], name: string, labels?: string[], outline: Flat[] = []): Promise<OutFile[]> {
  const out: OutFile[] = [];
  const used = new Set<string>();
  for (let i = 0; i < groups.length; i++) {
    const doc = await newDoc();
    await appendPages(doc, src, groups[i]);
    carryOutline(doc, outline, groups[i]);
    let fname = `${stem(name)}-${labels?.[i] ? safeFileName(labels[i], 40) : `part-${i + 1}`}.pdf`;
    for (let k = 2; used.has(fname); k++) fname = fname.replace(/(-\d+)?\.pdf$/, `-${k}.pdf`);
    used.add(fname);
    out.push(pdfOut(fname, await saveDoc(doc), `${groups[i].length} page${groups[i].length === 1 ? "" : "s"}`));
    await tick();
  }
  return withZip(out, `${stem(name)}-split.zip`);
}

/** When a tool produces several files, add a ZIP of all of them (listed first). */
export async function withZip(files: OutFile[], zipName: string): Promise<OutFile[]> {
  if (files.length < 2) return files;
  const zip = new JSZip();
  for (const f of files) zip.file(f.filename, f.bytes);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return [{ filename: zipName, bytes, mime: "application/zip", note: `All ${files.length} files` }, ...files];
}

export async function splitPdf(
  src: Src,
  opts: { mode: string; ranges?: string; every?: number; merge?: boolean },
): Promise<OutFile[]> {
  const doc = await open(src);
  const n = doc.getPageCount();
  let groups: number[][];
  if (opts.mode === "each") groups = Array.from({ length: n }, (_, i) => [i]);
  else if (opts.mode === "every") {
    const k = Math.max(1, Math.floor(opts.every || 1));
    groups = [];
    for (let i = 0; i < n; i += k) groups.push(Array.from({ length: Math.min(k, n - i) }, (_, j) => i + j));
  } else {
    groups = parseRangeGroups(opts.ranges ?? "", n);
    if (!groups.length) throw new Error(`List pages as numbers and ranges separated by commas (this PDF has ${n} page${n === 1 ? "" : "s"}).`);
    if (opts.merge) groups = [groups.flat()];
  }
  return writeParts(doc, groups, src.name, undefined, await outlineOf(src));
}

export async function extractSelected(src: Src, spec: string): Promise<OutFile> {
  const doc = await open(src);
  const n = doc.getPageCount();
  const pages = parsePageList(spec, n);
  if (!pages.length) throw new Error(`No pages matched “${spec}”. This PDF has ${n} pages.`);
  const out = await newDoc();
  await appendPages(out, doc, pages);
  carryOutline(out, await outlineOf(src), pages);
  return pdfOut(`${stem(src.name)}-pages.pdf`, await saveDoc(out), `${pages.length} of ${n} pages`);
}

export async function removePages(src: Src, spec: string): Promise<OutFile> {
  const doc = await open(src);
  const n = doc.getPageCount();
  const drop = new Set(parsePageList(spec, n));
  if (!drop.size) throw new Error(`No pages matched “${spec}”. This PDF has ${n} pages.`);
  if (drop.size >= n) throw new Error("That would remove every page. Keep at least one.");
  const keep = doc.getPageIndices().filter((i) => !drop.has(i));
  const out = await newDoc();
  await appendPages(out, doc, keep);
  carryOutline(out, await outlineOf(src), keep);
  return pdfOut(`${stem(src.name)}-trimmed.pdf`, await saveDoc(out), `Removed ${drop.size} page${drop.size === 1 ? "" : "s"}`);
}

export async function reversePages(src: Src): Promise<OutFile> {
  const doc = await open(src);
  const out = await newDoc();
  const order = doc.getPageIndices().reverse();
  await appendPages(out, doc, order);
  carryOutline(out, await outlineOf(src), order);
  return pdfOut(`${stem(src.name)}-reversed.pdf`, await saveDoc(out));
}

export async function splitByText(src: Src, query: string, opts: { regex?: boolean; caseSensitive?: boolean } = {}): Promise<OutFile[]> {
  const q = query.trim();
  if (!q) throw new Error("Enter the text that starts each new document.");
  let re: RegExp;
  try {
    re = opts.regex ? new RegExp(q, opts.caseSensitive ? "" : "i") : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"), opts.caseSensitive ? "" : "i");
  } catch {
    throw new Error("That pattern is not a valid regular expression.");
  }
  const pages = await extractPages(src.bytes, { password: src.password });
  const doc = await open(src);
  const starts = [0];
  pages.forEach((p, i) => {
    const text = p.items.map((it) => it.str).join(" ");
    if (i > 0 && re.test(text)) starts.push(i);
  });
  if (starts.length === 1) throw new Error(`“${q}” doesn't appear after the first page, so the file can't be split on it. For a scan, open it in OCR: Searchable PDF first.`);
  const groups = starts.map((a, i) => Array.from({ length: (starts[i + 1] ?? doc.getPageCount()) - a }, (_, k) => a + k));
  return writeParts(doc, groups, src.name, undefined, await outlineOf(src));
}

export async function splitByBookmarks(src: Src, level = 0): Promise<OutFile[]> {
  const all = await outlineOf(src);
  const outline = all.filter((o) => o.page > 0 && o.level <= level);
  if (!outline.length) throw new Error("This PDF has no bookmarks to split by.");
  const doc = await open(src);
  const n = doc.getPageCount();
  const points = [...new Map(outline.map((o) => [o.page - 1, o.title])).entries()].sort((a, b) => a[0] - b[0]);
  if (points[0][0] > 0) points.unshift([0, "front-matter"]);
  const groups: number[][] = [];
  const labels: string[] = [];
  points.forEach(([start, title], i) => {
    const end = points[i + 1]?.[0] ?? n;
    if (end > start) {
      groups.push(Array.from({ length: end - start }, (_, k) => start + k));
      labels.push(`${String(i + 1).padStart(2, "0")}-${title}`);
    }
  });
  return writeParts(doc, groups, src.name, labels, all);
}

/** Split each page into two halves using crop boxes (keeps text and vectors intact). */
export async function splitInHalf(src: Src, axis: "v" | "h", opts: { rtl?: boolean } = {}): Promise<OutFile> {
  const doc = await open(src);
  const out = await newDoc();
  const n = doc.getPageCount();
  for (let i = 0; i < n; i++) {
    const [a, b] = await copyPages(out, doc, [i, i]);
    const f = pageFrame(doc.getPage(i));
    const halves =
      axis === "v"
        ? [
            { u: 0, v: 0, w: f.width / 2, h: f.height },
            { u: f.width / 2, v: 0, w: f.width / 2, h: f.height },
          ]
        : [
            { u: 0, v: f.height / 2, w: f.width, h: f.height / 2 },
            { u: 0, v: 0, w: f.width, h: f.height / 2 },
          ];
    if (opts.rtl && axis === "v") halves.reverse();
    [a, b].forEach((p, k) => {
      const r = visualToUserRect(f, halves[k]);
      setBoxes(p, r);
      out.addPage(p);
    });
  }
  return pdfOut(`${stem(src.name)}-halves.pdf`, await saveDoc(out), `${n} pages → ${n * 2}`);
}

export function visualToUserRect(f: Frame, r: { u: number; v: number; w: number; h: number }) {
  const p1 = toUser(f, r.u, r.v);
  const p2 = toUser(f, r.u + r.w, r.v + r.h);
  return { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), width: Math.abs(p2.x - p1.x), height: Math.abs(p2.y - p1.y) };
}

function setBoxes(p: PDFPage, r: { x: number; y: number; width: number; height: number }) {
  p.setMediaBox(r.x, r.y, r.width, r.height);
  p.setCropBox(r.x, r.y, r.width, r.height);
  p.setTrimBox(r.x, r.y, r.width, r.height);
  p.setBleedBox(r.x, r.y, r.width, r.height);
  p.setArtBox(r.x, r.y, r.width, r.height);
}

export async function splitBySize(src: Src, maxMb: number, onProgress?: ProgressFn): Promise<OutFile[]> {
  const doc = await open(src);
  const n = doc.getPageCount();
  const cap = Math.max(20_000, maxMb * 1024 * 1024);
  const groups: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < n; i++) {
    onProgress?.(i / n, `Measuring page ${i + 1} of ${n}`);
    const trial = [...current, i];
    const probe = await newDoc();
    await appendPages(probe, doc, trial);
    const size = (await saveDoc(probe)).byteLength;
    if (size > cap && current.length) {
      groups.push(current);
      current = [i];
    } else current = trial;
    await tick();
  }
  if (current.length) groups.push(current);
  const parts = await writeParts(doc, groups, src.name, undefined, await outlineOf(src));
  const big = parts.filter((p) => p.mime === "application/pdf" && p.bytes.byteLength > cap);
  if (big.length) big.forEach((p) => (p.note = `${p.note} · one page alone is over the size limit`));
  return parts;
}

export async function rotatePdf(src: Src, angle: number, spec = "all"): Promise<OutFile> {
  const doc = await open(src);
  const targets = parsePageList(spec || "all", doc.getPageCount());
  for (const i of targets) {
    const page = doc.getPage(i);
    page.setRotation(degrees((((page.getRotation().angle + angle) % 360) + 360) % 360));
  }
  return pdfOut(`${stem(src.name)}-rotated.pdf`, await saveDoc(doc), `${targets.length} page${targets.length === 1 ? "" : "s"} rotated`);
}

export type PagePlan = { source: number; rotate?: number; doc?: number } | { blank: true; size?: [number, number] };

/** Build a new document from a plan: reorder, duplicate, rotate, insert blanks, pull pages from extra files. */
export async function organizePdf(src: Src, plan: PagePlan[], extras: Src[] = []): Promise<OutFile> {
  if (!plan.length) throw new Error("Keep at least one page.");
  const docs = [await open(src), ...(await Promise.all(extras.map(open)))];
  const out = await newDoc();
  // Each file's pages copied together, so links between them keep working, then laid out as planned.
  const copies = await Promise.all(
    docs.map((d, di) => {
      const wanted = plan.flatMap((s) => ("blank" in s || (s.doc ?? 0) !== di ? [] : [s.source]));
      return wanted.length ? copyPages(out, d, wanted) : Promise.resolve([]);
    }),
  );
  const next = docs.map(() => 0);
  let lastSize: [number, number] = [595.28, 841.89];
  for (const step of plan) {
    if ("blank" in step) {
      out.addPage(step.size ?? lastSize);
      continue;
    }
    const di = step.doc ?? 0;
    const p = copies[di][next[di]++];
    if (step.rotate) p.setRotation(degrees((((p.getRotation().angle + step.rotate) % 360) + 360) % 360));
    const f = pageFrame(p);
    lastSize = [f.width, f.height];
    out.addPage(p);
  }
  carryOutline(out, await outlineOf(src), plan.map((s) => ("blank" in s || (s.doc ?? 0) !== 0 ? -1 : s.source)));
  return pdfOut(`${stem(src.name)}-organized.pdf`, await saveDoc(out), `${plan.length} pages`);
}

export async function nUp(
  src: Src,
  opts: { n: number; paper?: string; landscape?: boolean | "auto"; border?: boolean; order?: "row" | "column"; gap?: number },
): Promise<OutFile> {
  const doc = await open(src);
  const n = Math.max(2, opts.n);
  const grid: Record<number, [number, number]> = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 8: [4, 2], 9: [3, 3], 16: [4, 4] };
  let [cols, rows] = grid[n] ?? [2, Math.ceil(n / 2)];
  const first = pageFrame(doc.getPage(0));
  const portraitSrc = first.height >= first.width;
  // 2-up and 8-up of portrait pages fit best on landscape sheets; 4/9/16-up on portrait.
  const landscape = opts.landscape === "auto" || opts.landscape === undefined ? (portraitSrc ? [2, 6, 8].includes(n) : ![2, 6, 8].includes(n)) : opts.landscape;
  const sheet = paperSize(opts.paper ?? "A4", landscape);
  if (!landscape && cols > rows) [cols, rows] = [rows, cols];
  const out = await newDoc();
  const gap = opts.gap ?? 10;
  const margin = 18;
  const cellW = (sheet[0] - margin * 2 - gap * (cols - 1)) / cols;
  const cellH = (sheet[1] - margin * 2 - gap * (rows - 1)) / rows;
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i += n) {
    const sheetPage = out.addPage(sheet);
    for (let k = 0; k < n && i + k < pages.length; k++) {
      const pg = pages[i + k];
      const f = pageFrame(pg);
      const emb = await out.embedPage(pg, {
        left: f.box.x,
        bottom: f.box.y,
        right: f.box.x + f.box.width,
        top: f.box.y + f.box.height,
      });
      const col = opts.order === "column" ? Math.floor(k / rows) : k % cols;
      const row = opts.order === "column" ? k % rows : Math.floor(k / cols);
      const scale = Math.min(cellW / f.width, cellH / f.height);
      const w = f.width * scale;
      const h = f.height * scale;
      const cx = margin + col * (cellW + gap) + (cellW - w) / 2;
      const cy = sheet[1] - margin - (row + 1) * cellH - row * gap + (cellH - h) / 2;
      drawEmbeddedUpright(sheetPage, emb, f, cx, cy, scale);
      if (opts.border) sheetPage.drawRectangle({ x: cx, y: cy, width: w, height: h, borderColor: hairline, borderWidth: 0.5 });
    }
  }
  return pdfOut(`${stem(src.name)}-${n}-up.pdf`, await saveDoc(out), `${pages.length} pages on ${Math.ceil(pages.length / n)} sheets`);
}

/** Draw an embedded page so it appears the way the original page displays (honouring /Rotate). */
export function drawEmbeddedUpright(
  target: PDFPage,
  emb: Awaited<ReturnType<PDFDocument["embedPage"]>>,
  f: Frame,
  x: number,
  y: number,
  scale: number,
) {
  const W = f.width * scale;
  const H = f.height * scale;
  let ox = x;
  let oy = y;
  let rot = 0;
  // drawPage rotates about its origin; shift the origin so the result lands in [x, x+W] x [y, y+H].
  if (f.rotation === 90) {
    rot = -90;
    oy = y + H;
  } else if (f.rotation === 180) {
    rot = 180;
    ox = x + W;
    oy = y + H;
  } else if (f.rotation === 270) {
    rot = 90;
    ox = x + W;
  }
  target.drawPage(emb, { x: ox, y: oy, width: f.box.width * scale, height: f.box.height * scale, rotate: degrees(rot) });
}

export async function flipPdf(src: Src, dir: "h" | "v"): Promise<OutFile> {
  const doc = await open(src);
  const out = await newDoc();
  for (const page of doc.getPages()) {
    const f = pageFrame(page);
    const emb = await out.embedPage(page, { left: f.box.x, bottom: f.box.y, right: f.box.x + f.box.width, top: f.box.y + f.box.height });
    const np = out.addPage([f.width, f.height]);
    // Build the upright page in a form, then mirror it with a transform.
    np.pushOperators(...mirrorOps(dir, f.width, f.height));
    drawEmbeddedUpright(np, emb, f, 0, 0, 1);
    np.pushOperators(popOp());
  }
  return pdfOut(`${stem(src.name)}-flipped.pdf`, await saveDoc(out));
}

function mirrorOps(dir: "h" | "v", w: number, h: number) {
  return [pushGraphicsState(), dir === "h" ? concatTransformationMatrix(-1, 0, 0, 1, w, 0) : concatTransformationMatrix(1, 0, 0, -1, 0, h)];
}
function popOp() {
  return popGraphicsState();
}

/** Crop by margins (mm per side), using real crop/media boxes so text and links survive. */
export async function cropMargins(
  src: Src,
  m: { top: number; right: number; bottom: number; left: number },
  spec = "all",
): Promise<OutFile> {
  const doc = await open(src);
  const targets = parsePageList(spec || "all", doc.getPageCount());
  for (const i of targets) {
    const page = doc.getPage(i);
    const f = pageFrame(page);
    const l = m.left * MM;
    const r = m.right * MM;
    const t = m.top * MM;
    const b = m.bottom * MM;
    const w = f.width - l - r;
    const h = f.height - t - b;
    if (w < 36 || h < 36) throw new Error("Those margins leave almost nothing of the page. Use smaller numbers.");
    setBoxes(page, visualToUserRect(f, { u: l, v: b, w, h }));
  }
  return pdfOut(`${stem(src.name)}-cropped.pdf`, await saveDoc(doc));
}

/** Detect the inked area of each page and crop to it (plus a margin). */
export async function autoCrop(src: Src, marginMm = 5, onProgress?: ProgressFn): Promise<OutFile> {
  const doc = await open(src);
  const n = doc.getPageCount();
  const bounds = await withPdfjs(
    src.bytes,
    async ({ pdf }) => {
      const res: ({ x0: number; y0: number; x1: number; y1: number } | null)[] = [];
      for (let i = 1; i <= n; i++) {
        onProgress?.(i / n, `Finding content on page ${i}`);
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const scale = Math.min(1.5, 1100 / Math.max(vp.width, vp.height));
        const c = await renderPage(page, scale, { readback: true });
        page.cleanup();
        res.push(inkBounds(c, scale));
      }
      return res;
    },
    src.password,
  );
  const mg = marginMm * MM;
  bounds.forEach((bd, i) => {
    if (!bd) return;
    const page = doc.getPage(i);
    const f = pageFrame(page);
    const u0 = Math.max(0, bd.x0 - mg);
    const u1 = Math.min(f.width, bd.x1 + mg);
    const top = Math.max(0, bd.y0 - mg);
    const bottom = Math.min(f.height, bd.y1 + mg);
    setBoxes(page, visualToUserRect(f, { u: u0, v: f.height - bottom, w: u1 - u0, h: bottom - top }));
  });
  return pdfOut(`${stem(src.name)}-autocropped.pdf`, await saveDoc(doc));
}

function inkBounds(c: HTMLCanvasElement, scale: number) {
  const ctx = c.getContext("2d")!;
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4;
      if (data[k] < 235 || data[k + 1] < 235 || data[k + 2] < 235) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0: x0 / scale, y0: y0 / scale, x1: (x1 + 1) / scale, y1: (y1 + 1) / scale };
}

/** Scale every page onto a paper size (centred, aspect kept). */
export async function fitToPaper(src: Src, paper: string, orientation: "auto" | "portrait" | "landscape" = "auto", marginMm = 0): Promise<OutFile> {
  const doc = await open(src);
  const out = await newDoc();
  for (const page of doc.getPages()) {
    const f = pageFrame(page);
    const land = orientation === "auto" ? f.width > f.height : orientation === "landscape";
    const [pw, ph] = paperSize(paper, land);
    const emb = await out.embedPage(page, { left: f.box.x, bottom: f.box.y, right: f.box.x + f.box.width, top: f.box.y + f.box.height });
    const np = out.addPage([pw, ph]);
    const mg = marginMm * MM;
    const scale = Math.min((pw - mg * 2) / f.width, (ph - mg * 2) / f.height);
    drawEmbeddedUpright(np, emb, f, (pw - f.width * scale) / 2, (ph - f.height * scale) / 2, scale);
  }
  return pdfOut(`${stem(src.name)}-${paper}.pdf`, await saveDoc(out));
}

export async function pdfToZip(src: Src): Promise<OutFile> {
  const doc = await open(src);
  const zip = new JSZip();
  const n = doc.getPageCount();
  const pad = String(n).length;
  for (let i = 0; i < n; i++) {
    const one = await newDoc();
    await appendPages(one, doc, [i]);
    zip.file(`${stem(src.name)}-page-${String(i + 1).padStart(pad, "0")}.pdf`, await saveDoc(one));
    await tick();
  }
  return {
    filename: `${stem(src.name)}-pages.zip`,
    bytes: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
    mime: "application/zip",
    note: `${n} single-page PDFs`,
  };
}

export async function addBlankPages(src: Src, opts: { where: "end" | "start" | "every"; count?: number }): Promise<OutFile> {
  const doc = await open(src);
  const out = await newDoc();
  const n = doc.getPageCount();
  const size = (i: number): [number, number] => {
    const f = pageFrame(doc.getPage(Math.min(i, n - 1)));
    return [f.width, f.height];
  };
  const count = Math.max(1, opts.count ?? 1);
  // All the pages at once (links between them keep working), then the blank pages between them.
  await appendPages(out, doc);
  if (opts.where === "every") for (let i = n - 1; i >= 0; i--) for (let k = 0; k < count; k++) out.insertPage(i + 1, size(i));
  if (opts.where === "start") for (let k = 0; k < count; k++) out.insertPage(0, size(0));
  if (opts.where === "end") for (let k = 0; k < count; k++) out.addPage(size(n - 1));
  return pdfOut(`${stem(src.name)}-with-blanks.pdf`, await saveDoc(out));
}
