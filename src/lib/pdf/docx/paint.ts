/**
 * Draws measured layout into PDF pages: text in the same fonts the browser
 * measured (so every word lands where it was laid out), highlights,
 * underlines, tab leaders, cell and paragraph boxes, pictures, shapes, links.
 */
import fontkit from "@cantoo/fontkit";
import {
  LineCapStyle,
  PDFArray,
  PDFName,
  PDFString,
  TextRenderingMode,
  beginText,
  endPath,
  endText,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setCharacterSpacing,
  setCharacterSqueeze,
  setFillingRgbColor,
  setFontAndSize,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  clip,
  concatTransformationMatrix,
  setGraphicsState,
  type PDFName as PDFNameT,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type PDFRef,
} from "@cantoo/pdf-lib";
import { embedImage, degrees, rgb, type PDFDocument } from "../core";
import { fontBytes } from "../fonts";
import { faceFile, isNeutral, type Face } from "./fonts";
import type { DrawInfo, HtmlGen, SpanStyle } from "./html";
import type { Measured, Seg } from "./measure";
import type { Border, DocxModel, GroupNode, ShapeNode, Sides } from "./model";
import { drawChart } from "./chart";
import { showOps } from "../textops";
import { metafileToPng } from "../metafile";

type FkFont = { hasGlyphForCodePoint(cp: number): boolean; unitsPerEm: number };

/** How wide a border is drawn: double and similar styles take three widths. */
export const borderTotal = (b: Border | undefined) => (!b || b.style === "none" || b.width <= 0 ? 0 : /^double|triple|thinThick|thickThin/.test(b.style) ? Math.max(b.width * 3, 2.25) : b.width);

const color = (hex: string | undefined, d = "000000") => {
  const h = /^[0-9a-f]{6}$/i.test(hex ?? "") ? hex! : d;
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
};

export type Clip = { y0: number; y1: number };
export type LinkRect = { page: number; x: number; y: number; w: number; h: number; link: number };

export class Painter {
  private fonts = new Map<string, Promise<PDFFont>>();
  private parsedFonts = new Map<string, Promise<FkFont>>();
  private images = new Map<string, Promise<PDFImage | null>>();
  private fontKeys = new WeakMap<PDFPage, Map<string, PDFNameT>>();
  links: LinkRect[] = [];

  /** One font resource entry per page and font. */
  private fontKey(page: PDFPage, font: PDFFont): PDFNameT {
    let m = this.fontKeys.get(page);
    if (!m) {
      m = new Map();
      this.fontKeys.set(page, m);
    }
    let k = m.get(font.name);
    if (!k) {
      k = page.node.newFontDictionary(font.name, font.ref);
      m.set(font.name, k);
    }
    return k;
  }

  constructor(public doc: PDFDocument, public gen: HtmlGen, public model: DocxModel) {
    doc.registerFontkit(fontkit as never);
  }

  /* ----- fonts */

  font(key: string): Promise<PDFFont> {
    let f = this.fonts.get(key);
    if (!f) {
      // Ligatures and contextual forms off for Latin text, as in the measuring frame.
      const latinOff = !key.startsWith("deva/");
      f = fontBytes(key).then((b) => this.doc.embedFont(b, { subset: true, features: latinOff ? { liga: false, clig: false, calt: false, dlig: false } : undefined }));
      this.fonts.set(key, f);
    }
    return f;
  }

  parsed(key: string): Promise<FkFont> {
    let f = this.parsedFonts.get(key);
    if (!f) {
      f = fontBytes(key).then((b) => fontkit.create(b as never) as unknown as FkFont);
      this.parsedFonts.set(key, f);
    }
    return f;
  }

