/**
 * Reads an .xlsx package into the resolved workbook model: styles (fonts,
 * fills, borders, alignment, number formats) with theme, tint and indexed
 * colours turned into hex, shared strings with rich text, every sheet's cells,
 * sizes, merges, page setup, headers and footers, print areas and titles,
 * pictures, charts and shapes, tables and conditional formats.
 */
import { Package, attr, drawingColor, emu, hexOf, hslToRgb, kid, kids, num, path, readTheme, rgbOf, rgbToHsl, type El, type Part, type Theme } from "../ooxml";
import type { Anchor, CfBlock, CfRule, Cell, ColInfo, Dxf, HeaderFooter, PageSetup, Range, RichRun, RowInfo, Sheet, Workbook, XAlign, XBorder, XBorderSide, XDrawing, XFont, XShape, XStyle, XTable } from "./model";

/* ------------------------------------------------------------------ colours */

const INDEXED = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080", "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF", "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696", "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];
/** SpreadsheetML theme colour indexes: light and dark come first, swapped against the scheme's own order. */
const THEME_ORDER = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];

/** Excel's tint: towards white (positive) or black (negative) on HLS luminance. */
export function applyTint(hex: string, t: number): string {
  if (!t) return hex;
  const [r, g, b] = rgbOf(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const l2 = t < 0 ? l * (1 + t) : l * (1 - t) + t;
  return hexOf(...hslToRgb(h, s, l2));
}

class Colors {
  constructor(
    private theme: Theme,
    private palette: string[],
  ) {}
  /** A <color> element to hex; undefined for automatic. */
  of(el: El | null | undefined): string | undefined {
    if (!el) return undefined;
    if (attr(el, "auto") === "1" || attr(el, "auto") === "true") return undefined;
    let hex: string | undefined;
    const rgb = attr(el, "rgb");
    const theme = attr(el, "theme");
    const indexed = attr(el, "indexed");
    if (rgb) hex = rgb.length >= 8 ? rgb.slice(-6) : rgb.padStart(6, "0");
    else if (theme != null) hex = this.theme.colors[THEME_ORDER[num(theme)] ?? "dk1"] ?? "000000";
    else if (indexed != null) {
      const i = num(indexed);
      if (i === 64 || i === 81) return undefined; // system foreground: automatic
      if (i === 65) hex = "FFFFFF";
      else hex = this.palette[i] ?? undefined;
    }
    if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
    return applyTint(hex.toUpperCase(), num(attr(el, "tint")));
  }
}

/* ------------------------------------------------------------- references */

export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** "B3" → {r: 2, c: 1}; "$B$3" too. */
export function cellRef(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  return m ? { r: Number(m[2]) - 1, c: colIndex(m[1]) } : null;
}

/** "A1:C4", "A1", "$1:$2" (whole rows), "$A:$B" (whole columns). */
export function rangeRef(ref: string): Range | null {
  const [a, b = a] = ref.trim().split(":");
  const ca = cellRef(a);
  const cb = cellRef(b);
  if (ca && cb) return { r0: Math.min(ca.r, cb.r), c0: Math.min(ca.c, cb.c), r1: Math.max(ca.r, cb.r), c1: Math.max(ca.c, cb.c) };
  const rows = /^\$?(\d+)$/;
  const cols = /^\$?([A-Za-z]{1,3})$/;
  if (rows.test(a) && rows.test(b)) return { r0: Number(rows.exec(a)![1]) - 1, r1: Number(rows.exec(b)![1]) - 1, c0: 0, c1: 16383 };
  if (cols.test(a) && cols.test(b)) return { r0: 0, r1: 1048575, c0: colIndex(cols.exec(a)![1]), c1: colIndex(cols.exec(b)![1]) };
  return null;
}

/** Split a defined name's value at commas outside quotes: "'A b'!$A$1:$B$2,'A b'!$D$1:$E$2". */
function splitRefs(v: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (const ch of v) {
    if (ch === "'") q = !q;
    if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
const refPart = (s: string) => s.slice(s.lastIndexOf("!") + 1);

/* ----------------------------------------------------------- number formats */

const BUILTIN: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 5: '"$"#,##0_);\\("$"#,##0\\)', 6: '"$"#,##0_);[Red]\\("$"#,##0\\)', 7: '"$"#,##0.00_);\\("$"#,##0.00\\)', 8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yyyy h:mm",
  37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)', 43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: "mm:ss", 46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@",
};

/** The reader's own short date (built-in format 14 follows the computer's settings in Excel). */
function localShortDate(): string {
  try {
    const parts = new Intl.DateTimeFormat(typeof navigator !== "undefined" ? navigator.language : "en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(2026, 9, 6));
    let out = "";
    for (const p of parts) {
      if (p.type === "day") out += p.value.length === 2 && p.value.startsWith("0") ? "dd" : "d";
      else if (p.type === "month") out += p.value.length === 2 && p.value.startsWith("0") ? "mm" : "m";
      else if (p.type === "year") out += "yyyy";
      else if (p.type === "literal") out += p.value.replace(/[^/.\- ]/g, "");
    }
    return /d/.test(out) && /m/.test(out) && /y/.test(out) ? out : "m/d/yyyy";
  } catch {
    return "m/d/yyyy";
  }
}

/* ------------------------------------------------------------------ styles */

type StyleSheet = { styles: XStyle[]; dxfs: Dxf[]; defaultFont: XFont; custom: Workbook["customTableStyles"]; defaultTableStyle?: string };

const DEFAULT_FONT: XFont = { name: "Calibri", size: 11, bold: false, italic: false, strike: false };

function readFont(el: El | null, colors: Colors, theme: Theme, base: XFont): XFont {
  if (!el) return { ...base };
  const v = (n: string) => attr(kid(el, n), "val");
  const flag = (n: string) => {
    const k = kid(el, n);
    if (!k) return undefined;
    const val = attr(k, "val");
    return val == null || !(val === "0" || val === "false");
  };
  const scheme = v("scheme");
  const themed = scheme === "major" ? theme.major.latin : scheme === "minor" ? theme.minor.latin : "";
  const u = kid(el, "u");
  const underline = u ? ((attr(u, "val") ?? "single") as XFont["underline"] | "none") : undefined;
  const va = v("vertAlign");
  return {
    name: themed || v("name") || v("rFont") || base.name,
    size: num(v("sz"), base.size) || base.size,
    bold: flag("b") ?? base.bold,
    italic: flag("i") ?? base.italic,
    underline: underline === "none" ? undefined : (underline ?? base.underline),
    strike: flag("strike") ?? base.strike,
    color: kid(el, "color") ? colors.of(kid(el, "color")) : base.color,
    vertAlign: va === "superscript" || va === "subscript" ? va : undefined,
  };
}

/** A fill to one colour: solid fills, patterns blended to their density, gradients to their middle. */
function readFill(el: El | null, colors: Colors, dxf = false): string | undefined {
  if (!el) return undefined;
  const pf = kid(el, "patternFill");
  if (pf) {
    const type = attr(pf, "patternType") ?? (dxf ? "solid" : "none");
    if (type === "none") return undefined;
    const fg = colors.of(kid(pf, "fgColor"));
    const bg = colors.of(kid(pf, "bgColor"));
    // (Conditional formats keep a solid fill's colour in bgColor.)
    if (type === "solid") return dxf ? (bg ?? fg) : (fg ?? (kid(pf, "fgColor") ? "000000" : undefined));
    const density: Record<string, number> = { gray0625: 0.0625, gray125: 0.125, lightGray: 0.25, mediumGray: 0.5, darkGray: 0.75 };
    const d = density[type] ?? (type.startsWith("dark") ? 0.5 : 0.25);
    const f = rgbOf(fg ?? "000000");
    const b = rgbOf(bg ?? "FFFFFF");
    return hexOf(f[0] * d + b[0] * (1 - d), f[1] * d + b[1] * (1 - d), f[2] * d + b[2] * (1 - d));
  }
  const gf = kid(el, "gradientFill");
  if (gf) {
    const stops = kids(gf, "stop").map((s) => colors.of(kid(s, "color")) ?? "FFFFFF");
    if (!stops.length) return undefined;
    const rgbs = stops.map(rgbOf);
    const avg = [0, 1, 2].map((i) => rgbs.reduce((a, c) => a + c[i], 0) / rgbs.length) as [number, number, number];
    return hexOf(...avg);
  }
  return undefined;
}

function readBorder(el: El | null, colors: Colors): XBorder {
  if (!el) return {};
  const side = (n: string): XBorderSide | undefined => {
    const s = kid(el, n);
    const style = attr(s, "style");
    if (!s || !style || style === "none") return undefined;
    return { style, color: colors.of(kid(s, "color")) };
  };
  return {
    left: side("left") ?? side("start"),
    right: side("right") ?? side("end"),
    top: side("top"),
    bottom: side("bottom"),
    diagonal: side("diagonal"),
    diagUp: attr(el, "diagonalUp") === "1",
    diagDown: attr(el, "diagonalDown") === "1",
  };
}

function readAlign(el: El | null): XAlign {
  if (!el) return {};
  const rot = num(attr(el, "textRotation"));
  return {
    h: attr(el, "horizontal") ?? undefined,
    v: attr(el, "vertical") ?? undefined,
    wrap: attr(el, "wrapText") === "1" || attr(el, "wrapText") === "true",
    indent: num(attr(el, "indent")) || undefined,
    rotation: rot === 255 ? 255 : rot > 90 ? -(rot - 90) : rot || undefined,
    shrink: attr(el, "shrinkToFit") === "1" || attr(el, "shrinkToFit") === "true",
  };
}

function readStyles(doc: Document | null, theme: Theme): StyleSheet {
  const root = doc?.documentElement ?? null;
  const palette = [...INDEXED];
  const custom = kids(path(root, "colors", "indexedColors"), "rgbColor");
  custom.forEach((c, i) => {
    const v = attr(c, "rgb");
    if (v) palette[i] = v.slice(-6).toUpperCase();
  });
  const colors = new Colors(theme, palette);
  const fmts = new Map<number, string>();
  for (const f of kids(kid(root, "numFmts"), "numFmt")) fmts.set(num(attr(f, "numFmtId")), attr(f, "formatCode") ?? "General");
  const fontEls = kids(kid(root, "fonts"), "font");
  const defaultFont = readFont(fontEls[0] ?? null, colors, theme, DEFAULT_FONT);
  const fonts = fontEls.map((f) => readFont(f, colors, theme, defaultFont));
  const fills = kids(kid(root, "fills"), "fill").map((f) => readFill(f, colors));
  const borders = kids(kid(root, "borders"), "border").map((b) => readBorder(b, colors));
  const short = localShortDate();
  const fmtOf = (id: number) => fmts.get(id) ?? (id === 14 ? short : id === 22 ? `${short} h:mm` : (BUILTIN[id] ?? "General"));
  const styles: XStyle[] = kids(kid(root, "cellXfs"), "xf").map((xf) => ({
    font: fonts[num(attr(xf, "fontId"))] ?? defaultFont,
    fill: fills[num(attr(xf, "fillId"))],
    border: borders[num(attr(xf, "borderId"))] ?? {},
    align: readAlign(kid(xf, "alignment")),
    numFmt: fmtOf(num(attr(xf, "numFmtId"))),
  }));
  if (!styles.length) styles.push({ font: defaultFont, border: {}, align: {}, numFmt: "General" });
  const dxfs: Dxf[] = kids(kid(root, "dxfs"), "dxf").map((d) => {
    const out: Dxf = {};
    const f = kid(d, "font");
    if (f) {
      const full = readFont(f, colors, theme, defaultFont);
      const part: Partial<XFont> = {};
      if (kid(f, "b")) part.bold = full.bold;
      if (kid(f, "i")) part.italic = full.italic;
      if (kid(f, "u")) part.underline = full.underline;
      if (kid(f, "strike")) part.strike = full.strike;
      if (kid(f, "color")) part.color = full.color ?? "000000";
      if (kid(f, "sz")) part.size = full.size;
      if (kid(f, "name")) part.name = full.name;
      out.font = part;
    }
    const fill = readFill(kid(d, "fill"), colors, true);
    if (fill) out.fill = fill;
    if (kid(d, "border")) out.border = readBorder(kid(d, "border"), colors);
    const nf = kid(d, "numFmt");
    if (nf) out.numFmt = attr(nf, "formatCode") ?? undefined;
    return out;
  });
  const customStyles: Workbook["customTableStyles"] = new Map();
  for (const ts of kids(kid(root, "tableStyles"), "tableStyle")) {
    const parts: Record<string, Dxf & { size?: number }> = {};
    for (const e of kids(ts, "tableStyleElement")) {
      const d = dxfs[num(attr(e, "dxfId"), -1)];
      if (d) parts[attr(e, "type") ?? ""] = { ...d, size: num(attr(e, "size"), 1) };
    }
    customStyles.set(attr(ts, "name") ?? "", parts);
  }
  return { styles, dxfs, defaultFont, custom: customStyles, defaultTableStyle: attr(kid(root, "tableStyles"), "defaultTableStyle") ?? undefined };
}

/* ---------------------------------------------------------- shared strings */

type SharedString = { text: string; rich?: RichRun[] };

function richOf(si: El, colors: Colors, theme: Theme, base: XFont): SharedString {
  const runs = kids(si, "r");
  if (!runs.length) return { text: textOf(kid(si, "t")) };
  const rich: RichRun[] = runs.map((r) => ({ text: textOf(kid(r, "t")), font: kid(r, "rPr") ? readFont(kid(r, "rPr"), colors, theme, base) : base }));
  return { text: rich.map((r) => r.text).join(""), rich };
}
/** Text of a <t>, with _xHHHH_ escapes decoded. */
function textOf(t: El | null): string {
  return (t?.textContent ?? "").replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/* ---------------------------------------------------------------- sheets */

const PAPER: Record<number, [number, number]> = {
  1: [612, 792], 2: [612, 792], 3: [792, 1224], 4: [1224, 792], 5: [612, 1008], 6: [396, 612], 7: [522, 756], 8: [841.89, 1190.55], 9: [595.28, 841.89], 10: [595.28, 841.89],
  11: [419.53, 595.28], 12: [728.5, 1031.81], 13: [515.91, 728.5], 14: [612, 936], 17: [792, 1224], 18: [612, 792], 19: [279, 639], 20: [297, 684], 24: [1224, 1584],
  34: [498.9, 708.66], 66: [1190.55, 1683.78], 70: [297.64, 419.53],
};

/** Letter for the Americas, A4 elsewhere: Excel prints a sheet with no paper size on the computer's default paper. */
function defaultPaper(): [number, number] {
  const lang = typeof navigator !== "undefined" ? navigator.language : "en-US";
  return /^(en-US|en-CA|es-MX|fr-CA|en-PH)$/i.test(lang) ? PAPER[1] : PAPER[9];
}

function readSetup(root: El): PageSetup {
  const ps = kid(root, "pageSetup");
  const po = kid(root, "printOptions");
  const pm = kid(root, "pageMargins");
  const fit = path(root, "sheetPr", "pageSetUpPr");
  const paper = PAPER[num(attr(ps, "paperSize"), 0)] ?? defaultPaper();
  const landscape = attr(ps, "orientation") === "landscape";
  const inch = (n: string, d: number) => num(attr(pm, n), d) * 72;
  const t = (n: string) => attr(po, n) === "1" || attr(po, n) === "true";
  return {
    paperW: landscape ? paper[1] : paper[0],
    paperH: landscape ? paper[0] : paper[1],
    landscape,
    scale: Math.min(400, Math.max(10, num(attr(ps, "scale"), 100))),
    fitToPage: attr(fit, "fitToPage") === "1" || attr(fit, "fitToPage") === "true",
    fitW: num(attr(ps, "fitToWidth"), 1),
    fitH: num(attr(ps, "fitToHeight"), 1),
    overThenDown: attr(ps, "pageOrder") === "overThenDown",
    firstPageNumber: attr(ps, "useFirstPageNumber") === "1" ? num(attr(ps, "firstPageNumber"), 1) : undefined,
    margins: { left: inch("left", 0.7), right: inch("right", 0.7), top: inch("top", 0.75), bottom: inch("bottom", 0.75), header: inch("header", 0.3), footer: inch("footer", 0.3) },
    hCenter: t("horizontalCentered"),
    vCenter: t("verticalCentered"),
    gridLines: t("gridLines"),
    headings: t("headings"),
    blackAndWhite: attr(ps, "blackAndWhite") === "1",
  };
}

function readHF(root: El): HeaderFooter {
  const hf = kid(root, "headerFooter");
  const tx = (n: string) => kid(hf, n)?.textContent ?? undefined;
  const flag = (n: string, d: boolean) => (attr(hf, n) == null ? d : attr(hf, n) === "1" || attr(hf, n) === "true");
  return {
    oddHeader: tx("oddHeader"),
    oddFooter: tx("oddFooter"),
    evenHeader: tx("evenHeader"),
    evenFooter: tx("evenFooter"),
    firstHeader: tx("firstHeader"),
    firstFooter: tx("firstFooter"),
    differentOddEven: flag("differentOddEven", false),
    differentFirst: flag("differentFirst", false),
    scaleWithDoc: flag("scaleWithDoc", true),
    alignWithMargins: flag("alignWithMargins", true),
  };
}

/** Serial day number of an ISO date (t="d" cells). */
function isoSerial(iso: string, date1904: boolean): number | null {
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00Z" : iso.endsWith("Z") ? iso : iso + "Z");
  if (Number.isNaN(d.getTime())) return null;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return (d.getTime() - base) / 86400000;
}

class Reader {
  colors: Colors;
  constructor(
    public pkg: Package,
    public wb: Workbook,
    public shared: SharedString[],
    palette: string[],
  ) {
    this.colors = new Colors(wb.theme, palette);
  }

  async sheet(name: string, state: Sheet["state"], partPath: string): Promise<Sheet | null> {
    const part = await this.pkg.part(partPath);
    if (!part) return null;
    const root = part.doc.documentElement;
    const fmt = kid(root, "sheetFormatPr");
    const sheet: Sheet = {
      name,
      state,
      cells: new Map(),
      rows: new Map(),
      cols: [],
      defaultRowHeight: attr(fmt, "defaultRowHeight") != null ? num(attr(fmt, "defaultRowHeight")) : undefined,
      defaultColWidth: attr(fmt, "defaultColWidth") != null ? num(attr(fmt, "defaultColWidth")) : undefined,
      baseColWidth: num(attr(fmt, "baseColWidth"), 8),
      zeroHeight: attr(fmt, "zeroHeight") === "1",
      merges: [],
      setup: readSetup(root),
      hf: readHF(root),
      rowBreaks: kids(kid(root, "rowBreaks"), "brk").map((b) => num(attr(b, "id"))).filter((n) => n > 0),
      colBreaks: kids(kid(root, "colBreaks"), "brk").map((b) => num(attr(b, "id"))).filter((n) => n > 0),
      drawings: [],
      tables: [],
      cf: [],
      links: [],
      rtl: attr(path(root, "sheetViews", "sheetView"), "rightToLeft") === "1",
    };
    for (const c of kids(kid(root, "cols"), "col")) {
      const info: ColInfo = { min: num(attr(c, "min"), 1) - 1, max: num(attr(c, "max"), 1) - 1 };
      if (attr(c, "width") != null) info.width = num(attr(c, "width"));
      if (attr(c, "hidden") === "1" || attr(c, "hidden") === "true") info.hidden = true;
      if (attr(c, "style") != null) info.s = num(attr(c, "style"));
      sheet.cols.push(info);
    }
    this.cells(kid(root, "sheetData"), sheet);
    for (const m of kids(kid(root, "mergeCells"), "mergeCell")) {
      const r = rangeRef(attr(m, "ref") ?? "");
      if (r) sheet.merges.push(r);
    }
    for (const h of kids(kid(root, "hyperlinks"), "hyperlink")) {
      const r = rangeRef(attr(h, "ref") ?? "");
      if (!r) continue;
      const rel = part.rels.get(attr(h, "id") ?? "");
      const url = rel?.external ? rel.target : undefined;
      const loc = attr(h, "location") ?? undefined;
      if (url && /^(https?:|mailto:|ftp:)/i.test(url)) sheet.links.push({ range: r, url });
      else if (loc) sheet.links.push({ range: r, location: loc });
    }
    sheet.cf = this.conditional(root);
    for (const d of kids(root, "drawing")) {
      const rel = part.rels.get(attr(d, "id") ?? "");
      if (rel && !rel.external) await this.drawings(rel.target, sheet);
    }
    for (const tp of kids(kid(root, "tableParts"), "tablePart")) {
      const rel = part.rels.get(attr(tp, "id") ?? "");
      if (!rel || rel.external) continue;
      const t = await this.pkg.xml(rel.target);
      const te = t?.documentElement;
      const ref = rangeRef(attr(te, "ref") ?? "");
      if (!te || !ref) continue;
      const si = kid(te, "tableStyleInfo");
      const b = (n: string, d: boolean) => (attr(si, n) == null ? d : attr(si, n) === "1" || attr(si, n) === "true");
      const table: XTable = {
        ref,
        header: num(attr(te, "headerRowCount"), 1),
        totals: num(attr(te, "totalsRowCount"), 0) || (attr(te, "totalsRowShown") === "1" && attr(te, "totalsRowCount") ? 1 : 0),
        style: si ? (attr(si, "name") ?? this.wb.defaultTableStyle ?? "TableStyleMedium2") : undefined,
        firstCol: b("showFirstColumn", false),
        lastCol: b("showLastColumn", false),
        rowStripes: b("showRowStripes", true),
        colStripes: b("showColumnStripes", false),
      };
      sheet.tables.push(table);
    }
    if (kid(root, "legacyDrawingHF")) this.wb.warnings.add("pictures in headers or footers");
    return sheet;
  }

  cells(data: El | null, sheet: Sheet) {
    if (!data) return;
    let rowNo = -1;
    for (const row of Array.from(data.children)) {
      if (row.localName !== "row") continue;
      rowNo = attr(row, "r") != null ? num(attr(row, "r")) - 1 : rowNo + 1;
      const info: RowInfo = {};
      if (attr(row, "ht") != null) info.ht = num(attr(row, "ht"));
      if (attr(row, "customHeight") === "1" || attr(row, "customHeight") === "true") info.custom = true;
      if (attr(row, "hidden") === "1" || attr(row, "hidden") === "true") info.hidden = true;
      if ((attr(row, "customFormat") === "1" || attr(row, "customFormat") === "true") && attr(row, "s") != null) info.s = num(attr(row, "s"));
      if (info.ht != null || info.hidden || info.s != null) sheet.rows.set(rowNo, info);
      let colNo = -1;
      let cells: Map<number, Cell> | undefined;
      for (const c of Array.from(row.children)) {
        if (c.localName !== "c") continue;
        const ref = attr(c, "r");
        const pos = ref ? cellRef(ref) : null;
        colNo = pos ? pos.c : colNo + 1;
        const r = pos ? pos.r : rowNo;
        const t = attr(c, "t") ?? "n";
        const s = num(attr(c, "s"));
        const v = kid(c, "v");
        const f = kid(c, "f");
        let cell: Cell | null = null;
        if (t === "s") {
          const ss = this.shared[num(v?.textContent)];
          if (ss) cell = { v: ss.text, t: "s", s, rich: ss.rich };
        } else if (t === "inlineStr") {
          const is = kid(c, "is");
          if (is) {
            const ss = richOf(is, this.colors, this.wb.theme, this.wb.styles[s]?.font ?? this.wb.defaultFont);
            cell = { v: ss.text, t: "s", s, rich: ss.rich };
          }
        } else if (t === "b") cell = v ? { v: v.textContent === "1" || v.textContent === "true", t: "b", s } : null;
        else if (t === "e") cell = v ? { v: v.textContent ?? "#N/A", t: "e", s } : null;
        else if (t === "str") cell = v ? { v: textOf(v), t: "str", s } : null;
        else if (t === "d") {
          const n = v ? isoSerial(v.textContent ?? "", this.wb.date1904) : null;
          cell = n != null ? { v: n, t: "n", s } : null;
        } else if (v && v.textContent !== "") {
          const n = Number(v.textContent);
          cell = Number.isFinite(n) ? { v: n, t: "n", s } : { v: v.textContent ?? "", t: "str", s };
        }
        if (!cell && f) cell = { v: null, t: "n", s, noCache: true };
        if (!cell && s) cell = { v: null, t: "n", s };
        if (!cell) continue;
        if (r !== rowNo) {
          let m = sheet.cells.get(r);
          if (!m) sheet.cells.set(r, (m = new Map()));
          m.set(colNo, cell);
          continue;
        }
        if (!cells) {
          cells = sheet.cells.get(rowNo);
          if (!cells) sheet.cells.set(rowNo, (cells = new Map()));
        }
        cells.set(colNo, cell);
      }
    }
  }

  conditional(root: El): CfBlock[] {
    const out: CfBlock[] = [];
    for (const cf of kids(root, "conditionalFormatting")) {
      const ranges = (attr(cf, "sqref") ?? "").split(/\s+/).map(rangeRef).filter((r): r is Range => !!r);
      const rules: CfRule[] = [];
      for (const r of kids(cf, "cfRule")) {
        const rule: CfRule = {
          type: attr(r, "type") ?? "",
          priority: num(attr(r, "priority"), 1000),
          stop: attr(r, "stopIfTrue") === "1",
          dxf: attr(r, "dxfId") != null ? this.wb.dxfs[num(attr(r, "dxfId"))] : undefined,
          operator: attr(r, "operator") ?? undefined,
          formulas: kids(r, "formula").map((f) => f.textContent ?? ""),
          text: attr(r, "text") ?? undefined,
          rank: attr(r, "rank") != null ? num(attr(r, "rank")) : undefined,
          percent: attr(r, "percent") === "1",
          bottom: attr(r, "bottom") === "1",
          aboveAverage: attr(r, "aboveAverage") !== "0",
          equalAverage: attr(r, "equalAverage") === "1",
        };
        const scale = kid(r, "colorScale") ?? kid(r, "dataBar") ?? kid(r, "iconSet");
        if (scale) {
          rule.cfvos = kids(scale, "cfvo").map((v) => ({ type: attr(v, "type") ?? "min", val: attr(v, "val") ?? undefined }));
          rule.colors = kids(scale, "color").map((c) => this.colors.of(c) ?? "000000");
          if (rule.type === "dataBar") {
            rule.barColor = rule.colors[0] ?? "638EC6";
            // Excel 2010 bars are solid or gradient, set in an extension; gradient is the default.
            const ext = r.getElementsByTagNameNS("*", "dataBar")[1];
            rule.gradient = attr(ext, "gradient") !== "0";
          }
        }
        rules.push(rule);
      }
      if (ranges.length && rules.length) out.push({ ranges, rules });
    }
    return out;
  }

  /* ----- drawings */

  async drawings(target: string, sheet: Sheet) {
    const part = await this.pkg.part(target);
    if (!part) return;
    for (const anchor of Array.from(part.doc.documentElement.children)) {
      const name = anchor.localName;
      if (name !== "twoCellAnchor" && name !== "oneCellAnchor" && name !== "absoluteAnchor") continue;
      const at = (el: El | null): Anchor => ({ col: num(kid(el, "col")?.textContent), colOff: emu(kid(el, "colOff")?.textContent), row: num(kid(el, "row")?.textContent), rowOff: emu(kid(el, "rowOff")?.textContent) });
      const base: Omit<XDrawing, "kind"> = { from: at(kid(anchor, "from")) };
      if (name === "twoCellAnchor") base.to = at(kid(anchor, "to"));
      const ext = kid(anchor, "ext");
      if (ext) base.ext = { w: emu(attr(ext, "cx")), h: emu(attr(ext, "cy")) };
      if (name === "absoluteAnchor") {
        const pos = kid(anchor, "pos");
        base.abs = { x: emu(attr(pos, "x")), y: emu(attr(pos, "y")) };
      }
      for (const obj of Array.from(anchor.children)) await this.object(this.choose(obj), part, base, sheet, null);
    }
  }

  /** mc:AlternateContent: the choice we understand, else the fallback. */
  choose(el: El): El {
    if (el.localName !== "AlternateContent") return el;
    const choice = kid(el, "Choice");
    const req = attr(choice, "Requires") ?? "";
    const ok = choice && /^(a14|v|x14|sle15|xdr14|cx1|cx2|cx4)?$/.test(req) && choice.firstElementChild;
    const pick = (ok ? choice : kid(el, "Fallback"))?.firstElementChild;
    return pick ?? el;
  }

  /**
   * One drawing object. Inside a group, `frame` maps the group's own coordinates to fractions
   * of the anchor box: fraction = a + (coordinate - o) * s.
   */
  async object(obj: El, part: Part, base: Omit<XDrawing, "kind">, sheet: Sheet, frame: { ax: number; ay: number; ox: number; oy: number; sx: number; sy: number } | null) {
    const xfrm = (el: El) => {
      const x = path(el, "spPr", "xfrm") ?? path(el, "grpSpPr", "xfrm") ?? kid(el, "xfrm");
      const off = kid(x, "off");
      const ext = kid(x, "ext");
      return { x: emu(attr(off, "x")), y: emu(attr(off, "y")), w: emu(attr(ext, "cx")), h: emu(attr(ext, "cy")), el: x };
    };
    const sub = (el: El) => {
      if (!frame) return undefined;
      const f = xfrm(el);
      return { x: frame.ax + (f.x - frame.ox) * frame.sx, y: frame.ay + (f.y - frame.oy) * frame.sy, w: f.w * frame.sx, h: f.h * frame.sy };
    };
    switch (obj.localName) {
      case "pic": {
        const blip = path(obj, "blipFill", "blip");
        const rel = part.rels.get(attr(blip, "embed") ?? "");
        if (!rel || rel.external) return;
        await this.media(rel.target);
        const src = path(obj, "blipFill", "srcRect");
        const crop = src ? { l: num(attr(src, "l")) / 100000, t: num(attr(src, "t")) / 100000, r: num(attr(src, "r")) / 100000, b: num(attr(src, "b")) / 100000 } : undefined;
        sheet.drawings.push({ ...base, kind: "pic", image: rel.target, crop, sub: sub(obj) });
        return;
      }
      case "graphicFrame": {
        const chart = obj.getElementsByTagNameNS("*", "chart")[0];
        const rel = chart ? part.rels.get(attr(chart, "id") ?? "") : undefined;
        if (!rel || rel.external) {
          this.wb.warnings.add("SmartArt and other graphics");
          return;
        }
        if (!this.wb.charts.has(rel.target)) {
          const doc = await this.pkg.xml(rel.target);
          if (!doc) return;
          this.wb.charts.set(rel.target, doc);
        }
        // (A chart frame keeps its size in its own xfrm, not under spPr.)
        sheet.drawings.push({ ...base, kind: "chart", chart: rel.target, sub: sub(obj) });
        return;
      }
      case "sp":
      case "cxnSp": {
        const shape = this.shape(obj);
        if (shape) sheet.drawings.push({ ...base, kind: "shape", shape, sub: sub(obj) });
        return;
      }
      case "grpSp": {
        const g = xfrm(obj);
        const chOff = kid(g.el, "chOff");
        const chExt = kid(g.el, "chExt");
        const cw = emu(attr(chExt, "cx")) || g.w || 1;
        const ch = emu(attr(chExt, "cy")) || g.h || 1;
        // The group's own box in the anchor (the whole anchor at the top level).
        const box = frame ? sub(obj)! : { x: 0, y: 0, w: 1, h: 1 };
        const inner = { ax: box.x, ay: box.y, ox: emu(attr(chOff, "x")), oy: emu(attr(chOff, "y")), sx: box.w / cw, sy: box.h / ch };
        for (const c of Array.from(obj.children)) await this.object(this.choose(c), part, base, sheet, inner);
        return;
      }
    }
  }

  shape(sp: El): XShape | null {
    const spPr = kid(sp, "spPr");
    const style = kid(sp, "style");
    const theme = this.wb.theme;
    const geom = attr(kid(spPr, "prstGeom"), "prst") ?? (kid(spPr, "custGeom") ? "rect" : "rect");
    const adj: Record<string, number> = {};
    for (const gd of kids(path(spPr, "prstGeom", "avLst"), "gd")) {
      const m = /val\s+(-?\d+)/.exec(attr(gd, "fmla") ?? "");
      if (m) adj[attr(gd, "name") ?? ""] = Number(m[1]);
    }
    let fill: string | undefined;
    let fillAlpha: number | undefined;
    const solid = kid(spPr, "solidFill");
    if (solid) {
      const c = drawingColor(solid, theme);
      fill = c?.hex;
      fillAlpha = c?.alpha;
    } else if (kid(spPr, "gradFill")) {
      const c = drawingColor(path(spPr, "gradFill", "gsLst", "gs"), theme);
      fill = c?.hex;
    } else if (!kid(spPr, "noFill") && sp.localName === "sp") {
      const ref = kid(style, "fillRef");
      if (ref && num(attr(ref, "idx")) > 0) fill = drawingColor(ref, theme)?.hex;
    }
    let line: XShape["line"];
    const ln = kid(spPr, "ln");
    if (!kid(ln, "noFill")) {
      const lc = drawingColor(kid(ln, "solidFill"), theme) ?? (kid(style, "lnRef") && num(attr(kid(style, "lnRef"), "idx")) > 0 ? drawingColor(kid(style, "lnRef"), theme) : null);
      if (lc) {
        // Theme line references darken the colour by half, as Office's default shape outline does.
        const fromStyle = !kid(ln, "solidFill");
        const hex = fromStyle && fill ? hexOf(...rgbOf(lc.hex).map((v) => v * 0.5) as [number, number, number]) : lc.hex;
        line = { color: hex, width: attr(ln, "w") != null ? emu(attr(ln, "w")) : 0.75, dash: attr(kid(ln, "prstDash"), "val") ?? undefined };
      }
    }
    const fontRefColor = drawingColor(kid(style, "fontRef"), theme)?.hex;
    const tx = kid(sp, "txBody");
    const body = kid(tx, "bodyPr");
    const paras: XShape["paras"] = [];
    for (const p of kids(tx, "p")) {
      const algn = attr(kid(p, "pPr"), "algn") ?? "l";
      const runs: XShape["paras"][number]["runs"] = [];
      const endSz = num(attr(kid(p, "endParaRPr"), "sz"), 1100) / 100;
      for (const r of Array.from(p.children)) {
        if (r.localName !== "r" && r.localName !== "fld" && r.localName !== "br") continue;
        if (r.localName === "br") {
          runs.push({ text: "\n", size: endSz, bold: false, italic: false });
          continue;
        }
        const rPr = kid(r, "rPr");
        runs.push({
          text: kid(r, "t")?.textContent ?? "",
          size: num(attr(rPr, "sz"), 1100) / 100,
          bold: attr(rPr, "b") === "1",
          italic: attr(rPr, "i") === "1",
          color: drawingColor(kid(rPr, "solidFill"), theme)?.hex ?? fontRefColor,
          font: attr(kid(rPr, "latin"), "typeface") ?? undefined,
        });
      }
      paras.push({ runs: runs.length ? runs : [{ text: "", size: endSz, bold: false, italic: false }], align: algn });
    }
    const ins = (n: string, d: number) => (attr(body, n) != null ? emu(attr(body, n)) : d);
    const x = kid(spPr, "xfrm");
    if (!fill && !line && !paras.some((p) => p.runs.some((r) => r.text.trim()))) return null;
    return {
      geom: sp.localName === "cxnSp" ? "line" : geom,
      adj,
      fill,
      fillAlpha,
      line,
      paras,
      insets: { l: ins("lIns", 7.2), t: ins("tIns", 3.6), r: ins("rIns", 7.2), b: ins("bIns", 3.6) },
      anchor: attr(body, "anchor") ?? "t",
      rot: num(attr(x, "rot")) / 60000 || undefined,
      flipH: attr(x, "flipH") === "1",
      flipV: attr(x, "flipV") === "1",
    };
  }

  async media(target: string) {
    if (this.wb.media.has(target)) return;
    const bytes = await this.pkg.bytes(target);
    if (!bytes) return;
    const ext = target.split(".").pop()?.toLowerCase() ?? "";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "bmp" ? "image/bmp" : ext === "emf" ? "image/emf" : ext === "wmf" ? "image/wmf" : ext === "tif" || ext === "tiff" ? "image/tiff" : ext === "webp" ? "image/webp" : "application/octet-stream";
    this.wb.media.set(target, { bytes, mime });
  }
}

/* ---------------------------------------------------------------- workbook */

export async function readXlsx(bytes: Uint8Array): Promise<Workbook> {
  const pkg = await Package.open(bytes);
  const main = (await pkg.mainPart(/officeDocument$/)) ?? "xl/workbook.xml";
  const wbPart = await pkg.part(main);
  if (!wbPart) throw new Error("This file is not an Excel workbook (.xlsx).");
  const root = wbPart.doc.documentElement;
  let themeDoc: Document | null = null;
  let stylesDoc: Document | null = null;
  let sstDoc: Document | null = null;
  for (const rel of wbPart.rels.values()) {
    if (/\/theme$/.test(rel.type)) themeDoc = await pkg.xml(rel.target);
    else if (/\/styles$/.test(rel.type)) stylesDoc = await pkg.xml(rel.target);
    else if (/\/sharedStrings$/.test(rel.type)) sstDoc = await pkg.xml(rel.target);
  }
  const theme = readTheme(themeDoc);
  const st = readStyles(stylesDoc, theme);
  const wb: Workbook = {
    sheets: [],
    styles: st.styles,
    dxfs: st.dxfs,
    defaultFont: st.defaultFont,
    theme,
    date1904: attr(kid(root, "workbookPr"), "date1904") === "1" || attr(kid(root, "workbookPr"), "date1904") === "true",
    charts: new Map(),
    media: new Map(),
    customTableStyles: st.custom,
    defaultTableStyle: st.defaultTableStyle,
    warnings: new Set(),
  };
  const palette = [...INDEXED];
  for (const [i, c] of kids(path(stylesDoc?.documentElement ?? null, "colors", "indexedColors"), "rgbColor").entries()) {
    const v = attr(c, "rgb");
    if (v) palette[i] = v.slice(-6).toUpperCase();
  }
  const colors = new Colors(theme, palette);
  const shared: SharedString[] = kids(sstDoc?.documentElement ?? null, "si").map((si) => richOf(si, colors, theme, st.defaultFont));
  const reader = new Reader(pkg, wb, shared, palette);
  const sheetEls = kids(kid(root, "sheets"), "sheet");
  // Print areas and titles, per sheet (localSheetId is the sheet's position).
  const names = kids(kid(root, "definedNames"), "definedName");
  for (const [i, s] of sheetEls.entries()) {
    const rel = wbPart.rels.get(attr(s, "id") ?? "");
    if (!rel || !/\/worksheet$/.test(rel.type)) continue; // chart sheets and dialogs are skipped
    const sheet = await reader.sheet(attr(s, "name") ?? `Sheet${i + 1}`, (attr(s, "state") as Sheet["state"]) ?? "visible", rel.target);
    if (!sheet) continue;
    for (const n of names) {
      if (num(attr(n, "localSheetId"), -1) !== i) continue;
      const nm = attr(n, "name");
      const refs = splitRefs(n.textContent ?? "").map(refPart);
      if (nm === "_xlnm.Print_Area") {
        const areas = refs.map(rangeRef).filter((r): r is Range => !!r);
        if (areas.length) sheet.printArea = areas;
      } else if (nm === "_xlnm.Print_Titles") {
        for (const r of refs.map(rangeRef)) {
          if (!r) continue;
          if (r.c0 === 0 && r.c1 === 16383) sheet.titleRows = [r.r0, r.r1];
          else if (r.r0 === 0 && r.r1 === 1048575) sheet.titleCols = [r.c0, r.c1];
        }
      }
    }
    if (kids(root, "sheets").length && sheet.rtl) wb.warnings.add("right-to-left sheets");
    wb.sheets.push(sheet);
  }
  for (const rel of (await pkg.rels("")).values()) {
    if (!/core-properties$/.test(rel.type)) continue;
    const core = await pkg.xml(rel.target);
    wb.title = core?.getElementsByTagNameNS("*", "title")[0]?.textContent?.trim() || undefined;
    wb.author = core?.getElementsByTagNameNS("*", "creator")[0]?.textContent?.trim() || undefined;
  }
  return wb;
}
