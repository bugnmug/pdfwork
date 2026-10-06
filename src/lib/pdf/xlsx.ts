/**
 * A small .xlsx writer with the styling a converted document needs: fonts, colours, fills,
 * borders, number and date formats, alignment, wrapped text, merged cells, column widths, row
 * heights and a filter on a table's header row. Strings go in the shared string table.
 */
import { zipSync, strToU8 } from "fflate";

export type Border = { style: "thin" | "medium" | "double"; color?: string };
export type XStyle = {
  font?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  /** Text colour, RRGGBB. */
  color?: string;
  /** Background, RRGGBB. */
  fill?: string;
  /** Excel number format code ("#,##0.00", "dd/mm/yy"). */
  numFmt?: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "center" | "bottom";
  wrap?: boolean;
  /** Indent from the left edge, in steps of about three characters. */
  indent?: number;
  border?: { top?: Border; bottom?: Border; left?: Border; right?: Border };
};
/** A cell: text, a number, or a date (as an Excel serial day number with a date format). */
export type XCell = { v: string | number; style?: XStyle };
export type XSheet = {
  name: string;
  rows: (XCell | null)[][];
  /** Column widths in characters. */
  widths?: number[];
  /** Row heights in points, where a row needs its own. */
  heights?: (number | undefined)[];
  /** Merged ranges: first row, first column, last row, last column (0-based). */
  merges?: [number, number, number, number][];
  /** A filter on a table, from its header row: first row, first column, last row, last column (0-based). */
  filter?: [number, number, number, number];
  /** Printing: scaled to one page's width, and turned sideways. */
  print?: { fitWidth?: boolean; landscape?: boolean; letter?: boolean };
};

const BUILTIN_FMT: Record<string, number> = { General: 0, "0": 1, "0.00": 2, "#,##0": 3, "#,##0.00": 4, "0%": 9, "0.00%": 10 };

/** Text safe inside XML: escaped, without the control characters XML forbids. */
const xml = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A1-style reference of a 0-based row and column. */
export function ref(r: number, c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return `${s}${r + 1}`;
}

/** A sheet name Excel accepts: no []:*?/\ , at most 31 characters, unique in the workbook. */
function sheetName(name: string, used: Set<string>): string {
  const base = (name.replace(/[[\]:*?/\\]/g, " ").replace(/^'+|'+$/g, "").trim() || "Sheet").slice(0, 31);
  let n = base;
  for (let k = 2; used.has(n.toLowerCase()); k++) n = `${base.slice(0, 31 - String(k).length - 1)} ${k}`;
  used.add(n.toLowerCase());
  return n;
}

