/** Personal-data patterns, tuned for Indian and international documents. */
export type PiiKind =
  | "email"
  | "phone"
  | "aadhaar"
  | "pan"
  | "gstin"
  | "ifsc"
  | "upi"
  | "card"
  | "bank"
  | "passport"
  | "voterid"
  | "ssn"
  | "iban"
  | "ip"
  | "dob"
  | "custom";

export type PiiHit = { kind: PiiKind; value: string; index: number; length: number; confidence: "high" | "medium" };

export const PII_LABEL: Record<PiiKind, string> = {
  email: "Email address",
  phone: "Phone number",
  aadhaar: "Aadhaar number",
  pan: "PAN",
  gstin: "GSTIN",
  ifsc: "IFSC code",
  upi: "UPI ID",
  card: "Payment card number",
  bank: "Bank account number",
  passport: "Passport number",
  voterid: "Voter ID (EPIC)",
  ssn: "US SSN",
  iban: "IBAN",
  ip: "IP address",
  dob: "Date of birth",
  custom: "Custom term",
};

export const PII_KINDS = Object.keys(PII_LABEL).filter((k) => k !== "custom") as PiiKind[];

type Rule = { kind: PiiKind; re: RegExp; check?: (m: string, full: RegExpExecArray) => PiiHit["confidence"] | null; group?: number };

const digits = (s: string) => s.replace(/\D/g, "");

function luhn(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = num.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Verhoeff checksum used by Aadhaar.
const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
function verhoeff(num: string): boolean {
  let c = 0;
  const arr = num.split("").reverse().map(Number);
  for (let i = 0; i < arr.length; i++) c = VD[c][VP[i % 8][arr[i]]];
  return c === 0;
}

// Birth-date labels as printed on IDs and forms, including the Hindi one on Aadhaar cards
// ("जन्म तिथि/DOB"). The value may follow a format hint such as "(DD/MM/YYYY)".
const DOB_LABEL = String.raw`(?:\bdate\s+of\s+birth|\bbirth\s*date|\bd\W{0,2}o\W{0,2}b\b\.?|\bborn(?:\s+on)?|जन्म\s*(?:तिथि|तारीख))`;
// 01/02/1990, 1-2-90, 15th Aug 1990, August 15, 1990, 1990-02-01
const MONTH = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;
const DOB_VALUE = String.raw`(\d{1,2}(?:st|nd|rd|th)?[\s./-](?:\d{1,2}|[a-z]{3,9}\.?)[\s,./-]{1,2}\d{2,4}|[a-z]{3,9}\.?\s\d{1,2}(?:st|nd|rd|th)?,?\s\d{4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})`;

const RULES: Rule[] = [
  { kind: "email", re: /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi },
  { kind: "upi", re: /\b[a-z0-9._-]{2,}@(?:ok)?(?:sbi|icici|hdfcbank|axis|axl|ybl|ibl|paytm|upi|apl|okaxis|okhdfcbank|okicici|oksbi|kotak|barodampay|idfcbank|federal|indus|aubank|jupiteraxis|fbl|yesbank|pnb|unionbank|cnrb|boi|freecharge|airtel|jio|slc|timecosmos|waaxis|wahdfcbank|waicici|wasbi)\b/gi },
  {
    kind: "card",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    check: (m) => {
      const d = digits(m);
      if (d.length < 13 || d.length > 19) return null;
      if (!/^(?:4|5[1-5]|2[2-7]|3[47]|3[0689]|6|35|62|60|65|81|82|508|353|356)/.test(d)) return null;
      return luhn(d) ? "high" : null;
    },
  },
  {
    kind: "aadhaar",
    re: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    check: (m) => (verhoeff(digits(m)) ? "high" : "medium"),
  },
  { kind: "gstin", re: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g },
  { kind: "pan", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, check: (m) => (/^[A-Z]{3}[ABCFGHLJPTK]/.test(m) ? "high" : "medium") },
  { kind: "ifsc", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  {
    // Only numbers labelled as a passport, so stray codes aren't caught. India's format
    // (one letter, seven digits) is certain; other countries' formats are flagged to check.
    kind: "passport",
    re: /\bpassport\s*(?:(?:no|num(?:ber)?)\b\.?|#)?\s*[:.-]?\s*([A-Z]{1,2}\d{6,8}|\d{9})\b/gi,
    group: 1,
    check: (m) => (/^[A-Z]\d{7}$/i.test(m) ? "high" : "medium"),
  },
  { kind: "voterid", re: /\b[A-Z]{3}\d{7}\b/g },
  { kind: "ssn", re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, check: (m) => (ibanValid(m) ? "high" : null) },
  {
    kind: "bank",
    re: /\b(?:a\/?c|acct|account)(?:\s*(?:no\.?|number|#))?\s*[:-]?\s*(\d[\d -]{7,20}\d)\b/gi,
    group: 1,
  },
  {
    kind: "phone",
    re: /(?:(?:\+|00)91[\s-]?|\b0)?\b[6-9]\d{4}[\s-]?\d{5}\b|(?:\+|00)[1-9]\d{0,2}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}\b|\(\d{3}\)\s?\d{3}-\d{4}\b/g,
    check: (m) => (digits(m).length >= 10 && digits(m).length <= 15 ? "high" : null),
  },
  { kind: "ip", re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  {
    kind: "dob",
    re: new RegExp(DOB_LABEL + String.raw`(?:\s*\([^)]{0,14}\))?\s*[:/-]?\s*` + DOB_VALUE, "gi"),
    group: 1,
    // A written month must really be a month ("12 March 1990", not "12 Marks 90").
    check: (m) => {
      const word = /[a-z]{3,}/i.exec(m)?.[0];
      return !word || MONTH.test(word) ? "high" : null;
    },
  },
];

function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const re = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export type FindOpts = { kinds?: PiiKind[]; terms?: string[]; regex?: string; caseSensitive?: boolean };

/** Find personal data and custom terms. Overlapping hits keep the most specific. */
export function findPii(text: string, opts: FindOpts = {}): PiiHit[] {
  const kinds = new Set(opts.kinds ?? PII_KINDS);
  const hits: PiiHit[] = [];
  for (const rule of RULES) {
    if (!kinds.has(rule.kind)) continue;
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const value = rule.group ? m[rule.group] : m[0];
      if (!value) continue;
      const index = rule.group ? m.index + m[0].lastIndexOf(value) : m.index;
      const conf = rule.check ? rule.check(value, m) : "high";
      if (!conf) continue;
      hits.push({ kind: rule.kind, value: value.trim(), index, length: value.length, confidence: conf });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  for (const term of (opts.terms ?? []).map((t) => t.trim()).filter(Boolean)) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), opts.caseSensitive ? "g" : "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) hits.push({ kind: "custom", value: m[0], index: m.index, length: m[0].length, confidence: "high" });
  }
  if (opts.regex?.trim()) {
    let re: RegExp;
    try {
      re = new RegExp(opts.regex, opts.caseSensitive ? "g" : "gi");
    } catch {
      throw new Error("The custom pattern is not a valid regular expression.");
    }
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      hits.push({ kind: "custom", value: m[0], index: m.index, length: m[0].length, confidence: "high" });
    }
  }
  // Resolve overlaps: prefer longer, then earlier rule order (already the push order).
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  const out: PiiHit[] = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (prev && h.index < prev.index + prev.length) {
      if (h.length > prev.length && h.kind !== "custom") out[out.length - 1] = h;
      continue;
    }
    out.push(h);
  }
  return out;
}
