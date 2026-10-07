/**
 * PowerPoint tables: the grid with merged cells, rows grown to fit their text,
 * cell fills and borders from the table style (PowerPoint's 74 built-in styles
 * included, for files that only name them) under each cell's own formatting.
 */
import { attr, kid, kids, num, type El, type Part } from "../ooxml";
import { colorIn, fillFrom, mergeLine, paintFill, paintLine, readFill, readLine, type Fill, type Frame, type Line } from "../drawingml/fill";
import { presetGeometry } from "../drawingml/geometry";
import { then, translate, type Mat, type RGBA } from "../drawingml/pen";
import { readBodyProps, SlideText, type ListSrc } from "./text";
import type { SlideEnv, SlidePainter } from "./slide";

type Side = "left" | "right" | "top" | "bottom" | "insideH" | "insideV";
type PartStyle = { fill?: Fill; borders: Partial<Record<Side, Line>>; color?: RGBA; bold?: boolean; italic?: boolean; font?: string };
type TblStyle = { parts: Partial<Record<string, PartStyle>>; bg?: Fill };

const PARTS = ["wholeTbl", "band1H", "band2H", "band1V", "band2V", "firstCol", "lastCol", "firstRow", "lastRow", "seCell", "swCell", "neCell", "nwCell"];

/* PowerPoint's built-in table styles, by family (rules after LibreOffice's map of all 74). */
const BUILTIN: Record<string, [string, string]> = {
  "{2D5ABB26-0587-4C30-8999-92F81FD0307C}": ["themed1", ""],
  "{3C2FFA5D-87B4-456A-9821-1D502468CF0F}": ["themed1", "accent1"],
  "{284E427A-3D55-4303-BF80-6455036E1DE7}": ["themed1", "accent2"],
  "{69C7853C-536D-4A76-A0AE-DD22124D55A5}": ["themed1", "accent3"],
  "{775DCB02-9BB8-47FD-8907-85C794F793BA}": ["themed1", "accent4"],
  "{35758FB7-9AC5-4552-8A53-C91805E547FA}": ["themed1", "accent5"],
  "{08FB837D-C827-4EFA-A057-4D05807E0F7C}": ["themed1", "accent6"],
  "{5940675A-B579-460E-94D1-54222C63F5DA}": ["themed2", ""],
  "{D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7}": ["themed2", "accent1"],
  "{18603FDC-E32A-4AB5-989C-0864C3EAD2B8}": ["themed2", "accent2"],
  "{306799F8-075E-4A3A-A7F6-7FBC6576F1A4}": ["themed2", "accent3"],
  "{E269D01E-BC32-4049-B463-5C60D7B0CCD2}": ["themed2", "accent4"],
  "{327F97BB-C833-4FB7-BDE5-3F7075034690}": ["themed2", "accent5"],
  "{638B1855-1B75-4FBE-930C-398BA8C253C6}": ["themed2", "accent6"],
  "{9D7B26C5-4107-4FEC-AEDC-1716B250A1EF}": ["light1", ""],
  "{3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5}": ["light1", "accent1"],
  "{0E3FDE45-AF77-4B5C-9715-49D594BDF05E}": ["light1", "accent2"],
  "{C083E6E3-FA7D-4D7B-A595-EF9225AFEA82}": ["light1", "accent3"],
  "{D27102A9-8310-4765-A935-A1911B00CA55}": ["light1", "accent4"],
  "{5FD0F851-EC5A-4D38-B0AD-8093EC10F338}": ["light1", "accent5"],
  "{68D230F3-CF80-4859-8CE7-A43EE81993B5}": ["light1", "accent6"],
  "{7E9639D4-E3E2-4D34-9284-5A2195B3D0D7}": ["light2", ""],
  "{69012ECD-51FC-41F1-AA8D-1B2483CD663E}": ["light2", "accent1"],
  "{72833802-FEF1-4C79-8D5D-14CF1EAF98D9}": ["light2", "accent2"],
  "{F2DE63D5-997A-4646-A377-4702673A728D}": ["light2", "accent3"],
  "{17292A2E-F333-43FB-9621-5CBBE7FDCDCB}": ["light2", "accent4"],
  "{5A111915-BE36-4E01-A7E5-04B1672EAD32}": ["light2", "accent5"],
  "{912C8C85-51F0-491E-9774-3900AFEF0FD7}": ["light2", "accent6"],
  "{616DA210-FB5B-4158-B5E0-FEB733F419BA}": ["light3", ""],
  "{BC89EF96-8CEA-46FF-86C4-4CE0E7609802}": ["light3", "accent1"],
  "{5DA37D80-6434-44D0-A028-1B22A696006F}": ["light3", "accent2"],
  "{8799B23B-EC83-4686-B30A-512413B5E67A}": ["light3", "accent3"],
  "{ED083AE6-46FA-4A59-8FB0-9F97EB10719F}": ["light3", "accent4"],
  "{BDBED569-4797-4DF1-A0F4-6AAB3CD982D8}": ["light3", "accent5"],
  "{E8B1032C-EA38-4F05-BA0D-38AFFFC7BED3}": ["light3", "accent6"],
  "{793D81CF-94F2-401A-BA57-92F5A7B2D0C5}": ["medium1", ""],
  "{B301B821-A1FF-4177-AEE7-76D212191A09}": ["medium1", "accent1"],
  "{9DCAF9ED-07DC-4A11-8D7F-57B35C25682E}": ["medium1", "accent2"],
  "{1FECB4D8-DB02-4DC6-A0A2-4F2EBAE1DC90}": ["medium1", "accent3"],
  "{1E171933-4619-4E11-9A3F-F7608DF75F80}": ["medium1", "accent4"],
  "{FABFCF23-3B69-468F-B69F-88F6DE6A72F2}": ["medium1", "accent5"],
  "{10A1B5D5-9B99-4C35-A422-299274C87663}": ["medium1", "accent6"],
  "{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}": ["medium2", ""],
  "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}": ["medium2", "accent1"],
  "{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}": ["medium2", "accent2"],
  "{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}": ["medium2", "accent3"],
  "{00A15C55-8517-42AA-B614-E9B94910E393}": ["medium2", "accent4"],
  "{7DF18680-E054-41AD-8BC1-D1AEF772440D}": ["medium2", "accent5"],
  "{93296810-A885-4BE3-A3E7-6D5BEEA58F35}": ["medium2", "accent6"],
  "{8EC20E35-A176-4012-BC5E-935CFFF8708E}": ["medium3", ""],
  "{6E25E649-3F16-4E02-A733-19D2CDBF48F0}": ["medium3", "accent1"],
  "{85BE263C-DBD7-4A20-BB59-AAB30ACAA65A}": ["medium3", "accent2"],
  "{EB344D84-9AFB-497E-A393-DC336BA19D2E}": ["medium3", "accent3"],
  "{EB9631B5-78F2-41C9-869B-9F39066F8104}": ["medium3", "accent4"],
  "{74C1A8A3-306A-4EB7-A6B1-4F7E0EB9C5D6}": ["medium3", "accent5"],
  "{2A488322-F2BA-4B5B-9748-0D474271808F}": ["medium3", "accent6"],
  "{D7AC3CCA-C797-4891-BE02-D94E43425B78}": ["medium4", ""],
  "{69CF1AB2-1976-4502-BF36-3FF5EA218861}": ["medium4", "accent1"],
  "{8A107856-5554-42FB-B03E-39F5DBC370BA}": ["medium4", "accent2"],
  "{0505E3EF-67EA-436B-97B2-0124C06EBD24}": ["medium4", "accent3"],
  "{C4B1156A-380E-4F78-BDF5-A606A8083BF9}": ["medium4", "accent4"],
  "{22838BEF-8BB2-4498-84A7-C5851F593DF1}": ["medium4", "accent5"],
  "{16D9F66E-5EB9-4882-86FB-DCBF35E3C3E4}": ["medium4", "accent6"],
  "{E8034E78-7F5D-4C2E-B375-FC64B27BC917}": ["dark1", ""],
  "{125E5076-3810-47DD-B79F-674D7AD40C01}": ["dark1", "accent1"],
  "{37CE84F3-28C3-443E-9E96-99CF82512B78}": ["dark1", "accent2"],
  "{D03447BB-5D67-496B-8E87-E561075AD55C}": ["dark1", "accent3"],
  "{E929F9F4-4A8F-4326-A1B4-22849713DDAB}": ["dark1", "accent4"],
  "{8FD4443E-F989-4FC4-A0C8-D5A2AF1F390B}": ["dark1", "accent5"],
  "{AF606853-7671-496A-8E4F-DF71F8EC918B}": ["dark1", "accent6"],
  "{5202B0CA-FC54-4496-8BCA-5EF66A818D29}": ["dark2", ""],
  "{0660B408-B3CF-4A94-85FC-2B1E0A45F4A2}": ["dark2", "accent1"],
  "{91EBBBCC-DAD2-459C-BE2E-F6DE35CF9A28}": ["dark2", "accent3"],
  "{46F890A9-2807-4EBB-B81D-B2AA78EC7F39}": ["dark2", "accent5"],
};

