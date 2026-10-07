/**
 * Word (.docx) → PDF, laid out like Word: read the document, build HTML that
 * follows Word's layout rules, let the browser set the lines in metric-
 * compatible fonts, cut the result into pages, then paint the PDF.
 */
import { newDoc, saveDoc, tick, type PDFPage, type ProgressFn } from "../core";
import { setOutline, type OutlineEntry } from "../outline";
import { Frame } from "./frame";
import { HtmlGen, formatNumber } from "./html";
import { baselineOffsets, measure, resolveTabs, type Measured } from "./measure";
import type { Drawing, Section } from "./model";
import { Painter, borderTotal } from "./paint";
import { columnsOf, paginate, type Page, type SectionFlow } from "./paginate";
import { readDocx } from "./read";

const FMT_SWITCH: Record<string, string> = { roman: "lowerRoman", ROMAN: "upperRoman", alphabetic: "lowerLetter", ALPHABETIC: "upperLetter", arabic: "decimal", Arabic: "decimal" };

export async function docxToPdfBytes(bytes: Uint8Array, name: string, onProgress?: ProgressFn): Promise<{ pdf: Uint8Array; pages: number; warnings: string[] }> {
  onProgress?.(0.05, "Reading the Word file");
  const model = await readDocx(bytes);
  const gen = new HtmlGen(model);

  // Body of each section, at its column width.
  const sections = model.sections.map(({ sect, blocks }) => {
    const cols = columnsOf(sect);
    return { sect, width: cols.w[0], html: gen.body(blocks, cols.w[0], sect) };
  });
  // Endnotes close the document.
  const endnotes = gen.notes.filter((n) => n.note === "endnote");
  if (endnotes.length) {
    const last = sections[sections.length - 1];
    let html = gen.rule(last.width);
    for (const n of endnotes) html += gen.note(model.endnotes.get(n.id) ?? [], last.width, n.label);
    last.html += html;
  }
  // Footnotes at the body width of the first section that uses them.
  const footnotes = gen.notes.filter((n) => n.note === "footnote");
  const noteWidth = sections[0]?.width ?? 450;
  const noteHtml = footnotes.map((n) => ({ key: `footnote:${n.id}`, html: gen.note(model.footnotes.get(n.id) ?? [], noteWidth, n.label) }));
  // Headers and footers, once per part and width.
  type PartRef = { key: string; path: string; width: number; sect: Section };
  const partRefs = new Map<string, PartRef>();
  const partKey = (path: string, width: number) => `${path}@${Math.round(width)}`;
  for (const { sect } of sections) {
    const width = sect.pageW - sect.margin.left - sect.margin.right;
    for (const set of [sect.headers, sect.footers]) for (const p of Object.values(set)) if (p && !partRefs.has(partKey(p, width))) partRefs.set(partKey(p, width), { key: partKey(p, width), path: p, width, sect });
  }
  const partHtml = new Map<string, string>();
  for (const r of partRefs.values()) partHtml.set(r.key, gen.part(model.parts.get(r.path) ?? [], r.width, r.sect));

  onProgress?.(0.2, "Loading fonts");
  const frame = await Frame.create();
  try {
    await frame.loadFaces(gen.faces);
    onProgress?.(0.3, "Laying out the pages");
    await tick();
    const bodyEls = sections.map((s) => frame.add(s.html, s.width));
    const partEls = new Map<string, HTMLElement>();
    for (const r of partRefs.values()) partEls.set(r.key, frame.add(partHtml.get(r.key)!, r.width));
    const noteEls = noteHtml.map((n) => ({ key: n.key, el: frame.add(n.html, noteWidth) }));
    const ovEls = new Map<number, HTMLElement>();
    for (const [idx, html] of gen.overlays) ovEls.set(idx, frame.add(html, gen.draws[idx].d.w, "root ovroot"));
    // Tabs depend on where text ends, so they are sized before anything is measured.
    const dt = model.settings.defaultTab;
    bodyEls.forEach((el, i) => resolveTabs(el, gen, dt, sections[i].width));
    for (const r of partRefs.values()) resolveTabs(partEls.get(r.key)!, gen, dt, r.width);
    for (const n of noteEls) resolveTabs(n.el, gen, dt, noteWidth);
    for (const [idx, el] of ovEls) resolveTabs(el, gen, dt, gen.draws[idx].d.w);
    const baseOff = baselineOffsets(frame.doc, gen.spans);
    onProgress?.(0.45, "Measuring");
    await tick();
    const measured: Measured[] = bodyEls.map((el) => measure(el, gen, baseOff));
    const partM = new Map<string, Measured>();
    for (const [k, el] of partEls) partM.set(k, measure(el, gen, baseOff));
    const noteM = new Map<string, Measured>();
    for (const n of noteEls) noteM.set(n.key, measure(n.el, gen, baseOff));
    const ovM = new Map<number, Measured>();
    for (const [idx, el] of ovEls) ovM.set(idx, measure(el, gen, baseOff));

    // Pages.
    const heightOf = (path: string | undefined, width: number) => (path ? (partM.get(partKey(path, width))?.height ?? 0) : 0);
    const flows: SectionFlow[] = sections.map((s, i) => {
      const width = s.sect.pageW - s.sect.margin.left - s.sect.margin.right;
      const h = s.sect.headers;
      const f = s.sect.footers;
      const variant = (set: typeof h, v: "first" | "even" | "default") => (v === "first" ? set.first : v === "even" ? (set.even ?? set.default) : set.default);
      return {
        sect: s.sect,
        m: i,
        measured: measured[i],
        header: { first: heightOf(variant(h, "first"), width), even: heightOf(variant(h, "even"), width), default: heightOf(variant(h, "default"), width) },
        footer: { first: heightOf(variant(f, "first"), width), even: heightOf(variant(f, "even"), width), default: heightOf(variant(f, "default"), width) },
      };
    });
    const pages = paginate(flows, { evenAndOdd: model.settings.evenAndOdd, noteHeight: (k) => noteM.get(k)?.height ?? 0, separator: 13 });
    const dbg = globalThis as { __dypKeepFrame?: boolean; __dypDebug?: unknown };
    if (dbg.__dypKeepFrame) dbg.__dypDebug = { pages, flows: flows.map((f) => ({ header: f.header, footer: f.footer, sect: f.sect, height: f.measured.height })) };
    onProgress?.(0.6, "Drawing the PDF");
    await tick();

    const doc = await newDoc();
    doc.setTitle(model.title || name.replace(/\.[^.]+$/, ""));
    if (model.author) doc.setAuthor(model.author);
    const painter = new Painter(doc, gen, model);
    const pdfPages: PDFPage[] = pages.map((p) => doc.addPage([p.w, p.h]));
    const bookmarkAt = new Map<string, { page: number; y: number }>();
    const headings: { page: number; y: number; text: string; level: number }[] = [];

    for (let pi = 0; pi < pages.length; pi++) {
      if (pi % 5 === 0) {
        onProgress?.(0.6 + (0.38 * pi) / pages.length, `Drawing page ${pi + 1} of ${pages.length}`);
        await tick();
      }
      const pg = pages[pi];
      const page = pdfPages[pi];
      const sect = flows[pg.sect].sect;
      const width = sect.pageW - sect.margin.left - sect.margin.right;
      // Overlays anchored on this page (body and header/footer), split by z-order.
      const overlays: { d: Drawing; idx: number; x: number; y: number; size?: { w: number; h: number } }[] = [];
      const collect = (m: Measured, y0: number, y1: number, dx: number, dy: number, colX: number, colW: number) => {
        for (const a of m.anchors) {
          if (a.y < y0 - 0.01 || a.y >= y1 - 0.01) continue;
          const idx = Number(a.name);
          const info = gen.draws[idx];
          if (!info) continue;
          const paraTop = (m.paraTop.get(a.p) ?? a.y) + dy;
          const om = ovM.get(idx);
          const size = info.d.autofit && om ? { w: info.d.w, h: om.height } : undefined;
          const pos = place(size ? { ...info.d, h: size.h } : info.d, pg, sect, a.x + dx, a.y + dy, Math.max(paraTop, y0 + dy), colX, colW);
          overlays.push({ d: info.d, idx, ...pos, size });
        }
      };
      // Header and footer for this page, with its page numbers filled in.
      const hf: { m: Measured; x: number; y: number }[] = [];
      for (const [set, isHeader] of [[sect.headers, true], [sect.footers, false]] as const) {
        const path = pg.variant === "first" ? set.first : pg.variant === "even" ? (set.even ?? set.default) : set.default;
        if (!path) continue;
        const key = partKey(path, width);
        const el = partEls.get(key);
        let m = partM.get(key);
        if (!el || !m) continue;
        if (m.fields.length) {
          for (const f of m.fields) {
            const fmt = (f.format && FMT_SWITCH[f.format]) || (f.field === "PAGE" ? pg.fmt : "decimal");
            f.el.textContent = f.field === "PAGE" ? formatNumber(pg.num, fmt) : f.field === "NUMPAGES" ? String(pg.total ?? pages.length) : String(pg.sectionPages ?? 1);
          }
          resolveTabs(el, gen, dt, width);
          m = measure(el, gen, baseOff);
        }
        const y = isHeader ? sect.margin.header : sect.pageH - sect.margin.footer - m.height;
        hf.push({ m, x: sect.margin.left, y });
        collect(m, -1e9, 1e9, sect.margin.left, y, sect.margin.left, width);
      }
      for (const c of pg.chunks) collect(measured[c.m], c.y0, c.y1, c.x, c.y - c.y0, c.x, c.w);
      overlays.sort((a, b) => (a.d.place.z ?? 0) - (b.d.place.z ?? 0));
      const paintOverlay = async (o: (typeof overlays)[number]) => {
        await painter.drawing(page, gen.draws[o.idx], o.x, o.y, o.size);
        const om = ovM.get(o.idx);
        if (om) await painter.paint(page, pi, om, null, o.x, o.y, { skipDrawings: true });
      };
      pageBorders(page, sect, pi, pg, painter, "back");
      for (const o of overlays) if (o.d.place.behind) await paintOverlay(o);
      for (const h of hf) await painter.paint(page, pi, h.m, null, h.x, h.y);
      for (const c of pg.chunks) {
        const m = measured[c.m];
        await painter.paint(page, pi, m, { y0: c.y0, y1: c.y1 }, c.x, c.y - c.y0);
        for (const b of m.bookmarks) if (b.y >= c.y0 && b.y < c.y1 && !bookmarkAt.has(b.name)) bookmarkAt.set(b.name, { page: pi, y: b.y + c.y - c.y0 });
        for (const [idx, text] of gen.headingTexts) {
          const top = m.paraTop.get(idx);
          if (top === undefined || top < c.y0 - 0.01 || top >= c.y1 - 0.01) continue;
          if (headings.some((h) => h.text === text && h.page === pi && Math.abs(h.y - (top + c.y - c.y0)) < 1)) continue;
          headings.push({ page: pi, y: top + c.y - c.y0, text, level: gen.paras[idx].heading ?? 1 });
        }
      }
      // Footnotes at the foot of the page, under a short rule.
      if (pg.notes.length) {
        // The last note's last line sits on the bottom margin (its space after falls away).
        const content = (k: string) => Math.max(0, ...(noteM.get(k)?.blocks.map((b) => b.bottom) ?? [0]));
        const last = pg.notes[pg.notes.length - 1];
        const total = pg.notes.reduce((h, k) => h + (noteM.get(k)?.height ?? 0), 0) - ((noteM.get(last)?.height ?? 0) - content(last)) + 13;
        let y = pg.bodyBottom - total;
        const x = pg.colX[0];
        page.drawLine({ start: { x, y: page.getHeight() - (y + 6) }, end: { x: x + Math.min(144, pg.colW[0] / 3), y: page.getHeight() - (y + 6) }, thickness: 0.5 });
        y += 13;
        for (const k of pg.notes) {
          const m = noteM.get(k);
          if (!m) continue;
          await painter.paint(page, pi, m, null, x, y);
          y += m.height;
        }
      }
      for (const o of overlays) if (!o.d.place.behind) await paintOverlay(o);
      pageBorders(page, sect, pi, pg, painter, "front");
    }
    painter.addLinks(pdfPages, (anchor) => bookmarkAt.get(anchor));
    // Bookmarks from headings, as Word's "Save as PDF" makes them.
    if (headings.length > 1) setOutline(doc, nest(headings, pages), true);
    onProgress?.(0.99, "Saving");
    const pdf = await saveDoc(doc);
    return { pdf, pages: pages.length, warnings: [...model.warnings] };
  } finally {
    // (Tests can keep the layout frame to inspect it.)
    const g = globalThis as { __dypKeepFrame?: boolean; __dypFrame?: Frame };
    if (g.__dypKeepFrame) g.__dypFrame = frame;
    else frame.destroy();
  }
}

