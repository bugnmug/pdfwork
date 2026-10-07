/**
 * PDF functions (sampled, exponential, stitching and PostScript calculator), evaluated, and
 * sampled ones written: what colour conversions need to turn a gradient's or a spot colour's
 * function into one that gives grey.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext } from "@cantoo/pdf-lib";
import { streamBytes } from "./contentstream";

export type Fn = (input: number[]) => number[];

const look = (ctx: PDFContext, o: unknown) => (o instanceof PDFRef ? ctx.lookup(o) : o);
const nums = (ctx: PDFContext, o: unknown): number[] | undefined => {
  const a = look(ctx, o);
  return a instanceof PDFArray ? a.asArray().map((v) => (look(ctx, v) instanceof PDFNumber ? (look(ctx, v) as PDFNumber).asNumber() : 0)) : undefined;
};
const clip = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A function object as something to call; null when it can't be read. */
export function readFunction(ctx: PDFContext, raw: unknown, depth = 0): Fn | null {
  if (depth > 8) return null;
  const obj = look(ctx, raw);
  // An array of functions: one output each.
  if (obj instanceof PDFArray) {
    const fs = obj.asArray().map((f) => readFunction(ctx, f, depth + 1));
    if (fs.some((f) => !f)) return null;
    return (x) => fs.flatMap((f) => f!(x));
  }
  const dict = obj instanceof PDFDict ? obj : obj instanceof PDFRawStream || obj instanceof PDFStream ? obj.dict : null;
  if (!dict) return null;
  const get = (k: string) => dict.get(PDFName.of(k));
  const type = (look(ctx, get("FunctionType")) as PDFNumber | undefined)?.asNumber?.();
  const domain = nums(ctx, get("Domain")) ?? [0, 1];
  const range = nums(ctx, get("Range"));
  const clipIn = (x: number[]) => x.map((v, i) => clip(v, domain[i * 2] ?? 0, domain[i * 2 + 1] ?? 1));
  const clipOut = (y: number[]) => (range ? y.map((v, i) => clip(v, range[i * 2] ?? -Infinity, range[i * 2 + 1] ?? Infinity)) : y);
  if (type === 2) {
    const c0 = nums(ctx, get("C0")) ?? [0];
    const c1 = nums(ctx, get("C1")) ?? [1];
    const n = (look(ctx, get("N")) as PDFNumber | undefined)?.asNumber?.() ?? 1;
    return (x) => {
      const t = clipIn(x)[0];
      const p = n === 1 ? t : Math.pow(t, n);
      return clipOut(c0.map((a, i) => a + p * ((c1[i] ?? 0) - a)));
    };
  }
  if (type === 3) {
    const fs = (look(ctx, get("Functions")) as PDFArray | undefined)?.asArray().map((f) => readFunction(ctx, f, depth + 1)) ?? [];
    if (!fs.length || fs.some((f) => !f)) return null;
    const bounds = nums(ctx, get("Bounds")) ?? [];
    const encode = nums(ctx, get("Encode")) ?? fs.flatMap(() => [0, 1]);
    return (x) => {
      const t = clipIn(x)[0];
      let k = 0;
      while (k < bounds.length && t >= bounds[k]) k++;
      const lo = k === 0 ? domain[0] : bounds[k - 1];
      const hi = k === bounds.length ? domain[1] : bounds[k];
      const e0 = encode[k * 2] ?? 0;
      const e1 = encode[k * 2 + 1] ?? 1;
      const u = hi === lo ? e0 : e0 + ((t - lo) * (e1 - e0)) / (hi - lo);
      return clipOut(fs[k]!([u]));
    };
  }
  if (type === 0) {
    if (!(obj instanceof PDFRawStream || obj instanceof PDFStream) || !range) return null;
    const size = nums(ctx, get("Size")) ?? [];
    const bps = (look(ctx, get("BitsPerSample")) as PDFNumber | undefined)?.asNumber?.() ?? 8;
    const m = size.length;
    const nOut = range.length / 2;
    if (!m || m > 6) return null;
    const encode = nums(ctx, get("Encode")) ?? size.flatMap((s) => [0, s - 1]);
    const decode = nums(ctx, get("Decode")) ?? range;
    let bytes: Uint8Array;
    try {
      bytes = streamBytes(ctx, obj);
    } catch {
      return null;
    }
    const max = Math.pow(2, bps) - 1;
    const sample = (index: number, j: number) => {
      const bit = (index * nOut + j) * bps;
      let v = 0;
      for (let b = 0; b < bps; b++) {
        const at = bit + b;
        v = v * 2 + ((bytes[at >> 3] >> (7 - (at & 7))) & 1);
      }
      return v;
    };
    return (x) => {
      const t = clipIn(x);
      // Each input mapped to the sample grid, then multilinear interpolation.
      const pos = t.map((v, i) => {
        const d0 = domain[i * 2];
        const d1 = domain[i * 2 + 1];
        const e = encode[i * 2] + ((v - d0) * (encode[i * 2 + 1] - encode[i * 2])) / (d1 - d0 || 1);
        return clip(e, 0, size[i] - 1);
      });
      const out = new Array(nOut).fill(0);
      const corners = 1 << m;
      for (let c = 0; c < corners; c++) {
        let w = 1;
        let index = 0;
        let stride = 1;
        for (let i = 0; i < m; i++) {
          const lo = Math.floor(pos[i]);
          const hi = Math.min(size[i] - 1, lo + 1);
          const f = pos[i] - lo;
          const useHi = (c >> i) & 1;
          w *= useHi ? f : 1 - f;
          index += (useHi ? hi : lo) * stride;
          stride *= size[i];
        }
        if (!w) continue;
        for (let j = 0; j < nOut; j++) out[j] += w * sample(index, j);
      }
      return clipOut(out.map((v, j) => decode[j * 2] + (v * (decode[j * 2 + 1] - decode[j * 2])) / max));
    };
  }
  if (type === 4) {
    if (!(obj instanceof PDFRawStream || obj instanceof PDFStream) || !range) return null;
    let code: string;
    try {
      code = new TextDecoder("latin1").decode(streamBytes(ctx, obj));
    } catch {
      return null;
    }
    const program = parsePostScript(code);
    if (!program) return null;
    return (x) => {
      const stack: (number | boolean)[] = [...clipIn(x)];
      if (!runPostScript(program, stack)) return range.filter((_, i) => i % 2 === 0);
      const outs = stack.slice(-range.length / 2).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));
      return clipOut(outs);
    };
  }
  return null;
}