  /** Split text into runs by the first face in the stack that has each character. */
  async runs(text: string, st: SpanStyle): Promise<{ text: string; face: Face }[]> {
    const out: { text: string; face: Face }[] = [];
    const faces = await Promise.all(st.stack.map(async (f) => ({ f, font: await this.parsed(faceFile(f, st.bold, st.italic).key) })));
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      let face: Face;
      if (isNeutral(cp) && out.length) face = out[out.length - 1].face;
      else face = (faces.find((x) => x.font.hasGlyphForCodePoint(cp)) ?? faces[0]).f;
      const last = out[out.length - 1];
      if (last && last.face === face) last.text += ch;
      else out.push({ text: ch, face });
    }
    return out;
  }

  /* ----- text */

  async text(page: PDFPage, seg: { text: string; x: number; base: number }, st: SpanStyle, H: number, dx: number, dy: number) {
    const text = seg.text.replace(/[\u200b\u00ad\ufeff]/g, "");
    if (!text.trim()) return;
    let x = seg.x + dx;
    const y = H - (seg.base + dy);
    for (const r of await this.runs(text, st)) {
      const ff = faceFile(r.face, st.bold, st.italic);
      const font = await this.font(ff.key);
      const key = this.fontKey(page, font);
      const ops = [pushGraphicsState(), setFillingRgbColor(...rgbParts(st.color)), beginText(), setFontAndSize(key, st.size)];
      if (st.spacing) ops.push(setCharacterSpacing(st.spacing));
      if (st.scale) ops.push(setCharacterSqueeze(st.scale));
      if (ff.fakeBold) ops.push(setTextRenderingMode(TextRenderingMode.FillAndOutline), setLineWidth(st.size * 0.03), setStrokingRgbColor(...rgbParts(st.color)));
      ops.push(setTextMatrix(1, 0, ff.fakeItalic ? 0.2 : 0, 1, x, y), ...showOps(font, r.text), endText(), popGraphicsState());
      page.pushOperators(...ops);
      const n = [...r.text].length;
      x += font.widthOfTextAtSize(r.text, st.size) * ((st.scale ?? 100) / 100) + (st.spacing ?? 0) * n;
    }
  }

  /* ----- a measured container */

  async paint(page: PDFPage, pageIndex: number, m: Measured, clipY: Clip | null, dx: number, dy: number, opt: { skipDrawings?: boolean } = {}) {
    const H = page.getHeight();
    const inClip = (y: number, h: number) => !clipY || (y + h > clipY.y0 + 0.01 && y < clipY.y1 - 0.01);
    const lineIn = (center: number) => !clipY || (center >= clipY.y0 - 0.01 && center < clipY.y1 - 0.01);
    const withClip = (draw: () => void) => {
      if (!clipY) return draw();
      const top = clipY.y0 + dy;
      const bottom = clipY.y1 + dy;
      page.pushOperators(pushGraphicsState(), rectangle(-1000, H - bottom, 10000, bottom - top), clip(), endPath());
      draw();
      page.pushOperators(popGraphicsState());
    };
    // 1. Cell and paragraph-box fills.
    withClip(() => {
      for (const b of m.boxes) {
        if (!b.info.fill || !inClip(b.y, b.h)) continue;
        page.drawRectangle({ x: b.x + dx, y: H - (b.y + dy) - b.h, width: b.w, height: b.h, color: color(b.info.fill) });
      }
    });
    // 2. Drawings in the flow.
    if (!opt.skipDrawings) {
      for (const d of m.draws) {
        if (!inClip(d.y, d.h)) continue;
        const info = this.gen.draws[d.d];
        if (!info) continue;
        await this.drawing(page, info, d.x + dx, d.y + dy, info.d.autofit ? { w: d.w, h: d.h } : undefined);
        if (d.link !== undefined) this.links.push({ page: pageIndex, x: d.x + dx, y: d.y + dy, w: d.w, h: d.h, link: d.link });
      }
    }
    // 3. Highlights, 4. text, 5. leaders, 6. underlines and strike-through.
    const segs = m.segs.filter((s) => lineIn(s.y + s.h / 2));
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const st = this.gen.spans[s.s];
      if (!st?.bg) continue;
      if (s.space && !neighbourShares(segs, i, (o) => this.gen.spans[o.s]?.bg === st.bg)) continue;
      page.drawRectangle({ x: s.x + dx, y: H - (s.y + dy) - s.h, width: s.w, height: s.h, color: color(st.bg) });
    }
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.space) continue;
      const st = this.gen.spans[s.s];
      if (!st) continue;
      // A following space on the same line goes into the text, for copy and search.
      const next = segs[i + 1];
      const text = next && next.space && next.p === s.p && Math.abs(next.base - s.base) < 0.5 ? s.text + " " : s.text;
      await this.text(page, { text, x: s.x, base: s.base }, st, H, dx, dy);
      if (st.link !== undefined) {
        // One clickable area per line of a link (words, spaces and tab leaders between them).
        const last = this.links[this.links.length - 1];
        const r = { page: pageIndex, x: s.x + dx, y: s.y + dy, w: s.w, h: s.h, link: st.link };
        if (last && last.page === pageIndex && last.link === st.link && Math.abs(last.y + last.h / 2 - (r.y + r.h / 2)) < Math.max(last.h, r.h) / 2 && r.x >= last.x) {
          const right = Math.max(last.x + last.w, r.x + r.w);
          const top = Math.min(last.y, r.y);
          const bottom = Math.max(last.y + last.h, r.y + r.h);
          last.y = top;
          last.h = bottom - top;
          last.w = right - last.x;
        } else this.links.push(r);
      }
    }
    for (const t of m.tabs) {
      if (!t.leader || !lineIn(t.base - 2)) continue;
      const st = t.s >= 0 ? this.gen.spans[t.s] : undefined;
      if (!st) continue;
      const ch = t.leader === "dot" ? "." : t.leader === "hyphen" ? "-" : t.leader === "middleDot" ? "·" : "_";
      const font = await this.font(faceFile(st.stack[0], false, false).key);
      const cw = font.widthOfTextAtSize(ch, st.size);
      if (cw <= 0) continue;
      const n = Math.floor((t.w - cw * 0.6) / cw);
      if (n <= 0) continue;
      const startX = t.x + t.w - n * cw - cw * 0.3;
      for (let k = 0; k < n; k++) await this.text(page, { text: ch, x: startX + k * cw, base: t.base }, { ...st, bold: false, italic: false, underline: undefined }, H, dx, dy);
    }
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const st = this.gen.spans[s.s];
      if (!st || (!st.underline && !st.strike && !st.dstrike)) continue;
      if (s.text === "\u200b") continue;
      if (s.space && !neighbourShares(segs, i, (o) => !!this.gen.spans[o.s]?.underline === !!st.underline && !!this.gen.spans[o.s]?.strike === !!st.strike)) continue;
      const c = color(st.ulColor ?? st.color);
      const x0 = s.x + dx;
      const x1 = s.x + s.w + dx;
      const base = H - (s.base + dy);
      if (st.underline && !(st.underline === "words" && s.space)) {
        const w = Math.max(0.4, st.size * (st.underline === "thick" || /Heavy$/.test(st.underline) ? 0.1 : 0.055));
        const yU = base - st.size * 0.12;
        const dash = /dot/i.test(st.underline) ? [w, w * 1.5] : /dash/i.test(st.underline) ? [w * 4, w * 2] : undefined;
        page.drawLine({ start: { x: x0, y: yU }, end: { x: x1, y: yU }, thickness: w, color: c, dashArray: dash });
        if (st.underline === "double") page.drawLine({ start: { x: x0, y: yU - w * 2.2 }, end: { x: x1, y: yU - w * 2.2 }, thickness: w, color: c });
      }
      if (st.strike || st.dstrike) {
        const w = Math.max(0.4, st.size * 0.05);
        const yS = base + st.size * 0.28;
        page.drawLine({ start: { x: x0, y: yS }, end: { x: x1, y: yS }, thickness: w, color: color(st.color) });
        if (st.dstrike) page.drawLine({ start: { x: x0, y: yS + w * 2.2 }, end: { x: x1, y: yS + w * 2.2 }, thickness: w, color: color(st.color) });
      }
    }
    // 7. Borders of cells and paragraph boxes.
    withClip(() => {
      for (const b of m.boxes) {
        if (!b.info.borders || !inClip(b.y, b.h)) continue;
        this.borders(page, b.info.borders, b.x + dx, b.y + dy, b.w, b.h, b.info.kind === "cell");
      }
    });
  }

  borders(page: PDFPage, bd: Sides<Border>, x: number, y: number, w: number, h: number, centred: boolean) {
    const H = page.getHeight();
    const side = (b: Border | undefined, x0: number, y0: number, x1: number, y1: number, inward: [number, number]) => {
      if (!b || b.style === "none" || b.width <= 0) return;
      const total = borderTotal(b);
      const off = centred ? 0 : total / 2;
      const ox = inward[0] * off;
      const oy = inward[1] * off;
      const dash = /dot/.test(b.style) ? [b.width, b.width * 1.5] : /dash/.test(b.style) ? [b.width * 4, b.width * 2] : undefined;
      const c = color(b.color);
      if (total !== b.width) {
        // Two lines for double borders.
        const g = total / 3;
        for (const k of [-1, 1]) page.drawLine({ start: { x: x0 + ox + inward[0] * g * k, y: H - (y0 + oy + inward[1] * g * k) }, end: { x: x1 + ox + inward[0] * g * k, y: H - (y1 + oy + inward[1] * g * k) }, thickness: g, color: c });
        return;
      }
      page.drawLine({ start: { x: x0 + ox, y: H - (y0 + oy) }, end: { x: x1 + ox, y: H - (y1 + oy) }, thickness: b.width, color: c, dashArray: dash, lineCap: LineCapStyle.Projecting });
    };
    side(bd.top, x, y, x + w, y, [0, 1]);
    side(bd.bottom, x, y + h, x + w, y + h, [0, -1]);
    side(bd.left, x, y, x, y + h, [1, 0]);
    side(bd.right, x + w, y, x + w, y + h, [-1, 0]);
  }

  /* ----- pictures and shapes */

  /** A picture, embedded once; `shown` (its longer side in points) sets a WMF or EMF picture's resolution. */
  image(src: string, shown?: number): Promise<PDFImage | null> {
    const m = this.model.media.get(src);
    const meta = !!m && /emf|wmf/.test(m.mime);
    const key = meta && shown ? `${src}|${Math.ceil(shown / 25) * 25}` : src;
    let p = this.images.get(key);
    if (!p) {
      p = (async () => {
        if (!m || /tiff/.test(m.mime)) return null;
        try {
          if (meta) {
            const png = await metafileToPng(m.bytes, shown);
            return png ? await this.doc.embedPng(png) : null;
          }
          return await embedImage(this.doc, m.bytes, m.mime);
        } catch {
          return null;
        }
      })();
      this.images.set(key, p);
    }
    return p;
  }

  /** A drawing's shapes at a box whose top-left is (x, y) in page points from the top. */
  async drawing(page: PDFPage, info: DrawInfo, x: number, y: number, size?: { w: number; h: number }) {
    // A shape that fits its text takes the size the layout gave it.
    const node = size && info.d.node.kind === "shape" ? { ...info.d.node, w: size.w, h: size.h } : info.d.node;
    await this.node(page, node, x, y, true);
  }

  async node(page: PDFPage, n: ShapeNode | GroupNode, x: number, y: number, root: boolean) {
    const nx = root ? x : x + n.x;
    const ny = root ? y : y + n.y;
    if (n.kind === "group") {
      for (const c of n.children) await this.node(page, c, nx, ny, false);
      return;
    }
    const H = page.getHeight();
    const opacity = n.fill?.alpha ?? 1;
    if (n.image) {
      const img = await this.image(n.image.src, Math.max(n.w, n.h));
      if (img) {
        const c = n.image.crop ?? {};
        const l = c.left ?? 0;
        const t = c.top ?? 0;
        const r = c.right ?? 0;
        const b = c.bottom ?? 0;
        const fw = n.w / Math.max(0.01, 1 - l - r);
        const fh = n.h / Math.max(0.01, 1 - t - b);
        const cropped = l || t || r || b;
        if (cropped) page.pushOperators(pushGraphicsState(), rectangle(nx, H - ny - n.h, n.w, n.h), clip(), endPath());
        const ix = nx - l * fw;
        const iy = H - (ny - t * fh) - fh;
        if (n.rot) {
          const a = (-n.rot * Math.PI) / 180;
          const cx = nx + n.w / 2;
          const cy = H - ny - n.h / 2;
          const bx = ix - cx;
          const by = iy - cy;
          page.drawImage(img, { x: cx + bx * Math.cos(a) - by * Math.sin(a), y: cy + bx * Math.sin(a) + by * Math.cos(a), width: fw, height: fh, rotate: degrees(-n.rot), opacity: opacity < 1 ? opacity : undefined });
        } else page.drawImage(img, { x: ix, y: iy, width: fw, height: fh, opacity: opacity < 1 ? opacity : undefined });
        if (cropped) page.pushOperators(popGraphicsState());
      } else {
        // A picture we cannot draw (TIFF, a damaged file): a light frame keeps the space visible.
        page.drawRectangle({ x: nx, y: H - ny - n.h, width: n.w, height: n.h, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5 });
      }
      if (n.line) this.outline(page, n, nx, ny);
      return;
    }
    if (n.textPath) {
      await this.textPath(page, n, nx, ny);
      return;
    }
    if (n.chart) {
      const doc = this.model.charts.get(n.chart);
      if (doc) await this.chart(page, doc, { x: nx, y: ny, w: n.w, h: n.h });
      return;
    }
    const fill = n.fill?.color ? color(n.fill.color) : undefined;
    const line = n.line;
    if (!fill && !line) return;
    const d = shapePath(n);
    if (!d) return;
    if (n.rot) {
      // Turn around the shape's centre.
      const a = (-n.rot * Math.PI) / 180;
      const cx = nx + n.w / 2;
      const cy = H - ny - n.h / 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy));
    }
    page.drawSvgPath(d, {
      x: nx,
      y: H - ny,
      color: fill,
      opacity: fill && opacity < 1 ? opacity : undefined,
      borderColor: line ? color(line.color) : undefined,
      borderWidth: line ? line.width : 0,
      borderOpacity: line?.alpha !== undefined && line.alpha < 1 ? line.alpha : undefined,
      borderDashArray: line?.dash && line.dash !== "solid" ? (/dot/.test(line.dash) ? [line.width, line.width * 2] : [line.width * 4, line.width * 3]) : undefined,
    });
    if (n.rot) page.pushOperators(popGraphicsState());
  }

  private async chart(page: PDFPage, doc: Document, box: { x: number; y: number; w: number; h: number }) {
    const H = page.getHeight();
    const style = (size: number, bold: boolean, color: string): SpanStyle => ({ stack: ["carlito", "sans", "deva", "sym"], bold, italic: false, size, color });
    const measure = async (text: string, size: number, bold = false) => (await this.font(faceFile("carlito", bold, false).key)).widthOfTextAtSize(text, size);
    await drawChart(
      page,
      doc,
      this.model.theme,
      box,
      async (text, x, baseline, size, o) => {
        if (!text) return;
        const w = o.align && o.align !== "left" ? await measure(text, size, o.bold) : 0;
        const x0 = o.align === "center" ? x - w / 2 : o.align === "right" ? x - w : x;
        await this.text(page, { text, x: x0, base: baseline }, style(size, !!o.bold, o.color ?? "595959"), H, 0, 0);
      },
      measure,
    );
  }

  private outline(page: PDFPage, n: ShapeNode, x: number, y: number) {
    const H = page.getHeight();
    if (!n.line) return;
    page.drawRectangle({ x, y: H - y - n.h, width: n.w, height: n.h, borderColor: color(n.line.color), borderWidth: n.line.width });
  }

  /** WordArt text on a path (watermarks): stretched to fill its shape, turned with it. */
  private async textPath(page: PDFPage, n: ShapeNode, x: number, y: number) {
    const tp = n.textPath!;
    if (!tp.text.trim()) return;
    const H = page.getHeight();
    const font = await this.font(faceFile("carlito", !!tp.bold, !!tp.italic).key);
    const w1 = font.widthOfTextAtSize(tp.text, 1);
    // Capitals fill the shape's height; the text is stretched across its width.
    const size = Math.max(4, n.h / 0.72);
    const scaleX = n.w / Math.max(0.01, w1 * size);
    const a = (-(n.rot ?? 0) * Math.PI) / 180;
    const cx = x + n.w / 2;
    const cy = H - y - n.h / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const gs = page.node.newExtGState("GS", page.doc.context.obj({ Type: "ExtGState", ca: n.fill?.alpha ?? 0.5, CA: n.fill?.alpha ?? 0.5 }));
    const key = this.fontKey(page, font);
    page.pushOperators(
      pushGraphicsState(),
      setGraphicsState(gs),
      concatTransformationMatrix(cos, sin, -sin, cos, cx, cy),
      setFillingRgbColor(...rgbParts(n.fill?.color ?? "C0C0C0")),
      beginText(),
      setFontAndSize(key, size),
      setTextMatrix(scaleX, 0, 0, 1, -n.w / 2, -size * 0.36),
      showText(font.encodeText(tp.text)),
      endText(),
      popGraphicsState(),
    );
  }

  /* ----- links */

  /** Turn the collected link boxes into annotations once every page exists. */
  addLinks(pages: PDFPage[], dest: (anchor: string) => { page: number; y: number } | undefined) {
    for (const l of this.links) {
      const link = this.gen.links[l.link];
      const page = pages[l.page];
      if (!link || !page) continue;
      const H = page.getHeight();
      const ctx = this.doc.context;
      let action: Record<string, unknown> | undefined;
      let destArr: unknown;
      if (link.url) {
        if (!/^(https?:|mailto:|tel:|ftp:)/i.test(link.url)) continue;
        action = { Type: "Action", S: "URI", URI: PDFString.of(link.url) };
      } else if (link.anchor) {
        const d = dest(link.anchor);
        if (!d) continue;
        const target = pages[d.page];
        destArr = [target.ref, "XYZ", null, target.getHeight() - d.y, null];
      } else continue;
      const dict: Record<string, unknown> = { Type: "Annot", Subtype: "Link", Rect: [l.x, H - l.y - l.h, l.x + l.w, H - l.y], Border: [0, 0, 0] };
      if (action) dict.A = action;
      else dict.Dest = destArr;
      const annot = ctx.obj(dict as never);
      const ref: PDFRef = ctx.register(annot);
      let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      if (!annots) {
        annots = ctx.obj([]);
        page.node.set(PDFName.of("Annots"), annots);
      }
      annots.push(ref);
    }
  }
}

