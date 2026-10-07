/**
 * PowerPoint (.pptx) to PDF, drawn the way PowerPoint draws slides: every
 * shape's real geometry (all preset shapes and freeforms), rotation and
 * flips, solid, gradient, pattern and picture fills, outlines with dashes and
 * arrowheads, shadows, text laid out with the theme's fonts and PowerPoint's
 * line spacing, bullets and autofit, tables with their styles, charts,
 * SmartArt, links and slide numbers. Runs entirely in the browser.
 */
import { newDoc, pdfOut, saveDoc, stem, tick, type OutFile, type ProgressFn } from "../core";
import { Package, attr, kid, kids, num, readTheme, resolveAlternates, type El, type Part } from "../ooxml";
import { setOutline, type OutlineEntry } from "../outline";
import { Pen } from "../drawingml/pen";
import { TextKit } from "../textkit";
import { Images } from "./images";
import { SlidePainter, addLinkAnnots, resolveLink, type LinkBox, type Pres, type SlideEnv } from "./slide";
import { SlideText } from "./text";

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export type PptxResult = { pdf: Uint8Array; pages: number; warnings: string[] };

async function readPres(bytes: Uint8Array): Promise<Pres> {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new Error("This is an old .ppt file. Save it as .pptx in PowerPoint, Keynote, Google Slides or LibreOffice, then convert.");
  let pkg: Package;
  try {
    pkg = await Package.open(bytes);
  } catch {
    throw new Error("That file isn't a valid .pptx presentation.");
  }
  const main = (await pkg.mainPart(/officeDocument$/)) ?? "ppt/presentation.xml";
  const pres = await pkg.part(main);
  if (!pres) throw new Error("This .pptx has no presentation part. It may be damaged.");
  const root = pres.doc.documentElement;
  const sz = kid(root, "sldSz");
  const slides: Pres["slides"] = [];
  for (const s of kids(kid(root, "sldIdLst"), "sldId")) {
    const id = s.getAttributeNS(R_NS, "id") || attr(s, "id");
    const rel = id ? pres.rels.get(id) : undefined;
    if (!rel) continue;
    const part = await pkg.part(rel.target);
    slides.push({ path: rel.target, hidden: attr(part?.doc.documentElement, "show") === "0" });
  }
  const tableStyles = new Map<string, El>();
  const tsRel = [...pres.rels.values()].find((r) => /\/tableStyles$/.test(r.type));
  const ts = tsRel ? await pkg.part(tsRel.target) : null;
  for (const st of kids(ts?.doc.documentElement, "tblStyle")) {
    const id = attr(st, "styleId");
    if (id) tableStyles.set(id, st);
  }
  return {
    pkg,
    W: num(attr(sz, "cx"), 9144000) / 12700,
    H: num(attr(sz, "cy"), 6858000) / 12700,
    slides,
    defaultTextStyle: kid(root, "defaultTextStyle"),
    firstSlideNum: num(attr(root, "firstSlideNum"), 1),
    tableStyles,
    slideIndex: new Map(slides.map((s, i) => [s.path, i])),
  };
}

