/**
 * An Excel workbook as the reader resolves it: every style index points at a
 * finished style (theme and indexed colours already turned into hex), and each
 * sheet carries its cells, sizes, merges, drawings and page setup. Rows and
 * columns are 0-based; lengths are in points unless a name says otherwise.
 */
import type { Theme } from "../ooxml";

export type XFont = {
  name: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline?: "single" | "double" | "singleAccounting" | "doubleAccounting";
  strike: boolean;
  color?: string; // hex; undefined means automatic (black)
  vertAlign?: "superscript" | "subscript";
};

export type XBorderSide = { style: string; color?: string };
export type XBorder = { left?: XBorderSide; right?: XBorderSide; top?: XBorderSide; bottom?: XBorderSide; diagonal?: XBorderSide; diagUp?: boolean; diagDown?: boolean };

export type XAlign = {
  h?: string; // general, left, center, right, fill, justify, centerContinuous, distributed
  v?: string; // top, center, bottom, justify, distributed
  wrap?: boolean;
  indent?: number;
  rotation?: number; // degrees, counter-clockwise; 255 = stacked letters
  shrink?: boolean;
};

export type XStyle = { font: XFont; fill?: string; border: XBorder; align: XAlign; numFmt: string };

/** A conditional or table format: only what it sets. */
export type Dxf = { font?: Partial<XFont>; fill?: string; border?: XBorder; numFmt?: string };

export type RichRun = { text: string; font: XFont };

export type Cell = {
  v: number | string | boolean | null;
  t: "n" | "s" | "b" | "e" | "str";
  s: number;
  rich?: RichRun[];
  /** A formula with no saved result (shown empty, as before Excel recalculates). */
  noCache?: boolean;
};

export type RowInfo = { ht?: number; custom?: boolean; hidden?: boolean; s?: number };
export type ColInfo = { min: number; max: number; width?: number; hidden?: boolean; s?: number };

export type Range = { r0: number; c0: number; r1: number; c1: number };

export type Anchor = { col: number; colOff: number; row: number; rowOff: number };
export type XShape = {
  geom: string;
  adj?: Record<string, number>;
  fill?: string;
  fillAlpha?: number;
  line?: { color: string; width: number; dash?: string };
  paras: { runs: { text: string; size: number; bold: boolean; italic: boolean; color?: string; font?: string }[]; align: string }[];
  insets: { l: number; t: number; r: number; b: number };
  anchor: string; // t, ctr, b
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
};
export type XDrawing = {
  from: Anchor;
  to?: Anchor;
  ext?: { w: number; h: number };
  abs?: { x: number; y: number };
  kind: "pic" | "chart" | "shape";
  image?: string; // media path
  crop?: { l: number; t: number; r: number; b: number }; // fractions
  chart?: string; // chart part path
  shape?: XShape;
  /** Where a grouped item sits in its group's anchor box, as fractions of the box. */
  sub?: { x: number; y: number; w: number; h: number };
};

export type XTable = { ref: Range; header: number; totals: number; style?: string; firstCol: boolean; lastCol: boolean; rowStripes: boolean; colStripes: boolean };

export type CfValue = { type: string; val?: string };
export type CfRule = {
  type: string; // cellIs, colorScale, dataBar, top10, aboveAverage, containsText, notContainsText, beginsWith, endsWith, containsBlanks, notContainsBlanks, duplicateValues, uniqueValues, expression, iconSet
  priority: number;
  stop?: boolean;
  dxf?: Dxf;
  operator?: string;
  formulas: string[];
  text?: string;
  rank?: number;
  percent?: boolean;
  bottom?: boolean;
  aboveAverage?: boolean;
  equalAverage?: boolean;
  cfvos?: CfValue[];
  colors?: string[];
  barColor?: string;
  gradient?: boolean;
};
export type CfBlock = { ranges: Range[]; rules: CfRule[] };

export type HeaderFooter = {
  oddHeader?: string;
  oddFooter?: string;
  evenHeader?: string;
  evenFooter?: string;
  firstHeader?: string;
  firstFooter?: string;
  differentOddEven: boolean;
  differentFirst: boolean;
  scaleWithDoc: boolean;
  alignWithMargins: boolean;
};

export type PageSetup = {
  paperW: number;
  paperH: number;
  landscape: boolean;
  scale: number; // percent
  fitToPage: boolean;
  fitW: number; // pages wide, 0 = as many as needed
  fitH: number;
  overThenDown: boolean;
  firstPageNumber?: number;
  margins: { left: number; right: number; top: number; bottom: number; header: number; footer: number };
  hCenter: boolean;
  vCenter: boolean;
  gridLines: boolean;
  headings: boolean;
  blackAndWhite: boolean;
};

export type Sheet = {
  name: string;
  state: "visible" | "hidden" | "veryHidden";
  cells: Map<number, Map<number, Cell>>;
  rows: Map<number, RowInfo>;
  cols: ColInfo[];
  defaultRowHeight?: number;
  defaultColWidth?: number; // characters (with padding), as stored
  baseColWidth: number;
  zeroHeight: boolean;
  merges: Range[];
  setup: PageSetup;
  hf: HeaderFooter;
  rowBreaks: number[]; // first row of each new page
  colBreaks: number[];
  printArea?: Range[];
  titleRows?: [number, number];
  titleCols?: [number, number];
  drawings: XDrawing[];
  tables: XTable[];
  cf: CfBlock[];
  links: { range: Range; url?: string; location?: string }[];
  rtl: boolean;
};

export type Workbook = {
  sheets: Sheet[];
  styles: XStyle[];
  dxfs: Dxf[];
  defaultFont: XFont;
  theme: Theme;
  date1904: boolean;
  charts: Map<string, Document>;
  media: Map<string, { bytes: Uint8Array; mime: string }>;
  customTableStyles: Map<string, Record<string, Dxf & { size?: number }>>;
  defaultTableStyle?: string;
  title?: string;
  author?: string;
  warnings: Set<string>;
};
