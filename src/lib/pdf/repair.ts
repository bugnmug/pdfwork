/**
 * Repair PDF: makes a damaged file open and print everywhere, keeps everything that survived, and
 * says plainly what was repaired and what was lost.
 *
 * The file is read without trusting its own index (see salvage), then each page is put right:
 * - its drawing is decoded as far as the data is good; a damaged end is cut off cleanly and the
 *   blocks it left open are closed, so viewers don't stop at the damage or draw garbage;
 * - text whose font object is lost is shown in a standard font when its codes are plain text, and
 *   taken out when they aren't (they would print as junk);
 * - a font whose program is damaged is replaced by one with the same letters and widths (see
 *   fontsub), and a picture whose data is cut off keeps what is left;
 * - a lost picture or setting is replaced by an empty one, so viewers don't stop at it.
 * The result is then read back with the other engine (PDF.js): a page it can't open, or a page
 * where it finds clearly more text in the original than in the repair, is redrawn from the
 * original as PDF.js shows it, with its words kept as searchable text.
 */
import { PDFArray, PDFDict, PDFInvalidObject, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFObject } from "@cantoo/pdf-lib";
import { zlibSync } from "fflate";
import { PasswordError, canvasToBytes, dropUnreferenced, newDoc, pdfOut, saveDoc, stem, tick, type OutFile, type PDFDocument, type ProgressFn } from "./core";
import { tokenize, type Tok } from "./contentstream";
import { FontSet } from "./fonts";
import { mendToUnicode, programState, replaceProgram, type Split } from "./fontsub";
import { place, pageFrame } from "./geometry";
import { PdfjsPasswordError, pageText, renderPage, withPdfjs } from "./pdfjs";
import { redrawPage } from "./raster";
import { Damage, decodeStream, dropDangling, filtersOf, readDamaged, type Kit, type Trouble } from "./salvage";
import type { Src } from "./pages";

const N = (s: string) => PDFName.of(s);
const nameOf = (o: unknown) => (o instanceof PDFName ? o.decodeText() : undefined);
const numOf = (o: unknown, d = 0) => (o instanceof PDFNumber ? o.asNumber() : d);
const isStream = (o: unknown): o is PDFRawStream | PDFStream => o instanceof PDFRawStream || o instanceof PDFStream;

/* ------------------------------------------------------------------- reading content streams */

const OPS = new Set(
  "b B b* B* BDC BI BMC BT BX c cm CS cs d d0 d1 Do DP EI EMC ET EX f F f* G g gs h i ID j J K k l m M MP n q Q re RG rg ri s S SC sc SCN scn sh T* Tc Td TD Tf Tj TJ TL Tm Tr Ts Tw Tz v w W W* y ' \"".split(" "),
);
const PAINT = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const PATH = new Set(["m", "l", "c", "v", "y", "re", "h"]);
const DEVICE = new Set(["DeviceGray", "DeviceRGB", "DeviceCMYK", "Pattern", "G", "RGB", "CMYK"]);

/**
 * Operand shapes of operators (n number, N name, s string, a array; * any numbers, then
 * optionally a name), for telling a damaged stream's garbage from drawing.
 */
const SHAPES: Record<string, string> = {
  cm: "nnnnnn", Tm: "nnnnnn", Td: "nn", TD: "nn", Tf: "Nn", m: "nn", l: "nn", c: "nnnnnn", v: "nnnn", y: "nnnn", re: "nnnn",
  w: "n", J: "n", j: "n", M: "n", Tc: "n", Tw: "n", Tz: "n", TL: "n", Ts: "n", Tr: "n", g: "n", G: "n", i: "n",
  rg: "nnn", RG: "nnn", k: "nnnn", K: "nnnn", d0: "nn", d1: "nnnnnn", d: "an",
  gs: "N", Do: "N", sh: "N", cs: "N", CS: "N", ri: "N", BMC: "N", MP: "N", Tj: "s", "'": "s", TJ: "a", '"': "nns",
  q: "", Q: "", BT: "", ET: "", n: "", f: "", F: "", "f*": "", S: "", s: "", B: "", "B*": "", b: "", "b*": "", h: "", W: "", "W*": "", EMC: "", BX: "", EX: "", "T*": "",
  sc: "*", SC: "*", scn: "*", SCN: "*",
};

function shapeOf(args: Tok[]): string {
  let out = "";
  let depth = 0;
  for (const a of args) {
    if (a.t === "arrS" || a.t === "dictS") {
      if (!depth) out += a.t === "arrS" ? "a" : "d";
      depth++;
    } else if (a.t === "arrE" || a.t === "dictE") depth = Math.max(0, depth - 1);
    else if (!depth) out += a.t === "num" ? "n" : a.t === "name" ? "N" : a.t === "str" || a.t === "hex" ? "s" : "?";
  }
  return out;
}

/** Whether an operator reads as drawing: the right operands, a path that has a start, text inside a text block. */
function fits(op: string, args: Tok[], st: { bt: boolean; point: boolean }): boolean {
  const want = SHAPES[op];
  const got = shapeOf(args);
  if (want === "*") {
    if (!/^n*N?$/.test(got)) return false;
  } else if (want !== undefined && got !== want) return false;
  if ((op === "l" || op === "c" || op === "v" || op === "y" || op === "h") && !st.point) return false;
  if ((op === "Tj" || op === "TJ" || op === "'" || op === '"' || op === "Td" || op === "TD" || op === "Tm" || op === "T*") && !st.bt) return false;
  return true;
}

