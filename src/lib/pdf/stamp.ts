/** Things drawn on top of existing pages: watermarks, numbers, headers, image stamps. */
import { PDFArray, PDFName } from "@cantoo/pdf-lib";
import {
  MM,
  degrees,
  embedImage,
  hexToRgb,
  ink,
  parsePageList,
  pdfOut,
  saveDoc,
  stem,
  type OutFile,
  type PDFDocument,
  type PDFPage,
} from "./core";
import { FontSet, type Family } from "./fonts";
import { anchorPoint, pageFrame, place, type Anchor, type Frame } from "./geometry";
import { open, type Src } from "./pages";

/** Move the most recently drawn content behind the page's original content. */
function sendLastStreamToBack(page: PDFPage) {
  const contents = page.node.lookup(PDFName.of("Contents"));
  if (contents instanceof PDFArray && contents.size() > 1) {
    const last = contents.get(contents.size() - 1);
    contents.remove(contents.size() - 1);
    contents.insert(0, last);
  }
}

function targets(doc: PDFDocument, spec?: string, skipFirst = 0): number[] {
  return parsePageList(spec || "all", doc.getPageCount()).filter((i) => i >= skipFirst);
}

/** Draw text centred at a visual point, rotated by `angle` degrees (counter-clockwise, visual). */
async function drawCentered(
  fonts: FontSet,
  page: PDFPage,
  f: Frame,
  text: string,
  cu: number,
  cv: number,
  o: { size: number; family?: Family; bold?: boolean; italic?: boolean; color: ReturnType<typeof hexToRgb>; opacity: number; angle: number },
) {
  const style = { family: o.family, bold: o.bold, italic: o.italic };
  const w = await fonts.width(text, o.size, style);
  const a = (o.angle * Math.PI) / 180;
  const capH = o.size * 0.7;
  // Baseline start so the text box is centred on (cu, cv).
  const u = cu - (w / 2) * Math.cos(a) + (capH / 2) * Math.sin(a);
  const v = cv - (w / 2) * Math.sin(a) - (capH / 2) * Math.cos(a);
  const p = place(f, u, v, o.angle);
  await fonts.draw(page, text, { x: p.x, y: p.y, size: o.size, style, color: o.color, opacity: o.opacity, rotate: p.rotate });
}

export type WatermarkOpts = {
  kind: "text" | "image";
  text?: string;
  image?: { bytes: Uint8Array; mime: string };
  family?: Family;
  bold?: boolean;
  italic?: boolean;
  size?: number;
  color?: string;
  opacity?: number;
  angle?: number;
  /** "center", an anchor, or "tile" to repeat across the page. */
  position?: Anchor | "tile";
  /** Image width as a fraction of page width. */
  scale?: number;
  behind?: boolean;
  pages?: string;
};

export async function watermark(src: Src, o: WatermarkOpts): Promise<OutFile> {
  const doc = await open(src);
  const fonts = new FontSet(doc);
  const color = hexToRgb(o.color || "#b42318");
  const opacity = Math.min(1, Math.max(0.02, o.opacity ?? 0.2));
  const angle = o.angle ?? 45;
  const pos = o.position ?? "center";
  const img = o.kind === "image" && o.image ? await embedImage(doc, o.image.bytes, o.image.mime) : null;
  if (o.kind === "image" && !img) throw new Error("Choose an image for the watermark.");
  const text = (o.text ?? "").trim() || "CONFIDENTIAL";
  for (const i of targets(doc, o.pages)) {
    const page = doc.getPage(i);
    const f = pageFrame(page);
    const centers: [number, number][] = [];
    let size = o.size ?? 0;
    let iw = 0;
    let ih = 0;
    if (img) {
      iw = f.width * Math.min(1, Math.max(0.05, o.scale ?? 0.4));
      ih = (iw * img.height) / img.width;
    } else if (!size) {
      // Auto size: diagonal text spans ~70% of the page diagonal.
      const w1 = await fonts.width(text, 1, { family: o.family, bold: o.bold ?? true });
      const span = pos === "tile" ? Math.hypot(f.width, f.height) * 0.28 : Math.hypot(f.width, f.height) * 0.62;
      size = Math.max(10, Math.min(160, span / Math.max(w1, 0.01)));
    }
    if (pos === "tile") {
      const stepU = img ? iw * 1.6 : f.width / 2.2;
      const stepV = img ? ih * 1.8 : f.height / 4;
      for (let v = stepV / 2, row = 0; v < f.height + stepV; v += stepV, row++) {
        for (let u = (row % 2 ? stepU / 2 : 0) + stepU / 4; u < f.width + stepU; u += stepU) centers.push([u, v]);
      }
    } else if (pos === "center") centers.push([f.width / 2, f.height / 2]);
    else {
      const bw = img ? iw : await fonts.width(text, size, { family: o.family, bold: o.bold ?? true });
      const bh = img ? ih : size;
      const a = anchorPoint(f, pos, bw, bh, 24);
      centers.push([a.u + bw / 2, a.v + bh / 2]);
    }
    for (const [cu, cv] of centers) {
      if (img) {
        const a = (angle * Math.PI) / 180;
        const u = cu - (iw / 2) * Math.cos(a) + (ih / 2) * Math.sin(a);
        const v = cv - (iw / 2) * Math.sin(a) - (ih / 2) * Math.cos(a);
        const p = place(f, u, v, angle);
        page.drawImage(img, { x: p.x, y: p.y, width: iw, height: ih, opacity, rotate: degreesOf(p.rotate) });
      } else {
        await drawCentered(fonts, page, f, text, cu, cv, { size, family: o.family, bold: o.bold ?? true, italic: o.italic, color, opacity, angle });
      }
    }
    if (o.behind) sendLastStreamToBack(page);
  }
  return pdfOut(`${stem(src.name)}-watermarked.pdf`, await saveDoc(doc));
}

