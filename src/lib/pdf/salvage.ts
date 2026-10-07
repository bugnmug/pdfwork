/**
 * Reading damaged PDFs.
 *
 * A PDF is a set of numbered objects (pages, fonts, pictures, the drawing of each page) and an
 * index of where each one starts. Damage comes in a few shapes: the index is wrong or gone (the
 * file was edited carelessly, or cut short), stray bytes sit in front of it, an object is
 * overwritten or cut off, or the compressed data inside one is corrupted. Here a file is read the
 * way a careful viewer reads it, without trusting the index: every object is found by its own
 * header, objects the normal reader gave up on are read again with their ends found another way,
 * compressed data is decoded as far as it is good (and no further), and the document's catalog
 * and page list are rebuilt when they are lost. What was found goes into a Damage record, so the
 * result can say plainly what was repaired and what could not be saved.
 */
import {
  PDFArray,
  PDFCatalog,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFInvalidObject,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObjectParser,
  PDFPageLeaf,
  PDFPageTree,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFObject,
} from "@cantoo/pdf-lib";
import fontkit from "@cantoo/fontkit";
import { Inflate, Unzlib, inflateSync, unzlibSync } from "fflate";
import { loadPdf } from "./core";
import { unicodeOf, winAnsi } from "./glyphnames";

const N = (s: string) => PDFName.of(s);
const isWS = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const isDigit = (c: number) => c >= 48 && c <= 57;
const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
const nameOf = (o: unknown) => (o instanceof PDFName ? o.decodeText() : undefined);
const numOf = (o: unknown) => (o instanceof PDFNumber ? o.asNumber() : undefined);

/* ------------------------------------------------------------------------ the record of damage */

/** Kinds of trouble found on pages, each told to the reader once with the pages it touched. */
export type Trouble =
  | "fontStandard"
  | "textLost"
  | "fontReplaced"
  | "fontUnreadable"
  | "contentCut"
  | "contentHole"
  | "contentLost"
  | "pictureLost"
  | "picturePatched"
  | "pictureCut"
  | "redrawn"
  | "blank";

export class Damage {
  /** Repairs to the file as a whole, in plain words, in the order they were made. */
  readonly file: string[] = [];
  /** Per kind of trouble, the pages (0-based, in the repaired file) it was found on. */
  readonly pages = new Map<Trouble, Set<number>>();
  fix(text: string) {
    if (!this.file.includes(text)) this.file.push(text);
  }
  at(kind: Trouble, page: number) {
    let s = this.pages.get(kind);
    if (!s) this.pages.set(kind, (s = new Set()));
    s.add(page);
  }
  has(kind: Trouble, page: number) {
    return this.pages.get(kind)?.has(page) ?? false;
  }
}

/* ------------------------------------------------------------------- files that aren't PDFs */

