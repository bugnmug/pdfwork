import { ChevronLeft, ChevronRight, Eraser, FilePlus2, Highlighter, PenLine, Redo2, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ResultList } from "@/components/results";
import { Button, Dialog, Notice, Select } from "@/components/ui";
import type { OutFile } from "@/lib/pdf/core";
import { markerPath, PAGE_SIZES, paperPattern, strokeOutline, type DrawPage, type DrawPoint, type Paper, type Stroke } from "@/lib/pdf/draw";
import { usePersistent } from "@/lib/storage";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";

type Doc = { pages: DrawPage[]; paper: Paper; orientation: "portrait" | "landscape" };
const EMPTY: Doc = { pages: [{ strokes: [] }], paper: "ruled", orientation: "portrait" };
const BLANK_PAGE: DrawPage = { strokes: [] };
const COLORS = ["#111827", "#1d4ed8", "#b91c1c", "#15803d"];
const MARKERS = ["#facc15", "#4ade80", "#f472b6", "#60a5fa"];
const WIDTHS = [1.4, 2.4, 4];

function paint(ctx: CanvasRenderingContext2D, page: DrawPage, paper: Paper, w: number, h: number, k: number, live?: Stroke | null) {
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const { lines, dots } = paperPattern(paper, w, h);
  for (const l of lines) {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = l.width;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  ctx.fillStyle = "#c3c9d6";
  for (const [x, y] of dots) {
    ctx.beginPath();
    ctx.arc(x, y, 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const s of live ? [...page.strokes, live] : page.strokes) {
    if (s.kind === "marker") {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = "multiply";
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke(new Path2D(markerPath(s.points)));
      ctx.restore();
    } else {
      const poly = strokeOutline(s.points, s.width);
      if (!poly.length) continue;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (const [x, y] of poly.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fill();
    }
  }
}

export default function Draw({ tool }: { tool: Tool }) {
  const [doc, setDoc] = usePersistent<Doc>("drawing", EMPTY, 800);
  const [index, setIndex] = useState(0);
  const [toolKind, setToolKind] = useState<"pen" | "marker" | "eraser">("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [marker, setMarker] = useState(MARKERS[0]);
  const [width, setWidth] = useState(WIDTHS[1]);
  const [results, setResults] = useState<OutFile[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [cssW, setCssW] = useState(600);
  const live = useRef<Stroke | null>(null);
  const penSeen = useRef(false);
  const history = useRef<{ undo: DrawPage[][]; redo: DrawPage[][] }>({ undo: [], redo: [] });
  const [, force] = useState(0);

  const page = doc.pages[Math.min(index, doc.pages.length - 1)] ?? BLANK_PAGE;
  const [W, H] = PAGE_SIZES[doc.orientation];
  const k = cssW / W;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setCssW(Math.min(900, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const redraw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssW * (H / W) * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    paint(c.getContext("2d")!, page, doc.paper, W, H, k * dpr, live.current);
  }, [cssW, H, W, page, doc.paper, k]);
  useEffect(() => redraw(), [redraw]);

  const commitPages = (pages: DrawPage[]) => {
    history.current.undo.push(doc.pages);
    if (history.current.undo.length > 100) history.current.undo.shift();
    history.current.redo = [];
    setDoc((d) => ({ ...d, pages }));
  };
  const setPageStrokes = (strokes: Stroke[]) => commitPages(doc.pages.map((p, i) => (i === index ? { strokes } : p)));

  const pt = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  const eraseAt = (x: number, y: number, strokes: Stroke[]) => {
    const r = 8;
    return strokes.filter((s) => !s.points.some(([px, py]) => Math.hypot(px - x, py - y) < r + s.width / 2));
  };
  const erasing = useRef<Stroke[] | null>(null);

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "pen") penSeen.current = true;
    if (e.pointerType === "touch" && penSeen.current) return; // palm rejection once a stylus is used
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = pt(e);
    if (toolKind === "eraser") {
      erasing.current = eraseAt(x, y, page.strokes);
      return;
    }
    const pressure = e.pointerType === "pen" && e.pressure ? e.pressure : 0.55;
    live.current = toolKind === "marker" ? { kind: "marker", color: marker, width: width * 5, points: [[x, y, 1]] } : { kind: "pen", color, width, points: [[x, y, pressure]] };
    redraw();
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (erasing.current) {
      const [x, y] = pt(e);
      const next = eraseAt(x, y, erasing.current);
      if (next.length !== erasing.current.length) {
        erasing.current = next;
        paint(canvas.current!.getContext("2d")!, { strokes: next }, doc.paper, W, H, k * Math.min(2.5, window.devicePixelRatio || 1));
      }
      return;
    }
    const s = live.current;
    if (!s) return;
    const events = (e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]) as PointerEvent[];
    for (const ev of events) {
      const [x, y] = pt(ev);
      const last = s.points[s.points.length - 1];
      const d = Math.hypot(x - last[0], y - last[1]);
      if (d < 0.6) continue;
      // A mouse has no pressure: thin the line a little when moving fast, like ink.
      const p = ev.pointerType === "pen" && ev.pressure ? ev.pressure : Math.max(0.3, Math.min(0.85, 0.9 - d / 18));
      s.points.push([x, y, last[2] * 0.6 + p * 0.4] as DrawPoint);
    }
    redraw();
  };
  const onUp = () => {
    if (erasing.current) {
      if (erasing.current.length !== page.strokes.length) setPageStrokes(erasing.current);
      erasing.current = null;
      return;
    }
    const s = live.current;
    live.current = null;
    if (s) setPageStrokes([...page.strokes, s]);
  };

  const undo = () => {
    const prev = history.current.undo.pop();
    if (!prev) return;
    history.current.redo.push(doc.pages);
    setDoc((d) => ({ ...d, pages: prev }));
    setIndex((i) => Math.min(i, prev.length - 1));
    force((n) => n + 1);
  };
  const redo = () => {
    const next = history.current.redo.pop();
    if (!next) return;
    history.current.undo.push(doc.pages);
    setDoc((d) => ({ ...d, pages: next }));
    force((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const { drawingToPdf } = await import("@/lib/pdf/draw");
      setResults([await drawingToPdf(doc.pages, { paper: doc.paper, orientation: doc.orientation, name: `notes-${new Date().toISOString().slice(0, 10)}` })]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toolBtn = (kind: typeof toolKind, Icon: typeof PenLine, label: string) => (
    <button type="button" onClick={() => setToolKind(kind)} aria-pressed={toolKind === kind} title={label} className={cn("flex h-9 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium", toolKind === kind ? "bg-carbon text-carbon-ink" : "text-ink-2 hover:bg-paper-2")}>
      <Icon className="size-4" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );

  return (
    <div className="grid gap-3">
      <div className="sticky top-14 z-20 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-line bg-paper/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex gap-0.5">
          {toolBtn("pen", PenLine, "Pen")}
          {toolBtn("marker", Highlighter, "Marker")}
          {toolBtn("eraser", Eraser, "Eraser")}
        </div>
        {toolKind !== "eraser" ? (
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
            {(toolKind === "marker" ? MARKERS : COLORS).map((c) => {
              const on = (toolKind === "marker" ? marker : color) === c;
              return (
                <button key={c} type="button" role="radio" aria-checked={on} aria-label={c} onClick={() => (toolKind === "marker" ? setMarker(c) : setColor(c))} className={cn("grid size-7 place-items-center rounded-full", on && "ring-2 ring-carbon")}>
                  <span className="size-5 rounded-full border border-black/10" style={{ background: c }} />
                </button>
              );
            })}
          </div>
        ) : null}
        {toolKind !== "eraser" ? (
          <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Thickness">
            {WIDTHS.map((w) => (
              <button key={w} type="button" role="radio" aria-checked={width === w} aria-label={`Thickness ${w}`} onClick={() => setWidth(w)} className={cn("grid size-8 place-items-center rounded-md", width === w ? "bg-paper-2 ring-1 ring-line" : "hover:bg-paper-2")}>
                <span className="rounded-full bg-ink" style={{ width: w * 2 + 2, height: w * 2 + 2 }} />
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex">
          <Button variant="ghost" size="icon" onClick={undo} disabled={!history.current.undo.length} aria-label="Undo">
            <Undo2 />
          </Button>
          <Button variant="ghost" size="icon" onClick={redo} disabled={!history.current.redo.length} aria-label="Redo">
            <Redo2 />
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Select value={doc.paper} onChange={(e) => setDoc((d) => ({ ...d, paper: e.target.value as Paper }))} className="h-9 w-28 text-[13px]" aria-label="Paper">
            <option value="ruled">Ruled</option>
            <option value="plain">Plain</option>
            <option value="grid">Grid</option>
            <option value="dots">Dots</option>
          </Select>
          <Select value={doc.orientation} onChange={(e) => setDoc((d) => ({ ...d, orientation: e.target.value as Doc["orientation"] }))} className="hidden h-9 w-32 text-[13px] sm:block" aria-label="Orientation">
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </Select>
          <Button variant="primary" onClick={save} busy={saving} disabled={saving}>
            {tool.cta}
          </Button>
        </div>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div ref={wrap} className="grid justify-items-center">
        <canvas
          ref={canvas}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className={cn("touch-none rounded-[3px] bg-white shadow-[0_1px_3px_rgb(0_0_0/0.18),0_0_0_1px_rgb(0_0_0/0.06)]", toolKind === "eraser" ? "cursor-cell" : "cursor-crosshair")}
          style={{ width: cssW, height: cssW * (H / W) }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="text-sm text-ink-2 tabular">
          Page {index + 1} of {doc.pages.length}
        </span>
        <Button variant="ghost" size="icon" onClick={() => setIndex((i) => Math.min(doc.pages.length - 1, i + 1))} disabled={index >= doc.pages.length - 1} aria-label="Next page">
          <ChevronRight />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            commitPages([...doc.pages.slice(0, index + 1), { strokes: [] }, ...doc.pages.slice(index + 1)]);
            setIndex(index + 1);
          }}
        >
          <FilePlus2 /> New page
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (doc.pages.length === 1) setPageStrokes([]);
            else {
              commitPages(doc.pages.filter((_, i) => i !== index));
              setIndex((i) => Math.max(0, i - 1));
            }
          }}
          className="hover:text-danger"
        >
          <Trash2 /> {doc.pages.length === 1 ? "Clear page" : "Delete page"}
        </Button>
      </div>
      <p className="text-center text-xs text-ink-3">Your drawing is kept in this browser until you clear it. With a stylus, your palm is ignored and pen pressure changes the line width.</p>
      <Dialog open={!!results} onClose={() => setResults(null)} title="Saved">
        {results ? <ResultList results={results} tool={tool.slug} onReset={() => setResults(null)} resetLabel="Keep drawing" /> : null}
      </Dialog>
    </div>
  );
}
