/** Reads a PDF's text for the AI tools: per-page text in reading order plus headings. */
import { useCallback, useState } from "react";
import type { PageDoc } from "@/lib/ai/local";

export type DocText = { file: File; password?: string; pages: PageDoc; headings: string[]; pageCount: number; textPages: number; title: string };

export function useDocText(ask: (name: string, wrong?: boolean) => Promise<string | null>) {
  const [doc, setDoc] = useState<DocText | null>(null);
  const [loading, setLoading] = useState<{ value: number; label: string } | null>(null);
  const [error, setError] = useState<string>();

  const load = useCallback(
    async (file: File) => {
      setError(undefined);
      setLoading({ value: 0, label: "Opening" });
      try {
        const { extractPages, toLines, linesToText, PdfjsPasswordError } = await import("@/lib/pdf/pdfjs");
        const { analyze } = await import("@/lib/pdf/structure");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let password: string | undefined;
        let wrong = false;
        let pts;
        for (;;) {
          try {
            pts = await extractPages(bytes, { password, styles: true, onProgress: (v, label) => setLoading({ value: v, label }) });
            break;
          } catch (e) {
            if (!(e instanceof PdfjsPasswordError)) throw e;
            const pw = await ask(file.name, wrong);
            if (pw == null) {
              setLoading(null);
              return;
            }
            password = pw;
            wrong = true;
          }
        }
        const pages: PageDoc = pts.map((p, i) => ({ page: i + 1, text: linesToText(toLines(p)) }));
        const textPages = pages.filter((p) => p.text.trim().length > 20).length;
        const headings = analyze(pts)
          .filter((b) => b.kind === "heading")
          .map((b) => (b as { text: string }).text);
        setDoc({ file, password, pages, headings, pageCount: pts.length, textPages, title: headings[0] ?? file.name.replace(/\.pdf$/i, "") });
      } catch (e) {
        setError(`Couldn't read ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setLoading(null);
      }
    },
    [ask],
  );
  return { doc, setDoc, load, loading, error };
}

export type AiStatus = { enabled: boolean; provider: string | null; speech: boolean; transcribe: boolean };

let statusPromise: Promise<AiStatus> | null = null;
/** Whether the site owner has configured an AI provider (asked once per visit). */
export function aiStatusOnce(): Promise<AiStatus> {
  statusPromise ??= import("@/lib/ai/server")
    .then((m) => m.aiStatus())
    .catch(() => ({ enabled: false, provider: null, speech: false, transcribe: false }));
  return statusPromise;
}
