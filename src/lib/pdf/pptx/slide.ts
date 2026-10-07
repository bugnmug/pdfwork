/**
 * One slide drawn to one PDF page: background, the master's and layout's own
 * graphics, then the slide's shapes, pictures, groups, tables, charts and
 * SmartArt, each with its geometry, fill, outline, shadow and text resolved
 * through placeholders and theme styles the way PowerPoint resolves them.
 */
import { PDFName, PDFString, type PDFPage } from "@cantoo/pdf-lib";
import type { PDFDocument } from "../core";
import { attr, kid, kids, num, path, readTheme, resolveAlternates, type El, type Package, type Part, type Theme } from "../ooxml";
import { customGeometry, presetGeometry, shapeGeometry, adjustValues, type Geometry } from "../drawingml/geometry";
import { blipPlacement, colorIn, fillFrom, isOpen, mergeLine, paintFill, paintLine, readFill, readLine, readShadow, type ColorCtx, type Fill, type Frame, type ImageLoader, type Line, type Shadow } from "../drawingml/fill";
import { IDENT, Pen, apply, boxMatrix, scale, then, translate, rotate, type Mat, type RGBA } from "../drawingml/pen";
import type { TextKit } from "../textkit";
import { SlideText, readBodyProps, type Link, type ListSrc } from "./text";
import type { Images } from "./images";
import { drawTable } from "./table";
import { drawChart, type ChartHost } from "../docx/chart";
import { paintPictureShadow, paintShadow } from "./shadow";
import { vmlId, vmlPictures } from "./vml";

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export type Pres = {
  pkg: Package;
  W: number;
  H: number;
  slides: { path: string; hidden: boolean }[];
  defaultTextStyle: El | null;
  firstSlideNum: number;
  tableStyles: Map<string, El>;
  slideIndex: Map<string, number>;
};

type Ph = { type: string; idx: string | null };
export type LinkBox = { link: Link; quad: [number, number][] };

/** Everything a slide's shapes are drawn with. */
export type SlideEnv = {
  pres: Pres;
  doc: PDFDocument;
  pen: Pen;
  kit: TextKit;
  images: Images;
  text: SlideText;
  theme: Theme;
  cc: ColorCtx;
  fmt: { fill: El[]; ln: El[]; effect: El[]; bg: El[] };
  slide: Part;
  layout: Part | null;
  master: Part | null;
  /** The theme part: its style lists' picture fills point at its own pictures. */
  themePart: Part | null;
  txStyles: { title: El | null; body: El | null; other: El | null };
  slideNo: number;
  links: LinkBox[];
  warnings: Set<string>;
};

const xfrmOf = (x: El | null | undefined) => {
  const off = kid(x, "off");
  const ext = kid(x, "ext");
  if (!off || !ext) return null;
  return {
    x: num(attr(off, "x")) / 12700,
    y: num(attr(off, "y")) / 12700,
    w: num(attr(ext, "cx")) / 12700,
    h: num(attr(ext, "cy")) / 12700,
    rot: num(attr(x, "rot")) / 60000,
    flipH: attr(x, "flipH") === "1" || attr(x, "flipH") === "true",
    flipV: attr(x, "flipV") === "1" || attr(x, "flipV") === "true",
  };
};

function phOf(el: El): Ph | null {
  const nv = Array.from(el.children).find((c) => /^nv/.test(c.localName));
  const ph = kid(kid(nv, "nvPr"), "ph");
  if (!ph) return null;
  return { type: attr(ph, "type") ?? "obj", idx: attr(ph, "idx") };
}

const norm = (t: string) => (t === "ctrTitle" ? "title" : t === "subTitle" || t === "obj" ? "body" : t);
const masterType = (t: string) => (t === "ctrTitle" || t === "title" ? "title" : ["dt", "ftr", "sldNum", "hdr"].includes(t) ? t : "body");

