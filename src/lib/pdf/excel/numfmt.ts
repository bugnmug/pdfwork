/**
 * Excel number formats: the section a value falls in, its colour, padding
 * (`_)` leaves the width of ")"), fill (`* ` stretches to the cell's width),
 * Indian digit grouping (#,##,##0) and General's fitting to the column. The
 * format codes themselves are applied by SheetJS's SSF.
 */
import { SSF as SSF0 } from "xlsx";

const SSF = SSF0 as unknown as { format(fmt: string, v: unknown, o?: { date1904?: boolean }): string; is_date(fmt: string): boolean };

export type Formatted = {
  text: string;
  /** Colour from the format ([Red], [Color10]). */
  color?: string;
  /** `_x`: each PAD in `text` stands for a blank as wide as the matching character here. */
  pads: string[];
  /** `*x`: `x` repeats at FILL to fill the cell. */
  fill?: string;
  /** The value is a number (or date): right-aligned by default, ##### when it does not fit. */
  numeric: boolean;
  /** General format: can show fewer decimals to fit. */
  general?: boolean;
};

export const PAD = "\uE001";
export const FILL = "\uE002";

const COLORS: Record<string, string> = { black: "000000", blue: "0000FF", cyan: "00FFFF", green: "00FF00", magenta: "FF00FF", red: "FF0000", white: "FFFFFF", yellow: "FFFF00" };
const PALETTE = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
  "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF", "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
  "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99", "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
  "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];