/** What a file is when it holds no PDF at all, said so the reader knows what to do instead. */
export function notPdf(b: Uint8Array): string {
  if (!b.length) return "This file is empty: there is no data in it at all. It was probably not downloaded or copied completely, so get it again from where it came from.";
  let zeros = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 0) zeros++;
  if (zeros >= b.length * 0.98)
    return "This file holds only blank bytes and no data. That happens when a download, copy or sync stops before the data is written, so get it again from where it came from.";
  const at = (sig: number[], off = 0) => sig.every((v, i) => b[off + i] === v);
  const picture = (kind: string) => `This is a ${kind} picture saved with a .pdf name, not a PDF. Images to PDF turns it into one.`;
  const head = latin1(b.subarray(0, 1024)).replace(/^\u00ef\u00bb\u00bf/, "").trimStart().toLowerCase(); // after a UTF-8 byte order mark
  if (/^<(!doctype html|html|head|body|meta|script|title)\b/.test(head) || /^<\?xml[^>]*>\s*(<!doctype html|<html)/.test(head))
    return "This file is a web page saved with a .pdf name, not a PDF. That usually happens when the download link needed you to sign in or had expired: open the link in your browser and download the PDF again.";
  if (at([0x50, 0x4b, 0x03, 0x04])) {
    const names = latin1(b.subarray(0, Math.min(b.length, 1 << 21)));
    if (names.includes("word/")) return "This is a Word document saved with a .pdf name. Word to PDF turns it into a PDF.";
    if (names.includes("xl/")) return "This is an Excel workbook saved with a .pdf name. Excel to PDF turns it into a PDF.";
    if (names.includes("ppt/")) return "This is a PowerPoint presentation saved with a .pdf name. PowerPoint to PDF turns it into a PDF.";
    if (names.includes("application/epub+zip")) return "This is an EPUB ebook saved with a .pdf name. eBook (EPUB) to PDF turns it into a PDF.";
    return "This is a ZIP archive, not a PDF. Unzip it first: the PDF may be inside.";
  }
  if (at([0xff, 0xd8, 0xff])) return picture("JPG");
  if (at([0x89, 0x50, 0x4e, 0x47])) return picture("PNG");
  if (at([0x47, 0x49, 0x46, 0x38])) return picture("GIF");
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return picture("WebP");
  if (at([0x49, 0x49, 0x2a, 0x00]) || at([0x4d, 0x4d, 0x00, 0x2a])) return picture("TIFF");
  if (at([0x66, 0x74, 0x79, 0x70], 4) && /^(heic|heix|mif1|msf1|avif)/.test(latin1(b.subarray(8, 12)))) return picture("HEIC");
  if (at([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return "This is an older Office file (.doc, .xls or .ppt) saved with a .pdf name. Open it in Office or LibreOffice and save it as a PDF.";
  if (head.startsWith("%!ps")) return "This is a PostScript file, not a PDF. It needs a PostScript converter (such as Ghostscript) to become a PDF.";
  if (head.startsWith("{\\rtf")) return "This is a Rich Text (RTF) document, not a PDF. Open it in a word processor and save it as a PDF.";
  let printable = 0;
  const n = Math.min(b.length, 4096);
  for (let i = 0; i < n; i++) if ((b[i] >= 32 && b[i] < 127) || b[i] === 9 || b[i] === 10 || b[i] === 13 || b[i] >= 0xc2) printable++;
  if (printable >= n * 0.97) return "This file holds plain text, not a PDF. Text to PDF turns text into a PDF.";
  return "This file is not a PDF, and there is no PDF data in it to recover.";
}

/** Where the PDF data starts ("%PDF-"), looking past stray bytes such as mail headers; -1 when absent. */
function pdfStart(b: Uint8Array): number {
  const n = Math.min(b.length - 5, 1 << 16);
  for (let i = 0; i <= n; i++) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return i;
  return -1;
}

/** Where the file's last end marker ("%%EOF") ends; -1 when it has none. */
function lastEof(b: Uint8Array): number {
  for (let i = b.length - 5; i >= 0; i--) if (b[i] === 0x25 && b[i + 1] === 0x25 && b[i + 2] === 0x45 && b[i + 3] === 0x4f && b[i + 4] === 0x46) return i + 5;
  return -1;
}

/* --------------------------------------------------------------------- finding every object */

/** An object header "12 0 obj": the numbers, where it starts and where its body starts. */
type Header = { num: number; gen: number; at: number; body: number };

function scanHeaders(b: Uint8Array): Header[] {
  const out: Header[] = [];
  for (let i = 1; i + 2 < b.length; i++) {
    if (b[i] !== 0x6f || b[i + 1] !== 0x62 || b[i + 2] !== 0x6a) continue; // "obj"
    const after = b[i + 3];
    if (after !== undefined && !isWS(after) && !isDelim(after)) continue;
    let k = i - 1;
    if (!isWS(b[k])) continue; // "endobj", "xobj"…
    while (k >= 0 && isWS(b[k])) k--;
    const genEnd = k;
    while (k >= 0 && isDigit(b[k])) k--;
    if (k === genEnd || genEnd - k > 5 || k < 0 || !isWS(b[k])) continue;
    const gen = Number(latin1(b.subarray(k + 1, genEnd + 1)));
    while (k >= 0 && isWS(b[k])) k--;
    const numEnd = k;
    while (k >= 0 && isDigit(b[k])) k--;
    if (k === numEnd || numEnd - k > 10 || (k >= 0 && !isWS(b[k]) && !isDelim(b[k]))) continue;
    const num = Number(latin1(b.subarray(k + 1, numEnd + 1)));
    if (num > 0 && num < 1e8 && gen < 65536) out.push({ num, gen, at: k + 1, body: i + 3 });
  }
  return out;
}

/** "12 0 obj" at `at` (after any whitespace), as [num, gen]; null when there is none. */
function headerAt(b: Uint8Array, at: number): [number, number] | null {
  if (at < 0 || at >= b.length) return null;
  const s = latin1(b.subarray(at, Math.min(b.length, at + 40)));
  const m = /^\s*(\d+)\s+(\d+)\s+obj/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Whether the file's index (its cross-reference tables or streams) is there and points at each
 * object it lists: "ok", "wrong" (some entries point at the wrong place) or "missing" (no index
 * at the end of the file, as when it was cut short).
 */
function checkIndex(b: Uint8Array): "ok" | "wrong" | "missing" {
  const tail = latin1(b.subarray(Math.max(0, b.length - 2048)));
  const m = /startxref\s+(\d+)\s*(?:%%EOF)?\s*$/.exec(tail) ?? /startxref\s+(\d+)/.exec(tail.slice(tail.lastIndexOf("startxref")));
  if (!m) return "missing";
  let offset = Number(m[1]);
  const seen = new Set<number>();
  const scratch = PDFContext.create();
  let wrong = 0;
  let checked = 0;
  const check = (num: number, gen: number, off: number) => {
    checked++;
    const h = headerAt(b, off);
    if (!h || h[0] !== num || h[1] !== gen) wrong++;
  };
  for (let section = 0; section < 64; section++) {
    if (seen.has(offset) || offset <= 0 || offset >= b.length) return "wrong";
    seen.add(offset);
    const head = latin1(b.subarray(offset, Math.min(b.length, offset + 64)));
    let trailer: PDFDict | undefined;
    if (/^\s*xref/.test(head)) {
      // A table: subsections of "first count", then 20-byte entries.
      const text = latin1(b.subarray(offset, Math.min(b.length, offset + 64 + 20 * 2_000_000)));
      const end = text.indexOf("trailer");
      if (end < 0) return "wrong";
      const body = text.slice(text.indexOf("xref") + 4, end);
      const tok = body.trim().split(/\s+/);
      for (let i = 0; i + 1 < tok.length; ) {
        const first = Number(tok[i]);
        const count = Number(tok[i + 1]);
        if (!Number.isInteger(first) || !Number.isInteger(count)) return "wrong";
        i += 2;
        for (let k = 0; k < count; k++, i += 3) {
          if (i + 2 >= tok.length) return "wrong";
          if (tok[i + 2] === "n" && first + k > 0) check(first + k, Number(tok[i + 1]), Number(tok[i]));
        }
      }
      try {
        const t = PDFObjectParser.forBytes(b.subarray(offset + end + 7, Math.min(b.length, offset + end + 7 + 4096)), scratch).parseObject();
        if (t instanceof PDFDict) trailer = t;
      } catch {
        return "wrong";
      }
      const hybrid = numOf(trailer?.get(N("XRefStm")));
      if (hybrid !== undefined && !headerAt(b, hybrid)) wrong++;
    } else {
      // A cross-reference stream.
      const h = headerAt(b, offset);
      if (!h) return "wrong";
      let s: PDFObject;
      try {
        const bodyAt = offset + latin1(b.subarray(offset, offset + 40)).indexOf("obj") + 3;
        s = PDFObjectParser.forBytes(b.subarray(bodyAt), scratch).parseObject();
      } catch {
        return "wrong";
      }
      if (!(s instanceof PDFRawStream) || nameOf(s.dict.get(N("Type"))) !== "XRef") return "wrong";
      trailer = s.dict;
      const w = s.dict.get(N("W"));
      if (!(w instanceof PDFArray) || w.size() < 3) return "wrong";
      const W = [0, 1, 2].map((i) => numOf(w.get(i)) ?? 0);
      const size = numOf(s.dict.get(N("Size"))) ?? 0;
      const idx = s.dict.get(N("Index"));
      const ranges: number[] = idx instanceof PDFArray ? idx.asArray().map((x) => numOf(x) ?? 0) : [0, size];
      const data = decodeStream(s);
      if (!data.intact) return "wrong";
      const row = W[0] + W[1] + W[2];
      let at = 0;
      const field = (len: number, dflt: number) => {
        if (!len) return dflt;
        let v = 0;
        for (let i = 0; i < len; i++) v = v * 256 + data.bytes[at++];
        return v;
      };
      for (let r = 0; r + 1 < ranges.length; r += 2)
        for (let k = 0; k < ranges[r + 1]; k++) {
          if (at + row > data.bytes.length) return "wrong";
          const type = field(W[0], 1);
          const f2 = field(W[1], 0);
          const f3 = field(W[2], 0);
          if (type === 1 && ranges[r] + k > 0) check(ranges[r] + k, f3, f2);
        }
    }
    const prev = numOf(trailer?.get(N("Prev")));
    if (prev === undefined) break;
    offset = prev;
  }
  return wrong || !checked ? "wrong" : "ok";
}

/* ------------------------------------------------------------- decoding as far as it is good */

/**
 * A stream's data after its filters. `whole`: decoded to the end without an error. `intact`:
 * whole, and its checksum (where the format has one) agrees, so nothing in it was changed.
 * `damageAt`: when known, how far into the decoded data the damage starts.
 */
export type Decoded = { bytes: Uint8Array; whole: boolean; intact: boolean; damageAt?: number };

function adler32(b: Uint8Array): number {
  let a = 1;
  let s = 0;
  for (let i = 0; i < b.length; ) {
    const end = Math.min(b.length, i + 3800);
    for (; i < end; i++) {
      a += b[i];
      s += a;
    }
    a %= 65521;
    s %= 65521;
  }
  return ((s << 16) | a) >>> 0;
}

/** zlib/deflate data decoded as far as it is good. */
export function inflate(data: Uint8Array): Decoded {
  const zlib = data.length > 2 && (data[0] & 0x0f) === 8 && (data[0] >> 4) <= 7 && ((data[0] << 8) | data[1]) % 31 === 0;
  try {
    const out = zlib ? unzlibSync(data) : inflateSync(data);
    if (!zlib) return { bytes: out, whole: true, intact: true };
    // The checksum after the data; some writers leave a line end after it.
    const sum = adler32(out);
    let end = data.length;
    for (let tries = 0; tries < 3 && end >= 4; tries++) {
      const v = ((data[end - 4] << 24) | (data[end - 3] << 16) | (data[end - 2] << 8) | data[end - 1]) >>> 0;
      if (v === sum) return { bytes: out, whole: true, intact: true };
      if (!isWS(data[end - 1])) break;
      end--;
    }
  } catch {
    /* decode it carefully below */
  }
  // Feed it in small pieces until it fails: everything that came out before then is kept.
  const chunks: Uint8Array[] = [];
  let total = 0;
  const take = (d: Uint8Array) => {
    chunks.push(d);
    total += d.length;
  };
  const inf = zlib ? new Unzlib(take) : new Inflate(take);
  const STEP = 64;
  let whole = true;
  for (let i = 0; i < data.length; i += STEP) {
    try {
      inf.push(data.subarray(i, i + STEP), i + STEP >= data.length);
    } catch {
      whole = false;
      break;
    }
  }
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  // A run of zero (or 0xFF) bytes never appears in compressed data: that is where it was wiped,
  // and what comes out of the data before it is good.
  let damageAt: number | undefined;
  for (let i = 2, run = 0; i < data.length; i++) {
    run = (data[i] === 0 || data[i] === 0xff) && data[i] === data[i - 1] ? run + 1 : 0;
    if (run >= 15) {
      let good = 0;
      const head = zlib ? new Unzlib((d) => (good += d.length)) : new Inflate((d) => (good += d.length));
      try {
        head.push(data.subarray(0, i - run), false);
      } catch {
        /* what came out before the error is still good */
      }
      damageAt = Math.min(good, total);
      break;
    }
  }
  return { bytes, whole, intact: false, damageAt };
}

/** Undoes a PNG or TIFF predictor (DecodeParms /Predictor). */
export function unpredict(data: Uint8Array, parms: PDFDict | undefined): Uint8Array {
  const p = numOf(parms?.get(N("Predictor"))) ?? 1;
  if (p < 2) return data;
  const colors = numOf(parms?.get(N("Colors"))) ?? 1;
  const bpc = numOf(parms?.get(N("BitsPerComponent"))) ?? 8;
  const cols = numOf(parms?.get(N("Columns"))) ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((cols * colors * bpc) / 8);
  if (p === 2) {
    if (bpc !== 8) return data;
    const out = data.slice();
    for (let r = 0; r * rowLen < out.length; r++)
      for (let i = r * rowLen + colors; i < Math.min(out.length, (r + 1) * rowLen); i++) out[i] = (out[i] + out[i - colors]) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  const prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = r * (rowLen + 1) + 1;
    const row = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      let v = data[src + i];
      if (type === 1) v += a;
      else if (type === 2) v += up;
      else if (type === 3) v += (a + up) >> 1;
      else if (type === 4) {
        const q = a + up - ul;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - up);
        const pc = Math.abs(q - ul);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      }
      row[i] = v & 255;
    }
    prev.set(row);
  }
  return out;
}

const IMAGE_CODECS = new Set(["DCTDecode", "DCT", "JPXDecode", "CCITTFaxDecode", "CCF", "JBIG2Decode", "Crypt"]);
const SHORT: Record<string, string> = { Fl: "FlateDecode", LZW: "LZWDecode", A85: "ASCII85Decode", AHx: "ASCIIHexDecode", RL: "RunLengthDecode" };

/** The filters of a stream, in order, with their parameters. */
export function filtersOf(dict: PDFDict): { name: string; parms?: PDFDict }[] {
  const ctx = dict.context;
  const f = ctx.lookup(dict.get(N("Filter")));
  const p = ctx.lookup(dict.get(N("DecodeParms")) ?? dict.get(N("DP")));
  const names = f instanceof PDFArray ? f.asArray().map((x) => nameOf(ctx.lookup(x)) ?? "") : f instanceof PDFName ? [f.decodeText()] : [];
  return names.map((name, i) => {
    const parms = p instanceof PDFArray ? ctx.lookup(p.get(i)) : i === 0 ? p : undefined;
    return { name: SHORT[name] ?? name, parms: parms instanceof PDFDict ? parms : undefined };
  });
}

/**
 * A stream's data with its general-purpose filters undone, as far as it is good. Picture codecs
 * (JPEG and the like) are left for the picture's reader.
 */
export function decodeStream(s: PDFRawStream | PDFStream): Decoded {
  const d = decodeFilters(s);
  // A stream the file was cut short in is never whole (compressed data says so itself).
  return cutShort.has(s) && d.intact ? { ...d, whole: false, intact: false } : d;
}

/** Streams read with their end missing (see readObject). */
const cutShort = new WeakSet<PDFRawStream | PDFStream>();

function decodeFilters(s: PDFRawStream | PDFStream): Decoded {
  if (!(s instanceof PDFRawStream)) {
    try {
      return { bytes: s.getContents(), whole: true, intact: true };
    } catch {
      return { bytes: new Uint8Array(), whole: false, intact: false };
    }
  }
  let data = s.contents;
  let whole = true;
  let intact = true;
  let damageAt: number | undefined;
  for (const { name, parms } of filtersOf(s.dict)) {
    if (IMAGE_CODECS.has(name)) break;
    if (name === "FlateDecode") {
      const d = inflate(data);
      data = d.bytes;
      whole &&= d.whole;
      intact &&= d.intact;
      if (d.damageAt !== undefined) damageAt = d.damageAt;
    } else {
      try {
        const st = decodePDFRawStream(PDFRawStream.of(s.dict.context.obj({ Filter: N(name), ...(parms ? { DecodeParms: parms } : {}) }), data)) as unknown as {
          decode(): Uint8Array;
          buffer?: Uint8Array;
          bufferLength?: number;
        };
        try {
          data = st.decode();
        } catch {
          data = (st.buffer ?? new Uint8Array()).slice(0, st.bufferLength ?? 0);
          whole = intact = false;
        }
      } catch {
        return { bytes: new Uint8Array(), whole: false, intact: false };
      }
    }
    if (parms && (name === "FlateDecode" || name === "LZWDecode")) data = unpredict(data, parms);
  }
  return { bytes: data, whole, intact, damageAt: damageAt !== undefined && !whole ? Math.min(damageAt, data.length) : damageAt };
}

/* ---------------------------------------------------------------- reading objects carefully */

/** The last line of a region when it is a stray keyword ("endstream", "endobj", or what's left of one). */
function trimKeywords(b: Uint8Array, s: number, e: number): number {
  for (let pass = 0; pass < 3; pass++) {
    while (e > s && isWS(b[e - 1])) e--;
    let k = e;
    while (k > s && b[k - 1] >= 0x61 && b[k - 1] <= 0x7a) k--;
    if (e - k > 0 && e - k <= 9 && (k === s || isWS(b[k - 1])) && /^(e|en|end|ends|endst|endstr|endstre|endstrea|endstream|endo|endob|endobj|.ndstream|.ndobj)$/.test(latin1(b.subarray(k, e)))) e = k;
    else break;
  }
  if (e > s && b[e - 1] === 10) e--;
  if (e > s && b[e - 1] === 13) e--;
  return e;
}

/**
 * The object whose header is `h`, read from its body up to `end` (where the next object starts).
 * A stream whose end can't be found keeps the data up to there; `cut` says so.
 */
function readObject(b: Uint8Array, h: Header, end: number, ctx: PDFContext): { obj: PDFObject; cut: boolean } | null {
  const body = b.subarray(h.body, end);
  const ref = PDFRef.of(h.num, h.gen);
  try {
    return { obj: PDFObjectParser.forBytes(body, ctx).parseObject(ref), cut: false };
  } catch {
    /* most often a stream whose end is missing */
  }
  const text = latin1(body.subarray(0, Math.min(body.length, 1 << 16)));
  const kw = /(?<!end)stream(\r\n|\r|\n)/.exec(text);
  if (!kw) return null;
  let dict: PDFObject;
  try {
    dict = PDFObjectParser.forBytes(body.subarray(0, kw.index), ctx).parseObject(ref);
  } catch {
    return null;
  }
  if (!(dict instanceof PDFDict)) return null;
  const s = kw.index + kw[0].length;
  const len = ctx.lookup(dict.get(N("Length")));
  const L = len instanceof PDFNumber ? len.asNumber() : -1;
  const e = L >= 0 && s + L <= body.length ? s + L : trimKeywords(body, s, body.length);
  const stream = PDFRawStream.of(dict, body.slice(s, Math.max(s, e)));
  // Cut short: the file ends inside it, or it is shorter than its stated length.
  const cut = end >= b.length || (L >= 0 && s + L > body.length);
  if (cut) cutShort.add(stream);
  return { obj: stream, cut };
}

/** Objects packed in an object stream, read one by one so a damaged one doesn't take the rest. */
function readObjectStream(stm: PDFRawStream, ctx: PDFContext, wanted: (ref: PDFRef) => boolean): number {
  const n = numOf(ctx.lookup(stm.dict.get(N("N")))) ?? 0;
  const first = numOf(ctx.lookup(stm.dict.get(N("First")))) ?? 0;
  const { bytes } = decodeStream(stm);
  if (!n || first <= 0 || first > bytes.length) return 0;
  const head = latin1(bytes.subarray(0, first)).trim().split(/\s+/).map(Number);
  let got = 0;
  for (let k = 0; k < n && 2 * k + 1 < head.length; k++) {
    const num = head[2 * k];
    const at = first + head[2 * k + 1];
    const end = 2 * k + 3 < head.length ? first + head[2 * k + 3] : bytes.length;
    if (!Number.isInteger(num) || at >= bytes.length || end <= at) continue;
    const ref = PDFRef.of(num, 0);
    if (!wanted(ref)) continue;
    try {
      ctx.assign(ref, PDFObjectParser.forBytes(bytes.subarray(at, Math.min(end, bytes.length)), ctx).parseObject(ref));
      got++;
    } catch {
      /* this one is lost */
    }
  }
  return got;
}

/**
 * Reads again every object the normal reader lost or gave up on, each from its own header and
 * bounded by the next one, so a damaged object can't swallow its neighbours. Returns how many
 * objects were recovered.
 */
function recoverObjects(b: Uint8Array, ctx: PDFContext, headers: Header[]): number {
  const missing = (ref: PDFRef) => {
    const o = ctx.lookup(ref);
    return o === undefined || o instanceof PDFInvalidObject;
  };
  let got = 0;
  // Objects read here; a later copy of one (an incremental update) replaces the earlier when it reads.
  const mine = new Set<PDFRef>();
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const ref = PDFRef.of(h.num, h.gen);
    if (!missing(ref) && !mine.has(ref)) continue;
    const r = readObject(b, h, i + 1 < headers.length ? headers[i + 1].at : b.length, ctx);
    if (!r) continue;
    ctx.assign(ref, r.obj);
    if (!mine.has(ref)) got++;
    mine.add(ref);
    if (r.obj instanceof PDFRawStream && nameOf(r.obj.dict.get(N("Type"))) === "ObjStm") got += readObjectStream(r.obj, ctx, missing);
  }
  // Object streams the normal reader kept but couldn't unpack.
  for (const [, o] of ctx.enumerateIndirectObjects())
    if (o instanceof PDFRawStream && nameOf(o.dict.get(N("Type"))) === "ObjStm") got += readObjectStream(o, ctx, missing);
  return got;
}