function builtinStyle(id: string, e: SlideEnv): TblStyle | null {
  const hit = BUILTIN[id.toUpperCase()];
  if (!hit) return null;
  const [family, accent] = hit;
  const doc = new DOMParser().parseFromString(`<x xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>`, "application/xml");
  const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  /** A scheme colour with modifiers, resolved through the slide's theme. */
  const clr = (scheme: string, mods: [string, number][] = []): RGBA => {
    const wrap = doc.createElementNS(A, "a:w");
    const c = doc.createElementNS(A, "a:schemeClr");
    c.setAttribute("val", scheme);
    for (const [k, v] of mods) {
      const m = doc.createElementNS(A, `a:${k}`);
      m.setAttribute("val", String(v));
      c.appendChild(m);
    }
    wrap.appendChild(c);
    return colorIn(wrap, e.cc) ?? { hex: "000000", alpha: 1 };
  };
  const solid = (c: RGBA): Fill => ({ kind: "solid", color: c });
  const ln = (c: RGBA, w = 1): Line => ({ width: w, fill: solid(c), dash: "solid" });
  const parts: Record<string, PartStyle> = {};
  const P = (k: string) => (parts[k] ??= { borders: {} });
  const acc = accent || "";
  const set4 = (k: string, c: RGBA, sides: Side[] = ["left", "right", "top", "bottom"]) => {
    for (const s of sides) P(k).borders[s] = ln(c);
  };
  for (const k of ["firstRow", "lastRow", "firstCol", "lastCol"]) P(k).bold = true;
  switch (family) {
    case "themed1": {
      if (acc) {
        const a = clr(acc);
        set4("wholeTbl", a, ["left", "right", "top", "bottom", "insideH", "insideV"]);
        P("wholeTbl").color = clr("dk1");
        P("firstRow").color = clr("lt1");
        set4("firstRow", a, ["left", "right", "top"]);
        P("firstRow").borders.bottom = ln(clr("lt1"));
        P("firstRow").fill = solid(a);
        set4("lastRow", a);
        set4("firstCol", a, ["left", "right", "top", "bottom", "insideH"]);
        set4("lastCol", a, ["left", "right", "top", "bottom", "insideH"]);
        P("band1H").fill = solid(clr(acc, [["alpha", 40000]]));
        P("band1V").fill = solid(clr(acc, [["alpha", 40000]]));
      } else P("wholeTbl").color = clr("tx1");
      break;
    }
    case "themed2": {
      const a = acc || "tx1";
      set4("wholeTbl", clr(a, [["tint", 50000]]));
      if (acc) {
        P("wholeTbl").color = clr("lt1");
        P("firstRow").color = clr("lt1");
        P("firstRow").borders.bottom = ln(clr("lt1"));
        P("lastRow").borders.top = ln(clr("lt1"));
        P("firstCol").borders.right = ln(clr("lt1"));
        P("lastCol").borders.left = ln(clr("lt1"));
        P("band1H").fill = solid(clr("lt1", [["alpha", 20000]]));
        P("band1V").fill = solid(clr("lt1", [["alpha", 20000]]));
        return { parts, bg: solid(clr(acc)) };
      }
      P("wholeTbl").borders.insideH = ln(clr("tx1"));
      P("wholeTbl").borders.insideV = ln(clr("tx1"));
      break;
    }
    case "light1": {
      const a = acc || "tx1";
      set4("wholeTbl", clr(a), ["top", "bottom"]);
      P("firstRow").borders.bottom = ln(clr(a));
      P("lastRow").borders.top = ln(clr(a));
      P("wholeTbl").color = clr("tx1");
      P("firstRow").color = clr("tx1");
      P("lastCol").color = clr("tx1");
      P("band1H").fill = solid(clr(a, [["alpha", 20000]]));
      P("band1V").fill = solid(clr(a, [["alpha", 20000]]));
      break;
    }
    case "light2": {
      const a = acc || "tx1";
      set4("wholeTbl", clr(a));
      P("wholeTbl").color = clr("tx1");
      P("firstRow").color = clr("bg1");
      P("firstRow").fill = solid(clr(a));
      P("lastRow").borders.top = ln(clr(a));
      P("band1H").borders.top = ln(clr(a));
      P("band1H").borders.bottom = ln(clr(a));
      for (const k of ["band1V", "band2V"]) {
        P(k).borders.left = ln(clr(a));
        P(k).borders.right = ln(clr(a));
      }
      break;
    }
    case "light3": {
      const a = acc || "tx1";
      set4("wholeTbl", clr(a), ["left", "right", "top", "bottom", "insideH", "insideV"]);
      P("wholeTbl").color = clr("tx1");
      P("firstRow").color = clr(a);
      P("firstRow").borders.bottom = ln(clr(a));
      P("lastRow").borders.top = ln(clr(a));
      P("band1H").fill = solid(clr(a, [["alpha", 20000]]));
      P("band1V").fill = solid(clr(a, [["alpha", 20000]]));
      break;
    }
    case "medium1": {
      const a = acc || "dk1";
      set4("wholeTbl", clr(a), ["left", "right", "top", "bottom", "insideH"]);
      P("wholeTbl").color = clr("dk1");
      P("wholeTbl").fill = solid(clr("lt1"));
      P("firstRow").color = clr("lt1");
      P("firstRow").fill = solid(clr(a));
      P("lastRow").fill = solid(clr("lt1"));
      P("lastRow").borders.top = ln(clr(a));
      P("band1H").fill = solid(clr(a, [["tint", 20000]]));
      P("band1V").fill = solid(clr(a, [["tint", 20000]]));
      break;
    }
    case "medium2": {
      const a = acc || "dk1";
      set4("wholeTbl", clr("lt1"), ["left", "right", "top", "bottom", "insideH", "insideV"]);
      P("wholeTbl").color = clr("dk1");
      P("wholeTbl").fill = solid(clr(a, [["tint", 20000]]));
      for (const k of ["firstRow", "lastRow", "firstCol", "lastCol"]) {
        P(k).color = clr("lt1");
        P(k).fill = solid(clr(a));
      }
      P("firstRow").borders.bottom = ln(clr("lt1"), 3);
      P("lastRow").borders.top = ln(clr("lt1"), 3);
      P("band1H").fill = solid(clr(a, [["tint", 40000]]));
      P("band1V").fill = solid(clr(a, [["tint", 40000]]));
      break;
    }
    case "medium3": {
      const a = acc || "dk1";
      set4("wholeTbl", clr("dk1"), ["top", "bottom"]);
      P("wholeTbl").color = clr("dk1");
      P("wholeTbl").fill = solid(clr("lt1"));
      P("lastRow").fill = solid(clr("lt1"));
      P("band1H").fill = solid(clr("dk1", [["tint", 20000]]));
      P("band1V").fill = solid(clr("dk1", [["tint", 20000]]));
      P("firstRow").color = clr("lt1");
      P("firstRow").borders.bottom = ln(clr("dk1"), 3);
      P("lastRow").borders.top = ln(clr("dk1"), 3);
      for (const k of ["firstRow", "firstCol", "lastCol"]) P(k).fill = solid(clr(a));
      P("firstCol").color = clr("lt1");
      P("lastCol").color = clr("lt1");
      break;
    }
    case "medium4": {
      const a = acc || "dk1";
      set4("wholeTbl", clr(a), ["left", "right", "top", "bottom", "insideH", "insideV"]);
      P("wholeTbl").color = clr("dk1");
      P("wholeTbl").fill = solid(clr(a, [["tint", 20000]]));
      P("lastRow").borders.top = ln(clr("dk1"));
      P("lastRow").fill = solid(clr("dk1", [["tint", 20000]]));
      P("firstRow").color = clr(a);
      P("firstRow").fill = solid(clr(a, [["tint", 20000]]));
      P("band1H").fill = solid(clr(a, [["tint", 40000]]));
      P("band1V").fill = solid(clr(a, [["tint", 40000]]));
      break;
    }
    case "dark1": {
      const a = acc || "dk1";
      const t = acc ? "shade" : "tint";
      P("wholeTbl").color = clr("dk1");
      P("firstRow").color = clr("lt1");
      P("firstRow").borders.bottom = ln(clr("lt1"));
      P("firstCol").borders.right = ln(clr("lt1"));
      P("lastCol").borders.left = ln(clr("lt1"));
      P("lastRow").borders.top = ln(clr("lt1"));
      P("firstRow").fill = solid(clr("dk1"));
      P("wholeTbl").fill = solid(clr(a, [[t, 20000]]));
      P("lastRow").fill = solid(clr(a));
      P("band1H").fill = solid(clr(a, [[t, 40000]]));
      P("band1V").fill = solid(clr(a, [[t, 40000]]));
      P("firstCol").fill = solid(clr(a, [[t, 60000]]));
      P("lastCol").fill = solid(clr(a, [[t, 60000]]));
      break;
    }
    case "dark2": {
      const a = acc || "dk1";
      P("wholeTbl").color = clr("dk1");
      P("firstRow").color = clr("lt1");
      P("lastRow").borders.top = ln(clr("dk1"));
      const head = !acc ? "dk1" : acc === "accent1" ? "accent2" : acc === "accent3" ? "accent4" : "accent6";
      P("firstRow").fill = solid(clr(head));
      P("wholeTbl").fill = solid(clr(a, [["tint", 20000]]));
      P("lastRow").fill = solid(clr(a, [["tint", 20000]]));
      P("band1H").fill = solid(clr(a, [["tint", 40000]]));
      P("band1V").fill = solid(clr(a, [["tint", 40000]]));
      break;
    }
  }
  return { parts };
}

