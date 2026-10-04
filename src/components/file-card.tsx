import { ChevronLeft, ChevronRight, Lock, X } from "lucide-react";
import { useEffect, useState } from "react";
import { extOf } from "@/lib/files";
import { fileInfo, type FileInfo } from "@/lib/thumbs";
import { cn, formatBytes } from "@/lib/utils";

export function useFileInfo(file: File | undefined, password?: string) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  useEffect(() => {
    if (!file) return setInfo(null);
    let alive = true;
    setInfo(null);
    fileInfo(file, password ?? "").then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, [file, password]);
  return info;
}

export function Thumb({ file, password, className }: { file: File; password?: string; className?: string }) {
  const info = useFileInfo(file, password);
  const ratio = info?.w && info?.h ? `${info.w} / ${info.h}` : "3 / 4";
  return (
    <div className={cn("relative grid w-full place-items-center overflow-hidden rounded-[4px] bg-white shadow-[0_1px_2px_rgb(0_0_0/0.12),0_0_0_1px_rgb(0_0_0/0.05)]", className)} style={{ aspectRatio: ratio, maxHeight: "100%" }}>
      {info?.url ? (
        <img src={info.url} alt="" className="size-full object-contain" draggable={false} />
      ) : info?.locked ? (
        <span className="grid justify-items-center gap-1 text-[#4a5061]">
          <Lock className="size-6" strokeWidth={1.6} />
          <span className="text-[11px] font-medium">Protected</span>
        </span>
      ) : info ? (
        <span className="rounded bg-[#eef0f4] px-2 py-1 text-xs font-bold tracking-wide text-[#4a5061]">{extOf(file.name)}</span>
      ) : (
        <span className="size-full animate-pulse bg-[#f2f3f6]" />
      )}
    </div>
  );
}

export function FileCard({
  file,
  password,
  index,
  numbered,
  onRemove,
  onMove,
  onUnlock,
  disabled,
  dragging,
  dropBefore,
}: {
  file: File;
  password?: string;
  index: number;
  numbered?: boolean;
  onRemove?: () => void;
  onMove?: (delta: -1 | 1) => void;
  onUnlock?: () => void;
  disabled?: boolean;
  dragging?: boolean;
  dropBefore?: boolean;
}) {
  const info = useFileInfo(file, password);
  return (
    <div className={cn("group relative grid gap-2 rounded-lg border border-line bg-paper p-2.5 transition-[opacity,box-shadow]", dragging && "opacity-40", dropBefore && "shadow-[-4px_0_0_0_var(--carbon)]")}>
      <div className="grid aspect-[3/4] place-items-center rounded-md bg-paper-2 p-3">
        <Thumb file={file} password={password} className="max-h-full" />
      </div>
      {numbered ? <span className="absolute top-1.5 left-1.5 grid size-6 place-items-center rounded-full bg-ink text-xs font-semibold text-paper tabular">{index + 1}</span> : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${file.name}`}
          className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-full border border-line bg-paper text-ink-2 shadow-sm transition-opacity hover:text-danger sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
      <div className="min-w-0 px-0.5">
        <p className="truncate text-[13px] font-medium text-ink" title={file.name}>
          {file.name}
        </p>
        <p className="flex items-center gap-1 text-xs text-ink-3 tabular">
          {formatBytes(file.size)}
          {info?.pages ? ` · ${info.pages} page${info.pages === 1 ? "" : "s"}` : ""}
          {info?.broken ? " · can't read" : ""}
        </p>
      </div>
      {info?.locked && onUnlock ? (
        <button type="button" onClick={onUnlock} className="rounded-md bg-warn-soft px-2 py-1 text-xs font-medium text-warn hover:underline">
          Enter password
        </button>
      ) : null}
      {onMove ? (
        <div className="flex justify-between">
          <button type="button" onClick={() => onMove(-1)} disabled={disabled} className="rounded p-1 text-ink-3 hover:bg-paper-2 hover:text-ink disabled:opacity-30" aria-label={`Move ${file.name} earlier`}>
            <ChevronLeft className="size-4" />
          </button>
          <button type="button" onClick={() => onMove(1)} disabled={disabled} className="rounded p-1 text-ink-3 hover:bg-paper-2 hover:text-ink disabled:opacity-30" aria-label={`Move ${file.name} later`}>
            <ChevronRight className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