/* ------------------------------------------------------------------ catalog and page list */

const isDict = (o: unknown): o is PDFDict => o instanceof PDFDict;
const typeIs = (o: unknown, t: string) => isDict(o) && nameOf(o.get(N("Type"))) === t;
const isPageNode = (o: unknown): o is PDFDict => typeIs(o, "Page");
const isPagesNode = (o: unknown): o is PDFDict => typeIs(o, "Pages") || (isDict(o) && !o.has(N("Type")) && o.get(N("Kids")) !== undefined && o.get(N("Count")) !== undefined);

/** The document catalog, found or made anew. */
function ensureCatalog(ctx: PDFContext, damage: Damage): PDFDict {
  const cur = ctx.lookup(ctx.trailerInfo.Root);
  if (typeIs(cur, "Catalog")) return cur as PDFDict;
  let best: [PDFRef, PDFDict] | undefined;
  for (const [ref, o] of ctx.enumerateIndirectObjects()) if (typeIs(o, "Catalog")) best = [ref, o as PDFDict];
  if (best) {
    ctx.trailerInfo.Root = best[0];
    return best[1];
  }
  const cat = PDFCatalog.fromMapWithContext(new Map([[N("Type"), N("Catalog")]]), ctx);
  ctx.trailerInfo.Root = ctx.register(cat);
  damage.fix("Rebuilt the document's lost catalog.");
  // An outline or a form nothing points to any more belongs to it.
  const loose = (t: (o: PDFDict) => boolean) => {
    const found = ctx.enumerateIndirectObjects().filter(([, o]) => isDict(o) && t(o as PDFDict));
    return found.length === 1 ? found[0][0] : undefined;
  };
  const outlines = loose((o) => typeIs(o, "Outlines"));
  if (outlines) cat.set(N("Outlines"), outlines);
  const form = loose((o) => !o.has(N("Type")) && ctx.lookup(o.get(N("Fields"))) instanceof PDFArray);
  if (form) cat.set(N("AcroForm"), form);
  return cat;
}

