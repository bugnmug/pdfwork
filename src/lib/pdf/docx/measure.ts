/**
 * Reads the browser's layout back: tab widths first (they depend on where the
 * text before them ended), then every word's box and baseline, every line of
 * every paragraph, cells, rows, boxes and drawings, all in points relative to
 * the container.
 */
import { cssFamily } from "./fonts";
import type { BoxInfo, HtmlGen, ParaInfo, SpanStyle } from "./html";
import type { TabStop } from "./model";
import { PX, pt } from "./units";


export type Seg = { text: string; x: number; y: number; w: number; h: number; base: number; s: number; space: boolean; p: number };
export type TabMark = { x: number; y: number; w: number; base: number; s: number; leader?: string };
export type BoxMark = { x: number; y: number; w: number; h: number; info: BoxInfo };
export type DrawMark = { x: number; y: number; w: number; h: number; d: number; link?: number };
export type Marker = { x: number; y: number; name: string; p: number };
export type Line = { top: number; bottom: number };
export type MBlock =
  | { kind: "p"; idx: number; top: number; bottom: number; lines: Line[]; info: ParaInfo }
  | { kind: "group"; top: number; bottom: number; children: MBlock[] }
  | { kind: "table"; top: number; bottom: number; rows: MRow[] }
  | { kind: "draw"; top: number; bottom: number };
export type MRow = { top: number; bottom: number; header: boolean; cantSplit: boolean; cells: { top: number; bottom: number; blocks: MBlock[] }[] };

export type Measured = {
  root: HTMLElement;
  width: number;
  height: number;
  segs: Seg[];
  tabs: TabMark[];
  boxes: BoxMark[];
  draws: DrawMark[];
  anchors: Marker[];
  bookmarks: Marker[];
  notes: Marker[];
  fields: { el: HTMLElement; field: string; format?: string }[];
  blocks: MBlock[];
  /** Areas no page break may cut through (floating pictures). */
  hard: Line[];
  paraTop: Map<number, number>;
};

export function spanFontCss(st: SpanStyle): string {
  return `font-family:${st.stack.map((f) => cssFamily(f)).join(",")};font-size:${pt(st.size)};font-weight:${st.bold ? 700 : 400};font-style:${st.italic ? "italic" : "normal"}`;
}

/** Baseline position below the top of a text box, per span style, measured in the frame itself. */
export function baselineOffsets(doc: Document, styles: SpanStyle[]): number[] {
  const host = doc.createElement("div");
  host.style.cssText = "position:absolute;left:0;top:-20000px;width:2000px";
  host.innerHTML = styles.map((st) => `<div style="line-height:normal;white-space:nowrap"><span style="${spanFontCss(st)}">x<i style="display:inline-block;width:0;height:0;vertical-align:baseline"></i></span></div>`).join("");
  doc.body.appendChild(host);
  const out: number[] = [];
  const divs = Array.from(host.children) as HTMLElement[];
  for (const d of divs) {
    const span = d.firstElementChild as HTMLElement;
    const text = span.firstChild as Text;
    const marker = span.lastElementChild as HTMLElement;
    const r = doc.createRange();
    r.setStart(text, 0);
    r.setEnd(text, 1);
    const tr = r.getBoundingClientRect();
    const mr = marker.getBoundingClientRect();
    out.push((mr.bottom - tr.top) * PX);
  }
  host.remove();
  return out;
}

const own = (el: Element, p: Element) => el.closest("div.p") === p;

