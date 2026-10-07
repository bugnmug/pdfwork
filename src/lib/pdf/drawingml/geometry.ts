/**
 * DrawingML shape geometry: the 187 preset shapes and custom geometry,
 * evaluated the way Office does (the guide formulas of ECMA-376 20.1.9),
 * into plain paths of lines and cubic Béziers in the shape's own box, y down.
 */
import { PRESETS } from "./presets";

export type Seg = { t: "M" | "L"; x: number; y: number } | { t: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number } | { t: "Z" };
export type PathFill = "none" | "norm" | "lighten" | "lightenLess" | "darken" | "darkenLess";
export type GeomPath = { segs: Seg[]; fill: PathFill; stroke: boolean };
export type Rect = { l: number; t: number; r: number; b: number };
export type Geometry = { paths: GeomPath[]; text: Rect };

type Cmd = { op: string; args: string[] };
type PathDef = { w: number; h: number; fill: PathFill; stroke: boolean; cmds: Cmd[] };
type Def = { av: [string, string][]; gd: [string, string][]; rect: string[] | null; paths: PathDef[] };

const EMU = 12700;
const DEG = 60000;
const toRad = (a: number) => (a / DEG) * (Math.PI / 180);

const pairs = (s: string): [string, string][] =>
  s
    ? s.split(";").map((p) => {
        const i = p.indexOf("=");
        return [p.slice(0, i), p.slice(i + 1)];
      })
    : [];

function parseCmds(s: string): Cmd[] {
  const toks = s.split(" ").filter(Boolean);
  const out: Cmd[] = [];
  const arity: Record<string, number> = { M: 2, L: 2, A: 4, Q: 4, C: 6, Z: 0 };
  for (let i = 0; i < toks.length; ) {
    const op = toks[i++];
    const n = arity[op] ?? 0;
    out.push({ op, args: toks.slice(i, i + n) });
    i += n;
  }
  return out;
}

const parsed = new Map<string, Def | null>();

function presetDef(name: string): Def | null {
  if (parsed.has(name)) return parsed.get(name)!;
  const src = PRESETS[name];
  let def: Def | null = null;
  if (src) {
    const [av, gd, rect, ...paths] = src.split("|");
    def = {
      av: pairs(av),
      gd: pairs(gd),
      rect: rect ? rect.split(" ") : null,
      paths: paths.map((p) => {
        const [head, body] = p.split("~");
        const [w, h, fill, stroke] = head.split(" ");
        return { w: Number(w), h: Number(h), fill: fill as PathFill, stroke: stroke === "1", cmds: parseCmds(body) };
      }),
    };
  }
  parsed.set(name, def);
  return def;
}

export const hasPreset = (name: string) => !!PRESETS[name];

/** Guide formulas: each one sees the built-ins, the adjust values and earlier guides. */
class Guides {
  v = new Map<string, number>();
  constructor(w: number, h: number) {
    const ss = Math.min(w, h);
    const set = (k: string, x: number) => this.v.set(k, x);
    set("w", w);
    set("h", h);
    set("l", 0);
    set("t", 0);
    set("r", w);
    set("b", h);
    set("hc", w / 2);
    set("vc", h / 2);
    set("ss", ss);
    set("ls", Math.max(w, h));
    for (const n of [2, 3, 4, 5, 6, 8, 10, 12, 16, 32]) {
      set(`wd${n}`, w / n);
      set(`hd${n}`, h / n);
      set(`ssd${n}`, ss / n);
    }
    set("cd2", 10800000);
    set("cd4", 5400000);
    set("cd8", 2700000);
    set("3cd4", 16200000);
    set("3cd8", 8100000);
    set("5cd8", 13500000);
    set("7cd8", 18900000);
  }
  get(tok: string): number {
    const hit = this.v.get(tok);
    if (hit !== undefined) return hit;
    const n = Number(tok);
    return Number.isFinite(n) ? n : 0;
  }
  eval(fmla: string): number {
    const [op, ...rest] = fmla.split(" ").filter(Boolean);
    const [x, y, z] = rest.map((t) => this.get(t));
    let r: number;
    switch (op) {
      case "val":
        r = x;
        break;
      case "*/":
        r = z ? (x * y) / z : 0;
        break;
      case "+-":
        r = x + y - z;
        break;
      case "+/":
        r = z ? (x + y) / z : 0;
        break;
      case "?:":
        r = x > 0 ? y : z;
        break;
      case "abs":
        r = Math.abs(x);
        break;
      case "at2":
        r = (Math.atan2(y, x) * 180 * DEG) / Math.PI;
        break;
      case "cat2":
        r = x * Math.cos(Math.atan2(z, y));
        break;
      case "sat2":
        r = x * Math.sin(Math.atan2(z, y));
        break;
      case "cos":
        r = x * Math.cos(toRad(y));
        break;
      case "sin":
        r = x * Math.sin(toRad(y));
        break;
      case "tan":
        r = x * Math.tan(toRad(y));
        break;
      case "max":
        r = Math.max(x, y);
        break;
      case "min":
        r = Math.min(x, y);
        break;
      case "mod":
        r = Math.sqrt(x * x + y * y + z * z);
        break;
      case "pin":
        r = y < x ? x : y > z ? z : y;
        break;
      case "sqrt":
        r = Math.sqrt(Math.max(0, x));
        break;
      default:
        r = 0;
    }
    return Number.isFinite(r) ? r : 0;
  }
}

