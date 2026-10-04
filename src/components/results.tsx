import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, CircleCheck, Download, Eye, FileArchive, FileText, FileImage, File as FileIcon, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import type { OutFile } from "@/lib/pdf/core";
import { downloadOut, extOf, kindOf, nextTools } from "@/lib/files";
import { outToFile, park } from "@/lib/handoff";
import { cn, formatBytes } from "@/lib/utils";
import { IconTile } from "./icons";
import { canPreview, PreviewDialog } from "./preview";
import { Button, Popover } from "./ui";

function KindIcon({ f }: { f: OutFile }) {
  const k = kindOf({ name: f.filename, type: f.mime });
  const Icon = f.mime === "application/zip" ? FileArchive : k === "image" ? FileImage : k === "pdf" || k === "text" || k === "markdown" ? FileText : FileIcon;
  return (
    <span className="relative grid size-10 shrink-0 place-items-center rounded-md bg-paper-2 text-ink-2">
      <Icon className="size-5" strokeWidth={1.7} aria-hidden />
      <span className="absolute -bottom-1 -right-1 rounded bg-ink px-1 text-[9px] font-bold leading-4 text-paper">{extOf(f.filename)}</span>
    </span>
  );
}

export function ContinueWith({ file, current }: { file: OutFile; current?: string }) {
  const navigate = useNavigate();
  const tools = nextTools(file, current);
  if (!tools.length) return null;
  return (
    <Popover
      align="end"
      button={({ toggle, open }) => (
        <Button variant="ghost" size="sm" onClick={toggle} aria-expanded={open}>
          Continue <ArrowRight />
        </Button>
      )}
    >
      {(close) => (
        <div className="w-64 p-1.5">
          <p className="px-2 pt-1.5 pb-1 text-xs font-medium text-ink-3">Use this file in…</p>
          <ul className="max-h-80 overflow-auto">
            {tools.map((t) => (
              <li key={t.slug}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-paper-2"
                  onClick={() => {
                    close();
                    park([outToFile(file)], current);
                    void navigate({ to: "/$slug", params: { slug: t.slug } });
                  }}
                >
                  <IconTile name={t.icon} category={t.category} size="sm" />
                  {t.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Popover>
  );
}

export function ResultList({
  results,
  tool,
  elapsed,
  inputBytes,
  onReset,
  onBack,
  resetLabel = "Start over",
}: {
  results: OutFile[];
  tool?: string;
  elapsed?: number;
  inputBytes?: number;
  onReset?: () => void;
  onBack?: () => void;
  resetLabel?: string;
}) {
  const [preview, setPreview] = useState<OutFile | null>(null);
  const [zipping, setZipping] = useState(false);
  const zip = results.find((r) => r.mime === "application/zip");
  const files = useMemo(() => results.filter((r) => r !== zip), [results, zip]);
  const [showAll, setShowAll] = useState(files.length <= 8);
  const single = files.length === 1 ? files[0] : null;
  const saved = single && inputBytes && kindOf({ name: single.filename, type: single.mime }) === "pdf" && tool === "compress-pdf" ? 1 - single.bytes.byteLength / inputBytes : null;

  const downloadAll = async () => {
    if (zip) return downloadOut(zip);
    setZipping(true);
    try {
      const { withZip } = await import("@/lib/pdf/pages");
      const [z] = await withZip(files, `${tool ?? "results"}.zip`);
      downloadOut(z);
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="flex items-start gap-3">
        <CircleCheck className="mt-0.5 size-6 shrink-0 text-ok" aria-hidden />
        <div className="min-w-0">
          <p className="text-lg font-semibold text-ink">{files.length === 1 ? "Your file is ready" : `${files.length} files are ready`}</p>
          <p className="text-sm text-ink-2">
            {elapsed !== undefined ? `Done in ${elapsed < 1000 ? `${Math.max(1, Math.round(elapsed))} ms` : `${(elapsed / 1000).toFixed(1)} s`} on this device.` : "Made on this device."}
            {saved !== null && inputBytes ? (
              saved > 0.005 ? (
                <>
                  {" "}
                  <b className="font-semibold text-ink tabular">
                    {formatBytes(inputBytes)} → {formatBytes(single!.bytes.byteLength)}
                  </b>{" "}
                  <span className="rounded-sm bg-marker px-1 font-semibold text-marker-ink tabular">{Math.round(saved * 100)}% smaller</span>
                </>
              ) : null
            ) : null}
          </p>
        </div>
      </div>

      {files.length > 1 ? (
        <Button variant="primary" size="lg" onClick={downloadAll} busy={zipping} className="w-full">
          {!zipping ? <Download /> : null} Download all ({zip ? formatBytes(zip.bytes.byteLength) : "ZIP"})
        </Button>
      ) : single ? (
        <Button variant="primary" size="lg" onClick={() => downloadOut(single)} className="w-full">
          <Download /> Download {extOf(single.filename)}
        </Button>
      ) : null}

      <ul className="grid gap-2">
        {(showAll ? files : files.slice(0, 6)).map((f, i) => (
          <li key={`${f.filename}-${i}`} className="flex items-center gap-3 rounded-md border border-line-2 bg-paper-2/60 p-2.5">
            <KindIcon f={f} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink" title={f.filename}>
                {f.filename}
              </p>
              <p className="truncate text-xs text-ink-3">
                <span className="tabular">{formatBytes(f.bytes.byteLength)}</span>
                {f.note ? ` · ${f.note}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {canPreview(f) ? (
                <Button variant="ghost" size="iconSm" onClick={() => setPreview(f)} aria-label={`Preview ${f.filename}`} title="Preview">
                  <Eye />
                </Button>
              ) : null}
              <Button variant="ghost" size="iconSm" onClick={() => downloadOut(f)} aria-label={`Download ${f.filename}`} title="Download">
                <Download />
              </Button>
              {files.length === 1 ? <ContinueWith file={f} current={tool} /> : null}
            </div>
          </li>
        ))}
      </ul>
      {!showAll ? (
        <Button variant="ghost" size="sm" onClick={() => setShowAll(true)} className="justify-self-start">
          Show all {files.length} files
        </Button>
      ) : null}

      {onReset || onBack ? (
        <div className={cn("flex flex-wrap gap-2 border-t border-line-2 pt-4")}>
          {onBack ? (
            <Button variant="secondary" onClick={onBack}>
              Change options
            </Button>
          ) : null}
          {onReset ? (
            <Button variant="ghost" onClick={onReset}>
              <RotateCcw /> {resetLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      <PreviewDialog file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