function shapesIn(part: Part | null): El[] {
  const tree = part?.doc.getElementsByTagNameNS("*", "spTree")[0];
  if (!tree) return [];
  const out: El[] = [];
  const walk = (t: El) => {
    for (const c of Array.from(t.children)) {
      if (c.localName === "grpSp") walk(c);
      else if (["sp", "pic", "graphicFrame", "cxnSp"].includes(c.localName)) out.push(c);
    }
  };
  walk(tree);
  return out;
}

function findLayoutPh(layout: Part | null, ph: Ph): El | null {
  const all = shapesIn(layout).filter((s) => phOf(s));
  if (ph.idx !== null) {
    const byIdx = all.find((s) => phOf(s)!.idx === ph.idx);
    if (byIdx) return byIdx;
  }
  return all.find((s) => norm(phOf(s)!.type) === norm(ph.type)) ?? all.find((s) => masterType(phOf(s)!.type) === masterType(ph.type) && ph.type !== "obj") ?? null;
}

function findMasterPh(master: Part | null, ph: Ph): El | null {
  const all = shapesIn(master).filter((s) => phOf(s));
  const want = masterType(ph.type);
  return all.find((s) => masterType(phOf(s)!.type) === want) ?? null;
}

const hasText = (txBody: El | null) => !!txBody && kids(txBody, "p").some((p) => Array.from(p.children).some((c) => (c.localName === "r" && (kid(c, "t")?.textContent ?? "") !== "") || c.localName === "fld"));

/** The page box (axis-aligned) of a local rectangle under `m`. */
function quadOf(m: Mat, x: number, y: number, w: number, h: number): [number, number][] {
  return [apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h)];
}

/**
 * The text frame of a shape: its text rectangle placed on the page, never mirrored
 * (a flipped shape keeps readable text; flipped vertically, the text turns over).
 */
function textFrame(m: Mat, rect: { l: number; t: number; r: number; b: number }, rotExtra: number, upright: boolean): { m: Mat; w: number; h: number } {
  const ax: [number, number] = [m[0], m[1]];
  const ay: [number, number] = [m[2], m[3]];
  const lx = Math.hypot(...ax) || 1;
  const ly = Math.hypot(...ay) || 1;
  const w = Math.abs(rect.r - rect.l) * lx;
  const h = Math.abs(rect.b - rect.t) * ly;
  const c = apply(m, (rect.l + rect.r) / 2, (rect.t + rect.b) / 2);
  let X: [number, number] = [ax[0] / lx, ax[1] / lx];
  const det = m[0] * m[3] - m[1] * m[2];
  if (det < 0) X = [-X[0], -X[1]];
  if (upright) X = [1, 0];
  const Y: [number, number] = [-X[1], X[0]];
  let fm: Mat = [X[0], X[1], Y[0], Y[1], c[0] - (X[0] * w) / 2 - (Y[0] * h) / 2, c[1] - (X[1] * w) / 2 - (Y[1] * h) / 2];
  if (rotExtra) fm = then(then(then(translate(-w / 2, -h / 2), rotate(rotExtra)), translate(w / 2, h / 2)), fm);
  return { m: fm, w, h };
}

export class SlidePainter {
  constructor(private e: SlideEnv) {}

  private get pen() {
    return this.e.pen;
  }

  /* ----- theme style references */

  private styleFill(ref: El | null): Fill | undefined {
    if (!ref) return undefined;
    const idx = num(attr(ref, "idx"));
    if (!idx) return { kind: "none" };
    const ph = colorIn(ref, this.e.cc)?.hex;
    const el = idx >= 1001 ? this.e.fmt.bg[idx - 1001] : this.e.fmt.fill[idx - 1];
    return el ? fillFrom(el, this.e.cc, ph, this.e.themePart ?? undefined) : undefined;
  }
  private styleLine(ref: El | null): Line {
    if (!ref) return {};
    const idx = num(attr(ref, "idx"));
    if (!idx) return { fill: { kind: "none" } };
    const ph = colorIn(ref, this.e.cc)?.hex;
    const ln = this.e.fmt.ln[idx - 1];
    return ln ? readLine(ln, this.e.cc, ph) : {};
  }
  private styleShadow(ref: El | null): Shadow | undefined {
    if (!ref) return undefined;
    const idx = num(attr(ref, "idx"));
    if (!idx) return undefined;
    const ph = colorIn(ref, this.e.cc)?.hex;
    const st = this.e.fmt.effect[idx - 1];
    return st ? readShadow(kid(st, "effectLst"), this.e.cc, ph) : undefined;
  }

