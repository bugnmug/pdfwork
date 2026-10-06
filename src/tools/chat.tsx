import { ArrowUp, BookOpen, FileText, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DropZone } from "@/components/dropzone";
import { usePasswordPrompt } from "@/components/password";
import { Button, Notice, Panel, Progress, Switch } from "@/components/ui";
import { Bm25, answerLocally, chunk, summarize, type Passage } from "@/lib/ai/local";
import { take } from "@/lib/handoff";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";
import { aiStatusOnce, useDocText, type AiStatus } from "./doc-text";

type Msg = { role: "user"; text: string } | { role: "bot"; text: string; pages: number[]; passages: { text: string; page: number }[]; source: "local" | "ai"; note?: string };

const SUGGESTED = ["Summarise the main points", "Which dates or deadlines come up?", "What amounts or prices appear?", "Which people or organisations are named?"];

function PageChips({ pages }: { pages: number[] }) {
  if (!pages.length) return null;
  return (
    <span className="mt-2 flex flex-wrap gap-1">
      {[...new Set(pages)].slice(0, 6).map((p) => (
        <span key={p} className="rounded-full bg-carbon-soft px-2 py-0.5 text-[11px] font-medium text-carbon tabular">
          p. {p}
        </span>
      ))}
    </span>
  );
}

