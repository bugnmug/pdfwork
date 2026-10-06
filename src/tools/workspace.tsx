import { ArrowDownAZ, Plus, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DropZone, filterAccepted, useFilePicker } from "@/components/dropzone";
import { FileCard, Thumb } from "@/components/file-card";
import { OptionsForm } from "@/components/options";
import { isPasswordError, usePasswordPrompt } from "@/components/password";
import { ResultList } from "@/components/results";
import { Button, Notice, Panel, Progress } from "@/components/ui";
import { take } from "@/lib/handoff";
import { accepts, kindOf } from "@/lib/files";
import type { OutFile } from "@/lib/pdf/core";
import { fileInfo } from "@/lib/thumbs";
import { defaultsOf, type Tool, type Values } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";

export type Item = { id: string; file: File; password?: string };

let uid = 0;
export const toItems = (files: File[]): Item[] => files.map((file) => ({ id: `f${++uid}`, file }));

/** Progress reporting that re-renders at most ~10 times a second. */
export function useThrottledProgress() {
  const [progress, setProgress] = useState<{ value: number | null; label: string }>({ value: null, label: "" });
  const last = useRef(0);
  const pending = useRef<{ value: number | null; label: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const report = useCallback((value: number, label: string) => {
    pending.current = { value: Math.max(0, Math.min(1, value)), label };
    const now = performance.now();
    const flush = () => {
      timer.current = null;
      last.current = performance.now();
      if (pending.current) setProgress(pending.current);
    };
    if (now - last.current > 100) flush();
    else if (!timer.current) timer.current = setTimeout(flush, 100);
  }, []);
  const reset = useCallback((label = "Starting") => {
    pending.current = null;
    setProgress({ value: null, label });
  }, []);
  return { progress, report, reset };
}

export function useElapsed(running: boolean) {
  const [now, setNow] = useState(0);
  const start = useRef(0);
  useEffect(() => {
    if (!running) return;
    start.current = performance.now();
    setNow(0);
    const t = setInterval(() => setNow(performance.now() - start.current), 500);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

export function RunningPanel({ progress, elapsed, note }: { progress: { value: number | null; label: string }; elapsed: number; note?: string }) {
  return (
    <div className="grid gap-3" aria-busy="true">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium text-ink">Working on it…</p>
        <span className="text-xs text-ink-3 tabular">{Math.floor(elapsed / 1000)} s</span>
      </div>
      <Progress value={progress.value} label={progress.label || "Starting"} />
      <p className="text-xs text-ink-3">{note ?? "Everything happens in this tab. Keep it open until it finishes."}</p>
    </div>
  );
}

export default function Workspace({ tool }: { tool: Tool }) {
  const input = tool.input;
  const multiple = !!input?.multiple;
  const [items, setItems] = useState<Item[]>([]);
  const [values, setValues] = useState<Values>(() => defaultsOf(tool.options));
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [results, setResults] = useState<OutFile[]>([]);
  const [error, setError] = useState<string>();
  const [elapsed, setElapsed] = useState<number>();
  const [pageCount, setPageCount] = useState<number>();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const { progress, report, reset } = useThrottledProgress();
  const ticking = useElapsed(phase === "running");
  const { ask, dialog } = usePasswordPrompt();
  const resultsRef = useRef<HTMLDivElement>(null);

  // Files handed over from another tool or the home page.
  useEffect(() => {
    const parked = take();
    if (!parked || !input) return;
    const ok = parked.files.filter((f) => accepts(input.accept, f));
    if (ok.length) setItems(toItems(multiple ? ok : ok.slice(0, 1)));
  }, [input, multiple]);

  // Page count of the first PDF, for the "pages" option hint.
  const first = items.find((i) => kindOf(i.file) === "pdf");
  useEffect(() => {
    if (!first) return setPageCount(undefined);
    let alive = true;
    fileInfo(first.file, first.password ?? "").then((i) => alive && setPageCount(i.pages));
    return () => {
      alive = false;
    };
  }, [first]);

  const addFiles = useCallback(
    (files: File[]) => {
      setError(undefined);
      setPhase("idle");
      setItems((cur) => (multiple ? [...cur, ...toItems(files)] : toItems(files.slice(0, 1))));
    },
    [multiple],
  );
  const picker = useFilePicker(input?.accept, multiple, addFiles);

  const move = (from: number, to: number) => {
    setItems((cur) => {
      if (to < 0 || to >= cur.length || from === to) return cur;
      const next = cur.slice();
      const [it] = next.splice(from, 1);
      next.splice(to, 0, it);
      return next;
    });
    setPhase("idle");
  };

  const unlock = async (item: Item, wrong = false): Promise<boolean> => {
    const pw = await ask(item.file.name, wrong);
    if (pw == null) return false;
    const info = await fileInfo(item.file, pw);
    if (info.locked) return unlock(item, true);
    setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, password: pw } : i)));
    return true;
  };

  const minFiles = input?.optional ? 0 : (input?.min ?? (input ? 1 : 0));
  const ready = items.length >= minFiles;

  const run = async () => {
    setError(undefined);
    setPhase("running");
    reset();
    const t0 = performance.now();
    const passwords: Record<string, string> = {};
    for (const i of items) if (i.password) passwords[i.file.name] = i.password;
    // Ask up front for files we already know are protected (except the unlock tool, which has its own field).
    if (tool.slug !== "remove-password") {
      for (const i of items) {
        if (passwords[i.file.name] || kindOf(i.file) !== "pdf") continue;
        const info = await fileInfo(i.file);
        if (!info.locked) continue;
        const pw = await ask(i.file.name);
        if (pw == null) return setPhase("idle");
        passwords[i.file.name] = pw;
      }
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const out = await runTool(tool, { files: items.map((i) => i.file), options: values, passwords, onProgress: report });
        setResults(out);
        setElapsed(performance.now() - t0);
        setPhase("done");
        setItems((cur) => cur.map((i) => (passwords[i.file.name] ? { ...i, password: passwords[i.file.name] } : i)));
        requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
        return;
      } catch (e) {
        if (isPasswordError(e)) {
          const name = e.fileName && items.some((i) => i.file.name === e.fileName) ? e.fileName : (items.find((i) => kindOf(i.file) === "pdf")?.file.name ?? "This PDF");
          const pw = await ask(name, e.wrong || !!passwords[name]);
          if (pw == null) return setPhase("idle");
          passwords[name] = pw;
          continue;
        }
        console.error(e);
        setError(e instanceof Error ? e.message : String(e));
        setPhase("idle");
        return;
      }
    }
    setPhase("idle");
  };

  const startOver = () => {
    setItems([]);
    setResults([]);
    setPhase("idle");
    setError(undefined);
  };

  const inputBytes = useMemo(() => items.reduce((s, i) => s + i.file.size, 0), [items]);
  const formFirst = !input || input.optional;

  const optionsPanel = (
    <Panel className={cn("grid gap-5 p-5", !formFirst && "lg:sticky lg:top-20")}>
      {phase === "done" ? (
        <div ref={resultsRef}>
          <ResultList results={results} tool={tool.slug} elapsed={elapsed} inputBytes={inputBytes} onBack={() => setPhase("idle")} onReset={startOver} />
        </div>
      ) : phase === "running" ? (
        <RunningPanel progress={progress} elapsed={ticking} />
      ) : (
        <>
          {tool.options?.length ? <OptionsForm defs={tool.options} values={values} onChange={setValues} pageCount={pageCount} /> : <p className="text-sm text-ink-2">{tool.long}</p>}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <div className="grid gap-2">
            <Button variant="primary" size="lg" onClick={run} disabled={!ready} className="w-full">
              {tool.cta}
            </Button>
            {!ready && input ? <p className="text-center text-xs text-ink-3">{minFiles > 1 ? `Add at least ${minFiles} files.` : "Add a file first."}</p> : null}
            <p className="flex items-center justify-center gap-1.5 text-xs text-ink-3">
              <ShieldCheck className="size-3.5 text-ok" aria-hidden /> Runs on this device. Nothing is uploaded.
            </p>
          </div>
        </>
      )}
    </Panel>
  );

  if (formFirst) {
    return (
      <div className="mx-auto grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-4">
        {input ? (
          items.length ? (
            <div className="flex items-center gap-3 rounded-lg border border-line bg-paper p-3">
              <div className="w-10 shrink-0">
                <Thumb file={items[0].file} />
              </div>
              <p className="min-w-0 flex-1 truncate text-sm text-ink">{items[0].file.name}</p>
              <Button variant="ghost" size="sm" onClick={() => setItems([])} disabled={phase === "running"}>
                Remove
              </Button>
            </div>
          ) : (
            <DropZone compact accept={input.accept} onFiles={addFiles} label={input.label} hint="Optional. Or type in the box below." />
          )
        ) : null}
        {optionsPanel}
        {dialog}
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="grid gap-4">
        <DropZone accept={input?.accept} multiple={multiple} onFiles={addFiles} label={input?.label} />
        {dialog}
      </div>
    );
  }

  const numbered = multiple && items.length > 1;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section
        aria-label="Files"
        className="grid gap-3"
        onDragOver={(e) => {
          if (!dragId && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (dragId || !e.dataTransfer.files.length) return;
          e.preventDefault();
          const ok = filterAccepted(Array.from(e.dataTransfer.files), input?.accept);
          if (ok.length) addFiles(ok);
        }}
      >
        {picker.input}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink-2">
            {items.length} file{items.length === 1 ? "" : "s"}
            {numbered ? <span className="text-ink-3"> · drag the cards or tap the arrow buttons to reorder</span> : null}
          </p>
          <div className="flex gap-1">
            {numbered ? (
              <Button variant="ghost" size="sm" onClick={() => setItems((c) => [...c].sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true })))} disabled={phase === "running"}>
                <ArrowDownAZ /> Sort by name
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={startOver} disabled={phase === "running"}>
              Clear
            </Button>
          </div>
        </div>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {items.map((it, i) => (
            <li
              key={it.id}
              draggable={numbered && phase !== "running"}
              onDragStart={(e) => {
                setDragId(it.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", it.id);
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOverIndex(i);
              }}
              onDrop={(e) => {
                if (!dragId) return;
                e.preventDefault();
                const from = items.findIndex((x) => x.id === dragId);
                move(from, i);
                setDragId(null);
                setOverIndex(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverIndex(null);
              }}
              className={cn(numbered && "cursor-grab active:cursor-grabbing")}
            >
              <FileCard
                file={it.file}
                password={it.password}
                index={i}
                numbered={numbered}
                disabled={phase === "running"}
                dragging={dragId === it.id}
                dropBefore={overIndex === i && dragId !== it.id}
                onRemove={() => {
                  setItems((c) => c.filter((x) => x.id !== it.id));
                  setPhase("idle");
                }}
                onMove={numbered ? (d) => move(i, i + d) : undefined}
                onUnlock={() => void unlock(it)}
              />
            </li>
          ))}
          {multiple ? (
            <li>
              <button
                type="button"
                onClick={picker.open}
                disabled={phase === "running"}
                className="grid size-full min-h-40 place-items-center rounded-lg border-2 border-dashed border-line text-ink-2 transition-colors hover:border-carbon hover:text-carbon"
              >
                <span className="grid justify-items-center gap-1.5 text-sm font-medium">
                  <Plus className="size-6" strokeWidth={1.6} />
                  Add more
                </span>
              </button>
            </li>
          ) : null}
        </ul>
      </section>
      <aside aria-label="Options">{optionsPanel}</aside>
      {dialog}
    </div>
  );
}

async function runTool(...args: Parameters<typeof import("@/lib/pdf/run").runTool>) {
  const m = await import("@/lib/pdf/run");
  return m.runTool(...args);
}