/** Size every tab in a container: Word's tab stops, default stops, the hanging indent stop, right/centre/decimal tabs. */
export function resolveTabs(root: HTMLElement, gen: HtmlGen, defaultTab: number, colWidth: number) {
  const doc = root.ownerDocument;
  for (const p of Array.from(root.querySelectorAll<HTMLElement>("div.p"))) {
    const tabs = Array.from(p.querySelectorAll<HTMLElement>(".tb")).filter((t) => own(t, p));
    const info = gen.paras[Number(p.dataset.p)];
    if (!info) continue;
    if (info.labelJc) {
      const lbl = Array.from(p.querySelectorAll<HTMLElement>(".lbl")).find((l) => own(l, p));
      if (lbl) {
        const w = lbl.getBoundingClientRect().width;
        lbl.style.marginLeft = `${-(info.labelJc === "center" ? w / 2 : w)}px`;
      }
    }
    if (!tabs.length) continue;
    const pr = p.getBoundingClientRect();
    // Tab positions count from the column edge, where a zero indent would start.
    const origin = pr.left - info.indLeft / PX;
    const stops: TabStop[] = info.tabs.filter((t) => t.val !== "clear" && t.val !== "bar").slice();
    if (info.indFirst < 0 && !stops.some((s) => Math.abs(s.pos - info.indLeft) < 0.5)) stops.push({ pos: info.indLeft, val: "left" });
    stops.sort((a, b) => a.pos - b.pos);
    tabs.forEach((t, i) => {
      t.style.width = "0px";
      const r = t.getBoundingClientRect();
      const x = (r.left - origin) * PX;
      let stop: TabStop | undefined;
      const ptab = t.dataset.ptab;
      if (ptab) {
        const width = colWidth;
        stop = { pos: ptab === "center" ? width / 2 : ptab === "right" ? width : 0, val: ptab, leader: t.dataset.lead };
      } else {
        stop = stops.find((s) => s.pos > x + 0.05);
        if (!stop) {
          const pos = (Math.floor(x / defaultTab + 1e-6) + 1) * defaultTab;
          stop = { pos, val: "left" };
        }
      }
      let width = Math.max(0, stop.pos - x);
      if (stop.val === "right" || stop.val === "end" || stop.val === "center" || stop.val === "decimal") {
        // The text after the tab (up to the next tab) on this line.
        const range = doc.createRange();
        range.setStartAfter(t);
        const next = tabs[i + 1];
        if (next) range.setEndBefore(next);
        else range.setEnd(p, p.childNodes.length);
        let follow = 0;
        if (stop.val === "decimal") {
          follow = decimalWidth(range, doc);
        } else {
          for (const rr of Array.from(range.getClientRects())) if (Math.abs(rr.top - r.top) < 3 || (rr.top <= r.top + 1 && rr.bottom >= r.bottom - 1)) follow = Math.max(follow, rr.right - r.left);
        }
        const f = follow * PX;
        width = stop.val === "center" ? Math.max(0, stop.pos - x - f / 2) : Math.max(0, stop.pos - x - f);
      }
      t.style.width = `${width / PX}px`;
      if (stop.leader && stop.leader !== "none") t.dataset.lead = stop.leader;
    });
  }
}

/** Width of the text after a decimal tab up to its decimal point. */
function decimalWidth(range: Range, doc: Document): number {
  const text = range.toString();
  const dot = text.search(/[.,](?=\d)|[.,]$/);
  if (dot < 0) {
    const rects = Array.from(range.getClientRects());
    return rects.length ? rects[rects.length - 1].right - rects[0].left : 0;
  }
  // Walk to the text node holding the point.
  const walker = doc.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  let count = 0;
  let node: Node | null = walker.currentNode.nodeType === Node.TEXT_NODE ? walker.currentNode : walker.nextNode();
  const startRect = range.getBoundingClientRect();
  while (node) {
    if (range.intersectsNode(node)) {
      const t = node.textContent ?? "";
      const startOff = node === range.startContainer ? range.startOffset : 0;
      const len = t.length - startOff;
      if (count + len > dot) {
        const r = doc.createRange();
        r.setStart(node, startOff + (dot - count));
        r.setEnd(node, startOff + (dot - count));
        return r.getBoundingClientRect().left - startRect.left;
      }
      count += len;
    }
    node = walker.nextNode();
  }
  return startRect.width;
}

