/**
 * PowerPoint (.pptx) → PDF with real layout: shapes, text boxes and pictures
 * are drawn where they sit on the slide, with sizes, bullets, alignment and
 * colours inherited from the layout, master and theme the way PowerPoint
 * resolves them. Tables, basic charts and SmartArt drawings are rendered too.
 */
import JSZip from "jszip";
import { degrees, embedImage, hexToRgb, imageToCanvas, canvasToBytes, pdfOut, stem, tick, type OutFile, type PDFPage, type ProgressFn, type RGB } from "./core";
import { Typesetter, baseStyle, type ParaBlock, type Style } from "./layout";
import type { Family } from "./fonts";

const EMU = 12700; // EMU per point

type El = Element;
const kids = (el: El | null | undefined, name: string): El[] => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el: El | null | undefined, name: string): El | null => (el ? (Array.from(el.children).find((c) => c.localName === name) ?? null) : null);
const path = (el: El | null | undefined, ...names: string[]): El | null => names.reduce<El | null>((cur, n) => kid(cur, n), el ?? null);
const num = (v: string | null | undefined, d = 0) => (v == null || v === "" ? d : Number(v));

type Part = { path: string; doc: Document; rels: Map<string, { target: string; type: string }> };

class Package {
  constructor(public zip: JSZip) {}
  private cache = new Map<string, Promise<Part | null>>();
  async xml(p: string): Promise<Document | null> {
    const f = this.zip.file(p);
    if (!f) return null;
    return new DOMParser().parseFromString(await f.async("string"), "application/xml");
  }
  part(p: string): Promise<Part | null> {
    let c = this.cache.get(p);
    if (!c) {
      c = (async () => {
        const doc = await this.xml(p);
        if (!doc) return null;
        const relsPath = p.replace(/([^/]+)$/, "_rels/$1.rels");
        const relsDoc = await this.xml(relsPath);
        const rels = new Map<string, { target: string; type: string }>();
        if (relsDoc) {
          for (const r of Array.from(relsDoc.getElementsByTagName("Relationship"))) {
            const mode = r.getAttribute("TargetMode");
            const target = r.getAttribute("Target") || "";
            rels.set(r.getAttribute("Id") || "", { target: mode === "External" ? target : resolvePath(p, target), type: r.getAttribute("Type") || "" });
          }
        }
        return { path: p, doc, rels };
      })();
      this.cache.set(p, c);
    }
    return c;
  }
  async bytes(p: string) {
    const f = this.zip.file(p);
    return f ? f.async("uint8array") : null;
  }
}

