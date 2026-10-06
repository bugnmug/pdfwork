/**
 * On-device document understanding: extractive
 * summaries, keywords, facts (dates, amounts, emails), and question answering
 * by passage retrieval (BM25) with page references. No key, no upload.
 */

const STOP = new Set(
  "a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also may shall will must within upon per via etc e.g i.e".split(" "),
);

export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length > 5 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 4 && s.endsWith("es") && /(s|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 6 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 5 && s.endsWith("ed")) s = s.slice(0, -2);
  return s;
}

export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).filter((w) => !STOP.has(w) && w.length > 1).map(stem);
}

/**
 * Split text into sentences. Line structure is used first, so headings and
 * list items become their own units instead of running into the next
 * paragraph (PDF text often has no full stop after a title).
 */
export function sentences(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: object) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const seg = Seg ? new Seg("en", { granularity: "sentence" }) : null;
  const split = (para: string) => {
    const clean = para.replace(/\s+/g, " ").trim();
    if (!clean) return [];
    return seg ? Array.from(seg.segment(clean), (x) => x.segment) : clean.split(/(?<=[.!?।])\s+(?=[A-Z0-9“"(\p{Lu}])/u);
  };
  const lines = text.split(/\n/);
  const units: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) units.push(...split(buf.join(" ")));
    buf = [];
  };
  const bullet = /^\s*(?:[-–•*·▪◦]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/i;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return flush();
    const next = (lines[i + 1] ?? "").trim();
    if (bullet.test(line)) {
      flush();
      buf.push(line.replace(bullet, ""));
      return;
    }
    const standalone = line.length < 70 && !/[.,;:!?)\]-]$/.test(line) && (!next || /^[\p{Lu}\d•\-–*]/u.test(next));
    if (standalone && (!buf.length || /[.!?:]$/.test(buf[buf.length - 1]))) {
      flush();
      units.push(line);
      return;
    }
    buf.push(line);
    if (standalone) flush();
  });
  flush();
  return units.map((x) => x.trim()).filter((x) => x.length > 20 && x.length < 600 && /\p{L}/u.test(x));
}

export type PageDoc = { page: number; text: string }[];

// Month names written out or shortened ("Sept", "Sep.", "September").
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON = `(?:${MONTHS.map((m) => (m === "september" ? "sept?(?:ember)?" : m.slice(0, 3) + (m.length > 3 ? `(?:${m.slice(3)})?` : ""))).join("|")})\\.?`;
const ORD = "(?:st|nd|rd|th)?";
/** 12/03/2024, 2024-03-12, 12th March 2024, March 12, 2024, Q3 2024, Q3 FY24. */
const DATE_FACT = new RegExp(
  String.raw`\b(?:\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2}|\d{1,2}${ORD}\s+${MON},?\s+\d{4}|${MON}\s+\d{1,2}${ORD},?\s+\d{4}|Q[1-4]\s+(?:FY\s?)?\d{2,4})\b`,
  "gi",
);

export type Summary = {
  points: { text: string; page: number }[];
  keywords: string[];
  stats: { pages: number; words: number; minutes: number };
  facts: { label: string; values: string[] }[];
  headings: string[];
};