/** Where an anchored drawing sits on its page. */
function place(d: Drawing, pg: Page, s: Section, ax: number, ay: number, paraTop: number, colX: number, colW: number): { x: number; y: number } {
  const pl = d.place;
  const hRel = ({ text: "column", char: "character", "left-margin-area": "leftMargin", "right-margin-area": "rightMargin" } as Record<string, string>)[pl.hRel ?? ""] ?? pl.hRel ?? "column";
  const vRel = ({ text: "paragraph", "top-margin-area": "topMargin", "bottom-margin-area": "bottomMargin" } as Record<string, string>)[pl.vRel ?? ""] ?? pl.vRel ?? "paragraph";
  const hb: Record<string, [number, number]> = {
    page: [0, pg.w],
    margin: [s.margin.left, pg.w - s.margin.right],
    column: [colX, colX + colW],
    character: [ax, ax],
    leftMargin: [0, s.margin.left],
    rightMargin: [pg.w - s.margin.right, pg.w],
    insideMargin: [0, s.margin.left],
    outsideMargin: [pg.w - s.margin.right, pg.w],
  };
  const vb: Record<string, [number, number]> = {
    page: [0, pg.h],
    margin: [s.margin.top, pg.h - s.margin.bottom],
    paragraph: [paraTop, paraTop],
    line: [ay, ay],
    topMargin: [0, s.margin.top],
    bottomMargin: [pg.h - s.margin.bottom, pg.h],
    insideMargin: [s.margin.top, pg.h - s.margin.bottom],
    outsideMargin: [s.margin.top, pg.h - s.margin.bottom],
  };
  const [h0, h1] = hb[hRel] ?? hb.column;
  const [v0, v1] = vb[vRel] ?? vb.paragraph;
  const alignIn = (a: string | undefined, lo: number, hi: number, size: number, off: number | undefined) => {
    if (a === "center") return (lo + hi - size) / 2;
    if (a === "right" || a === "bottom" || a === "outside") return hi - size;
    if (a === "left" || a === "top" || a === "inside") return lo;
    return lo + (off ?? 0);
  };
  return { x: alignIn(pl.hAlign, h0, h1, d.w, pl.hOffset), y: alignIn(pl.vAlign, v0, v1, d.h, pl.vOffset) };
}

