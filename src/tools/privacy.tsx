import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Eraser, ScanSearch, ShieldAlert, ShieldCheck, SquareSlash } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DropZone } from "@/components/dropzone";
import { Thumb } from "@/components/file-card";
import { usePasswordPrompt } from "@/components/password";
import { ResultList } from "@/components/results";
import { Button, Input, Notice, Panel, Progress, Switch } from "@/components/ui";
import { park, take } from "@/lib/handoff";
import type { OutFile } from "@/lib/pdf/core";
import type { Src } from "@/lib/pdf/pages";
import type { PiiKind } from "@/lib/pdf/pii";
import type { Finding } from "@/lib/pdf/redact";
import type { HiddenItem } from "@/lib/pdf/security";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";
import { srcWithPassword } from "./compare";
import { useThrottledProgress } from "./workspace";

const LABEL: Record<string, string> = {
  email: "Email addresses",
  phone: "Phone numbers",
  aadhaar: "Aadhaar numbers",
  pan: "PAN numbers",
  gstin: "GSTINs",
  ifsc: "IFSC codes",
  upi: "UPI IDs",
  card: "Card numbers",
  bank: "Bank account numbers",
  passport: "Passport numbers",
  voterid: "Voter IDs",
  ssn: "US Social Security numbers",
  iban: "IBANs",
  ip: "IP addresses",
  dob: "Dates of birth",
  custom: "Your words and patterns",
};

function maskValue(v: string) {
  const s = v.trim();
  if (s.length <= 4) return "•".repeat(s.length);
  return s.slice(0, 2) + "•".repeat(Math.max(1, s.length - 4)) + s.slice(-2);
}

