import { ArrowDown, ArrowUp, ChevronDown, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DropZone, useFilePicker } from "@/components/dropzone";
import { IconTile } from "@/components/icons";
import { OptionsForm } from "@/components/options";
import { isPasswordError, usePasswordPrompt } from "@/components/password";
import { ResultList } from "@/components/results";
import { Button, Input, Notice, Panel, Progress, Select } from "@/components/ui";
import { outToFile, take } from "@/lib/handoff";
import type { OutFile } from "@/lib/pdf/core";
import { usePersistent } from "@/lib/storage";
import { fileInfo } from "@/lib/thumbs";
import { defaultsOf, TOOL_BY_SLUG, type Tool, type Values } from "@/lib/tools/catalog";
import { cn, formatBytes } from "@/lib/utils";
import { useThrottledProgress } from "./workspace";

/** Tools that take one PDF and give back one PDF, so they can be chained. */
const STEPS = ["rotate-pdf", "remove-pages", "extract-pages", "repair-pdf", "ocr-pdf", "crop-pdf", "resize-pdf", "n-up", "flip-pdf", "split-in-half", "page-numbers", "header-footer", "watermark", "stamp-image", "grayscale-pdf", "invert-pdf", "flatten-pdf", "sanitize-pdf", "compress-pdf", "pdf-to-pdfa", "encrypt-pdf"];

type Step = { id: string; slug: string; values: Values };
type Saved = { name: string; steps: { slug: string; values: Values }[] };

let n = 0;
const step = (slug: string, values?: Values): Step => ({ id: `s${++n}`, slug, values: { ...defaultsOf(TOOL_BY_SLUG[slug].options), ...values } });

const PRESETS: { name: string; steps: () => Step[] }[] = [
  { name: "Email-ready", steps: () => [step("compress-pdf"), step("sanitize-pdf")] },
  { name: "Confidential handout", steps: () => [step("watermark", { text: "CONFIDENTIAL" }), step("page-numbers", { format: "Page {n} of {total}" }), step("compress-pdf")] },
  { name: "Scan archive", steps: () => [step("ocr-pdf"), step("compress-pdf"), step("pdf-to-pdfa")] },
  { name: "Print booklet prep", steps: () => [step("resize-pdf"), step("page-numbers", { mirror: true })] },
];

/** Files can't be stored, so saved workflows drop file options (like a watermark image). */
const storable = (v: Values) => Object.fromEntries(Object.entries(v).filter(([, x]) => !(x instanceof File)));

