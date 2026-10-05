import { Download, Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DropZone } from "@/components/dropzone";
import { usePasswordPrompt } from "@/components/password";
import { ResultList } from "@/components/results";
import { Button, Notice, Panel, Progress, Select, Slider } from "@/components/ui";
import { take } from "@/lib/handoff";
import type { OutFile } from "@/lib/pdf/core";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";
import { aiStatusOnce, useDocText, type AiStatus } from "./doc-text";

type Unit = { text: string; page: number };

/** Everything worth reading aloud, headings included, split into sentences. */
function readingUnits(pages: { page: number; text: string }[]): Unit[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: object) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  const seg = Seg ? new Seg("en", { granularity: "sentence" }) : null;
  const out: Unit[] = [];
  for (const p of pages) {
    for (const para of p.text.split(/\n{2,}|\f/)) {
      const clean = para.replace(/-\n(?=\p{Ll})/gu, "").replace(/\s*\n\s*/g, " ").trim();
      if (!clean) continue;
      const parts = seg ? Array.from(seg.segment(clean), (s) => s.segment) : clean.split(/(?<=[.!?।])\s+/);
      for (const s of parts) if (s.trim().length > 1) out.push({ text: s.trim(), page: p.page });
    }
  }
  return out;
}

export default function Reader({ tool }: { tool: Tool }) {
  const { ask, dialog } = usePasswordPrompt();
  const { doc, setDoc, load, loading, error } = useDocText(ask);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voice, setVoice] = useState("");
  const [rate, setRate] = useState(1);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [mp3, setMp3] = useState<{ v: number; l: string } | null>(null);
  const [mp3Error, setMp3Error] = useState<string>();
  const [results, setResults] = useState<OutFile[] | null>(null);
  const token = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  const units = useMemo(() => (doc ? readingUnits(doc.pages) : []), [doc]);
  const hindi = useMemo(() => units.slice(0, 40).filter((u) => /[ऀ-ॿ]/.test(u.text)).length > 10, [units]);

  useEffect(() => {
    const f = take()?.files.find((x) => /\.pdf$/i.test(x.name) || x.type === "application/pdf");
    if (f) void load(f);
    void aiStatusOnce().then(setAi);
  }, [load]);

  useEffect(() => {
    if (!supported) return;
    const pick = () => {
      const list = speechSynthesis.getVoices();
      setVoices(list);
      setVoice((cur) => cur || (list.find((v) => (hindi ? v.lang.startsWith("hi") : v.lang === navigator.language)) ?? list.find((v) => v.lang.startsWith(hindi ? "hi" : "en")) ?? list[0])?.voiceURI || "");
    };
    pick();
    speechSynthesis.addEventListener("voiceschanged", pick);
    return () => speechSynthesis.removeEventListener("voiceschanged", pick);
  }, [supported, hindi]);

  useEffect(() => () => void (supported && speechSynthesis.cancel()), [supported]);

  const speak = (i: number) => {
    if (!supported || i >= units.length) {
      setPlaying(false);
      return;
    }
    const my = ++token.current;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(units[i].text);
    const v = voices.find((x) => x.voiceURI === voice);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = rate;
    u.onend = () => {
      if (my !== token.current) return;
      setIndex(i + 1);
      speak(i + 1);
    };
    u.onerror = (e) => {
      if (my !== token.current || e.error === "interrupted" || e.error === "canceled") return;
      setPlaying(false);
    };
    setIndex(i);
    setPlaying(true);
    speechSynthesis.speak(u);
  };
  const stop = () => {
    token.current++;
    if (supported) speechSynthesis.cancel();
    setPlaying(false);
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${index}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [index]);

  // Restart the current sentence when the voice or speed changes mid-play.
  useEffect(() => {
    if (playing) speak(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, rate]);

  const makeMp3 = async () => {
    setMp3Error(undefined);
    setResults(null);
    const chunks: string[] = [];
    let cur = "";
    for (const u of units) {
      if ((cur + " " + u.text).length > 3400 && cur) {
        chunks.push(cur);
        cur = "";
      }
      cur = cur ? `${cur} ${u.text}` : u.text;
    }
    if (cur) chunks.push(cur);
    if (!chunks.length) return;
    try {
      const { aiSpeak } = await import("@/lib/ai/server");
      const parts: Uint8Array[] = [];
      for (let i = 0; i < chunks.length; i++) {
        setMp3({ v: i / chunks.length, l: `Recording part ${i + 1} of ${chunks.length}` });
        const r = await aiSpeak({ data: { text: chunks[i] } });
        if (!r.ok) throw new Error(r.error);
        parts.push(Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)));
      }
      const total = parts.reduce((n, p) => n + p.length, 0);
      const bytes = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        bytes.set(p, o);
        o += p.length;
      }
      setResults([{ filename: `${doc!.file.name.replace(/\.pdf$/i, "")}.mp3`, bytes, mime: "audio/mpeg", note: `${chunks.length} part${chunks.length === 1 ? "" : "s"}` }]);
    } catch (e) {
      setMp3Error(e instanceof Error ? e.message : String(e));
    } finally {
      setMp3(null);
    }
  };

  if (!doc)
    return (
      <div className="grid gap-4">
        {loading ? (
          <Panel className="grid min-h-72 place-items-center p-8">
            <div className="w-full max-w-sm">
              <Progress value={loading.value} label={loading.label} />
            </div>
          </Panel>
        ) : (
          <DropZone accept="application/pdf,.pdf" onFiles={(f) => void load(f[0])} label={tool.input?.label ?? "Choose a PDF"} />
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {dialog}
      </div>
    );

  const progress = units.length ? index / units.length : 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Panel className="overflow-hidden">
        <div ref={listRef} className="max-h-[70vh] overflow-auto px-5 py-6 font-[Doc_Serif,serif] text-[17px] leading-[1.8] text-ink sm:px-8">
          {!units.length ? <Notice tone="warn">This PDF has no readable text (it looks scanned). Run OCR first.</Notice> : null}
          {units.map((u, i) => (
            <span key={i} data-i={i}>
              {i === 0 || units[i - 1].page !== u.page ? <span className="my-3 block font-sans text-xs font-medium tracking-wide text-ink-3 uppercase">Page {u.page}</span> : null}
              <span onClick={() => speak(i)} className={cn("cursor-pointer rounded-sm px-0.5 transition-colors hover:bg-carbon-soft", i === index && (playing ? "bg-marker text-marker-ink" : "bg-marker/50"))}>
                {u.text}
              </span>{" "}
            </span>
          ))}
        </div>
        <div className="h-1 bg-line-2">
          <div className="h-full bg-carbon transition-[width]" style={{ width: `${progress * 100}%` }} />
        </div>
      </Panel>
      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel className="grid gap-4 p-4">
          {!supported ? <Notice tone="warn">This browser can&apos;t read aloud. Try Chrome, Edge or Safari.</Notice> : null}
          <div className="flex items-center justify-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => speak(Math.max(0, index - 1))} aria-label="Previous sentence" disabled={!units.length}>
              <SkipBack />
            </Button>
            {playing ? (
              <Button variant="primary" size="lg" className="w-28" onClick={stop}>
                <Pause /> Pause
              </Button>
            ) : (
              <Button variant="primary" size="lg" className="w-28" onClick={() => speak(index >= units.length ? 0 : index)} disabled={!supported || !units.length}>
                <Play /> {index > 0 && index < units.length ? "Resume" : "Play"}
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={() => speak(Math.min(units.length - 1, index + 1))} aria-label="Next sentence" disabled={!units.length}>
              <SkipForward />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => (stop(), setIndex(0))} aria-label="Stop and go back to the start">
              <Square />
            </Button>
          </div>
          <p className="text-center text-xs text-ink-3 tabular">
            Sentence {Math.min(index + 1, units.length)} of {units.length} · page {units[Math.min(index, units.length - 1)]?.page ?? 1}
          </p>
          <label className="grid gap-1.5">
            <span className="text-[13px] font-medium text-ink-2">Voice</span>
            <Select value={voice} onChange={(e) => setVoice(e.target.value)} disabled={!voices.length}>
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </Select>
          </label>
          <div className="grid gap-1.5">
            <span className="text-[13px] font-medium text-ink-2">Speed</span>
            <Slider label="Speed" min={0.5} max={2} step={0.1} value={rate} onChange={setRate} format={(v) => `${v.toFixed(1)}×`} />
          </div>
          <p className="text-xs text-ink-3">Uses the voices built into your device. Tap any sentence to start reading from there.</p>
          {ai?.speech ? (
            <div className="grid gap-2 border-t border-line-2 pt-4">
              <Button variant="secondary" onClick={makeMp3} disabled={!!mp3 || !units.length}>
                <Download /> Make an MP3
              </Button>
              {mp3 ? <Progress value={mp3.v} label={mp3.l} /> : null}
              {mp3Error ? <Notice tone="danger">{mp3Error}</Notice> : null}
              {results ? <ResultList results={results} tool={tool.slug} /> : null}
              <p className="text-xs text-ink-3">The MP3 is made by this site&apos;s speech service, so the text (not the file) is sent to it.</p>
            </div>
          ) : null}
          <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => (stop(), setDoc(null), setIndex(0), setResults(null))}>
            Read another PDF
          </Button>
        </Panel>
      </aside>
      {dialog}
    </div>
  );
}