export function measure(root: HTMLElement, gen: HtmlGen, baseOff: number[]): Measured {
  const doc = root.ownerDocument;
  const rr = root.getBoundingClientRect();
  const ox = rr.left;
  const oy = rr.top;
  const box = (r: DOMRect) => ({ x: (r.left - ox) * PX, y: (r.top - oy) * PX, w: r.width * PX, h: r.height * PX });
  const m: Measured = { root, width: rr.width * PX, height: rr.height * PX, segs: [], tabs: [], boxes: [], draws: [], anchors: [], bookmarks: [], notes: [], fields: [], blocks: [], hard: [], paraTop: new Map() };
  const range = doc.createRange();
  const pOf = (el: Element) => Number((el.closest("div.p") as HTMLElement | null)?.dataset.p ?? -1);

  // Text.
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const span = n.parentElement;
    if (!span || !span.classList.contains("r")) continue;
    const s = Number(span.dataset.s);
    const off = baseOff[s] ?? 0;
    const text = n.textContent ?? "";
    const p = pOf(span);
    const re = /\s+|\S+/g;
    for (let mt = re.exec(text); mt; mt = re.exec(text)) {
      const chunk = mt[0];
      const space = /^\s+$/.test(chunk) && chunk !== "\u200b";
      range.setStart(n, mt.index);
      range.setEnd(n, mt.index + chunk.length);
      const rects = Array.from(range.getClientRects()).filter((q) => q.height > 0);
      if (rects.length <= 1) {
        const q = rects[0] ?? range.getBoundingClientRect();
        const b = box(q);
        m.segs.push({ text: chunk, ...b, base: b.y + off, s, space, p });
        continue;
      }
      // A word broken across lines: measure it letter by letter.
      let cur: { text: string; r: DOMRect } | null = null;
      for (let i = 0; i < chunk.length; i++) {
        range.setStart(n, mt.index + i);
        range.setEnd(n, mt.index + i + 1);
        const q = range.getBoundingClientRect();
        if (cur && Math.abs(q.top - cur.r.top) < 2) {
          cur = { text: cur.text + chunk[i], r: new DOMRect(cur.r.left, cur.r.top, q.right - cur.r.left, cur.r.height) };
        } else {
          if (cur) {
            const b = box(cur.r);
            m.segs.push({ text: cur.text, ...b, base: b.y + off, s, space, p });
          }
          cur = { text: chunk[i], r: q };
        }
      }
      if (cur) {
        const b = box(cur.r);
        m.segs.push({ text: cur.text, ...b, base: b.y + off, s, space, p });
      }
    }
  }

  // Tabs (their leaders are drawn), fields, notes, markers.
  for (const t of Array.from(root.querySelectorAll<HTMLElement>(".tb"))) {
    const b = box(t.getBoundingClientRect());
    const s = t.dataset.s ? Number(t.dataset.s) : -1;
    if (b.w > 0.1) m.tabs.push({ x: b.x, y: b.y, w: b.w, base: b.y, s, leader: t.dataset.lead });
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-fld]"))) m.fields.push({ el, field: el.dataset.fld!, format: el.dataset.fmt });
  // Footnote references (endnotes gather at the end of the document instead).
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-note^="footnote:"]'))) {
    const b = box(el.getBoundingClientRect());
    m.notes.push({ x: b.x, y: b.y + b.h / 2, name: el.dataset.note!, p: pOf(el) });
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".bm"))) {
    const b = box(el.getBoundingClientRect());
    m.bookmarks.push({ x: b.x, y: b.y, name: el.dataset.bm!, p: pOf(el) });
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".a"))) {
    const b = box(el.getBoundingClientRect());
    m.anchors.push({ x: b.x, y: b.y, name: el.dataset.a!, p: pOf(el) });
  }
  // Boxes: table cells, bordered or shaded paragraph groups.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-x]"))) {
    const info = gen.boxes[Number(el.dataset.x)];
    if (!info || info.kind === "table") continue;
    if (!info.fill && !info.borders) continue;
    m.boxes.push({ ...box(el.getBoundingClientRect()), info });
  }
  // Drawings in the flow (inline, floating, between lines).
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".d"))) {
    const b = box(el.getBoundingClientRect());
    m.draws.push({ ...b, d: Number(el.dataset.d), link: el.dataset.l ? Number(el.dataset.l) : undefined });
    const info = gen.draws[Number(el.dataset.d)];
    if (info && info.mode !== "inline") m.hard.push({ top: b.y, bottom: b.y + b.h });
  }
  m.blocks = blockTree(root, root, gen, m, box);
  // A bookmark marks the top of its line (its marker sits on the baseline), so links and
  // outline entries that go to it show the whole line.
  const linesOf = new Map<number, Line[]>();
  const walk = (bs: MBlock[]) => {
    for (const b of bs) {
      if (b.kind === "p") linesOf.set(b.idx, b.lines);
      else if (b.kind === "group") walk(b.children);
      else if (b.kind === "table") for (const r of b.rows) for (const c of r.cells) walk(c.blocks);
    }
  };
  walk(m.blocks);
  for (const bm of m.bookmarks) {
    const line = linesOf.get(bm.p)?.find((l) => bm.y >= l.top - 0.01 && bm.y <= l.bottom + 0.01);
    if (line) bm.y = line.top;
  }
  return m;
}