function resolvePath(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/* ---------------------------------------------------------------- colours */

type Theme = { colors: Record<string, string>; majorFont: string; minorFont: string };

function readTheme(doc: Document | null): Theme {
  const colors: Record<string, string> = { dk1: "000000", lt1: "FFFFFF", dk2: "44546A", lt2: "E7E6E6", accent1: "4472C4", accent2: "ED7D31", accent3: "A5A5A5", accent4: "FFC000", accent5: "5B9BD5", accent6: "70AD47", hlink: "0563C1", folHlink: "954F72" };
  let majorFont = "";
  let minorFont = "";
  if (doc) {
    const scheme = doc.getElementsByTagNameNS("*", "clrScheme")[0];
    for (const c of Array.from(scheme?.children ?? [])) {
      const srgb = kid(c, "srgbClr")?.getAttribute("val");
      const sys = kid(c, "sysClr")?.getAttribute("lastClr");
      if (srgb || sys) colors[c.localName] = (srgb || sys)!;
    }
    majorFont = doc.getElementsByTagNameNS("*", "majorFont")[0]?.getElementsByTagNameNS("*", "latin")[0]?.getAttribute("typeface") ?? "";
    minorFont = doc.getElementsByTagNameNS("*", "minorFont")[0]?.getElementsByTagNameNS("*", "latin")[0]?.getAttribute("typeface") ?? "";
  }
  return { colors, majorFont, minorFont };
}

type ColorCtx = { theme: Theme; map: Record<string, string> };

function colorOf(el: El | null, c: ColorCtx, phClr?: string): { rgb: RGB; alpha: number } | null {
  if (!el) return null;
  const node = kid(el, "srgbClr") ?? kid(el, "schemeClr") ?? kid(el, "sysClr") ?? kid(el, "prstClr") ?? kid(el, "scrgbClr") ?? kid(el, "hslClr");
  if (!node) return null;
  let hex = "000000";
  if (node.localName === "srgbClr") hex = node.getAttribute("val") || hex;
  else if (node.localName === "sysClr") hex = node.getAttribute("lastClr") || (node.getAttribute("val") === "window" ? "FFFFFF" : "000000");
  else if (node.localName === "prstClr") hex = PRESET[node.getAttribute("val") || ""] ?? "000000";
  else if (node.localName === "schemeClr") {
    const v = node.getAttribute("val") || "tx1";
    if (v === "phClr" && phClr) hex = phClr;
    else hex = c.theme.colors[c.map[v] ?? v] ?? c.theme.colors[v] ?? "000000";
  } else if (node.localName === "scrgbClr") {
    const f = (k: string) => Math.round((num(node.getAttribute(k)) / 100000) * 255);
    hex = [f("r"), f("g"), f("b")].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  let alpha = 1;
  for (const mod of Array.from(node.children)) {
    const v = num(mod.getAttribute("val")) / 100000;
    if (mod.localName === "alpha") alpha = v;
    else if (mod.localName === "lumMod" || mod.localName === "lumOff") {
      const [h, s, l] = rgbToHsl(r, g, b);
      const nl = mod.localName === "lumMod" ? l * v : l + v;
      [r, g, b] = hslToRgb(h, s, Math.min(1, Math.max(0, nl)));
    } else if (mod.localName === "tint") [r, g, b] = [r, g, b].map((x) => x + (1 - x) * (1 - v));
    else if (mod.localName === "shade") [r, g, b] = [r, g, b].map((x) => x * v);
  }
  return { rgb: hexToRgb("#" + [r, g, b].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("")), alpha };
}

const PRESET: Record<string, string> = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080", orange: "FFA500", purple: "800080" };

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/* ------------------------------------------------------------- text styles */

type LvlStyle = { size?: number; bold?: boolean; italic?: boolean; color?: El; algn?: string; marL?: number; indent?: number; bu?: { char?: string; auto?: string; none?: boolean; color?: El }; font?: string; lnSpc?: number; spcBef?: number; spcAft?: number };

function readLvl(pPr: El | null): LvlStyle {
  if (!pPr) return {};
  const s: LvlStyle = {};
  const algn = pPr.getAttribute("algn");
  if (algn) s.algn = algn;
  if (pPr.hasAttribute("marL")) s.marL = num(pPr.getAttribute("marL")) / EMU;
  if (pPr.hasAttribute("indent")) s.indent = num(pPr.getAttribute("indent")) / EMU;
  const def = kid(pPr, "defRPr");
  if (def) Object.assign(s, readRun(def));
  if (kid(pPr, "buNone")) s.bu = { none: true };
  const bc = kid(pPr, "buChar");
  if (bc) s.bu = { char: bc.getAttribute("char") || "•", color: kid(pPr, "buClr") ?? undefined };
  const ba = kid(pPr, "buAutoNum");
  if (ba) s.bu = { auto: ba.getAttribute("type") || "arabicPeriod" };
  const ln = path(pPr, "lnSpc", "spcPct");
  if (ln) s.lnSpc = num(ln.getAttribute("val")) / 100000;
  const sb = path(pPr, "spcBef", "spcPts");
  if (sb) s.spcBef = num(sb.getAttribute("val")) / 100;
  const sa = path(pPr, "spcAft", "spcPts");
  if (sa) s.spcAft = num(sa.getAttribute("val")) / 100;
  return s;
}

function readRun(rPr: El | null): LvlStyle {
  if (!rPr) return {};
  const s: LvlStyle = {};
  if (rPr.hasAttribute("sz")) s.size = num(rPr.getAttribute("sz")) / 100;
  if (rPr.hasAttribute("b")) s.bold = rPr.getAttribute("b") === "1" || rPr.getAttribute("b") === "true";
  if (rPr.hasAttribute("i")) s.italic = rPr.getAttribute("i") === "1" || rPr.getAttribute("i") === "true";
  const fill = kid(rPr, "solidFill");
  if (fill) s.color = fill;
  const latin = kid(rPr, "latin")?.getAttribute("typeface");
  if (latin) s.font = latin;
  return s;
}

function lstStyle(lst: El | null): Record<number, LvlStyle> {
  const out: Record<number, LvlStyle> = {};
  if (!lst) return out;
  for (let i = 1; i <= 9; i++) {
    const l = kid(lst, `lvl${i}pPr`);
    if (l) out[i - 1] = readLvl(l);
  }
  return out;
}

function familyOf(face: string | undefined, theme: Theme): Family {
  let f = face || "";
  if (f === "+mj-lt") f = theme.majorFont;
  if (f === "+mn-lt") f = theme.minorFont;
  if (/mono|courier|consolas|menlo/i.test(f)) return "mono";
  if (/times|georgia|garamond|cambria|serif|book antiqua|palatino|baskerville/i.test(f) && !/sans/i.test(f)) return "serif";
  return "sans";
}

/* ------------------------------------------------------------------ render */

type Xform = { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean };
type GroupMap = (x: Xform) => Xform;

type SlideCtx = {
  pkg: Package;
  part: Part;
  layout: Part | null;
  master: Part | null;
  theme: Theme;
  colors: ColorCtx;
  t: Typesetter;
  page: PDFPage;
  H: number;
  masterStyles: { title: Record<number, LvlStyle>; body: Record<number, LvlStyle>; other: Record<number, LvlStyle> };
};

function readXfrm(x: El | null): Xform | null {
  if (!x) return null;
  const off = kid(x, "off");
  const ext = kid(x, "ext");
  if (!off || !ext) return null;
  return {
    x: num(off.getAttribute("x")) / EMU,
    y: num(off.getAttribute("y")) / EMU,
    w: num(ext.getAttribute("cx")) / EMU,
    h: num(ext.getAttribute("cy")) / EMU,
    rot: num(x.getAttribute("rot")) / 60000,
    flipH: x.getAttribute("flipH") === "1",
    flipV: x.getAttribute("flipV") === "1",
  };
}

function phInfo(sp: El): { type: string; idx: string } | null {
  const ph = sp.getElementsByTagNameNS("*", "ph")[0];
  if (!ph) return null;
  return { type: ph.getAttribute("type") || "body", idx: ph.getAttribute("idx") || "" };
}

function findPh(part: Part | null, ph: { type: string; idx: string }): El | null {
  if (!part) return null;
  const sps = Array.from(part.doc.getElementsByTagNameNS("*", "sp"));
  const norm = (t: string) => (t === "ctrTitle" ? "title" : t === "subTitle" ? "body" : t);
  const byIdx = ph.idx ? sps.find((s) => phInfo(s)?.idx === ph.idx) : undefined;
  if (byIdx) return byIdx;
  return sps.find((s) => {
    const i = phInfo(s);
    return i && norm(i.type) === norm(ph.type);
  }) ?? null;
}

async function drawBackground(c: SlideCtx, W: number, H: number) {
  for (const part of [c.part, c.layout, c.master]) {
    if (!part) continue;
    const bg = part.doc.getElementsByTagNameNS("*", "bg")[0];
    if (!bg) continue;
    const bgPr = kid(bg, "bgPr");
    if (bgPr) {
      const solid = kid(bgPr, "solidFill");
      const grad = kid(bgPr, "gradFill");
      const blip = kid(bgPr, "blipFill");
      if (solid) {
        const col = colorOf(solid, c.colors);
        if (col) c.page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: col.rgb });
        return;
      }
      if (grad) {
        const stop = grad.getElementsByTagNameNS("*", "gs")[0];
        const col = colorOf(stop, c.colors);
        if (col) c.page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: col.rgb });
        return;
      }
      if (blip) {
        const img = await imageFromBlip(c, part, kid(blip, "blip"));
        if (img) c.page.drawImage(img, { x: 0, y: 0, width: W, height: H });
        return;
      }
    }
    const bgRef = kid(bg, "bgRef");
    if (bgRef) {
      const col = colorOf(bgRef, c.colors);
      if (col) c.page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: col.rgb });
      return;
    }
  }
}

