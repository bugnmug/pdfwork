import { ArrowLeftRight, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DropZone } from "@/components/dropzone";
import { Thumb } from "@/components/file-card";
import { usePasswordPrompt } from "@/components/password";
import { ResultList } from "@/components/results";
import { Button, Notice, Panel, Progress, Segmented, Spinner, Switch } from "@/components/ui";
import { take } from "@/lib/handoff";
import type { CompareResult, DiffPart } from "@/lib/pdf/compare";
import type { OutFile } from "@/lib/pdf/core";
import type { Src } from "@/lib/pdf/pages";
import type { Tool } from "@/lib/tools/catalog";
import { cn, formatBytes } from "@/lib/utils";
import { useThrottledProgress } from "./workspace";

type Side = { file: File; password?: string } | null;

/** Opens a PDF (asking for its password if needed) and returns it ready for the engine. */
export async function srcWithPassword(file: File, password: string | undefined, ask: (n: string, wrong?: boolean) => Promise<string | null>): Promise<Src | null> {
  const { pageCountOf, PdfjsPasswordError } = await import("@/lib/pdf/pdfjs");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pw = password;
  let wrong = false;
  for (;;) {
    try {
      await pageCountOf(bytes, pw);
      return { bytes, name: file.name, password: pw };
    } catch (e) {
      if (!(e instanceof PdfjsPasswordError)) throw e;
      const next = await ask(file.name, wrong);
      if (next == null) return null;
      pw = next;
      wrong = true;
    }
  }
}

function Slot({ label, side, onPick, onClear }: { label: string; side: Side; onPick: (f: File) => void; onClear: () => void }) {
  if (!side) return <DropZone compact accept="application/pdf,.pdf" onFiles={(f) => onPick(f[0])} label={label} hint="PDF" paste={false} />;
  return (
    <Panel className="flex items-center gap-3 p-3">
      <div className="w-12 shrink-0">
        <Thumb file={side.file} password={side.password} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium tracking-wide text-ink-3 uppercase">{label.replace(/^Choose (the )?/i, "")}</p>
        <p className="truncate text-sm font-medium">{side.file.name}</p>
        <p className="text-xs text-ink-3">{formatBytes(side.file.size)}</p>
      </div>
      <Button variant="ghost" size="iconSm" onClick={onClear} aria-label={`Remove ${side.file.name}`}>
        <X />
      </Button>
    </Panel>
  );
}

/** Collapse long unchanged stretches so the changes stand out. */
function condense(parts: DiffPart[], context = 160): (DiffPart & { gap?: boolean })[] {
  const out: (DiffPart & { gap?: boolean })[] = [];
  parts.forEach((p, i) => {
    if (p.added || p.removed || p.value.length <= context * 2 + 40) return out.push(p);
    const first = i === 0;
    const last = i === parts.length - 1;
    const head = first ? "" : p.value.slice(0, context);
    const tail = last ? "" : p.value.slice(-context);
    if (head) out.push({ value: head });
    out.push({ value: "", gap: true });
    if (tail) out.push({ value: tail });
  });
  return out;
}

function TextDiff({ r, onlyChanges }: { r: CompareResult; onlyChanges: boolean }) {
  const parts = useMemo(() => (onlyChanges ? condense(r.parts) : r.parts), [r, onlyChanges]);
  return (
    <div className="max-h-[70vh] overflow-auto rounded-md border border-line bg-white p-5 font-[Doc_Serif,serif] text-[15px] leading-relaxed whitespace-pre-wrap text-[#1b1b1b]">
      {parts.map((p, i) =>
        "gap" in p && p.gap ? (
          <span key={i} className="mx-1 inline-block rounded bg-[#eef0f4] px-2 font-sans text-xs text-[#6b7280]">
            … unchanged …
          </span>
        ) : p.added ? (
          <ins key={i} className="rounded-sm bg-[#d6f5dd] text-[#0a5c1f] underline decoration-[#0a5c1f]/40">
            {p.value}
          </ins>
        ) : p.removed ? (
          <del key={i} className="rounded-sm bg-[#fbd9d9] text-[#8a1111]">
            {p.value}
          </del>
        ) : (
          <span key={i}>{p.value}</span>
        ),
      )}
    </div>
  );
}