  private loader(part: Part): ImageLoader {
    return async (f, size) => this.e.images.load((f.owner as Part | null) ?? part, f.blip, this.e.cc, size, f.phClr);
  }

  /* ----- background */

  async background() {
    const { pres } = this.e;
    for (const part of [this.e.slide, this.e.layout, this.e.master]) {
      const bg = part?.doc.getElementsByTagNameNS("*", "bg")[0];
      if (!bg || !part) continue;
      const frame: Frame = { m: IDENT, w: pres.W, h: pres.H };
      const rect = presetGeometry("rect", pres.W, pres.H)!.paths[0].segs;
      const bgPr = kid(bg, "bgPr");
      // The background's own fill, or the theme's background style it refers to.
      const fill = bgPr ? readFill(bgPr, this.e.cc, undefined, part) : this.styleFill(kid(bg, "bgRef"));
      if (fill) await paintFill(this.pen, rect, fill, frame, "norm", this.loader(part));
      return;
    }
  }

  /* ----- shape trees */

  async tree(part: Part, where: "master" | "layout" | "slide") {
    const tree = part.doc.getElementsByTagNameNS("*", "spTree")[0];
    if (tree) await this.walk(tree, part, IDENT, where);
    // ActiveX controls (a Flash movie, a form control) show their saved preview picture.
    const controls = kid(kid(part.doc.documentElement, "cSld"), "controls");
    for (const c of kids(controls, "control")) {
      try {
        const pic = kid(c, "pic");
        if (pic) await this.picture(pic, part, IDENT);
        else await this.vmlPreview(attr(c, "spid"), part, null);
      } catch (err) {
        this.e.warnings.add(`Part of a slide couldn't be drawn (${(err as Error).message ?? err}).`);
      }
    }
  }

  /**
   * An object's preview picture kept in the slide's VML drawing (ActiveX controls, and OLE
   * objects saved by older versions), in `frame` or else where the VML places it.
   */
  private async vmlPreview(spid: string | null, part: Part, frame: Frame | null): Promise<boolean> {
    if (!spid) return false;
    const rel = [...part.rels.values()].find((r) => /\/vmlDrawing$/.test(r.type) && !r.external);
    if (!rel) return false;
    const v = (await vmlPictures(this.e.pres.pkg, rel.target)).get(vmlId(spid));
    if (!v?.target) return false;
    const f = frame ?? { m: translate(v.x, v.y), w: v.w, h: v.h };
    const k = Math.max(Math.hypot(f.m[0], f.m[1]), Math.hypot(f.m[2], f.m[3]));
    const img = await this.e.images.loadTarget(v.target, this.e.cc, { w: f.w * k, h: f.h * k });
    if (!img) return false;
    this.pen.image(img.img, then([f.w, 0, 0, -f.h, 0, f.h], f.m));
    return true;
  }

  private async walk(tree: El, part: Part, parent: Mat, where: "master" | "layout" | "slide", grpFill?: Fill) {
    for (const el of Array.from(tree.children)) {
      try {
        await this.node(el, part, parent, where, grpFill);
      } catch (err) {
        this.e.warnings.add(`Part of a slide couldn't be drawn (${(err as Error).message ?? err}).`);
      }
    }
  }

