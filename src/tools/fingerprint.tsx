import { Check, CircleCheck, CircleX, Copy, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DropZone, useFilePicker } from "@/components/dropzone";
import { ResultList } from "@/components/results";
import { Button, Input, Panel, Spinner } from "@/components/ui";
import { take } from "@/lib/handoff";
import type { OutFile } from "@/lib/pdf/core";
import type { Fingerprint } from "@/lib/pdf/security";
import type { Tool } from "@/lib/tools/catalog";
import { cn, formatBytes } from "@/lib/utils";

function HashRow({ label, value, match }: { label: string; value: string; match: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("grid gap-1 rounded-md px-3 py-2", match ? "bg-ok-soft ring-1 ring-ok/40" : "bg-paper-2")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-3">{label}</span>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="flex items-center gap-1 text-xs text-carbon hover:underline"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <code className="font-mono text-[12.5px] break-all text-ink">{value}</code>
    </div>
  );
}

export default function FingerprintTool({ tool }: { tool: Tool }) {
  const [items, setItems] = useState<{ file: File; fp?: Fingerprint; error?: string }[]>([]);
  const [verify, setVerify] = useState("");
  const [report, setReport] = useState<OutFile[] | null>(null);

  const add = (files: File[]) => {
    setReport(null);
    setItems((cur) => [...cur, ...files.map((file) => ({ file }))]);
  };
  const picker = useFilePicker("*/*", true, add);

  useEffect(() => {
    const parked = take();
    if (parked?.files.length) add(parked.files);
  }, []);

  useEffect(() => {
    const todo = items.findIndex((i) => !i.fp && !i.error);
    if (todo < 0) return;
    let alive = true;
    (async () => {
      const { fingerprint } = await import("@/lib/pdf/security");
      const it = items[todo];
      try {
        const fp = await fingerprint(new Uint8Array(await it.file.arrayBuffer()), it.file.name);
        if (alive) setItems((cur) => cur.map((x) => (x.file === it.file ? { ...x, fp } : x)));
      } catch (e) {
        if (alive) setItems((cur) => cur.map((x) => (x.file === it.file ? { ...x, error: e instanceof Error ? e.message : String(e) } : x)));
      }
    })();
    return () => {
      alive = false;
    };
  }, [items]);

  const want = verify.replace(/[\s:-]/g, "").toLowerCase();
  const matchOf = (fp?: Fingerprint) => !!want && !!fp && [fp.sha256, fp.sha512, fp.sha1, fp.md5].includes(want);
  const anyMatch = items.some((i) => matchOf(i.fp));

  const makeReport = async () => {
    const { fingerprintReport } = await import("@/lib/pdf/security");
    const done = items.filter((i) => i.fp);
    const text = done.map((i) => fingerprintReport(i.fp!)).join("\n\n" + "=".repeat(60) + "\n\n");
    setReport([{ filename: done.length === 1 ? `${done[0].file.name}.fingerprint.txt` : "fingerprints.txt", bytes: new TextEncoder().encode(text), mime: "text/plain" }]);
  };

  if (!items.length) return <DropZone accept="*/*" multiple onFiles={add} label={tool.input?.label ?? "Choose files"} hint="Any file type: PDF, images, documents, archives" />;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="grid gap-3">
        {picker.input}
        {items.map((it, i) => (
          <Panel key={i} className="grid gap-3 p-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{it.file.name}</p>
                <p className="text-xs text-ink-3 tabular">
                  {formatBytes(it.file.size)} · {it.file.size.toLocaleString()} bytes
                </p>
              </div>
              {matchOf(it.fp) ? (
                <span className="flex items-center gap-1 rounded-full bg-ok-soft px-2 py-1 text-xs font-medium text-ok">
                  <CircleCheck className="size-3.5" /> Matches
                </span>
              ) : null}
              <Button variant="ghost" size="iconSm" onClick={() => setItems((c) => c.filter((_, j) => j !== i))} aria-label={`Remove ${it.file.name}`}>
                <X />
              </Button>
            </div>
            {it.error ? (
              <p className="text-sm text-danger">{it.error}</p>
            ) : !it.fp ? (
              <p className="flex items-center gap-2 text-sm text-ink-2">
                <Spinner /> Hashing…
              </p>
            ) : (
              <>
                <div className="grid gap-2">
                  <HashRow label="SHA-256" value={it.fp.sha256} match={want === it.fp.sha256} />
                  <HashRow label="SHA-512" value={it.fp.sha512} match={want === it.fp.sha512} />
                  <HashRow label="MD5" value={it.fp.md5} match={want === it.fp.md5} />
                  <HashRow label="SHA-1" value={it.fp.sha1} match={want === it.fp.sha1} />
                </div>
                {it.fp.pdf ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-3">
                    {[
                      ["PDF version", it.fp.pdf.version],
                      ["Pages", String(it.fp.pdf.pages)],
                      ["Encrypted", it.fp.pdf.encrypted ? "Yes" : "No"],
                      ["Title", it.fp.pdf.title],
                      ["Author", it.fp.pdf.author],
                      ["Created with", it.fp.pdf.creator],
                      ["Produced by", it.fp.pdf.producer],
                      ["Created", it.fp.pdf.created ? new Date(it.fp.pdf.created).toLocaleString() : undefined],
                      ["Modified", it.fp.pdf.modified ? new Date(it.fp.pdf.modified).toLocaleString() : undefined],
                      ["Form fields", it.fp.pdf.forms ? String(it.fp.pdf.forms) : undefined],
                      ["Attachments", it.fp.pdf.attachments ? String(it.fp.pdf.attachments) : undefined],
                      ["Scripts", it.fp.pdf.javascript ? "Yes" : undefined],
                    ]
                      .filter(([, v]) => v)
                      .map(([k, v]) => (
                        <div key={k} className="min-w-0">
                          <dt className="text-xs text-ink-3">{k}</dt>
                          <dd className="truncate text-ink" title={v}>
                            {v}
                          </dd>
                        </div>
                      ))}
                    {it.fp.pdf.ids?.length ? (
                      <div className="col-span-full min-w-0">
                        <dt className="text-xs text-ink-3">Document ID</dt>
                        <dd className="font-mono text-xs break-all text-ink">{it.fp.pdf.ids.join(" / ")}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
              </>
            )}
          </Panel>
        ))}
        <Button variant="ghost" className="justify-self-start" onClick={picker.open}>
          <Plus /> Add more files
        </Button>
      </div>
      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel className="grid gap-3 p-4">
          <label htmlFor="verify-hash" className="text-[13px] font-medium text-ink-2">
            Check against a hash you were given
          </label>
          <Input id="verify-hash" value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="Paste any SHA-256, SHA-512, MD5 or SHA-1 value" spellCheck={false} className="font-mono text-[13px]" />
          {want ? (
            anyMatch ? (
              <p className="flex items-center gap-1.5 text-sm font-medium text-ok">
                <CircleCheck className="size-4" /> Match: the file is exactly the one that hash describes.
              </p>
            ) : (
              <p className="flex items-center gap-1.5 text-sm font-medium text-danger">
                <CircleX className="size-4" /> No match. The file differs from the one the hash came from (or the hash was copied wrongly).
              </p>
            )
          ) : null}
          <Button
            variant="primary"
            onClick={() => {
              makeReport().catch((e) => toast.error(String(e)));
            }}
            disabled={!items.some((i) => i.fp)}
          >
            Download fingerprint report
          </Button>
          {report ? <ResultList results={report} tool={tool.slug} /> : null}
          <p className="text-xs text-ink-3">A hash changes completely if even one byte of the file changes, so matching hashes prove two files are identical.</p>
        </Panel>
      </aside>
    </div>
  );
}
