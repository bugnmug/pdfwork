/**
 * Reads a .docx into the resolved model: styles (with basedOn chains, the
 * default paragraph style and table styles with their conditional parts),
 * numbering, theme fonts and colours, sections, headers and footers,
 * footnotes, fields, hyperlinks, pictures, shapes and text boxes.
 */
import { Package, attr, drawingColor, emu, kid, kids, num, onOff, path, readTheme, twip, wordThemeColor, type El, type Part, type Theme } from "../ooxml";
import { isSymbolFont, mapSymbols, symChar } from "./symbols";
import type {
  AbstractNum, Block, Border, CellBorders, CellProps, DocxModel, Drawing, Fill, Fonts, GroupNode, Inline, Level, Line, Link, NumDef,
  Para, ParaBorders, ParaProps, Placement, Row, RunProps, Section, Settings, ShapeNode, Sides, TabStop, Table, TableProps,
} from "./model";

/* ------------------------------------------------------------ properties */

const HIGHLIGHT: Record<string, string> = {
  yellow: "FFFF00", green: "00FF00", cyan: "00FFFF", magenta: "FF00FF", blue: "0000FF", red: "FF0000", darkBlue: "000080", darkCyan: "008080",
  darkGreen: "008000", darkMagenta: "800080", darkRed: "800000", darkYellow: "808000", darkGray: "808080", lightGray: "C0C0C0", black: "000000", white: "FFFFFF",
};

const THEME_COLOR: Record<string, string> = {
  dark1: "dk1", light1: "lt1", dark2: "dk2", light2: "lt2", text1: "dk1", text2: "dk2", background1: "lt1", background2: "lt2",
  accent1: "accent1", accent2: "accent2", accent3: "accent3", accent4: "accent4", accent5: "accent5", accent6: "accent6",
  hyperlink: "hlink", followedHyperlink: "folHlink",
};

const clean = <T extends object>(o: T): Partial<T> => {
  const out: Partial<T> = {};
  for (const k in o) if (o[k] !== undefined) out[k] = o[k];
  return out;
};

class Props {
  constructor(public theme: Theme) {}

