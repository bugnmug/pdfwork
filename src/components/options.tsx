import { Eye, EyeOff, ImagePlus, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { OptionDef, Values } from "@/lib/tools/catalog";
import { cn, formatBytes } from "@/lib/utils";
import { useFilePicker } from "./dropzone";
import { Button, Field, Input, inputClass, Segmented, Select, Slider, Switch, Textarea } from "./ui";

function PasswordInput({ id, value, onChange, placeholder, disabled }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input id={id} type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} autoComplete="new-password" className="pr-10" />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-ink-3 hover:text-ink" aria-label={show ? "Hide password" : "Show password"}>
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

function FileOption({ accept, value, onChange, disabled }: { accept: string; value: unknown; onChange: (f: File | undefined) => void; disabled?: boolean }) {
  const file = value instanceof File ? value : undefined;
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) return setUrl(undefined);
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const picker = useFilePicker(accept, false, (f) => onChange(f[0]));
  return (
    <div>
      {picker.input}
      {file ? (
        <div className="flex items-center gap-3 rounded-md border border-line bg-paper-2 p-2">
          {url ? <img src={url} alt="" className="checker size-12 rounded object-contain" /> : null}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-ink">{file.name}</p>
            <p className="text-xs text-ink-3">{formatBytes(file.size)}</p>
          </div>
          <Button variant="ghost" size="iconSm" onClick={() => onChange(undefined)} aria-label="Remove image" disabled={disabled}>
            <X />
          </Button>
        </div>
      ) : (
        <Button variant="secondary" className="w-full" onClick={picker.open} disabled={disabled}>
          <ImagePlus /> Choose image
        </Button>
      )}
    </div>
  );
}

function OptionField({ def, values, set, disabled, pageCount }: { def: OptionDef; values: Values; set: (k: string, v: unknown) => void; disabled?: boolean; pageCount?: number }) {
  const id = useId();
  const v = values[def.key];
  switch (def.type) {
    case "switch":
      return <Switch id={id} checked={!!v} onChange={(x) => set(def.key, x)} label={def.label} />;
    case "segmented":
      return (
        <Field label={def.label} help={def.help}>
          <Segmented label={def.label} value={String(v ?? def.default ?? "")} onChange={(x) => set(def.key, x)} options={def.choices} />
        </Field>
      );
    case "select":
      return (
        <Field label={def.label} help={def.help} htmlFor={id}>
          <Select id={id} value={String(v ?? def.default ?? "")} onChange={(e) => set(def.key, e.target.value)} disabled={disabled}>
            {def.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "number":
      return (
        <Field label={def.label} help={def.help} htmlFor={id}>
          <div className="relative">
            <Input
              id={id}
              type="number"
              inputMode="decimal"
              min={def.min}
              max={def.max}
              step={def.step ?? 1}
              value={v === undefined || v === null ? "" : String(v)}
              onChange={(e) => set(def.key, e.target.value === "" ? "" : Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : e.target.value)}
              disabled={disabled}
              className={cn("tabular", def.suffix && "pr-11")}
            />
            {def.suffix ? <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-ink-3">{def.suffix}</span> : null}
          </div>
        </Field>
      );
    case "slider": {
      const n = typeof v === "number" ? v : Number(v ?? def.default ?? def.min);
      return (
        <Field label={def.label} help={def.help}>
          <Slider label={def.label} min={def.min} max={def.max} step={def.step ?? 1} value={n} onChange={(x) => set(def.key, x)} format={def.format === "percent" ? (x) => `${Math.round(x * 100)}%` : (x) => String(Math.round(x * 10) / 10)} />
        </Field>
      );
    }
    case "color":
      return (
        <Field label={def.label} help={def.help} htmlFor={id}>
          <div className={cn(inputClass, "flex h-10 items-center gap-2 px-1.5")}>
            <input id={id} type="color" value={String(v ?? def.default ?? "#000000")} onChange={(e) => set(def.key, e.target.value)} disabled={disabled} className="size-7 cursor-pointer rounded border-0 bg-transparent p-0" />
            <input aria-label={`${def.label} hex`} value={String(v ?? "")} onChange={(e) => set(def.key, e.target.value)} className="w-full bg-transparent text-sm text-ink uppercase tabular focus:outline-none" maxLength={7} />
          </div>
        </Field>
      );
    case "password":
      return (
        <Field label={def.label} help={def.help} htmlFor={id}>
          <PasswordInput id={id} value={String(v ?? "")} onChange={(x) => set(def.key, x)} placeholder={def.placeholder} disabled={disabled} />
        </Field>
      );
    case "textarea":
      return (
        <Field label={def.label} help={def.help} htmlFor={id}>
          <Textarea id={id} rows={def.rows ?? 6} value={String(v ?? "")} placeholder={def.placeholder} onChange={(e) => set(def.key, e.target.value)} disabled={disabled} className="font-[inherit]" />
        </Field>
      );
    case "pages":
      return (
        <Field label={def.label} help={pageCount ? `${def.help ?? ""}${def.help ? " · " : ""}this file has ${pageCount} page${pageCount === 1 ? "" : "s"}` : def.help} htmlFor={id}>
          <Input id={id} value={String(v ?? "")} placeholder={def.placeholder ?? "all"} onChange={(e) => set(def.key, e.target.value)} disabled={disabled} spellCheck={false} />
        </Field>
      );
    case "file":
      return (
        <Field label={def.label} help={def.help}>
          <FileOption accept={def.accept} value={v} onChange={(f) => set(def.key, f)} disabled={disabled} />
        </Field>
      );
    default:
      return (
        <Field label={def.label} help={def.help} htmlFor={id}>
          <Input id={id} value={String(v ?? "")} placeholder={"placeholder" in def ? def.placeholder : undefined} onChange={(e) => set(def.key, e.target.value)} disabled={disabled} />
        </Field>
      );
  }
}

export function OptionsForm({ defs, values, onChange, disabled, pageCount, className }: { defs: OptionDef[]; values: Values; onChange: (v: Values) => void; disabled?: boolean; pageCount?: number; className?: string }) {
  const set = (k: string, val: unknown) => onChange({ ...values, [k]: val });
  const visible = defs.filter((d) => !d.show || d.show(values));
  if (!visible.length) return null;
  return (
    <fieldset disabled={disabled} className={cn("grid grid-cols-2 gap-x-3 gap-y-4", className)}>
      {visible.map((d) => (
        <div key={d.key} className={d.wide || !(d.type === "number" || d.type === "color") ? "col-span-2" : "col-span-1"}>
          <OptionField def={d} values={values} set={set} disabled={disabled} pageCount={pageCount} />
        </div>
      ))}
    </fieldset>
  );
}
