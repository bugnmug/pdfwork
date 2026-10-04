/**
 * Minimal PDF content-stream tokenizer and walker. Enough to follow the
 * graphics state (q/Q/cm), find where images are drawn and at what size, and
 * rewrite colour operators.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
} from "@cantoo/pdf-lib";
import type { PDFDocument } from "./core";

export type TokType = "num" | "name" | "str" | "hex" | "op" | "arrS" | "arrE" | "dictS" | "dictE" | "inline";
export type Tok = { t: TokType; s: number; e: number; v: string };

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

export function tokenize(b: Uint8Array): Tok[] {
  const out: Tok[] = [];
  const n = b.length;
  let i = 0;
  const str = (s: number, e: number) => {
    let r = "";
    for (let k = s; k < e; k++) r += String.fromCharCode(b[k]);
    return r;
  };
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) {
      i++;
      continue;
    }
    if (c === 37) {
      while (i < n && b[i] !== 10 && b[i] !== 13) i++;
      continue;
    }
    const s = i;
    if (c === 40) {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (b[i] === 92) i += 2;
        else {
          if (b[i] === 40) depth++;
          else if (b[i] === 41) depth--;
          i++;
        }
      }
      out.push({ t: "str", s, e: i, v: "" });
      continue;
    }
    if (c === 60) {
      if (b[i + 1] === 60) {
        out.push({ t: "dictS", s, e: i + 2, v: "<<" });
        i += 2;
        continue;
      }
      while (i < n && b[i] !== 62) i++;
      i++;
      out.push({ t: "hex", s, e: i, v: "" });
      continue;
    }
    if (c === 62 && b[i + 1] === 62) {
      out.push({ t: "dictE", s, e: i + 2, v: ">>" });
      i += 2;
      continue;
    }
    if (c === 91 || c === 93) {
      out.push({ t: c === 91 ? "arrS" : "arrE", s, e: i + 1, v: String.fromCharCode(c) });
      i++;
      continue;
    }
    if (c === 123 || c === 125 || c === 41 || c === 62) {
      i++;
      continue;
    }
    if (c === 47) {
      i++;
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
      out.push({ t: "name", s, e: i, v: str(s + 1, i) });
      continue;
    }
    while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    const word = str(s, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      out.push({ t: "num", s, e: i, v: word });
      continue;
    }
    if (word === "BI") {
      // Inline image: skip to "ID", then binary data until whitespace + "EI" + whitespace/EOF.
      let k = i;
      while (k < n - 1 && !(b[k] === 73 && b[k + 1] === 68 && WS.has(b[k - 1]) && (WS.has(b[k + 2]) || k + 2 >= n))) k++;
      k += 3;
      while (k < n - 1 && !(WS.has(b[k - 1]) && b[k] === 69 && b[k + 1] === 73 && (k + 2 >= n || WS.has(b[k + 2]) || DELIM.has(b[k + 2])))) k++;
      i = Math.min(n, k + 2);
      out.push({ t: "inline", s, e: i, v: "BI" });
      continue;
    }
    out.push({ t: "op", s, e: i, v: word || String.fromCharCode(c) });
    if (!word) i++;
  }
  return out;
}

export function streamBytes(ctx: PDFContext, obj: unknown): Uint8Array {
  const s = obj instanceof PDFRef ? ctx.lookup(obj) : obj;
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFStream) return s.getContents();
  return new Uint8Array();
}

/** Concatenated, decoded content of a page. */
export function pageContent(doc: PDFDocument, pageIndex: number): Uint8Array {
  const page = doc.getPage(pageIndex);
  const ctx = doc.context;
  const contents = page.node.get(PDFName.of("Contents"));
  const resolved = contents instanceof PDFRef ? ctx.lookup(contents) : contents;
  const parts: Uint8Array[] = [];
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) parts.push(streamBytes(ctx, resolved.get(i)));
  } else if (resolved) parts.push(streamBytes(ctx, resolved));
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 10;
  }
  return out;
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

function resourcesOf(node: PDFDict | undefined, ctx: PDFContext): PDFDict | undefined {
  if (!node) return undefined;
  const r = node.get(PDFName.of("Resources"));
  const d = r instanceof PDFRef ? ctx.lookup(r) : r;
  return d instanceof PDFDict ? d : undefined;
}

