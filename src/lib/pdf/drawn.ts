/**
 * Charts and drawings made of shapes rather than pictures: the bars, axes, slices and lines of a
 * chart with its labels, a logo drawn as outlines. Conversions that reflow a page (Word, HTML)
 * show each as a picture of its part of the page, in place of loose labels that only make sense
 * over the drawing.
 *
 * Shapes that belong to the text (boxes around it, shading behind it, rules under it, bullets
 * and check boxes before it, the cells of a table) are left alone. What remains are shapes that
 * stand on their own: filled boxes with nothing written in them (bars), slanted or curved shapes
 * (lines, slices, arrows, dots), and the lines that join them (axes, grid lines, a frame). Shapes
 * that touch, or bars that stand side by side on one line, make up one drawing; one of at least
 * three such shapes, of some size, is a figure. Short text in it or right beside it (values,
 * names, an axis title, the chart's own title) goes with it; a drawing with running text inside
 * it is not a figure.
 */
import type { Pic, Shape, TextItem } from "./pdfjs";

type Rect = { x: number; y: number; w: number; h: number };

/** A figure: the picture standing for it (its place on the page) and the page it is on (from 0). */
export type DrawnFigure = { pic: Pic; page: number };

const lum = (hex?: string) => {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return 0;
  const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const white = (c?: string) => !!c && lum(c) > 0.985;
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const boxOf = (rs: Rect[]): Rect => rs.reduce(union);
/** Space between two boxes (0 where they touch or overlap): the larger of the gaps across and down. */
const gapOf = (a: Rect, b: Rect) => Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w), Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const within = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const midOf = (it: TextItem): [number, number] => [it.bbox.x + it.bbox.w / 2, it.bbox.y + it.bbox.h / 2];
const plain = (s: Shape) => !s.slant && !s.round;

/** Two cells of a table sharing an edge. */
function sideBySide(a: Rect, b: Rect): boolean {
  const vo = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const ho = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  return ((Math.abs(a.x + a.w - b.x) < 2 || Math.abs(b.x + b.w - a.x) < 2) && vo > Math.min(a.h, b.h) * 0.5) || ((Math.abs(a.y + a.h - b.y) < 2 || Math.abs(b.y + b.h - a.y) < 2) && ho > Math.min(a.w, b.w) * 0.5);
}

/**
 * Bars of one chart with no axis drawn: standing on one line with one width, or running from one
 * edge with one thickness, at most a few widths apart.
 */
function bars(a: Shape, b: Shape): boolean {
  if (!plain(a) || !plain(b) || !a.fill || !b.fill) return false;
  const up = Math.abs(a.y + a.h - (b.y + b.h)) <= 1 && Math.abs(a.w - b.w) <= Math.max(a.w, b.w) * 0.25 && Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w) <= Math.max(a.w, b.w) * 3.5;
  const across = Math.abs(a.x - b.x) <= 1 && Math.abs(a.h - b.h) <= Math.max(a.h, b.h) * 0.25 && Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h) <= Math.max(a.h, b.h) * 3.5;
  return up || across;
}

/** FNV-1a: the same drawing on several pages (a logo in the letterhead) gets one name. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * The figures drawn on one page. `items`: all its text, in any direction (an axis title runs up
 * the page); `pics`: its pictures, which a figure doesn't take over. Returns the figures with
 * the text and shapes they take in.
 */