export default function Chat({ tool }: { tool: Tool }) {
  const { ask, dialog } = usePasswordPrompt();
  const { doc, setDoc, load, loading, error } = useDocText(ask);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [useAi, setUseAi] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const f = take()?.files.find((x) => /\.pdf$/i.test(x.name) || x.type === "application/pdf");
    if (f) void load(f);
    void aiStatusOnce().then(setAi);
  }, [load]);

  const index = useMemo(() => (doc ? new Bm25(chunk(doc.pages)) : null), [doc]);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), [msgs, busy]);

  const send = async (question: string) => {
    const text = question.trim();
    if (!text || !doc || !index) return;
    setQ("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const overview = /\b(about|summar|overview|main points|key points|tl;?dr|gist)\b/i.test(text);
      if (useAi && ai?.enabled) {
        const hits = overview ? doc.pages.slice(0, 12).map((p) => ({ text: p.text.slice(0, 3500), page: p.page })) : index.search(text, 8).map((h) => ({ text: h.p.text, page: h.p.page }));
        const history = msgs.flatMap((m, i) => (m.role === "user" && msgs[i + 1]?.role === "bot" ? [{ q: m.text, a: (msgs[i + 1] as { text: string }).text }] : [])).slice(-4);
        const { aiAsk } = await import("@/lib/ai/server");
        const r = await aiAsk({ data: { mode: "chat", question: text, passages: hits, history, title: doc.title } });
        if (r.ok) {
          const pages = [...r.text.matchAll(/p\.\s?(\d+)/g)].map((m) => Number(m[1]));
          setMsgs((m) => [...m, { role: "bot", text: r.text, pages, passages: hits, source: "ai" }]);
          return;
        }
        const local = answerLocally(index, text);
        setMsgs((m) => [...m, { role: "bot", text: local.answer, pages: local.page ? [local.page] : [], passages: local.passages, source: "local", note: `${r.error} Showing the on-device answer instead.` }]);
        return;
      }
      if (overview) {
        const s = summarize(doc.pages, doc.headings, 5);
        const body = s.points.map((p) => `• ${p.text}`).join("\n");
        setMsgs((m) => [...m, { role: "bot", text: `${doc.pageCount} pages, about ${s.stats.words.toLocaleString()} words. The main points:\n\n${body}`, pages: s.points.map((p) => p.page), passages: [], source: "local" }]);
        return;
      }
      const r = answerLocally(index, text);
      setMsgs((m) => [...m, { role: "bot", text: r.answer, pages: r.page ? [r.page] : [], passages: r.passages, source: "local", note: r.confident ? undefined : "Not a confident match. Check the passages below." }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "bot", text: `Something went wrong: ${e instanceof Error ? e.message : String(e)}`, pages: [], passages: [], source: "local" }]);
    } finally {
      setBusy(false);
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

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <Panel className="flex min-h-[60vh] flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-line-2 px-4 py-3">
          <FileText className="size-4 text-ink-3" />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{doc.file.name}</p>
          {ai?.enabled ? <Switch checked={useAi} onChange={setUseAi} label={<span className="inline-flex items-center gap-1">AI answers <Sparkles className="size-3.5 text-carbon" /></span>} /> : null}
        </div>
        <div className="flex-1 space-y-4 overflow-auto px-4 py-5" aria-live="polite">
          {!msgs.length ? (
            <div className="grid gap-3">
              <p className="text-sm text-ink-2">Ask anything about this document. Answers quote the passage they came from, with page numbers.</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTED.map((s) => (
                  <button key={s} type="button" onClick={() => void send(s)} className="rounded-full border border-line bg-paper px-3 py-1.5 text-left text-[13px] text-ink-2 hover:border-carbon hover:text-carbon">
                    {s}
                  </button>
                ))}
              </div>
              {doc.textPages === 0 ? <Notice tone="warn">This looks like a scan, so there&apos;s nothing to search yet. Open it in OCR: Searchable PDF first, then bring the result back here.</Notice> : null}
            </div>
          ) : null}
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="ml-auto w-fit max-w-[85%] rounded-lg rounded-br-sm bg-carbon px-3.5 py-2 text-sm text-carbon-ink">
                {m.text}
              </div>
            ) : (
              <div key={i} className="max-w-[92%]">
                <div className="rounded-lg rounded-bl-sm border border-line bg-paper-2 px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-ink">
                  {m.text}
                  <PageChips pages={m.pages} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 px-1 text-[11px] text-ink-3">
                  <span>{m.source === "ai" ? "AI answer from the passages below" : "Answered on this device"}</span>
                  {m.note ? <span className="text-warn">{m.note}</span> : null}
                </div>
                {m.passages.length ? (
                  <details className="mt-1 px-1">
                    <summary className="inline-flex items-center gap-1 text-xs text-carbon">
                      <BookOpen className="size-3.5" /> {m.passages.length} source passage{m.passages.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-2 grid gap-2">
                      {m.passages.slice(0, 6).map((p: Passage | { text: string; page: number }, j) => (
                        <li key={j} className="rounded-md border border-line-2 bg-paper px-3 py-2 text-xs leading-relaxed text-ink-2">
                          <b className="mr-1 text-ink tabular">p. {p.page}</b>
                          {p.text.length > 600 ? `${p.text.slice(0, 600)}…` : p.text}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ),
          )}
          {busy ? <div className="h-9 w-24 animate-pulse rounded-lg bg-paper-2" /> : null}
          <div ref={endRef} />
        </div>
        <form
          className="flex items-end gap-2 border-t border-line-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(q);
          }}
        >
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(q);
              }
            }}
            rows={1}
            placeholder="Ask a question about the PDF"
            aria-label="Your question"
            className="max-h-40 min-h-10 flex-1 resize-none rounded-md border border-line bg-paper px-3 py-2 text-sm focus:border-carbon focus:ring-2 focus:ring-carbon/25 focus:outline-none"
          />
          <Button type="submit" variant="primary" size="icon" disabled={!q.trim() || busy} aria-label="Send">
            <ArrowUp />
          </Button>
        </form>
      </Panel>
      <aside className="grid content-start gap-3">
        <Panel className="grid gap-2 p-4 text-sm">
          <p className="font-medium">{doc.title}</p>
          <p className="text-ink-2 tabular">
            {doc.pageCount} page{doc.pageCount === 1 ? "" : "s"} · {doc.pages.reduce((n, p) => n + (p.text.match(/\S+/g)?.length ?? 0), 0).toLocaleString()} words
          </p>
          <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => (setDoc(null), setMsgs([]))}>
            Use another PDF
          </Button>
        </Panel>
        <Panel className={cn("grid gap-2 p-4 text-xs leading-relaxed text-ink-2")}>
          <p className="font-medium text-ink">How answers work</p>
          <p>On-device answers find the best-matching passages with a search model that runs in this tab. Nothing is sent anywhere.</p>
          {ai?.enabled ? <p>AI answers send only your question and the handful of passages needed to answer it, never the file. The meter at the top shows exactly how much.</p> : null}
        </Panel>
      </aside>
      {dialog}
    </div>
  );
}