/** The document information (title, author), found again when the file's end with its pointer is lost. */
function ensureInfo(ctx: PDFContext) {
  if (isDict(ctx.lookup(ctx.trailerInfo.Info))) return;
  const keys = ["Producer", "Creator", "CreationDate", "ModDate", "Title", "Author"];
  let found: PDFRef | undefined;
  for (const [ref, o] of ctx.enumerateIndirectObjects())
    if (isDict(o) && !o.has(N("Type")) && keys.filter((k) => o.has(N(k))).length >= 2 && !o.has(N("Kids")) && !o.has(N("Font"))) found = ref;
  ctx.trailerInfo.Info = found;
}

const INHERITED = ["Resources", "MediaBox", "CropBox", "Rotate"];

/**
 * Checks the page list against the pages in the file and rebuilds it when it is damaged: pages a
 * lost branch of the list pointed to are found by their own records and put back in file order,
 * and pages that are gone for good keep their place as blank pages (so page numbers still match).
 */
function rebuildPageList(ctx: PDFContext, catalog: PDFDict, damage: Damage) {
  type Slot = { page: PDFRef } | { lost?: PDFRef; count: number };
  const slots: Slot[] = [];
  const reached = new Set<PDFRef>();
  const nodes = new Set<PDFDict>();
  const rootRef = catalog.get(N("Pages"));
  const root = ctx.lookup(rootRef);
  let damaged = !(root instanceof PDFPageTree);
  const walk = (node: PDFDict, depth: number) => {
    if (depth > 64 || nodes.has(node)) {
      damaged = true;
      return;
    }
    nodes.add(node);
    if (!(node instanceof PDFPageTree)) damaged = true;
    const kids = ctx.lookup(node.get(N("Kids")));
    const want = numOf(ctx.lookup(node.get(N("Count"))));
    if (!(kids instanceof PDFArray)) {
      damaged = true;
      slots.push({ count: Math.max(1, want ?? 1) });
      return;
    }
    const start = slots.length;
    const lostAt: number[] = [];
    for (const k of kids.asArray()) {
      const d = ctx.lookup(k);
      if (isPageNode(d) && k instanceof PDFRef) {
        if (!(d instanceof PDFPageLeaf)) damaged = true;
        if (reached.has(k)) damaged = true;
        else {
          reached.add(k);
          slots.push({ page: k });
        }
      } else if (isPagesNode(d)) walk(d, depth + 1);
      else {
        damaged = true;
        lostAt.push(slots.length);
        slots.push({ lost: k instanceof PDFRef ? k : undefined, count: 1 });
      }
    }
    const counted = slots.slice(start).reduce((n, s) => n + ("page" in s ? 1 : s.count), 0);
    if (want !== undefined && want > counted && lostAt.length) (slots[lostAt[lostAt.length - 1]] as { count: number }).count += want - counted;
  };
  if (isPagesNode(root)) walk(root, 0);

  // Pages the list doesn't reach. One whose parent is part of the intact list was left behind by
  // an edit (an older version of a page); the rest were lost with a damaged branch.
  const strays = ctx
    .enumerateIndirectObjects()
    .filter(([ref, o]) => isPageNode(o) && !reached.has(ref))
    .filter(([, o]) => {
      const p = ctx.lookup((o as PDFDict).get(N("Parent")));
      return !(isDict(p) && nodes.has(p));
    })
    .map(([ref]) => ref);
  if (!damaged && !strays.length) return;

  // Strays fill the lost branch they belonged to, if the list still names it, in file order.
  const parentOf = (ref: PDFRef) => (ctx.lookup(ref) as PDFDict).get(N("Parent"));
  const pool = new Set(strays);
  const out: Slot[] = [];
  for (const s of slots) {
    if ("page" in s || !s.lost) {
      out.push(s);
      continue;
    }
    const mine = [...pool].filter((r) => parentOf(r) === s.lost).sort((a, b) => a.objectNumber - b.objectNumber);
    if (mine.length) {
      for (const r of mine) {
        pool.delete(r);
        out.push({ page: r });
      }
    } else out.push(s);
  }
  // The rest go where their place in the file puts them.
  const rest = [...pool].sort((a, b) => a.objectNumber - b.objectNumber);
  const listed = out.filter((s): s is { page: PDFRef } => "page" in s).map((s) => s.page.objectNumber);
  const inOrder = listed.every((n, i) => i === 0 || n > listed[i - 1]);
  for (const r of rest) {
    let at = out.length;
    if (inOrder) {
      const k = out.findIndex((s) => "page" in s && s.page.objectNumber > r.objectNumber);
      if (k >= 0) at = k;
    }
    out.splice(at, 0, { page: r });
  }

  // Each page carries what it inherited from the old list's branches before it is re-hung.
  const inherited = (page: PDFDict, key: string): PDFObject | undefined => {
    let node: PDFDict | undefined = page;
    for (let d = 0; node && d < 64; d++) {
      const v = node.get(N(key));
      if (v !== undefined) return v;
      const p: PDFObject | undefined = ctx.lookup(node.get(N("Parent")));
      node = isDict(p) ? p : undefined;
    }
    return undefined;
  };
  const pages = out.filter((s): s is { page: PDFRef } => "page" in s).map((s) => ctx.lookup(s.page) as PDFDict);
  const boxes = new Map<string, number>();
  const keep = new Map<PDFDict, Map<string, PDFObject>>();
  for (const p of pages) {
    const m = new Map<string, PDFObject>();
    for (const k of INHERITED) {
      const v = inherited(p, k);
      if (v !== undefined) m.set(k, v);
    }
    keep.set(p, m);
    const mb = m.get("MediaBox");
    if (mb) boxes.set(String(ctx.lookup(mb)), (boxes.get(String(ctx.lookup(mb))) ?? 0) + 1);
  }
  const common = [...boxes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const box = (): PDFObject => {
    const nums = common?.match(/-?[\d.]+/g)?.map(Number);
    return ctx.obj(nums?.length === 4 ? nums : [0, 0, 595.28, 841.89]);
  };
  const newRoot = PDFPageTree.withContext(ctx);
  const newRootRef = ctx.register(newRoot);
  const kids: PDFRef[] = [];
  let blanks = 0;
  for (const s of out) {
    if ("page" in s) {
      let p = ctx.lookup(s.page) as PDFDict;
      const inherit = keep.get(p)!;
      if (!(p instanceof PDFPageLeaf)) {
        p = PDFPageLeaf.fromMapWithContext(new Map(p.entries()), ctx, false);
        ctx.assign(s.page, p);
      }
      for (const [k, v] of inherit) p.set(N(k), v);
      if (!p.has(N("MediaBox"))) p.set(N("MediaBox"), box());
      if (!p.has(N("Resources"))) p.set(N("Resources"), ctx.obj({}));
      p.set(N("Parent"), newRootRef);
      kids.push(s.page);
    } else
      for (let i = 0; i < s.count; i++) {
        damage.at("blank", kids.length);
        const blank = PDFPageLeaf.withContextAndParent(ctx, newRootRef);
        blank.set(N("MediaBox"), box());
        kids.push(ctx.register(blank));
        blanks++;
      }
  }
  newRoot.set(N("Kids"), ctx.obj(kids));
  newRoot.set(N("Count"), PDFNumber.of(kids.length));
  catalog.set(N("Pages"), newRootRef);
  const found = kids.length - blanks - reached.size;
  if (!isPagesNode(root)) damage.fix("Rebuilt the document's lost list of pages.");
  else if (found > 0) damage.fix(`Found ${found} page${found === 1 ? "" : "s"} missing from the document's list of pages.`);
  else damage.fix("Rebuilt the document's damaged list of pages.");
}

/* ------------------------------------------------------------------------- lost fonts */

/** The advance widths (thousandths of an em) of codes 0 to `last` in a TrueType program, by the font's own character map. */
function programWidths(ctx: PDFContext, desc: PDFDict, symbolic: boolean, last: number): number[] | undefined {
  const file = ctx.lookup(desc.get(N("FontFile2")));
  if (!(file instanceof PDFRawStream)) return undefined;
  const d = decodeStream(file);
  if (!d.intact) return undefined;
  type G = { id: number; advanceWidth: number };
  let f: { unitsPerEm: number; glyphForCodePoint(c: number): G | null };
  try {
    f = fontkit.create(d.bytes) as unknown as typeof f;
  } catch {
    return undefined;
  }
  const scale = 1000 / f.unitsPerEm;
  const win = winAnsi().byCode;
  const out: number[] = [];
  for (let c = 0; c <= last; c++) {
    let g: G | null = null;
    try {
      if (symbolic) {
        g = f.glyphForCodePoint(c);
        if (!g?.id) g = f.glyphForCodePoint(0xf000 + c);
      } else {
        const u = unicodeOf(win.get(c) ?? "");
        g = u === undefined ? null : f.glyphForCodePoint(u);
      }
    } catch {
      g = null;
    }
    out.push(g?.id ? Math.round(g.advanceWidth * scale) : 0);
  }
  return out;
}

/** A lost font put back together from its surviving parts, not yet put in place (see lostFonts). */
export type Kit = { font: PDFDict; simple: boolean; codes?: Set<number> };

/**
 * Fonts whose object is gone while their parts survive (the program, its description, its
 * character map), each put back together from them when there is no doubt which parts are its:
 * the only lost font with the only stray set of parts, or parts stored right next to it (as most
 * writers store them). They are offered, not put in place: whoever reads the text drawn with a
 * font checks first that its codes fit (see repair).
 */
export function lostFonts(ctx: PDFContext): Map<PDFRef, Kit> {
  const pointed = new Set<PDFRef>();
  const lost = new Set<PDFRef>();
  const seen = new Set<unknown>();
  const visit = (o: unknown) => {
    if (o instanceof PDFRef) {
      pointed.add(o);
      return;
    }
    if (seen.has(o)) return;
    if (o instanceof PDFRawStream || o instanceof PDFStream) {
      seen.add(o);
      visit(o.dict);
    } else if (o instanceof PDFDict) {
      seen.add(o);
      for (const [k, v] of o.entries()) {
        // A resource list of fonts: the fonts it names that are gone.
        const list = k.decodeText() === "Font" ? (v instanceof PDFRef ? ctx.lookup(v) : v) : undefined;
        if (list instanceof PDFDict && !typeIs(list, "Font"))
          for (const [, f] of list.entries()) {
            const t = f instanceof PDFRef ? ctx.lookup(f) : f;
            if (f instanceof PDFRef && (t === undefined || t instanceof PDFInvalidObject)) lost.add(f);
          }
        visit(v);
      }
    } else if (o instanceof PDFArray) for (const v of o.asArray()) visit(v);
  };
  const out = new Map<PDFRef, Kit>();
  for (const [, o] of ctx.enumerateIndirectObjects()) visit(o);
  if (!lost.size) return out;
  const strays = ctx.enumerateIndirectObjects().filter(([ref]) => !pointed.has(ref));
  const kits = strays.filter(([, o]) => isDict(o) && (typeIs(o, "FontDescriptor") || (typeIs(o, "Font") && /^CIDFontType[02]$/.test(nameOf(o.get(N("Subtype"))) ?? ""))));
  const maps = strays.filter(([, o]) => {
    if (!(o instanceof PDFRawStream) || o.dict.has(N("Subtype")) || o.dict.has(N("Type"))) return false;
    const t = latin1(decodeStream(o).bytes.subarray(0, 4096));
    return /begincmap/.test(t) && /beginbf(char|range)/.test(t);
  });
  const near = <T>(list: [PDFRef, T][], ref: PDFRef) => {
    const close = list.filter(([r]) => Math.abs(r.objectNumber - ref.objectNumber) <= 3);
    return close.length === 1 ? close[0] : list.length === 1 && lost.size === 1 ? list[0] : undefined;
  };
  for (const ref of lost) {
    const kit = near(kits, ref);
    if (!kit) continue;
    const map = near(maps, ref);
    const [kitRef, k] = kit as [PDFRef, PDFDict];
    if (typeIs(k, "Font")) {
      // A composite font's descendant: the composite around it, with the usual identity encoding.
      out.set(ref, { font: ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: k.get(N("BaseFont")) ?? N("Font"), Encoding: "Identity-H", DescendantFonts: [kitRef], ...(map ? { ToUnicode: map[0] } : {}) }), simple: false });
    } else {
      const file = k.has(N("FontFile2")) ? "TrueType" : "Type1";
      const symbolic = ((numOf(ctx.lookup(k.get(N("Flags")))) ?? 0) & 4) !== 0;
      const font = ctx.obj({ Type: "Font", Subtype: file, BaseFont: k.get(N("FontName")) ?? N("Font"), FontDescriptor: kitRef, ...(symbolic ? {} : { Encoding: "WinAnsiEncoding" }), ...(map ? { ToUnicode: map[0] } : {}) });
      // The widths went with the font object: they are read back from its program.
      const codes = map ? [...latin1(decodeStream(map[1] as PDFRawStream).bytes).matchAll(/<([0-9a-fA-F]{2,4})>/g)].map((m) => parseInt(m[1], 16)).filter((c) => c < 256) : [];
      const widths = programWidths(ctx, k, symbolic, codes.length ? Math.max(...codes) : 255);
      if (widths) {
        font.set(N("FirstChar"), PDFNumber.of(0));
        font.set(N("LastChar"), PDFNumber.of(widths.length - 1));
        font.set(N("Widths"), ctx.obj(widths));
      }
      out.set(ref, { font, simple: true, ...(codes.length ? { codes: new Set(codes) } : {}) });
    }
    kits.splice(kits.indexOf(kit), 1);
    if (map) maps.splice(maps.indexOf(map), 1);
  }
  return out;
}