async function imageFromBlip(c: SlideCtx, part: Part, blip: El | null, crop?: El | null) {
  if (!blip) return null;
  const id = blip.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed") || blip.getAttribute("r:embed");
  const rel = id ? part.rels.get(id) : undefined;
  if (!rel) return null;
  const bytes = await c.pkg.bytes(rel.target);
  if (!bytes) return null;
  const ext = rel.target.split(".").pop()?.toLowerCase() ?? "";
  if (["emf", "wmf", "svg", "tif", "tiff"].includes(ext)) return null;
  const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "bmp" ? "image/bmp" : "image/jpeg";
  try {
    if (crop && ["l", "t", "r", "b"].some((k) => crop.getAttribute(k))) {
      const canvas = await imageToCanvas(bytes, mime);
      const l = num(crop.getAttribute("l")) / 100000;
      const t = num(crop.getAttribute("t")) / 100000;
      const r = num(crop.getAttribute("r")) / 100000;
      const b = num(crop.getAttribute("b")) / 100000;
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(canvas.width * (1 - l - r)));
      out.height = Math.max(1, Math.round(canvas.height * (1 - t - b)));
      out.getContext("2d")!.drawImage(canvas, -canvas.width * l, -canvas.height * t);
      return c.t.doc.embedPng(await canvasToBytes(out, "image/png"));
    }
    return await embedImage(c.t.doc, bytes, mime);
  } catch {
    return null;
  }
}

async function drawTree(c: SlideCtx, tree: El, part: Part, map: GroupMap, opts: { skipPlaceholders?: boolean } = {}) {
  for (const el of Array.from(tree.children)) {
    switch (el.localName) {
      case "sp":
        if (opts.skipPlaceholders && phInfo(el)) break;
        await drawShape(c, el, part, map);
        break;
      case "pic":
        await drawPic(c, el, part, map);
        break;
      case "grpSp": {
        const gx = kid(el, "grpSpPr");
        const x = gx ? kid(gx, "xfrm") : null;
        const off = readXfrm(x);
        const chOff = kid(x, "chOff");
        const chExt = kid(x, "chExt");
        if (off && chOff && chExt) {
          const cx = num(chOff.getAttribute("x")) / EMU;
          const cy = num(chOff.getAttribute("y")) / EMU;
          const cw = num(chExt.getAttribute("cx")) / EMU || 1;
          const ch = num(chExt.getAttribute("cy")) / EMU || 1;
          const outer = map(off);
          const sx = outer.w / cw;
          const sy = outer.h / ch;
          const inner: GroupMap = (r) => ({ ...r, x: outer.x + (r.x - cx) * sx, y: outer.y + (r.y - cy) * sy, w: r.w * sx, h: r.h * sy });
          await drawTree(c, el, part, inner, opts);
        } else await drawTree(c, el, part, map, opts);
        break;
      }
      case "graphicFrame":
        await drawGraphicFrame(c, el, part, map);
        break;
      case "cxnSp":
        drawConnector(c, el, map);
        break;
      case "AlternateContent": {
        const choice = kid(el, "Fallback") ?? kid(el, "Choice");
        if (choice) await drawTree(c, choice, part, map, opts);
        break;
      }
    }
  }
}

function inheritedSpPr(c: SlideCtx, sp: El) {
  const ph = phInfo(sp);
  const lay = ph ? findPh(c.layout, ph) : null;
  const mas = ph ? findPh(c.master, ph) : null;
  return { ph, lay, mas };
}