export default function Privacy({ tool }: { tool: Tool }) {
  const isScanner = tool.slug === "privacy-scanner";
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [src, setSrc] = useState<Src | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [meta, setMeta] = useState<{ pages: number; textPages: number } | null>(null);
  const [hidden, setHidden] = useState<HiddenItem[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [terms, setTerms] = useState("");
  const [regex, setRegex] = useState("");
  const [showValues, setShowValues] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<OutFile[] | null>(null);
  const { progress, report, reset } = useThrottledProgress();
  const { ask, dialog } = usePasswordPrompt();

  const scan = async (f: File, base?: Src) => {
    setScanning(true);
    setError(undefined);
    setResults(null);
    reset("Reading the text");
    try {
      const s = base ?? (await srcWithPassword(f, undefined, ask));
      if (!s) {
        setFile(null);
        return;
      }
      setSrc(s);
      const { scanDocument } = await import("@/lib/pdf/redact");
      const r = await scanDocument(s, { terms: terms.split(/[,\n]/).map((t) => t.trim()).filter(Boolean), regex }, report);
      setFindings(r.findings);
      setMeta({ pages: r.pages, textPages: r.textPages });
      // Tick everything: leaking personal data is worse than over-redacting. Uncertain ones are flagged "check".
      setChecked(new Set(r.findings.map((_, i) => i)));
      if (isScanner) {
        const { inspectHidden } = await import("@/lib/pdf/security");
        setHidden(await inspectHidden(s));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    const f = take()?.files.find((x) => /\.pdf$/i.test(x.name) || x.type === "application/pdf");
    if (f) {
      setFile(f);
      void scan(f);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => {
    const m = new Map<PiiKind, number[]>();
    (findings ?? []).forEach((f, i) => m.set(f.kind, [...(m.get(f.kind) ?? []), i]));
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [findings]);

  const redact = async () => {
    if (!src || !findings) return;
    const chosen = findings.filter((_, i) => checked.has(i));
    if (!chosen.length) return setError("Tick at least one item to redact.");
    setRedacting(true);
    setError(undefined);
    reset("Redacting");
    try {
      const { redactBoxes, redactionReport } = await import("@/lib/pdf/redact");
      const pdf = await redactBoxes(src, chosen.flatMap((f) => f.boxes), {}, report);
      pdf.filename = src.name.replace(/\.pdf$/i, "") + "-redacted.pdf";
      pdf.note = `${chosen.length} item${chosen.length === 1 ? "" : "s"} removed`;
      const log: OutFile = { filename: src.name.replace(/\.pdf$/i, "") + "-redaction-log.txt", bytes: new TextEncoder().encode(redactionReport(src.name, chosen, meta?.pages ?? 0)), mime: "text/plain", note: "What was removed (masked)" };
      setResults([pdf, log]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRedacting(false);
    }
  };

  const downloadReport = async () => {
    if (!src || !findings) return;
    const { redactionReport } = await import("@/lib/pdf/redact");
    const hiddenText = hidden?.length ? `\n\nHidden data\n${"-".repeat(40)}\n${hidden.map((h) => `[${h.risk.toUpperCase()}] ${h.label}: ${h.detail}`).join("\n")}` : "";
    const text = redactionReport(src.name, findings, meta?.pages ?? 0, "Privacy scan") + (findings.length ? "" : "\nNo personal data found in the text.") + hiddenText;
    setResults([{ filename: src.name.replace(/\.pdf$/i, "") + "-privacy-report.txt", bytes: new TextEncoder().encode(text), mime: "text/plain", note: `${findings.length} personal data item${findings.length === 1 ? "" : "s"}` }]);
  };

  const handTo = (slug: string) => {
    if (!file) return;
    park([file], tool.slug);
    void navigate({ to: "/$slug", params: { slug } });
  };

  if (!file)
    return (
      <div className="grid gap-4">
        <DropZone
          accept="application/pdf,.pdf"
          onFiles={(f) => {
            setFile(f[0]);
            void scan(f[0]);
          }}
          label={tool.input?.label ?? "Choose a PDF"}
        />
        {dialog}
      </div>
    );

  const high = (findings ?? []).filter((f) => f.confidence === "high").length;
  const risky = (hidden ?? []).filter((h) => h.risk !== "low").length;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="grid gap-4">
        <Panel className="flex items-center gap-3 p-3">
          <div className="w-10 shrink-0">
            <Thumb file={file} password={src?.password} />
          </div>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</p>
          <Button variant="ghost" size="sm" onClick={() => (setFile(null), setFindings(null), setHidden(null), setSrc(null), setResults(null))}>
            Change file
          </Button>
        </Panel>
        {scanning ? (
          <Panel className="p-6">
            <Progress value={progress.value} label={progress.label} />
          </Panel>
        ) : findings ? (
          <>
            {meta && meta.textPages === 0 ? (
              <Notice tone="warn">This looks like a scan, so personal details can&apos;t be spotted yet. Open it in OCR: Searchable PDF first, then check it again.</Notice>
            ) : (
              <Panel className={cn("flex items-start gap-3 p-4", findings.length ? "border-warn/40 bg-warn-soft/40" : "border-ok/40 bg-ok-soft/40")}>
                {findings.length ? <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warn" /> : <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" />}
                <div>
                  <p className="font-semibold">{findings.length ? `${findings.length} item${findings.length === 1 ? "" : "s"} of personal data found` : "No personal data found in the text"}</p>
                  <p className="text-sm text-ink-2">
                    {findings.length ? (high === findings.length ? "All matches passed format and checksum tests." : `${high} passed format and checksum tests. The ${findings.length - high} marked “check” look right but failed one, so take a look.`) : "Add your own words or a pattern on the right if you expected matches."}
                    {meta ? ` Scanned ${meta.textPages} of ${meta.pages} page${meta.pages === 1 ? "" : "s"}.` : ""}
                  </p>
                </div>
              </Panel>
            )}
            {groups.map(([kind, idx]) => {
              const all = idx.every((i) => checked.has(i));
              return (
                <Panel key={kind} className="overflow-hidden">
                  <details open={findings.length <= 40}>
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                      {!isScanner ? (
                        <input
                          type="checkbox"
                          checked={all}
                          ref={(el) => {
                            if (el) el.indeterminate = !all && idx.some((i) => checked.has(i));
                          }}
                          onChange={() =>
                            setChecked((c) => {
                              const n = new Set(c);
                              idx.forEach((i) => (all ? n.delete(i) : n.add(i)));
                              return n;
                            })
                          }
                          onClick={(e) => e.stopPropagation()}
                          className="size-4 accent-[var(--carbon)]"
                          aria-label={`Select all ${LABEL[kind] ?? kind}`}
                        />
                      ) : null}
                      <span className="flex-1 font-medium">{LABEL[kind] ?? kind}</span>
                      <span className="rounded-full bg-paper-2 px-2 py-0.5 text-xs text-ink-2 tabular">{idx.length}</span>
                      <ChevronDown className="size-4 text-ink-3" />
                    </summary>
                    <ul className="divide-y divide-line-2 border-t border-line-2">
                      {idx.map((i) => {
                        const f = findings[i];
                        return (
                          <li key={i}>
                            <label className="flex items-center gap-3 px-4 py-2 text-sm">
                              {!isScanner ? (
                                <input
                                  type="checkbox"
                                  checked={checked.has(i)}
                                  onChange={() =>
                                    setChecked((c) => {
                                      const n = new Set(c);
                                      if (n.has(i)) n.delete(i);
                                      else n.add(i);
                                      return n;
                                    })
                                  }
                                  className="size-4 accent-[var(--carbon)]"
                                />
                              ) : null}
                              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{showValues ? f.value : maskValue(f.value)}</span>
                              {f.confidence === "medium" ? <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[11px] text-warn">check</span> : null}
                              <span className="shrink-0 text-xs text-ink-3 tabular">p. {f.page + 1}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                </Panel>
              );
            })}
            {isScanner && hidden ? (
              <Panel className="grid gap-3 p-4">
                <p className="font-semibold">Hidden data</p>
                {hidden.length ? (
                  <ul className="grid gap-2">
                    {hidden.map((h) => (
                      <li key={h.label} className="flex items-start gap-3 rounded-md bg-paper-2 px-3 py-2 text-sm">
                        <span className={cn("mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase", h.risk === "high" ? "bg-danger-soft text-danger" : h.risk === "medium" ? "bg-warn-soft text-warn" : "bg-line-2 text-ink-3")}>{h.risk}</span>
                        <span className="min-w-0">
                          <span className="font-medium text-ink">{h.label}</span>
                          <span className="block break-words text-ink-2">{h.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-2">No hidden metadata, scripts, attachments or comments.</p>
                )}
                {risky || hidden.some((h) => h.fix === "sanitize") ? (
                  <Button variant="secondary" className="justify-self-start" onClick={() => handTo("sanitize-pdf")}>
                    <Eraser /> Remove hidden data
                  </Button>
                ) : null}
              </Panel>
            ) : null}
          </>
        ) : error ? (
          <Notice tone="danger">{error}</Notice>
        ) : null}
      </div>

      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel className="grid gap-4 p-4">
          <div className="grid gap-1.5">
            <label htmlFor="pii-terms" className="text-[13px] font-medium text-ink-2">
              Also find these words
            </label>
            <Input id="pii-terms" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Names, client code, address…" />
            <p className="text-xs text-ink-3">Separate with commas.</p>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="pii-regex" className="text-[13px] font-medium text-ink-2">
              Custom pattern (optional)
            </label>
            <Input id="pii-regex" value={regex} onChange={(e) => setRegex(e.target.value)} placeholder="e.g. EMP-\d{5}" spellCheck={false} className="font-mono text-[13px]" />
          </div>
          <Button variant="secondary" onClick={() => file && void scan(file, src ?? undefined)} disabled={scanning}>
            <ScanSearch /> Scan again
          </Button>
          <Switch checked={showValues} onChange={setShowValues} label="Show full values" />
          {error && findings ? <Notice tone="danger">{error}</Notice> : null}
          {redacting ? <Progress value={progress.value} label={progress.label} /> : null}
          {results ? (
            <ResultList results={results} tool={tool.slug} />
          ) : isScanner ? (
            <div className="grid gap-2">
              <Button variant="primary" onClick={downloadReport} disabled={!findings}>
                Download report
              </Button>
              {findings?.length ? (
                <Button variant="secondary" onClick={() => handTo("auto-redact")}>
                  <SquareSlash /> Redact what was found
                </Button>
              ) : null}
            </div>
          ) : (
            <Button variant="primary" size="lg" onClick={redact} disabled={!findings?.length || !checked.size || redacting} busy={redacting}>
              {tool.cta} ({checked.size})
            </Button>
          )}
          <p className="text-xs text-ink-3">Scanning happens on this device. Redacting paints the boxes into the page and deletes whatever text was under them; everything else stays searchable.</p>
        </Panel>
      </aside>
      {dialog}
    </div>
  );
}