  private async node(el: El, part: Part, parent: Mat, where: "master" | "layout" | "slide", grpFill?: Fill) {
    const nv = Array.from(el.children).find((c) => /^nv/.test(c.localName));
    if (attr(kid(nv, "cNvPr"), "hidden") === "1") return;
    switch (el.localName) {
      case "sp":
      case "cxnSp":
        if (where !== "slide" && phOf(el)) return;
        await this.shape(el, part, parent, grpFill);
        return;
      case "pic":
        if (where !== "slide" && phOf(el)) return;
        await this.picture(el, part, parent, grpFill);
        return;
      case "grpSp":
        await this.group(el, part, parent, where);
        return;
      case "graphicFrame":
        if (where !== "slide" && phOf(el)) return;
        await this.graphicFrame(el, part, parent);
        return;
      case "AlternateContent": {
        const pick = kid(el, "Fallback") ?? kid(el, "Choice");
        if (pick) await this.walk(pick, part, parent, where, grpFill);
        return;
      }
    }
  }

  private async group(el: El, part: Part, parent: Mat, where: "master" | "layout" | "slide") {
    const gp = kid(el, "grpSpPr");
    const x = kid(gp, "xfrm");
    const box = xfrmOf(x);
    let m = parent;
    if (box) {
      const chOff = kid(x, "chOff");
      const chExt = kid(x, "chExt");
      const cx = num(attr(chOff, "x")) / 12700;
      const cy = num(attr(chOff, "y")) / 12700;
      const cw = num(attr(chExt, "cx")) / 12700;
      const ch = num(attr(chExt, "cy")) / 12700;
      const sx = cw ? box.w / cw : 1;
      const sy = ch ? box.h / ch : 1;
      m = then(then(then(translate(-cx, -cy), scale(sx, sy)), boxMatrix(box.x, box.y, box.w, box.h, box.rot, box.flipH, box.flipV)), parent);
    }
    const fill = readFill(gp, this.e.cc, undefined, part);
    await this.walk(el, part, m, where, fill);
  }

  /** The shape element and its placeholder ancestors (layout, master), nearest first. */
  private chain(el: El): { list: El[]; ph: Ph | null } {
    const ph = phOf(el);
    if (!ph) return { list: [el], ph };
    const lay = findLayoutPh(this.e.layout, ph);
    const mas = findMasterPh(this.e.master, lay ? (phOf(lay) ?? ph) : ph);
    return { list: [el, lay, mas].filter(Boolean) as El[], ph };
  }

  /**
   * Fill, outline and shadow through the placeholder chain. At each level (the shape, its
   * layout placeholder, the master's) the level's own spPr comes before its theme style, and
   * both come before anything inherited: a slide title with a shape style keeps its box even
   * when the master's title says no fill.
   */
  private look(list: El[], part: Part, grpFill?: Fill): { fill: Fill | undefined; line: Line; shadow: Shadow | undefined } {
    const owners = [part, this.e.layout, this.e.master];
    const levels = list.map((s, i) => ({ spPr: kid(s, "spPr"), style: kid(s, "style"), owner: owners[i] ?? part }));
    let fill: Fill | undefined;
    for (const lv of levels) {
      fill = readFill(lv.spPr, this.e.cc, undefined, lv.owner) ?? this.styleFill(kid(lv.style, "fillRef"));
      if (fill) {
        if (fill.kind === "blip" && !fill.owner) fill = { ...fill, owner: lv.owner };
        break;
      }
    }
    if (fill?.kind === "grp") fill = grpFill;
    let line: Line = {};
    for (let i = levels.length - 1; i >= 0; i--) {
      line = mergeLine(line, this.styleLine(kid(levels[i].style, "lnRef")));
      line = mergeLine(line, readLine(kid(levels[i].spPr, "ln"), this.e.cc));
    }
    if (line.fill?.kind === "grp") line.fill = grpFill;
    let shadow: Shadow | undefined;
    for (const lv of levels) {
      const eff = kid(lv.spPr, "effectLst");
      if (eff) {
        shadow = readShadow(eff, this.e.cc);
        break;
      }
      const ref = kid(lv.style, "effectRef");
      if (ref) {
        shadow = this.styleShadow(ref);
        break;
      }
    }
    return { fill, line, shadow };
  }