function rgbParts(hex: string): [number, number, number] {
  const h = /^[0-9a-f]{6}$/i.test(hex) ? hex : "000000";
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

/** A space between two words that share a decoration gets it too. */
function neighbourShares(segs: Seg[], i: number, same: (o: Seg) => boolean): boolean {
  const s = segs[i];
  const prev = segs[i - 1];
  const next = segs[i + 1];
  return !!prev && !!next && !prev.space && !next.space && Math.abs(prev.base - s.base) < 0.5 && Math.abs(next.base - s.base) < 0.5 && same(prev) && same(next);
}

/* ------------------------------------------------------------- geometry */

/** SVG path for a shape in its own box (0..w, 0..h). */
export function shapePath(n: ShapeNode): string | null {
  const w = n.w;
  const h = n.h;
  const adj = (k: string, d: number) => (n.adj?.[k] ?? d) / 100000;
  const ss = Math.min(w, h);
  if (n.path?.length) {
    return n.path
      .map((p) => {
        const sx = p.w ? w / p.w : 1;
        const sy = p.h ? h / p.h : 1;
        return scalePath(p.d, sx, sy);
      })
      .join(" ");
  }
  switch (n.geom) {
    case "ellipse":
    case "circle": {
      const rx = w / 2;
      const ry = h / 2;
      const k = 0.5523;
      return `M ${rx} 0 C ${rx + rx * k} 0 ${w} ${ry - ry * k} ${w} ${ry} C ${w} ${ry + ry * k} ${rx + rx * k} ${h} ${rx} ${h} C ${rx - rx * k} ${h} 0 ${ry + ry * k} 0 ${ry} C 0 ${ry - ry * k} ${rx - rx * k} 0 ${rx} 0 Z`;
    }
    case "line":
    case "straightConnector1":
    case "bentConnector2":
    case "bentConnector3":
    case "curvedConnector3": {
      const fx = n.flipH ? w : 0;
      const fy = n.flipV ? h : 0;
      return `M ${fx} ${fy} L ${w - fx} ${h - fy}`;
    }
    case "roundRect": {
      const r = ss * adj("adj", 16667);
      return `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z`;
    }
    case "round2SameRect": {
      const r = ss * adj("adj1", 16667);
      return `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h} L 0 ${h} L 0 ${r} Q 0 0 ${r} 0 Z`;
    }
    case "snip1Rect": {
      const r = ss * adj("adj", 16667);
      return `M 0 0 L ${w - r} 0 L ${w} ${r} L ${w} ${h} L 0 ${h} Z`;
    }
    case "triangle": {
      const a = w * adj("adj", 50000);
      return `M ${a} 0 L ${w} ${h} L 0 ${h} Z`;
    }
    case "rtTriangle":
      return `M 0 0 L ${w} ${h} L 0 ${h} Z`;
    case "diamond":
      return `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;
    case "parallelogram": {
      const a = ss * adj("adj", 25000);
      return `M ${a} 0 L ${w} 0 L ${w - a} ${h} L 0 ${h} Z`;
    }
    case "trapezoid": {
      const a = ss * adj("adj", 25000);
      return `M 0 ${h} L ${a} 0 L ${w - a} 0 L ${w} ${h} Z`;
    }
    case "pentagon":
      return `M ${w / 2} 0 L ${w} ${h * 0.38} L ${w * 0.81} ${h} L ${w * 0.19} ${h} L 0 ${h * 0.38} Z`;
    case "hexagon": {
      const a = ss * adj("adj", 25000);
      return `M ${a} 0 L ${w - a} 0 L ${w} ${h / 2} L ${w - a} ${h} L ${a} ${h} L 0 ${h / 2} Z`;
    }
    case "octagon": {
      const a = ss * adj("adj", 29289);
      return `M ${a} 0 L ${w - a} 0 L ${w} ${a} L ${w} ${h - a} L ${w - a} ${h} L ${a} ${h} L 0 ${h - a} L 0 ${a} Z`;
    }
    case "homePlate": {
      const a = ss * adj("adj", 50000);
      return `M 0 0 L ${w - a} 0 L ${w} ${h / 2} L ${w - a} ${h} L 0 ${h} Z`;
    }
    case "chevron": {
      const a = ss * adj("adj", 50000);
      return `M 0 0 L ${w - a} 0 L ${w} ${h / 2} L ${w - a} ${h} L 0 ${h} L ${a} ${h / 2} Z`;
    }
    case "rightArrow": {
      const a1 = h * adj("adj1", 50000);
      const a2 = ss * adj("adj2", 50000);
      const y0 = (h - a1) / 2;
      return `M 0 ${y0} L ${w - a2} ${y0} L ${w - a2} 0 L ${w} ${h / 2} L ${w - a2} ${h} L ${w - a2} ${h - y0} L 0 ${h - y0} Z`;
    }
    case "leftArrow": {
      const a1 = h * adj("adj1", 50000);
      const a2 = ss * adj("adj2", 50000);
      const y0 = (h - a1) / 2;
      return `M ${w} ${y0} L ${a2} ${y0} L ${a2} 0 L 0 ${h / 2} L ${a2} ${h} L ${a2} ${h - y0} L ${w} ${h - y0} Z`;
    }
    case "upArrow": {
      const a1 = w * adj("adj1", 50000);
      const a2 = ss * adj("adj2", 50000);
      const x0 = (w - a1) / 2;
      return `M ${x0} ${h} L ${x0} ${a2} L 0 ${a2} L ${w / 2} 0 L ${w} ${a2} L ${w - x0} ${a2} L ${w - x0} ${h} Z`;
    }
    case "downArrow": {
      const a1 = w * adj("adj1", 50000);
      const a2 = ss * adj("adj2", 50000);
      const x0 = (w - a1) / 2;
      return `M ${x0} 0 L ${x0} ${h - a2} L 0 ${h - a2} L ${w / 2} ${h} L ${w} ${h - a2} L ${w - x0} ${h - a2} L ${w - x0} 0 Z`;
    }
    case "star5": {
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 0.5 : 0.19;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push(`${w / 2 + Math.cos(a) * r * w} ${h / 2 + Math.sin(a) * r * h * 1.05 + h * 0.03}`);
      }
      return `M ${pts.join(" L ")} Z`;
    }
    case "plus": {
      const a = ss * adj("adj", 25000);
      return `M ${a} 0 L ${w - a} 0 L ${w - a} ${a} L ${w} ${a} L ${w} ${h - a} L ${w - a} ${h - a} L ${w - a} ${h} L ${a} ${h} L ${a} ${h - a} L 0 ${h - a} L 0 ${a} L ${a} ${a} Z`;
    }
    case "flowChartTerminator": {
      const r = h / 2;
      return `M ${r} 0 L ${w - r} 0 A ${r} ${r} 0 0 1 ${w - r} ${h} L ${r} ${h} A ${r} ${r} 0 0 1 ${r} 0 Z`;
    }
    default:
      return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
  }
}

function scalePath(d: string, sx: number, sy: number): string {
  const toks = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let out = "";
  let cmd = "";
  let idx = 0;
  for (const t of toks) {
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      idx = 0;
      out += ` ${t}`;
      continue;
    }
    const v = Number(t);
    let s: number;
    if (cmd === "A") {
      // rx ry rot large sweep x y
      const k = idx % 7;
      s = k === 0 ? v * sx : k === 1 ? v * sy : k === 5 ? v * sx : k === 6 ? v * sy : v;
    } else s = idx % 2 === 0 ? v * sx : v * sy;
    out += ` ${Math.round(s * 1000) / 1000}`;
    idx++;
  }
  return out.trim();
}