/** The bytes of a string token, literal "(...)" or hex "<...>". */
function stringBytes(b: Uint8Array, t: Tok): number[] {
  const out: number[] = [];
  if (t.t === "hex") {
    let h = "";
    for (let i = t.s + 1; i < t.e - 1; i++) if (/[0-9a-fA-F]/.test(String.fromCharCode(b[i]))) h += String.fromCharCode(b[i]);
    if (h.length % 2) h += "0";
    for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
    return out;
  }
  for (let i = t.s + 1; i < t.e - 1; i++) {
    if (b[i] !== 92) {
      out.push(b[i]);
      continue;
    }
    const d = b[++i];
    if (d >= 48 && d <= 55) {
      let v = d - 48;
      for (let k = 0; k < 2 && b[i + 1] >= 48 && b[i + 1] <= 55; k++) v = v * 8 + (b[++i] - 48);
      out.push(v & 255);
    } else if (d !== 10 && d !== 13) out.push({ 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[d] ?? d);
  }
  return out;
}

/** Text shown with one font, and where each showing operator (with its operands) sits. */
type Shown = { bytes: number[]; ops: { s: number; e: number; op: string; args: Tok[] }[] };

type Read = {
  /** Where the good part of the stream ends (all of it, when nothing is wrong). */
  end: number;
  /** What is still open at that point: a text block, saved states, marked content, a path. */
  open: { bt: boolean; q: number; mc: number; path: boolean };
  fonts: Map<string, Shown>;
  xobjects: Set<string>;
  gstates: Set<string>;
  spaces: Map<string, number>;
  patterns: Map<string, { s: number; e: number; op: string }[]>;
  shadings: Map<string, { s: number; e: number }[]>;
  props: Set<string>;
  /** Where each font is chosen (its Tf operators). */
  picks: Map<string, { s: number; e: number }[]>;
  /** Runs of zero bytes: data wiped out in a stream stored uncompressed. */
  holes: number;
  /** Text whose string was wiped (it would show as junk). */
  wiped: { s: number; e: number; op: string; args: Tok[] }[];
  /** Things no undamaged stream has (see readContent's modes). */
  odd: number;
};

/**
 * Walks a content stream, noting what it draws with. A damaged one ("damaged") is read only up
 * to the first thing no undamaged stream contains: an unknown operator, binary junk, an
 * unfinished string or picture, an operator with the wrong operands, or `stop` (where the damage
 * is known to start). "count" reads it all and counts those things (in `odd`).
 */
function readContent(b: Uint8Array, mode: "healthy" | "damaged" | "count", stop?: number): Read {
  const damaged = mode === "damaged";
  const strict = mode !== "healthy";
  const toks = tokenize(b);
  const r: Read = { end: damaged ? 0 : b.length, open: { bt: false, q: 0, mc: 0, path: false }, fonts: new Map(), xobjects: new Set(), gstates: new Set(), spaces: new Map(), patterns: new Map(), shadings: new Map(), props: new Set(), picks: new Map(), holes: 0, wiped: [], odd: 0 };
  /** Something no undamaged stream has: counted, and whether the walk stops there. */
  const odd = () => {
    r.odd++;
    return damaged;
  };
  const st = { bt: false, q: 0, mc: 0, path: false, point: false };
  const fontStack: string[] = [];
  let font = "";
  let args: Tok[] = [];
  let depth = 0;
  let compat = 0;
  let space = "";
  const add = <T>(m: Map<string, T[]>, k: string, v: T) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  let gap = 0;
  let hole = false;
  for (const t of toks) {
    if (stop !== undefined && t.e > stop) break;
    // Zeros wiped over the text (not a picture's data, where they belong).
    let zeros = 0;
    for (let i = gap, end = t.t === "inline" ? t.s : t.e; i < end && zeros < 16; i++) zeros = b[i] === 0 ? zeros + 1 : 0;
    if (zeros >= 16) {
      r.holes++;
      hole = true;
    }
    gap = t.e;
    if (t.t === "arrS" || t.t === "dictS") {
      depth++;
      args.push(t);
      continue;
    }
    if (t.t === "arrE" || t.t === "dictE") {
      depth = Math.max(0, depth - 1);
      args.push(t);
      continue;
    }
    if (t.t === "inline") {
      if (strict && !/\sEI$/.test(new TextDecoder("latin1").decode(b.subarray(Math.max(t.s, t.e - 3), t.e))) && odd()) break;
      args = [];
      if (damaged) r.end = t.e;
      continue;
    }
    if (t.t !== "op") {
      if (strict && ((t.t === "str" && b[t.e - 1] !== 41) || (t.t === "hex" && b[t.e - 1] !== 62) || (t.t === "name" && /[^\x21-\x7e]/.test(t.v))) && odd()) break;
      args.push(t);
      if (strict && depth === 0 && args.length === 65 && odd()) break;
      continue;
    }
    const op = t.v;
    if ((!OPS.has(op) && !compat) || depth > 0) {
      if (strict && odd()) break;
      args = [];
      depth = 0;
      continue;
    }
    // In a damaged stream, garbage can still spell known operators: their operands, a path
    // without a start or text outside a text block give it away.
    if (strict && !fits(op, args, st)) {
      if (odd()) break;
      args = [];
      continue;
    }
    const name = (k: number) => (args[k]?.t === "name" ? args[k].v : "");
    const lastName = () => (args.length && args[args.length - 1].t === "name" ? args[args.length - 1].v : "");
    const from = args.length ? args[0].s : t.s;
    switch (op) {
      case "Tf":
        font = name(0);
        if (!r.fonts.has(font)) r.fonts.set(font, { bytes: [], ops: [] });
        add(r.picks, font, { s: from, e: t.e });
        break;
      case "Tj":
      case "'":
      case '"':
      case "TJ": {
        const sh = r.fonts.get(font) ?? r.fonts.set(font, { bytes: [], ops: [] }).get(font)!;
        for (const a of args) if (a.t === "str" || a.t === "hex") sh.bytes.push(...stringBytes(b, a));
        sh.ops.push({ s: from, e: t.e, op, args });
        if (hole) r.wiped.push({ s: from, e: t.e, op, args });
        break;
      }
      case "Do":
        r.xobjects.add(lastName());
        break;
      case "gs":
        r.gstates.add(lastName());
        break;
      case "sh":
        add(r.shadings, lastName(), { s: from, e: t.e });
        break;
      case "cs":
      case "CS":
        space = lastName();
        if (space && !DEVICE.has(space) && !r.spaces.has(space)) r.spaces.set(space, 0);
        break;
      case "sc":
      case "SC":
      case "scn":
      case "SCN": {
        const p = lastName();
        if (p && (op === "scn" || op === "SCN")) add(r.patterns, p, { s: from, e: t.e, op });
        else if (space && r.spaces.has(space)) r.spaces.set(space, Math.max(r.spaces.get(space)!, args.filter((a) => a.t === "num").length));
        break;
      }
      case "BDC":
      case "DP":
        if (args[1]?.t === "name") r.props.add(args[1].v);
        if (op === "BDC") st.mc++;
        break;
      case "BMC":
        st.mc++;
        break;
      case "EMC":
        st.mc = Math.max(0, st.mc - 1);
        break;
      case "BT":
        st.bt = true;
        break;
      case "ET":
        st.bt = false;
        break;
      case "q":
        st.q++;
        fontStack.push(font);
        break;
      case "Q":
        st.q = Math.max(0, st.q - 1);
        font = fontStack.pop() ?? font;
        break;
      case "BX":
        compat++;
        break;
      case "EX":
        compat = Math.max(0, compat - 1);
        break;
      default:
        if (PATH.has(op)) st.path = true;
        else if (PAINT.has(op)) st.path = false;
        if (op === "m" || op === "re") st.point = true;
        else if (PAINT.has(op)) st.point = false;
    }
    args = [];
    hole = false;
    if (damaged) {
      r.end = t.e;
      r.open = { ...st };
    }
  }
  return r;
}

/* --------------------------------------------------------------------------- putting it right */

type Fixer = {
  doc: PDFDocument;
  ctx: PDFContext;
  damage: Damage;
  page: number;
  /** Objects already looked at (forms, fonts, pictures shared by pages) and what was wrong with each. */
  seen: Map<unknown, Trouble[]>;
  /** The standard fonts put in for lost ones, by name. */
  standard: Map<string, PDFRef>;
  emptyForm?: PDFRef;
  /** Per resource dictionary, what was decided for each of its lost fonts. */
  lost: Map<unknown, Map<string, "standard" | "drop">>;
  /** Lost fonts that can be put back together from their surviving parts (see salvage), and how many were. */
  kits: Map<PDFRef, Kit>;
  rebuilt: number;
  /** Fonts whose program is gone for good, with nothing saying what their codes mean. */
  gone: Set<PDFDict>;
  /** Fonts given a new program that show some ligatures as their letters (see fontsub). */
  splits: Map<PDFDict, { splits: Map<number, Split>; wide: boolean }>;
};

/** A resource category of a resource dictionary, made when `make` and it is missing. */
function category(ctx: PDFContext, res: PDFDict, cat: string, make = false): PDFDict | undefined {
  const raw = res.get(N(cat));
  const d = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
  if (d instanceof PDFDict) return d;
  if (!make) return undefined;
  const fresh = ctx.obj({});
  res.set(N(cat), fresh);
  return fresh;
}

/** A named resource, or undefined when it is missing (gone, or never readable). */
function resource(ctx: PDFContext, res: PDFDict | undefined, cat: string, name: string): PDFObject | undefined {
  const d = res ? category(ctx, res, cat) : undefined;
  const raw = d?.get(N(name));
  const o = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
  return o === undefined || o instanceof PDFInvalidObject ? undefined : o;
}

function rewrite(s: PDFRawStream | PDFStream, bytes: Uint8Array) {
  if (!(s instanceof PDFRawStream)) return;
  s.contents = zlibSync(bytes);
  s.dict.set(N("Filter"), N("FlateDecode"));
  s.dict.delete(N("DecodeParms"));
  s.dict.delete(N("DL"));
}

/** The standard font a resource name stands for, by the abbreviations forms and some writers use (Helv, HeBo, TiRo, Cour…). */
const STANDARD_NAMES: Record<string, string> = {
  helv: "Helvetica", hebo: "Helvetica-Bold", heit: "Helvetica-Oblique", heob: "Helvetica-Oblique", hebi: "Helvetica-BoldOblique", hebl: "Helvetica-BoldOblique",
  tiro: "Times-Roman", tibo: "Times-Bold", tiit: "Times-Italic", tibi: "Times-BoldItalic",
  cour: "Courier", cobo: "Courier-Bold", coit: "Courier-Oblique", cobi: "Courier-BoldOblique", coob: "Courier-Oblique",
  symb: "Symbol", zadb: "ZapfDingbats",
};

/** Whether text drawn with a lost font fits the font rebuilt for it: one-byte codes it maps, for a simple font. */
function kitFits(kit: Kit, bytes: number[]): boolean {
  if (!kit.simple) return bytes.length % 2 === 0;
  if (bytes.filter((c) => c === 0).length > bytes.length * 0.1) return false;
  return !kit.codes || bytes.filter((c) => kit.codes!.has(c)).length >= bytes.length * 0.9;
}

/** Codes that read as plain text in a standard font (not two-byte codes or a subset's private numbering). */
const plainText = (b: number[]) =>
  b.length >= 2 &&
  b.filter((c) => (c >= 0x20 && c <= 0x7e) || c >= 0xa0 || c === 9).length >= b.length * 0.95 &&
  b.filter((c) => c === 0x20 || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c >= 0xc0).length >= b.length * 0.5;

type Outcome = { troubles: Trouble[]; kept: number; damaged: boolean };

/**
 * A text-showing operator with ligature codes replaced by their letters' codes, as a TJ array
 * that moves back after each so the rest of the line keeps its place; null when it has none.
 */
function splitShow(b: Uint8Array, o: { op: string; args: Tok[] }, sp: { splits: Map<number, Split>; wide: boolean }): string | null {
  const items: (number[] | number)[] = [];
  let changed = false;
  const strings = o.op === "TJ" ? o.args : o.args.filter((a) => a.t === "str" || a.t === "hex").slice(-1);
  for (const a of strings) {
    if (a.t === "num") {
      items.push(Number(a.v));
      continue;
    }
    if (a.t !== "str" && a.t !== "hex") continue;
    const bytes = stringBytes(b, a);
    const codes: number[] = [];
    for (let i = 0; i < bytes.length; i += sp.wide ? 2 : 1) codes.push(sp.wide ? (bytes[i] << 8) | (bytes[i + 1] ?? 0) : bytes[i]);
    let run: number[] = [];
    for (const c of codes) {
      const s = sp.splits.get(c);
      if (!s) {
        run.push(c);
        continue;
      }
      changed = true;
      run.push(...s.codes);
      if (Math.abs(s.back) > 0.5) {
        items.push(run, s.back);
        run = [];
      }
    }
    if (run.length) items.push(run);
  }
  if (!changed) return null;
  const hex = (c: number) => c.toString(16).toUpperCase().padStart(sp.wide ? 4 : 2, "0");
  const tj = `[${items.map((it) => (typeof it === "number" ? String(Math.round(it * 100) / 100) : `<${it.map(hex).join("")}>`)).join(" ")}] TJ`;
  const nums = o.args.filter((a) => a.t === "num").map((a) => a.v);
  return o.op === "'" ? `T* ${tj}` : o.op === '"' ? `${nums[0] ?? 0} Tw ${nums[1] ?? 0} Tc T* ${tj}` : tj;
}

/** The edit taking a text-showing operator out, keeping the line moves and spacing it also makes. */
function dropShow(o: { s: number; e: number; op: string; args: Tok[] }) {
  const nums = o.args.filter((a) => a.t === "num").map((a) => a.v);
  return { s: o.s, e: o.e, text: o.op === "'" ? "T*" : o.op === '"' ? `${nums[0] ?? 0} Tw ${nums[1] ?? 0} Tc T*` : "" };
}

/**
 * Puts one content stream right (a page's, a form's, a Type 3 glyph's, an appearance's) and
 * then what it draws with. `res`: its resources.
 */
async function fixStream(x: Fixer, s: PDFRawStream | PDFStream, res: PDFDict | undefined, depth: number): Promise<Outcome> {
  const known = x.seen.get(s);
  if (known) return { troubles: known, kept: 1, damaged: false };
  x.seen.set(s, []);
  const ctx = x.ctx;
  const troubles: Trouble[] = [];
  const d = decodeStream(s);
  // Damaged: the data stops decoding, or zeros were wiped over it. Data that decodes to the end
  // but fails its checksum is damaged only when its content reads oddly too (some writers get
  // the checksum wrong, and every viewer shows such a stream as it decodes).
  const damaged = !d.intact && (!d.whole || d.damageAt !== undefined || readContent(d.bytes, "count").odd >= 3);
  const r = readContent(d.bytes, damaged ? "damaged" : "healthy", d.damageAt);
  const edits: { s: number; e: number; text: string }[] = [];
  const cut = damaged && (r.end < d.bytes.length || !d.whole);
  if (cut) troubles.push("contentCut");
  if (r.holes) troubles.push("contentHole");
  for (const o of r.wiped) edits.push(dropShow(o));

  // Fonts used.
  const decided = x.lost.get(res ?? x) ?? x.lost.set(res ?? x, new Map()).get(res ?? x)!;
  for (const [name, shown] of r.fonts) {
    if (!name) continue;
    let f = resource(ctx, res, "Font", name);
    // A lost font whose parts survive is put back together, when the codes drawn with it fit.
    const ref = res ? category(ctx, res, "Font")?.get(N(name)) : undefined;
    const kit = !(f instanceof PDFDict) && ref instanceof PDFRef ? x.kits.get(ref) : undefined;
    if (kit && ref instanceof PDFRef && shown.bytes.length) {
      x.kits.delete(ref);
      if (kitFits(kit, shown.bytes)) {
        ctx.assign(ref, kit.font);
        x.rebuilt++;
        f = kit.font;
      }
    }
    if (f instanceof PDFDict) {
      troubles.push(...(await fixFont(x, f, res, depth)));
      if (x.gone.has(f)) {
        // Its program is gone and nothing says what its codes mean: they would print as junk.
        for (const o of shown.ops) edits.push(dropShow(o));
        for (const p of r.picks.get(name) ?? []) edits.push({ ...p, text: "" });
        if (shown.ops.length) troubles.push("textLost");
      }
      // Ligatures its new program draws as their separate letters.
      const sp = x.splits.get(f);
      if (sp)
        for (const o of shown.ops) {
          const text = splitShow(d.bytes, o, sp);
          if (text !== null) edits.push({ s: o.s, e: o.e, text });
        }
      continue;
    }
    // Otherwise its text is shown in a standard font when its codes are plain text; when they
    // are codes only the lost font could read, they would print as junk, so they go.
    let choice = decided.get(name);
    if (!choice && shown.ops.length) decided.set(name, (choice = plainText(shown.bytes) ? "standard" : "drop"));
    if (choice === "standard") {
      if (res) {
        const base = STANDARD_NAMES[name.toLowerCase()] ?? "Helvetica";
        const std = x.standard.get(base) ?? ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: base, ...(/Symbol|Dingbats/.test(base) ? {} : { Encoding: "WinAnsiEncoding" }) }));
        x.standard.set(base, std);
        category(ctx, res, "Font", true)!.set(N(name), std);
      }
      if (shown.ops.length) troubles.push("fontStandard");
      continue;
    }
    for (const o of shown.ops) edits.push(dropShow(o));
    for (const p of r.picks.get(name) ?? []) edits.push({ ...p, text: "" });
    if (shown.ops.length) troubles.push("textLost");
  }
  // Pictures and forms.
  for (const name of r.xobjects) {
    if (!name) continue;
    const o = resource(ctx, res, "XObject", name);
    if (!isStream(o)) {
      if (res) {
        x.emptyForm ??= ctx.register(ctx.stream(new Uint8Array(), { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] }));
        category(ctx, res, "XObject", true)!.set(N(name), x.emptyForm);
      }
      troubles.push("pictureLost");
      continue;
    }
    const sub = nameOf(o.dict.get(N("Subtype")) instanceof PDFRef ? ctx.lookup(o.dict.get(N("Subtype"))) : o.dict.get(N("Subtype")));
    if (sub === "Image") troubles.push(...fixImage(x, o));
    else if (sub === "Form" && depth < 12) {
      const out = await fixStream(x, o, formResources(ctx, o.dict) ?? res, depth + 1);
      troubles.push(...out.troubles.map((t) => (t === "contentLost" ? "contentCut" : t)));
    }
  }
  // Settings that are gone get neutral ones.
  for (const name of r.gstates) if (name && res && resource(ctx, res, "ExtGState", name) === undefined) category(ctx, res, "ExtGState", true)!.set(N(name), ctx.obj({}));
  for (const name of r.props) if (name && res && resource(ctx, res, "Properties", name) === undefined) category(ctx, res, "Properties", true)!.set(N(name), ctx.obj({}));
  for (const [name, n] of r.spaces) {
    const cs = res ? resource(ctx, res, "ColorSpace", name) : undefined;
    if (res && cs === undefined) category(ctx, res, "ColorSpace", true)!.set(N(name), N(n === 1 ? "DeviceGray" : n === 4 ? "DeviceCMYK" : "DeviceRGB"));
    const plain = cs !== undefined ? plainSpace(ctx, cs) : undefined;
    if (res && plain) category(ctx, res, "ColorSpace")!.set(N(name), plain);
  }
  for (const [name, uses] of r.shadings) if (resource(ctx, res, "Shading", name) === undefined) for (const u of uses) edits.push({ ...u, text: "" });
  for (const [name, uses] of r.patterns) {
    const p = resource(ctx, res, "Pattern", name);
    if (p === undefined) for (const u of uses) edits.push({ s: u.s, e: u.e, text: u.op === "scn" ? "0.75 g" : "0.75 G" });
    else if (isStream(p) && depth < 12) troubles.push(...(await fixStream(x, p, formResources(ctx, p.dict) ?? res, depth + 1)).troubles);
  }

  // The stream itself: its good part, with the lost text taken out and what was left open closed
  // (and stored again when its checksum was wrong, so strict readers don't stop at it).
  let kept = d.bytes.length;
  if (cut || edits.length || !d.intact) {
    const head = d.bytes.subarray(0, cut ? r.end : d.bytes.length);
    kept = head.length;
    const closing = cut ? (r.open.path ? "\nn" : "") + (r.open.bt ? "\nET" : "") + "\nEMC".repeat(r.open.mc) + "\nQ".repeat(r.open.q) : "";
    const parts: Uint8Array[] = [];
    let at = 0;
    const enc = new TextEncoder();
    for (const e of edits.filter((e) => e.e <= head.length).sort((a, b) => a.s - b.s)) {
      if (e.s < at) continue;
      parts.push(head.subarray(at, e.s), enc.encode(e.text));
      at = e.e;
    }
    parts.push(head.subarray(at), enc.encode(closing + "\n"));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    rewrite(s, out);
  }
  const unique = [...new Set(troubles)];
  x.seen.set(s, unique);
  return { troubles: unique, kept, damaged };
}