/** A style written out in ppt/tableStyles.xml. */
function readStyle(el: El, e: SlideEnv): TblStyle {
  const parts: Record<string, PartStyle> = {};
  for (const name of PARTS) {
    const p = kid(el, name);
    if (!p) continue;
    const ps: PartStyle = { borders: {} };
    const tx = kid(p, "tcTxStyle");
    if (tx) {
      if (attr(tx, "b") === "on") ps.bold = true;
      if (attr(tx, "b") === "off") ps.bold = false;
      if (attr(tx, "i") === "on") ps.italic = true;
      const c = colorIn(tx, e.cc);
      if (c) ps.color = c;
      const fr = kid(tx, "fontRef");
      if (fr) {
        ps.font = attr(fr, "idx") ?? undefined;
        if (!c) ps.color = colorIn(fr, e.cc) ?? undefined;
      }
    }
    const tc = kid(p, "tcStyle");
    const bdr = kid(tc, "tcBdr");
    for (const s of ["left", "right", "top", "bottom", "insideH", "insideV"] as Side[]) {
      const b = kid(bdr, s);
      if (!b) continue;
      const lnEl = kid(b, "ln");
      if (lnEl) ps.borders[s] = readLine(lnEl, e.cc);
      const lnRef = kid(b, "lnRef");
      if (lnRef && !lnEl) {
        const idx = num(attr(lnRef, "idx"));
        const base = e.fmt.ln[idx - 1];
        if (base) ps.borders[s] = readLine(base, e.cc, colorIn(lnRef, e.cc)?.hex);
      }
    }
    const f = kid(tc, "fill");
    if (f) ps.fill = readFill(f, e.cc);
    const fr = kid(tc, "fillRef");
    if (fr && !f) {
      const idx = num(attr(fr, "idx"));
      const base = idx >= 1001 ? e.fmt.bg[idx - 1001] : e.fmt.fill[idx - 1];
      if (base) ps.fill = fillFrom(base, e.cc, colorIn(fr, e.cc)?.hex);
    }
    parts[name] = ps;
  }
  const bgEl = kid(el, "tblBg");
  const bg = bgEl ? readFill(bgEl, e.cc) : undefined;
  return { parts, bg };
}

