/**
 * Slide text: DrawingML text bodies laid out the way PowerPoint does. Paragraph
 * and run properties are inherited through the list-style chain (shape, layout,
 * master, presentation), lines break at word boundaries inside the text frame's
 * insets, line spacing follows each font's own metrics, bullets and numbering
 * sit on the hanging indent, and autofit shrinks the text when asked to.
 */
import { setCharacterSpacing, setFillingRgbColor, setLineWidth, setStrokingRgbColor, setTextRenderingMode, TextRenderingMode, beginText, endText, setFontAndSize, setTextMatrix, popGraphicsState, pushGraphicsState } from "@cantoo/pdf-lib";
import { attr, kid, kids, num, type El } from "../ooxml";
import { colorIn, readFill, readLine, readShadow, type ColorCtx, type Fill, type Line, type Shadow } from "../drawingml/fill";
import { apply, then, rotate, translate, type Mat, type Pen, type RGBA } from "../drawingml/pen";
import type { TextKit, FontSpec } from "../textkit";
import { scriptOf } from "../docx/fonts";
import { isSymbolFont, mapSymbols } from "../docx/symbols";
import type { Theme } from "../ooxml";

export type Link = { url?: string; slide?: number; jump?: string };
export type Spacing = { pct?: number; pts?: number };

export type RunStyle = {
  size: number;
  bold: boolean;
  italic: boolean;
  u: string;
  strike: string;
  baseline: number;
  cap: string;
  spc: number;
  /** Kerning from this size up (points); 0 for none. */
  kern: number;
  fill?: Fill;
  /** A linked run's own colour, under the hyperlink colour (what its bullet takes). */
  textFill?: Fill;
  ln?: Line;
  highlight?: RGBA;
  shadow?: Shadow;
  latin: string;
  ea: string;
  cs: string;
  sym: string;
  link?: Link;
};

type Bullet = { type: "none" | "char" | "auto" | "blip"; char?: string; scheme?: string; start?: number; blip?: El };
type Tab = { pos: number; algn: string };
export type ParaStyle = {
  algn: string;
  marL: number;
  marR: number;
  indent: number;
  defTab: number;
  tabs: Tab[];
  lnSpc: Spacing;
  spcBef: Spacing;
  spcAft: Spacing;
  bu: Bullet;
  buColor: RGBA | "tx";
  buSize: Spacing | "tx";
  buFont: string;
  def: Partial<RunStyle>;
  rtl: boolean;
};

/** One source in the inheritance chain: a list style (lstStyle, p:bodyStyle...) or a shape's p:style fontRef. */
export type ListSrc = { el?: El | null; fontRef?: { idx: string; color?: RGBA } };

export type TextEnv = {
  kit: TextKit;
  theme: Theme;
  cc: ColorCtx;
  slideNo: number;
  /** Resolve a hyperlink element (a:hlinkClick) to a target. */
  link: (el: El) => Link | undefined;
  /** Picture bullets. */
  bulletImage?: (blip: El) => Promise<{ draw: (pen: Pen, m: Mat) => void; w: number; h: number } | null>;
  /** Called for each run with a link: the run's box in page coordinates. */
  onLink?: (link: Link, quad: [number, number][]) => void;
  date?: Date;
};

export type BodyProps = {
  lIns: number;
  tIns: number;
  rIns: number;
  bIns: number;
  anchor: string;
  anchorCtr: boolean;
  wrap: boolean;
  vert: string;
  rot: number;
  upright: boolean;
  numCol: number;
  spcCol: number;
  autofit: "none" | "norm" | "shape";
  fontScale: number;
  lnSpcReduction: number;
};

/** bodyPr settings merged through the chain (highest priority first). */
export function readBodyProps(chain: (El | null | undefined)[]): BodyProps {
  const get = (name: string) => {
    for (const b of chain) {
      const v = attr(b, name);
      if (v !== null) return v;
    }
    return null;
  };
  const emu = (name: string, d: number) => {
    const v = get(name);
    return v === null ? d : num(v) / 12700;
  };
  let autofit: BodyProps["autofit"] = "none";
  let fontScale = 1;
  let lnSpcReduction = 0;
  for (const b of chain) {
    if (!b) continue;
    const n = kid(b, "normAutofit");
    if (n) {
      autofit = "norm";
      fontScale = num(attr(n, "fontScale"), 100000) / 100000;
      lnSpcReduction = num(attr(n, "lnSpcReduction"), 0) / 100000;
      break;
    }
    if (kid(b, "spAutoFit")) {
      autofit = "shape";
      break;
    }
    if (kid(b, "noAutofit")) break;
  }
  return {
    lIns: emu("lIns", 7.2),
    tIns: emu("tIns", 3.6),
    rIns: emu("rIns", 7.2),
    bIns: emu("bIns", 3.6),
    anchor: get("anchor") ?? "t",
    anchorCtr: get("anchorCtr") === "1",
    wrap: get("wrap") !== "none",
    vert: get("vert") ?? "horz",
    rot: num(get("rot")) / 60000,
    upright: get("upright") === "1",
    numCol: Math.max(1, num(get("numCol"), 1)),
    spcCol: emu("spcCol", 0),
    autofit,
    fontScale,
    lnSpcReduction,
  };
}

/* ------------------------------------------------------------- styles */

const onOff = (v: string | null) => v === "1" || v === "true" || v === "on";