/* ------------------------------------------------------------------ dangling references */

/** Array entries that are lists of things, where a lost entry is dropped rather than left empty. */
const LISTS = new Set(["Kids", "Annots", "Fields", "Contents", "DescendantFonts", "Order", "OCGs", "ON", "OFF", "Locked", "RBGroups", "B", "Names", "Nums", "AF", "Outputintents", "OutputIntents"]);

/**
 * Takes out references to objects that are gone (pointers a strict reader stops at): a lost
 * entry of a list is dropped, a lost value in a dictionary is removed, any other lost item
 * becomes null. Returns how many were taken out.
 */
export function dropDangling(ctx: PDFContext): number {
  for (const [ref, o] of ctx.enumerateIndirectObjects()) if (o instanceof PDFInvalidObject) ctx.delete(ref);
  const gone = (v: unknown) => v instanceof PDFRef && ctx.lookup(v) === undefined;
  let n = 0;
  const seen = new Set<unknown>();
  const visit = (o: unknown, key: string) => {
    if (o === undefined || seen.has(o)) return;
    if (o instanceof PDFRef) {
      seen.add(o);
      visit(ctx.lookup(o), key);
      return;
    }
    if (o instanceof PDFRawStream || o instanceof PDFStream) {
      seen.add(o);
      visit(o.dict, key);
      return;
    }
    if (o instanceof PDFDict) {
      seen.add(o);
      for (const [k, v] of o.entries()) {
        if (gone(v)) {
          o.delete(k);
          n++;
        } else visit(v, k.decodeText());
      }
    } else if (o instanceof PDFArray) {
      seen.add(o);
      for (let i = o.size() - 1; i >= 0; i--) {
        const v = o.get(i);
        if (gone(v)) {
          if (LISTS.has(key)) o.remove(i);
          else o.set(i, PDFNull);
          n++;
        } else visit(v, key);
      }
    }
  };
  visit(ctx.trailerInfo.Root, "Root");
  visit(ctx.trailerInfo.Info, "Info");
  return n;
}