const degreesOf = (d: number) => degrees(d);

export function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const map: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [v, s] of map) while (n >= v) {
    out += s;
    n -= v;
  }
  return out;
}

export type NumberOpts = {
  format?: string; // e.g. "{n}", "Page {n} of {total}"
  numerals?: "arabic" | "roman" | "ROMAN";
  position?: Anchor;
  start?: number;
  skipFirst?: number;
  /** Count skipped pages in the total (e.g. "Page 3 of 10" when the cover is page 1). */
  size?: number;
  color?: string;
  family?: Family;
  margin?: number; // mm
  mirror?: boolean; // facing pages: swap left/right on even pages
  pages?: string;
};

export async function addPageNumbers(src: Src, o: NumberOpts): Promise<OutFile> {
  const doc = await open(src);
  const fonts = new FontSet(doc);
  const pages = targets(doc, o.pages, o.skipFirst ?? 0);
  const total = pages.length;
  const start = o.start ?? 1;
  const color = hexToRgb(o.color || "#161410");
  const size = o.size ?? 10;
  const margin = (o.margin ?? 10) * MM;
  const fmt = o.format || "{n}";
  for (let k = 0; k < pages.length; k++) {
    const page = doc.getPage(pages[k]);
    const f = pageFrame(page);
    const num = start + k;
    const label = fmt
      .replaceAll("{n}", o.numerals === "roman" ? toRoman(num) : o.numerals === "ROMAN" ? toRoman(num).toUpperCase() : String(num))
      .replaceAll("{total}", String(total + start - 1))
      .replaceAll("{page}", String(num))
      .replaceAll("{pages}", String(total + start - 1));
    let anchor = o.position ?? "bottom";
    if (o.mirror && k % 2 === 1) anchor = anchor.replace("left", "§").replace("right", "left").replace("§", "right") as Anchor;
    const w = await fonts.width(label, size, { family: o.family });
    const a = anchorPoint(f, anchor, w, size * 0.72, margin);
    const p = place(f, a.u, a.v);
    await fonts.draw(page, label, { x: p.x, y: p.y, size, style: { family: o.family }, color, rotate: p.rotate });
  }
  return pdfOut(`${stem(src.name)}-numbered.pdf`, await saveDoc(doc), `${total} pages numbered`);
}

export type BatesOpts = { prefix?: string; suffix?: string; start?: number; digits?: number; position?: Anchor; size?: number; color?: string; margin?: number };

/** Bates-number one or more files with a running counter across all of them. */
export async function batesNumber(srcs: Src[], o: BatesOpts): Promise<OutFile[]> {
  let counter = o.start ?? 1;
  const out: OutFile[] = [];
  for (const src of srcs) {
    const doc = await open(src);
    const fonts = new FontSet(doc);
    const first = counter;
    for (const page of doc.getPages()) {
      const f = pageFrame(page);
      const label = `${o.prefix ?? ""}${String(counter).padStart(o.digits ?? 7, "0")}${o.suffix ?? ""}`;
      const size = o.size ?? 10;
      const w = await fonts.width(label, size, { bold: true });
      const a = anchorPoint(f, o.position ?? "bottom-right", w, size * 0.72, (o.margin ?? 8) * MM);
      const p = place(f, a.u, a.v);
      // Drawn as a small label, like an exhibit sticker, so it reads on any background.
      const pad = size * 0.35;
      page.drawRectangle({ ...place(f, a.u - pad, a.v - pad), width: w + pad * 2, height: size * 0.72 + pad * 2, color: hexToRgb("#ffffff"), borderColor: hexToRgb("#8a8f98"), borderWidth: 0.5, rotate: degrees(p.rotate) });
      await fonts.draw(page, label, { x: p.x, y: p.y, size, style: { bold: true }, color: hexToRgb(o.color || "#000000"), rotate: p.rotate });
      counter++;
    }
    const last = counter - 1;
    out.push(pdfOut(`${stem(src.name)}-bates.pdf`, await saveDoc(doc), `${o.prefix ?? ""}${String(first).padStart(o.digits ?? 7, "0")} to ${o.prefix ?? ""}${String(last).padStart(o.digits ?? 7, "0")}`));
  }
  return out;
}

