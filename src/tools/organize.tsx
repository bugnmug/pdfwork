import { ArrowDownToLine, ArrowUpToLine, CheckSquare, Copy, FilePlus2, Plus, RotateCcw, RotateCw, Square, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DropZone, useFilePicker } from "@/components/dropzone";
import { usePasswordPrompt } from "@/components/password";
import { ResultList } from "@/components/results";
import { Button, Dialog, Notice, Progress, Spinner } from "@/components/ui";
import { take } from "@/lib/handoff";
import type { OutFile } from "@/lib/pdf/core";
import type { PagePlan } from "@/lib/pdf/pages";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";

type Doc = { file: File; password?: string; pages: number };
type Card = { key: string; doc: number; source: number; rotate: number; blank?: boolean };
type Thumb = { url: string; w: number; h: number };

let seq = 0;
const key = () => `c${++seq}`;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

async function openWithPassword(file: File, ask: (name: string, wrong?: boolean) => Promise<string | null>): Promise<{ pages: number; password?: string } | null> {
  const { pageCountOf, PdfjsPasswordError } = await import("@/lib/pdf/pdfjs");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let password: string | undefined;
  let wrong = false;
  for (;;) {
    try {
      return { pages: await pageCountOf(bytes, password), password };
    } catch (e) {
      if (!(e instanceof PdfjsPasswordError)) throw e;
      const pw = await ask(file.name, wrong);
      if (pw == null) return null;
      password = pw;
      wrong = true;
    }
  }
}