/** Plain text of a slide's title placeholder, for its bookmark. */
function titleOf(slide: Part): string {
  for (const sp of Array.from(slide.doc.getElementsByTagNameNS("*", "sp"))) {
    const ph = sp.getElementsByTagNameNS("*", "ph")[0];
    const t = attr(ph, "type");
    if (t !== "title" && t !== "ctrTitle") continue;
    const text = kids(kid(sp, "txBody"), "p")
      .map((p) => Array.from(p.getElementsByTagNameNS("*", "t")).map((x) => x.textContent ?? "").join(""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text;
  }
  return "";
}

const relOf = (part: Part | null, type: RegExp) => (part ? [...part.rels.values()].find((r) => type.test(r.type)) : undefined);

export async function pptxToPdfBytes(bytes: Uint8Array, name: string, opts: { hidden?: boolean } = {}, onProgress?: ProgressFn): Promise<PptxResult> {
  onProgress?.(0.03, "Reading the presentation");
  const pres = await readPres(bytes);
  const shown = pres.slides.map((s, i) => ({ ...s, index: i })).filter((s) => opts.hidden || !s.hidden);
  if (!pres.slides.length) throw new Error("No slides found in this presentation.");
  if (!shown.length) throw new Error("Every slide in this presentation is hidden.");
  const doc = await newDoc();
  doc.setTitle(stem(name));
  const kit = new TextKit(doc);
  const images = new Images(pres.pkg, doc);
  const warnings = new Set<string>();
  const outline: OutlineEntry[] = [];
  const pageOfSlide = new Map(shown.map((s, i) => [s.index, i]));
  const pending: { page: ReturnType<typeof doc.addPage>; links: LinkBox[]; i: number }[] = [];
  for (let i = 0; i < shown.length; i++) {
    onProgress?.(0.05 + (0.9 * i) / shown.length, `Slide ${i + 1} of ${shown.length}`);
    const slide = await pres.pkg.part(shown[i].path);
    const page = doc.addPage([pres.W, pres.H]);
    if (!slide) continue;
    const layout = await partOf(pres.pkg, relOf(slide, /\/slideLayout$/)?.target);
    const master = await partOf(pres.pkg, relOf(layout, /\/slideMaster$/)?.target);
    const themePart = await partOf(pres.pkg, relOf(master, /\/theme$/)?.target);
    for (const p of [slide, layout, master]) resolveAlternates(p?.doc);
    const theme = readTheme(themePart?.doc ?? null);
    // Colour mapping: the master's, unless the layout or the slide overrides it.
    const map: Record<string, string> = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" };
    const clrMap = master?.doc.getElementsByTagNameNS("*", "clrMap")[0];
    for (const a of Array.from(clrMap?.attributes ?? [])) map[a.localName] = a.value;
    for (const p of [layout, slide]) {
      const ovr = p?.doc.getElementsByTagNameNS("*", "overrideClrMapping")[0];
      if (ovr) for (const a of Array.from(ovr.attributes)) map[a.localName] = a.value;
    }
    const cc = { theme, map };
    const fmtScheme = themePart?.doc.getElementsByTagNameNS("*", "fmtScheme")[0];
    const fmt = {
      fill: Array.from(kid(fmtScheme, "fillStyleLst")?.children ?? []),
      ln: kids(kid(fmtScheme, "lnStyleLst"), "ln"),
      effect: kids(kid(fmtScheme, "effectStyleLst"), "effectStyle"),
      bg: Array.from(kid(fmtScheme, "bgFillStyleLst")?.children ?? []),
    };
    const txStyles = master?.doc.getElementsByTagNameNS("*", "txStyles")[0];
    const pen = new Pen(doc, page, pres.H);
    const links: LinkBox[] = [];
    const slideNo = pres.firstSlideNum + shown[i].index;
    const env: SlideEnv = {
      pres,
      doc,
      pen,
      kit,
      images,
      text: null as unknown as SlideText,
      theme,
      cc,
      fmt,
      slide,
      layout,
      master,
      themePart,
      txStyles: { title: kid(txStyles, "titleStyle"), body: kid(txStyles, "bodyStyle"), other: kid(txStyles, "otherStyle") },
      slideNo,
      links,
      warnings,
    };
    env.text = new SlideText({
      kit,
      theme,
      cc,
      slideNo,
      link: (el) => resolveLink(el, slide, pres),
      onLink: (link, quad) => links.push({ link, quad }),
      bulletImage: async (blip) => {
        const got = await images.load(slide, blip, cc);
        return got ? { draw: (p, m) => p.image(got.img, m), w: got.w, h: got.h } : null;
      },
    });
    const painter = new SlidePainter(env);
    pen.begin();
    try {
      // A white page under everything, as PowerPoint prints.
      pen.rectPath(0, 0, pres.W, pres.H);
      pen.fillWith({ hex: "FFFFFF", alpha: 1 });
      await painter.background();
      const showMaster = attr(slide.doc.documentElement, "showMasterSp") !== "0";
      if (master && showMaster && attr(layout?.doc.documentElement, "showMasterSp") !== "0") await painter.tree(master, "master");
      if (layout && showMaster) await painter.tree(layout, "layout");
      await painter.tree(slide, "slide");
    } catch (err) {
      warnings.add(`Slide ${i + 1} couldn't be drawn completely (${(err as Error).message ?? err}).`);
    } finally {
      pen.end();
    }
    pending.push({ page, links, i });
    const title = titleOf(slide);
    outline.push({ title: title || `Slide ${i + 1}`, pageIndex: i });
    await tick();
  }
  const pages = doc.getPages();
  for (const p of pending) addLinkAnnots(doc, p.page, pres.H, p.links, (k) => pages[k].ref, (s) => pageOfSlide.get(s), p.i, pages.length);
  if (outline.length > 1) setOutline(doc, outline, true);
  if (images.skipped) warnings.add(`${images.skipped} picture${images.skipped === 1 ? " is" : "s are"} in a format we can't draw (HD Photo, TIFF, or a damaged file) and ${images.skipped === 1 ? "was" : "were"} left out.`);
  onProgress?.(0.97, "Saving");
  const pdf = await saveDoc(doc);
  return { pdf, pages: pages.length, warnings: [...warnings] };
}

async function partOf(pkg: Package, path: string | undefined): Promise<Part | null> {
  return path ? pkg.part(path) : null;
}

export async function pptxToPdf(bytes: Uint8Array, name: string, onProgress?: ProgressFn): Promise<OutFile> {
  const r = await pptxToPdfBytes(bytes, name, {}, onProgress);
  const note = `${r.pages} slide${r.pages === 1 ? "" : "s"}` + (r.warnings.length ? `. ${r.warnings.join(" ")}` : "");
  return pdfOut(`${stem(name)}.pdf`, r.pdf, note);
}