type CellBox = { tc: El; r: number; c: number; rs: number; cs: number; x: number; y: number; w: number; h: number; parts: string[] };

export async function drawTable(e: SlideEnv, painter: SlidePainter, tbl: El, m: Mat, _w: number, _h: number, part: Part) {
  const pr = kid(tbl, "tblPr");
  const flag = (k: string) => attr(pr, k) === "1" || attr(pr, k) === "true";
  const styleId = (kid(pr, "tableStyleId")?.textContent ?? "").trim();
  let style: TblStyle | null = null;
  const styleEl = kid(pr, "tableStyle") ?? (styleId ? e.pres.tableStyles.get(styleId) : undefined);
  if (styleEl) style = readStyle(styleEl, e);
  else if (styleId) style = builtinStyle(styleId, e);
  const grid = kids(kid(tbl, "tblGrid"), "gridCol").map((g) => num(attr(g, "w")) / 12700);
  const rows = kids(tbl, "tr");
  const nR = rows.length;
  const nC = grid.length;
  if (!nR || !nC) return;
  const colX = [0];
  for (const w of grid) colX.push(colX[colX.length - 1] + w);
  // Cells with their spans; the merged-away ones only reserve space.
  const cells: CellBox[] = [];
  rows.forEach((tr, r) => {
    // One cell per grid column: a cell spanning n columns is followed by n-1 hMerge cells
    // (a file that leaves those out just goes on after the span).
    let c = 0;
    let spanEnd = 0;
    for (const tc of kids(tr, "tc")) {
      const hMerge = attr(tc, "hMerge") === "1";
      if (hMerge && c < spanEnd) {
        c++;
        continue;
      }
      if (c < spanEnd) c = spanEnd;
      if (c >= nC) break;
      const cs = Math.max(1, num(attr(tc, "gridSpan"), 1));
      const rs = Math.max(1, num(attr(tc, "rowSpan"), 1));
      const merged = hMerge || attr(tc, "vMerge") === "1";
      if (!merged) cells.push({ tc, r, c, rs: Math.min(rs, nR - r), cs: Math.min(cs, nC - c), x: colX[c], y: 0, w: colX[Math.min(nC, c + cs)] - colX[c], h: 0, parts: [] });
      spanEnd = c + cs;
      c++;
    }
  });
  // Which style parts apply to each cell, weakest first.
  const firstRow = flag("firstRow");
  const lastRow = flag("lastRow");
  const firstCol = flag("firstCol");
  const lastCol = flag("lastCol");
  const bandRow = flag("bandRow");
  const bandCol = flag("bandCol");
  for (const cb of cells) {
    const p = ["wholeTbl"];
    const bodyR = cb.r - (firstRow ? 1 : 0);
    const bodyC = cb.c - (firstCol ? 1 : 0);
    if (bandRow && !(firstRow && cb.r === 0) && !(lastRow && cb.r === nR - 1)) p.push(bodyR % 2 === 0 ? "band1H" : "band2H");
    if (bandCol && !(firstCol && cb.c === 0) && !(lastCol && cb.c + cb.cs === nC)) p.push(bodyC % 2 === 0 ? "band1V" : "band2V");
    if (firstCol && cb.c === 0) p.push("firstCol");
    if (lastCol && cb.c + cb.cs === nC) p.push("lastCol");
    if (lastRow && cb.r + cb.rs === nR) p.push("lastRow");
    if (firstRow && cb.r === 0) p.push("firstRow");
    if (firstRow && firstCol && cb.r === 0 && cb.c === 0) p.push("nwCell");
    if (firstRow && lastCol && cb.r === 0 && cb.c + cb.cs === nC) p.push("neCell");
    if (lastRow && firstCol && cb.r + cb.rs === nR && cb.c === 0) p.push("swCell");
    if (lastRow && lastCol && cb.r + cb.rs === nR && cb.c + cb.cs === nC) p.push("seCell");
    cb.parts = p;
  }
  const partOf = (k: string) => style?.parts[k];
  // Text: a list style made from the table style's text settings.
  const text = e.text;
  const textChain = (cb: CellBox): ListSrc[] => {
    let color: RGBA | undefined;
    let font: string | undefined;
    for (const k of cb.parts) {
      const ps = partOf(k);
      if (ps?.color) color = ps.color;
      if (ps?.font) font = ps.font;
    }
    const chain: ListSrc[] = [{ el: kid(kid(cb.tc, "txBody"), "lstStyle") }];
    chain.push({ fontRef: { idx: font ?? "none", color } });
    chain.push({ el: e.pres.defaultTextStyle }, { el: e.txStyles.other });
    return chain;
  };
  const boldOf = (cb: CellBox) => {
    let b: boolean | undefined;
    let i: boolean | undefined;
    for (const k of cb.parts) {
      const ps = partOf(k);
      if (ps?.bold !== undefined) b = ps.bold;
      if (ps?.italic !== undefined) i = ps.italic;
    }
    return { b, i };
  };
  const margins = (tcPr: El | null) => ({
    l: num(attr(tcPr, "marL"), 91440) / 12700,
    r: num(attr(tcPr, "marR"), 91440) / 12700,
    t: num(attr(tcPr, "marT"), 45720) / 12700,
    b: num(attr(tcPr, "marB"), 45720) / 12700,
  });
  // Row heights: at least the stored height, grown to fit single-row cells' text.
  const rowH = rows.map((tr) => num(attr(tr, "h")) / 12700);
  const bodies = new Map<CellBox, El>();
  for (const cb of cells) {
    const body = kid(cb.tc, "txBody");
    if (!body) continue;
    const { b, i } = boldOf(cb);
    bodies.set(cb, b !== undefined || i !== undefined ? emphasise(body, b, i) : body);
  }
  const textH = new Map<CellBox, number>();
  for (const cb of cells) {
    const body = bodies.get(cb);
    if (!body) continue;
    const tcPr = kid(cb.tc, "tcPr");
    const mg = margins(tcPr);
    const vertCell = attr(tcPr, "vert");
    const vertical = !!vertCell && vertCell !== "horz";
    const bp = readBodyProps([]);
    const innerW = vertical ? 1e4 : Math.max(1, cb.w - mg.l - mg.r);
    const paras = await text.layout(body, textChain(cb), innerW, { ...bp, lIns: 0, rIns: 0, tIns: 0, bIns: 0 }, 1, 0);
    // Turned text runs down the cell: its longest line is the height it needs (its lines
    // stack across the cell's width).
    const h = (vertical ? Math.max(0, ...paras.flatMap((p) => p.lines.map((l) => l.w))) : SlideText.height(paras)) + mg.t + mg.b;
    textH.set(cb, h);
    if (cb.rs === 1) rowH[cb.r] = Math.max(rowH[cb.r], h);
  }
  // Spanning cells taller than their rows grow the last row they cover.
  for (const cb of cells) {
    if (cb.rs <= 1) continue;
    const h = textH.get(cb) ?? 0;
    const have = rowH.slice(cb.r, cb.r + cb.rs).reduce((a, b) => a + b, 0);
    if (h > have) rowH[cb.r + cb.rs - 1] += h - have;
  }
  const rowY = [0];
  for (const h of rowH) rowY.push(rowY[rowY.length - 1] + h);
  for (const cb of cells) {
    cb.y = rowY[cb.r];
    cb.h = rowY[cb.r + cb.rs] - rowY[cb.r];
  }
  const pen = e.pen;
  const tableW = colX[nC];
  const tableH = rowY[nR];
  const loader = async (f: Extract<Fill, { kind: "blip" }>, size?: { w: number; h: number }) => e.images.load((f.owner as Part | null) ?? part, f.blip, e.cc, size, f.phClr);
  // Background, then cell fills.
  const tblFill = readFill(pr, e.cc, undefined, part) ?? style?.bg;
  if (tblFill && tblFill.kind !== "none") await paintFill(pen, presetGeometry("rect", tableW, tableH)!.paths[0].segs, tblFill, { m, w: tableW, h: tableH }, "norm", loader);
  for (const cb of cells) {
    const tcPr = kid(cb.tc, "tcPr");
    let fill = readFill(tcPr, e.cc, undefined, part);
    if (!fill) for (const k of cb.parts) fill = partOf(k)?.fill ?? fill;
    if (!fill || fill.kind === "none") continue;
    const cm = then(translate(cb.x, cb.y), m);
    await paintFill(pen, presetGeometry("rect", cb.w, cb.h)!.paths[0].segs, fill, { m: cm, w: cb.w, h: cb.h }, "norm", loader);
  }
  // Borders: the cell's own, else the style's (outer edges or inside lines).
  const edge = (cb: CellBox, side: "left" | "right" | "top" | "bottom"): Line | undefined => {
    const tcPr = kid(cb.tc, "tcPr");
    const own = kid(tcPr, { left: "lnL", right: "lnR", top: "lnT", bottom: "lnB" }[side]);
    let st: Line | undefined;
    const outer = side === "left" ? cb.c === 0 : side === "right" ? cb.c + cb.cs === nC : side === "top" ? cb.r === 0 : cb.r + cb.rs === nR;
    for (const k of cb.parts) {
      const ps = partOf(k);
      if (!ps) continue;
      // A part's own outside edges, else its inside lines.
      const partOuter = (() => {
        if (k === "firstRow") return side === "top" ? true : side === "bottom" ? true : outer;
        if (k === "lastRow") return side === "bottom" ? true : side === "top" ? true : outer;
        if (k === "firstCol") return side === "left" ? true : side === "right" ? true : outer;
        if (k === "lastCol") return side === "right" ? true : side === "left" ? true : outer;
        if (/^band/.test(k)) return true;
        return outer;
      })();
      const b = partOuter ? ps.borders[side] : ps.borders[side === "left" || side === "right" ? "insideV" : "insideH"];
      if (b) st = b;
    }
    if (own) return mergeLine(st ?? {}, readLine(own, e.cc));
    return st;
  };
  type Seg = { x1: number; y1: number; x2: number; y2: number; line: Line };
  const segs: Seg[] = [];
  for (const cb of cells) {
    const L = edge(cb, "left");
    const R = edge(cb, "right");
    const T = edge(cb, "top");
    const B = edge(cb, "bottom");
    if (T) segs.push({ x1: cb.x, y1: cb.y, x2: cb.x + cb.w, y2: cb.y, line: T });
    if (B) segs.push({ x1: cb.x, y1: cb.y + cb.h, x2: cb.x + cb.w, y2: cb.y + cb.h, line: B });
    if (L) segs.push({ x1: cb.x, y1: cb.y, x2: cb.x, y2: cb.y + cb.h, line: L });
    if (R) segs.push({ x1: cb.x + cb.w, y1: cb.y, x2: cb.x + cb.w, y2: cb.y + cb.h, line: R });
    for (const [tag, x1, y1, x2, y2] of [["lnTlToBr", 0, 0, 1, 1], ["lnBlToTr", 0, 1, 1, 0]] as const) {
      const d = kid(kid(cb.tc, "tcPr"), tag);
      if (d) segs.push({ x1: cb.x + x1 * cb.w, y1: cb.y + y1 * cb.h, x2: cb.x + x2 * cb.w, y2: cb.y + y2 * cb.h, line: readLine(d, e.cc) });
    }
  }
  const frame: Frame = { m, w: tableW, h: tableH };
  for (const s of segs) {
    if (!s.line.fill || s.line.fill.kind === "none") continue;
    paintLine(pen, [{ t: "M", x: s.x1, y: s.y1 }, { t: "L", x: s.x2, y: s.y2 }], { ...s.line, width: s.line.width ?? 1 }, frame, false);
  }
  // Text.
  for (const cb of cells) {
    const body = bodies.get(cb);
    if (!body) continue;
    const tcPr = kid(cb.tc, "tcPr");
    const mg = margins(tcPr);
    const vertCell = attr(tcPr, "vert") ?? "horz";
    const anchor = attr(tcPr, "anchor") ?? "t";
    const bp = { ...readBodyProps([]), lIns: mg.l, rIns: mg.r, tIns: mg.t, bIns: mg.b, anchor, vert: vertCell, anchorCtr: attr(tcPr, "anchorCtr") === "1" };
    const cm = then(translate(cb.x, cb.y), m);
    await text.draw(pen, body, textChain(cb), bp, cm, cb.w, cb.h);
  }
  void painter;
}

/** A copy of a text body whose runs default to bold or italic (the table style's emphasis). */
function emphasise(body: El, b?: boolean, i?: boolean): El {
  const copy = body.cloneNode(true) as El;
  const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  for (const p of kids(copy, "p")) {
    for (const r of Array.from(p.children)) {
      if (r.localName !== "r" && r.localName !== "fld" && r.localName !== "endParaRPr") continue;
      let rPr = r.localName === "endParaRPr" ? r : kid(r, "rPr");
      if (!rPr) {
        rPr = copy.ownerDocument.createElementNS(A, "a:rPr");
        r.insertBefore(rPr, r.firstChild);
      }
      if (b !== undefined && !rPr.hasAttribute("b")) rPr.setAttribute("b", b ? "1" : "0");
      if (i !== undefined && !rPr.hasAttribute("i")) rPr.setAttribute("i", i ? "1" : "0");
    }
  }
  return copy;
}
