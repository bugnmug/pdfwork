import { FileUp, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { accepts } from "@/lib/files";
import { cn } from "@/lib/utils";
import { Button } from "./ui";

function describeAccept(accept?: string): string {
  if (!accept || accept === "*/*") return "Any file";
  const exts = accept
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("."))
    .map((s) => s.slice(1).toUpperCase());
  const uniq = [...new Set(exts)].filter((e) => e !== "JPEG");
  if (uniq.length > 6) return `${uniq.slice(0, 6).join(", ")} and more`;
  return uniq.join(", ");
}

/** Picks files that match `accept`, warns about the rest. */
export function filterAccepted(list: File[], accept?: string): File[] {
  const ok = list.filter((f) => accepts(accept, f));
  const bad = list.length - ok.length;
  if (bad) toast.error(bad === 1 ? `“${list.find((f) => !accepts(accept, f))?.name}” isn't a supported file for this tool.` : `${bad} files aren't supported by this tool and were skipped.`);
  return ok;
}

export function useFilePicker(accept: string | undefined, multiple: boolean, onFiles: (f: File[]) => void) {
  const inputRef = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={inputRef}
      type="file"
      className="hidden"
      accept={accept}
      multiple={multiple}
      onChange={(e) => {
        const list = Array.from(e.target.files ?? []);
        e.target.value = "";
        const ok = filterAccepted(list, accept);
        if (ok.length) onFiles(multiple ? ok : ok.slice(0, 1));
      }}
    />
  );
  return { open: () => inputRef.current?.click(), input };
}

export function DropZone({
  accept,
  multiple = false,
  onFiles,
  label = "Choose files",
  hint,
  compact = false,
  paste = true,
  className,
  children,
}: {
  accept?: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  label?: string;
  hint?: ReactNode;
  compact?: boolean;
  paste?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const [windowDrag, setWindowDrag] = useState(false);
  const id = useId();
  const picker = useFilePicker(accept, multiple, onFiles);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  // Highlight while files are dragged anywhere over the window.
  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth++;
      setWindowDrag(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setWindowDrag(false);
    };
    const drop = () => {
      depth = 0;
      setWindowDrag(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  useEffect(() => {
    if (!paste) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable)) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      const named = files.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `pasted-${Date.now()}-${i + 1}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type })));
      const ok = filterAccepted(named, accept);
      if (ok.length) onFilesRef.current(multiple ? ok : ok.slice(0, 1));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [accept, multiple, paste]);

  return (
    <div
      role="region"
      aria-labelledby={id}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const list = Array.from(e.dataTransfer.files);
        const ok = filterAccepted(list, accept);
        if (ok.length) onFiles(multiple ? ok : ok.slice(0, 1));
      }}
      className={cn(
        "relative grid place-items-center rounded-lg border-2 border-dashed bg-paper text-center transition-[border-color,background-color,box-shadow] duration-200",
        compact ? "px-4 py-6" : "px-6 py-14 sm:py-20",
        over ? "border-carbon bg-carbon-soft shadow-[0_0_0_4px_var(--carbon-soft)]" : windowDrag ? "border-carbon/60" : "border-line",
        className,
      )}
    >
      {picker.input}
      <div className="grid justify-items-center gap-3">
        {!compact ? (
          <span className={cn("grid size-14 place-items-center rounded-full transition-colors", over ? "bg-carbon text-carbon-ink" : "bg-carbon-soft text-carbon")}>
            <FileUp className="size-6" strokeWidth={1.8} aria-hidden />
          </span>
        ) : null}
        <Button variant="primary" size={compact ? "md" : "lg"} onClick={picker.open} id={id}>
          {compact ? <FileUp /> : null}
          {label}
        </Button>
        <p className="text-sm text-ink-2">
          or drop {multiple ? "them" : "it"} here{paste ? <span className="hidden sm:inline"> · paste works too</span> : null}
        </p>
        <p className="text-xs text-ink-3">{hint ?? describeAccept(accept)}</p>
        {children}
        {!compact ? (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-3">
            <ShieldCheck className="size-3.5 text-ok" aria-hidden />
            Processed on this device. Nothing is uploaded.
          </p>
        ) : null}
      </div>
    </div>
  );
}