export function summarize(pages: PageDoc, headings: string[] = [], max?: number): Summary {
  const all: { text: string; page: number; pos: number }[] = [];
  for (const p of pages) for (const s of sentences(p.text)) all.push({ text: s, page: p.page, pos: all.length });
  const words = pages.reduce((n, p) => n + (p.text.match(/\S+/g)?.length ?? 0), 0);
  const df = new Map<string, number>();
  const sentTerms = all.map((s) => {
    const t = terms(s.text);
    for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
    return t;
  });
  const N = Math.max(1, all.length);
  const idf = (w: string) => Math.log(1 + N / (1 + (df.get(w) ?? 0)));
  // Document centroid of tf-idf weights.
  const centroid = new Map<string, number>();
  sentTerms.forEach((ts) => ts.forEach((w) => centroid.set(w, (centroid.get(w) ?? 0) + idf(w))));
  const headingTerms = new Set(headings.flatMap(terms));
  const scored = all.map((s, i) => {
    const ts = sentTerms[i];
    if (!ts.length) return { ...s, score: 0 };
    let sc = 0;
    for (const w of new Set(ts)) sc += (centroid.get(w) ?? 0) * idf(w) * (headingTerms.has(w) ? 1.4 : 1);
    sc /= Math.pow(ts.length, 0.6);
    const posBonus = i < 3 ? 1.25 : 1;
    const numeric = /\d/.test(s.text) ? 1.08 : 1;
    return { ...s, score: sc * posBonus * numeric };
  });
  const want = max ?? Math.min(12, Math.max(4, Math.round(Math.sqrt(all.length) * 1.3)));
  const picked: typeof scored = [];
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (picked.length >= want) break;
    const st = new Set(terms(s.text));
    const dup = picked.some((p) => {
      const pt = new Set(terms(p.text));
      const inter = [...st].filter((w) => pt.has(w)).length;
      return inter / Math.max(1, Math.min(st.size, pt.size)) > 0.6;
    });
    if (!dup) picked.push(s);
  }
  picked.sort((a, b) => a.pos - b.pos);
  // Show keywords as the word people actually wrote, not its stem ("prepared", not "prepar").
  const surface = new Map<string, Map<string, number>>();
  for (const p of pages)
    for (const w of p.text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []) {
      if (STOP.has(w) || w.length < 2) continue;
      const st = stem(w);
      const m = surface.get(st) ?? new Map<string, number>();
      m.set(w, (m.get(w) ?? 0) + 1);
      surface.set(st, m);
    }
  const kw = [...centroid.entries()]
    .filter(([w]) => w.length > 3 && !/^\d+$/.test(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => [...(surface.get(w)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? w);
  const full = pages.map((p) => p.text).join("\n");
  const uniq = (re: RegExp, limit = 8) => [...new Set(full.match(re) ?? [])].slice(0, limit);
  const facts = [
    { label: "Dates", values: uniq(DATE_FACT) },
    { label: "Amounts", values: uniq(/(?:₹|\bRs\.?|\bINR|\$|\bUSD|€|£)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:crore|lakh|million|billion|k|cr|L)\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:crore|lakh|million|billion)\b/gi) },
    { label: "Percentages", values: uniq(/\b\d+(?:\.\d+)?\s?%/g) },
    { label: "Emails", values: uniq(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) },
    { label: "Links", values: uniq(/https?:\/\/[^\s)>\]]+/gi, 5) },
  ].filter((f) => f.values.length);
  return { points: picked.map((p) => ({ text: p.text, page: p.page })), keywords: kw, stats: { pages: pages.length, words, minutes: Math.max(1, Math.round(words / 230)) }, facts, headings: headings.slice(0, 20) };
}

export type Passage = { text: string; page: number; terms: string[] };

export function chunk(pages: PageDoc, target = 90): Passage[] {
  const out: Passage[] = [];
  for (const p of pages) {
    const sents = sentences(p.text);
    const units = sents.length ? sents : p.text.split(/\n{2,}/).filter((x) => x.trim());
    let cur: string[] = [];
    let n = 0;
    const flush = () => {
      if (!cur.length) return;
      const text = cur.join(" ");
      out.push({ text, page: p.page, terms: terms(text) });
      cur = [];
      n = 0;
    };
    for (const s of units) {
      const len = s.split(/\s+/).length;
      if (n + len > target && n > target * 0.4) flush();
      cur.push(s);
      n += len;
    }
    flush();
  }
  return out;
}

export class Bm25 {
  private df = new Map<string, number>();
  private avg = 1;
  constructor(public passages: Passage[], private k1 = 1.4, private b = 0.75) {
    for (const p of passages) for (const t of new Set(p.terms)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avg = passages.reduce((s, p) => s + p.terms.length, 0) / Math.max(1, passages.length);
  }
  search(query: string, k = 4): { p: Passage; score: number }[] {
    const q = [...new Set(terms(query))];
    const N = this.passages.length;
    const res = this.passages.map((p) => {
      const tf = new Map<string, number>();
      for (const t of p.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        score += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * p.terms.length) / this.avg)));
      }
      // Exact phrase bonus.
      if (query.length > 8 && p.text.toLowerCase().includes(query.toLowerCase().replace(/[?.!]+$/, "").trim())) score *= 1.5;
      return { p, score };
    });
    return res.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }
}

export type LocalAnswer = { answer: string; page: number | null; passages: { text: string; page: number }[]; confident: boolean };

export function answerLocally(index: Bm25, question: string): LocalAnswer {
  const hits = index.search(question, 4);
  if (!hits.length) return { answer: "I couldn't find anything about that in the document. Try different words, or check the spelling.", page: null, passages: [], confident: false };
  const q = new Set(terms(question));
  let best = { s: "", page: hits[0].p.page, score: -1 };
  for (const h of hits.slice(0, 3)) {
    for (const s of sentences(h.p.text)) {
      const st = terms(s);
      const overlap = st.filter((w) => q.has(w)).length;
      const score = overlap / Math.sqrt(st.length + 1) + h.score * 0.05 + (/\d/.test(s) && /how (much|many)|when|what (date|year|amount|price)|cost|total/i.test(question) ? 0.3 : 0);
      if (score > best.score) best = { s, page: h.p.page, score };
    }
  }
  const answer = best.s || hits[0].p.text.slice(0, 400);
  const covered = q.size ? terms(answer).filter((w) => q.has(w)).length / q.size : 0;
  return { answer, page: best.page, passages: hits.map((h) => ({ text: h.p.text, page: h.p.page })), confident: hits[0].score > 2 || covered >= 0.5 };
}
