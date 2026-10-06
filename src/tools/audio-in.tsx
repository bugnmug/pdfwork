import { FileAudio, Mic, MicOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFilePicker } from "@/components/dropzone";
import { ResultList } from "@/components/results";
import { Button, Input, Notice, Panel, Progress, Select, Textarea } from "@/components/ui";
import type { OutFile } from "@/lib/pdf/core";
import { usePersistent } from "@/lib/storage";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";
import { aiStatusOnce, type AiStatus } from "./doc-text";

type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

const LANGS = [
  ["en-IN", "English (India)"],
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["hi-IN", "हिन्दी Hindi"],
  ["mr-IN", "मराठी Marathi"],
  ["ta-IN", "தமிழ் Tamil"],
  ["te-IN", "తెలుగు Telugu"],
  ["kn-IN", "ಕನ್ನಡ Kannada"],
  ["bn-IN", "বাংলা Bengali"],
  ["gu-IN", "ગુજરાતી Gujarati"],
];

/** Decode any audio file, downmix to 16 kHz mono and cut it into WAV pieces of about a minute. */
async function audioToWavChunks(file: File, seconds = 60): Promise<Blob[]> {
  const buf = await file.arrayBuffer();
  const ctx = new AudioContext();
  const audio = await ctx.decodeAudioData(buf.slice(0));
  await ctx.close();
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(audio.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  const mono = (await off.startRendering()).getChannelData(0);
  const per = seconds * rate;
  const out: Blob[] = [];
  for (let start = 0; start < mono.length; start += per) {
    const slice = mono.subarray(start, Math.min(mono.length, start + per));
    const view = new DataView(new ArrayBuffer(44 + slice.length * 2));
    const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF");
    view.setUint32(4, 36 + slice.length * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, "data");
    view.setUint32(40, slice.length * 2, true);
    for (let i = 0; i < slice.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, slice[i])) * 0x7fff, true);
    out.push(new Blob([view.buffer], { type: "audio/wav" }));
  }
  return out;
}