  color(el: El | null, valAttr = "val", themeAttr = "themeColor", tintAttr = "themeTint", shadeAttr = "themeShade"): string | undefined {
    if (!el) return undefined;
    const th = attr(el, themeAttr);
    if (th && THEME_COLOR[th]) return wordThemeColor(this.theme.colors[THEME_COLOR[th]] ?? "000000", attr(el, tintAttr), attr(el, shadeAttr));
    const v = attr(el, valAttr);
    if (!v) return undefined;
    if (v === "auto") return "auto";
    return /^[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : undefined;
  }

  /** A w:shd as one colour: patterns become a blend of their two colours. */
  shading(el: El | null): string | undefined {
    if (!el) return undefined;
    const val = attr(el, "val") ?? "clear";
    if (val === "nil") return "none";
    const fill = this.color(el, "fill", "themeFill", "themeFillTint", "themeFillShade");
    const fg = this.color(el, "color", "themeColor", "themeTint", "themeShade");
    const pct = val === "solid" ? 100 : /^pct(\d+)$/.test(val) ? Number(val.slice(3)) : val === "clear" ? 0 : 50;
    const back = fill && fill !== "auto" ? fill : undefined;
    if (pct === 0) return back ?? "none";
    const front = fg && fg !== "auto" ? fg : "000000";
    const b = back ?? "FFFFFF";
    const mix = (i: number) => Math.round(parseInt(front.slice(i, i + 2), 16) * (pct / 100) + parseInt(b.slice(i, i + 2), 16) * (1 - pct / 100));
    return [0, 2, 4].map((i) => mix(i).toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  border(el: El | null): Border | undefined {
    if (!el) return undefined;
    const style = attr(el, "val") ?? "single";
    if (style === "nil" || style === "none") return { style: "none", width: 0, color: "000000", space: 0 };
    const sz = num(attr(el, "sz"), 4);
    // Art borders (apples, stars...) give sz in points; draw them as a plain line.
    const width = /^(single|thick|double|dotted|dashed|dotDash|dotDotDash|triple|thinThick|thickThin|thinThickThin|wave|doubleWave|dashSmallGap|dashDotStroked|threeDEmboss|threeDEngrave|outset|inset)/.test(style) || /Gap$/.test(style) ? sz / 8 : Math.min(sz, 6) / 2;
    const color = this.color(el, "color");
    return { style, width: Math.max(0.25, width), color: color && color !== "auto" ? color : "000000", space: num(attr(el, "space")) };
  }

  sides(el: El | null): ParaBorders & CellBorders {
    const out: ParaBorders & CellBorders = {};
    for (const c of Array.from(el?.children ?? [])) {
      const name = c.localName === "start" ? "left" : c.localName === "end" ? "right" : c.localName;
      if (["top", "left", "bottom", "right", "between", "bar", "insideH", "insideV", "tl2br", "tr2bl"].includes(name)) (out as Record<string, Border | undefined>)[name] = this.border(c);
    }
    return out;
  }

  margins(el: El | null): Sides<number> {
    const out: Sides<number> = {};
    for (const c of Array.from(el?.children ?? [])) {
      const name = c.localName === "start" ? "left" : c.localName === "end" ? "right" : c.localName;
      if (["top", "left", "bottom", "right"].includes(name) && (attr(c, "type") ?? "dxa") === "dxa") (out as Record<string, number>)[name] = twip(attr(c, "w"));
    }
    return out;
  }

  fonts(el: El): Fonts {
    const f: Fonts = {};
    const th = this.theme;
    const fromTheme = (v: string | null): string | undefined => {
      if (!v) return undefined;
      const set = v.startsWith("major") ? th.major : th.minor;
      if (/HAnsi|Ascii/.test(v)) return set.latin || undefined;
      if (/EastAsia/.test(v)) return set.ea || set.scripts["Hans"] || set.scripts["Jpan"] || undefined;
      if (/Bidi/.test(v)) return set.cs || undefined;
      return undefined;
    };
    for (const k of ["ascii", "hAnsi", "eastAsia", "cs"] as const) {
      const v = fromTheme(attr(el, `${k}Theme`)) ?? attr(el, k) ?? undefined;
      if (v) f[k] = v;
    }
    const hint = attr(el, "hint");
    if (hint) f.hint = hint;
    return f;
  }

  rPr(el: El | null): RunProps {
    const rp: RunProps = {};
    if (!el) return rp;
    for (const c of Array.from(el.children)) {
      switch (c.localName) {
        case "rStyle":
          rp.styleId = attr(c, "val") ?? undefined;
          break;
        case "rFonts":
          rp.fonts = this.fonts(c);
          break;
        case "sz":
          rp.size = num(attr(c, "val"), 22) / 2;
          break;
        case "szCs":
          rp.sizeCs = num(attr(c, "val"), 22) / 2;
          break;
        case "b":
          rp.bold = onOff(c);
          break;
        case "bCs":
          rp.boldCs = onOff(c);
          break;
        case "i":
          rp.italic = onOff(c);
          break;
        case "iCs":
          rp.italicCs = onOff(c);
          break;
        case "u": {
          const v = attr(c, "val") ?? "single";
          rp.underline = v;
          const col = this.color(c);
          if (col && col !== "auto") rp.underlineColor = col;
          break;
        }
        case "strike":
          rp.strike = onOff(c);
          break;
        case "dstrike":
          rp.dstrike = onOff(c);
          break;
        case "color":
          rp.color = this.color(c);
          break;
        case "highlight": {
          const v = attr(c, "val") ?? "";
          rp.highlight = v === "none" ? "none" : HIGHLIGHT[v];
          break;
        }
        case "shd":
          rp.shading = this.shading(c);
          break;
        case "vertAlign":
          rp.vertAlign = (attr(c, "val") as RunProps["vertAlign"]) ?? "baseline";
          break;
        case "position":
          rp.position = num(attr(c, "val")) / 2;
          break;
        case "caps":
          rp.caps = onOff(c);
          break;
        case "smallCaps":
          rp.smallCaps = onOff(c);
          break;
        case "spacing":
          rp.spacing = twip(attr(c, "val"));
          break;
        case "w":
          rp.scale = num(attr(c, "val"), 100);
          break;
        case "vanish":
        case "specVanish":
          rp.vanish = onOff(c);
          break;
        case "webHidden":
          break;
        case "rtl":
          rp.rtl = onOff(c);
          break;
        case "cs":
          rp.cs = onOff(c);
          break;
        case "bdr":
          rp.border = this.border(c);
          break;
        case "emboss":
        case "imprint":
          rp.emboss = onOff(c);
          break;
        case "outline":
          rp.outline = onOff(c);
          break;
        case "shadow":
          rp.shadow = onOff(c);
          break;
      }
    }
    return rp;
  }

  pPr(el: El | null): ParaProps {
    const pp: ParaProps = {};
    if (!el) return pp;
    for (const c of Array.from(el.children)) {
      switch (c.localName) {
        case "pStyle":
          pp.styleId = attr(c, "val") ?? undefined;
          break;
        case "keepNext":
          pp.keepNext = onOff(c);
          break;
        case "keepLines":
          pp.keepLines = onOff(c);
          break;
        case "pageBreakBefore":
          pp.pageBreakBefore = onOff(c);
          break;
        case "widowControl":
          pp.widowControl = onOff(c);
          break;
        case "numPr": {
          const id = attr(kid(c, "numId"), "val");
          const lvl = attr(kid(c, "ilvl"), "val");
          if (id != null) pp.numId = id;
          if (lvl != null) pp.ilvl = num(lvl);
          break;
        }
        case "pBdr":
          pp.borders = this.sides(c);
          break;
        case "shd":
          pp.shading = this.shading(c);
          break;
        case "tabs":
          pp.tabs = kids(c, "tab").map((t) => ({ pos: twip(attr(t, "pos")), val: attr(t, "val") ?? "left", leader: attr(t, "leader") ?? undefined }));
          break;
        case "spacing": {
          const b = attr(c, "before");
          const a = attr(c, "after");
          const bl = attr(c, "beforeLines");
          const al = attr(c, "afterLines");
          if (bl != null) pp.spBefore = (num(bl) / 100) * 12;
          else if (b != null) pp.spBefore = twip(b);
          if (al != null) pp.spAfter = (num(al) / 100) * 12;
          else if (a != null) pp.spAfter = twip(a);
          const yes = (v: string | null) => v === "1" || v === "true" || v === "on";
          if (attr(c, "beforeAutospacing") != null) pp.spBeforeAuto = yes(attr(c, "beforeAutospacing"));
          if (attr(c, "afterAutospacing") != null) pp.spAfterAuto = yes(attr(c, "afterAutospacing"));
          const line = attr(c, "line");
          if (line != null) {
            const rule = (attr(c, "lineRule") ?? "auto") as ParaProps["lineRule"];
            pp.lineRule = rule;
            pp.line = rule === "auto" ? num(line, 240) / 240 : twip(line);
          }
          break;
        }
        case "ind": {
          const left = attr(c, "start") ?? attr(c, "left");
          const right = attr(c, "end") ?? attr(c, "right");
          if (left != null) pp.indLeft = twip(left);
          if (right != null) pp.indRight = twip(right);
          const hanging = attr(c, "hanging");
          const first = attr(c, "firstLine");
          if (hanging != null) {
            pp.indHanging = twip(hanging);
            pp.indFirst = undefined;
          } else if (first != null) {
            pp.indFirst = twip(first);
            pp.indHanging = undefined;
          }
          break;
        }
        case "contextualSpacing":
          pp.contextual = onOff(c);
          break;
        case "jc":
          pp.align = attr(c, "val") ?? "left";
          break;
        case "outlineLvl":
          pp.outlineLvl = num(attr(c, "val"), 9);
          break;
        case "bidi":
          pp.bidi = onOff(c);
          break;
        case "suppressLineNumbers":
          pp.suppressLineNumbers = onOff(c);
          break;
        case "framePr":
          pp.frame = clean({
            dropCap: attr(c, "dropCap") ?? undefined,
            lines: attr(c, "lines") != null ? num(attr(c, "lines")) : undefined,
            x: attr(c, "x") != null ? twip(attr(c, "x")) : undefined,
            y: attr(c, "y") != null ? twip(attr(c, "y")) : undefined,
            w: attr(c, "w") != null ? twip(attr(c, "w")) : undefined,
            h: attr(c, "h") != null ? twip(attr(c, "h")) : undefined,
            hAnchor: attr(c, "hAnchor") ?? undefined,
            vAnchor: attr(c, "vAnchor") ?? undefined,
            xAlign: attr(c, "xAlign") ?? undefined,
            yAlign: attr(c, "yAlign") ?? undefined,
            wrap: attr(c, "wrap") ?? undefined,
          });
          break;
      }
    }
    return pp;
  }
}

export function mergeRP(a: RunProps, b: RunProps): RunProps {
  const out: RunProps = { ...a, ...clean(b) };
  if (a.fonts || b.fonts) out.fonts = { ...a.fonts, ...b.fonts };
  return out;
}

function mergeTabs(a: TabStop[] = [], b: TabStop[] = []): TabStop[] {
  let out = a.slice();
  for (const t of b) {
    out = out.filter((x) => Math.abs(x.pos - t.pos) > 0.5);
    if (t.val !== "clear") out.push(t);
  }
  return out.sort((x, y) => x.pos - y.pos);
}

export function mergePP(a: ParaProps, b: ParaProps): ParaProps {
  const cb = clean(b);
  const out: ParaProps = { ...a, ...cb };
  if ("indFirst" in b && b.indFirst !== undefined) out.indHanging = undefined;
  if ("indHanging" in b && b.indHanging !== undefined) out.indFirst = undefined;
  if (a.borders || b.borders) out.borders = { ...a.borders, ...b.borders };
  if (a.tabs || b.tabs) out.tabs = mergeTabs(a.tabs, b.tabs);
  return out;
}

/* ---------------------------------------------------------------- styles */

type CondPart = { pp: ParaProps; rp: RunProps; cell: Partial<CellProps> & { borders?: CellBorders }; tblBorders?: CellBorders; row?: { header?: boolean; cantSplit?: boolean } };
type StyleDef = {
  id: string;
  type: string;
  name: string;
  basedOn?: string;
  isDefault: boolean;
  pp: ParaProps;
  rp: RunProps;
  tbl?: { tp: Partial<TableProps>; cell: Partial<CellProps>; cond: Map<string, CondPart>; rowBand: number; colBand: number };
};

class Styles {
  defs = new Map<string, StyleDef>();
  defaults = { pp: {} as ParaProps, rp: {} as RunProps };
  defaultPara?: string;
  defaultChar?: string;
  defaultTable?: string;
  private paraCache = new Map<string, { pp: ParaProps; rp: RunProps }>();
  private charCache = new Map<string, RunProps>();
  private tblCache = new Map<string, NonNullable<StyleDef["tbl"]>>();

  constructor(doc: Document | null, private P: Props) {
    if (!doc) return;
    const root = doc.documentElement;
    const dd = kid(root, "docDefaults");
    this.defaults.rp = P.rPr(path(dd, "rPrDefault", "rPr"));
    this.defaults.pp = P.pPr(path(dd, "pPrDefault", "pPr"));
    for (const s of kids(root, "style")) {
      const id = attr(s, "styleId") ?? "";
      const type = attr(s, "type") ?? "paragraph";
      const def: StyleDef = {
        id,
        type,
        name: attr(kid(s, "name"), "val") ?? id,
        basedOn: attr(kid(s, "basedOn"), "val") ?? undefined,
        isDefault: attr(s, "default") === "1" || attr(s, "default") === "true",
        pp: P.pPr(kid(s, "pPr")),
        rp: P.rPr(kid(s, "rPr")),
      };
      if (type === "table") def.tbl = this.readTableStyle(s);
      this.defs.set(id, def);
      if (def.isDefault && type === "paragraph") this.defaultPara = id;
      if (def.isDefault && type === "character") this.defaultChar = id;
      if (def.isDefault && type === "table") this.defaultTable = id;
    }
  }

  private readTableStyle(s: El): NonNullable<StyleDef["tbl"]> {
    const P = this.P;
    const tblPr = kid(s, "tblPr");
    const tp: Partial<TableProps> = clean({
      borders: tblPr ? P.sides(kid(tblPr, "tblBorders")) : undefined,
      cellMargins: tblPr ? P.margins(kid(tblPr, "tblCellMar")) : undefined,
      shading: P.shading(kid(tblPr, "shd")),
      align: attr(kid(tblPr, "jc"), "val") ?? undefined,
      indent: kid(tblPr, "tblInd") ? twip(attr(kid(tblPr, "tblInd"), "w")) : undefined,
    });
    const cond = new Map<string, CondPart>();
    for (const c of kids(s, "tblStylePr")) {
      const type = attr(c, "type") ?? "";
      const tcPr = kid(c, "tcPr");
      cond.set(type, {
        pp: P.pPr(kid(c, "pPr")),
        rp: P.rPr(kid(c, "rPr")),
        cell: clean({ borders: tcPr ? P.sides(kid(tcPr, "tcBorders")) : undefined, shading: P.shading(kid(tcPr, "shd")), vAlign: attr(kid(tcPr, "vAlign"), "val") ?? undefined }),
        tblBorders: kid(kid(c, "tblPr"), "tblBorders") ? P.sides(kid(kid(c, "tblPr"), "tblBorders")) : undefined,
      });
    }
    const tcPr = kid(s, "tcPr");
    return {
      tp,
      cell: clean({ shading: P.shading(kid(tcPr, "shd")), vAlign: attr(kid(tcPr, "vAlign"), "val") ?? undefined, borders: tcPr && kid(tcPr, "tcBorders") ? P.sides(kid(tcPr, "tcBorders")) : undefined }),
      cond,
      rowBand: num(attr(kid(tblPr, "tblStyleRowBandSize"), "val"), 1) || 1,
      colBand: num(attr(kid(tblPr, "tblStyleColBandSize"), "val"), 1) || 1,
    };
  }

  /** Paragraph style chain merged (without docDefaults). */
  para(id: string | undefined): { pp: ParaProps; rp: RunProps } {
    const sid = id && this.defs.has(id) ? id : this.defaultPara;
    if (!sid) return { pp: {}, rp: {} };
    const hit = this.paraCache.get(sid);
    if (hit) return hit;
    this.paraCache.set(sid, { pp: {}, rp: {} }); // cycle guard
    const def = this.defs.get(sid)!;
    const base = def.basedOn && def.basedOn !== sid && this.defs.get(def.basedOn)?.type === "paragraph" ? this.para(def.basedOn) : { pp: {}, rp: {} };
    const out = { pp: mergePP(base.pp, def.pp), rp: mergeRP(base.rp, def.rp) };
    this.paraCache.set(sid, out);
    return out;
  }

  char(id: string | undefined): RunProps {
    if (!id || !this.defs.has(id)) return {};
    const hit = this.charCache.get(id);
    if (hit) return hit;
    this.charCache.set(id, {});
    const def = this.defs.get(id)!;
    const base = def.basedOn && def.basedOn !== id ? this.char(def.basedOn) : {};
    const out = mergeRP(base, def.rp);
    this.charCache.set(id, out);
    return out;
  }

  table(id: string | undefined): NonNullable<StyleDef["tbl"]> | undefined {
    const sid = id && this.defs.has(id) ? id : this.defaultTable;
    if (!sid) return undefined;
    const hit = this.tblCache.get(sid);
    if (hit) return hit;
    const def = this.defs.get(sid)!;
    const own = def.tbl ?? { tp: {}, cell: {}, cond: new Map<string, CondPart>(), rowBand: 1, colBand: 1 };
    const base = def.basedOn && def.basedOn !== sid && this.defs.get(def.basedOn)?.type === "table" ? this.table(def.basedOn) : undefined;
    const mergeCond = (a: CondPart, b: CondPart): CondPart => ({
      pp: mergePP(a.pp, b.pp),
      rp: mergeRP(a.rp, b.rp),
      cell: { ...a.cell, ...b.cell, borders: a.cell.borders || b.cell.borders ? { ...a.cell.borders, ...b.cell.borders } : undefined },
      tblBorders: a.tblBorders || b.tblBorders ? { ...a.tblBorders, ...b.tblBorders } : undefined,
    });
    const cond = new Map<string, CondPart>(base ? base.cond : []);
    // The style's own pPr/rPr/tcPr make up its whole-table part.
    const explicit = own.cond.get("wholeTable");
    const ownWhole: CondPart = mergeCond({ pp: def.pp, rp: def.rp, cell: own.cell }, explicit ?? { pp: {}, rp: {}, cell: {} });
    for (const [k, v] of [...[...own.cond.entries()].filter(([k]) => k !== "wholeTable"), ["wholeTable", ownWhole] as [string, CondPart]]) {
      const b = cond.get(k);
      cond.set(k, b ? mergeCond(b, v) : v);
    }
    const out: NonNullable<StyleDef["tbl"]> = {
      tp: { ...base?.tp, ...own.tp, borders: { ...base?.tp.borders, ...own.tp.borders }, cellMargins: { ...base?.tp.cellMargins, ...own.tp.cellMargins } },
      cell: { ...base?.cell, ...own.cell },
      cond,
      rowBand: own.rowBand,
      colBand: own.colBand,
    };
    this.tblCache.set(sid, out);
    return out;
  }

  headingLevel(id: string | undefined): number | undefined {
    if (!id) return undefined;
    const lvl = this.para(id).pp.outlineLvl;
    if (lvl !== undefined && lvl < 9) return lvl + 1;
    const name = this.defs.get(id)?.name ?? "";
    const m = /^heading ([1-9])$/i.exec(name);
    if (m) return Number(m[1]);
    if (/^title$/i.test(name)) return undefined;
    return undefined;
  }
}

/* -------------------------------------------------------------- numbering */

function readNumbering(doc: Document | null, P: Props): { abstracts: Map<string, AbstractNum>; nums: Map<string, NumDef>; pics: Map<string, string> } {
  const abstracts = new Map<string, AbstractNum>();
  const nums = new Map<string, NumDef>();
  const pics = new Map<string, string>();
  if (!doc) return { abstracts, nums, pics };
  const root = doc.documentElement;
  const level = (l: El): Level => ({
    start: num(attr(kid(l, "start"), "val"), 1),
    fmt: attr(kid(l, "numFmt"), "val") ?? "decimal",
    text: attr(kid(l, "lvlText"), "val") ?? "",
    restart: kid(l, "lvlRestart") ? num(attr(kid(l, "lvlRestart"), "val")) : undefined,
    legal: onOff(kid(l, "isLgl")) ?? false,
    suffix: attr(kid(l, "suff"), "val") ?? "tab",
    jc: attr(kid(l, "lvlJc"), "val") ?? "left",
    pp: P.pPr(kid(l, "pPr")),
    rp: P.rPr(kid(l, "rPr")),
    picBullet: attr(kid(l, "lvlPicBulletId"), "val") ?? undefined,
  });
  for (const a of kids(root, "abstractNum")) {
    const levels: Level[] = [];
    for (const l of kids(a, "lvl")) levels[num(attr(l, "ilvl"))] = level(l);
    abstracts.set(attr(a, "abstractNumId") ?? "", {
      levels,
      styleLink: attr(kid(a, "styleLink"), "val") ?? undefined,
      numStyleLink: attr(kid(a, "numStyleLink"), "val") ?? undefined,
    });
  }
  for (const n of kids(root, "num")) {
    const overrides = new Map<number, { start?: number; level?: Level }>();
    for (const o of kids(n, "lvlOverride")) {
      const lvlEl = kid(o, "lvl");
      overrides.set(num(attr(o, "ilvl")), clean({ start: kid(o, "startOverride") ? num(attr(kid(o, "startOverride"), "val")) : undefined, level: lvlEl ? level(lvlEl) : undefined }));
    }
    nums.set(attr(n, "numId") ?? "", { abstractId: attr(kid(n, "abstractNumId"), "val") ?? "", overrides });
  }
  for (const pb of kids(root, "numPicBullet")) {
    const id = attr(pb, "numPicBulletId") ?? "";
    const img = pb.getElementsByTagNameNS("*", "imagedata")[0] ?? pb.getElementsByTagNameNS("*", "blip")[0];
    const rid = attr(img, "id") ?? attr(img, "embed");
    if (rid) pics.set(id, rid);
  }
  return { abstracts, nums, pics };
}

/* --------------------------------------------------------------- settings */

function readSettings(doc: Document | null): Settings {
  const root = doc?.documentElement ?? null;
  const compat = kid(root, "compat");
  let mode = 12;
  for (const cs of kids(compat, "compatSetting")) if (attr(cs, "name") === "compatibilityMode") mode = num(attr(cs, "val"), 12);
  const fp = kid(root, "footnotePr");
  const ep = kid(root, "endnotePr");
  return {
    defaultTab: kid(root, "defaultTabStop") ? twip(attr(kid(root, "defaultTabStop"), "val")) || 36 : 36,
    evenAndOdd: onOff(kid(root, "evenAndOddHeaders")) ?? false,
    sumSpacing: onOff(kid(compat, "doNotUseHTMLParagraphAutoSpacing")) ?? false,
    footnoteFmt: attr(kid(fp, "numFmt"), "val") ?? "decimal",
    footnoteStart: num(attr(kid(fp, "numStart"), "val"), 1),
    footnoteRestart: attr(kid(fp, "numRestart"), "val") ?? undefined,
    endnoteFmt: attr(kid(ep, "numFmt"), "val") ?? "lowerRoman",
    compatMode: mode,
    mirrorMargins: onOff(kid(root, "mirrorMargins")) ?? false,
    gutterAtTop: onOff(kid(root, "gutterAtTop")) ?? false,
    bordersDoNotSurroundHeader: onOff(kid(root, "bordersDoNotSurroundHeader")) ?? false,
    bordersDoNotSurroundFooter: onOff(kid(root, "bordersDoNotSurroundFooter")) ?? false,
  };
}

/* ----------------------------------------------------------------- reader */

type FieldFrame = { instr: string; phase: "instr" | "result"; mode: "pass" | "collect" | "skip"; result: Inline[]; rp: RunProps; link?: Link; type: string; arg: string; format?: string };

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jpe: "image/jpeg", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", emf: "image/emf", wmf: "image/wmf", svg: "image/svg+xml", webp: "image/webp" };

class Reader {
  P: Props;
  styles: Styles;
  model: DocxModel;
  private fields: FieldFrame[] = [];
  /** Run properties of a table cell's paragraphs, from the table style. */
  private tableCtx: { pp: ParaProps; rp: RunProps } | null = null;

  constructor(public pkg: Package, theme: Theme, stylesDoc: Document | null, model: DocxModel) {
    this.P = new Props(theme);
    this.styles = new Styles(stylesDoc, this.P);
    this.model = model;
  }

  /* ----- media */

  async media(part: Part, rid: string | null | undefined): Promise<string | undefined> {
    if (!rid) return undefined;
    const rel = part.rels.get(rid);
    if (!rel || rel.external) return undefined;
    const p = rel.target;
    if (!this.model.media.has(p)) {
      const bytes = await this.pkg.bytes(p);
      if (!bytes) return undefined;
      const ext = (p.split(".").pop() ?? "").toLowerCase();
      this.model.media.set(p, { bytes, mime: MIME[ext] ?? "application/octet-stream" });
    }
    return p;
  }

  /* ----- blocks */

  async blocks(container: El, part: Part, out: Block[] = [], onSect?: (s: Section, blocks: Block[]) => void): Promise<Block[]> {
    for (const el of Array.from(container.children)) {
      switch (el.localName) {
        case "p": {
          const p = await this.paragraph(el, part);
          out.push(p);
          if (p.sect && onSect) {
            onSect(p.sect, out.splice(0));
          }
          break;
        }
        case "tbl":
          out.push(await this.table(el, part));
          break;
        case "sdt":
          await this.blocks(kid(el, "sdtContent") ?? el, part, out, onSect);
          break;
        case "customXml":
        case "smartTag":
        case "ins":
        case "moveTo":
          await this.blocks(el, part, out, onSect);
          break;
        case "AlternateContent": {
          const pick = this.alternate(el);
          if (pick) await this.blocks(pick, part, out, onSect);
          break;
        }
        case "altChunk":
          this.model.warnings.add("embedded HTML or RTF content");
          break;
      }
    }
    return out;
  }

  alternate(el: El): El | null {
    const ok = new Set(["wps", "wpg", "wpc", "wpi", "w14", "w15", "w16", "wp14", "a14", "v", "o", "w10", "m", "mc", "r", "w", "wp", "a", "pic", "c"]);
    for (const c of kids(el, "Choice")) {
      const req = (attr(c, "Requires") ?? "").split(/\s+/).filter(Boolean);
      if (req.every((r) => ok.has(r))) return c;
    }
    return kid(el, "Fallback");
  }

  /* ----- paragraphs */

  paraProps(pPr: El | null, inTable: boolean): { pp: ParaProps; rp: RunProps; mark: RunProps } {
    const direct = this.P.pPr(pPr);
    const S = this.styles;
    const style = S.para(direct.styleId);
    const isDefaultStyle = !direct.styleId || direct.styleId === S.defaultPara || !S.defs.has(direct.styleId);
    let pp = S.defaults.pp;
    let rp = S.defaults.rp;
    const t = inTable ? this.tableCtx : null;
    if (t && isDefaultStyle) {
      // Word lets a table style win over the Normal style's own settings.
      pp = mergePP(mergePP(pp, style.pp), t.pp);
      rp = mergeRP(mergeRP(rp, style.rp), t.rp);
    } else {
      if (t) {
        pp = mergePP(pp, t.pp);
        rp = mergeRP(rp, t.rp);
      }
      pp = mergePP(pp, style.pp);
      rp = mergeRP(rp, style.rp);
    }
    // Numbering: a level's indents sit between the style and direct formatting
    // (or under the style when the style itself brings the numbering).
    const numId = direct.numId ?? style.pp.numId;
    const ilvl = direct.ilvl ?? style.pp.ilvl ?? 0;
    const lvl = numId && numId !== "0" ? this.level(numId, ilvl) : undefined;
    if (lvl) {
      const lp: ParaProps = { indLeft: lvl.pp.indLeft, indHanging: lvl.pp.indHanging, indFirst: lvl.pp.indFirst, tabs: lvl.pp.tabs, indRight: lvl.pp.indRight };
      if (direct.numId) pp = mergePP(pp, lp);
      else pp = mergePP(mergePP(mergePP(S.defaults.pp, t && !isDefaultStyle ? t.pp : {}), lp), style.pp);
    }
    pp = mergePP(pp, direct);
    if (lvl || numId) {
      pp.numId = numId;
      pp.ilvl = ilvl;
    }
    pp.styleId = direct.styleId ?? S.defaultPara;
    const markDirect = this.P.rPr(kid(pPr, "rPr"));
    const mark = mergeRP(rp, mergeRP(S.char(markDirect.styleId), markDirect));
    return { pp, rp, mark };
  }

  level(numId: string, ilvl: number): Level | undefined {
    const n = this.model.nums.get(numId);
    if (!n) return undefined;
    const o = n.overrides.get(ilvl);
    if (o?.level) return o.level;
    let a = this.model.abstracts.get(n.abstractId);
    for (let i = 0; i < 3 && a?.numStyleLink; i++) {
      const linked = this.styles.para(a.numStyleLink).pp.numId;
      const ln = linked ? this.model.nums.get(linked) : undefined;
      a = ln ? this.model.abstracts.get(ln.abstractId) : undefined;
    }
    return a?.levels[ilvl];
  }

  async paragraph(el: El, part: Part): Promise<Para> {
    const pPr = kid(el, "pPr");
    const inTable = !!this.tableCtx;
    const { pp, rp, mark } = this.paraProps(pPr, inTable);
    const inlines: Inline[] = [];
    await this.inlines(el, part, rp, inlines, undefined);
    const para: Para = { kind: "p", pp, mark, inlines, inTable };
    const sectPr = kid(pPr, "sectPr");
    if (sectPr) para.sect = this.section(sectPr, part);
    return para;
  }

  private emit(out: Inline[], item: Inline) {
    // Inside a field's instruction nothing shows; a field we compute ourselves
    // (page numbers) collects its cached result instead of showing it.
    for (const f of this.fields) if (f.phase === "instr" || f.mode === "skip") return;
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i];
      if (f.mode === "collect") {
        f.result.push(item);
        return;
      }
    }
    // Pass-through field results (TOC entries) take the field's hyperlink.
    const link = [...this.fields].reverse().find((x) => x.link)?.link;
    if (link && (item.kind === "text" || item.kind === "tab" || item.kind === "drawing") && !item.link) item.link = link;
    out.push(item);
  }

  async inlines(container: El, part: Part, paraRp: RunProps, out: Inline[], link: Link | undefined) {
    for (const el of Array.from(container.children)) {
      switch (el.localName) {
        case "pPr":
          break;
        case "r":
          await this.run(el, part, paraRp, out, link);
          break;
        case "hyperlink": {
          const rid = attr(el, "id");
          const anchor = attr(el, "anchor");
          const rel = rid ? part.rels.get(rid) : undefined;
          const l: Link | undefined = rel?.external ? { url: rel.target + (anchor ? `#${anchor}` : "") } : anchor ? { anchor } : link;
          await this.inlines(el, part, paraRp, out, l);
          break;
        }
        case "fldSimple": {
          const instr = attr(el, "instr") ?? "";
          this.beginField(paraRp);
          const f = this.fields[this.fields.length - 1];
          f.instr = instr;
          this.separateField();
          await this.inlines(el, part, paraRp, out, link);
          this.endField(out);
          break;
        }
        case "sdt": {
          const content = kid(el, "sdtContent");
          const check = el.getElementsByTagNameNS("*", "checkbox")[0];
          if (check && content) {
            // Content controls show their own ☐/☒ characters; keep them.
            await this.inlines(content, part, paraRp, out, link);
          } else if (content) await this.inlines(content, part, paraRp, out, link);
          break;
        }
        case "smartTag":
        case "customXml":
        case "ins":
        case "moveTo":
        case "dir":
        case "bdo":
          await this.inlines(el, part, paraRp, out, link);
          break;
        case "bookmarkStart": {
          const name = attr(el, "name");
          if (name && name !== "_GoBack") this.emit(out, { kind: "bookmark", name });
          break;
        }
        case "oMathPara":
        case "oMath":
          this.math(el, paraRp, out);
          break;
        case "AlternateContent": {
          const pick = this.alternate(el);
          if (pick) await this.inlines(pick, part, paraRp, out, link);
          break;
        }
      }
    }
  }

  /** Equations as plain text: readable, if not typeset. */
  math(el: El, paraRp: RunProps, out: Inline[]) {
    const rp = mergeRP(paraRp, { fonts: { ascii: "Cambria Math", hAnsi: "Cambria Math" }, italic: true });
    const walk = (n: El): string => {
      if (n.localName === "t") return n.textContent ?? "";
      if (n.localName === "f") {
        const a = walk(kid(n, "num") ?? n);
        const b = walk(kid(n, "den") ?? n);
        return `(${a})/(${b})`;
      }
      if (n.localName === "sSup") return walk(kid(n, "e") ?? n) + "^" + walk(kid(n, "sup") ?? n);
      if (n.localName === "sSub") return walk(kid(n, "e") ?? n) + "_" + walk(kid(n, "sub") ?? n);
      if (n.localName === "rad") return "√(" + walk(kid(n, "e") ?? n) + ")";
      return Array.from(n.children).map(walk).join("");
    };
    const text = walk(el);
    if (text) this.emit(out, { kind: "text", text, rp });
  }

  runProps(rPr: El | null, paraRp: RunProps): RunProps {
    const direct = this.P.rPr(rPr);
    const styled = mergeRP(paraRp, this.styles.char(direct.styleId ?? this.styles.defaultChar));
    return mergeRP(styled, direct);
  }

  async run(el: El, part: Part, paraRp: RunProps, out: Inline[], link: Link | undefined) {
    const rPr = kid(el, "rPr");
    const rp = this.runProps(rPr, paraRp);
    for (const c of Array.from(el.children)) {
      switch (c.localName) {
        case "t": {
          const raw = c.textContent ?? "";
          if (!raw) break;
          const sym = mapSymbols(raw, rp.fonts?.ascii ?? rp.fonts?.hAnsi);
          const text = sym ?? raw;
          this.emit(out, { kind: "text", text, rp: sym ? { ...rp, fonts: { ...rp.fonts, ascii: "Symbol Mapped", hAnsi: "Symbol Mapped" } } : rp, link });
          break;
        }
        case "instrText": {
          const f = this.fields[this.fields.length - 1];
          if (f && f.phase === "instr") f.instr += c.textContent ?? "";
          break;
        }
        case "tab":
          this.emit(out, { kind: "tab", rp, link });
          break;
        case "ptab":
          this.emit(out, { kind: "tab", rp, link, ptab: { align: attr(c, "alignment") ?? "left", leader: attr(c, "leader") ?? undefined, relativeTo: attr(c, "relativeTo") ?? undefined } });
          break;
        case "br": {
          const type = attr(c, "type") ?? "textWrapping";
          this.emit(out, { kind: "br", type: type === "page" ? "page" : type === "column" ? "column" : "line", rp });
          break;
        }
        case "cr":
          this.emit(out, { kind: "br", type: "line", rp });
          break;
        case "noBreakHyphen":
          this.emit(out, { kind: "text", text: "\u2011", rp, link });
          break;
        case "softHyphen":
          this.emit(out, { kind: "text", text: "\u00ad", rp, link });
          break;
        case "sym": {
          const font = attr(c, "font") ?? undefined;
          const ch = symChar(font, attr(c, "char") ?? "");
          if (ch) this.emit(out, { kind: "text", text: ch, rp: isSymbolFont(font) ? { ...rp, fonts: { ascii: "Symbol Mapped", hAnsi: "Symbol Mapped" } } : rp, link });
          break;
        }
        case "fldChar": {
          const t = attr(c, "fldCharType");
          if (t === "begin") {
            this.beginField(rp);
            const ff = kid(c, "ffData");
            if (ff && kid(ff, "checkBox")) {
              const cb = kid(ff, "checkBox")!;
              const checked = onOff(kid(cb, "checked")) ?? onOff(kid(cb, "default")) ?? false;
              this.fields[this.fields.length - 1].type = "FORMCHECKBOX";
              this.fields[this.fields.length - 1].arg = checked ? "1" : "0";
            }
          } else if (t === "separate") this.separateField();
          else if (t === "end") this.endField(out);
          break;
        }
        case "drawing": {
          const d = await this.drawing(c, part, rp);
          if (d) this.emit(out, { kind: "drawing", d, rp, link });
          break;
        }
        case "pict":
        case "object": {
          for (const d of await this.vml(c, part, rp)) this.emit(out, { kind: "drawing", d, rp, link });
          break;
        }
        case "AlternateContent": {
          const pick = this.alternate(c);
          if (pick) {
            const fake = el.ownerDocument.createElementNS(el.namespaceURI, el.prefix ? `${el.prefix}:r` : "r");
            if (rPr) fake.appendChild(rPr.cloneNode(true));
            for (const k of Array.from(pick.children)) fake.appendChild(k.cloneNode(true));
            await this.run(fake, part, paraRp, out, link);
          }
          break;
        }
        case "footnoteReference":
        case "endnoteReference": {
          const id = attr(c, "id") ?? "";
          const cmf = attr(c, "customMarkFollows");
          const custom = cmf === "1" || cmf === "true" || cmf === "on" ? "custom" : undefined;
          this.emit(out, { kind: "noteRef", note: c.localName === "footnoteReference" ? "footnote" : "endnote", id, rp, custom });
          break;
        }
        case "footnoteRef":
        case "endnoteRef":
          this.emit(out, { kind: "noteMark", rp });
          break;
        case "pgNum":
          this.emit(out, { kind: "field", field: "PAGE", rp, text: "1" });
          break;
        case "lastRenderedPageBreak":
        case "separator":
        case "continuationSeparator":
        case "annotationRef":
        case "commentReference":
          break;
      }
    }
  }

  beginField(rp: RunProps) {
    this.fields.push({ instr: "", phase: "instr", mode: "pass", result: [], rp, type: "", arg: "" });
  }

  separateField() {
    const f = this.fields[this.fields.length - 1];
    if (!f) return;
    f.phase = "result";
    this.classify(f);
  }

  private classify(f: FieldFrame) {
    const instr = f.instr.trim();
    const type = f.type || (instr.split(/\s+/)[0] ?? "").toUpperCase();
    f.type = type;
    const fmt = /\\\*\s*(\w+)/.exec(instr)?.[1];
    if (fmt && !/^MERGEFORMAT|CHARFORMAT$/i.test(fmt)) f.format = fmt;
    if (type === "PAGE" || type === "NUMPAGES" || type === "SECTIONPAGES" || type === "FORMCHECKBOX") f.mode = "collect";
    else if (type === "HYPERLINK") {
      const anchor = /\\l\s+"([^"]+)"/.exec(instr)?.[1];
      const url = /^HYPERLINK\s+"([^"]+)"/i.exec(instr)?.[1] ?? /^HYPERLINK\s+(\S+)/i.exec(instr)?.[1];
      f.link = url && !url.startsWith("\\") ? { url: url + (anchor ? `#${anchor}` : "") } : anchor ? { anchor } : undefined;
      f.mode = "pass";
    } else f.mode = "pass";
  }

  endField(out: Inline[]) {
    const f = this.fields.pop();
    if (!f) return;
    if (f.phase === "instr") this.classify(f);
    const text = f.result.map((x) => (x.kind === "text" ? x.text : "")).join("");
    const rp = (f.result.find((x) => x.kind === "text") as { rp: RunProps } | undefined)?.rp ?? f.rp;
    if (f.type === "PAGE" || f.type === "NUMPAGES" || f.type === "SECTIONPAGES") this.emit(out, { kind: "field", field: f.type, format: f.format, rp, text: text || "1" });
    else if (f.type === "FORMCHECKBOX") this.emit(out, { kind: "check", checked: f.arg === "1", rp: f.rp });
  }

  /* ----- tables */

  async table(el: El, part: Part): Promise<Table> {
    const P = this.P;
    const tblPr = kid(el, "tblPr");
    const styleId = attr(kid(tblPr, "tblStyle"), "val") ?? undefined;
    const ts = this.styles.table(styleId);
    const direct: Partial<TableProps> = clean({
      width: kid(tblPr, "tblW") ? { type: attr(kid(tblPr, "tblW"), "type") ?? "dxa", value: num(attr(kid(tblPr, "tblW"), "w")) } : undefined,
      align: attr(kid(tblPr, "jc"), "val") ?? undefined,
      indent: kid(tblPr, "tblInd") ? twip(attr(kid(tblPr, "tblInd"), "w")) : undefined,
      layout: attr(kid(tblPr, "tblLayout"), "type") ?? undefined,
      spacing: kid(tblPr, "tblCellSpacing") ? twip(attr(kid(tblPr, "tblCellSpacing"), "w")) : undefined,
      shading: P.shading(kid(tblPr, "shd")),
      bidi: onOff(kid(tblPr, "bidiVisual")),
    });
    const tpp = kid(tblPr, "tblpPr");
    const tp: TableProps = {
      ...ts?.tp,
      ...direct,
      styleId,
      borders: { ...ts?.tp.borders, ...(kid(tblPr, "tblBorders") ? P.sides(kid(tblPr, "tblBorders")) : {}) },
      cellMargins: { left: 5.4, right: 5.4, top: 0, bottom: 0, ...ts?.tp.cellMargins, ...P.margins(kid(tblPr, "tblCellMar")) },
    };
    if (tpp) {
      tp.floating = clean({
        x: attr(tpp, "tblpX") != null ? twip(attr(tpp, "tblpX")) : undefined,
        y: attr(tpp, "tblpY") != null ? twip(attr(tpp, "tblpY")) : undefined,
        xAlign: attr(tpp, "tblpXSpec") ?? undefined,
        yAlign: attr(tpp, "tblpYSpec") ?? undefined,
        hAnchor: attr(tpp, "horzAnchor") ?? undefined,
        vAnchor: attr(tpp, "vertAnchor") ?? undefined,
        left: twip(attr(tpp, "leftFromText")),
        right: twip(attr(tpp, "rightFromText")),
        top: twip(attr(tpp, "topFromText")),
        bottom: twip(attr(tpp, "bottomFromText")),
      });
    }
    const look = this.look(kid(tblPr, "tblLook"));
    const grid = kids(kid(el, "tblGrid"), "gridCol").map((g) => twip(attr(g, "w")));
    // Rows inside content controls or customXml keep their order with plain rows.
    const rowEls: El[] = [];
    for (const c of Array.from(el.children)) {
      if (c.localName === "tr") rowEls.push(c);
      else if (c.localName === "sdt") rowEls.push(...kids(kid(c, "sdtContent"), "tr"));
      else if (c.localName === "customXml") rowEls.push(...kids(c, "tr"));
    }
    const nRows = rowEls.length;
    const rows: Row[] = [];
    const saved = this.tableCtx;
    let headerRows = 0;
    for (let ri = 0; ri < nRows; ri++) {
      const tr = rowEls[ri];
      const trPr = kid(tr, "trPr");
      const header = onOff(kid(trPr, "tblHeader")) ?? false;
      if (header && ri === headerRows) headerRows++;
      const hEl = kid(trPr, "trHeight");
      const row: Row = {
        cells: [],
        header: header && ri === headerRows - 1,
        cantSplit: onOff(kid(trPr, "cantSplit")) ?? false,
        height: hEl ? { value: twip(attr(hEl, "val")), rule: attr(hEl, "hRule") ?? "atLeast" } : undefined,
        gridBefore: num(attr(kid(trPr, "gridBefore"), "val")),
        gridAfter: num(attr(kid(trPr, "gridAfter"), "val")),
      };
      const tcs: El[] = [];
      for (const c of Array.from(tr.children)) {
        if (c.localName === "tc") tcs.push(c);
        else if (c.localName === "sdt") tcs.push(...kids(kid(c, "sdtContent"), "tc"));
        else if (c.localName === "customXml") tcs.push(...kids(c, "tc"));
      }
      let col = row.gridBefore ?? 0;
      const lastCol = Math.max(grid.length, 1) - 1;
      for (let ci = 0; ci < tcs.length; ci++) {
        const tc = tcs[ci];
        const tcPr = kid(tc, "tcPr");
        const span = Math.max(1, num(attr(kid(tcPr, "gridSpan"), "val"), 1));
        const conds = this.conditions(ts, look, ri, nRows, col, col + span - 1, lastCol, headerRows);
        // Cell-level style parts in order, then direct formatting.
        const cellStyle: Partial<CellProps> & { borders?: CellBorders } = { ...ts?.cell };
        let cpp: ParaProps = {};
        let crp: RunProps = {};
        let borders = this.tableEdges(tp.borders, ri, nRows, col, col + span - 1, lastCol);
        for (const c of conds) {
          const part2 = ts?.cond.get(c);
          if (!part2) continue;
          cpp = mergePP(cpp, part2.pp);
          crp = mergeRP(crp, part2.rp);
          if (part2.cell.shading) cellStyle.shading = part2.cell.shading;
          if (part2.cell.vAlign) cellStyle.vAlign = part2.cell.vAlign;
          const tb = part2.tblBorders;
          if (tb) borders = { ...borders, ...this.tableEdges(tb, ri, nRows, col, col + span - 1, lastCol, true) };
          const cb = part2.cell.borders;
          if (cb) borders = { ...borders, ...this.condEdges(cb, c, ri, nRows, col, col + span - 1, lastCol, headerRows) };
        }
        const directBorders = tcPr && kid(tcPr, "tcBorders") ? P.sides(kid(tcPr, "tcBorders")) : {};
        borders = { ...borders, ...clean({ top: directBorders.top, bottom: directBorders.bottom, left: directBorders.left, right: directBorders.right, tl2br: directBorders.tl2br, tr2bl: directBorders.tr2bl }) };
        const vm = kid(tcPr, "vMerge");
        const tcW = kid(tcPr, "tcW");
        const cp: CellProps = {
          span,
          width: tcW ? { type: attr(tcW, "type") ?? "dxa", value: num(attr(tcW, "w")) } : undefined,
          vMerge: vm ? ((attr(vm, "val") ?? "continue") === "restart" ? "restart" : "continue") : undefined,
          borders,
          shading: P.shading(kid(tcPr, "shd")) ?? cellStyle.shading ?? tp.shading,
          margins: { ...tp.cellMargins, ...P.margins(kid(tcPr, "tcMar")) },
          vAlign: attr(kid(tcPr, "vAlign"), "val") ?? cellStyle.vAlign,
          textDirection: attr(kid(tcPr, "textDirection"), "val") ?? undefined,
          noWrap: onOff(kid(tcPr, "noWrap")),
          hideMark: onOff(kid(tcPr, "hideMark")),
        };
        this.tableCtx = { pp: mergePP(ts?.cond.get("wholeTable")?.pp ?? {}, cpp), rp: mergeRP(ts?.cond.get("wholeTable")?.rp ?? {}, crp) };
        const blocks = await this.blocks(tc, part);
        this.tableCtx = saved;
        row.cells.push({ cp, blocks });
        col += span;
      }
      rows.push(row);
    }
    this.tableCtx = saved;
    return { kind: "tbl", tp, grid, rows };
  }

  look(el: El | null) {
    const v = attr(el, "val");
    const bits = v ? parseInt(v, 16) : 0x04a0;
    const a = (name: string, bit: number) => {
      const x = attr(el, name);
      return x != null ? x === "1" || x === "true" : !!(bits & bit);
    };
    return { firstRow: a("firstRow", 0x20), lastRow: a("lastRow", 0x40), firstCol: a("firstColumn", 0x80), lastCol: a("lastColumn", 0x100), noHBand: a("noHBand", 0x200), noVBand: a("noVBand", 0x400) };
  }

  conditions(ts: ReturnType<Styles["table"]>, look: ReturnType<Reader["look"]>, r: number, nRows: number, c0: number, c1: number, lastCol: number, headerRows: number): string[] {
    if (!ts) return [];
    const out = ["wholeTable"];
    const isFirstRow = look.firstRow && r === 0;
    void headerRows;
    const isLastRow = look.lastRow && r === nRows - 1;
    const isFirstCol = look.firstCol && c0 === 0;
    const isLastCol = look.lastCol && c1 === lastCol;
    if (!look.noVBand && !isFirstCol && !isLastCol) {
      const ci = c0 - (look.firstCol ? 1 : 0);
      out.push(Math.floor(ci / ts.colBand) % 2 === 0 ? "band1Vert" : "band2Vert");
    }
    if (!look.noHBand && !isFirstRow && !isLastRow) {
      const ri = r - (look.firstRow ? 1 : 0);
      out.push(Math.floor(ri / ts.rowBand) % 2 === 0 ? "band1Horz" : "band2Horz");
    }
    if (isFirstCol) out.push("firstCol");
    if (isLastCol) out.push("lastCol");
    if (isFirstRow) out.push("firstRow");
    if (isLastRow) out.push("lastRow");
    if (isFirstRow && isFirstCol) out.push("nwCell");
    if (isFirstRow && isLastCol) out.push("neCell");
    if (isLastRow && isFirstCol) out.push("swCell");
    if (isLastRow && isLastCol) out.push("seCell");
    return out;
  }

  /** A cell's four edges from table-wide borders (outer edges or inside lines). */
  tableEdges(b: CellBorders, r: number, nRows: number, c0: number, c1: number, lastCol: number, sparse = false): CellBorders {
    const out: CellBorders = {
      top: r === 0 ? b.top : b.insideH,
      bottom: r === nRows - 1 ? b.bottom : b.insideH,
      left: c0 === 0 ? b.left : b.insideV,
      right: c1 >= lastCol ? b.right : b.insideV,
    };
    return sparse ? clean(out) : out;
  }

  /** Borders from a conditional part: a row part's inside lines run between its cells, a column part's between its rows. */
  condEdges(b: CellBorders, cond: string, r: number, nRows: number, c0: number, c1: number, lastCol: number, headerRows: number): CellBorders {
    void headerRows;
    const rowPart = cond === "firstRow" || cond === "lastRow" || /Horz$/.test(cond);
    const colPart = cond === "firstCol" || cond === "lastCol" || /Vert$/.test(cond);
    if (cond === "wholeTable") return this.tableEdges(b, r, nRows, c0, c1, lastCol, true);
    if (rowPart) return clean({ top: b.top, bottom: b.bottom, left: c0 === 0 ? b.left : b.insideV, right: c1 >= lastCol ? b.right : b.insideV });
    if (colPart) return clean({ left: b.left, right: b.right, top: r === 0 ? b.top : b.insideH, bottom: r === nRows - 1 ? b.bottom : b.insideH });
    return clean({ top: b.top, bottom: b.bottom, left: b.left, right: b.right });
  }

  /* ----- sections */

  section(el: El, part: Part): Section {
    const pgSz = kid(el, "pgSz");
    const pgMar = kid(el, "pgMar");
    const cols = kid(el, "cols");
    const refs = (name: string) => {
      const out: Section["headers"] = {};
      for (const r of kids(el, name)) {
        const type = (attr(r, "type") ?? "default") as "default" | "first" | "even";
        const rel = part.rels.get(attr(r, "id") ?? "");
        if (rel) out[type] = rel.target;
      }
      return out;
    };
    const colEls = kids(cols, "col");
    const pgNum = kid(el, "pgNumType");
    const pb = kid(el, "pgBorders");
    const w = twip(attr(pgSz, "w"), 612);
    const h = twip(attr(pgSz, "h"), 792);
    return {
      pageW: w,
      pageH: h,
      orient: attr(pgSz, "orient") ?? undefined,
      margin: {
        top: Math.abs(twip(attr(pgMar, "top"), 72)),
        right: twip(attr(pgMar, "right") ?? attr(pgMar, "end"), 72),
        bottom: Math.abs(twip(attr(pgMar, "bottom"), 72)),
        left: twip(attr(pgMar, "left") ?? attr(pgMar, "start"), 72),
        header: twip(attr(pgMar, "header"), 36),
        footer: twip(attr(pgMar, "footer"), 36),
        gutter: twip(attr(pgMar, "gutter")),
      },
      cols: {
        num: Math.max(1, num(attr(cols, "num"), colEls.length || 1)),
        space: twip(attr(cols, "space"), 36),
        sep: ["1", "true", "on"].includes(attr(cols, "sep") ?? ""),
        equal: colEls.length ? attr(cols, "equalWidth") === "1" || attr(cols, "equalWidth") === "true" : true,
        widths: colEls.length ? colEls.map((c) => ({ w: twip(attr(c, "w")), space: twip(attr(c, "space")) })) : undefined,
      },
      titlePg: onOff(kid(el, "titlePg")) ?? false,
      headers: refs("headerReference"),
      footers: refs("footerReference"),
      pgNumStart: attr(pgNum, "start") != null ? num(attr(pgNum, "start")) : undefined,
      pgNumFmt: attr(pgNum, "fmt") ?? undefined,
      type: attr(kid(el, "type"), "val") ?? "nextPage",
      vAlign: attr(kid(el, "vAlign"), "val") ?? undefined,
      pgBorders: pb
        ? { ...clean(this.P.sides(pb) as Sides<Border>), offsetFrom: attr(pb, "offsetFrom") ?? "text", display: attr(pb, "display") ?? "allPages", zOrder: attr(pb, "zOrder") ?? "front" }
        : undefined,
      bidi: onOff(kid(el, "bidi")),
    };
  }

  /* ----- drawings (DrawingML) */

  async drawing(el: El, part: Part, _rp: RunProps): Promise<Drawing | null> {
    const host = kid(el, "inline") ?? kid(el, "anchor");
    if (!host) return null;
    const anchor = host.localName === "anchor";
    const ext = kid(host, "extent");
    const w = emu(attr(ext, "cx"));
    const h = emu(attr(ext, "cy"));
    const docPr = kid(host, "docPr");
    if (attr(docPr, "hidden") === "1" || attr(docPr, "hidden") === "true") return null;
    const dist = { top: emu(attr(host, "distT")), bottom: emu(attr(host, "distB")), left: emu(attr(host, "distL")), right: emu(attr(host, "distR")) };
    const place: Placement = { mode: anchor ? "anchor" : "inline", dist };
    if (anchor) {
      const ph = kid(host, "positionH");
      const pv = kid(host, "positionV");
      place.hRel = attr(ph, "relativeFrom") ?? "column";
      place.hAlign = kid(ph, "align")?.textContent ?? undefined;
      place.hOffset = kid(ph, "posOffset") ? emu(kid(ph, "posOffset")!.textContent) : undefined;
      place.vRel = attr(pv, "relativeFrom") ?? "paragraph";
      place.vAlign = kid(pv, "align")?.textContent ?? undefined;
      place.vOffset = kid(pv, "posOffset") ? emu(kid(pv, "posOffset")!.textContent) : undefined;
      if (attr(host, "simplePos") === "1") {
        const sp = kid(host, "simplePos");
        place.hRel = "page";
        place.vRel = "page";
        place.hOffset = emu(attr(sp, "x"));
        place.vOffset = emu(attr(sp, "y"));
      }
      const wrapEl = ["wrapNone", "wrapSquare", "wrapTight", "wrapThrough", "wrapTopAndBottom"].map((n) => kid(host, n)).find(Boolean);
      place.wrap = (wrapEl?.localName.replace(/^wrap/, "").replace(/^./, (c) => c.toLowerCase()) ?? "none") as Placement["wrap"];
      place.wrapSide = attr(wrapEl, "wrapText") ?? undefined;
      place.behind = attr(host, "behindDoc") === "1" || attr(host, "behindDoc") === "true";
      place.z = num(attr(host, "relativeHeight"));
      place.inCell = attr(host, "layoutInCell") !== "0";
    }
    const gd = path(host, "graphic", "graphicData");
    if (!gd) return null;
    const node = await this.graphic(gd, part, w, h);
    if (!node) return null;
    const out: Drawing = { w, h, place, node: node.node, alt: attr(docPr, "descr") ?? undefined, partial: node.partial };
    const relW = host.getElementsByTagNameNS("*", "sizeRelH")[0];
    const relH = host.getElementsByTagNameNS("*", "sizeRelV")[0];
    const pctW = relW?.getElementsByTagNameNS("*", "pctWidth")[0]?.textContent;
    const pctH = relH?.getElementsByTagNameNS("*", "pctHeight")[0]?.textContent;
    if (pctW && Number(pctW) > 0) out.relW = { pct: Number(pctW) / 100000, rel: attr(relW, "relativeFrom") ?? "margin" };
    if (pctH && Number(pctH) > 0) out.relH = { pct: Number(pctH) / 100000, rel: attr(relH, "relativeFrom") ?? "margin" };
    if (node.node.kind === "shape" && node.node.text?.autofit) out.autofit = true;
    return out;
  }

  async graphic(gd: El, part: Part, w: number, h: number): Promise<{ node: ShapeNode | GroupNode; partial?: string } | null> {
    const first = gd.firstElementChild;
    if (!first) return null;
    switch (first.localName) {
      case "pic":
        return { node: await this.picture(first, part, { x: 0, y: 0, w, h }) };
      case "wsp":
        return { node: await this.shape(first, part, { x: 0, y: 0, w, h }) };
      case "wgp":
      case "wpc":
        return { node: await this.group(first, part, { x: 0, y: 0, w, h }) };
      case "chart": {
        const rel = part.rels.get(attr(first, "id") ?? "");
        const doc = rel && !rel.external ? await this.pkg.xml(rel.target) : null;
        if (doc && rel) {
          this.model.charts.set(rel.target, doc);
          return { node: { kind: "shape", x: 0, y: 0, w, h, geom: "rect", chart: rel.target } };
        }
        this.model.warnings.add("charts");
        return { node: { kind: "shape", x: 0, y: 0, w, h, geom: "rect", line: { color: "BFBFBF", width: 0.75 } }, partial: "chart" };
      }
      case "relIds": {
        const sa = await this.smartArt(first, part, w, h);
        if (sa) return { node: sa };
        this.model.warnings.add("SmartArt");
        return { node: { kind: "shape", x: 0, y: 0, w, h, geom: "rect" }, partial: "smartart" };
      }
      default:
        return null;
    }
  }

  async smartArt(el: El, part: Part, w: number, h: number): Promise<GroupNode | null> {
    // SmartArt keeps a ready-drawn copy of its shapes (diagrams/drawingN.xml).
    const dm = part.rels.get(attr(el, "dm") ?? "");
    if (!dm) return null;
    const dataPart = await this.pkg.part(dm.target);
    if (!dataPart) return null;
    let drawingPath: string | undefined;
    const ext = dataPart.doc.getElementsByTagNameNS("*", "dataModelExt")[0];
    const relId = attr(ext, "relId");
    if (relId) drawingPath = part.rels.get(relId)?.target;
    if (!drawingPath) for (const r of part.rels.values()) if (/diagramDrawing$/.test(r.type)) drawingPath = r.target;
    if (!drawingPath) return null;
    const dPart = await this.pkg.part(drawingPath);
    const tree = dPart?.doc.getElementsByTagNameNS("*", "spTree")[0];
    if (!dPart || !tree) return null;
    const children: (ShapeNode | GroupNode)[] = [];
    for (const sp of kids(tree, "sp")) {
      const s = await this.shape(sp, dPart, { x: 0, y: 0, w, h }, true);
      children.push(s);
    }
    return { kind: "group", x: 0, y: 0, w, h, children };
  }

  xfrm(spPr: El | null, box: { x: number; y: number; w: number; h: number }) {
    const x = kid(spPr, "xfrm");
    const off = kid(x, "off");
    const ext = kid(x, "ext");
    return {
      x: off ? emu(attr(off, "x")) : box.x,
      y: off ? emu(attr(off, "y")) : box.y,
      w: ext ? emu(attr(ext, "cx")) : box.w,
      h: ext ? emu(attr(ext, "cy")) : box.h,
      rot: num(attr(x, "rot")) / 60000 || undefined,
      flipH: attr(x, "flipH") === "1" || undefined,
      flipV: attr(x, "flipV") === "1" || undefined,
    };
  }

  async picture(pic: El, part: Part, box: { x: number; y: number; w: number; h: number }, useXfrm = false): Promise<ShapeNode> {
    const spPr = kid(pic, "spPr");
    const blipFill = kid(pic, "blipFill");
    const blip = kid(blipFill, "blip");
    const src = await this.media(part, attr(blip, "embed") ?? attr(blip, "link"));
    const sr = kid(blipFill, "srcRect");
    const crop = sr ? clean({ left: num(attr(sr, "l")) / 100000, top: num(attr(sr, "t")) / 100000, right: num(attr(sr, "r")) / 100000, bottom: num(attr(sr, "b")) / 100000 }) : undefined;
    const t = useXfrm ? this.xfrm(spPr, box) : { ...box, ...pick(this.xfrm(spPr, box), ["rot", "flipH", "flipV"]) };
    const line = this.line(kid(spPr, "ln"), null);
    const alpha = kid(blip, "alphaModFix") ? num(attr(kid(blip, "alphaModFix"), "amt"), 100000) / 100000 : undefined;
    const node: ShapeNode = { kind: "shape", ...t, geom: attr(kid(spPr, "prstGeom"), "prst") ?? "rect", image: src ? { src, crop } : undefined, line };
    if (alpha !== undefined && alpha < 1) node.fill = { alpha };
    return node;
  }

  fill(spPr: El | null, styleRef: El | null): Fill | undefined {
    const T = this.P.theme;
    if (kid(spPr, "noFill")) return undefined;
    const solid = kid(spPr, "solidFill");
    if (solid) {
      const c = drawingColor(solid, T);
      return c ? { color: c.hex, alpha: c.alpha } : undefined;
    }
    const grad = kid(spPr, "gradFill");
    if (grad) {
      const stops = kids(kid(grad, "gsLst"), "gs").map((g) => {
        const c = drawingColor(g, T);
        return { pos: num(attr(g, "pos")) / 100000, color: c?.hex ?? "FFFFFF", alpha: c?.alpha ?? 1 };
      });
      if (stops.length) return { color: stops[0].color, alpha: stops[0].alpha, gradient: { stops, angle: num(attr(kid(grad, "lin"), "ang")) / 60000 } };
    }
    const patt = kid(spPr, "pattFill");
    if (patt) {
      const c = drawingColor(kid(patt, "fgClr"), T);
      return c ? { color: c.hex, alpha: c.alpha * 0.5 } : undefined;
    }
    if (kid(spPr, "blipFill")) return undefined;
    // No fill of its own: the shape style's fill reference.
    if (styleRef && num(attr(styleRef, "idx")) > 0) {
      const c = drawingColor(styleRef, T);
      return c ? { color: c.hex, alpha: c.alpha } : undefined;
    }
    return undefined;
  }

  line(ln: El | null, styleRef: El | null): Line | undefined {
    const T = this.P.theme;
    if (kid(ln, "noFill")) return undefined;
    const width = ln && attr(ln, "w") != null ? emu(attr(ln, "w")) : undefined;
    const dash = attr(kid(ln, "prstDash"), "val") ?? undefined;
    const head = attr(kid(ln, "headEnd"), "type") ?? undefined;
    const tail = attr(kid(ln, "tailEnd"), "type") ?? undefined;
    const solid = kid(ln, "solidFill") ?? kid(ln, "gradFill")?.getElementsByTagNameNS("*", "gs")[0] ?? null;
    if (solid) {
      const c = drawingColor(solid, T);
      if (c) return { color: c.hex, alpha: c.alpha, width: width ?? 0.75, dash, head, tail };
    }
    if (styleRef && num(attr(styleRef, "idx")) > 0) {
      const c = drawingColor(styleRef, T);
      const idx = num(attr(styleRef, "idx"));
      if (c) return { color: c.hex, alpha: c.alpha, width: width ?? [0.5, 0.5, 1, 1.5][Math.min(3, idx)], dash, head, tail };
    }
    if (ln && width) return { color: "000000", width, dash, head, tail };
    return undefined;
  }

  async shape(sp: El, part: Part, box: { x: number; y: number; w: number; h: number }, useXfrm = false): Promise<ShapeNode> {
    const spPr = kid(sp, "spPr");
    const style = kid(sp, "style");
    const t = useXfrm ? this.xfrm(spPr, box) : { ...box, ...pick(this.xfrm(spPr, box), ["rot", "flipH", "flipV"]) };
    const prst = kid(spPr, "prstGeom");
    const adj: Record<string, number> = {};
    for (const g of kids(kid(prst, "avLst"), "gd")) {
      const m = /val\s+(-?\d+)/.exec(attr(g, "fmla") ?? "");
      if (m) adj[attr(g, "name") ?? ""] = Number(m[1]);
    }
    const node: ShapeNode = {
      kind: "shape",
      ...t,
      geom: prst ? (attr(prst, "prst") ?? "rect") : kid(spPr, "custGeom") ? "custom" : "rect",
      adj: Object.keys(adj).length ? adj : undefined,
      fill: this.fill(spPr, kid(style, "fillRef")),
      line: this.line(kid(spPr, "ln"), kid(style, "lnRef")),
    };
    const cust = kid(spPr, "custGeom");
    if (cust) node.path = this.customPath(cust);
    const blipFill = kid(spPr, "blipFill");
    if (blipFill) {
      const src = await this.media(part, attr(kid(blipFill, "blip"), "embed"));
      if (src) node.image = { src };
    }
    // Text: a Word text box (w:txbxContent) or DrawingML text (SmartArt).
    const bodyPr = kid(sp, "bodyPr");
    const insets = {
      left: emu(attr(bodyPr, "lIns") ?? "91440"),
      top: emu(attr(bodyPr, "tIns") ?? "45720"),
      right: emu(attr(bodyPr, "rIns") ?? "91440"),
      bottom: emu(attr(bodyPr, "bIns") ?? "45720"),
    };
    const anchorV = attr(bodyPr, "anchor") ?? "t";
    const txbx = path(sp, "txbx", "txbxContent");
    if (txbx) {
      const saved = this.tableCtx;
      this.tableCtx = null;
      const blocks = await this.blocks(txbx, part);
      this.tableCtx = saved;
      node.text = { blocks, insets, anchor: anchorV, vertical: attr(bodyPr, "vert") ?? undefined, autofit: !!kid(bodyPr, "spAutoFit"), wrap: attr(bodyPr, "wrap") !== "none" };
    } else {
      const txBody = kid(sp, "txBody");
      if (txBody) {
        const fontRef = kid(style, "fontRef");
        const color = drawingColor(fontRef, this.P.theme)?.hex;
        node.text = { blocks: this.drawingText(txBody, color), insets: { left: emu(attr(kid(txBody, "bodyPr"), "lIns") ?? "91440"), top: emu(attr(kid(txBody, "bodyPr"), "tIns") ?? "45720"), right: emu(attr(kid(txBody, "bodyPr"), "rIns") ?? "91440"), bottom: emu(attr(kid(txBody, "bodyPr"), "bIns") ?? "45720") }, anchor: attr(kid(txBody, "bodyPr"), "anchor") ?? "ctr", wrap: true };
      }
    }
    return node;
  }

  /** DrawingML paragraphs (SmartArt, charts' titles) as model paragraphs. */
  drawingText(txBody: El, color?: string): Block[] {
    const T = this.P.theme;
    const out: Block[] = [];
    for (const p of kids(txBody, "p")) {
      const pPr = kid(p, "pPr");
      const algn = attr(pPr, "algn") ?? "ctr";
      const inlines: Inline[] = [];
      let size = 11;
      for (const r of Array.from(p.children)) {
        if (r.localName !== "r" && r.localName !== "fld") continue;
        const rPr = kid(r, "rPr");
        const c = drawingColor(kid(rPr, "solidFill"), T)?.hex ?? color;
        size = attr(rPr, "sz") ? num(attr(rPr, "sz")) / 100 : size;
        const font = attr(kid(rPr, "latin"), "typeface") ?? undefined;
        const rp: RunProps = clean({ size, bold: attr(rPr, "b") === "1" || undefined, italic: attr(rPr, "i") === "1" || undefined, color: c, fonts: font ? { ascii: font.startsWith("+") ? (font === "+mj-lt" ? T.major.latin : T.minor.latin) : font, hAnsi: font.startsWith("+") ? (font === "+mj-lt" ? T.major.latin : T.minor.latin) : font } : { ascii: T.minor.latin, hAnsi: T.minor.latin } });
        const text = kid(r, "t")?.textContent ?? "";
        if (text) inlines.push({ kind: "text", text, rp });
      }
      out.push({ kind: "p", pp: { align: algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "both" : "left", spAfter: 0, spBefore: 0, line: 0.9, lineRule: "auto" }, mark: { size }, inlines });
    }
    return out;
  }

  customPath(cust: El): ShapeNode["path"] {
    const out: NonNullable<ShapeNode["path"]> = [];
    for (const p of kids(kid(cust, "pathLst"), "path")) {
      const pw = num(attr(p, "w"));
      const ph = num(attr(p, "h"));
      let d = "";
      let cx = 0;
      let cy = 0;
      const pt = (e: El | null) => [num(attr(e, "x")), num(attr(e, "y"))];
      for (const c of Array.from(p.children)) {
        const pts = kids(c, "pt").map(pt);
        switch (c.localName) {
          case "moveTo":
            [cx, cy] = pts[0] ?? [0, 0];
            d += `M ${cx} ${cy} `;
            break;
          case "lnTo":
            [cx, cy] = pts[0] ?? [cx, cy];
            d += `L ${cx} ${cy} `;
            break;
          case "cubicBezTo":
            if (pts.length === 3) {
              d += `C ${pts.flat().join(" ")} `;
              [cx, cy] = pts[2];
            }
            break;
          case "quadBezTo":
            if (pts.length === 2) {
              d += `Q ${pts.flat().join(" ")} `;
              [cx, cy] = pts[1];
            }
            break;
          case "arcTo": {
            const wR = num(attr(c, "wR"));
            const hR = num(attr(c, "hR"));
            const st = (num(attr(c, "stAng")) / 60000) * (Math.PI / 180);
            const sw = (num(attr(c, "swAng")) / 60000) * (Math.PI / 180);
            const ox = cx - wR * Math.cos(st);
            const oy = cy - hR * Math.sin(st);
            const ex = ox + wR * Math.cos(st + sw);
            const ey = oy + hR * Math.sin(st + sw);
            d += `A ${wR} ${hR} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${ex} ${ey} `;
            cx = ex;
            cy = ey;
            break;
          }
          case "close":
            d += "Z ";
            break;
        }
      }
      out.push({ w: pw, h: ph, d: d.trim(), fill: attr(p, "fill") !== "none", stroke: attr(p, "stroke") !== "0" && attr(p, "stroke") !== "false" });
    }
    return out;
  }

  async group(g: El, part: Part, box: { x: number; y: number; w: number; h: number }): Promise<GroupNode> {
    const grpSpPr = kid(g, "grpSpPr");
    const x = kid(grpSpPr, "xfrm");
    const off = kid(x, "off");
    const ext = kid(x, "ext");
    const chOff = kid(x, "chOff");
    const chExt = kid(x, "chExt");
    // Child coordinates map from the group's child space onto its box.
    const cx0 = emu(attr(chOff, "x"));
    const cy0 = emu(attr(chOff, "y"));
    const cw = emu(attr(chExt, "cx")) || emu(attr(ext, "cx")) || box.w;
    const ch = emu(attr(chExt, "cy")) || emu(attr(ext, "cy")) || box.h;
    const sx = box.w / (cw || 1);
    const sy = box.h / (ch || 1);
    void off;
    const children: (ShapeNode | GroupNode)[] = [];
    const map = (t: { x: number; y: number; w: number; h: number }) => ({ x: (t.x - cx0) * sx, y: (t.y - cy0) * sy, w: t.w * sx, h: t.h * sy });
    for (const c of Array.from(g.children)) {
      const spPr = kid(c, "spPr") ?? kid(c, "grpSpPr");
      const t = map(this.xfrm(spPr, { x: 0, y: 0, w: 0, h: 0 }));
      if (c.localName === "wsp" || c.localName === "sp") {
        const s = await this.shape(c, part, t);
        Object.assign(s, t);
        children.push(s);
      } else if (c.localName === "pic") {
        const s = await this.picture(c, part, t);
        children.push(s);
      } else if (c.localName === "grpSp" || c.localName === "wgp") {
        const sub = await this.group(c, part, t);
        sub.x = t.x;
        sub.y = t.y;
        children.push(sub);
      } else if (c.localName === "graphicFrame") {
        const gd = path(c, "graphic", "graphicData");
        const r = gd ? await this.graphic(gd, part, t.w, t.h) : null;
        if (r) {
          Object.assign(r.node, { x: t.x, y: t.y });
          children.push(r.node);
        }
      }
    }
    return { kind: "group", x: box.x, y: box.y, w: box.w, h: box.h, children };
  }

  /* ----- VML (older documents, watermarks, text boxes) */

  async vml(el: El, part: Part, rp: RunProps): Promise<Drawing[]> {
    const out: Drawing[] = [];
    for (const c of Array.from(el.children)) {
      if (["shape", "rect", "roundrect", "oval", "line", "image", "group", "polyline"].includes(c.localName)) {
        const d = await this.vmlShape(c, part, rp);
        if (d) out.push(d);
      }
    }
    return out;
  }

  vmlStyle(s: string | null): Record<string, string> {
    const out: Record<string, string> = {};
    for (const decl of (s ?? "").split(";")) {
      const i = decl.indexOf(":");
      if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
    }
    return out;
  }

  vmlLen(v: string | undefined, d = 0): number {
    if (!v) return d;
    const m = /^(-?[\d.]+)\s*(pt|in|cm|mm|px|pc|em)?$/.exec(v.trim());
    if (!m) return d;
    const n = Number(m[1]);
    const u = m[2] ?? "px";
    return u === "pt" ? n : u === "in" ? n * 72 : u === "cm" ? (n * 72) / 2.54 : u === "mm" ? (n * 72) / 25.4 : u === "pc" ? n * 12 : u === "em" ? n * 12 : n * 0.75;
  }

  vmlColor(v: string | null): string | undefined {
    if (!v) return undefined;
    const m = /#?([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(v);
    if (m) {
      const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
      return h.toUpperCase();
    }
    const named: Record<string, string> = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", silver: "C0C0C0", gray: "808080", grey: "808080", navy: "000080" };
    return named[v.trim().split(/\s/)[0].toLowerCase()];
  }

  async vmlShape(sh: El, part: Part, rp: RunProps): Promise<Drawing | null> {
    const st = this.vmlStyle(sh.getAttribute("style"));
    if (st["visibility"] === "hidden" || st["display"] === "none") return null;
    let w = this.vmlLen(st["width"]);
    let h = this.vmlLen(st["height"]);
    const isLine = sh.localName === "line";
    if (isLine) {
      const [x1, y1] = (attr(sh, "from") ?? "0,0").split(",").map((v) => this.vmlLen(v));
      const [x2, y2] = (attr(sh, "to") ?? "0,0").split(",").map((v) => this.vmlLen(v));
      w = Math.abs(x2 - x1);
      h = Math.abs(y2 - y1);
    }
    const abs = st["position"] === "absolute";
    const z = Number(st["z-index"] ?? 0);
    const wrapEl = sh.getElementsByTagNameNS("*", "wrap")[0];
    const wrapType = attr(wrapEl, "type");
    const place: Placement = abs
      ? {
          mode: "anchor",
          wrap: wrapType === "square" ? "square" : wrapType === "topAndBottom" ? "topAndBottom" : wrapType === "tight" ? "tight" : "none",
          behind: z < 0,
          hRel: st["mso-position-horizontal-relative"] ?? "column",
          hAlign: st["mso-position-horizontal"] && st["mso-position-horizontal"] !== "absolute" ? st["mso-position-horizontal"] : undefined,
          hOffset: this.vmlLen(st["margin-left"] ?? st["left"]),
          vRel: st["mso-position-vertical-relative"] ?? "paragraph",
          vAlign: st["mso-position-vertical"] && st["mso-position-vertical"] !== "absolute" ? st["mso-position-vertical"] : undefined,
          vOffset: this.vmlLen(st["margin-top"] ?? st["top"]),
          dist: { top: 0, bottom: 0, left: 9, right: 9 },
          z,
        }
      : { mode: "inline", dist: {} };
    const rot = Number(st["rotation"] ?? 0) || undefined;
    const filled = attr(sh, "filled") !== "f" && attr(sh, "filled") !== "false";
    const stroked = attr(sh, "stroked") !== "f" && attr(sh, "stroked") !== "false";
    const fillEl = kid(sh, "fill");
    const fillColor = this.vmlColor(attr(sh, "fillcolor") ?? attr(fillEl, "color"));
    const opacity = attr(fillEl, "opacity");
    const strokeColor = this.vmlColor(attr(sh, "strokecolor") ?? attr(kid(sh, "stroke"), "color")) ?? "000000";
    const strokeW = this.vmlLen(attr(sh, "strokeweight") ?? undefined, 0.75);
    const type = attr(sh, "type") ?? "";
    const spt = attr(sh, "spt");
    const node: ShapeNode = {
      kind: "shape",
      x: 0,
      y: 0,
      w,
      h,
      rot,
      geom: sh.localName === "oval" ? "ellipse" : sh.localName === "roundrect" ? "roundRect" : isLine ? "line" : "rect",
      fill: filled && (fillColor || (sh.localName !== "shape" && sh.localName !== "image")) ? { color: fillColor ?? "FFFFFF", alpha: opacity ? parseVmlFraction(opacity) : 1 } : undefined,
      line: stroked && sh.localName !== "image" && !(sh.localName === "shape" && !attr(sh, "strokecolor") && !kid(sh, "stroke") && type.includes("75")) ? { color: strokeColor, width: strokeW } : undefined,
    };
    const img = kid(sh, "imagedata");
    if (img) {
      const src = await this.media(part, attr(img, "id") ?? attr(img, "relid") ?? attr(img, "pict"));
      if (src) {
        const f = (k: string) => parseVmlFraction(attr(img, k) ?? "0");
        node.image = { src, crop: clean({ left: f("cropleft") || undefined, top: f("croptop") || undefined, right: f("cropright") || undefined, bottom: f("cropbottom") || undefined }) };
        // A washed-out picture (watermark): gain and black level raised.
        if (attr(img, "gain") || attr(img, "blacklevel")) node.fill = { alpha: 0.35 };
        node.line = undefined;
      } else if (!fillColor) return null;
    }
    const tp = kid(sh, "textpath");
    if (tp && (type.includes("136") || spt === "136" || attr(tp, "string"))) {
      const ts = this.vmlStyle(tp.getAttribute("style"));
      node.textPath = { text: attr(tp, "string") ?? "", font: (ts["font-family"] ?? "").replace(/["']/g, "") || undefined, size: this.vmlLen(ts["font-size"]) || undefined, bold: ts["font-weight"] === "bold", italic: ts["font-style"] === "italic" };
      node.line = undefined;
      if (!node.fill) node.fill = { color: "C0C0C0", alpha: 0.5 };
      else node.fill.alpha = Math.min(node.fill.alpha ?? 1, opacity ? parseVmlFraction(opacity) : 0.5);
    }
    const tb = kid(sh, "textbox");
    const txbx = kid(tb, "txbxContent");
    if (txbx) {
      const ins = (attr(tb, "inset") ?? "7.2pt,3.6pt,7.2pt,3.6pt").split(",").map((v) => this.vmlLen(v.trim()));
      const saved = this.tableCtx;
      this.tableCtx = null;
      const blocks = await this.blocks(txbx, part);
      this.tableCtx = saved;
      node.text = { blocks, insets: { left: ins[0] ?? 7.2, top: ins[1] ?? 3.6, right: ins[2] ?? 7.2, bottom: ins[3] ?? 3.6 }, anchor: st["v-text-anchor"] === "middle" ? "ctr" : st["v-text-anchor"] === "bottom" ? "b" : "t", wrap: true, autofit: st["mso-fit-shape-to-text"] === "t" };
    }
    const drawing: Drawing = { w, h, place, node };
    if (node.text?.autofit) drawing.autofit = true;
    if (sh.localName === "group") {
      this.model.warnings.add("grouped drawings");
      return null;
    }
    if (!w || !h) {
      if (!isLine) return null;
    }
    void rp;
    return drawing;
  }
}

function parseVmlFraction(v: string): number {
  const s = v.trim();
  if (s.endsWith("f")) return Number(s.slice(0, -1)) / 65536;
  if (s.endsWith("%")) return Number(s.slice(0, -1)) / 100;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/* ------------------------------------------------------------------ entry */

export async function readDocx(bytes: Uint8Array): Promise<DocxModel> {
  const pkg = await Package.open(bytes);
  const mainPath = (await pkg.mainPart(/\/officeDocument$/)) ?? "word/document.xml";
  const main = await pkg.part(mainPath);
  if (!main) throw new Error("This file has no Word document inside. Is it really a .docx?");
  const relOf = (re: RegExp) => [...main.rels.values()].find((r) => re.test(r.type))?.target;
  const themeDoc = relOf(/\/theme$/) ? await pkg.xml(relOf(/\/theme$/)!) : null;
  const theme = readTheme(themeDoc);
  const stylesDoc = relOf(/\/styles$/) ? await pkg.xml(relOf(/\/styles$/)!) : null;
  const settings = readSettings(relOf(/\/settings$/) ? await pkg.xml(relOf(/\/settings$/)!) : null);
  const model: DocxModel = {
    sections: [],
    parts: new Map(),
    footnotes: new Map(),
    endnotes: new Map(),
    abstracts: new Map(),
    nums: new Map(),
    settings,
    media: new Map(),
    headingLevel: () => undefined,
    warnings: new Set(),
    charts: new Map(),
    theme,
  };
  const reader = new Reader(pkg, theme, stylesDoc, model);
  const numbering = readNumbering(relOf(/\/numbering$/) ? await pkg.xml(relOf(/\/numbering$/)!) : null, reader.P);
  model.abstracts = numbering.abstracts;
  model.nums = numbering.nums;
  model.headingLevel = (id) => reader.styles.headingLevel(id);
  model.defaultParaStyle = reader.styles.defaultPara;

  const body = kid(main.doc.documentElement, "body");
  if (!body) throw new Error("The Word document has no body.");
  const tail = await reader.blocks(body, main, [], (sect, blocks) => model.sections.push({ sect, blocks }));
  const lastSect = kid(body, "sectPr");
  model.sections.push({ sect: lastSect ? reader.section(lastSect, main) : reader.section(main.doc.createElement("sectPr"), main), blocks: tail });
  // Sections without their own headers or footers inherit the previous section's.
  for (let i = 1; i < model.sections.length; i++) {
    const prev = model.sections[i - 1].sect;
    const s = model.sections[i].sect;
    for (const k of ["default", "first", "even"] as const) {
      s.headers[k] ??= prev.headers[k];
      s.footers[k] ??= prev.footers[k];
    }
  }
  // Headers, footers, notes.
  const partPaths = new Set<string>();
  for (const { sect } of model.sections) for (const set of [sect.headers, sect.footers]) for (const p of Object.values(set)) if (p) partPaths.add(p);
  for (const p of partPaths) {
    const part = await pkg.part(p);
    if (part) model.parts.set(p, await reader.blocks(part.doc.documentElement, part));
  }
  for (const [kind, re, map] of [["footnote", /\/footnotes$/, model.footnotes], ["endnote", /\/endnotes$/, model.endnotes]] as const) {
    const p = relOf(re);
    const part = p ? await pkg.part(p) : null;
    if (!part) continue;
    for (const n of kids(part.doc.documentElement, kind)) {
      const type = attr(n, "type");
      const blocks = await reader.blocks(n, part);
      if (type === "separator" && kind === "footnote") model.footnoteSep = blocks;
      if (type && type !== "normal") continue;
      map.set(attr(n, "id") ?? "", blocks);
    }
  }
  // Title and author for the PDF's properties.
  const core = await pkg.xml("docProps/core.xml");
  if (core) {
    model.title = core.getElementsByTagNameNS("*", "title")[0]?.textContent?.trim() || undefined;
    model.author = core.getElementsByTagNameNS("*", "creator")[0]?.textContent?.trim() || undefined;
  }
  return model;
}