export type HeaderFooterOpts = {
  headerLeft?: string;
  headerCenter?: string;
  headerRight?: string;
  footerLeft?: string;
  footerCenter?: string;
  footerRight?: string;
  size?: number;
  color?: string;
  family?: Family;
  margin?: number; // mm
  skipFirst?: number;
  pages?: string;
  title?: string;
};

export async function headerFooter(src: Src, o: HeaderFooterOpts): Promise<OutFile> {
  const doc = await open(src);
  const fonts = new FontSet(doc);
  const pages = targets(doc, o.pages, o.skipFirst ?? 0);
  const n = doc.getPageCount();
  const now = new Date();
  const date = now.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const size = o.size ?? 9;
  const color = hexToRgb(o.color || "#444444");
  const margin = (o.margin ?? 10) * MM;
  const title = o.title ?? doc.getTitle() ?? stem(src.name);
  const slots: [keyof HeaderFooterOpts, Anchor][] = [
    ["headerLeft", "top-left"],
    ["headerCenter", "top"],
    ["headerRight", "top-right"],
    ["footerLeft", "bottom-left"],
    ["footerCenter", "bottom"],
    ["footerRight", "bottom-right"],
  ];
  if (!slots.some(([k]) => String(o[k] ?? "").trim())) throw new Error("Type something for at least one header or footer position.");
  for (const i of pages) {
    const page = doc.getPage(i);
    const f = pageFrame(page);
    for (const [key, anchor] of slots) {
      const tpl = String(o[key] ?? "");
      if (!tpl.trim()) continue;
      const text = tpl
        .replaceAll("{page}", String(i + 1))
        .replaceAll("{pages}", String(n))
        .replaceAll("{date}", date)
        .replaceAll("{time}", time)
        .replaceAll("{filename}", src.name)
        .replaceAll("{title}", title);
      const maxW = f.width / 3 - margin / 2;
      const fitted = await fonts.fit(text, size, Math.max(40, maxW), { family: o.family });
      const w = await fonts.width(fitted, size, { family: o.family });
      const a = anchorPoint(f, anchor, w, size * 0.72, margin);
      const p = place(f, a.u, a.v);
      await fonts.draw(page, fitted, { x: p.x, y: p.y, size, style: { family: o.family }, color, rotate: p.rotate });
    }
  }
  return pdfOut(`${stem(src.name)}-header-footer.pdf`, await saveDoc(doc));
}

export type ImageStampOpts = {
  image: { bytes: Uint8Array; mime: string };
  where: "last" | "first" | "all" | "custom";
  pages?: string;
  position?: Anchor;
  widthMm?: number;
  margin?: number; // mm
  caption?: string;
  opacity?: number;
};

/** Place an image (thumb impression, seal, logo, signature scan) on chosen pages. */
export async function stampImage(src: Src, o: ImageStampOpts): Promise<OutFile> {
  const doc = await open(src);
  const fonts = new FontSet(doc);
  const img = await embedImage(doc, o.image.bytes, o.image.mime);
  const n = doc.getPageCount();
  const list = o.where === "last" ? [n - 1] : o.where === "first" ? [0] : o.where === "all" ? doc.getPageIndices() : parsePageList(o.pages || "all", n);
  const w = (o.widthMm ?? 25) * MM;
  const h = (w * img.height) / img.width;
  const capSize = 8;
  for (const i of list) {
    const page = doc.getPage(i);
    const f = pageFrame(page);
    const capH = o.caption ? capSize + 4 : 0;
    const a = anchorPoint(f, o.position ?? "bottom-right", w, h + capH, (o.margin ?? 12) * MM);
    const p = place(f, a.u, a.v + capH);
    page.drawImage(img, { x: p.x, y: p.y, width: w, height: h, opacity: o.opacity ?? 1, rotate: degrees(p.rotate) });
    if (o.caption) {
      const tw = await fonts.width(o.caption, capSize);
      const c = place(f, a.u + (w - tw) / 2, a.v);
      await fonts.draw(page, o.caption, { x: c.x, y: c.y, size: capSize, color: ink, rotate: c.rotate });
    }
  }
  return pdfOut(`${stem(src.name)}-stamped.pdf`, await saveDoc(doc), `${list.length} page${list.length === 1 ? "" : "s"} stamped`);
}