async function drawShape(c: SlideCtx, sp: El, part: Part, map: GroupMap) {
  const spPr = kid(sp, "spPr");
  const { ph, lay, mas } = inheritedSpPr(c, sp);
  const xf = readXfrm(kid(spPr, "xfrm")) ?? readXfrm(kid(kid(lay, "spPr"), "xfrm")) ?? readXfrm(kid(kid(mas, "spPr"), "xfrm"));
  if (!xf) return;
  const box = map(xf);
  const H = c.H;
  // Fill
  const style = kid(sp, "style");
  let fill: { rgb: RGB; alpha: number } | null = null;
  if (kid(spPr, "solidFill")) fill = colorOf(kid(spPr, "solidFill"), c.colors);
  else if (kid(spPr, "gradFill")) fill = colorOf(kid(spPr, "gradFill")?.getElementsByTagNameNS("*", "gs")[0] ?? null, c.colors);
  else if (!kid(spPr, "noFill") && style) {
    const fr = kid(style, "fillRef");
    if (fr && num(fr.getAttribute("idx")) > 0) fill = colorOf(fr, c.colors);
  }
  let line: { rgb: RGB; w: number } | null = null;
  const ln = kid(spPr, "ln");
  if (ln && !kid(ln, "noFill")) {
    const col = colorOf(kid(ln, "solidFill"), c.colors);
    if (col) line = { rgb: col.rgb, w: Math.max(0.5, num(ln.getAttribute("w"), 12700) / EMU) };
  } else if (!ln && style && !ph) {
    const lr = kid(style, "lnRef");
    if (lr && num(lr.getAttribute("idx")) > 0) {
      const col = colorOf(lr, c.colors);
      if (col) line = { rgb: col.rgb, w: 0.75 };
    }
  }
  const geom = kid(spPr, "prstGeom")?.getAttribute("prst") ?? "rect";
  const blipFill = kid(spPr, "blipFill");
  if (blipFill) {
    const img = await imageFromBlip(c, part, kid(blipFill, "blip"));
    if (img) c.page.drawImage(img, { x: box.x, y: H - box.y - box.h, width: box.w, height: box.h });
  }
  if (fill || line) drawGeom(c.page, geom, box, H, fill, line);
  const txBody = kid(sp, "txBody");
  if (txBody) await drawText(c, txBody, box, ph, lay, mas, sp);
}

