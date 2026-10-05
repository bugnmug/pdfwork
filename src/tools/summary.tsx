import { Check, Copy, Download, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DropZone } from "@/components/dropzone";
import { usePasswordPrompt } from "@/components/password";
import { ResultList } from "@/components/results";
import { Button, Notice, Panel, Progress, Slider } from "@/components/ui";
import { summarize } from "@/lib/ai/local";
import { take } from "@/lib/handoff";
import type { OutFile } from "@/lib/pdf/core";
import type { Tool } from "@/lib/tools/catalog";
import { aiStatusOnce, useDocText, type AiStatus } from "./doc-text";

export default function Summary({ tool }: { tool: Tool }) {
  const { ask, dialog } = usePasswordPrompt();
  const { doc, setDoc, load, loading, error } = useDocText(ask);
  const [count, setCount] = useState(0);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [aiText, setAiText] = useState<string>();
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [out, setOut] = useState<OutFile[] | null>(null);

  useEffect(() => {
    const f = take()?.files.find((x) => /\.pdf$/i.test(x.name) || x.type === "application/pdf");
    if (f) void load(f);
    void aiStatusOnce().then(setAi);
  }, [load]);

  const summary = useMemo(() => (doc ? summarize(doc.pages, doc.headings, count || undefined) : null), [doc, count]);
  useEffect(() => {
    if (summary && !count) setCount(summary.points.length);
  }, [summary, count]);

  const asText = () => {
    if (!summary || !doc) return "";
    const lines = [`Summary of ${doc.file.name}`, "", `${summary.stats.pages} pages · ${summary.stats.words.toLocaleString()} words · about ${summary.stats.minutes} min read`, ""];
    if (aiText) lines.push("AI summary", aiText, "");
    lines.push("Key points", ...summary.points.map((p) => `- ${p.text} (p. ${p.page})`), "");
    for (const f of summary.facts) lines.push(`${f.label}: ${f.values.join(", ")}`);
    if (summary.keywords.length) lines.push("", `Keywords: ${summary.keywords.join(", ")}`);
    return lines.join("\n");
  };

  const runAi = async () => {
    if (!doc) return;
    setAiBusy(true);
    setAiError(undefined);
    try {
      let budget = 55000;
      const passages = doc.pages
        .map((p) => ({ page: p.page, text: p.text }))
        .filter((p) => {
          if (budget <= 0) return false;
          budget -= p.text.length;
          return true;
        });
      const { aiAsk } = await import("@/lib/ai/server");
      const r = await aiAsk({ data: { mode: "summarize", passages, title: doc.title } });
      if (r.ok) setAiText(r.text);
      else setAiError(r.error);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  };

  const downloadPdf = async () => {
    if (!summary || !doc) return;
    const { markdownToPdf } = await import("@/lib/pdf/office");
    const md = [
      `# Summary: ${doc.title}`,
      `*${doc.file.name} · ${summary.stats.pages} pages · ${summary.stats.words.toLocaleString()} words*`,
      ...(aiText ? ["## AI summary", aiText] : []),
      "## Key points",
      ...summary.points.map((p) => `- ${p.text} *(p. ${p.page})*`),
      ...(summary.facts.length ? ["## Facts", ...summary.facts.map((f) => `- **${f.label}:** ${f.values.join(", ")}`)] : []),
      ...(summary.keywords.length ? ["## Keywords", summary.keywords.join(", ")] : []),
    ].join("\n\n");
    const o = await markdownToPdf(md, `${doc.file.name.replace(/\.pdf$/i, "")}-summary`);
    setOut([o]);
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

  if (!summary) return null;
  const noText = doc.textPages === 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Panel className="grid gap-6 p-5 sm:p-7">
        <header className="grid gap-1">
          <p className="text-xs font-medium tracking-wide text-ink-3 uppercase">Summary</p>
          <h2 className="text-2xl font-bold tracking-tight">{doc.title}</h2>
          <p className="text-sm text-ink-2 tabular">
            {summary.stats.pages} pages · {summary.stats.words.toLocaleString()} words · about {summary.stats.minutes} min to read
          </p>
        </header>
        {noText ? <Notice tone="warn">This PDF has no text layer (it looks scanned). Run OCR first to make it readable, then summarise it.</Notice> : null}
        {aiText ? (
          <section className="grid gap-2 rounded-lg border border-carbon/20 bg-carbon-soft/50 p-4">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-carbon">
              <Sparkles className="size-4" /> AI summary
            </p>
            <div className="text-[15px] leading-relaxed whitespace-pre-wrap text-ink">{aiText}</div>
          </section>
        ) : null}
        {summary.points.length ? (
          <section className="grid gap-3">
            <h3 className="font-semibold">Key points</h3>
            <ol className="grid gap-3">
              {summary.points.map((p, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-marker text-xs font-bold text-marker-ink tabular">{i + 1}</span>
                  <p className="text-[15px] leading-relaxed text-ink">
                    {p.text} <span className="text-xs text-ink-3 tabular">p. {p.page}</span>
                  </p>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {summary.facts.length ? (
          <section className="grid gap-3">
            <h3 className="font-semibold">Facts and figures</h3>
            <dl className="grid gap-2 sm:grid-cols-2">
              {summary.facts.map((f) => (
                <div key={f.label} className="rounded-md border border-line-2 bg-paper-2 p-3">
                  <dt className="text-xs font-medium text-ink-3">{f.label}</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {f.values.map((v) => (
                      <span key={v} className="rounded bg-paper px-1.5 py-0.5 text-[13px] text-ink tabular">
                        {v}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
        {summary.headings.length > 1 ? (
          <section className="grid gap-2">
            <h3 className="font-semibold">Sections</h3>
            <ul className="columns-1 gap-6 text-sm text-ink-2 sm:columns-2">
              {summary.headings.map((h, i) => (
                <li key={i} className="mb-1 break-inside-avoid">
                  {h}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Panel>
      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel className="grid gap-4 p-4">
          <div className="grid gap-1.5">
            <p className="text-[13px] font-medium text-ink-2">Number of key points</p>
            <Slider label="Number of key points" min={3} max={20} value={count || 6} onChange={setCount} />
          </div>
          {summary.keywords.length ? (
            <div className="grid gap-1.5">
              <p className="text-[13px] font-medium text-ink-2">Keywords</p>
              <div className="flex flex-wrap gap-1.5">
                {summary.keywords.map((k) => (
                  <span key={k} className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-2">
                    {k}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <div className="grid gap-2">
            {ai?.enabled ? (
              <Button variant="soft" onClick={runAi} busy={aiBusy} disabled={aiBusy || noText}>
                {!aiBusy ? <Sparkles /> : null} {aiText ? "Redo AI summary" : "Write an AI summary"}
              </Button>
            ) : null}
            {aiError ? <Notice tone="danger">{aiError}</Notice> : null}
            <Button
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(asText());
                setCopied(true);
                toast.success("Summary copied");
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check /> : <Copy />} Copy as text
            </Button>
            <Button variant="primary" onClick={downloadPdf}>
              <Download /> Download as PDF
            </Button>
          </div>
          {out ? <ResultList results={out} tool={tool.slug} /> : null}
          <p className="text-xs text-ink-3">The key points are picked on this device by ranking each sentence against the whole document. {ai?.enabled ? "The AI summary sends the document's text (not the file) to the AI service." : ""}</p>
          <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => (setDoc(null), setAiText(undefined), setOut(null), setCount(0))}>
            Summarise another PDF
          </Button>
        </Panel>
      </aside>
      {dialog}
    </div>
  );
}