/**
 * An elliptical arc as DrawingML defines it: starting at the current point, which sits
 * at angle stAng on an ellipse of radii (rx, ry), sweeping swAng. The angles are the
 * visual ones (from the centre), not the ellipse's parameter, so they are converted.
 */
function arc(segs: Seg[], cur: { x: number; y: number }, rx: number, ry: number, stAng: number, swAng: number): { x: number; y: number } {
  if (rx <= 0 || ry <= 0 || !swAng) return cur;
  const param = (a: number) => {
    // Parameter t with the point (rx cos t, ry sin t) at visual angle a.
    const r = toRad(a);
    return Math.atan2(rx * Math.sin(r), ry * Math.cos(r));
  };
  const t0 = param(stAng);
  const t1 = param(stAng + swAng);
  // The parameter sweep keeps the visual sweep's direction and whole turns.
  const TAU = 2 * Math.PI;
  const sign = swAng > 0 ? 1 : -1;
  const full = Math.floor(Math.abs(toRad(swAng)) / TAU + 1e-9);
  let rest = sign > 0 ? (((t1 - t0) % TAU) + TAU) % TAU : -((((t0 - t1) % TAU) + TAU) % TAU);
  if (Math.abs(Math.abs(rest) - TAU) < 1e-9) rest = full ? 0 : sign * TAU;
  const total = sign * full * TAU + rest;
  if (!total) return cur;
  const cx = cur.x - rx * Math.cos(t0);
  const cy = cur.y - ry * Math.sin(t0);
  const n = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2) - 1e-9));
  const d = total / n;
  const k = (4 / 3) * Math.tan(d / 4);
  let a = t0;
  let x = cur.x;
  let y = cur.y;
  for (let i = 0; i < n; i++) {
    const b = a + d;
    const x2 = cx + rx * Math.cos(b);
    const y2 = cy + ry * Math.sin(b);
    segs.push({
      t: "C",
      x1: x - k * rx * Math.sin(a),
      y1: y + k * ry * Math.cos(a),
      x2: x2 + k * rx * Math.sin(b),
      y2: y2 - k * ry * Math.cos(b),
      x: x2,
      y: y2,
    });
    x = x2;
    y = y2;
    a = b;
  }
  return { x, y };
}

function build(def: Def, w: number, h: number, adj: Record<string, string> = {}): Geometry {
  // Evaluated in EMU, as the formulas were written for; returned in points.
  const W = w * EMU;
  const H = h * EMU;
  const g = new Guides(W, H);
  for (const [name, fmla] of def.av) g.v.set(name, g.eval(adj[name] ?? fmla));
  for (const [name, fmla] of Object.entries(adj)) if (!g.v.has(name)) g.v.set(name, g.eval(fmla));
  for (const [name, fmla] of def.gd) g.v.set(name, g.eval(fmla));
  const paths: GeomPath[] = [];
  for (const p of def.paths) {
    const sx = p.w > 0 ? W / p.w : 1;
    const sy = p.h > 0 ? H / p.h : 1;
    // Work in the path's own coordinates (arcs are defined there), scale on output.
    const raw: Seg[] = [];
    let cur = { x: 0, y: 0 };
    let start = { x: 0, y: 0 };
    let open = false;
    const ensure = () => {
      if (!open) {
        raw.push({ t: "M", x: cur.x, y: cur.y });
        start = { ...cur };
        open = true;
      }
    };
    for (const c of p.cmds) {
      const a = c.args.map((t) => g.get(t));
      switch (c.op) {
        case "M":
          cur = { x: a[0], y: a[1] };
          start = { ...cur };
          raw.push({ t: "M", x: cur.x, y: cur.y });
          open = true;
          break;
        case "L":
          ensure();
          cur = { x: a[0], y: a[1] };
          raw.push({ t: "L", x: cur.x, y: cur.y });
          break;
        case "A":
          ensure();
          cur = arc(raw, cur, a[0], a[1], a[2], a[3]);
          break;
        case "Q": {
          ensure();
          const [qx, qy, x, y] = a;
          raw.push({ t: "C", x1: cur.x + ((qx - cur.x) * 2) / 3, y1: cur.y + ((qy - cur.y) * 2) / 3, x2: x + ((qx - x) * 2) / 3, y2: y + ((qy - y) * 2) / 3, x, y });
          cur = { x, y };
          break;
        }
        case "C":
          ensure();
          raw.push({ t: "C", x1: a[0], y1: a[1], x2: a[2], y2: a[3], x: a[4], y: a[5] });
          cur = { x: a[4], y: a[5] };
          break;
        case "Z":
          if (open) raw.push({ t: "Z" });
          cur = { ...start };
          open = false;
          break;
      }
    }
    const fx = sx / EMU;
    const fy = sy / EMU;
    const segs: Seg[] = raw.map((s) =>
      s.t === "Z" ? s : s.t === "C" ? { t: "C", x1: s.x1 * fx, y1: s.y1 * fy, x2: s.x2 * fx, y2: s.y2 * fy, x: s.x * fx, y: s.y * fy } : { t: s.t, x: s.x * fx, y: s.y * fy },
    );
    paths.push({ segs, fill: p.fill, stroke: p.stroke });
  }
  const rect = def.rect ? def.rect.map((t) => g.get(t) / EMU) : [0, 0, w, h];
  return { paths, text: { l: rect[0], t: rect[1], r: rect[2], b: rect[3] } };
}