async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export default function AudioIn({ tool }: { tool: Tool }) {
  const [text, setText] = usePersistent("dictation", "", 500);
  const [title, setTitle] = useState("");
  const [lang, setLang] = usePersistent("dictation-lang", "en-IN");
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string>();
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [transcribing, setTranscribing] = useState<{ v: number; l: string } | null>(null);
  const [results, setResults] = useState<OutFile[] | null>(null);
  const [saving, setSaving] = useState(false);
  const rec = useRef<Rec | null>(null);
  const want = useRef(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setSupported(!!((window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition));
    void aiStatusOnce().then(setAi);
    return () => {
      want.current = false;
      rec.current?.stop();
    };
  }, []);

  const start = () => {
    const SR = ((window as unknown as { SpeechRecognition?: new () => Rec }).SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: new () => Rec }).webkitSpeechRecognition)!;
    const r = new SR();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let finals = "";
      let temp = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finals += res[0].transcript;
        else temp += res[0].transcript;
      }
      if (finals) setText((t) => (t && !/\s$/.test(t) ? `${t} ` : t) + finals.trim());
      setInterim(temp);
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(e.error === "not-allowed" ? "Microphone access was blocked. Allow it in your browser's site settings." : `Dictation stopped: ${e.error}.`);
      want.current = false;
    };
    // Browsers stop listening after a pause; keep going until the user presses stop.
    r.onend = () => {
      setInterim("");
      if (want.current) {
        try {
          r.start();
        } catch {
          setListening(false);
        }
      } else setListening(false);
    };
    rec.current = r;
    want.current = true;
    setError(undefined);
    try {
      r.start();
      setListening(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const stop = () => {
    want.current = false;
    rec.current?.stop();
    setListening(false);
  };

  const picker = useFilePicker("audio/*,video/*,.mp3,.m4a,.wav,.ogg,.webm,.aac,.flac", false, async (files) => {
    setError(undefined);
    try {
      setTranscribing({ v: 0, l: "Decoding the recording" });
      const chunks = await audioToWavChunks(files[0]);
      const { aiTranscribe } = await import("@/lib/ai/server");
      let all = "";
      for (let i = 0; i < chunks.length; i++) {
        setTranscribing({ v: i / chunks.length, l: `Transcribing minute ${i + 1} of ${chunks.length}` });
        const r = await aiTranscribe({ data: { base64: await blobToBase64(chunks[i]), mime: "audio/wav" } });
        if (!r.ok) throw new Error(r.error);
        all += (all ? " " : "") + r.text.trim();
      }
      setText((t) => (t.trim() ? `${t.trim()}\n\n${all}` : all));
      if (!title) setTitle(files[0].name.replace(/\.[^.]+$/, ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTranscribing(null);
    }
  });

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const { runTool } = await import("@/lib/pdf/run");
      setResults(await runTool(tool, { files: [], options: { body: text, title: title || "Transcript" } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      {picker.input}
      <Panel className="grid gap-3 p-4 sm:p-5">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Title" className="text-base font-medium" />
        <div className="relative">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={16} placeholder={supported ? "Press the microphone and start talking, or type here…" : "Type or paste here…"} aria-label="Transcript" className="min-h-80 text-[15px] leading-relaxed" />
          {interim ? <p className="pointer-events-none absolute right-3 bottom-3 left-3 truncate rounded bg-paper/90 px-2 py-1 text-sm text-ink-3 italic">{interim}</p> : null}
        </div>
        <p className="text-xs text-ink-3 tabular">
          {words} word{words === 1 ? "" : "s"} · saved in this browser, clear it any time
        </p>
      </Panel>
      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel className="grid gap-4 p-4">
          {supported ? (
            <>
              <button
                type="button"
                onClick={listening ? stop : start}
                className={cn("mx-auto grid size-24 place-items-center rounded-full text-white shadow-panel transition-transform active:scale-95", listening ? "animate-pulse bg-danger" : "bg-carbon hover:bg-carbon-hover")}
                aria-label={listening ? "Stop dictation" : "Start dictation"}
              >
                {listening ? <MicOff className="size-9" /> : <Mic className="size-9" />}
              </button>
              <p className="text-center text-sm text-ink-2">{listening ? "Listening… speak naturally. Say “full stop” or “comma” for punctuation." : "Tap to dictate"}</p>
              <label className="grid gap-1.5">
                <span className="text-[13px] font-medium text-ink-2">Language</span>
                <Select value={lang} onChange={(e) => setLang(e.target.value)} disabled={listening}>
                  {LANGS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </label>
              <p className="text-xs text-ink-3">Dictation uses your browser&apos;s speech recognition, which may process audio on your browser maker&apos;s servers.</p>
            </>
          ) : (
            <Notice tone="warn">This browser doesn&apos;t offer dictation. Chrome, Edge and Safari do. You can still type or paste text.</Notice>
          )}
          {ai?.transcribe ? (
            <div className="grid gap-2 border-t border-line-2 pt-4">
              <Button variant="secondary" onClick={picker.open} disabled={!!transcribing}>
                <FileAudio /> Transcribe a recording
              </Button>
              {transcribing ? <Progress value={transcribing.v} label={transcribing.l} /> : null}
              <p className="text-xs text-ink-3">The audio is sent to this site&apos;s transcription service in one-minute pieces.</p>
            </div>
          ) : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button variant="primary" size="lg" onClick={save} busy={saving} disabled={saving || !text.trim()}>
            {tool.cta}
          </Button>
          {results ? <ResultList results={results} tool={tool.slug} /> : null}
          {text ? (
            <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => confirm("Clear the transcript?") && (setText(""), setResults(null))}>
              Clear text
            </Button>
          ) : null}
        </Panel>
      </aside>
    </div>
  );
}
