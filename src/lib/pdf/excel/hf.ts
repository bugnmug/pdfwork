/**
 * Excel page headers and footers: the &-codes (sections, page numbers, dates,
 * file and sheet names, fonts, sizes, styles and colours) parsed and drawn in
 * the margins.
 */
import type { PDFPage } from "@cantoo/pdf-lib";
import { rgb } from "../core";
import { applyTint } from "./read";
import type { Theme } from "../ooxml";
import type { XFont } from "./model";
import type { TextKit } from "../textkit";

type Field = "P" | "N" | "D" | "T" | "F" | "A" | "Z";
type HFRun = { text: string; field?: Field; delta?: number; font: XFont };
type Section = HFRun[][];
export type HFParts = { l: Section; c: Section; r: Section };

const THEME_ORDER = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];

export function parseHF(src: string, base: XFont, theme: Theme): HFParts {
  const parts: HFParts = { l: [[]], c: [[]], r: [[]] };
  let sec: Section = parts.c;
  const font: XFont = { ...base };
  let buf = "";
  const flush = () => {
    if (buf) sec[sec.length - 1].push({ text: buf, font: { ...font } });
    buf = "";
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      flush();
      sec.push([]);
      continue;
    }
    if (ch !== "&") {
      buf += ch;
      continue;
    }
    const code = src[i + 1] ?? "";
    i++;
    if (code === "&") {
      buf += "&";
      continue;
    }
    flush();
    switch (code.toUpperCase()) {
      case "L":
        sec = parts.l;
        break;
      case "C":
        sec = parts.c;
        break;
      case "R":
        sec = parts.r;
        break;
      case "P": {
        const m = /^([+-])(\d+)/.exec(src.slice(i + 1));
        sec[sec.length - 1].push({ text: "", field: "P", delta: m ? (m[1] === "-" ? -1 : 1) * Number(m[2]) : 0, font: { ...font } });
        if (m) i += m[0].length;
        break;
      }
      case "N":
      case "D":
      case "T":
      case "F":
      case "A":
      case "Z":
        sec[sec.length - 1].push({ text: "", field: code.toUpperCase() as Field, font: { ...font } });
        break;
      case "G":
        break; // a picture: not drawn
      case '"': {
        const end = src.indexOf('"', i + 1);
        const spec = src.slice(i + 1, end < 0 ? undefined : end);
        i = end < 0 ? src.length : end;
        const [name, style = ""] = spec.split(",");
        if (name && name !== "-") font.name = name.trim();
        if (style) {
          const st = style.toLowerCase();
          font.bold = /bold/.test(st);
          font.italic = /italic|oblique/.test(st);
        }
        break;
      }
      case "B":
        font.bold = !font.bold;
        break;
      case "I":
        font.italic = !font.italic;
        break;
      case "U":
        font.underline = font.underline ? undefined : "single";
        break;
      case "E":
        font.underline = font.underline ? undefined : "double";
        break;
      case "S":
        font.strike = !font.strike;
        break;
      case "X":
        font.vertAlign = font.vertAlign === "superscript" ? undefined : "superscript";
        break;
      case "Y":
        font.vertAlign = font.vertAlign === "subscript" ? undefined : "subscript";
        break;
      case "K": {
        const spec = src.slice(i + 1, i + 7);
        i += 6;
        if (/^[0-9a-f]{6}$/i.test(spec)) font.color = spec.toUpperCase();
        else {
          // Theme colour: two digits of theme index, a sign and three digits of tint percent.
          const m = /^(\d\d)([+-])(\d{3})$/.exec(spec);
          if (m) font.color = applyTint((theme.colors[THEME_ORDER[Number(m[1])] ?? "dk1"] ?? "000000").toUpperCase(), (m[2] === "-" ? -1 : 1) * (Number(m[3]) / 100));
        }
        break;
      }
      default:
        if (/\d/.test(code)) {
          let digits = code;
          while (/\d/.test(src[i + 1] ?? "") && digits.length < 3) digits += src[++i];
          font.size = Number(digits) || font.size;
        }
    }
  }
  flush();
  return parts;
}

export type HFContext = { page: number; pages: number; file: string; sheet: string; date: Date };

function resolve(run: HFRun, ctx: HFContext): string {
  switch (run.field) {
    case "P":
      return String(ctx.page + (run.delta ?? 0));
    case "N":
      return String(ctx.pages);
    case "D":
      return ctx.date.toLocaleDateString();
    case "T":
      return ctx.date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    case "F":
      return ctx.file;
    case "A":
      return ctx.sheet;
    case "Z":
      return "";
    default:
      return run.text;
  }
}

/** Draw one header or footer. `top`: distance of a header's top, or a footer's bottom, from that page edge. */
export async function drawHF(page: PDFPage, parts: HFParts, ctx: HFContext, kit: TextKit, area: { left: number; right: number; edge: number }, header: boolean, scale: number) {
  const W = page.getWidth();
  const H = page.getHeight();
  for (const [which, sec] of [["l", parts.l], ["c", parts.c], ["r", parts.r]] as const) {
    const lines = [];
    for (const line of sec) {
      const runs = line.map((r) => ({ text: resolve(r, ctx), font: { ...r.font, size: r.font.size * scale } })).filter((r) => r.text);
      let asc = 0;
      let desc = 0;
      let lh = 0;
      let w = 0;
      for (const r of runs) {
        const m = await kit.metrics(r.font);
        asc = Math.max(asc, m.ascent);
        desc = Math.max(desc, m.descent);
        lh = Math.max(lh, await kit.lineHeight(r.font));
        w += await kit.width(r.text, r.font);
      }
      if (!runs.length) {
        const m = await kit.metrics(line[0]?.font ?? { name: "Calibri", size: 11 * scale, bold: false, italic: false, strike: false });
        asc = m.ascent;
        desc = m.descent;
        lh = asc + desc;
      }
      lines.push({ runs, asc, desc, lh, w });
    }
    if (!lines.some((l) => l.runs.length)) continue;
    const total = lines.reduce((t, l) => t + l.lh, 0);
    // Headers grow down from the header margin; footers grow up from the footer margin.
    let top = header ? area.edge : H - area.edge - total;
    for (const l of lines) {
      const base = top + l.asc + (l.lh - l.asc - l.desc) / 2;
      let x = which === "l" ? area.left : which === "r" ? W - area.right - l.w : (area.left + (W - area.right)) / 2 - l.w / 2;
      for (const r of l.runs) {
        const color = r.font.color ?? "000000";
        const w = await kit.draw(page, r.text, x, H - base, r.font, r.font.size, color);
        if (r.font.underline) {
          const m = await kit.metrics(r.font);
          page.drawLine({ start: { x, y: H - base - m.underline }, end: { x: x + w, y: H - base - m.underline }, thickness: m.thickness, color: rgb(0, 0, 0) });
        }
        x += w;
      }
      top += l.lh;
    }
  }
}