/** Adjust values from a:avLst (name to formula, normally "val n"). */
export function adjustValues(avLst: Element | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const gd of Array.from(avLst?.children ?? [])) {
    const n = gd.getAttribute("name");
    const f = gd.getAttribute("fmla");
    if (n && f) out[n] = f;
  }
  return out;
}

export function presetGeometry(name: string, w: number, h: number, adj?: Record<string, string>): Geometry | null {
  const def = presetDef(name);
  return def ? build(def, w, h, adj) : null;
}

const local = (el: Element | null | undefined, name: string): Element | null => {
  for (const c of Array.from(el?.children ?? [])) if (c.localName === name) return c;
  return null;
};

/** a:custGeom: the same guide language, written inline. */
export function customGeometry(cg: Element, w: number, h: number): Geometry {
  const gdList = (el: Element | null): [string, string][] => Array.from(el?.children ?? []).filter((g) => g.localName === "gd").map((g) => [g.getAttribute("name") ?? "", g.getAttribute("fmla") ?? "val 0"]);
  const rectEl = local(cg, "rect");
  const paths: PathDef[] = [];
  for (const p of Array.from(local(cg, "pathLst")?.children ?? [])) {
    if (p.localName !== "path") continue;
    const cmds: Cmd[] = [];
    for (const c of Array.from(p.children)) {
      const pts = Array.from(c.children).filter((q) => q.localName === "pt").flatMap((q) => [q.getAttribute("x") ?? "0", q.getAttribute("y") ?? "0"]);
      switch (c.localName) {
        case "moveTo":
          cmds.push({ op: "M", args: pts.slice(0, 2) });
          break;
        case "lnTo":
          cmds.push({ op: "L", args: pts.slice(0, 2) });
          break;
        case "arcTo":
          cmds.push({ op: "A", args: ["wR", "hR", "stAng", "swAng"].map((k) => c.getAttribute(k) ?? "0") });
          break;
        case "quadBezTo":
          cmds.push({ op: "Q", args: pts.slice(0, 4) });
          break;
        case "cubicBezTo":
          cmds.push({ op: "C", args: pts.slice(0, 6) });
          break;
        case "close":
          cmds.push({ op: "Z", args: [] });
          break;
      }
    }
    const stroke = p.getAttribute("stroke");
    paths.push({ w: Number(p.getAttribute("w") ?? 0) || 0, h: Number(p.getAttribute("h") ?? 0) || 0, fill: (p.getAttribute("fill") as PathFill) || "norm", stroke: !(stroke === "0" || stroke === "false"), cmds });
  }
  const def: Def = {
    av: gdList(local(cg, "avLst")),
    gd: gdList(local(cg, "gdLst")),
    rect: rectEl ? ["l", "t", "r", "b"].map((k) => rectEl.getAttribute(k) ?? (k === "l" || k === "t" ? "0" : k === "r" ? "w" : "h")) : null,
    paths,
  };
  return build(def, w, h);
}

/** The geometry of an spPr: its preset or custom shape, else a rectangle. */
export function shapeGeometry(spPr: Element | null | undefined, w: number, h: number): Geometry {
  const cust = local(spPr, "custGeom");
  if (cust) return customGeometry(cust, w, h);
  const prst = local(spPr, "prstGeom");
  const name = prst?.getAttribute("prst") ?? "rect";
  return presetGeometry(name, w, h, adjustValues(local(prst, "avLst"))) ?? presetGeometry("rect", w, h)!;
}

/** SVG path data for a geometry path (for pdf-lib's drawSvgPath or debugging). */
export function svgPath(segs: Seg[]): string {
  return segs.map((s) => (s.t === "Z" ? "Z" : s.t === "C" ? `C ${s.x1} ${s.y1} ${s.x2} ${s.y2} ${s.x} ${s.y}` : `${s.t} ${s.x} ${s.y}`)).join(" ");
}