  private async shape(el: El, part: Part, parent: Mat, grpFill?: Fill) {
    const { list, ph } = this.chain(el);
    const txBody = kid(el, "txBody");
    // Empty placeholders don't show outside editing.
    if (ph && !hasText(txBody) && !kid(kid(el, "spPr"), "blipFill")) return;
    const spPrs = list.map((s) => kid(s, "spPr"));
    const box = spPrs.map((s) => xfrmOf(kid(s, "xfrm"))).find(Boolean);
    if (!box) return;
    const m = then(boxMatrix(box.x, box.y, box.w, box.h, box.rot, box.flipH, box.flipV), parent);
    const geomPr = spPrs.find((s) => kid(s, "prstGeom") || kid(s, "custGeom")) ?? null;
    const geo = geometryOf(geomPr, box.w, box.h);
    const style = list.map((s) => kid(s, "style")).find(Boolean) ?? null;
    const { fill, line, shadow } = this.look(list, part, grpFill);
    const frame: Frame = { m, w: box.w, h: box.h };
    await this.paintGeometry(geo, fill, line, shadow, frame, (fill?.kind === "blip" ? (fill.owner as Part) : null) ?? part);
    // Text.
    if (txBody && hasText(txBody)) {
      const bodyChain = list.map((s) => kid(kid(s, "txBody"), "bodyPr"));
      const bp = readBodyProps(bodyChain);
      const txX = xfrmOf(kid(el, "txXfrm"));
      let tf: { m: Mat; w: number; h: number };
      if (txX) {
        const tm = then(boxMatrix(txX.x, txX.y, txX.w, txX.h, txX.rot, txX.flipH, txX.flipV), parent);
        tf = textFrame(tm, { l: 0, t: 0, r: txX.w, b: txX.h }, bp.rot, bp.upright);
      } else tf = textFrame(m, geo.text, bp.rot, bp.upright);
      const fontRef = kid(style, "fontRef");
      const lists: ListSrc[] = [{ el: kid(txBody, "lstStyle") }];
      if (fontRef) lists.push({ fontRef: { idx: attr(fontRef, "idx") ?? "none", color: colorIn(fontRef, this.e.cc) ?? undefined } });
      for (const s of list.slice(1)) lists.push({ el: kid(kid(s, "txBody"), "lstStyle") });
      if (ph) {
        // Placeholders take the master's text styles, never the presentation's defaults.
        const mt = masterType(ph.type);
        lists.push({ el: mt === "title" ? this.e.txStyles.title : mt === "body" ? this.e.txStyles.body : this.e.txStyles.other });
      } else {
        lists.push({ el: this.e.pres.defaultTextStyle });
        lists.push({ el: this.e.txStyles.other });
      }
      const bare = (!fill || fill.kind === "none") && (!line.fill || line.fill.kind === "none");
      await this.e.text.draw(this.pen, txBody, lists, bp, tf.m, tf.w, tf.h, bare ? shadow : undefined);
    }
    this.shapeLink(el, m, box.w, box.h, part);
  }

  /** Shadow, then every path's fill, then every path's outline. */
  async paintGeometry(geo: Geometry, fill: Fill | undefined, line: Line, shadow: Shadow | undefined, frame: Frame, part: Part) {
    const pen = this.pen;
    const visibleFill = fill && fill.kind !== "none";
    const visibleLine = line.fill && line.fill.kind !== "none";
    if (shadow && (visibleFill || visibleLine)) await paintShadow(pen, this.e.doc, geo, frame, shadow, !!visibleFill, line);
    if (visibleFill) for (const p of geo.paths) if (p.fill !== "none") await paintFill(pen, p.segs, fill!, frame, p.fill, this.loader(part));
    if (visibleLine) for (const p of geo.paths) if (p.stroke) paintLine(pen, p.segs, line, frame, isOpen(p.segs));
  }

  private shapeLink(el: El, m: Mat, w: number, h: number, part: Part) {
    const nv = Array.from(el.children).find((c) => /^nv/.test(c.localName));
    const hk = kid(kid(nv, "cNvPr"), "hlinkClick");
    if (!hk) return;
    const link = resolveLink(hk, part, this.e.pres);
    if (link) this.e.links.push({ link, quad: quadOf(m, 0, 0, w, h) });
  }

