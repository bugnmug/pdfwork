/**
 * The Word document as the reader resolves it: every paragraph, run, table and
 * cell carries its final properties (defaults, styles, table style and direct
 * formatting already merged). Lengths are in points.
 */

export type Border = { style: string; width: number; color: string; space: number };
export type Sides<T> = { top?: T; left?: T; bottom?: T; right?: T };
export type ParaBorders = Sides<Border> & { between?: Border; bar?: Border };
export type CellBorders = Sides<Border> & { insideH?: Border; insideV?: Border; tl2br?: Border; tr2bl?: Border };

export type Fonts = { ascii?: string; hAnsi?: string; eastAsia?: string; cs?: string; hint?: string };

export type RunProps = {
  styleId?: string;
  fonts?: Fonts;
  size?: number;
  sizeCs?: number;
  bold?: boolean;
  boldCs?: boolean;
  italic?: boolean;
  italicCs?: boolean;
  underline?: string;
  underlineColor?: string;
  strike?: boolean;
  dstrike?: boolean;
  color?: string; // hex RRGGBB, or "auto"
  highlight?: string; // hex
  shading?: string; // hex fill
  vertAlign?: "superscript" | "subscript" | "baseline";
  position?: number; // raise (pt)
  caps?: boolean;
  smallCaps?: boolean;
  spacing?: number; // letter spacing (pt)
  scale?: number; // horizontal scale (%)
  vanish?: boolean;
  rtl?: boolean;
  cs?: boolean;
  border?: Border;
  emboss?: boolean;
  outline?: boolean;
  shadow?: boolean;
};

export type TabStop = { pos: number; val: string; leader?: string };

export type ParaProps = {
  styleId?: string;
  align?: string;
  indLeft?: number;
  indRight?: number;
  indFirst?: number; // first-line indent (positive) ...
  indHanging?: number; // ... or hanging indent (positive)
  spBefore?: number;
  spAfter?: number;
  spBeforeAuto?: boolean;
  spAfterAuto?: boolean;
  line?: number; // for "auto": multiple of single spacing; otherwise points
  lineRule?: "auto" | "exact" | "atLeast";
  contextual?: boolean;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  widowControl?: boolean;
  borders?: ParaBorders;
  shading?: string;
  tabs?: TabStop[];
  numId?: string;
  ilvl?: number;
  outlineLvl?: number;
  bidi?: boolean;
  frame?: { dropCap?: string; lines?: number; x?: number; y?: number; w?: number; h?: number; hAnchor?: string; vAnchor?: string; xAlign?: string; yAlign?: string; wrap?: string };
  suppressLineNumbers?: boolean;
};

export type Link = { url?: string; anchor?: string };

export type Inline =
  | { kind: "text"; text: string; rp: RunProps; link?: Link }
  | { kind: "tab"; rp: RunProps; link?: Link; ptab?: { align: string; leader?: string; relativeTo?: string } }
  | { kind: "br"; type: "line" | "page" | "column"; rp: RunProps }
  | { kind: "field"; field: string; format?: string; rp: RunProps; text: string; link?: Link }
  | { kind: "noteRef"; note: "footnote" | "endnote"; id: string; rp: RunProps; custom?: string }
  | { kind: "noteMark"; rp: RunProps } // the number at the start of a footnote's own text
  | { kind: "bookmark"; name: string }
  | { kind: "drawing"; d: Drawing; rp: RunProps; link?: Link }
  | { kind: "check"; checked: boolean; rp: RunProps };

export type Para = {
  kind: "p";
  pp: ParaProps;
  /** Properties of the paragraph mark: the height of an empty paragraph, the list label. */
  mark: RunProps;
  inlines: Inline[];
  /** A section ends with this paragraph. */
  sect?: Section;
  /** The paragraph sits in a table cell (for numbering and style decisions). */
  inTable?: boolean;
};

export type CellProps = {
  width?: { type: string; value: number };
  span: number;
  vMerge?: "restart" | "continue";
  borders: CellBorders;
  shading?: string;
  margins: Sides<number>;
  vAlign?: string;
  textDirection?: string;
  noWrap?: boolean;
  hideMark?: boolean;
};

export type Cell = { cp: CellProps; blocks: Block[] };
export type Row = {
  cells: Cell[];
  height?: { value: number; rule: string };
  header?: boolean;
  cantSplit?: boolean;
  gridBefore?: number;
  gridAfter?: number;
  wBefore?: number;
  wAfter?: number;
};

export type TableProps = {
  styleId?: string;
  width?: { type: string; value: number };
  align?: string;
  indent?: number;
  borders: CellBorders;
  cellMargins: Sides<number>;
  layout?: string;
  spacing?: number;
  shading?: string;
  bidi?: boolean;
  overlap?: string;
  floating?: { x?: number; y?: number; xAlign?: string; yAlign?: string; hAnchor?: string; vAnchor?: string; left?: number; right?: number; top?: number; bottom?: number };
};

