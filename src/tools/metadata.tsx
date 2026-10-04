import { useEffect, useState } from "react";
import { DropZone } from "@/components/dropzone";
import { Thumb } from "@/components/file-card";
import { usePasswordPrompt } from "@/components/password";
import { ResultList } from "@/components/results";
import { Button, Field, Input, Notice, Panel, Spinner, Textarea } from "@/components/ui";
import { take } from "@/lib/handoff";
import type { OutFile } from "@/lib/pdf/core";
import type { Src } from "@/lib/pdf/pages";
import type { Tool } from "@/lib/tools/catalog";
import { formatBytes } from "@/lib/utils";
import { srcWithPassword } from "./compare";

type Meta = { title: string; author: string; subject: string; keywords: string; creator: string; producer: string; created: string; modified: string; pages: number };

export default function Metadata({ tool }: { tool: Tool }) {
  const [file, setFile] = useState<File | null>(null);
  const [src, setSrc] = useState<Src | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [form, setForm] = useState({ title: "", author: "", subject: "", keywords: "", creator: "" });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<OutFile[] | null>(null);
  const { ask, dialog } = usePasswordPrompt();

  const open = async (f: File) => {
    setFile(f);
    setLoading(true);
    setError(undefined);
    setResults(null);
    try {
      const s = await srcWithPassword(f, undefined, ask);
      if (!s) return setFile(null);
      setSrc(s);
      const { readMetadata } = await import("@/lib/pdf/security");
      const m = await readMetadata(s);
      setMeta(m);
      setForm({ title: m.title, author: m.author, subject: m.subject, keywords: m.keywords, creator: m.creator });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const f = take()?.files.find((x) => /\.pdf$/i.test(x.name) || x.type === "application/pdf");
    if (f) void open(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!src) return;
    setSaving(true);
    setError(undefined);
    try {
      const { setMetadata } = await import("@/lib/pdf/security");
      setResults([await setMetadata(src, form)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!file) return <DropZone accept="application/pdf,.pdf" onFiles={(f) => void open(f[0])} label={tool.input?.label ?? "Choose a PDF"} />;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Panel className="grid gap-3 p-4">
        <div className="mx-auto w-40">
          <Thumb file={file} password={src?.password} />
        </div>
        <p className="truncate text-center text-sm font-medium">{file.name}</p>
        {meta ? (
          <dl className="grid gap-1.5 text-[13px]">
            {[
              ["Pages", String(meta.pages)],
              ["Size", formatBytes(file.size)],
              ["Produced by", meta.producer || "—"],
              ["Created", meta.created ? new Date(meta.created).toLocaleString() : "—"],
              ["Modified", meta.modified ? new Date(meta.modified).toLocaleString() : "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-ink-3">{k}</dt>
                <dd className="truncate text-right text-ink" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => (setFile(null), setMeta(null), setResults(null))}>
          Choose another PDF
        </Button>
      </Panel>
      <Panel className="grid gap-4 p-5">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-ink-2">
            <Spinner /> Reading properties…
          </p>
        ) : meta ? (
          <>
            <Field label="Title" htmlFor="m-title" help="Shown in the browser tab and by search engines.">
              <Input id="m-title" value={form.title} onChange={set("title")} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Author" htmlFor="m-author">
                <Input id="m-author" value={form.author} onChange={set("author")} />
              </Field>
              <Field label="Created with" htmlFor="m-creator">
                <Input id="m-creator" value={form.creator} onChange={set("creator")} />
              </Field>
            </div>
            <Field label="Subject" htmlFor="m-subject">
              <Textarea id="m-subject" rows={2} value={form.subject} onChange={set("subject")} className="min-h-16" />
            </Field>
            <Field label="Keywords" htmlFor="m-keywords" help="Separate with commas.">
              <Input id="m-keywords" value={form.keywords} onChange={set("keywords")} />
            </Field>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={save} busy={saving} disabled={saving}>
                {tool.cta}
              </Button>
              <Button variant="ghost" onClick={() => setForm({ title: "", author: "", subject: "", keywords: "", creator: "" })}>
                Clear all fields
              </Button>
            </div>
            {results ? <ResultList results={results} tool={tool.slug} /> : null}
          </>
        ) : error ? (
          <Notice tone="danger">{error}</Notice>
        ) : null}
      </Panel>
      {dialog}
    </div>
  );
}