  private async picture(el: El, part: Part, parent: Mat, grpFill?: Fill) {
    const { list } = this.chain(el);
    const spPrs = list.map((s) => kid(s, "spPr"));
    const box = spPrs.map((s) => xfrmOf(kid(s, "xfrm"))).find(Boolean);
    if (!box) return;
    const m = then(boxMatrix(box.x, box.y, box.w, box.h, box.rot, box.flipH, box.flipV), parent);
    const geomPr = spPrs.find((s) => kid(s, "prstGeom") || kid(s, "custGeom")) ?? null;
    const geo = geometryOf(geomPr, box.w, box.h);
    const bf = kid(el, "blipFill");
    let fill = bf ? fillFrom(bf, this.e.cc, undefined, part) : undefined;
    if (fill?.kind === "blip" && !fill.stretch && !fill.tile) fill = { ...fill, stretch: { l: 0, t: 0, r: 0, b: 0 } };
    const look = this.look(list, part, grpFill);
    const { line, shadow } = look;
    const frame: Frame = { m, w: box.w, h: box.h };
    // A picture's own geometry only clips the picture.
    const fillGeo: Geometry = { ...geo, paths: geo.paths.filter((p) => p.fill !== "none") };
    // A fill set on the picture shows through its transparent parts.
    const under = look.fill && look.fill.kind !== "none" && look.fill.kind !== "blip" ? look.fill : undefined;
    if (under) {
      if (shadow) await paintShadow(this.pen, this.e.doc, fillGeo.paths.length ? fillGeo : geo, frame, shadow, true, line);
      for (const p of (fillGeo.paths.length ? fillGeo : geo).paths) await paintFill(this.pen, p.segs, under, frame, p.fill === "none" ? "norm" : p.fill, this.loader(part));
    }
    // With a fill under it, the picture's box casts the shadow (painted above).
    let geoShadow = under ? undefined : shadow;
    if (shadow && !under && fill?.kind === "blip") {
      // A picture with see-through parts casts the shadow of what shows.
      const k = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));
      const got = await this.e.images.load(part, fill.blip, this.e.cc, { w: box.w * k, h: box.h * k });
      const place = blipPlacement(fill, box.w, box.h);
      if (got?.transparent && place && !fill.tile) {
        const clip = fillGeo.paths.length === 1 && geomPr && attr(kid(geomPr, "prstGeom"), "prst") !== "rect" ? fillGeo.paths[0].segs : null;
        if (await paintPictureShadow(this.pen, this.e.doc, await got.mask(), place, clip, frame, shadow)) geoShadow = undefined;
      }
    }
    await this.paintGeometry(fillGeo.paths.length ? fillGeo : geo, fill, line, geoShadow, frame, part);
    this.shapeLink(el, m, box.w, box.h, part);
  }

  private async graphicFrame(el: El, part: Part, parent: Mat) {
    const box = xfrmOf(kid(el, "xfrm"));
    if (!box) return;
    const m = then(boxMatrix(box.x, box.y, box.w, box.h, box.rot, box.flipH, box.flipV), parent);
    const data = path(el, "graphic", "graphicData");
    const uri = attr(data, "uri") ?? "";
    if (uri.endsWith("/table")) {
      const tbl = kid(data, "tbl");
      if (tbl) await drawTable(this.e, this, tbl, m, box.w, box.h, part);
      return;
    }
    if (uri.endsWith("/chart")) {
      const c = kid(data, "chart");
      const id = c?.getAttributeNS(R_NS, "id") || attr(c, "id");
      const rel = id ? part.rels.get(id) : undefined;
      const chart = rel ? await this.e.pres.pkg.part(rel.target) : null;
      if (chart) await this.chart(chart, m, box.w, box.h);
      return;
    }
    if (uri.endsWith("/diagram")) {
      await this.smartArt(data!, part, then(translate(box.x, box.y), parent));
      return;
    }
    // OLE objects and others: their picture (in the frame, or in the VML drawing of older files).
    const pic = data?.getElementsByTagNameNS("*", "pic")[0];
    if (!pic) {
      const ole = data?.getElementsByTagNameNS("*", "oleObj")[0];
      if (ole) await this.vmlPreview(attr(ole, "spid"), part, { m, w: box.w, h: box.h });
      return;
    }
    if (pic) {
      if (!xfrmOf(kid(kid(pic, "spPr"), "xfrm"))) {
        // The frame's placement stands in for the picture's.
        const bf = kid(pic, "blipFill");
        const fill = bf ? fillFrom(bf, this.e.cc, undefined, part) : undefined;
        if (fill?.kind === "blip") await this.paintGeometry(presetGeometry("rect", box.w, box.h)!, { ...fill, stretch: fill.stretch ?? { l: 0, t: 0, r: 0, b: 0 } }, {}, undefined, { m, w: box.w, h: box.h }, part);
      } else await this.picture(pic, part, parent);
    }
  }

  private async smartArt(data: El, part: Part, parent: Mat) {
    const ids = kid(data, "relIds");
    const dmId = ids?.getAttributeNS(R_NS, "dm") || attr(ids, "dm");
    const dm = dmId ? part.rels.get(dmId) : undefined;
    let drawingPath: string | undefined;
    if (dm) {
      const dataPart = await this.e.pres.pkg.part(dm.target);
      const ext = dataPart?.doc.getElementsByTagNameNS("*", "dataModelExt")[0];
      const relId = attr(ext, "relId");
      if (relId) drawingPath = part.rels.get(relId)?.target;
      if (!drawingPath) {
        const n = /(\d+)\.xml$/.exec(dm.target)?.[1];
        drawingPath = [...part.rels.values()].find((r) => /diagramDrawing/.test(r.type) && (!n || r.target.endsWith(`drawing${n}.xml`)))?.target;
      }
    }
    if (!drawingPath) {
      this.e.warnings.add("A SmartArt graphic has no saved drawing and was left out.");
      return;
    }
    const drawing = await this.e.pres.pkg.part(drawingPath);
    resolveAlternates(drawing?.doc);
    const tree = drawing?.doc.getElementsByTagNameNS("*", "spTree")[0];
    if (drawing && tree) await this.walk(tree, drawing, parent, "slide");
  }

  private async chart(part: Part, m: Mat, w: number, h: number) {
    const pen = this.pen;
    const kit = this.e.kit;
    const [x, y] = apply(m, 0, 0);
    const page = pen.page;
    // Picture, gradient and pattern fills of the chart and plot areas, drawn as on slides.
    const host: ChartHost = {
      // Unformatted chart text takes the presentation's default size, as in PowerPoint.
      textSize: num(attr(kid(kid(this.e.pres.defaultTextStyle, "lvl1pPr"), "defRPr"), "sz"), 1800) / 100,
      fill: async (spPr, r) => {
        const f = readFill(spPr, this.e.cc, undefined, part);
        if (!f || f.kind === "none" || f.kind === "solid") return false;
        pen.begin();
        try {
          await paintFill(pen, presetGeometry("rect", r.w, r.h)!.paths[0].segs, f, { m: translate(r.x, r.y), w: r.w, h: r.h }, "norm", this.loader(part));
        } finally {
          pen.end();
        }
        return true;
      },
    };
    pen.end();
    try {
      const font = (bold?: boolean, italic?: boolean, name?: string) => ({ name: name || this.e.theme.minor.latin || "Calibri", size: 10, bold: !!bold, italic: !!italic });
      await drawChart(
        page,
        part.doc,
        this.e.theme,
        { x, y, w, h },
        async (text, tx, baseline, size, opt) => {
          const f = font(opt.bold, opt.italic, opt.font);
          const tw = await kit.width(text, f, size);
          const left = opt.align === "center" ? tx - tw / 2 : opt.align === "right" ? tx - tw : tx;
          await kit.draw(page, text, left, this.e.pres.H - baseline, f, size, opt.color ?? "000000");
        },
        (text, size, bold, name) => kit.width(text, font(bold, false, name), size),
        this.e.cc.map,
        host,
      );
    } finally {
      pen.begin();
    }
  }
}