function VisualDiff({ a, b, pages }: { a: Src; b: Src; pages: number }) {
  const [page, setPage] = useState(1);
  const [view, setView] = useState("overlay");
  const [data, setData] = useState<{ a: string; b: string; diff: string; changed: number } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    import("@/lib/pdf/compare")
      .then((m) => m.visualDiff(a, b, page, 1.4))
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [a, b, page]);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="iconSm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="Previous page">
            <ChevronLeft />
          </Button>
          <span className="w-24 text-center text-sm tabular">
            Page {page} of {pages}
          </span>
          <Button variant="ghost" size="iconSm" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} aria-label="Next page">
            <ChevronRight />
          </Button>
        </div>
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "overlay", label: "Differences" },
            { value: "side", label: "Side by side" },
          ]}
          className="w-64"
        />
        {data ? (
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium tabular", data.changed > 0 ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok")}>
            {data.changed > 0 ? `${data.changed}% of the page changed` : "No visual change"}
          </span>
        ) : null}
        {busy ? <Spinner className="text-ink-3" /> : null}
      </div>
      {view === "overlay" ? (
        <div className="grid gap-2">
          {data?.diff ? <img src={data.diff} alt={`Differences on page ${page}`} className="mx-auto w-full max-w-3xl rounded border border-line bg-white" /> : <div className="aspect-[1/1.3] w-full max-w-3xl rounded border border-line bg-paper-2" />}
          <p className="text-center text-xs text-ink-3">
            <span className="font-medium text-[#c62828]">Red</span>: only in the original · <span className="font-medium text-[#1e8a3c]">Green</span>: only in the changed version
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {[data?.a, data?.b].map((src, i) => (
            <figure key={i} className="grid gap-1">
              {src ? <img src={src} alt="" className="w-full rounded border border-line bg-white" /> : <div className="grid aspect-[1/1.3] place-items-center rounded border border-dashed border-line text-xs text-ink-3">No page {page}</div>}
              <figcaption className="text-center text-xs text-ink-3">{i === 0 ? "Original" : "Changed"}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Compare({ tool }: { tool: Tool }) {
  const [a, setA] = useState<Side>(null);
  const [b, setB] = useState<Side>(null);
  const [srcs, setSrcs] = useState<[Src, Src] | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [textError, setTextError] = useState<string>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("text");
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [report, setReport] = useState<OutFile[] | null>(null);
  const [pages, setPages] = useState(1);
  const { progress, report: onProgress, reset } = useThrottledProgress();
  const { ask, dialog } = usePasswordPrompt();

  useEffect(() => {
    const pdfs = (take()?.files ?? []).filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (pdfs[0]) setA({ file: pdfs[0] });
    if (pdfs[1]) setB({ file: pdfs[1] });
  }, []);

  const clearResults = () => {
    setResult(null);
    setSrcs(null);
    setReport(null);
    setTextError(undefined);
  };

  const run = async () => {
    if (!a || !b) return;
    setRunning(true);
    setError(undefined);
    clearResults();
    reset("Reading both files");
    try {
      const sa = await srcWithPassword(a.file, a.password, ask);
      if (!sa) return;
      const sb = await srcWithPassword(b.file, b.password, ask);
      if (!sb) return;
      setA({ file: a.file, password: sa.password });
      setB({ file: b.file, password: sb.password });
      const m = await import("@/lib/pdf/compare");
      const { pageCountOf } = await import("@/lib/pdf/pdfjs");
      setPages(Math.max(await pageCountOf(sa.bytes, sa.password), await pageCountOf(sb.bytes, sb.password)));
      setSrcs([sa, sb]);
      try {
        const r = await m.compareText(sa, sb, onProgress);
        setResult(r);
        setTab("text");
      } catch (e) {
        setTextError(e instanceof Error ? e.message : String(e));
        setTab("visual");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const makeReport = async () => {
    if (!srcs || !result) return;
    const m = await import("@/lib/pdf/compare");
    const r = await m.compareReport(srcs[0], srcs[1], result);
    r.note = result.same ? "No text differences" : `${result.added} words added, ${result.removed} removed`;
    setReport([r]);
  };

  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Slot label="Choose the original" side={a} onPick={(f) => (setA({ file: f }), clearResults())} onClear={() => (setA(null), clearResults())} />
        <Button variant="ghost" size="icon" className="justify-self-center" onClick={() => (setA(b), setB(a), clearResults())} disabled={!a && !b} aria-label="Swap files" title="Swap">
          <ArrowLeftRight />
        </Button>
        <Slot label="Choose the changed version" side={b} onPick={(f) => (setB({ file: f }), clearResults())} onClear={() => (setB(null), clearResults())} />
      </div>
      {!srcs ? (
        <div className="grid justify-items-center gap-3">
          {running ? (
            <div className="w-full max-w-md">
              <Progress value={progress.value} label={progress.label} />
            </div>
          ) : (
            <Button variant="primary" size="lg" onClick={run} disabled={!a || !b}>
              {tool.cta}
            </Button>
          )}
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </div>
      ) : (
        <Panel className="grid gap-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            {result ? (
              result.same ? (
                <p className="font-semibold text-ok">The text is identical.</p>
              ) : (
                <p className="font-semibold">
                  <span className="text-[#1e8a3c] tabular">+{result.added}</span> words added, <span className="text-[#c62828] tabular">−{result.removed}</span> removed
                </p>
              )
            ) : null}
            <Segmented
              label="Comparison type"
              value={tab}
              onChange={setTab}
              options={[
                { value: "text", label: "Text" },
                { value: "visual", label: "Visual" },
              ]}
              className="w-56"
            />
            {tab === "text" && result && !result.same ? <Switch checked={onlyChanges} onChange={setOnlyChanges} label="Only show changes" /> : null}
            <div className="ml-auto flex gap-2">
              {result ? (
                <Button variant="secondary" size="sm" onClick={makeReport}>
                  Make PDF report
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={clearResults}>
                Done
              </Button>
            </div>
          </div>
          {report ? <ResultList results={report} tool={tool.slug} /> : null}
          {tab === "text" ? result ? <TextDiff r={result} onlyChanges={onlyChanges} /> : <Notice tone="warn">{textError}</Notice> : <VisualDiff a={srcs[0]} b={srcs[1]} pages={pages} />}
        </Panel>
      )}
      {dialog}
    </div>
  );
}