function drawGeom(page: PDFPage, geom: string, b: Xform, H: number, fill: { rgb: RGB; alpha: number } | null, line: { rgb: RGB; w: number } | null) {
  const common = { color: fill?.rgb, opacity: fill?.alpha, borderColor: line?.rgb, borderWidth: line?.w ?? 0 };
  if (geom === "ellipse" || geom === "circle") {
    page.drawEllipse({ x: b.x + b.w / 2, y: H - b.y - b.h / 2, xScale: b.w / 2, yScale: b.h / 2, ...common });
    return;
  }
  if (geom === "line" || geom === "straightConnector1") {
    if (line) page.drawLine({ start: { x: b.x, y: H - b.y }, end: { x: b.x + b.w, y: H - b.y - b.h }, thickness: line.w, color: line.rgb });
    return;
  }
  if (geom === "roundRect" || geom === "round2SameRect" || geom === "snipRoundRect") {
    const r = Math.min(b.w, b.h) * 0.16;
    const x = b.x;
    const y = b.y;
    const w = b.w;
    const h = b.h;
    const d = `M ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} L ${x + r} ${y + h} Q ${x} ${y + h} ${x} ${y + h - r} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
    page.drawSvgPath(d, { x: 0, y: H, ...common, borderWidth: line?.w });
    return;
  }
  if (geom === "triangle") {
    page.drawSvgPath(`M ${b.x + b.w / 2} ${b.y} L ${b.x + b.w} ${b.y + b.h} L ${b.x} ${b.y + b.h} Z`, { x: 0, y: H, ...common, borderWidth: line?.w });
    return;
  }
  if (geom === "rightArrow") {
    const s = b.h * 0.25;
    const hx = b.x + b.w - b.h * 0.5;
    page.drawSvgPath(`M ${b.x} ${b.y + s} L ${hx} ${b.y + s} L ${hx} ${b.y} L ${b.x + b.w} ${b.y + b.h / 2} L ${hx} ${b.y + b.h} L ${hx} ${b.y + b.h - s} L ${b.x} ${b.y + b.h - s} Z`, { x: 0, y: H, ...common, borderWidth: line?.w });
    return;
  }
  page.drawRectangle({ x: b.x, y: H - b.y - b.h, width: b.w, height: b.h, ...common, rotate: b.rot ? degrees(-b.rot) : undefined });
}

async function drawText(c: SlideCtx, txBody: El, box: Xform, ph: { type: string; idx: string } | null, lay: El | null, mas: El | null, sp: El) {
  const bodyPr = kid(txBody, "bodyPr");
  const layBodyPr = kid(kid(lay, "txBody"), "bodyPr");
  const masBodyPr = kid(kid(mas, "txBody"), "bodyPr");
  const attr = (name: string, d: number) => {
    for (const b of [bodyPr, layBodyPr, masBodyPr]) if (b?.hasAttribute(name)) return num(b.getAttribute(name)) / EMU;
    return d;
  };
  const lIns = attr("lIns", 7.2);
  const rIns = attr("rIns", 7.2);
  const tIns = attr("tIns", 3.6);
  const bIns = attr("bIns", 3.6);
  const anchor = [bodyPr, layBodyPr, masBodyPr].find((b) => b?.hasAttribute("anchor"))?.getAttribute("anchor") ?? (ph && /title/i.test(ph.type) ? "ctr" : "t");
  const autofit = kid(bodyPr, "normAutofit");
  let scale = autofit?.hasAttribute("fontScale") ? num(autofit.getAttribute("fontScale")) / 100000 : 1;
  const noWrap = bodyPr?.getAttribute("wrap") === "none";
  const kind = !ph ? "other" : /title/i.test(ph.type) ? "title" : ["body", "subTitle", "obj", ""].includes(ph.type) || ph.type === "body" ? "body" : "other";
  const masterLvls = kind === "title" ? c.masterStyles.title : kind === "body" ? c.masterStyles.body : c.masterStyles.other;
  // A shape's style (p:style/a:fontRef) can set the default text colour, e.g. white text on a filled shape.
  const fontRef = kid(kid(sp, "style"), "fontRef");
  const refColor: Record<number, LvlStyle> = {};
  if (fontRef && Array.from(fontRef.children).length) for (let i = 0; i < 9; i++) refColor[i] = { color: fontRef };
  const chains = [lstStyle(kid(txBody, "lstStyle")), refColor, lstStyle(kid(kid(lay, "txBody"), "lstStyle")), lstStyle(kid(kid(mas, "txBody"), "lstStyle")), masterLvls];
  const lvlStyle = (lvl: number): LvlStyle => {
    const merged: LvlStyle = {};
    for (let i = chains.length - 1; i >= 0; i--) Object.assign(merged, stripUndef(chains[i][lvl] ?? {}));
    return merged;
  };
  const width = Math.max(10, box.w - lIns - rIns);
  const paras = kids(txBody, "p");
  const build = async (sc: number) => {
    const out: { lines: Awaited<ReturnType<Typesetter["layoutPara"]>>; before: number; after: number; lineHeight: number }[] = [];
    const counters: number[] = [];
    for (const p of paras) {
      const pPr = kid(p, "pPr");
      const lvl = num(pPr?.getAttribute("lvl"));
      const ls = { ...lvlStyle(lvl), ...stripUndef(readLvl(pPr)) };
      const endRPr = kid(p, "endParaRPr");
      const atoms: ParaBlock["atoms"] = [];
      let firstStyle: Style | null = null;
      for (const r of Array.from(p.children)) {
        if (r.localName === "br") {
          atoms.push({ br: true, style: firstStyle ?? styleFor(ls, {}, c, sc) });
          continue;
        }
        if (r.localName !== "r" && r.localName !== "fld") continue;
        const text = kid(r, "t")?.textContent ?? "";
        const st = styleFor(ls, readRun(kid(r, "rPr")), c, sc);
        firstStyle ??= st;
        for (const tok of text.replace(/\t/g, "    ").split(/( +)/)) if (tok) atoms.push({ text: tok, style: st, space: /^ +$/.test(tok) });
      }
      const pStyle = firstStyle ?? styleFor(ls, readRun(endRPr), c, sc);
      const algn = ls.algn === "ctr" ? "center" : ls.algn === "r" ? "right" : ls.algn === "just" ? "justify" : "left";
      let marker: ParaBlock["marker"];
      const hasText = atoms.some((a) => !("br" in a) && a.text.trim());
      if (hasText && ls.bu && !ls.bu.none && kind !== "title") {
        if (ls.bu.auto) {
          counters[lvl] = (counters[lvl] ?? 0) + 1;
          marker = { text: `${counters[lvl]}.`, style: pStyle };
        } else marker = { text: ls.bu.char ?? "•", style: { ...pStyle, color: colorOf(ls.bu.color ?? null, c.colors)?.rgb ?? pStyle.color } };
      }
      const marL = ls.marL ?? (marker ? 24 : 0);
      const block: ParaBlock = { kind: "para", atoms: atoms.length ? atoms : [{ text: " ", style: pStyle, space: false }], align: algn, indent: marL, before: 0, after: 0, marker };
      const lh = ls.lnSpc ? 1.2 * ls.lnSpc : 1.2;
      c.t.lineHeight = lh;
      const lines = await c.t.layoutPara(block, noWrap ? 10000 : width);
      out.push({ lines, before: (ls.spcBef ?? 0) * sc, after: (ls.spcAft ?? 0) * sc, lineHeight: lh });
    }
    return out;
  };
  let laid = await build(scale);
  const heightOf = (l: typeof laid) => l.reduce((s, p, i) => s + (i ? p.before : 0) + p.lines.reduce((a, x) => a + x.height, 0) + p.after, 0);
  // Shrink text that overflows a placeholder, like PowerPoint's autofit.
  for (let tries = 0; tries < 6 && heightOf(laid) > box.h - tIns - bIns + 2 && (autofit || ph) && scale > 0.45; tries++) {
    scale *= 0.88;
    laid = await build(scale);
  }
  const total = heightOf(laid);
  let y = box.y + tIns;
  if (anchor === "ctr") y = box.y + (box.h - total) / 2;
  else if (anchor === "b") y = box.y + box.h - bIns - total;
  for (let i = 0; i < laid.length; i++) {
    const p = laid[i];
    if (i) y += p.before;
    for (const line of p.lines) {
      await c.t.drawLine(line, box.x + lIns, y, c.page);
      y += line.height;
    }
    y += p.after;
  }
  c.t.lineHeight = 1.4;
}

function stripUndef<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function styleFor(ls: LvlStyle, run: LvlStyle, c: SlideCtx, scale: number): Style {
  const size = (run.size ?? ls.size ?? 18) * scale;
  const colorEl = run.color ?? ls.color;
  const col = colorEl ? colorOf(colorEl, c.colors)?.rgb : undefined;
  return {
    ...baseStyle(),
    family: familyOf(run.font ?? ls.font, c.theme),
    bold: run.bold ?? ls.bold ?? false,
    italic: run.italic ?? ls.italic ?? false,
    size: Math.max(4, size),
    color: col ?? hexToRgb("#" + (c.theme.colors[c.colors.map["tx1"] ?? "dk1"] ?? "000000")),
  };
}

async function drawPic(c: SlideCtx, pic: El, part: Part, map: GroupMap) {
  const spPr = kid(pic, "spPr");
  const { lay, mas } = inheritedSpPr(c, pic);
  const xf = readXfrm(kid(spPr, "xfrm")) ?? readXfrm(kid(kid(lay, "spPr"), "xfrm")) ?? readXfrm(kid(kid(mas, "spPr"), "xfrm"));
  if (!xf) return;
  const box = map(xf);
  const blipFill = kid(pic, "blipFill");
  const img = await imageFromBlip(c, part, kid(blipFill, "blip"), kid(blipFill, "srcRect"));
  if (!img) {
    c.page.drawRectangle({ x: box.x, y: c.H - box.y - box.h, width: box.w, height: box.h, borderColor: hexToRgb("#bbbbbb"), borderWidth: 0.5 });
    return;
  }
  if (box.rot) {
    // Rotate about the centre.
    const a = (-box.rot * Math.PI) / 180;
    const cx = box.x + box.w / 2;
    const cy = c.H - box.y - box.h / 2;
    const ox = cx - (box.w / 2) * Math.cos(a) + (box.h / 2) * Math.sin(a);
    const oy = cy - (box.w / 2) * Math.sin(a) - (box.h / 2) * Math.cos(a);
    c.page.drawImage(img, { x: ox, y: oy, width: box.w, height: box.h, rotate: degrees(-box.rot) });
  } else c.page.drawImage(img, { x: box.x, y: c.H - box.y - box.h, width: box.w, height: box.h });
}

function drawConnector(c: SlideCtx, el: El, map: GroupMap) {
  const spPr = kid(el, "spPr");
  const xf = readXfrm(kid(spPr, "xfrm"));
  if (!xf) return;
  const b = map(xf);
  const ln = kid(spPr, "ln");
  const col = colorOf(kid(ln, "solidFill"), c.colors) ?? colorOf(kid(kid(el, "style"), "lnRef"), c.colors);
  const w = Math.max(0.5, num(ln?.getAttribute("w"), 9525) / EMU);
  const x1 = b.flipH ? b.x + b.w : b.x;
  const x2 = b.flipH ? b.x : b.x + b.w;
  const y1 = b.flipV ? b.y + b.h : b.y;
  const y2 = b.flipV ? b.y : b.y + b.h;
  c.page.drawLine({ start: { x: x1, y: c.H - y1 }, end: { x: x2, y: c.H - y2 }, thickness: w, color: col?.rgb ?? hexToRgb("#444444") });
}

async function drawGraphicFrame(c: SlideCtx, el: El, part: Part, map: GroupMap) {
  const xf = readXfrm(kid(el, "xfrm"));
  if (!xf) return;
  const box = map(xf);
  const data = el.getElementsByTagNameNS("*", "graphicData")[0];
  const uri = data?.getAttribute("uri") ?? "";
  if (uri.endsWith("/table")) {
    const tbl = kid(data, "tbl");
    if (tbl) await drawTable(c, tbl, box);
    return;
  }
  if (uri.endsWith("/chart")) {
    const ch = data?.getElementsByTagNameNS("*", "chart")[0];
    const id = ch?.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || ch?.getAttribute("r:id");
    const rel = id ? part.rels.get(id) : undefined;
    const chartPart = rel ? await c.pkg.part(rel.target) : null;
    if (chartPart) await drawChart(c, chartPart, box);
    return;
  }
  if (uri.endsWith("/diagram")) {
    // SmartArt: PowerPoint stores a pre-rendered drawing alongside the data.
    for (const rel of part.rels.values()) {
      if (/diagramDrawing/i.test(rel.type)) {
        const drawing = await c.pkg.part(rel.target);
        const tree = drawing?.doc.getElementsByTagNameNS("*", "spTree")[0];
        if (drawing && tree) {
          await drawTree(c, tree, drawing, (r) => map({ ...r, x: r.x + xf.x, y: r.y + xf.y }));
          return;
        }
      }
    }
  }
  if (uri.endsWith("/picture") || uri.includes("ole")) {
    const pic = el.getElementsByTagNameNS("*", "pic")[0];
    if (pic) await drawPic(c, pic, part, map);
  }
}

async function drawTable(c: SlideCtx, tbl: El, box: Xform) {
  const grid = kids(kid(tbl, "tblGrid"), "gridCol").map((g) => num(g.getAttribute("w")) / EMU);
  const rows = kids(tbl, "tr");
  const tblPr = kid(tbl, "tblPr");
  const firstRow = tblPr?.getAttribute("firstRow") === "1";
  const band = tblPr?.getAttribute("bandRow") === "1";
  const accent = hexToRgb("#" + (c.theme.colors.accent1 ?? "4472C4"));
  const light = (() => {
    const hex = c.theme.colors.accent1 ?? "4472C4";
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return hexToRgb("#" + [r, g, b].map((x) => Math.round((x + (1 - x) * 0.82) * 255).toString(16).padStart(2, "0")).join(""));
  })();
  let y = box.y;
  for (let ri = 0; ri < rows.length; ri++) {
    const tr = rows[ri];
    let h = num(tr.getAttribute("h")) / EMU;
    const cells = kids(tr, "tc");
    let x = box.x;
    // Measure text heights first so rows grow to fit.
    const prepared: { w: number; lines: Awaited<ReturnType<Typesetter["layoutPara"]>>; fill: RGB | null; span: number; skip: boolean }[] = [];
    let col = 0;
    for (const tc of cells) {
      const span = num(tc.getAttribute("gridSpan"), 1);
      const skip = tc.getAttribute("hMerge") === "1" || tc.getAttribute("vMerge") === "1";
      const w = grid.slice(col, col + span).reduce((a, b) => a + b, 0) || box.w / Math.max(1, cells.length);
      col += span;
      const tcPr = kid(tc, "tcPr");
      let fill = colorOf(kid(tcPr, "solidFill"), c.colors)?.rgb ?? null;
      const header = firstRow && ri === 0;
      if (!fill && header) fill = accent;
      else if (!fill && band && ri % 2 === (firstRow ? 1 : 0)) fill = light;
      const lines: Awaited<ReturnType<Typesetter["layoutPara"]>> = [];
      for (const p of kids(kid(tc, "txBody"), "p")) {
        const atoms: ParaBlock["atoms"] = [];
        for (const r of kids(p, "r")) {
          const rs = readRun(kid(r, "rPr"));
          const st: Style = { ...styleFor({ size: 14 }, rs, c, 1), bold: rs.bold ?? header, color: header && !rs.color ? hexToRgb("#ffffff") : styleFor({}, rs, c, 1).color };
          for (const tok of (kid(r, "t")?.textContent ?? "").split(/( +)/)) if (tok) atoms.push({ text: tok, style: st, space: /^ +$/.test(tok) });
        }
        const algnRaw = kid(p, "pPr")?.getAttribute("algn");
        const align = algnRaw === "ctr" ? "center" : algnRaw === "r" ? "right" : "left";
        c.t.lineHeight = 1.2;
        if (atoms.length) lines.push(...(await c.t.layoutPara({ kind: "para", atoms, align, indent: 0, before: 0, after: 0 }, w - 14)));
      }
      prepared.push({ w, lines, fill, span, skip });
      h = Math.max(h, lines.reduce((s, l) => s + l.height, 0) + 10);
    }
    for (const p of prepared) {
      if (p.fill) c.page.drawRectangle({ x, y: c.H - y - h, width: p.w, height: h, color: p.fill });
      c.page.drawRectangle({ x, y: c.H - y - h, width: p.w, height: h, borderColor: hexToRgb("#ffffff"), borderWidth: 1 });
      if (!p.skip) {
        let ty = y + 5;
        for (const l of p.lines) {
          await c.t.drawLine(l, x + 7, ty, c.page);
          ty += l.height;
        }
      }
      x += p.w;
    }
    y += h;
  }
  c.t.lineHeight = 1.4;
}

async function drawChart(c: SlideCtx, part: Part, box: Xform) {
  const doc = part.doc;
  const H = c.H;
  const title = Array.from(doc.getElementsByTagNameNS("*", "title")[0]?.getElementsByTagNameNS("*", "t") ?? []).map((t) => t.textContent).join("");
  const sers = Array.from(doc.getElementsByTagNameNS("*", "ser"));
  const kind = ["barChart", "bar3DChart", "lineChart", "pieChart", "doughnutChart", "areaChart"].find((k) => doc.getElementsByTagNameNS("*", k).length) ?? "";
  const palette = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"].map((k) => hexToRgb("#" + (c.theme.colors[k] ?? "4472C4")));
  const series = sers.map((s) => ({
    name: s.getElementsByTagNameNS("*", "tx")[0]?.getElementsByTagNameNS("*", "v")[0]?.textContent ?? "",
    cats: Array.from(s.getElementsByTagNameNS("*", "cat")[0]?.getElementsByTagNameNS("*", "pt") ?? []).map((p) => p.getElementsByTagNameNS("*", "v")[0]?.textContent ?? ""),
    vals: Array.from(s.getElementsByTagNameNS("*", "val")[0]?.getElementsByTagNameNS("*", "pt") ?? []).map((p) => Number(p.getElementsByTagNameNS("*", "v")[0]?.textContent ?? 0)),
  }));
  const fonts = c.t.fonts;
  let top = box.y + 4;
  if (title) {
    const w = await fonts.width(title, 14, { bold: true });
    await fonts.draw(c.page, title, { x: box.x + (box.w - w) / 2, y: H - top - 14, size: 14, style: { bold: true }, color: hexToRgb("#333333") });
    top += 24;
  }
  const area = { x: box.x + 36, y: top, w: box.w - 48, h: box.y + box.h - top - 28 };
  if (!series.length || area.w < 20 || area.h < 20) {
    c.page.drawRectangle({ x: box.x, y: H - box.y - box.h, width: box.w, height: box.h, borderColor: hexToRgb("#cccccc"), borderWidth: 0.6 });
    return;
  }
  if (kind === "pieChart" || kind === "doughnutChart") {
    const vals = series[0].vals;
    const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const r = Math.min(area.w, area.h) / 2;
    const cx = area.x + area.w / 2;
    const cy = H - (area.y + area.h / 2);
    let ang = Math.PI / 2;
    vals.forEach((v, i) => {
      const sweep = (Math.max(0, v) / total) * Math.PI * 2;
      const steps = Math.max(2, Math.ceil(sweep / 0.1));
      let d = `M ${cx} ${H - cy}`;
      for (let k = 0; k <= steps; k++) {
        const a = ang - (sweep * k) / steps;
        d += ` L ${cx + r * Math.cos(a)} ${H - (cy + r * Math.sin(a))}`;
      }
      d += " Z";
      c.page.drawSvgPath(d, { x: 0, y: H, color: palette[i % palette.length], borderColor: hexToRgb("#ffffff"), borderWidth: 1 });
      ang -= sweep;
    });
    return;
  }
  const allVals = series.flatMap((s) => s.vals);
  const max = Math.max(...allVals, 0) || 1;
  const min = Math.min(...allVals, 0);
  const span = max - min || 1;
  const cats = series[0].cats.length || series[0].vals.length;
  const baseY = H - (area.y + area.h * (max / span));
  c.page.drawLine({ start: { x: area.x, y: baseY }, end: { x: area.x + area.w, y: baseY }, thickness: 0.6, color: hexToRgb("#999999") });
  const horizontal = doc.getElementsByTagNameNS("*", "barDir")[0]?.getAttribute("val") === "bar";
  if (kind.startsWith("bar") && !horizontal) {
    const groupW = area.w / cats;
    const bw = (groupW * 0.7) / series.length;
    series.forEach((s, si) =>
      s.vals.forEach((v, ci) => {
        const h = (v / span) * area.h;
        c.page.drawRectangle({ x: area.x + ci * groupW + groupW * 0.15 + si * bw, y: v >= 0 ? baseY : baseY + h, width: bw * 0.92, height: Math.abs(h), color: palette[si % palette.length] });
      }),
    );
  } else if (kind.startsWith("bar") && horizontal) {
    const groupH = area.h / cats;
    const bh = (groupH * 0.7) / series.length;
    const zeroX = area.x + area.w * (-min / span);
    series.forEach((s, si) =>
      s.vals.forEach((v, ci) => {
        const w = (v / span) * area.w;
        c.page.drawRectangle({ x: v >= 0 ? zeroX : zeroX + w, y: H - (area.y + ci * groupH + groupH * 0.15 + (si + 1) * bh), width: Math.abs(w), height: bh * 0.92, color: palette[si % palette.length] });
      }),
    );
  } else {
    series.forEach((s, si) => {
      const pts = s.vals.map((v, ci) => ({ x: area.x + (cats > 1 ? (ci / (cats - 1)) * area.w : area.w / 2), y: H - (area.y + ((max - v) / span) * area.h) }));
      for (let k = 1; k < pts.length; k++) c.page.drawLine({ start: pts[k - 1], end: pts[k], thickness: 2, color: palette[si % palette.length] });
    });
  }
  // Category labels
  const labels = series[0].cats;
  if (labels.length && !horizontal) {
    for (let i = 0; i < labels.length; i++) {
      const lbl = await fonts.fit(labels[i], 8, area.w / labels.length - 2);
      const w = await fonts.width(lbl, 8);
      const cx = kind === "lineChart" ? area.x + (labels.length > 1 ? (i / (labels.length - 1)) * area.w : area.w / 2) : area.x + (i + 0.5) * (area.w / labels.length);
      await fonts.draw(c.page, lbl, { x: cx - w / 2, y: H - (area.y + area.h) - 12, size: 8, color: hexToRgb("#555555") });
    }
  }
}

export async function pptxToPdf(bytes: Uint8Array, name: string, onProgress?: ProgressFn): Promise<OutFile> {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new Error("This is an old .ppt file. Save it as .pptx in PowerPoint, Keynote, Google Slides or LibreOffice, then convert.");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("That file isn't a valid .pptx presentation.");
  }
  const pkg = new Package(zip);
  const pres = await pkg.part("ppt/presentation.xml");
  if (!pres) throw new Error("This .pptx has no presentation part. It may be damaged.");
  const sz = pres.doc.getElementsByTagNameNS("*", "sldSz")[0];
  const W = num(sz?.getAttribute("cx"), 9144000) / EMU;
  const H = num(sz?.getAttribute("cy"), 6858000) / EMU;
  const ids = Array.from(pres.doc.getElementsByTagNameNS("*", "sldId"));
  const slidePaths = ids
    .map((s) => pres.rels.get(s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || s.getAttribute("r:id") || "")?.target)
    .filter((p): p is string => !!p);
  if (!slidePaths.length) throw new Error("No slides found in this presentation.");
  const t = await Typesetter.create({ pageSize: [W, H], margin: 0 });
  // Typesetter starts with one blank page; slides add their own.
  t.doc.removePage(0);
  for (let i = 0; i < slidePaths.length; i++) {
    onProgress?.(i / slidePaths.length, `Slide ${i + 1} of ${slidePaths.length}`);
    const part = await pkg.part(slidePaths[i]);
    if (!part) continue;
    if (part.doc.documentElement.getAttribute("show") === "0") continue; // hidden slide
    const layoutRel = [...part.rels.values()].find((r) => r.type.endsWith("/slideLayout"));
    const layout = layoutRel ? await pkg.part(layoutRel.target) : null;
    const masterRel = layout ? [...layout.rels.values()].find((r) => r.type.endsWith("/slideMaster")) : undefined;
    const master = masterRel ? await pkg.part(masterRel.target) : null;
    const themeRel = master ? [...master.rels.values()].find((r) => r.type.endsWith("/theme")) : undefined;
    const theme = readTheme(themeRel ? (await pkg.part(themeRel.target))?.doc ?? null : null);
    const clrMapEl = master?.doc.getElementsByTagNameNS("*", "clrMap")[0];
    const map: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
    if (clrMapEl) for (const a of Array.from(clrMapEl.attributes)) map[a.name] = a.value;
    const txStyles = master?.doc.getElementsByTagNameNS("*", "txStyles")[0];
    const page = t.doc.addPage([W, H]);
    const c: SlideCtx = {
      pkg,
      part,
      layout,
      master,
      theme,
      colors: { theme, map },
      t,
      page,
      H,
      masterStyles: { title: lstStyle(kid(txStyles ?? null, "titleStyle")), body: lstStyle(kid(txStyles ?? null, "bodyStyle")), other: lstStyle(kid(txStyles ?? null, "otherStyle")) },
    };
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: hexToRgb("#ffffff") });
    await drawBackground(c, W, H);
    const ident: GroupMap = (r) => r;
    const showMaster = part.doc.documentElement.getAttribute("showMasterSp") !== "0" && layout?.doc.documentElement.getAttribute("showMasterSp") !== "0";
    if (master && showMaster) {
      const tree = master.doc.getElementsByTagNameNS("*", "spTree")[0];
      if (tree) await drawTree({ ...c, part: master }, tree, master, ident, { skipPlaceholders: true });
    }
    if (layout) {
      const tree = layout.doc.getElementsByTagNameNS("*", "spTree")[0];
      if (tree) await drawTree({ ...c, part: layout }, tree, layout, ident, { skipPlaceholders: true });
    }
    const tree = part.doc.getElementsByTagNameNS("*", "spTree")[0];
    if (tree) await drawTree(c, tree, part, ident);
    await tick();
  }
  const pdf = await t.finish({ pageNumbers: false, bookmarks: false });
  return pdfOut(`${stem(name)}.pdf`, pdf, `${t.doc.getPageCount()} slide${t.doc.getPageCount() === 1 ? "" : "s"}`);
}