class Styles {
  fonts: string[] = [];
  fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  borders: string[] = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  fmts = new Map<string, number>();
  xfs: string[] = [];
  private keys = new Map<string, number>();
  constructor(private base: { font: string; size: number }) {
    this.font({});
    this.xfs.push('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
    this.keys.set("{}", 0);
  }
  private index(list: string[], x: string): number {
    const i = list.indexOf(x);
    if (i >= 0) return i;
    list.push(x);
    return list.length - 1;
  }
  private font(s: XStyle): number {
    const parts = [
      s.bold ? "<b/>" : "",
      s.italic ? "<i/>" : "",
      `<sz val="${s.size ?? this.base.size}"/>`,
      s.color ? `<color rgb="FF${s.color}"/>` : "",
      `<name val="${xml(s.font ?? this.base.font)}"/>`,
      '<family val="2"/>',
    ];
    return this.index(this.fonts, `<font>${parts.join("")}</font>`);
  }
  private border(b: NonNullable<XStyle["border"]>): number {
    const side = (k: "left" | "right" | "top" | "bottom") => {
      const x = b[k];
      return x ? `<${k} style="${x.style}"><color rgb="FF${x.color ?? "000000"}"/></${k}>` : `<${k}/>`;
    };
    return this.index(this.borders, `<border>${side("left")}${side("right")}${side("top")}${side("bottom")}<diagonal/></border>`);
  }
  private numFmt(code: string): number {
    if (code in BUILTIN_FMT) return BUILTIN_FMT[code];
    if (!this.fmts.has(code)) this.fmts.set(code, 164 + this.fmts.size);
    return this.fmts.get(code)!;
  }
  /** The cell format index for a style. */
  id(s: XStyle = {}): number {
    const key = JSON.stringify(s);
    const known = this.keys.get(key);
    if (known !== undefined) return known;
    const fontId = this.font(s);
    const fillId = s.fill ? this.index(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${s.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const borderId = s.border ? this.border(s.border) : 0;
    const numFmtId = s.numFmt ? this.numFmt(s.numFmt) : 0;
    const align = s.align || s.valign || s.wrap || s.indent ? `<alignment${s.align ? ` horizontal="${s.align}"` : ""}${s.valign ? ` vertical="${s.valign}"` : ""}${s.wrap ? ' wrapText="1"' : ""}${s.indent ? ` indent="${s.indent}"` : ""}/>` : "";
    const apply = `${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}${numFmtId ? ' applyNumberFormat="1"' : ""}${align ? ' applyAlignment="1"' : ""}`;
    this.xfs.push(`<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${apply}>${align}</xf>`);
    this.keys.set(key, this.xfs.length - 1);
    return this.xfs.length - 1;
  }
  xml(): string {
    const fmts = [...this.fmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xml(code)}"/>`).join("");
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      (fmts ? `<numFmts count="${this.fmts.size}">${fmts}</numFmts>` : "") +
      `<fonts count="${this.fonts.length}">${this.fonts.join("")}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.join("")}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.join("")}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.join("")}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>"
    );
  }
}

/** The workbook as .xlsx bytes. `font`: the default font and size (points). */
export function writeXlsx(sheets: XSheet[], o: { font: string; size: number; title?: string }): Uint8Array {
  const styles = new Styles({ font: o.font, size: o.size });
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const str = (s: string) => {
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  };
  const used = new Set<string>();
  const names = sheets.map((s) => sheetName(s.name, used));
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, text: string) => (files[path] = strToU8(text));

  sheets.forEach((sh, si) => {
    const width = Math.max(1, ...sh.rows.map((r) => r.length));
    const rowsXml: string[] = [];
    sh.rows.forEach((row, r) => {
      const ht = sh.heights?.[r];
      const cells = row
        .map((c, k) => {
          if (!c) return "";
          const s = c.style ? styles.id(c.style) : 0;
          const sa = s ? ` s="${s}"` : "";
          if (typeof c.v === "number") return Number.isFinite(c.v) ? `<c r="${ref(r, k)}"${sa}><v>${c.v}</v></c>` : "";
          if (c.v === "") return s ? `<c r="${ref(r, k)}"${sa}/>` : "";
          return `<c r="${ref(r, k)}"${sa} t="s"><v>${str(c.v)}</v></c>`;
        })
        .join("");
      if (!cells && ht === undefined) return;
      rowsXml.push(`<row r="${r + 1}"${ht !== undefined ? ` ht="${Math.round(ht * 4) / 4}" customHeight="1"` : ""}>${cells}</row>`);
    });
    const cols = sh.widths?.length ? `<cols>${sh.widths.map((w, k) => `<col min="${k + 1}" max="${k + 1}" width="${Math.round(w * 100) / 100}" customWidth="1"/>`).join("")}</cols>` : "";
    const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(([r0, c0, r1, c1]) => `<mergeCell ref="${ref(r0, c0)}:${ref(r1, c1)}"/>`).join("")}</mergeCells>` : "";
    const filter = sh.filter ? `<autoFilter ref="${ref(sh.filter[0], sh.filter[1])}:${ref(sh.filter[2], sh.filter[3])}"/>` : "";
    const last = ref(Math.max(0, sh.rows.length - 1), width - 1);
    // Codes and account numbers kept as text on purpose: no "number stored as text" flags.
    const ignored = `<ignoredErrors><ignoredError sqref="A1:${last}" numberStoredAsText="1"/></ignoredErrors>`;
    put(
      `xl/worksheets/sheet${si + 1}.xml`,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        (sh.print?.fitWidth ? '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' : "") +
        `<dimension ref="A1:${last}"/>` +
        `<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ""}/></sheetViews>` +
        `<sheetFormatPr defaultRowHeight="${Math.round(o.size * 1.32 * 4) / 4}"/>` +
        cols +
        `<sheetData>${rowsXml.join("")}</sheetData>` +
        filter +
        merges +
        '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
        (sh.print ? `<pageSetup paperSize="${sh.print.letter ? 1 : 9}"${sh.print.landscape ? ' orientation="landscape"' : ""}${sh.print.fitWidth ? ' fitToWidth="1" fitToHeight="0"' : ""}/>` : "") +
        ignored +
        "</worksheet>",
    );
  });

  // Absolute reference ($A$1) of a 0-based row and column.
  const abs = (r: number, c: number) => "$" + ref(r, c).replace(/(\d+)$/, "$$$1");
  const filters = sheets.flatMap((sh, si) => (sh.filter ? [`<definedName name="_xlnm._FilterDatabase" localSheetId="${si}" hidden="1">'${xml(names[si].replace(/'/g, "''"))}'!${abs(sh.filter[0], sh.filter[1])}:${abs(sh.filter[2], sh.filter[3])}</definedName>`] : []));
  put(
    "xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="17000"/></bookViews>' +
      `<sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
      (filters.length ? `<definedNames>${filters.join("")}</definedNames>` : "") +
      "</workbook>",
  );
  put(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId${names.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
      "</Relationships>",
  );
  put(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
      strings.map((s) => `<si><t${/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : ""}>${xml(s)}</t></si>`).join("") +
      "</sst>",
  );
  put("xl/styles.xml", styles.xml());
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  put(
    "docProps/core.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      (o.title ? `<dc:title>${xml(o.title)}</dc:title>` : "") +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
  );
  put(
    "docProps/app.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DoYourPDF</Application></Properties>',
  );
  put(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      "</Relationships>",
  );
  put(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      "</Types>",
  );
  // [Content_Types].xml first, as Office expects.
  const ordered: Record<string, Uint8Array> = { "[Content_Types].xml": files["[Content_Types].xml"] };
  for (const [k, v] of Object.entries(files)) if (k !== "[Content_Types].xml") ordered[k] = v;
  return zipSync(ordered, { level: 6 });
}
