import { useNavigate } from "@tanstack/react-router";
import { PenLine } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DropZone } from "@/components/dropzone";
import { Thumb } from "@/components/file-card";
import { usePasswordPrompt } from "@/components/password";
import { ResultList } from "@/components/results";
import { Button, Input, Notice, Panel, Select, Spinner, Switch, Textarea } from "@/components/ui";
import { park, take } from "@/lib/handoff";
import type { OutFile } from "@/lib/pdf/core";
import type { FieldInfo } from "@/lib/pdf/forms";
import type { Src } from "@/lib/pdf/pages";
import type { Tool } from "@/lib/tools/catalog";
import { srcWithPassword } from "./compare";

/** "applicant.firstName_1" → "Applicant first name 1" */
function humanize(name: string) {
  const last = name.split(".").slice(-2).join(" ");
  const s = last
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
}

function FieldInput({ f, value, onChange }: { f: FieldInfo; value: string; onChange: (v: string) => void }) {
  const id = `field-${f.name}`;
  switch (f.kind) {
    case "multiline":
      return <Textarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} disabled={f.readOnly} maxLength={f.maxLength} className="min-h-20" />;
    case "checkbox":
      return <Switch id={id} checked={value === "true"} onChange={(v) => onChange(v ? "true" : "false")} label={value === "true" ? "Ticked" : "Not ticked"} />;
    case "radio":
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-2" role="radiogroup" aria-labelledby={`${id}-label`}>
          {(f.options ?? []).map((o) => (
            <label key={o} className="flex items-center gap-1.5 text-sm">
              <input type="radio" name={id} checked={value === o} onChange={() => onChange(o)} disabled={f.readOnly} className="size-4 accent-[var(--carbon)]" />
              {o}
            </label>
          ))}
          {value ? (
            <button type="button" onClick={() => onChange("")} className="text-xs text-ink-3 hover:text-ink">
              Clear
            </button>
          ) : null}
        </div>
      );
    case "dropdown":
      return (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={f.readOnly}>
          <option value="">Choose…</option>
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case "list": {
      const sel = new Set(value.split("\n").filter(Boolean));
      return (
        <div className="grid gap-1.5">
          {(f.options ?? []).map((o) => (
            <label key={o} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sel.has(o)}
                onChange={() => {
                  if (sel.has(o)) sel.delete(o);
                  else sel.add(o);
                  onChange([...sel].join("\n"));
                }}
                className="size-4 accent-[var(--carbon)]"
              />
              {o}
            </label>
          ))}
        </div>
      );
    }
    case "text":
      return <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={f.readOnly} maxLength={f.maxLength} />;
    default:
      return <p className="text-sm text-ink-3">{f.kind === "signature" ? "A signature field. Use Sign PDF to sign it." : "This field can't be filled here."}</p>;
  }
}

export default function FillForm({ tool }: { tool: Tool }) {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [src, setSrc] = useState<Src | null>(null);
  const [fields, setFields] = useState<FieldInfo[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [flatten, setFlatten] = useState(false);
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
      const { listFields } = await import("@/lib/pdf/forms");
      const list = await listFields(s);
      setFields(list);
      setValues(Object.fromEntries(list.map((x) => [x.name, x.value])));
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

  const byPage = useMemo(() => {
    const m = new Map<number, FieldInfo[]>();
    for (const f of fields ?? []) {
      const p = f.page ?? -1;
      m.set(p, [...(m.get(p) ?? []), f]);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [fields]);

  const save = async () => {
    if (!src || !fields) return;
    setSaving(true);
    setError(undefined);
    try {
      const { fillForm } = await import("@/lib/pdf/forms");
      // Only send fields the user can change, so read-only values stay as they were.
      const changed = Object.fromEntries(fields.filter((f) => !f.readOnly && ["text", "multiline", "checkbox", "radio", "dropdown", "list"].includes(f.kind)).map((f) => [f.name, values[f.name] ?? ""]));
      setResults([await fillForm(src, changed, { flatten })]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!file) return <DropZone accept="application/pdf,.pdf" onFiles={(f) => void open(f[0])} label={tool.input?.label ?? "Choose a PDF"} />;

  const fillable = (fields ?? []).filter((f) => ["text", "multiline", "checkbox", "radio", "dropdown", "list"].includes(f.kind));
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="grid gap-4">
        {loading ? (
          <Panel className="flex items-center gap-2 p-6 text-sm text-ink-2">
            <Spinner /> Reading the form…
          </Panel>
        ) : fields && !fillable.length ? (
          <Panel className="grid justify-items-start gap-3 p-6">
            <p className="font-semibold">This PDF has no fillable fields</p>
            <p className="text-sm text-ink-2">It may be a scanned or flat form. You can still type on it: open it in the editor and place text where the answers go.</p>
            <Button
              variant="primary"
              onClick={() => {
                park([file], tool.slug);
                void navigate({ to: "/$slug", params: { slug: "edit-pdf" } });
              }}
            >
              <PenLine /> Type on it in Edit PDF
            </Button>
          </Panel>
        ) : (
          byPage.map(([page, list]) => (
            <Panel key={page} className="grid gap-4 p-5">
              <p className="text-xs font-semibold tracking-wide text-ink-3 uppercase">{page >= 0 ? `Page ${page + 1}` : "Other fields"}</p>
              {list.map((f) => (
                <div key={f.name} className="grid gap-1.5">
                  <label id={`field-${f.name}-label`} htmlFor={`field-${f.name}`} className="text-[13px] font-medium text-ink-2">
                    {humanize(f.name)}
                    {f.required ? <span className="text-danger"> *</span> : null}
                    {f.readOnly ? <span className="ml-1.5 text-xs font-normal text-ink-3">(read-only)</span> : null}
                  </label>
                  <FieldInput f={f} value={values[f.name] ?? ""} onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))} />
                </div>
              ))}
            </Panel>
          ))
        )}
        {error && !fields ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel className="grid gap-4 p-4">
          <div className="flex items-center gap-3">
            <div className="w-12 shrink-0">
              <Thumb file={file} password={src?.password} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{file.name}</p>
              <p className="text-xs text-ink-3">{fillable.length} fillable field{fillable.length === 1 ? "" : "s"}</p>
            </div>
          </div>
          <Switch checked={flatten} onChange={setFlatten} label="Flatten (lock the answers so they can't be edited)" />
          {error && fields ? <Notice tone="danger">{error}</Notice> : null}
          <Button variant="primary" size="lg" onClick={save} busy={saving} disabled={saving || !fillable.length}>
            {tool.cta}
          </Button>
          {results ? <ResultList results={results} tool={tool.slug} /> : null}
          <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => (setFile(null), setFields(null), setResults(null))}>
            Choose another PDF
          </Button>
        </Panel>
      </aside>
      {dialog}
    </div>
  );
}