type Ps = (string | number | Ps)[];

function parsePostScript(code: string): Ps | null {
  const toks = code.match(/[{}]|[^\s{}]+/g) ?? [];
  let i = 0;
  const block = (): Ps | null => {
    const out: Ps = [];
    while (i < toks.length) {
      const t = toks[i++];
      if (t === "{") {
        const b = block();
        if (!b) return null;
        out.push(b);
      } else if (t === "}") return out;
      else if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) out.push(Number(t));
      else out.push(t);
    }
    return out;
  };
  while (i < toks.length && toks[i] !== "{") i++;
  i++;
  return block();
}

function runPostScript(prog: Ps, s: (number | boolean)[], depth = 0): boolean {
  if (depth > 50) return false;
  const n = () => Number(s.pop());
  for (let k = 0; k < prog.length; k++) {
    const op = prog[k];
    if (typeof op === "number") {
      s.push(op);
      continue;
    }
    if (Array.isArray(op)) {
      // A procedure: run by the "if"/"ifelse" that follows it.
      const next = prog[k + 1];
      const next2 = prog[k + 2];
      if (next === "if") {
        if (s.pop()) if (!runPostScript(op, s, depth + 1)) return false;
        k += 1;
      } else if (Array.isArray(next) && next2 === "ifelse") {
        if (!runPostScript(s.pop() ? op : next, s, depth + 1)) return false;
        k += 2;
      } else return false;
      continue;
    }
    switch (op) {
      case "add": { const b = n(); s.push(n() + b); break; }
      case "sub": { const b = n(); s.push(n() - b); break; }
      case "mul": { const b = n(); s.push(n() * b); break; }
      case "div": { const b = n(); s.push(n() / b); break; }
      case "idiv": { const b = n(); s.push(Math.trunc(n() / b)); break; }
      case "mod": { const b = n(); s.push(n() % b); break; }
      case "neg": s.push(-n()); break;
      case "abs": s.push(Math.abs(n())); break;
      case "ceiling": s.push(Math.ceil(n())); break;
      case "floor": s.push(Math.floor(n())); break;
      case "round": s.push(Math.round(n())); break;
      case "truncate": case "cvi": s.push(Math.trunc(n())); break;
      case "cvr": s.push(n()); break;
      case "sqrt": s.push(Math.sqrt(n())); break;
      case "sin": s.push(Math.sin((n() * Math.PI) / 180)); break;
      case "cos": s.push(Math.cos((n() * Math.PI) / 180)); break;
      case "atan": { const b = n(); const a = n(); let d = (Math.atan2(a, b) * 180) / Math.PI; if (d < 0) d += 360; s.push(d); break; }
      case "exp": { const e = n(); s.push(Math.pow(n(), e)); break; }
      case "ln": s.push(Math.log(n())); break;
      case "log": s.push(Math.log10(n())); break;
      case "eq": { const b = s.pop(); s.push(s.pop() === b); break; }
      case "ne": { const b = s.pop(); s.push(s.pop() !== b); break; }
      case "gt": { const b = n(); s.push(n() > b); break; }
      case "ge": { const b = n(); s.push(n() >= b); break; }
      case "lt": { const b = n(); s.push(n() < b); break; }
      case "le": { const b = n(); s.push(n() <= b); break; }
      case "and": { const b = s.pop(); const a = s.pop(); s.push(typeof a === "boolean" ? a && !!b : (a as number) & (b as number)); break; }
      case "or": { const b = s.pop(); const a = s.pop(); s.push(typeof a === "boolean" ? a || !!b : (a as number) | (b as number)); break; }
      case "xor": { const b = s.pop(); const a = s.pop(); s.push(typeof a === "boolean" ? a !== !!b : (a as number) ^ (b as number)); break; }
      case "not": { const a = s.pop(); s.push(typeof a === "boolean" ? !a : ~(a as number)); break; }
      case "bitshift": { const b = n(); const a = n(); s.push(b >= 0 ? a << b : a >> -b); break; }
      case "true": s.push(true); break;
      case "false": s.push(false); break;
      case "pop": s.pop(); break;
      case "exch": { const b = s.pop()!; const a = s.pop()!; s.push(b, a); break; }
      case "dup": s.push(s[s.length - 1]); break;
      case "copy": { const c = n(); s.push(...s.slice(s.length - c)); break; }
      case "index": { const c = n(); s.push(s[s.length - 1 - c]); break; }
      case "roll": {
        const j = n();
        const c = n();
        if (c > 0) {
          const part = s.splice(s.length - c, c);
          const r = ((j % c) + c) % c;
          s.push(...part.slice(c - r), ...part.slice(0, c - r));
        }
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

/**
 * A sampled function (type 0) with `inputs` inputs over `domain`, one output in [0, 1], from
 * `f`: what replaces a gradient's or spot colour's function once it has to give grey.
 */
export function sampledGray(ctx: PDFContext, inputs: number, domain: number[], f: (x: number[]) => number): PDFRef {
  const per = inputs === 1 ? 256 : inputs === 2 ? 33 : inputs === 3 ? 17 : inputs === 4 ? 9 : 5;
  const total = Math.pow(per, inputs);
  const data = new Uint8Array(total);
  const x = new Array(inputs).fill(0);
  for (let i = 0; i < total; i++) {
    let r = i;
    for (let d = 0; d < inputs; d++) {
      const k = r % per;
      r = Math.floor(r / per);
      x[d] = domain[d * 2] + ((domain[d * 2 + 1] - domain[d * 2]) * k) / (per - 1);
    }
    data[i] = Math.round(clip(f(x), 0, 1) * 255);
  }
  return ctx.register(ctx.flateStream(data, { FunctionType: 0, Domain: domain, Range: [0, 1], Size: new Array(inputs).fill(per), BitsPerSample: 8 }));
}