function pageBorders(page: PDFPage, s: Section, pi: number, pg: Page, painter: Painter, layer: "back" | "front") {
  const pb = s.pgBorders;
  if (!pb) return;
  if ((pb.zOrder === "back") !== (layer === "back")) return;
  if (pb.display === "firstPage" && !pg.firstOfSection) return;
  if (pb.display === "notFirstPage" && pg.firstOfSection) return;
  void pi;
  const sp = (b?: { space: number; width: number }) => b?.space ?? 0;
  let x0: number;
  let y0: number;
  let x1: number;
  let y1: number;
  // The space runs from the page edge to the border's outer edge, or from the text to its inner edge.
  if (pb.offsetFrom === "page") {
    x0 = sp(pb.left);
    y0 = sp(pb.top);
    x1 = s.pageW - sp(pb.right);
    y1 = s.pageH - sp(pb.bottom);
  } else {
    x0 = s.margin.left - sp(pb.left) - borderTotal(pb.left);
    y0 = s.margin.top - sp(pb.top) - borderTotal(pb.top);
    x1 = s.pageW - s.margin.right + sp(pb.right) + borderTotal(pb.right);
    y1 = s.pageH - s.margin.bottom + sp(pb.bottom) + borderTotal(pb.bottom);
  }
  painter.borders(page, { top: pb.top, left: pb.left, bottom: pb.bottom, right: pb.right }, x0, y0, x1 - x0, y1 - y0, false);
}

function nest(flat: { page: number; y: number; text: string; level: number }[], pages: Page[]): OutlineEntry[] {
  const root: OutlineEntry[] = [];
  const stack: { level: number; e: OutlineEntry }[] = [];
  for (const f of flat) {
    const e: OutlineEntry = { title: f.text, pageIndex: f.page, top: pages[f.page].h - f.y };
    while (stack.length && stack[stack.length - 1].level >= f.level) stack.pop();
    if (stack.length) (stack[stack.length - 1].e.children ??= []).push(e);
    else root.push(e);
    stack.push({ level: f.level, e });
  }
  return root;
}