export function geometryOf(spPr: El | null, w: number, h: number): Geometry {
  if (!spPr) return presetGeometry("rect", w, h)!;
  const cust = kid(spPr, "custGeom");
  if (cust) return customGeometry(cust, w, h);
  const prst = kid(spPr, "prstGeom");
  return presetGeometry(attr(prst, "prst") ?? "rect", w, h, adjustValues(kid(prst, "avLst"))) ?? shapeGeometry(null, w, h);
}

export function resolveLink(hk: El, part: Part, pres: Pres): Link | undefined {
  const id = hk.getAttributeNS(R_NS, "id") || attr(hk, "id");
  const action = attr(hk, "action") ?? "";
  if (/hlinkshowjump/.test(action)) {
    const jump = /jump=(\w+)/.exec(action)?.[1];
    return jump ? { jump } : undefined;
  }
  if (!id) return undefined;
  const rel = part.rels.get(id);
  if (!rel) return undefined;
  if (/hlinksldjump/.test(action) || /\/slide$/.test(rel.type)) {
    const idx = pres.slideIndex.get(rel.target);
    return idx !== undefined ? { slide: idx } : undefined;
  }
  if (rel.external && /^(https?|mailto|ftp|tel):/i.test(rel.target)) return { url: rel.target };
  return undefined;
}