function xobjects(res: PDFDict | undefined, ctx: PDFContext): PDFDict | undefined {
  if (!res) return undefined;
  const x = res.get(PDFName.of("XObject"));
  const d = x instanceof PDFRef ? ctx.lookup(x) : x;
  return d instanceof PDFDict ? d : undefined;
}

/** For every image XObject, the largest size (in points) it is drawn at anywhere in the document. */
export function imageDisplaySizes(doc: PDFDocument): Map<string, { w: number; h: number }> {
  const ctx = doc.context;
  const sizes = new Map<string, { w: number; h: number }>();
  const record = (ref: PDFRef, m: M) => {
    const w = Math.hypot(m[0], m[1]);
    const h = Math.hypot(m[2], m[3]);
    const key = ref.toString();
    const cur = sizes.get(key);
    if (!cur || w * h > cur.w * cur.h) sizes.set(key, { w, h });
  };
  const run = (bytes: Uint8Array, res: PDFDict | undefined, base: M, depth: number) => {
    if (depth > 12) return;
    const xo = xobjects(res, ctx);
    const toks = tokenize(bytes);
    const stack: M[] = [];
    let ctm = base;
    const nums: number[] = [];
    let lastName = "";
    for (const t of toks) {
      if (t.t === "num") {
        nums.push(Number(t.v));
        continue;
      }
      if (t.t === "name") {
        lastName = t.v;
        nums.length = 0;
        continue;
      }
      if (t.t !== "op") {
        nums.length = 0;
        continue;
      }
      switch (t.v) {
        case "q":
          stack.push(ctm);
          break;
        case "Q":
          ctm = stack.pop() ?? base;
          break;
        case "cm":
          if (nums.length >= 6) ctm = mul(nums.slice(-6) as M, ctm);
          break;
        case "Do": {
          const raw = xo?.get(PDFName.of(lastName));
          if (raw instanceof PDFRef) {
            const obj = ctx.lookup(raw);
            if (obj instanceof PDFRawStream || obj instanceof PDFStream) {
              const sub = obj.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
              if (sub === "/Image") record(raw, ctm);
              else if (sub === "/Form") {
                const mArr = obj.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray);
                const fm: M = mArr ? (Array.from({ length: 6 }, (_, k) => (mArr.lookup(k) as PDFNumber)?.asNumber?.() ?? (k === 0 || k === 3 ? 1 : 0)) as M) : [1, 0, 0, 1, 0, 0];
                try {
                  run(streamBytes(ctx, obj), resourcesOf(obj.dict, ctx) ?? res, mul(fm, ctm), depth + 1);
                } catch {
                  /* undecodable form: ignore */
                }
              }
            }
          }
          break;
        }
      }
      nums.length = 0;
    }
  };
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    try {
      run(pageContent(doc, i), resourcesOf(p.node, ctx) ?? (p.node.Resources() as PDFDict | undefined), [1, 0, 0, 1, 0, 0], 0);
    } catch {
      /* skip page */
    }
  });
  return sizes;
}

/** Which pages draw which image refs (for listing extracted images by page). */
export function imagesByPage(doc: PDFDocument): Map<string, number> {
  const ctx = doc.context;
  const first = new Map<string, number>();
  doc.getPages().forEach((p, i) => {
    const visit = (res: PDFDict | undefined, depth: number) => {
      const xo = xobjects(res, ctx);
      if (!xo || depth > 8) return;
      for (const key of xo.keys()) {
        const ref = xo.get(key);
        if (!(ref instanceof PDFRef)) continue;
        const obj = ctx.lookup(ref);
        if (!(obj instanceof PDFRawStream || obj instanceof PDFStream)) continue;
        const sub = obj.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString();
        if (sub === "/Image") {
          if (!first.has(ref.toString())) first.set(ref.toString(), i);
        } else if (sub === "/Form") visit(resourcesOf(obj.dict, ctx), depth + 1);
      }
    };
    visit(resourcesOf(p.node, ctx) ?? (p.node.Resources() as PDFDict | undefined), 0);
  });
  return first;
}
