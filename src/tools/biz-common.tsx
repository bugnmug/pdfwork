/** Small pieces shared by the business forms (invoice, receipt, GST, resume). */
import { ImagePlus, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useFilePicker } from "@/components/dropzone";
import { Button, Input, Panel, Select } from "@/components/ui";
import { STATES } from "@/lib/pdf/business";
import { cn } from "@/lib/utils";

export function Section({ title, children, aside, className }: { title: ReactNode; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <Panel className={cn("grid gap-4 p-4 sm:p-5", className)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </Panel>
  );
}

export function L({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: ReactNode }) {
  return (
    <label className={cn("grid content-start gap-1.5", className)}>
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {hint ? <span className="text-xs text-ink-3">{hint}</span> : null}
    </label>
  );
}

export function StateSelect({ value, onChange, placeholder = "Choose state" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {Object.entries(STATES)
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([code, name]) => (
          <option key={code} value={code}>
            {name} ({code})
          </option>
        ))}
    </Select>
  );
}

export function NumInput({ value, onChange, className, step = "any", min = 0, ...rest }: { value: number; onChange: (n: number) => void; className?: string; step?: string; min?: number } & Omit<React.ComponentProps<"input">, "value" | "onChange">) {
  return (
    <Input
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      value={Number.isFinite(value) && value !== 0 ? value : value === 0 ? "0" : ""}
      onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
      onFocus={(e) => e.target.select()}
      className={cn("tabular", className)}
      {...rest}
    />
  );
}

/** Resize an image file into a PNG/JPEG data URL suitable for storing in localStorage. */
export async function imageToDataUrl(f: File, max = 600): Promise<string> {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That image could not be opened."));
      i.src = url;
    });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(f.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function dataUrlToImage(src?: string): { bytes: Uint8Array; mime: string } | undefined {
  if (!src) return undefined;
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(src);
  if (!m) return undefined;
  const raw = atob(m[2]);
  return { bytes: Uint8Array.from(raw, (c) => c.charCodeAt(0)), mime: m[1] };
}

export function ImageSlot({ label, value, onChange, hint }: { label: string; value?: string; onChange: (v: string | undefined) => void; hint?: string }) {
  const picker = useFilePicker("image/png,image/jpeg,image/webp", false, async (f) => onChange(await imageToDataUrl(f[0])));
  return (
    <div className="grid gap-1.5">
      <span className="text-[13px] font-medium text-ink-2">{label}</span>
      {picker.input}
      {value ? (
        <div className="flex items-center gap-3 rounded-md border border-line bg-paper-2 p-2">
          <img src={value} alt="" className="checker h-12 max-w-32 rounded object-contain" />
          <Button variant="ghost" size="iconSm" className="ml-auto" onClick={() => onChange(undefined)} aria-label={`Remove ${label}`}>
            <X />
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={picker.open}>
          <ImagePlus /> Add {label.toLowerCase()}
        </Button>
      )}
      {hint ? <span className="text-xs text-ink-3">{hint}</span> : null}
    </div>
  );
}

export function RemoveRow({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button variant="ghost" size="iconSm" onClick={onClick} aria-label={label} className="text-ink-3 hover:text-danger">
      <Trash2 />
    </Button>
  );
}

/** "INV-0042" → "INV-0043" (keeps the zero padding). */
export function nextNumber(s: string): string {
  const m = /^(.*?)(\d+)(\D*)$/.exec(s);
  if (!m) return s ? `${s}-2` : "1";
  const n = String(Number(m[2]) + 1).padStart(m[2].length, "0");
  return `${m[1]}${n}${m[3]}`;
}

export const today = () => new Date().toISOString().slice(0, 10);