export default function Workflow({ tool }: { tool: Tool }) {
  const [steps, setSteps] = useState<Step[]>(() => PRESETS[1].steps());
  const [open, setOpen] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [saved, setSaved] = usePersistent<Saved[]>("workflows", []);
  const [name, setName] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<OutFile[] | null>(null);
  const [elapsed, setElapsed] = useState<number>();
  const { progress, report, reset } = useThrottledProgress();
  const { ask, dialog } = usePasswordPrompt();
  const picker = useFilePicker("application/pdf,.pdf", true, (f) => (setFiles((c) => [...c, ...f]), setResults(null)));

  useEffect(() => {
    const parked = take()?.files.filter((x) => /\.pdf$/i.test(x.name) || x.type === "application/pdf");
    if (parked?.length) setFiles(parked);
  }, []);

  const encryptIndex = steps.findIndex((s) => s.slug === "encrypt-pdf");
  const encryptNotLast = encryptIndex >= 0 && encryptIndex < steps.length - 1;
  const totalSize = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files]);

  const move = (i: number, d: -1 | 1) =>
    setSteps((cur) => {
      const j = i + d;
      if (j < 0 || j >= cur.length) return cur;
      const next = cur.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const run = async () => {
    if (!files.length || !steps.length) return;
    setRunning(true);
    setError(undefined);
    setResults(null);
    reset();
    const t0 = performance.now();
    const { runTool } = await import("@/lib/pdf/run");
    const outs: OutFile[] = [];
    try {
      for (let fi = 0; fi < files.length; fi++) {
        let current = files[fi];
        const passwords: Record<string, string> = {};
        const info = await fileInfo(current);
        if (info.locked) {
          const pw = await ask(current.name);
          if (pw == null) throw new Error(`Skipped: ${current.name} needs its password.`);
          passwords[current.name] = pw;
        }
        for (let si = 0; si < steps.length; si++) {
          const st = steps[si];
          const t = TOOL_BY_SLUG[st.slug];
          const label = `${files.length > 1 ? `${current.name.slice(0, 28)} · ` : ""}${si + 1}/${steps.length} ${t.name}`;
          const base = (fi + si / steps.length) / files.length;
          let out: OutFile[];
          for (;;) {
            try {
              out = await runTool(t, { files: [current], options: st.values, passwords, onProgress: (f, l) => report(base + f / steps.length / files.length, `${label}: ${l}`) });
              break;
            } catch (e) {
              if (!isPasswordError(e)) throw new Error(`${t.name} failed on ${current.name}: ${e instanceof Error ? e.message : String(e)}`);
              const pw = await ask(current.name, !!passwords[current.name]);
              if (pw == null) throw new Error(`Stopped: ${current.name} needs its password.`);
              passwords[current.name] = pw;
            }
          }
          const pdf = out.find((o) => o.mime === "application/pdf");
          if (!pdf) throw new Error(`${t.name} didn't produce a PDF, so the next step can't continue.`);
          // Keep the original name through the chain so the final file is recognisable.
          const finalName = files[fi].name.replace(/\.pdf$/i, "") + "-processed.pdf";
          current = outToFile({ ...pdf, filename: si === steps.length - 1 ? finalName : files[fi].name });
          if (st.slug === "encrypt-pdf") passwords[current.name] = String(st.values.userPassword ?? "");
        }
        outs.push({ filename: current.name, bytes: new Uint8Array(await current.arrayBuffer()), mime: "application/pdf", note: `${formatBytes(files[fi].size)} → ${formatBytes(current.size)}` });
      }
      if (outs.length > 1) {
        const { withZip } = await import("@/lib/pdf/pages");
        setResults(await withZip(outs, "workflow-results.zip"));
      } else setResults(outs);
      setElapsed(performance.now() - t0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const saveWorkflow = () => {
    const nm = name.trim() || `Workflow ${saved.length + 1}`;
    setSaved((cur) => [...cur.filter((s) => s.name !== nm), { name: nm, steps: steps.map((s) => ({ slug: s.slug, values: storable(s.values) })) }]);
    toast.success(`Saved “${nm}”`);
    setName("");
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="grid gap-4">
        <Panel className="grid gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-ink-2">Start from</span>
            {PRESETS.map((p) => (
              <button key={p.name} type="button" onClick={() => (setSteps(p.steps()), setOpen(null))} className="rounded-full border border-line bg-paper px-3 py-1 text-[13px] hover:border-carbon hover:text-carbon">
                {p.name}
              </button>
            ))}
            {saved.map((s) => (
              <span key={s.name} className="flex items-center rounded-full border border-carbon/30 bg-carbon-soft text-[13px] text-carbon">
                <button type="button" className="py-1 pr-1 pl-3" onClick={() => (setSteps(s.steps.map((x) => step(x.slug, x.values))), setOpen(null))}>
                  {s.name}
                </button>
                <button type="button" className="py-1 pr-2 pl-1 opacity-60 hover:opacity-100" onClick={() => setSaved((cur) => cur.filter((x) => x.name !== s.name))} aria-label={`Delete saved workflow ${s.name}`}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        </Panel>

        <ol className="grid gap-2">
          {steps.map((s, i) => {
            const t = TOOL_BY_SLUG[s.slug];
            const isOpen = open === s.id;
            return (
              <li key={s.id}>
                <Panel className="overflow-hidden">
                  <div className="flex items-center gap-3 p-3">
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold text-paper tabular">{i + 1}</span>
                    <IconTile name={t.icon} category={t.category} size="sm" />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(isOpen ? null : s.id)} aria-expanded={isOpen}>
                      <span className="block truncate text-sm font-medium">{t.name}</span>
                      <span className="block truncate text-xs text-ink-3">{t.options?.length ? (isOpen ? "Hide options" : "Tap to change options") : "No options"}</span>
                    </button>
                    {t.options?.length ? <ChevronDown className={cn("size-4 text-ink-3 transition-transform", isOpen && "rotate-180")} /> : null}
                    <div className="flex">
                      <Button variant="ghost" size="iconSm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                        <ArrowUp />
                      </Button>
                      <Button variant="ghost" size="iconSm" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="Move down">
                        <ArrowDown />
                      </Button>
                      <Button variant="ghost" size="iconSm" onClick={() => setSteps((c) => c.filter((x) => x.id !== s.id))} aria-label={`Remove ${t.name}`} className="hover:text-danger">
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  {isOpen && t.options?.length ? (
                    <div className="border-t border-line-2 p-4">
                      <OptionsForm defs={t.options} values={s.values} onChange={(v) => setSteps((c) => c.map((x) => (x.id === s.id ? { ...x, values: v } : x)))} />
                    </div>
                  ) : null}
                </Panel>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Add a step"
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              const s = step(e.target.value);
              setSteps((c) => (c.some((x) => x.slug === "encrypt-pdf") && e.target.value !== "encrypt-pdf" ? [...c.slice(0, -1), s, c[c.length - 1]] : [...c, s]));
              setOpen(s.id);
            }}
            className="w-64"
          >
            <option value="">+ Add a step…</option>
            {STEPS.map((sl) => (
              <option key={sl} value={sl}>
                {TOOL_BY_SLUG[sl].name}
              </option>
            ))}
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this workflow" className="h-9 w-48 text-[13px]" aria-label="Workflow name" />
            <Button variant="secondary" size="sm" onClick={saveWorkflow} disabled={!steps.length}>
              <Save /> Save
            </Button>
          </div>
        </div>
        {encryptNotLast ? <Notice tone="warn">Protect PDF works best as the last step. Steps after it have to unlock the file first.</Notice> : null}
      </div>

      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel className="grid gap-4 p-4">
          {picker.input}
          {files.length ? (
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  {files.length} PDF{files.length === 1 ? "" : "s"} <span className="font-normal text-ink-3">· {formatBytes(totalSize)}</span>
                </p>
                <Button variant="ghost" size="sm" onClick={picker.open} disabled={running}>
                  <Plus /> Add
                </Button>
              </div>
              <ul className="grid max-h-52 gap-1 overflow-auto">
                {files.map((f, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-md bg-paper-2 px-2.5 py-1.5 text-[13px]">
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span className="shrink-0 text-xs text-ink-3 tabular">{formatBytes(f.size)}</span>
                    <button type="button" onClick={() => setFiles((c) => c.filter((_, j) => j !== i))} disabled={running} aria-label={`Remove ${f.name}`} className="text-ink-3 hover:text-danger">
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <DropZone compact multiple accept="application/pdf,.pdf" onFiles={(f) => setFiles(f)} label="Choose PDFs" />
          )}
          {running ? <Progress value={progress.value} label={progress.label} /> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button variant="primary" size="lg" onClick={run} disabled={!files.length || !steps.length || running} busy={running}>
            {tool.cta} {steps.length ? `(${steps.length} step${steps.length === 1 ? "" : "s"})` : ""}
          </Button>
          {results ? <ResultList results={results} tool={tool.slug} elapsed={elapsed} onReset={() => (setResults(null), setFiles([]))} resetLabel="New batch" /> : null}
        </Panel>
      </aside>
      {dialog}
    </div>
  );
}
