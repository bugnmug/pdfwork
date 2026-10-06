import { useEffect, useState } from "react";
import type { OutFile } from "@/lib/pdf/core";
import { kindOf } from "@/lib/files";
import { bytesToBlob, formatBytes } from "@/lib/utils";
import { Dialog, Notice, Progress } from "./ui";

const MAX_PAGES = 40;

function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const [pages, setPages] = useState<{ url: string; w: number; h: number }[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    (async () => {
      const { openPdfjs, renderPage } = await import("@/lib/pdf/pdfjs");
      const o = await openPdfjs(bytes);
      try {
        if (!alive) return;
        setTotal(o.pageCount);
        const width = Math.min(820, window.innerWidth - 48) * Math.min(2, window.devicePixelRatio || 1);
        for (let i = 1; i <= Math.min(o.pageCount, MAX_PAGES) && alive; i++) {
          const page = await o.pdf.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          const canvas = await renderPage(page, width / vp.width, { pixelBudget: 3_000_000 });
          page.cleanup();
          const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
          if (!blob || !alive) break;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setPages((p) => [...p, { url, w: vp.width, h: vp.height }]);
        }
      } finally {
        await o.close().catch(() => undefined);
      }
    })().catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [bytes]);
  if (error) return <Notice tone="danger">Couldn&apos;t preview this file: {error}</Notice>;
  return (
    <div className="grid gap-4">
      {pages.length < Math.min(total || 1, MAX_PAGES) ? <Progress value={total ? pages.length / Math.min(total, MAX_PAGES) : null} label={`Rendering page ${pages.length + 1}${total ? ` of ${total}` : ""}`} /> : null}
      {pages.map((p, i) => (
        <figure key={p.url} className="grid gap-1">
          <img src={p.url} alt={`Page ${i + 1}`} className="w-full rounded border border-line bg-white shadow-sm" style={{ aspectRatio: `${p.w} / ${p.h}` }} />
          <figcaption className="text-center text-xs text-ink-3">
            {i + 1} / {total}
          </figcaption>
        </figure>
      ))}
      {total > MAX_PAGES && pages.length === MAX_PAGES ? <p className="text-center text-sm text-ink-2">Preview shows the first {MAX_PAGES} pages. Download to see all {total}.</p> : null}
    </div>
  );
}

function TextPreview({ bytes, html }: { bytes: Uint8Array; html?: boolean }) {
  const text = new TextDecoder().decode(bytes.subarray(0, 300_000));
  if (html)
    return <iframe title="HTML preview" sandbox="" srcDoc={text} className="h-[70vh] w-full rounded border border-line bg-white" />;
  return <pre className="max-h-[70vh] overflow-auto rounded-md border border-line bg-paper-2 p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink">{text}{bytes.byteLength > 300_000 ? "\n\n… (preview truncated)" : ""}</pre>;
}

function ImagePreview({ file }: { file: OutFile }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(bytesToBlob(file.bytes, file.mime));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url ? <img src={url} alt={file.filename} className="checker mx-auto max-h-[75vh] rounded border border-line object-contain" /> : null;
}

export function canPreview(f: OutFile): boolean {
  const k = kindOf({ name: f.filename, type: f.mime });
  return k === "pdf" || k === "image" || k === "text" || k === "markdown" || k === "csv" || k === "html" || /\.(json|xml)$/i.test(f.filename);
}

export function PreviewDialog({ file, onClose }: { file: OutFile | null; onClose: () => void }) {
  const k = file ? kindOf({ name: file.filename, type: file.mime }) : "other";
  return (
    <Dialog open={!!file} onClose={onClose} wide title={file ? <span className="block max-w-[60vw] truncate">{file.filename}</span> : ""}>
      {file ? (
        <div className="grid gap-3">
          <p className="text-xs text-ink-3">{formatBytes(file.bytes.byteLength)}</p>
          {k === "pdf" ? <PdfPreview bytes={file.bytes} /> : k === "image" ? <ImagePreview file={file} /> : <TextPreview bytes={file.bytes} html={k === "html"} />}
        </div>
      ) : null}
    </Dialog>
  );
}
