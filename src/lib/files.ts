import type { OutFile } from "@/lib/pdf/core";
import { TOOL_BY_SLUG, type Tool } from "@/lib/tools/catalog";
import { bytesToBlob, downloadBlob } from "@/lib/utils";

export type FileKind = "pdf" | "image" | "word" | "excel" | "ppt" | "html" | "markdown" | "text" | "csv" | "epub" | "audio" | "other";

export function kindOf(f: { name: string; type?: string }): FileKind {
  const n = f.name.toLowerCase();
  const t = (f.type ?? "").toLowerCase();
  if (t === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (t.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/.test(n)) return "image";
  if (/\.(docx|doc|odt|rtf)$/.test(n)) return "word";
  if (/\.(xlsx|xls|xlsm|ods)$/.test(n)) return "excel";
  if (/\.(pptx|ppt|odp)$/.test(n)) return "ppt";
  if (/\.(html?|xhtml)$/.test(n) || t === "text/html") return "html";
  if (/\.(md|markdown)$/.test(n)) return "markdown";
  if (/\.(csv|tsv)$/.test(n) || t === "text/csv") return "csv";
  if (n.endsWith(".epub")) return "epub";
  if (t.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|webm|flac|aac)$/.test(n)) return "audio";
  if (t.startsWith("text/") || n.endsWith(".txt")) return "text";
  return "other";
}

/** Does a file satisfy an <input accept="…"> string? */
export function accepts(accept: string | undefined, f: File): boolean {
  if (!accept || accept === "*/*" || accept === "*") return true;
  const n = f.name.toLowerCase();
  const t = (f.type || "").toLowerCase();
  return accept
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((a) => (a.startsWith(".") ? n.endsWith(a) : a.endsWith("/*") ? t.startsWith(a.slice(0, -1)) : t === a));
}

export function downloadOut(o: OutFile) {
  downloadBlob(bytesToBlob(o.bytes, o.mime), o.filename);
}

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toUpperCase() : "FILE";
}

const PDF_NEXT = ["compress-pdf", "merge-pdf", "organize-pages", "edit-pdf", "sign-pdf", "page-numbers", "watermark", "encrypt-pdf", "ocr-pdf", "split-pdf", "pdf-to-word", "pdf-to-jpg", "redact-pdf", "rotate-pdf"];

/** Tools that make sense to run next on a result. */
export function nextTools(o: { filename: string; mime: string }, current?: string): Tool[] {
  const k = kindOf({ name: o.filename, type: o.mime });
  const slugs = k === "pdf" ? PDF_NEXT : k === "image" ? ["images-to-pdf", "ocr-pdf"] : [];
  return slugs.filter((s) => s !== current).map((s) => TOOL_BY_SLUG[s]).filter(Boolean);
}

/** Suggestions for files dropped on the home page. */
export function suggestFor(files: File[]): Tool[] {
  const kinds = new Set(files.map(kindOf));
  const pdfs = files.filter((f) => kindOf(f) === "pdf").length;
  const s: string[] = [];
  if (kinds.has("pdf")) {
    if (pdfs > 1) s.push("merge-pdf", "compress-pdf", "mix-pdf", "compare-pdfs", "bates");
    s.push("compress-pdf", "edit-pdf", "sign-pdf", "organize-pages", "split-pdf", "pdf-to-word", "pdf-to-jpg", "ocr-pdf", "encrypt-pdf", "chat-pdf", "summarize", "watermark", "page-numbers", "redact-pdf", "pdf-to-excel");
  }
  if (kinds.has("image")) s.push("images-to-pdf", "ocr-pdf");
  if (kinds.has("word")) s.push("word-to-pdf");
  if (kinds.has("excel")) s.push("excel-to-pdf");
  if (kinds.has("ppt")) s.push("ppt-to-pdf");
  if (kinds.has("html")) s.push("html-to-pdf");
  if (kinds.has("markdown")) s.push("markdown-to-pdf");
  if (kinds.has("csv")) s.push("csv-to-pdf");
  if (kinds.has("epub")) s.push("ebook-to-pdf");
  if (kinds.has("text")) s.push("create-pdf", "markdown-to-pdf");
  s.push("fingerprint", "p2p-share");
  return [...new Set(s)].map((x) => TOOL_BY_SLUG[x]).filter(Boolean);
}