export default function Organize({ tool }: { tool: Tool }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, Thumb>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<Card[][]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ v: number | null; l: string }>({ v: null, l: "" });
  const [results, setResults] = useState<OutFile[] | null>(null);
  const [error, setError] = useState<string>();
  const [drag, setDrag] = useState<{ key: string; x: number; y: number; target: number } | null>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const abort = useRef<AbortController | null>(null);
  const { ask, dialog } = usePasswordPrompt();

  const change = (next: Card[]) => {
    setHistory((h) => [...h.slice(-60), cards]);
    setCards(next);
  };

  const loadThumbs = useCallback(async (file: File, docIndex: number, password: string | undefined, signal: AbortSignal) => {
    const { renderThumbnails } = await import("@/lib/pdf/pdfjs");
    const bytes = new Uint8Array(await file.arrayBuffer());
    await renderThumbnails(bytes, 170, (i, url, size) => setThumbs((t) => ({ ...t, [`${docIndex}:${i}`]: { url, w: size.w, h: size.h } })), { password, signal });
  }, []);

  const addDoc = useCallback(
    async (file: File, main: boolean) => {
      setLoading(true);
      setError(undefined);
      try {
        const opened = await openWithPassword(file, ask);
        if (!opened) return;
        const index = main ? 0 : docs.length;
        const doc: Doc = { file, password: opened.password, pages: opened.pages };
        const newCards = Array.from({ length: opened.pages }, (_, i) => ({ key: key(), doc: index, source: i, rotate: 0 }));
        if (main) {
          abort.current?.abort();
          abort.current = new AbortController();
          setDocs([doc]);
          setCards(newCards);
          setThumbs({});
          setHistory([]);
          setSelected(new Set());
          setResults(null);
        } else {
          setDocs((d) => [...d, doc]);
          change([...cards, ...newCards]);
          toast.success(`Added ${opened.pages} page${opened.pages === 1 ? "" : "s"} from ${file.name}`);
        }
        void loadThumbs(file, index, opened.password, (abort.current ??= new AbortController()).signal).catch(() => undefined);
      } catch (e) {
        setError(`Couldn't open ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ask, docs.length, cards, loadThumbs],
  );

  useEffect(() => {
    const parked = take();
    const f = parked?.files.find((x) => /\.pdf$/i.test(x.name) || x.type === "application/pdf");
    if (f) void addDoc(f, true);
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const extraPicker = useFilePicker("application/pdf,.pdf", false, (f) => void addDoc(f[0], false));

  /* ---- selection helpers */
  const sel = cards.filter((c) => selected.has(c.key));
  const targets = sel.length ? sel.map((c) => c.key) : [];
  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const rotate = (keys: string[], by: number) => change(cards.map((c) => (keys.includes(c.key) ? { ...c, rotate: (((c.rotate + by) % 360) + 360) % 360 } : c)));
  const remove = (keys: string[]) => {
    if (keys.length >= cards.length) return toast.error("A PDF needs at least one page.");
    change(cards.filter((c) => !keys.includes(c.key)));
    setSelected(new Set());
  };
  const duplicate = (keys: string[]) => {
    const next: Card[] = [];
    for (const c of cards) {
      next.push(c);
      if (keys.includes(c.key)) next.push({ ...c, key: key() });
    }
    change(next);
  };
  const insertBlank = () => {
    const at = sel.length ? cards.indexOf(sel[sel.length - 1]) + 1 : cards.length;
    const next = cards.slice();
    next.splice(at, 0, { key: key(), doc: -1, source: -1, rotate: 0, blank: true });
    change(next);
  };
  const moveTo = (keys: string[], where: "start" | "end") => {
    const moving = cards.filter((c) => keys.includes(c.key));
    const rest = cards.filter((c) => !keys.includes(c.key));
    change(where === "start" ? [...moving, ...rest] : [...rest, ...moving]);
  };

  /* ---- pointer drag (mouse: immediate after a few px; touch: long press) */
  type DragStart = { key: string; startX: number; startY: number; scrollY: number; rects: DOMRect[]; active: boolean; timer?: ReturnType<typeof setTimeout>; pointerType: string };
  const dragState = useRef<DragStart | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const autoScroll = useRef<number | null>(null);

  const targetIndex = (x: number, y: number, rects: DOMRect[]) => {
    let best = rects.length;
    let bestD = Infinity;
    rects.forEach((r, i) => {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = Math.hypot(x - cx, (y - cy) * 1.4);
      if (d < bestD) {
        bestD = d;
        best = x < cx ? i : i + 1;
      }
    });
    return best;
  };

  const onPointerDown = (e: React.PointerEvent, c: Card) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.button !== 0) return;
    const els = Array.from(gridRef.current?.querySelectorAll<HTMLElement>("[data-card]") ?? []);
    const st: DragStart = { key: c.key, startX: e.clientX, startY: e.clientY, scrollY: window.scrollY, rects: els.map((el) => el.getBoundingClientRect()), active: false, pointerType: e.pointerType };
    dragState.current = st;
    if (e.pointerType !== "mouse") {
      st.timer = setTimeout(() => {
        st.active = true;
        navigator.vibrate?.(15);
        setDrag({ key: c.key, x: st.startX, y: st.startY, target: cardsRef.current.findIndex((x) => x.key === c.key) });
      }, 320);
    }
  };

  useEffect(() => {
    const stopScroll = () => {
      if (autoScroll.current) cancelAnimationFrame(autoScroll.current);
      autoScroll.current = null;
    };
    const move = (e: PointerEvent) => {
      const st = dragState.current;
      if (!st) return;
      const dist = Math.hypot(e.clientX - st.startX, e.clientY - st.startY);
      if (!st.active) {
        if (st.pointerType === "mouse" && dist > 6) st.active = true;
        else if (st.pointerType !== "mouse" && dist > 10) {
          clearTimeout(st.timer);
          dragState.current = null;
          return;
        } else return;
      }
      // Card positions were measured when the drag began; account for scrolling since.
      const target = targetIndex(e.clientX, e.clientY + (window.scrollY - st.scrollY), st.rects);
      setDrag({ key: st.key, x: e.clientX, y: e.clientY, target });
      const edge = 80;
      const speed = e.clientY < edge + 56 ? -(edge + 56 - e.clientY) / 4 : e.clientY > window.innerHeight - edge ? (e.clientY - (window.innerHeight - edge)) / 4 : 0;
      stopScroll();
      if (speed) {
        const step = () => {
          window.scrollBy(0, speed);
          autoScroll.current = requestAnimationFrame(step);
        };
        autoScroll.current = requestAnimationFrame(step);
      }
    };
    const finish = (commit: boolean) => {
      const st = dragState.current;
      dragState.current = null;
      stopScroll();
      if (st?.timer) clearTimeout(st.timer);
      const d = dragRef.current;
      setDrag(null);
      if (!st || !commit) return;
      if (!st.active) {
        toggle(st.key);
        return;
      }
      if (!d) return;
      const list = cardsRef.current;
      const from = list.findIndex((c) => c.key === d.key);
      let to = d.target;
      if (from < 0 || to === from || to === from + 1) return;
      const next = list.slice();
      const [m] = next.splice(from, 1);
      if (to > from) to--;
      next.splice(to, 0, m);
      change(next);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const touchMove = (e: TouchEvent) => {
      if (dragState.current?.active) e.preventDefault();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    document.addEventListener("touchmove", touchMove, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.removeEventListener("touchmove", touchMove);
    };
  });

  const save = async () => {
    setSaving(true);
    setError(undefined);
    setProgress({ v: null, l: "Building the PDF" });
    try {
      const main = docs[0];
      const { organizePdf } = await import("@/lib/pdf/pages");
      const src = async (d: Doc) => ({ bytes: new Uint8Array(await d.file.arrayBuffer()), name: d.file.name, password: d.password });
      const plan: PagePlan[] = cards.map((c) => (c.blank ? { blank: true } : { source: c.source, rotate: c.rotate, doc: c.doc }));
      const out = await organizePdf(await src(main), plan, await Promise.all(docs.slice(1).map(src)));
      setResults([out]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!docs.length)
    return (
      <div className="grid gap-4">
        {loading ? (
          <div className="grid min-h-72 place-items-center rounded-lg border border-line bg-paper">
            <span className="flex items-center gap-2 text-sm text-ink-2">
              <Spinner /> Opening…
            </span>
          </div>
        ) : (
          <DropZone accept="application/pdf,.pdf" onFiles={(f) => void addDoc(f[0], true)} label={tool.input?.label ?? "Choose a PDF"} />
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {dialog}
      </div>
    );

  const dragging = drag ? cards.find((c) => c.key === drag.key) : null;
  return (
    <div className="grid gap-4">
      <div className="sticky top-14 z-20 -mx-4 flex flex-wrap items-center gap-2 border-y border-line bg-paper/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
        <p className="mr-auto text-sm text-ink-2 tabular">
          {cards.length} page{cards.length === 1 ? "" : "s"}
          {sel.length ? ` · ${sel.length} selected` : ""}
        </p>
        {sel.length ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => rotate(targets, -90)} title="Rotate left">
              <RotateCcw />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => rotate(targets, 90)} title="Rotate right">
              <RotateCw />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => duplicate(targets)} title="Duplicate">
              <Copy />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => moveTo(targets, "start")} title="Move to start">
              <ArrowUpToLine />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => moveTo(targets, "end")} title="Move to end">
              <ArrowDownToLine />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => remove(targets)} title="Delete" className="text-danger hover:bg-danger-soft hover:text-danger">
              <Trash2 />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              <Square /> None
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(cards.map((c) => c.key)))}>
            <CheckSquare /> Select all
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={insertBlank} title={sel.length ? "Insert a blank page after the selection" : "Add a blank page at the end"}>
          <Plus /> <span className="hidden sm:inline">Blank page</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={extraPicker.open} title="Insert pages from a second file">
          <FilePlus2 /> <span className="hidden sm:inline">Add PDF</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => history.length && (setCards(history[history.length - 1]), setHistory((h) => h.slice(0, -1)))} disabled={!history.length} title="Undo">
          <Undo2 />
        </Button>
        <Button variant="primary" onClick={save} busy={saving} disabled={saving}>
          {tool.cta}
        </Button>
        {extraPicker.input}
      </div>
      <p className="text-xs text-ink-3">Tap pages to select them. Drag to reorder (on touch screens, press and hold first).</p>
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <ul ref={gridRef} className="grid grid-cols-3 gap-3 select-none sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
        {cards.map((c, i) => {
          const t = c.blank ? null : thumbs[`${c.doc}:${c.source}`];
          const isSel = selected.has(c.key);
          const showBefore = drag && drag.target === i && drag.key !== c.key;
          const showAfter = drag && drag.target === cards.length && i === cards.length - 1;
          return (
            <li key={c.key} data-card className="relative" onPointerDown={(e) => onPointerDown(e, c)}>
              {showBefore ? <span className="absolute top-0 -left-2 h-full w-1 rounded-full bg-carbon" /> : null}
              {showAfter ? <span className="absolute top-0 -right-2 h-full w-1 rounded-full bg-carbon" /> : null}
              <div className={cn("group relative grid gap-1.5 rounded-lg border bg-paper p-2 transition-[opacity,box-shadow,border-color]", isSel ? "border-carbon shadow-[0_0_0_2px_var(--carbon)]" : "border-line hover:border-ink-3", drag?.key === c.key && "opacity-30")} style={{ touchAction: drag ? "none" : "manipulation" }}>
                <div className="relative grid aspect-square place-items-center overflow-hidden rounded-md bg-paper-2">
                  {c.blank ? (
                    <div className="grid aspect-[1/1.414] h-[85%] place-items-center rounded-[2px] bg-white text-[10px] text-[#9aa1b0] shadow-sm">Blank</div>
                  ) : t ? (
                    <img src={t.url} alt={`Page ${c.source + 1}`} draggable={false} className="absolute inset-0 m-auto max-h-[86%] max-w-[86%] rounded-[2px] bg-white shadow-sm transition-transform duration-200" style={{ transform: `rotate(${c.rotate}deg)` }} />
                  ) : (
                    <Spinner className="text-ink-3" />
                  )}
                </div>
                <div className="flex items-center justify-between gap-1 px-0.5 text-[11px] text-ink-3 tabular">
                  <span className="font-semibold text-ink">{i + 1}</span>
                  <span>{c.blank ? "blank" : `${docs.length > 1 ? LETTERS[c.doc] + " " : ""}p.${c.source + 1}`}</span>
                </div>
                <span className={cn("absolute top-3 left-3 grid size-5 place-items-center rounded-full border-2 text-[10px]", isSel ? "border-carbon bg-carbon text-carbon-ink" : "border-line bg-paper/90 opacity-0 group-hover:opacity-100")}>{isSel ? "✓" : ""}</span>
                <div className="absolute top-2 right-2 flex flex-col gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                  <button type="button" onClick={() => rotate([c.key], 90)} className="grid size-7 place-items-center rounded-md border border-line bg-paper text-ink-2 shadow-sm hover:text-carbon" aria-label={`Rotate page ${i + 1}`}>
                    <RotateCw className="size-3.5" />
                  </button>
                  <button type="button" onClick={() => duplicate([c.key])} className="hidden size-7 place-items-center rounded-md border border-line bg-paper text-ink-2 shadow-sm hover:text-carbon sm:grid" aria-label={`Duplicate page ${i + 1}`}>
                    <Copy className="size-3.5" />
                  </button>
                  <button type="button" onClick={() => remove([c.key])} className="grid size-7 place-items-center rounded-md border border-line bg-paper text-ink-2 shadow-sm hover:text-danger" aria-label={`Delete page ${i + 1}`}>
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {docs.length > 1 ? (
        <p className="text-xs text-ink-3">
          {docs.map((d, i) => (
            <span key={i} className="mr-3">
              <b className="text-ink-2">{LETTERS[i]}</b> = {d.file.name}
            </span>
          ))}
        </p>
      ) : null}

      {drag && dragging ? (
        <div className="pointer-events-none fixed z-50 w-28 -translate-x-1/2 -translate-y-1/2 rotate-3 rounded-lg border border-carbon bg-paper p-1.5 shadow-panel" style={{ left: drag.x, top: drag.y }}>
          {dragging.blank ? <div className="aspect-[1/1.414] rounded bg-white" /> : <img src={thumbs[`${dragging.doc}:${dragging.source}`]?.url} alt="" className="w-full rounded bg-white" style={{ transform: `rotate(${dragging.rotate}deg)` }} />}
        </div>
      ) : null}

      <Dialog open={saving} onClose={() => undefined} title="Saving">
        <Progress value={progress.v} label={progress.l} />
      </Dialog>
      <Dialog open={!!results} onClose={() => setResults(null)} title="Saved">
        {results ? <ResultList results={results} tool={tool.slug} onReset={() => setResults(null)} resetLabel="Keep organizing" /> : null}
      </Dialog>
      {loading ? (
        <div className="fixed right-4 bottom-4 z-40 flex items-center gap-2 rounded-md border border-line bg-paper px-3 py-2 text-sm shadow-panel">
          <Spinner /> Adding pages…
        </div>
      ) : null}
      {dialog}
    </div>
  );
}