function formResources(ctx: PDFContext, dict: PDFDict): PDFDict | undefined {
  const r = dict.get(N("Resources"));
  const d = r instanceof PDFRef ? ctx.lookup(r) : r;
  return d instanceof PDFDict ? d : undefined;
}

/** A font: its program checked (and replaced when damaged); a Type 3 font's glyph drawings put right. */
async function fixFont(x: Fixer, f: PDFDict, res: PDFDict | undefined, depth: number): Promise<Trouble[]> {
  const known = x.seen.get(f);
  if (known) return known;
  x.seen.set(f, []);
  const ctx = x.ctx;
  const out: Trouble[] = [];
  mendToUnicode(ctx, f);
  if (nameOf(ctx.lookup(f.get(N("Subtype")))) === "Type3") {
    const procs = ctx.lookup(f.get(N("CharProcs")));
    if (procs instanceof PDFDict && depth < 12)
      for (const [, p] of procs.entries()) {
        const s = ctx.lookup(p);
        if (isStream(s)) out.push(...(await fixStream(x, s, formResources(ctx, f) ?? res, depth + 1)).troubles.map((t): Trouble => (t === "contentCut" || t === "contentLost" ? "fontUnreadable" : t)));
      }
  } else {
    const state = programState(ctx, f);
    if (state === "ok") restoreProgram(ctx, f);
    if (state === "damaged" || state === "lost") {
      const done = await replaceProgram(x.doc, f).catch(() => null);
      if (!done) {
        x.gone.add(f);
        dropProgram(ctx, f);
      } else {
        out.push("fontReplaced");
        if (done.splits.size) x.splits.set(f, done);
      }
    }
  }
  const unique = [...new Set(out)];
  x.seen.set(f, unique);
  return unique;
}