export function drawnFigures(
  page: { page: number; width: number; height: number },
  items: TextItem[],
  shapes: Shape[],
  pics: Rect[] = [],
): { figures: DrawnFigure[]; text: Set<TextItem>; shapes: Set<Shape>; keys: { shape: Shape; before: TextItem }[] } {
  const out = { figures: [] as DrawnFigure[], text: new Set<TextItem>(), shapes: new Set<Shape>(), keys: [] as { shape: Shape; before: TextItem }[] };
  if (shapes.length < 3 || shapes.length > 2500) return out;
  const area = page.width * page.height;
  const text = items.filter((it) => it.str.trim());
  const holds = (s: Rect) => text.some((it) => within(s, ...midOf(it)));
  /** The text a small mark stands just before, on its line: a bullet's, a check box's, a legend key's. */
  const textAfter = (s: Shape) =>
    text
      .filter((it) => it.dir === 0 && Math.min(s.y + s.h, it.bbox.y + it.bbox.h) - Math.max(s.y, it.bbox.y) > Math.min(s.h, it.bbox.h) * 0.4 && it.x >= s.x + s.w - 1 && it.x - (s.x + s.w) < it.fontSize * 2.5)
      .sort((a, b) => a.x - b.x)[0];
  // Boxes with text in them (cells, callouts, badges): an empty box against one is an empty cell.
  const full = shapes.filter((s) => s.fill && !white(s.fill) && plain(s) && s.w >= 6 && s.h >= 6 && holds(s));
  const kind = new Map<Shape, "own" | "join">();
  // Bars with their values written in them: three or more boxes of one width standing on one
  // line (or of one thickness running from one edge), of clearly different lengths, each with
  // a figure or a word or two in it. Cells of a table line up too, but keep one size along a row.
  const labelled = new Set<Shape>();
  const boxes = shapes.filter((s) => s.fill && !white(s.fill) && plain(s) && s.w >= 4 && s.h >= 4 && s.w * s.h <= area * 0.5 && text.filter((it) => within(s, ...midOf(it))).every((it) => it.str.trim().length <= 8));
  for (const s of boxes) {
    if (labelled.has(s)) continue;
    for (const up of [true, false]) {
      const row = boxes.filter((o) => (up ? Math.abs(o.y + o.h - (s.y + s.h)) <= 1 && Math.abs(o.w - s.w) <= s.w * 0.25 : Math.abs(o.x - s.x) <= 1 && Math.abs(o.h - s.h) <= s.h * 0.25));
      const lengths = row.map((o) => (up ? o.h : o.w));
      if (row.length >= 3 && Math.max(...lengths) >= Math.min(...lengths) * 1.25) for (const o of row) labelled.add(o);
    }
  }
  for (const s of shapes) {
    if (s.w * s.h > area * 0.5) continue;
    const fill = s.fill && !white(s.fill) ? s.fill : undefined;
    const stroke = s.stroke && !white(s.stroke) ? s.stroke : undefined;
    if (!fill && !stroke) continue;
    // Thin straight lines join shapes (axes, grid lines); they make no figure by themselves.
    if (plain(s) && ((s.h <= 3.2 && s.w >= 6) || (s.w <= 3.2 && s.h >= 6))) {
      kind.set(s, "join");
      continue;
    }
    if (s.w < 1.5 && s.h < 1.5) continue;
    // A box with text in it (a callout, a cell, a badge) holds the text; a slanted or curved
    // shape's box says little about what is written in it (a slice of a pie).
    if (plain(s) && !labelled.has(s) && holds(s)) continue;
    // A small mark just before a line's text: a bullet, a check box, a legend's key.
    if (s.w <= 16 && s.h <= 16 && textAfter(s)) continue;
    if (fill && plain(s) && full.some((o) => sideBySide(o, s))) continue;
    // Filled, slanted or curved: a shape of its own. An empty frame only joins others.
    kind.set(s, fill || !plain(s) ? "own" : "join");
  }
  const nodes = [...kind.keys()];
  if (nodes.length < 3) return out;
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const [a, b] = [nodes[i], nodes[j]];
      const d = gapOf(a, b);
      const own = kind.get(a) === "own" && kind.get(b) === "own";
      if (own ? d <= 3 || bars(a, b) : d <= 1.5) parent[find(i)] = find(j);
    }
  const groups = new Map<number, Shape[]>();
  nodes.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]));

  const sizes = text.filter((it) => it.dir === 0).map((it) => it.fontSize).sort((a, b) => a - b);
  const pageSize = sizes.length ? sizes[sizes.length >> 1] : 11;
  // Labels are short: a value, a name, an axis title, a chart's title.
  const short = (it: TextItem) => it.str.trim().length <= 40 && it.str.trim().split(/\s+/).length <= 6;
  const taken = new Set<TextItem>();
  const done: Rect[] = [];
  const colours = new Set<string>();
  for (const g of groups.values()) {
    const own = g.filter((s) => kind.get(s) === "own");
    const curved = own.some((s) => !plain(s));
    // A box's fill and border drawn as separate shapes are one shape; boxes all of one size with
    // nothing in them (cards cut off by the page, frames to fill in) are no chart.
    const distinct = own.filter((s, i) => !own.slice(0, i).some((o) => Math.abs(o.x - s.x) < 2 && Math.abs(o.y - s.y) < 2 && Math.abs(o.w - s.w) < 2 && Math.abs(o.h - s.h) < 2));
    if (!distinct.length || (distinct.length < 3 && !(curved && g.length >= 4))) continue;
    if (!curved && distinct.every((s) => Math.abs(s.w - distinct[0].w) < 2 && Math.abs(s.h - distinct[0].h) < 2)) continue;
    const box = boxOf(g);
    if (box.w < 36 || box.h < 24 || box.w * box.h < 1800 || box.w * box.h > area * 0.8) continue;
    // Shapes drawn over a picture belong to the picture; shapes inside a figure already found, to that figure.
    if (pics.some((p) => overlap(p, box) > Math.min(p.w * p.h, box.w * box.h) * 0.3) || done.some((f) => overlap(f, box) > box.w * box.h * 0.5)) continue;
    // Its labels: short text inside it, then short text right beside it, no larger than the text already in.
    let region = box;
    const mine = new Set<TextItem>();
    const inner = text.filter((it) => !taken.has(it) && within(box, ...midOf(it)));
    if (inner.some((it) => !short(it))) continue;
    for (const it of inner) {
      mine.add(it);
      region = union(region, it.bbox);
    }
    for (let round = 0; round < 3; round++) {
      const ref = mine.size ? Math.max(...[...mine].map((it) => it.fontSize)) : pageSize;
      let grew = false;
      for (const it of text) {
        if (mine.has(it) || taken.has(it) || !short(it) || it.fontSize > ref * 1.2 + 0.5) continue;
        const b = it.bbox;
        const across = Math.min(b.x + b.w, region.x + region.w) - Math.max(b.x, region.x) > Math.min(b.w, region.w) * 0.5;
        const down = Math.min(b.y + b.h, region.y + region.h) - Math.max(b.y, region.y) > Math.min(b.h, region.h) * 0.5;
        const dx = Math.max(region.x - (b.x + b.w), b.x - (region.x + region.w));
        const dy = Math.max(region.y - (b.y + b.h), b.y - (region.y + region.h));
        if ((across && dy <= it.fontSize * 1.2) || (down && dx <= it.fontSize * 1.5) || within(region, ...midOf(it))) {
          mine.add(it);
          region = union(region, b);
          grew = true;
        }
      }
      if (!grew) break;
    }
    const pad = 3;
    const x = Math.max(0, region.x - pad);
    const y = Math.max(0, region.y - pad);
    const fig: Rect = { x, y, w: Math.min(page.width, region.x + region.w + pad) - x, h: Math.min(page.height, region.y + region.h + pad) - y };
    // Running text under it, or a figure already there: not a figure after all.
    if (text.some((it) => !mine.has(it) && within(fig, ...midOf(it)) && (!short(it) || taken.has(it)))) continue;
    const foreign = text.filter((it) => !mine.has(it) && within(fig, ...midOf(it)));
    for (const it of [...mine, ...foreign]) taken.add(it);
    const inside = shapes.filter((s) => s.w * s.h <= area * 0.5 && within(fig, s.x + s.w / 2, s.y + s.h / 2) && overlap(s, fig) >= s.w * s.h * 0.6);
    const sig = [
      ...inside.map((s) => `${Math.round(s.x - fig.x)},${Math.round(s.y - fig.y)},${Math.round(s.w)},${Math.round(s.h)},${s.fill ?? ""},${s.stroke ?? ""}`),
      ...[...mine].map((it) => `${it.str}@${Math.round(it.bbox.x - fig.x)},${Math.round(it.bbox.y - fig.y)}`),
    ]
      .sort()
      .join(";");
    for (const s of inside) out.shapes.add(s);
    for (const it of taken) out.text.add(it);
    done.push(fig);
    for (const s of own) if (s.fill) colours.add(s.fill);
    out.figures.push({ page: page.page, pic: { id: `draw-${hash(`${Math.round(fig.w)}x${Math.round(fig.h)};${sig}`)}`, ...fig, ow: fig.w, oh: fig.h, rot: 0, flip: false } });
  }
  // A legend set apart from its chart: keys in the colours of the chart's shapes, each before its name.
  for (const s of shapes) {
    if (!out.figures.length || out.shapes.has(s) || !s.fill || !colours.has(s.fill) || s.w > 16 || s.h > 16 || s.w < 3 || s.h < 3 || Math.abs(s.w - s.h) > Math.max(s.w, s.h) * 0.3) continue;
    const before = textAfter(s);
    if (before && !out.text.has(before)) out.keys.push({ shape: s, before });
  }
  return out;
}