function themeFont(face: string, theme: Theme): string {
  switch (face) {
    case "+mj-lt":
      return theme.major.latin;
    case "+mn-lt":
      return theme.minor.latin;
    case "+mj-ea":
      return theme.major.ea;
    case "+mn-ea":
      return theme.minor.ea;
    case "+mj-cs":
      return theme.major.cs;
    case "+mn-cs":
      return theme.minor.cs;
  }
  return face;
}

function applyRPr(rs: Partial<RunStyle>, el: El | null | undefined, env: TextEnv) {
  if (!el) return;
  const a = (n: string) => attr(el, n);
  if (a("sz") !== null) rs.size = num(a("sz")) / 100;
  if (a("b") !== null) rs.bold = onOff(a("b"));
  if (a("i") !== null) rs.italic = onOff(a("i"));
  if (a("u") !== null) rs.u = a("u")!;
  if (a("strike") !== null) rs.strike = a("strike")!;
  if (a("baseline") !== null) rs.baseline = num(a("baseline")) / 100000;
  if (a("cap") !== null) rs.cap = a("cap")!;
  if (a("spc") !== null) rs.spc = num(a("spc")) / 100;
  if (a("kern") !== null) rs.kern = num(a("kern")) / 100;
  const fill = readFill(el, env.cc);
  if (fill) rs.fill = fill;
  const ln = kid(el, "ln");
  if (ln) rs.ln = readLine(ln, env.cc);
  const hl = kid(el, "highlight");
  if (hl) rs.highlight = colorIn(hl, env.cc) ?? undefined;
  const eff = kid(el, "effectLst");
  if (eff) rs.shadow = readShadow(eff, env.cc);
  for (const k of ["latin", "ea", "cs", "sym"] as const) {
    const f = attr(kid(el, k), "typeface");
    if (f !== null && f !== undefined) rs[k] = f;
  }
  const hk = kid(el, "hlinkClick");
  if (hk) rs.link = env.link(hk);
}

function applyPPr(ps: ParaStyle, el: El | null | undefined, env: TextEnv, withDefRPr: boolean) {
  if (!el) return;
  const a = (n: string) => attr(el, n);
  if (a("algn") !== null) ps.algn = a("algn")!;
  if (a("marL") !== null) ps.marL = num(a("marL")) / 12700;
  if (a("marR") !== null) ps.marR = num(a("marR")) / 12700;
  if (a("indent") !== null) ps.indent = num(a("indent")) / 12700;
  if (a("defTabSz") !== null) ps.defTab = num(a("defTabSz")) / 12700;
  if (a("rtl") !== null) ps.rtl = onOff(a("rtl"));
  const sp = (n: string): Spacing | undefined => {
    const s = kid(el, n);
    if (!s) return undefined;
    const p = kid(s, "spcPct");
    const t = kid(s, "spcPts");
    if (p) return { pct: num(attr(p, "val")) / 100000 };
    if (t) return { pts: num(attr(t, "val")) / 100 };
    return undefined;
  };
  ps.lnSpc = sp("lnSpc") ?? ps.lnSpc;
  ps.spcBef = sp("spcBef") ?? ps.spcBef;
  ps.spcAft = sp("spcAft") ?? ps.spcAft;
  if (kid(el, "buClrTx")) ps.buColor = "tx";
  const bc = kid(el, "buClr");
  if (bc) ps.buColor = colorIn(bc, env.cc) ?? ps.buColor;
  if (kid(el, "buSzTx")) ps.buSize = "tx";
  if (kid(el, "buSzPct")) ps.buSize = { pct: num(attr(kid(el, "buSzPct"), "val")) / 100000 };
  if (kid(el, "buSzPts")) ps.buSize = { pts: num(attr(kid(el, "buSzPts"), "val")) / 100 };
  if (kid(el, "buFontTx")) ps.buFont = "";
  const bf = attr(kid(el, "buFont"), "typeface");
  if (bf !== null && bf !== undefined) ps.buFont = bf;
  if (kid(el, "buNone")) ps.bu = { type: "none" };
  const bch = kid(el, "buChar");
  if (bch) ps.bu = { type: "char", char: attr(bch, "char") ?? "•" };
  const ban = kid(el, "buAutoNum");
  if (ban) ps.bu = { type: "auto", scheme: attr(ban, "type") ?? "arabicPeriod", start: num(attr(ban, "startAt"), 1) };
  const bbl = kid(el, "buBlip");
  if (bbl && kid(bbl, "blip")) ps.bu = { type: "blip", blip: kid(bbl, "blip")! };
  const tl = kid(el, "tabLst");
  if (tl) ps.tabs = kids(tl, "tab").map((t) => ({ pos: num(attr(t, "pos")) / 12700, algn: attr(t, "algn") ?? "l" })).sort((x, y) => x.pos - y.pos);
  if (withDefRPr) applyRPr(ps.def, kid(el, "defRPr"), env);
}

function defaultPara(): ParaStyle {
  return { algn: "l", marL: 0, marR: 0, indent: 0, defTab: 72, tabs: [], lnSpc: { pct: 1 }, spcBef: { pts: 0 }, spcAft: { pts: 0 }, bu: { type: "none" }, buColor: "tx", buSize: "tx", buFont: "", def: {}, rtl: false };
}