/** Lines of a paragraph: its words grouped by baseline, as bands that tile the paragraph. */
function paraLines(p: HTMLElement, idx: number, m: Measured, gen: HtmlGen, top: number, bottom: number, box: (r: DOMRect) => { x: number; y: number; w: number; h: number }): Line[] {
  const items: { top: number; bottom: number; key: number }[] = [];
  for (const s of m.segs) {
    if (s.p !== idx) continue;
    const shift = gen.spans[s.s]?.shift ?? 0;
    items.push({ top: s.y, bottom: s.y + s.h, key: s.base + shift });
  }
  for (const el of Array.from(p.querySelectorAll<HTMLElement>(".d"))) {
    if (el.closest("div.p") !== p) continue;
    const info = gen.draws[Number(el.dataset.d)];
    if (info?.mode !== "inline") continue;
    const b = box(el.getBoundingClientRect());
    items.push({ top: b.y, bottom: b.y + b.h, key: b.y + b.h });
  }
  items.sort((a, b) => a.key - b.key);
  const lines: { top: number; bottom: number; key: number }[] = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    // Same line: same baseline, or overlapping boxes with a nearby baseline.
    if (last && (Math.abs(it.key - last.key) < 1.2 || (it.top < last.bottom - 2 && Math.abs(it.key - last.key) < Math.max(4, (last.bottom - last.top) * 0.5)))) {
      last.top = Math.min(last.top, it.top);
      last.bottom = Math.max(last.bottom, it.bottom);
      last.key = Math.max(last.key, it.key);
    } else lines.push({ ...it });
  }
  if (!lines.length) return [{ top, bottom }];
  // Tile the paragraph: each boundary halfway between neighbouring lines.
  const out: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = i === 0 ? top : (lines[i - 1].bottom + lines[i].top) / 2;
    const b = i === lines.length - 1 ? bottom : (lines[i].bottom + lines[i + 1].top) / 2;
    out.push({ top: t, bottom: Math.max(t, b) });
  }
  return out;
}

function blockTree(container: Element, root: HTMLElement, gen: HtmlGen, m: Measured, box: (r: DOMRect) => { x: number; y: number; w: number; h: number }): MBlock[] {
  const out: MBlock[] = [];
  for (const el of Array.from(container.children) as HTMLElement[]) {
    if (el.matches("div.p")) {
      const b = box(el.getBoundingClientRect());
      const idx = Number(el.dataset.p);
      m.paraTop.set(idx, b.y);
      out.push({ kind: "p", idx, top: b.y, bottom: b.y + b.h, lines: paraLines(el, idx, m, gen, b.y, b.y + b.h, box), info: gen.paras[idx] });
    } else if (el.matches("div.bx")) {
      const b = box(el.getBoundingClientRect());
      out.push({ kind: "group", top: b.y, bottom: b.y + b.h, children: blockTree(el, root, gen, m, box) });
    } else if (el.matches("table.t")) {
      const b = box(el.getBoundingClientRect());
      const rows: MRow[] = [];
      for (const tr of Array.from(el.querySelectorAll<HTMLElement>(":scope > tbody > tr, :scope > tr"))) {
        const rb = box(tr.getBoundingClientRect());
        const info = gen.boxes[Number(tr.dataset.r)];
        const cells: MRow["cells"] = [];
        for (const td of Array.from(tr.children) as HTMLElement[]) {
          const cb = box(td.getBoundingClientRect());
          const flow = td.querySelector(":scope > .flow") ?? td;
          cells.push({ top: cb.y, bottom: cb.y + cb.h, blocks: blockTree(flow, root, gen, m, box) });
        }
        rows.push({ top: rb.y, bottom: rb.y + rb.h, header: !!info?.header, cantSplit: !!info?.cantSplit, cells });
      }
      out.push({ kind: "table", top: b.y, bottom: b.y + b.h, rows });
    } else if (el.matches(".d")) {
      const b = box(el.getBoundingClientRect());
      out.push({ kind: "draw", top: b.y, bottom: b.y + b.h });
    } else if (el.children.length) {
      out.push(...blockTree(el, root, gen, m, box));
    }
  }
  return out;
}