/** Link annotations for a page; quads are in slide (y-down) coordinates. */
export function addLinkAnnots(doc: PDFDocument, page: PDFPage, H: number, links: LinkBox[], pageRefs: (i: number) => unknown, pageOfSlide: (slide: number) => number | undefined, current: number, count: number) {
  const ctx = doc.context;
  const annots = [];
  // One box per run of linked words on a line, not one per word.
  const same = (a: Link, b: Link) => a.url === b.url && a.slide === b.slide && a.jump === b.jump;
  const boxes: { link: Link; rect: number[] }[] = [];
  for (const l of links) {
    const xs = l.quad.map((q) => q[0]);
    const ys = l.quad.map((q) => H - q[1]);
    const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const prev = boxes[boxes.length - 1];
    const overlapY = prev ? Math.min(prev.rect[3], rect[3]) - Math.max(prev.rect[1], rect[1]) : 0;
    if (prev && same(prev.link, l.link) && overlapY > 0.5 * Math.min(prev.rect[3] - prev.rect[1], rect[3] - rect[1]) && rect[0] - prev.rect[2] < 3 && rect[2] > prev.rect[0]) {
      prev.rect = [Math.min(prev.rect[0], rect[0]), Math.min(prev.rect[1], rect[1]), Math.max(prev.rect[2], rect[2]), Math.max(prev.rect[3], rect[3])];
    } else boxes.push({ link: l.link, rect });
  }
  for (const { link, rect } of boxes) {
    const l = { link };
    if (rect[2] - rect[0] < 0.5 || rect[3] - rect[1] < 0.5) continue;
    let action: Record<string, unknown> | null = null;
    let dest: unknown = null;
    if (l.link.url) action = { Type: "Action", S: "URI", URI: PDFString.of(l.link.url) };
    else {
      let target: number | undefined;
      if (l.link.slide !== undefined) target = pageOfSlide(l.link.slide);
      else if (l.link.jump === "nextslide") target = current + 1;
      else if (l.link.jump === "previousslide") target = current - 1;
      else if (l.link.jump === "firstslide") target = 0;
      else if (l.link.jump === "lastslide") target = count - 1;
      if (target === undefined || target < 0 || target >= count) continue;
      dest = [pageRefs(target), PDFName.of("Fit")];
    }
    const d: Record<string, unknown> = { Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0] };
    if (action) d.A = action;
    if (dest) d.Dest = dest;
    annots.push(ctx.register(ctx.obj(d as never)));
  }
  if (!annots.length) return;
  const existing = page.node.Annots();
  if (existing) for (const a of annots) existing.push(a);
  else page.node.set(PDFName.of("Annots"), ctx.obj(annots));
}

export { readTheme, type RGBA };