/** A font program that reads whole but fails its checksum is stored again, so strict readers don't stop at it. */
function restoreProgram(ctx: PDFContext, f: PDFDict) {
  const look = (o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  let holder: unknown = f;
  if (nameOf(look(f.get(N("Subtype")))) === "Type0") {
    const kids = look(f.get(N("DescendantFonts")));
    holder = kids instanceof PDFArray ? look(kids.get(0)) : undefined;
  }
  const desc = holder instanceof PDFDict ? look(holder.get(N("FontDescriptor"))) : undefined;
  if (!(desc instanceof PDFDict)) return;
  for (const k of ["FontFile", "FontFile2", "FontFile3"]) {
    const st = look(desc.get(N(k)));
    if (!(st instanceof PDFRawStream)) continue;
    const d = decodeStream(st);
    if (d.whole && !d.intact && d.bytes.length) {
      st.contents = zlibSync(d.bytes);
      st.dict.set(N("Filter"), N("FlateDecode"));
      st.dict.delete(N("DecodeParms"));
    }
  }
}

/** Takes a broken font program out (its text is gone), so viewers don't stop at it. */
function dropProgram(ctx: PDFContext, f: PDFDict) {
  const look = (o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  let holder: unknown = f;
  if (nameOf(look(f.get(N("Subtype")))) === "Type0") {
    const kids = look(f.get(N("DescendantFonts")));
    holder = kids instanceof PDFArray ? look(kids.get(0)) : undefined;
  }
  const desc = holder instanceof PDFDict ? look(holder.get(N("FontDescriptor"))) : undefined;
  if (desc instanceof PDFDict) for (const k of ["FontFile", "FontFile2", "FontFile3"]) desc.delete(N(k));
}

/**
 * A colour space with a damaged colour profile becomes the plain device space the profile stands
 * in for (its alternate), so viewers don't stop at it. Returns the replacement, if any.
 */
function plainSpace(ctx: PDFContext, cs: unknown): PDFObject | undefined {
  const c = cs instanceof PDFRef ? ctx.lookup(cs) : cs;
  if (!(c instanceof PDFArray) || nameOf(ctx.lookup(c.get(0))) !== "ICCBased") return undefined;
  const st = ctx.lookup(c.get(1));
  if (!isStream(st)) return N("DeviceRGB");
  // A profile reads whole and carries its signature ("acsp") at byte 36.
  const d = decodeStream(st);
  if (d.intact && d.bytes.length > 40 && String.fromCharCode(...d.bytes.subarray(36, 40)) === "acsp") return undefined;
  const alt = ctx.lookup(st.dict.get(N("Alternate")));
  if (alt instanceof PDFName) return alt;
  const n = numOf(ctx.lookup(st.dict.get(N("N"))), 3);
  return N(n === 1 ? "DeviceGray" : n === 4 ? "DeviceCMYK" : "DeviceRGB");
}

/** Components, bits and the paper (no ink) value of a picture's samples. */
function paperOf(ctx: PDFContext, s: PDFRawStream): { comps: number; bpc: number; paper: number[] } {
  const d = s.dict;
  const look = (o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  const decode = look(d.get(N("Decode")));
  const flipped = decode instanceof PDFArray && numOf(look(decode.get(0))) > numOf(look(decode.get(1)));
  if (look(d.get(N("ImageMask")))?.toString() === "true") return { comps: 1, bpc: 1, paper: [flipped ? 0 : 1] };
  const bpc = numOf(look(d.get(N("BitsPerComponent"))), 8);
  const max = bpc === 16 ? 65535 : (1 << bpc) - 1;
  const space = (cs: unknown): { comps: number; paper: number[] } => {
    const c = look(cs);
    const n = nameOf(c);
    if (n === "DeviceGray" || n === "CalGray" || n === "G") return { comps: 1, paper: [max] };
    if (n === "DeviceCMYK" || n === "CMYK") return { comps: 4, paper: [0, 0, 0, 0] };
    if (n) return { comps: 3, paper: [max, max, max] };
    if (c instanceof PDFArray) {
      const kind = nameOf(look(c.get(0)));
      if (kind === "ICCBased") {
        const st = look(c.get(1));
        const k = isStream(st) ? numOf(look(st.dict.get(N("N"))), 3) : 3;
        return { comps: k, paper: Array(k).fill(k === 4 ? 0 : max) };
      }
      if (kind === "CalRGB" || kind === "Lab") return { comps: 3, paper: kind === "Lab" ? [max, max >> 1, max >> 1] : [max, max, max] };
      if (kind === "CalGray") return { comps: 1, paper: [max] };
      if (kind === "Separation") return { comps: 1, paper: [0] };
      if (kind === "DeviceN") {
        const names = look(c.get(1));
        const k = names instanceof PDFArray ? names.size() : 1;
        return { comps: k, paper: Array(k).fill(0) };
      }
      if (kind === "Indexed") {
        // The lightest colour of the palette.
        const base = space(c.get(1));
        const hival = numOf(look(c.get(2)));
        const lut = look(c.get(3));
        let table: Uint8Array | undefined;
        if (isStream(lut)) table = decodeStream(lut).bytes;
        else if (lut && "asBytes" in (lut as object)) table = (lut as unknown as { asBytes(): Uint8Array }).asBytes();
        let best = 0;
        let bestL = -1;
        for (let i = 0; table && i <= hival; i++) {
          const v = Array.from(table.subarray(i * base.comps, (i + 1) * base.comps));
          const l = base.comps === 4 ? 255 * 4 - v.reduce((a, b) => a + b, 0) : v.reduce((a, b) => a + b, 0) / base.comps;
          if (l > bestL) {
            bestL = l;
            best = i;
          }
        }
        return { comps: 1, paper: [best] };
      }
    }
    return { comps: 3, paper: [max, max, max] };
  };
  const sp = space(d.get(N("ColorSpace")));
  if (flipped && sp.comps === 1) sp.paper = [max - sp.paper[0]];
  return { comps: sp.comps, bpc, paper: sp.paper };
}

/** A picture: data cut off part way is kept, with the rest as blank paper (viewers otherwise fail on it). */
function fixImage(x: Fixer, s: PDFRawStream | PDFStream): Trouble[] {
  const cached = x.seen.get(s);
  if (cached) return cached;
  const out: Trouble[] = [];
  x.seen.set(s, out);
  if (!(s instanceof PDFRawStream)) return out;
  const ctx = x.ctx;
  const mask = ctx.lookup(s.dict.get(N("SMask")));
  if (isStream(mask)) out.push(...fixImage(x, mask));
  const plain = plainSpace(ctx, s.dict.get(N("ColorSpace")));
  if (plain) s.dict.set(N("ColorSpace"), plain);
  const filters = filtersOf(s.dict).map((f) => f.name);
  const codec = filters.find((f) => ["DCTDecode", "JPXDecode", "CCITTFaxDecode", "JBIG2Decode"].includes(f));
  if (codec === "DCTDecode") {
    // A JPEG ends with its end marker; one cut short shows only its top. (Damage inside one can't
    // be told from picture data: long runs of zeros, say, are what flat colour looks like.)
    const d = filters.length > 1 ? decodeStream(s).bytes : s.contents;
    let end = false;
    for (let i = d.length - 2; i >= Math.max(0, d.length - 64); i--) if (d[i] === 0xff && d[i + 1] === 0xd9) end = true;
    if (!end && d.length) out.push("pictureCut");
    return [...new Set(out)];
  }
  if (codec) return [...new Set(out)];
  const d = decodeStream(s);
  if (d.intact) return [...new Set(out)];
  const w = numOf(ctx.lookup(s.dict.get(N("Width"))));
  const h = numOf(ctx.lookup(s.dict.get(N("Height"))));
  if (!(w > 0 && h > 0)) return [...new Set(out)];
  const { comps, bpc, paper } = paperOf(ctx, s);
  const row = Math.ceil((w * comps * bpc) / 8);
  // Where the damage starts is known when the data was wiped or cut off: what comes before it
  // is kept and the rest is blank paper. Otherwise the picture keeps what decodes (as viewers
  // show it, garbled or not, which can't be told), stored again so strict viewers can read it.
  const good = Math.min(d.damageAt ?? d.bytes.length, d.bytes.length, row * h);
  const rows = Math.floor(good / row);
  if (rows < h && (d.damageAt !== undefined || !d.whole)) out.push("picturePatched");
  // One row of paper, packed at the picture's bit depth.
  const blank = new Uint8Array(row);
  for (let px = 0, bit = 0; px < w; px++)
    for (let c = 0; c < comps; c++, bit += bpc) {
      const v = paper[c] ?? 0;
      if (bpc === 8) blank[bit >> 3] = v;
      else if (bpc === 16) {
        blank[bit >> 3] = v >> 8;
        blank[(bit >> 3) + 1] = v & 255;
      } else blank[bit >> 3] |= (v & ((1 << bpc) - 1)) << (8 - bpc - (bit & 7));
    }
  const data = new Uint8Array(row * h);
  data.set(d.bytes.subarray(0, rows * row));
  for (let r = rows; r < h; r++) data.set(blank, r * row);
  s.contents = zlibSync(data);
  s.dict.set(N("Filter"), N("FlateDecode"));
  s.dict.delete(N("DecodeParms"));
  return [...new Set(out)];
}

/** A page: its drawing, what it draws with, and its annotations' appearances. */
async function fixPage(x: Fixer) {
  const ctx = x.ctx;
  const node = x.doc.getPage(x.page).node;
  let res: PDFDict | undefined;
  try {
    res = node.Resources();
  } catch {
    res = undefined;
  }
  if (!res) node.set(N("Resources"), (res = ctx.obj({})));
  const raw = node.get(N("Contents"));
  const c = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
  const refs = c instanceof PDFArray ? c.asArray() : raw !== undefined ? [raw] : [];
  const parts: (PDFRawStream | PDFStream)[] = [];
  for (const k of refs) {
    const s = k instanceof PDFRef ? ctx.lookup(k) : k;
    if (isStream(s)) parts.push(s);
  }
  const troubles: Trouble[] = [];
  let kept = 0;
  let damaged = false;
  for (const s of parts) {
    const o = await fixStream(x, s, res, 0);
    troubles.push(...o.troubles);
    kept += o.kept;
    damaged ||= o.damaged;
  }
  if (refs.length && !parts.length) {
    troubles.push("contentLost");
    node.delete(N("Contents"));
  } else if (parts.length < refs.length) {
    troubles.push("contentCut");
    node.set(N("Contents"), ctx.obj(refs.filter((k) => isStream(k instanceof PDFRef ? ctx.lookup(k) : k))));
  }
  else if (damaged && kept === 0) troubles.push("contentLost");
  // Annotation appearances (form fields, stamps, notes) draw with the form's fonts when they name none.
  const acro = ctx.lookup(x.doc.catalog.get(N("AcroForm")));
  const dr = acro instanceof PDFDict ? ctx.lookup(acro.get(N("DR"))) : undefined;
  const annots = ctx.lookup(node.get(N("Annots")));
  if (annots instanceof PDFArray)
    for (const a0 of annots.asArray()) {
      const a = ctx.lookup(a0);
      if (!(a instanceof PDFDict)) continue;
      const ap = ctx.lookup(a.get(N("AP")));
      if (!(ap instanceof PDFDict)) continue;
      for (const key of ["N", "R", "D"]) {
        const v = ctx.lookup(ap.get(N(key)));
        const streams = isStream(v) ? [v] : v instanceof PDFDict ? v.entries().map(([, s]) => ctx.lookup(s)).filter(isStream) : [];
        for (const s of streams) troubles.push(...(await fixStream(x, s, formResources(ctx, s.dict) ?? (dr instanceof PDFDict ? dr : undefined), 1)).troubles.filter((t) => t !== "contentCut"));
      }
    }
  // Fonts and pictures the page lists but its drawing never reached (it may be cut short) are
  // put right too, so a reader going through the list doesn't stop at a broken one.
  const fonts = category(ctx, res, "Font");
  for (const [, v] of fonts?.entries() ?? []) {
    const f = ctx.lookup(v);
    if (f instanceof PDFDict) await fixFont(x, f, res, 0);
  }
  const xobjects = category(ctx, res, "XObject");
  for (const [, v] of xobjects?.entries() ?? []) {
    const o = ctx.lookup(v);
    if (isStream(o) && nameOf(ctx.lookup(o.dict.get(N("Subtype")))) === "Image") fixImage(x, o);
  }
  const set = new Set(troubles);
  if (set.has("contentLost")) set.delete("contentCut");
  for (const t of set) x.damage.at(t, x.page);
}

/* ------------------------------------------------------------------------------- reporting */

/** "Page 3", "Pages 3 and 5", "Pages 2 to 6", "Pages 1, 3 and 7 to 9" (from 0-based indices). */
function pagesText(set: Set<number>, total: number): string {
  const p = [...set].sort((a, b) => a - b).map((i) => i + 1);
  if (p.length === 1) return `Page ${p[0]}`;
  if (p.length === total) return total === 2 ? "Both pages" : `All ${total} pages`;
  const runs: string[] = [];
  for (let i = 0; i < p.length; ) {
    let j = i;
    while (j + 1 < p.length && p[j + 1] === p[j] + 1) j++;
    if (j - i >= 2) runs.push(`${p[i]} to ${p[j]}`);
    else for (let k = i; k <= j; k++) runs.push(String(p[k]));
    i = j + 1;
  }
  // A long scatter reads better as a count.
  if (runs.length > 5) return `${p.length} pages`;
  return `Pages ${runs.length === 1 ? runs[0] : `${runs.slice(0, -1).join(", ")} and ${runs[runs.length - 1]}`}`;
}

const SAY: [Trouble, (p: string, many: boolean) => string][] = [
  ["blank", (p, many) => `${p} ${many ? "are" : "is"} missing from the file; ${many ? "blank pages keep their places" : "a blank page keeps its place"}.`],
  ["contentLost", (p, many) => `${p}: ${many ? "their" : "its"} content was lost, so ${many ? "they are" : "it is"} blank.`],
  ["contentCut", (p, many) => `${p}: the end of ${many ? "their" : "its"} content was damaged beyond repair and is missing.`],
  ["contentHole", (p, many) => `${p}: part of ${many ? "their" : "its"} content was blanked out by the damage and is missing.`],
  ["textLost", (p) => `${p}: some text was lost along with its font.`],
  ["fontStandard", (p) => `${p}: text whose font was lost is shown in a standard font.`],
  ["fontReplaced", (p) => `${p}: a damaged font was replaced with a matching one.`],
  ["fontUnreadable", (p) => `${p}: some characters of a damaged font are incomplete.`],
  ["pictureLost", (p) => `${p}: a picture was lost.`],
  ["picturePatched", (p) => `${p}: a damaged picture is missing its lower part.`],
  ["pictureCut", (p) => `${p}: a picture is incomplete (its data is cut short).`],
  ["redrawn", (p, many) => `${p} ${many ? "were" : "was"} redrawn as ${many ? "images" : "an image"} with ${many ? "their" : "its"} text kept searchable.`],
];

function noteOf(damage: Damage, pages: number): string {
  const said = [...damage.file];
  for (const [kind, say] of SAY) {
    const set = damage.pages.get(kind);
    if (set?.size) said.push(say(pagesText(set, pages), set.size > 1));
  }
  const lost = [...damage.pages.keys()].some((k) => k !== "fontReplaced" && k !== "redrawn");
  if (!said.length) said.push("No damage found; the file was rewritten cleanly.");
  else if (!lost) said.push("Nothing was lost.");
  return `${pages} page${pages === 1 ? "" : "s"}. ${said.join(" ")}`;
}

/* ------------------------------------------------------------------------------ the tool */

/** The object count the file states matches the objects it has (strict checkers warn otherwise). */
function tidyNumbers(doc: PDFDocument) {
  const ctx = doc.context;
  ctx.largestObjectNumber = Math.max(0, ...ctx.enumerateIndirectObjects().map(([r]) => r.objectNumber));
}

/**
 * The words PDF.js reads on each page (runs of four or more letters with a vowel, lower case:
 * real words, not the junk a lost font's codes read as); null for a page it can't read, and
 * null for all when it can't open the file.
 */
async function wordsPerPage(bytes: Uint8Array, password?: string): Promise<(string[] | null)[] | null> {
  try {
    return await withPdfjs(
      bytes,
      async ({ pdf, pageCount }) => {
        const out: (string[] | null)[] = [];
        for (let i = 1; i <= pageCount; i++) {
          try {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            const text = tc.items.map((it) => ("str" in it ? it.str : "")).join(" ");
            out.push((text.match(/\p{L}{4,}/gu) ?? []).map((w) => w.toLowerCase()).filter((w) => /[aeiouy\u00e0-\u00ff]/.test(w)));
            page.cleanup();
          } catch {
            out.push(null);
          }
        }
        return out;
      },
      password,
    );
  } catch (e) {
    if (e instanceof PdfjsPasswordError) throw e;
    return null;
  }
}

/** How many of `theirs` (a multiset of words) are missing from `mine`. */
function missingWords(theirs: string[], mine: string[]): number {
  const have = new Map<string, number>();
  for (const w of mine) have.set(w, (have.get(w) ?? 0) + 1);
  let missing = 0;
  for (const w of theirs) {
    const n = have.get(w) ?? 0;
    if (n) have.set(w, n - 1);
    else missing++;
  }
  return missing;
}

export async function repairPdf(src: Src, onProgress?: ProgressFn): Promise<OutFile> {
  const name = `${stem(src.name)}-repaired.pdf`;
  const damage = new Damage();
  let doc: PDFDocument;
  let kits: Map<PDFRef, Kit>;
  try {
    onProgress?.(0.05, "Reading the file");
    ({ doc, kits } = await readDamaged(src.bytes, { password: src.password, name: src.name }, damage));
  } catch (e) {
    if (e instanceof PasswordError || e instanceof PdfjsPasswordError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/^This (file|is)/.test(msg)) throw e;
    return redrawAll(src, onProgress);
  }
  const n = doc.getPageCount();
  if (!n || damage.pages.get("blank")?.size === n) {
    try {
      return await redrawAll(src, onProgress);
    } catch (e) {
      if (e instanceof PdfjsPasswordError) throw e;
      throw new Error(
        damage.file.some((f) => /end of the file was missing/.test(f))
          ? "This file was cut short, and none of its pages are in the part that is left. Get it again from where it came from."
          : "None of this file's pages survived the damage, so there is nothing to recover.",
      );
    }
  }
  const x: Fixer = { doc, ctx: doc.context, damage, page: 0, seen: new Map(), lost: new Map(), standard: new Map(), kits, rebuilt: 0, gone: new Set(), splits: new Map() };
  for (let i = 0; i < n; i++) {
    onProgress?.(0.1 + (0.6 * i) / n, `Checking page ${i + 1} of ${n}`);
    x.page = i;
    await fixPage(x);
    if (i % 8 === 7) await tick();
  }
  if (x.rebuilt) damage.fix(`Rebuilt ${x.rebuilt === 1 ? "a lost font" : `${x.rebuilt} lost fonts`} from ${x.rebuilt === 1 ? "its" : "their"} surviving parts.`);
  dropDangling(doc.context);
  await dropUnreferenced(doc);
  tidyNumbers(doc);
  let bytes = await saveDoc(doc, { objectStreams: false });

  // Read back with the other engine; pages it reads better from the original are redrawn from there.
  onProgress?.(0.75, "Checking the result");
  const mine = await wordsPerPage(bytes);
  if (!mine || mine.length !== n) return redrawAll(src, onProgress);
  const found = damage.file.length > 0 || damage.pages.size > 0;
  const redo: number[] = [];
  if (found && !damage.file.some((f) => /list of pages/.test(f))) {
    const theirs = await wordsPerPage(src.bytes, src.password);
    if (theirs && theirs.length === n)
      for (let i = 0; i < n; i++) {
        const skip = (["textLost", "blank", "contentCut", "contentHole", "contentLost"] as Trouble[]).some((t) => damage.has(t, i));
        const t = theirs[i];
        const m = mine[i];
        if (!m || (!skip && t && missingWords(t, m) >= 20 && missingWords(t, m) >= t.length * 0.25)) redo.push(i);
      }
  }
  if (redo.length) {
    const fonts = new FontSet(doc);
    await withPdfjs(
      src.bytes,
      async ({ pdf }) => {
        for (const [k, i] of redo.entries()) {
          onProgress?.(0.8 + (0.15 * k) / redo.length, `Redrawing page ${i + 1}`);
          const page = await pdf.getPage(i + 1);
          const canvas = await renderPage(page, 300 / 72, { pixelBudget: 36e6 });
          const text = await pageText(page).catch(() => null);
          page.cleanup();
          await redrawPage(doc, i, canvas, text, fonts, { quality: 0.9 });
          canvas.width = canvas.height = 0;
          damage.at("redrawn", i);
          await tick();
        }
      },
      src.password,
    );
    await dropUnreferenced(doc);
    tidyNumbers(doc);
    bytes = await saveDoc(doc, { objectStreams: false });
  }
  return pdfOut(name, bytes, noteOf(damage, n));
}

/**
 * The last resort, when the file's structure can't be read at all: every page PDF.js can show is
 * redrawn as an image, with its words kept as searchable text.
 */
async function redrawAll(src: Src, onProgress?: ProgressFn): Promise<OutFile> {
  const out = await newDoc();
  const fonts = new FontSet(out);
  let ok = 0;
  let failed = 0;
  try {
    await withPdfjs(
      src.bytes,
      async ({ pdf, pageCount }) => {
        for (let i = 1; i <= pageCount; i++) {
          onProgress?.(i / pageCount, `Recovering page ${i} of ${pageCount}`);
          try {
            const page = await pdf.getPage(i);
            const canvas = await renderPage(page, 2);
            const text = await pageText(page).catch(() => null);
            page.cleanup();
            const vp = page.getViewport({ scale: 1 });
            const img = await out.embedJpg(await canvasToBytes(canvas, "image/jpeg", 0.9));
            const np = out.addPage([vp.width, vp.height]);
            np.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
            if (text) {
              const f = pageFrame(np);
              for (const it of text.items) {
                if (!it.str.trim()) continue;
                const p = place(f, it.ox, f.height - it.oy, -it.dir);
                await fonts.drawInvisible(np, it.str, { x: p.x, y: p.y, size: it.fontSize, width: it.w, rotate: p.rotate });
              }
            }
            ok++;
          } catch {
            failed++;
          }
          await tick();
        }
      },
      src.password,
    );
  } catch (e) {
    if (e instanceof PdfjsPasswordError) throw e;
    throw new Error("This file is too damaged to recover: no page in it can be read.");
  }
  if (!ok) throw new Error("This file is too damaged to recover: no page in it can be read.");
  const note = `${ok} page${ok === 1 ? "" : "s"}. The file's structure was beyond repair, so every page that could be read was redrawn as an image with its text kept searchable.${failed ? ` ${failed} page${failed === 1 ? "" : "s"} could not be read.` : ""}`;
  return pdfOut(`${stem(src.name)}-repaired.pdf`, await saveDoc(out), note);
}