/* ------------------------------------------------------------------------------ the reader */

function docOf(ctx: PDFContext): PDFDocument {
  // pdf-lib makes documents only from bytes; this one is put together from recovered objects.
  const Make = PDFDocument as unknown as new (context: PDFContext, ignoreEncryption: boolean, updateMetadata: boolean) => PDFDocument;
  return new Make(ctx, true, false);
}

/**
 * Reads a PDF however damaged it is, and says in `damage` what was wrong with its structure.
 * Throws (with a plain explanation) only when there is no PDF in the file at all.
 */
export async function readDamaged(src: Uint8Array, opts: { password?: string; name: string }, damage: Damage): Promise<{ doc: PDFDocument; kits: Map<PDFRef, Kit> }> {
  const start = pdfStart(src);
  let b = start > 0 ? src.subarray(start) : src;
  // Stray data after the file's last end marker (an object there is an unfinished update, kept).
  const eof = lastEof(b);
  let after = false;
  if (eof > 0 && eof < b.length) {
    const rest = b.subarray(eof);
    let ink = 0;
    for (let i = 0; i < rest.length && ink <= 64; i++) if (!isWS(rest[i])) ink++;
    if (ink > 64 && !scanHeaders(rest).length) {
      b = b.subarray(0, eof);
      after = true;
    }
  }
  const headers = scanHeaders(b);
  if (start < 0 && !headers.length) throw new Error(notPdf(src));
  if (start > 0) damage.fix("Removed stray data in front of the PDF.");
  else if (start < 0) damage.fix("Rebuilt the file's missing PDF header.");
  if (after) damage.fix("Removed stray data after the end of the PDF.");
  const index = checkIndex(eof > 0 && eof < b.length ? b.subarray(0, eof) : b);
  if (index === "missing") damage.fix("The end of the file was missing, so its index was rebuilt.");
  else if (index === "wrong") damage.fix("Rebuilt the file's broken index.");

  let ctx: PDFContext | undefined;
  try {
    ctx = await PDFParser.forBytesWithOptions(b, 500, false, false, false).parseDocument();
  } catch {
    ctx = undefined;
  }
  const encrypted = ctx ? !!ctx.lookup(ctx.trailerInfo.Encrypt) : /\/Encrypt\s+\d+\s+\d+\s+R/.test(latin1(b.subarray(Math.max(0, b.length - 8192))));
  if (encrypted) {
    // Encrypted: read the normal way, which decrypts (objects are not recovered one by one).
    const doc = await loadPdf(b, { password: opts.password, name: opts.name });
    rebuildPageList(doc.context, doc.catalog, damage);
    damage.fix("The repaired copy is not password-protected.");
    return { doc, kits: new Map() };
  }
  ctx ??= PDFContext.create();
  // Protection details with nothing pointing to them: the file is encrypted, but what says so is lost.
  if (ctx.enumerateIndirectObjects().some(([, o]) => isDict(o) && nameOf(o.get(N("Filter"))) === "Standard" && o.has(N("O")) && o.has(N("U"))))
    throw new Error("This file is password-protected, and the part of it that holds its protection details is damaged, so its contents can't be read.");
  const got = recoverObjects(b, ctx, headers);
  if (got && index === "ok" && start >= 0) damage.fix("Repaired damaged parts of the file's structure.");
  const catalog = ensureCatalog(ctx, damage);
  ensureInfo(ctx);
  rebuildPageList(ctx, catalog, damage);
  return { doc: docOf(ctx), kits: lostFonts(ctx) };
}