export type Table = { kind: "tbl"; tp: TableProps; grid: number[]; rows: Row[] };

export type Block = Para | Table;

export type HeaderSet = { default?: string; first?: string; even?: string };

export type Section = {
  pageW: number;
  pageH: number;
  orient?: string;
  margin: { top: number; right: number; bottom: number; left: number; header: number; footer: number; gutter: number };
  cols: { num: number; space: number; sep: boolean; equal: boolean; widths?: { w: number; space: number }[] };
  titlePg: boolean;
  headers: HeaderSet;
  footers: HeaderSet;
  pgNumStart?: number;
  pgNumFmt?: string;
  type: string;
  vAlign?: string;
  pgBorders?: Sides<Border> & { offsetFrom?: string; display?: string; zOrder?: string };
  rtlGutter?: boolean;
  bidi?: boolean;
};

/* ---------------------------------------------------------------- drawings */

export type Fill = { color?: string; alpha?: number; image?: string; gradient?: { stops: { pos: number; color: string; alpha: number }[]; angle: number } };
export type Line = { color: string; alpha?: number; width: number; dash?: string; head?: string; tail?: string };

export type ShapeNode = {
  kind: "shape";
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
  geom: string;
  adj?: Record<string, number>;
  path?: { w: number; h: number; d: string; fill: boolean; stroke: boolean }[];
  fill?: Fill;
  line?: Line;
  image?: { src: string; crop?: Sides<number> };
  text?: { blocks: Block[]; insets: Sides<number>; anchor: string; vertical?: string; autofit?: boolean; wrap?: boolean };
  /** WordArt-style text on a path (watermarks). */
  textPath?: { text: string; font?: string; size?: number; bold?: boolean; italic?: boolean };
  /** A chart part (its path in the package). */
  chart?: string;
};
export type GroupNode = { kind: "group"; x: number; y: number; w: number; h: number; rot?: number; children: (ShapeNode | GroupNode)[] };

export type Placement = {
  /** "inline" sits in the line like a character; others float. */
  mode: "inline" | "anchor";
  wrap?: "none" | "square" | "tight" | "through" | "topAndBottom";
  behind?: boolean;
  hRel?: string;
  hAlign?: string;
  hOffset?: number;
  vRel?: string;
  vAlign?: string;
  vOffset?: number;
  dist: Sides<number>;
  z?: number;
  inCell?: boolean;
  wrapSide?: string;
};

export type Drawing = {
  w: number;
  h: number;
  place: Placement;
  node: ShapeNode | GroupNode;
  alt?: string;
  link?: Link;
  /** A chart, SmartArt or OLE object we could only partly draw. */
  partial?: string;
  /** Size as a share of the page or margins (Word 2010 relative sizes), 0..1. */
  relW?: { pct: number; rel: string };
  relH?: { pct: number; rel: string };
  /** The shape grows or shrinks to fit its text. */
  autofit?: boolean;
};

/* --------------------------------------------------------------- numbering */

export type Level = {
  start: number;
  fmt: string;
  text: string;
  restart?: number;
  legal?: boolean;
  suffix: string;
  jc: string;
  pp: ParaProps;
  rp: RunProps;
  picBullet?: string;
};
export type AbstractNum = { levels: Level[]; styleLink?: string; numStyleLink?: string };
export type NumDef = { abstractId: string; overrides: Map<number, { start?: number; level?: Level }> };

export type Settings = {
  defaultTab: number;
  evenAndOdd: boolean;
  sumSpacing: boolean;
  footnoteFmt: string;
  footnoteStart: number;
  footnoteRestart?: string;
  endnoteFmt: string;
  compatMode: number;
  mirrorMargins: boolean;
  gutterAtTop: boolean;
  bordersDoNotSurroundHeader: boolean;
  bordersDoNotSurroundFooter: boolean;
};

export type DocxModel = {
  sections: { sect: Section; blocks: Block[] }[];
  parts: Map<string, Block[]>; // header and footer parts, by path
  footnotes: Map<string, Block[]>;
  endnotes: Map<string, Block[]>;
  footnoteSep?: Block[];
  abstracts: Map<string, AbstractNum>;
  nums: Map<string, NumDef>;
  settings: Settings;
  media: Map<string, { bytes: Uint8Array; mime: string }>;
  /** Paragraph style id → outline level (headings) and the default paragraph style. */
  headingLevel: (styleId: string | undefined) => number | undefined;
  defaultParaStyle?: string;
  warnings: Set<string>;
  charts: Map<string, Document>;
  theme: import("../ooxml").Theme;
  title?: string;
  author?: string;
};