export function resolvePara(chain: ListSrc[], lvl: number, pPr: El | null, env: TextEnv): ParaStyle {
  const ps = defaultPara();
  for (let i = chain.length - 1; i >= 0; i--) {
    const src = chain[i];
    if (src.el) {
      applyPPr(ps, kid(src.el, "defPPr"), env, true);
      applyPPr(ps, kid(src.el, `lvl${lvl + 1}pPr`), env, true);
    }
    if (src.fontRef) {
      const f = src.fontRef.idx;
      if (f === "major" || f === "minor") {
        const k = f === "major" ? "mj" : "mn";
        ps.def.latin = `+${k}-lt`;
        ps.def.ea = `+${k}-ea`;
        ps.def.cs = `+${k}-cs`;
      }
      if (src.fontRef.color) ps.def.fill = { kind: "solid", color: src.fontRef.color };
    }
  }
  applyPPr(ps, pPr, env, false);
  return ps;
}

function runStyle(ps: ParaStyle, rPr: El | null, env: TextEnv): RunStyle {
  const rs: RunStyle = { size: 18, bold: false, italic: false, u: "none", strike: "noStrike", baseline: 0, cap: "none", spc: 0, kern: 0, latin: "+mn-lt", ea: "+mn-ea", cs: "+mn-cs", sym: "", fill: { kind: "solid", color: colorIn(schemeColor("tx1"), env.cc) ?? { hex: "000000", alpha: 1 } } };
  Object.assign(rs, ps.def);
  applyRPr(rs, rPr, env);
  const hk = kid(rPr, "hlinkClick");
  if (hk && rs.link) {
    // Linked text shows in the theme's hyperlink colour, underlined, unless the link
    // is set to keep the text's own colour (PowerPoint 2019's hlinkClr extension).
    const keep = attr(hk.getElementsByTagNameNS("*", "hlinkClr")[0], "val") === "tx";
    if (!keep) {
      rs.textFill = rs.fill;
      rs.fill = { kind: "solid", color: colorIn(schemeColor("hlink"), env.cc) ?? { hex: "0563C1", alpha: 1 } };
    }
    if (rs.u === "none") rs.u = "sng";
  }
  return rs;
}

const schemeEls = new Map<string, El>();
function schemeColor(val: string): El {
  let el = schemeEls.get(val);
  if (!el) schemeEls.set(val, (el = new DOMParser().parseFromString(`<f xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:schemeClr val="${val}"/></f>`, "application/xml").documentElement));
  return el;
}

/* -------------------------------------------------------------- fonts */

type Metrics = { lh: number; above: number };
/**
 * PowerPoint's line metrics don't depend on the font: a single line is 1.2 times the
 * font size with the baseline one font size down (as LibreOffice also lays PPTX out).
 */
const SLIDE_METRICS: Metrics = { lh: 1.2, above: 1 };
function fontMetrics(_name: string): Metrics {
  return SLIDE_METRICS;
}

/** PowerPoint kerns a run from its kern size up (kern="1200": 12 pt and larger). */
const kerned = (st: RunStyle, size: number) => st.kern > 0 && size >= st.kern - 0.01;

/* ------------------------------------------------------------- layout */

/** A measured piece of text in one style and font. */
type Piece = { text: string; st: RunStyle; font: string; size: number; w: number; space: boolean; tab?: boolean; asc: number; desc: number; rise: number };
type Word = { pieces: Piece[]; w: number; spaces: Piece[]; sw: number; br?: boolean; tab?: boolean };
type LineOut = { pieces: { p: Piece; x: number }[]; w: number; asc: number; desc: number; h: number; base: number; x0: number; last: boolean; spaceCount: number; para: number };
type ParaOut = { lines: LineOut[]; before: number; after: number; bullet?: { text?: string; st: RunStyle; font: string; size: number; x: number; w: number; blip?: El }; ps: ParaStyle };

const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

function autoNumber(scheme: string, n: number): string {
  const roman = (v: number) => {
    const map: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let s = "";
    for (const [k, r] of map) while (v >= k) {
      s += r;
      v -= k;
    }
    return s;
  };
  const alpha = (v: number) => {
    let s = "";
    while (v > 0) {
      v--;
      s = String.fromCharCode(97 + (v % 26)) + s;
      v = Math.floor(v / 26);
    }
    return s;
  };
  let core = String(n);
  if (/^roman/.test(scheme)) core = roman(n);
  else if (/^alpha/.test(scheme)) core = alpha(n);
  else if (/^circleNum/.test(scheme)) return n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : `(${n})`;
  if (/Uc/.test(scheme)) core = core.toUpperCase();
  if (/ParenBoth$/.test(scheme)) return `(${core})`;
  if (/ParenR$/.test(scheme)) return `${core})`;
  if (/Period$/.test(scheme)) return `${core}.`;
  if (/Minus$/.test(scheme)) return `- ${core} -`;
  return core;
}