/** Split a format code into its ;-separated sections (outside quotes, brackets and escapes). */
export function sections(fmt: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  let br = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === "\\" && !q) {
      cur += ch + (fmt[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') q = !q;
    else if (!q && ch === "[") br = true;
    else if (!q && ch === "]") br = false;
    if (ch === ";" && !q && !br) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const COND = /\[(<=|>=|<>|<|>|=)\s*(-?[\d.]+)\]/;
function test(sec: string, v: number): boolean | null {
  const m = COND.exec(sec);
  if (!m) return null;
  const n = Number(m[2]);
  switch (m[1]) {
    case "<":
      return v < n;
    case "<=":
      return v <= n;
    case ">":
      return v > n;
    case ">=":
      return v >= n;
    case "=":
      return v === n;
    default:
      return v !== n;
  }
}

/** The section a number is shown with, and the value that section shows (its sign carried by the section). */
function pick(secs: string[], v: number): { sec: string; v: number } {
  const nonEmpty = secs.length;
  if (secs.some((s) => COND.test(s))) {
    if (test(secs[0], v)) return { sec: secs[0], v };
    if (nonEmpty > 1 && test(secs[1], v)) return { sec: secs[1], v: Math.abs(v) };
    if (nonEmpty > 2) return { sec: secs[2], v: Math.abs(v) };
    if (nonEmpty > 1 && !COND.test(secs[1])) return { sec: secs[1], v: Math.abs(v) };
    return { sec: secs[0], v };
  }
  if (nonEmpty === 1 || secs[0] === undefined) return { sec: secs[0], v };
  if (v > 0 || (v === 0 && nonEmpty < 3)) return { sec: secs[0], v };
  if (v < 0) return { sec: secs[1], v: -v };
  return { sec: secs[2] ?? secs[0], v };
}

/** Rewrite a section for SSF: colours and conditions out, padding and fill as markers. */
function prepare(sec: string): { code: string; color?: string; pads: string[]; fill?: string; indian: boolean } {
  let code = "";
  let color: string | undefined;
  const pads: string[] = [];
  let fill: string | undefined;
  for (let i = 0; i < sec.length; i++) {
    const ch = sec[i];
    if (ch === '"') {
      const end = sec.indexOf('"', i + 1);
      const lit = end < 0 ? sec.slice(i) : sec.slice(i, end + 1);
      code += lit;
      i += lit.length - 1;
    } else if (ch === "\\") {
      code += ch + (sec[i + 1] ?? "");
      i++;
    } else if (ch === "[") {
      const end = sec.indexOf("]", i);
      const inner = sec.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? sec.length : end;
      const lower = inner.toLowerCase();
      if (COLORS[lower]) color = COLORS[lower];
      else if (/^color\s*\d+$/.test(lower)) color = PALETTE[Number(lower.replace(/\D/g, "")) - 1];
      else if (COND.test(`[${inner}]`)) continue;
      else code += `[${inner}]`;
    } else if (ch === "_") {
      pads.push(sec[i + 1] ?? " ");
      code += `"${PAD}"`;
      i++;
    } else if (ch === "*") {
      if (fill === undefined) {
        fill = sec[i + 1] ?? " ";
        code += `"${FILL}"`;
      }
      i++;
    } else code += ch;
  }
  // Indian grouping: 12,34,567.00. SSF knows only thousands; regroup afterwards.
  const indian = /#,##,##0|#,##,###/.test(code);
  if (indian) code = code.replace(/#,##,##0/g, "#,##0").replace(/#,##,###/g, "#,###");
  return { code, color, pads, fill, indian };
}

const regroupIndian = (s: string) =>
  s.replace(/\d{1,3}(?:,\d{3})+|\d{4,}/, (m) => {
    const digits = m.replace(/,/g, "");
    if (digits.length <= 3) return digits;
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    return `${rest},${last3}`;
  });

/** Excel's General format for a number, in at most `maxChars` characters (11 by default). */
export function general(v: number, maxChars = 11): string {
  if (!Number.isFinite(v)) return "#NUM!";
  if (v === 0) return "0";
  const neg = v < 0;
  const a = Math.abs(v);
  const room = Math.max(1, maxChars - (neg ? 1 : 0));
  const sign = neg ? "-" : "";
  const digits = (s: string) => s.replace(".", "").replace(/^0+/, "").replace(/0+$/, "").length;
  // Plain: as many decimals as the room leaves.
  let plain: string | null = null;
  const intLen = a >= 1 ? Math.floor(Math.log10(a)) + 1 : 1;
  if (intLen <= room) {
    let s = a.toFixed(Math.min(100, Math.max(0, room - intLen - 1)));
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    if (s.length <= room && Number(s) !== 0) plain = s;
  }
  // Scientific: 1.23457E+14.
  let sci: string | null = null;
  for (let d = Math.max(0, room - 6); d >= 0 && !sci; d--) {
    const [m, e] = a.toExponential(d).split("e");
    const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    const exp = Number(e);
    const s = `${mant}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
    if (s.length <= room) sci = s;
  }
  // Plain wins unless scientific shows more of a small number (0.000000123 against 1.23456E-07).
  if (plain !== null && (a >= 1 || !sci || digits(plain) >= digits(sci.split("E")[0]))) return sign + plain;
  if (sci) return sign + sci;
  return "#".repeat(Math.max(1, maxChars));
}

const isGeneral = (code: string) => /^general$/i.test(code.trim());

/** A cell value as Excel shows it with format `fmt`. */
export function formatValue(v: number | string | boolean | null, t: string, fmt: string, date1904: boolean): Formatted {
  if (v === null || v === "") return { text: "", pads: [], numeric: false };
  if (t === "b") return { text: v ? "TRUE" : "FALSE", pads: [], numeric: false };
  if (t === "e") return { text: String(v), pads: [], numeric: false };
  const secs = sections(fmt || "General");
  if (typeof v === "string") {
    // Text goes through the fourth section, or a single section with @; otherwise as it is.
    const sec = secs.length >= 4 ? secs[3] : secs.length === 1 && secs[0].includes("@") ? secs[0] : null;
    if (!sec) return { text: v, pads: [], numeric: false };
    const p = prepare(sec);
    let text: string;
    try {
      text = SSF.format(p.code, v, { date1904 });
    } catch {
      text = v;
    }
    return { text, color: p.color, pads: p.pads, fill: p.fill, numeric: false };
  }
  const n = Number(v);
  if (secs.length === 1 && isGeneral(secs[0])) return { text: general(n), pads: [], numeric: true, general: true };
  const { sec, v: shown } = pick(secs, n);
  if (isGeneral(sec.replace(COND, "").replace(/\[[^\]]*\]/g, ""))) {
    const p = prepare(sec);
    return { text: general(shown), color: p.color, pads: [], numeric: true, general: true };
  }
  const p = prepare(sec);
  if (!p.code.replace(/"[^"]*"/g, "").trim() && !p.code.includes('"')) return { text: "", pads: [], numeric: true };
  // Plain number formats (any grouping, decimals, percent, scaling, literals) are done here;
  // dates, times, fractions and scientific go to SSF.
  const plain = plainNumber(sec, shown);
  if (plain !== null) return { text: plain, color: p.color, pads: p.pads, fill: p.fill, numeric: true };
  let text: string;
  try {
    text = SSF.format(p.code, shown, { date1904 });
  } catch {
    // Dates before 1900 and other values the format cannot show.
    text = "#".repeat(8);
  }
  if (p.indian) text = regroupIndian(text);
  return { text, color: p.color, pads: p.pads, fill: p.fill, numeric: true };
}

/**
 * A number in a plain number format: literals around one block of digit placeholders
 * (0 # ?), with grouping commas (Indian when the groups go two by two), decimals, percent
 * signs and trailing commas that scale by a thousand. Null for anything else.
 */
export function plainNumber(sec: string, v: number): string | null {
  type Tok = { lit: string } | { num: string } | { pct: true };
  const toks: Tok[] = [];
  let num = "";
  let numDone = false;
  const endNum = () => {
    if (num && !numDone) {
      toks.push({ num });
      numDone = true;
    }
  };
  for (let i = 0; i < sec.length; i++) {
    const ch = sec[i];
    if (ch === '"') {
      const end = sec.indexOf('"', i + 1);
      endNum();
      toks.push({ lit: sec.slice(i + 1, end < 0 ? undefined : end) });
      i = end < 0 ? sec.length : end;
    } else if (ch === "\\") {
      endNum();
      toks.push({ lit: sec[i + 1] ?? "" });
      i++;
    } else if (ch === "_") {
      endNum();
      toks.push({ lit: PAD });
      i++;
    } else if (ch === "*") {
      endNum();
      toks.push({ lit: FILL });
      i++;
    } else if (ch === "[") {
      const end = sec.indexOf("]", i);
      const inner = sec.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? sec.length : end;
      const cur = /^\$([^-\]]*)/.exec(inner);
      if (cur) {
        endNum();
        toks.push({ lit: cur[1] });
      } else if (/^(h+|m+|s+)$/i.test(inner)) return null; // elapsed time
    } else if ("0#?,.".includes(ch)) {
      if (numDone) return null; // a second block of digits (a phone number pattern): SSF
      num += ch;
    } else if (ch === "%") {
      endNum();
      toks.push({ pct: true });
    } else if (/[ymdhsEe/@]/.test(ch) || ch === "A" && /^AM\/PM/i.test(sec.slice(i))) return null;
    else {
      endNum();
      toks.push({ lit: ch });
    }
  }
  endNum();
  const block = toks.find((t): t is { num: string } => "num" in t);
  if (!block) return null;
  let pat = block.num;
  // Commas after the last digit divide by a thousand each.
  let scale = 1;
  while (pat.endsWith(",")) {
    scale *= 1000;
    pat = pat.slice(0, -1);
  }
  const [ip, dp = ""] = pat.split(".");
  if (pat.split(".").length > 2) return null;
  const pct = toks.filter((t) => "pct" in t).length;
  let x = (Math.abs(v) / scale) * Math.pow(100, pct);
  const decs = dp.replace(/[^0#?]/g, "");
  x = Number(x.toFixed(Math.min(20, decs.length)));
  let [is, ds = ""] = x.toFixed(Math.min(20, decs.length)).split(".");
  // Decimals: # drops trailing zeros, ? turns them to spaces.
  if (decs.length) {
    const chars = ds.split("");
    for (let k = decs.length - 1; k >= 0 && chars[k] === "0"; k--) {
      if (decs[k] === "#") chars.pop();
      else if (decs[k] === "?") chars[k] = " ";
      else break;
    }
    ds = chars.join("");
  }
  // Whole part: at least as many digits as there are zeros, ? as spaces; grouping commas.
  const ints = ip.replace(/[^0#?]/g, "");
  const minDigits = (ints.match(/0/g) ?? []).length;
  if (is === "0" && !minDigits) is = "";
  while (is.length < minDigits) is = "0" + is;
  const q = (ints.match(/\?/g) ?? []).length;
  if (is.length < minDigits + q) is = " ".repeat(minDigits + q - is.length) + is;
  if (/[0#?],[0#?]/.test(ip)) {
    const lead = is.match(/^ */)?.[0] ?? "";
    const d = is.slice(lead.length);
    const indian = /[#0?],[#0?]{2},[#0?]{3}$/.test(ip);
    const grouped = indian ? d.replace(/(\d)(?=(\d{3})$)/, "$1,").replace(/(\d)(?=(\d{2})+,)/g, "$1,") : d.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    is = lead + grouped;
  }
  let numText = is + (dp !== "" || pat.includes(".") ? "." + ds : "");
  if (!decs.length && pat.includes(".")) numText = is + ".";
  let out = "";
  for (const t of toks) out += "lit" in t ? t.lit : "pct" in t ? "%" : numText;
  return (v < 0 && x !== 0 ? "-" : v < 0 ? "-" : "") + out;
}

export function isDateFormat(fmt: string): boolean {
  try {
    return SSF.is_date(fmt);
  } catch {
    return false;
  }
}