function formatDate(type: string, d: Date): string | null {
  const m = /^datetime(\d+)$/.exec(type);
  if (!m) return null;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const h12 = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? "AM" : "PM";
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ymd = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  switch (Number(m[1])) {
    case 1:
      return ymd;
    case 2:
      return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    case 3:
      return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
    case 4:
      return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    case 5:
      return `${d.getDate()}-${months[d.getMonth()].slice(0, 3)}-${String(d.getFullYear()).slice(2)}`;
    case 6:
      return `${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
    case 7:
      return `${months[d.getMonth()].slice(0, 3)}-${String(d.getFullYear()).slice(2)}`;
    case 8:
      return `${ymd} ${h12}:${mm} ${ampm}`;
    case 9:
      return `${ymd} ${h12}:${mm}:${ss} ${ampm}`;
    case 10:
      return `${d.getHours()}:${mm}`;
    case 11:
      return `${d.getHours()}:${mm}:${ss}`;
    case 12:
      return `${h12}:${mm} ${ampm}`;
    case 13:
      return `${h12}:${mm}:${ss} ${ampm}`;
  }
  return ymd;
}

export class SlideText {
  /** A shape's shadow, cast by its text when the shape has no fill or outline. */
  private shapeShadow: Shadow | undefined;
  constructor(private env: TextEnv) {}

  private fontFor(st: RunStyle, script: "latin" | "ea" | "cs"): string {
    const t = this.env.theme;
    const pick = script === "ea" ? st.ea || st.latin : script === "cs" ? st.cs || st.latin : st.latin;
    let name = themeFont(pick, t);
    if (!name) name = themeFont(st.latin, t) || t.minor.latin || "Calibri";
    return name;
  }

  private spec(font: string, st: RunStyle, size: number): FontSpec {
    return { name: font, size, bold: st.bold, italic: st.italic };
  }

  /** Text in one style split into measured pieces by script and caps. */
  private async pieces(text: string, st: RunStyle, scale: number): Promise<Piece[]> {
    const out: Piece[] = [];
    let display = st.cap === "all" ? text.toUpperCase() : text;
    const baseSize = st.size * scale;
    const size = st.baseline ? baseSize * (2 / 3) : baseSize;
    const rise = st.baseline * baseSize;
    // Symbol-font runs: letters stand for pictures.
    const latinFont = this.fontFor(st, "latin");
    if (isSymbolFont(latinFont)) display = mapSymbols(display, latinFont) ?? display;
    const parts: { text: string; script: "latin" | "ea" | "cs"; small: boolean }[] = [];
    for (const ch of display) {
      const cp = ch.codePointAt(0)!;
      const script = cp <= 0x7f ? "latin" : scriptOf(cp);
      const small = st.cap === "small" && ch !== ch.toUpperCase();
      const last = parts[parts.length - 1];
      if (last && last.script === script && last.small === small) last.text += ch;
      else parts.push({ text: ch, script, small });
    }
    for (const p of parts) {
      const font = this.fontFor(st, p.script);
      const sz = p.small ? size * 0.8 : size;
      const txt = p.small ? p.text.toUpperCase() : p.text;
      const w = (await this.env.kit.width(txt, this.spec(font, st, sz), sz, kerned(st, sz))) + st.spc * [...txt].length;
      const m = fontMetrics(font);
      out.push({ text: txt, st, font, size: sz, w, space: /^[ \u00a0\u3000]+$/.test(txt), asc: m.above * baseSize + Math.max(0, rise), desc: (m.lh - m.above) * baseSize + Math.max(0, -rise), rise });
    }
    return out;
  }

  /** Paragraph content as words (break units). */
  private async words(p: El, ps: ParaStyle, scale: number, firstStyle: { st?: RunStyle }): Promise<Word[]> {
    const words: Word[] = [];
    let cur: Word = { pieces: [], w: 0, spaces: [], sw: 0 };
    const flush = () => {
      if (cur.pieces.length || cur.spaces.length) words.push(cur);
      cur = { pieces: [], w: 0, spaces: [], sw: 0 };
    };
    const env = this.env;
    for (const r of Array.from(p.children)) {
      const name = r.localName;
      if (name !== "r" && name !== "fld" && name !== "br") continue;
      const st = runStyle(ps, kid(r, "rPr"), env);
      firstStyle.st ??= st;
      if (name === "br") {
        flush();
        const m = fontMetrics(this.fontFor(st, "latin"));
        words.push({ pieces: [{ text: "", st, font: this.fontFor(st, "latin"), size: st.size * scale, w: 0, space: false, asc: m.above * st.size * scale, desc: (m.lh - m.above) * st.size * scale, rise: 0 }], w: 0, spaces: [], sw: 0, br: true });
        continue;
      }
      let text = kid(r, "t")?.textContent ?? "";
      if (name === "fld") {
        const type = attr(r, "type") ?? "";
        if (type === "slidenum") text = String(env.slideNo);
        else {
          const d = formatDate(type, env.date ?? new Date());
          if (d !== null) text = d;
        }
      }
      // Vertical tab is PowerPoint's soft line break inside a run.
      const chunks = text.replace(/\r\n?/g, "\n").split(/([\t\v\n])/);
      for (const chunk of chunks) {
        if (!chunk) continue;
        if (chunk === "\v" || chunk === "\n") {
          flush();
          const m = fontMetrics(this.fontFor(st, "latin"));
          words.push({ pieces: [{ text: "", st, font: this.fontFor(st, "latin"), size: st.size * scale, w: 0, space: false, asc: m.above * st.size * scale, desc: (m.lh - m.above) * st.size * scale, rise: 0 }], w: 0, spaces: [], sw: 0, br: true });
          continue;
        }
        if (chunk === "\t") {
          flush();
          const m = fontMetrics(this.fontFor(st, "latin"));
          words.push({ pieces: [{ text: "", st, font: this.fontFor(st, "latin"), size: st.size * scale, w: 0, space: false, tab: true, asc: m.above * st.size * scale, desc: (m.lh - m.above) * st.size * scale, rise: 0 }], w: 0, spaces: [], sw: 0, tab: true });
          continue;
        }
        // Break after spaces and hyphens, and around CJK characters.
        const toks = chunk.match(/[ \u00a0\u3000]+|[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]|[^ \u00a0\u3000\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]+?(?:-(?=[^\s-])|$|(?=[ \u00a0\u3000\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]))/g) ?? [];
        for (const tok of toks) {
          const isSpace = /^[ \u00a0\u3000]+$/.test(tok) && !/\u00a0/.test(tok);
          const ps2 = await this.pieces(tok, st, scale);
          if (isSpace) {
            for (const q of ps2) {
              q.space = true;
              cur.spaces.push(q);
              cur.sw += q.w;
            }
            continue;
          }
          if (cur.spaces.length) flush();
          for (const q of ps2) {
            cur.pieces.push(q);
            cur.w += q.w;
          }
          if (CJK.test(tok) || /-$/.test(tok)) flush();
        }
      }
    }
    flush();
    return words;
  }

  /** Lay out a whole text body in a frame `width` wide. */
  async layout(body: El, chain: ListSrc[], width: number, bp: BodyProps, scale: number, spacingCut: number): Promise<ParaOut[]> {
    const env = this.env;
    const out: ParaOut[] = [];
    const counters = new Map<number, { scheme: string; n: number }>();
    let prevLvl = -1;
    for (const p of kids(body, "p")) {
      const pPr = kid(p, "pPr");
      const lvl = Math.min(8, num(attr(pPr, "lvl")));
      const ps = resolvePara(chain, lvl, pPr, env);
      const first: { st?: RunStyle } = {};
      const words = await this.words(p, ps, scale, first);
      const hasText = words.some((w) => w.pieces.some((q) => q.text) || w.tab);
      const endSt = runStyle(ps, kid(p, "endParaRPr"), env);
      const st0 = first.st ?? endSt;
      // Numbering continues through paragraphs at the same level, restarts after a gap.
      let bullet: ParaOut["bullet"];
      if (hasText && ps.bu.type !== "none") {
        const size0 = st0.size * scale;
        const bsize = ps.buSize === "tx" ? size0 : ps.buSize.pts !== undefined ? ps.buSize.pts * scale : size0 * (ps.buSize.pct ?? 1);
        const bst: RunStyle = { ...st0, fill: st0.textFill ?? st0.fill, size: bsize / scale, baseline: 0, u: "none", strike: "noStrike", cap: "none", spc: 0, link: undefined, highlight: undefined };
        if (ps.buColor !== "tx") bst.fill = { kind: "solid", color: ps.buColor };
        if (ps.buFont) bst.latin = bst.ea = bst.cs = ps.buFont;
        let text: string | undefined;
        if (ps.bu.type === "char") text = ps.bu.char ?? "•";
        else if (ps.bu.type === "auto") {
          const c = counters.get(lvl);
          const n = c && c.scheme === ps.bu.scheme ? c.n + 1 : (ps.bu.start ?? 1);
          counters.set(lvl, { scheme: ps.bu.scheme ?? "", n });
          text = autoNumber(ps.bu.scheme ?? "arabicPeriod", n);
          bst.latin = ps.buFont || st0.latin;
        }
        const font = this.fontFor(bst, "latin");
        const shown = text !== undefined && isSymbolFont(font) ? (mapSymbols(text, font) ?? text) : text;
        const w = shown !== undefined ? await env.kit.width(shown, this.spec(font, bst, bsize), bsize) : bsize;
        bullet = { text: shown, st: bst, font, size: bsize, x: ps.marL + ps.indent, w, blip: ps.bu.type === "blip" ? ps.bu.blip : undefined };
      }
      if (ps.bu.type !== "auto" || !hasText) {
        if (hasText || lvl <= prevLvl) counters.delete(lvl);
      }
      for (const k of [...counters.keys()]) if (k > lvl) counters.delete(k);
      if (hasText) prevLvl = lvl;
      // Lines.
      const lines: LineOut[] = [];
      const firstX = ps.marL + ps.indent;
      const textStart = bullet ? (ps.indent < 0 && bullet.x + bullet.w <= ps.marL ? ps.marL : bullet.x + bullet.w) : firstX;
      const avail = (first: boolean) => (bp.wrap ? width - ps.marR - (first ? textStart : ps.marL) : 1e9);
      let line: { p: Piece; x: number }[] = [];
      let x = 0;
      let isFirst = true;
      const startX = () => (isFirst ? textStart : ps.marL);
      const finish = (last: boolean, forced = false) => {
        // Spaces where a line wraps hang past the edge; at a paragraph's end or a
        // line break they count, as they do in PowerPoint.
        let w = 0;
        for (const it of line) if (!it.p.space || last || forced) w = Math.max(w, it.x + it.p.w);
        let asc = 0;
        let desc = 0;
        for (const it of line) {
          if (it.p.tab) continue;
          asc = Math.max(asc, it.p.asc);
          desc = Math.max(desc, it.p.desc);
        }
        if (!line.length || (!asc && !desc)) {
          const src = line[0]?.p ?? null;
          const st = src?.st ?? endSt;
          const m = fontMetrics(this.fontFor(st, "latin"));
          asc = m.above * st.size * scale;
          desc = (m.lh - m.above) * st.size * scale;
        }
        if (bullet && isFirst) {
          const m = fontMetrics(bullet.font);
          asc = Math.max(asc, m.above * bullet.size);
          desc = Math.max(desc, (m.lh - m.above) * bullet.size);
        }
        lines.push({ pieces: line, w, asc, desc, h: 0, base: 0, x0: startX(), last, spaceCount: line.filter((it) => it.p.space).length, para: out.length });
        line = [];
        x = 0;
        isFirst = false;
      };
      const tabStop = (pos: number, lineStart: number): { stop: number; algn: string } => {
        const abs = lineStart + pos;
        const t = ps.tabs.find((tb) => tb.pos > abs + 0.01);
        if (t) return { stop: t.pos - lineStart, algn: t.algn };
        const d = ps.defTab > 0 ? ps.defTab : 72;
        return { stop: (Math.floor(abs / d + 1e-6) + 1) * d - lineStart, algn: "l" };
      };
      for (let wi = 0; wi < words.length; wi++) {
        const wd = words[wi];
        if (wd.br) {
          line.push({ p: wd.pieces[0], x });
          finish(false, true);
          continue;
        }
        if (wd.tab) {
          const { stop, algn } = tabStop(x, startX());
          // Right and centre tabs pull the following word back to the stop.
          let next = 0;
          if (algn !== "l") for (let k = wi + 1; k < words.length && !words[k].tab && !words[k].br; k++) next += words[k].w + (words[k + 1] && !words[k + 1].tab ? words[k].sw : 0);
          let to = algn === "r" ? stop - next : algn === "ctr" ? stop - next / 2 : stop;
          if (to < x) to = x;
          line.push({ p: { ...wd.pieces[0], w: to - x }, x });
          x = to;
          continue;
        }
        const room = avail(isFirst);
        if (line.length && x + wd.w > room + 0.01) finish(false);
        if (!line.length && wd.w > avail(isFirst) + 0.01 && bp.wrap) {
          // A word wider than the line: break it between characters.
          for (const q of wd.pieces) {
            let rest = q.text;
            while (rest) {
              const r = avail(isFirst) - x;
              let n = 0;
              let w = 0;
              const chars = [...rest];
              for (; n < chars.length; n++) {
                const cw = (await env.kit.width(chars[n], this.spec(q.font, q.st, q.size), q.size)) + q.st.spc;
                if (w + cw > r && (n > 0 || line.length)) break;
                w += cw;
              }
              if (n === 0) {
                finish(false);
                continue;
              }
              const part = chars.slice(0, n).join("");
              line.push({ p: { ...q, text: part, w }, x });
              x += w;
              rest = chars.slice(n).join("");
              if (rest) finish(false);
            }
          }
          for (const s of wd.spaces) {
            line.push({ p: s, x });
            x += s.w;
          }
          continue;
        }
        for (const q of wd.pieces) {
          line.push({ p: q, x });
          x += q.w;
        }
        for (const s of wd.spaces) {
          line.push({ p: s, x });
          x += s.w;
        }
      }
      if (line.length || !lines.length || lines[lines.length - 1].pieces.some((it) => it.p.text === "" && !it.p.tab)) finish(true);
      else lines[lines.length - 1].last = true;
      // Spacing.
      const size0 = st0.size * scale;
      const lnPct = ps.lnSpc.pct !== undefined ? Math.max(0.1, ps.lnSpc.pct - spacingCut) : undefined;
      for (const l of lines) {
        const natural = l.asc + l.desc;
        if (lnPct !== undefined) l.h = natural * lnPct;
        else l.h = (ps.lnSpc.pts ?? natural) * (scale < 1 ? scale : 1);
        l.base = l.h - l.desc;
      }
      const spacing = (s: Spacing) => (s.pts !== undefined ? s.pts * (1 - spacingCut) : (s.pct ?? 0) * size0 * (1 - spacingCut));
      out.push({ lines, before: spacing(ps.spcBef), after: spacing(ps.spcAft), bullet, ps });
    }
    return out;
  }

  static height(paras: ParaOut[]): number {
    let h = 0;
    paras.forEach((p, i) => {
      if (i) h += p.before;
      for (const l of p.lines) h += l.h;
      h += p.after;
    });
    return h;
  }

  /**
   * Lay out and draw a text body inside a frame: `frame` maps the text rectangle's own
   * coordinates (0..w, 0..h, unrotated text) to the page.
   */
  async draw(pen: Pen, body: El, chain: ListSrc[], bp: BodyProps, frame: Mat, w: number, h: number, shadow?: Shadow) {
    if (!kids(body, "p").some((p) => Array.from(p.children).some((c) => c.localName === "fld" || (c.localName === "r" && (kid(c, "t")?.textContent ?? "") !== "")))) return;
    this.shapeShadow = shadow;
    try {
      await this.drawBody(pen, body, chain, bp, frame, w, h);
    } finally {
      this.shapeShadow = undefined;
    }
  }

  private async drawBody(pen: Pen, body: El, chain: ListSrc[], bp: BodyProps, frame: Mat, w: number, h: number) {
    // Vertical text turns the frame; the insets stay with the shape's sides.
    let m = frame;
    let fw = Math.max(0, w - bp.lIns - bp.rIns);
    let fh = Math.max(0, h - bp.tIns - bp.bIns);
    m = then(translate(bp.lIns, bp.tIns), m);
    const vert = bp.vert === "vert" || bp.vert === "eaVert" || bp.vert === "mongolianVert" || bp.vert === "wordArtVertRtl" ? 90 : bp.vert === "vert270" ? 270 : 0;
    if (vert) {
      const cx = fw / 2;
      const cy = fh / 2;
      [fw, fh] = [fh, fw];
      m = then(then(translate(-fw / 2, -fh / 2), rotate(vert)), then(translate(cx, cy), m));
    }
    const cols = bp.numCol;
    const colW = cols > 1 ? Math.max(1, (fw - bp.spcCol * (cols - 1)) / cols) : fw;
    // Autofit: the scale PowerPoint stored with the text. PowerPoint recomputes it only when
    // the text is edited, so a deck shows (and prints) at the stored scale even if it overflows.
    const scale = bp.autofit === "norm" ? bp.fontScale : 1;
    const cut = bp.autofit === "norm" ? bp.lnSpcReduction : 0;
    const paras = await this.layout(body, chain, colW, bp, scale, cut);
    // Columns: lines flow down each column in turn.
    type Placed = { line: LineOut; para: ParaOut; x: number; top: number; col: number; firstOfPara: boolean };
    const placed: Placed[] = [];
    let col = 0;
    let y = 0;
    for (const [pi, p] of paras.entries()) {
      // Space before doesn't apply at the top of the text.
      if (pi) y += p.before;
      p.lines.forEach((l, i) => {
        if (cols > 1 && y + l.h > fh + 0.5 && y > 0 && col < cols - 1) {
          col++;
          y = 0;
        }
        placed.push({ line: l, para: p, x: col * (colW + bp.spcCol), top: y, col, firstOfPara: i === 0 });
        y += l.h;
      });
      y += p.after;
    }
    const total = cols > 1 ? fh : SlideText.height(paras);
    const anchor = bp.anchor;
    const dy = anchor === "ctr" ? (fh - total) / 2 : anchor === "b" ? fh - total : 0;
    // anchorCtr centres the block of text, keeping its alignment inside.
    // anchorCtr centres the block of text in the frame; lines align inside the block.
    let dx = 0;
    let blockW = colW;
    if (bp.anchorCtr && bp.wrap) {
      blockW = Math.min(colW, Math.max(0, ...placed.map((pl) => pl.line.x0 + pl.line.w + pl.para.ps.marR)));
      dx = (colW - blockW) / 2;
    }
    for (const pl of placed) {
      const { line, para } = pl;
      const ps = para.ps;
      let lx = pl.x + line.x0 + dx;
      const room = (bp.wrap ? blockW - ps.marR : 0) - line.x0;
      const extra = room - line.w;
      let gap = 0;
      if (bp.wrap) {
        if (ps.algn === "ctr") lx += extra / 2;
        else if (ps.algn === "r") lx += extra;
        else if ((ps.algn === "just" || ps.algn === "dist") && (!line.last || ps.algn === "dist") && extra > 0) {
          const inner = line.pieces.filter((it, i) => it.p.space && line.pieces.slice(i + 1).some((o) => !o.p.space)).length;
          if (inner) gap = extra / inner;
        }
      } else {
        // No wrapping: the text hangs around the frame per its alignment.
        if (ps.algn === "ctr") lx = pl.x + (colW - line.w) / 2 + (line.x0 - ps.marL) / 2;
        else if (ps.algn === "r") lx = pl.x + colW - line.w;
      }
      const base = dy + pl.top + line.base;
      if (pl.firstOfPara && para.bullet) await this.drawBullet(pen, m, para.bullet, pl.x + dx + (bp.wrap && ps.algn !== "l" && ps.algn !== "just" ? lx - pl.x - dx - line.x0 : 0), base);
      let shift = 0;
      for (const it of line.pieces) {
        const px = lx + it.x + shift;
        if (it.p.space && gap) {
          const trailing = !line.pieces.slice(line.pieces.indexOf(it) + 1).some((o) => !o.p.space);
          if (!trailing) shift += gap;
        }
        if (it.p.tab || !it.p.text) continue;
        await this.drawPiece(pen, m, it.p, px, base, line);
      }
    }
  }

  private async drawBullet(pen: Pen, m: Mat, b: NonNullable<ParaOut["bullet"]>, x0: number, base: number) {
    const bx = x0 + b.x;
    if (b.blip) {
      // A picture bullet is 70% of the text's size (as LibreOffice also draws PowerPoint's),
      // keeps its proportions and sits centred on the middle of the letters.
      const img = this.env.bulletImage ? await this.env.bulletImage(b.blip) : null;
      if (img) {
        const h = b.size * 0.7;
        const w = img.w > 0 && img.h > 0 ? (h * img.w) / img.h : h;
        img.draw(pen, then([w, 0, 0, -h, bx, base - b.size * 0.3 + h / 2], m));
      }
      return;
    }
    if (!b.text) return;
    const p: Piece = { text: b.text, st: b.st, font: b.font, size: b.size, w: b.w, space: false, asc: 0, desc: 0, rise: 0 };
    await this.drawPiece(pen, m, p, bx, base, null);
  }

  private async drawPiece(pen: Pen, m: Mat, p: Piece, x: number, base: number, line: LineOut | null) {
    const kit = this.env.kit;
    const st = p.st;
    const y = base - p.rise;
    const spec = this.spec(p.font, st, p.size);
    const fill = st.fill;
    const color: RGBA | null = !fill || fill.kind === "none" ? null : fill.kind === "solid" ? fill.color : fill.kind === "grad" ? fill.stops[Math.floor((fill.stops.length - 1) / 2)].color : fill.kind === "patt" ? fill.fg : { hex: "000000", alpha: 1 };
    const outline = st.ln?.fill && st.ln.fill.kind !== "none" ? st.ln : undefined;
    const outlineColor: RGBA | null = outline?.fill?.kind === "solid" ? outline.fill.color : null;
    pen.save();
    pen.concat(m);
    // Highlight behind the run.
    if (st.highlight && line) {
      pen.rectPath(x, base - line.asc, p.w, line.asc + line.desc);
      pen.fillWith(st.highlight);
    }
    // Shadow under the text (the run's own, or the shape's when the shape itself shows nothing),
    // drawn as outlines so it doesn't repeat the words in the PDF's text.
    const shadow = st.shadow ?? this.shapeShadow;
    if (shadow && color) {
      const r = (shadow.dir * Math.PI) / 180;
      const sx = x + shadow.dist * Math.cos(r);
      const sy = y + shadow.dist * Math.sin(r);
      const { segs } = await kit.outline(p.text, spec, p.size, p.st.spc, kerned(p.st, p.size));
      const offsets: [number, number][] = [[0, 0]];
      if (shadow.blur >= 1) for (const k of [0.35, 0.7]) for (let i = 0; i < 8; i++) offsets.push([Math.cos((i * Math.PI) / 4) * shadow.blur * k, Math.sin((i * Math.PI) / 4) * shadow.blur * k]);
      const a = offsets.length === 1 ? shadow.color.alpha : 1 - Math.pow(1 - Math.min(0.95, shadow.color.alpha * 0.85), 1 / offsets.length);
      for (const [ox, oy] of offsets) {
        pen.save();
        pen.path(segs as never, [1, 0, 0, 1, sx + ox, sy + oy]);
        pen.fillWith({ hex: shadow.color.hex, alpha: a });
        pen.restore();
      }
    }
    if (color || outlineColor) await this.glyphs(pen, kit, p, spec, x, y, color, outlineColor, outline?.width ?? 0.75);
    // Underline and strike-through.
    if (color && (st.u !== "none" || st.strike !== "noStrike")) {
      const met = await kit.metrics(spec, p.size);
      const w = p.w - st.spc;
      if (st.u !== "none" && st.u) {
        const th = Math.max(0.5, met.thickness * (/heavy|Heavy|thick/.test(st.u) ? 2 : 1));
        const uy = y + met.underline;
        pen.rectPath(x, uy - th / 2, w, th);
        if (st.u === "dbl") pen.rectPath(x, uy + th * 1.5, w, th);
        pen.fillWith(color);
      }
      if (st.strike !== "noStrike") {
        const th = Math.max(0.5, met.thickness);
        const sy = y - p.size * 0.3;
        pen.rectPath(x, sy - th / 2, w, th);
        if (st.strike === "dblStrike") pen.rectPath(x, sy - th * 2, w, th);
        pen.fillWith(color);
      }
    }
    pen.restore();
    if (st.link && this.env.onLink) {
      const asc = p.size * 0.95;
      const desc = p.size * 0.25;
      const quad: [number, number][] = [
        [x, base - asc],
        [x + p.w, base - asc],
        [x + p.w, base + desc],
        [x, base + desc],
      ].map(([qx, qy]) => apply(m, qx, qy));
      this.env.onLink(st.link, quad);
    }
  }

  /** The glyphs of a piece, face by face, in the current (y-down) user space. */
  private async glyphs(pen: Pen, kit: TextKit, p: Piece, spec: FontSpec, x: number, y: number, fill: RGBA | null, stroke: RGBA | null, strokeW: number) {
    let cx = x;
    for (const r of await kit.runs(p.text, spec)) {
      const kern = kerned(p.st, p.size);
      const w = (await kit.runWidth(r, p.size, kern)) + p.st.spc * [...r.text].length;
      if (r.text.trim()) {
        const font = await kit.embed(r.key);
        const key = kit.fontKey(pen.page, font);
        pen.save();
        if (fill && fill.alpha < 1) pen.alpha(fill.alpha, stroke?.alpha);
        else if (stroke && stroke.alpha < 1) pen.alpha(undefined, stroke.alpha);
        const parts = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
        const ops = [beginText(), setFontAndSize(key, p.size)];
        if (fill) ops.push(setFillingRgbColor(...parts(fill.hex)));
        let mode = fill ? TextRenderingMode.Fill : TextRenderingMode.Outline;
        if (stroke) {
          ops.push(setStrokingRgbColor(...parts(stroke.hex)), setLineWidth(Math.max(0.2, strokeW)));
          mode = fill ? TextRenderingMode.FillAndOutline : TextRenderingMode.Outline;
        } else if (r.fakeBold && fill) {
          ops.push(setStrokingRgbColor(...parts(fill.hex)), setLineWidth(p.size * 0.03));
          mode = TextRenderingMode.FillAndOutline;
        }
        if (mode !== TextRenderingMode.Fill) ops.push(setTextRenderingMode(mode));
        if (p.st.spc) ops.push(setCharacterSpacing(p.st.spc));
        ops.push(setTextMatrix(1, 0, r.fakeItalic ? 0.2 : 0, -1, cx, y), ...(await kit.show(font, r, kern)), endText());
        pen.op(...ops);
        pen.restore();
      }
      cx += w;
    }
  }
}

export { pushGraphicsState, popGraphicsState };
