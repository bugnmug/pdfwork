/**
 * The page editor behind Edit PDF, Edit PDF Text, Sign PDF and Redact PDF.
 * Pages are rendered with PDF.js; everything you add lives in an overlay as
 * plain objects (in PDF points) until you save, when they are written into the
 * file by lib/pdf/edit (or burned in by lib/pdf/redact).
 */
import {
  Bold,
  CalendarDays,
  Circle,
  Eraser,
  Highlighter,
  ImagePlus,
  Italic,
  Loader2,
  Minus,
  MousePointer2,
  MoveUpRight,
  PenLine,
  Redo2,
  Search,
  Signature as SignatureIcon,
  Square,
  SquareSlash,
  TextCursor,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DropZone, useFilePicker } from "@/components/dropzone";
import { isPasswordError, usePasswordPrompt } from "@/components/password";
import { ResultList } from "@/components/results";
import { SignatureDialog, type Signature } from "@/components/signature";
import { Button, Dialog, Input, Notice, Progress, Select, Spinner, Switch } from "@/components/ui";
import { take } from "@/lib/handoff";
import type { OutFile } from "@/lib/pdf/core";
import { arrowHead, BASELINE, LINE_HEIGHT, svgInk, type EditObject, type TextObj } from "@/lib/pdf/edit";
import type { Family } from "@/lib/pdf/fonts";
import type { Box } from "@/lib/pdf/redact";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";
import { useThrottledProgress } from "./workspace";

type Mode = "select" | "text" | "draw" | "highlight" | "whiteout" | "rect" | "ellipse" | "line" | "arrow" | "edit-text" | "redact";
type Pt = [number, number];
type Size = { w: number; h: number };

const MODES: Record<Mode, { label: string; icon: LucideIcon; key: string; hint: string }> = {
  select: { label: "Select", icon: MousePointer2, key: "v", hint: "Click an item to move, resize or delete it." },
  text: { label: "Text", icon: Type, key: "t", hint: "Click where the text should go, then type." },
  "edit-text": { label: "Edit text", icon: TextCursor, key: "e", hint: "Click any line of existing text to rewrite it." },
  draw: { label: "Draw", icon: PenLine, key: "d", hint: "Draw freehand with the mouse, a finger or a pen." },
  highlight: { label: "Highlight", icon: Highlighter, key: "h", hint: "Drag across text to highlight it." },
  whiteout: { label: "Whiteout", icon: Eraser, key: "w", hint: "Drag over anything to cover it with white (or a matching colour)." },
  rect: { label: "Box", icon: Square, key: "r", hint: "Drag to draw a rectangle." },
  ellipse: { label: "Circle", icon: Circle, key: "o", hint: "Drag to draw an ellipse." },
  line: { label: "Line", icon: Minus, key: "l", hint: "Drag to draw a line." },
  arrow: { label: "Arrow", icon: MoveUpRight, key: "a", hint: "Drag to draw an arrow." },
  redact: { label: "Redact", icon: SquareSlash, key: "x", hint: "Drag boxes over anything that must be removed for good." },
};

const TOOLSETS: Record<string, Mode[]> = {
  "edit-pdf": ["select", "text", "edit-text", "draw", "highlight", "whiteout", "rect", "ellipse", "line", "arrow"],
  "edit-text": ["select", "edit-text", "text", "whiteout"],
  "sign-pdf": ["select", "text", "draw"],
  "redact-pdf": ["select", "redact"],
};
const START_MODE: Record<string, Mode> = { "edit-pdf": "select", "edit-text": "edit-text", "sign-pdf": "select", "redact-pdf": "redact" };

const COLORS = ["#111827", "#1d4ed8", "#b91c1c", "#15803d", "#7c3aed", "#ea580c", "#ffffff"];
const HIGHLIGHTS = ["#fde047", "#86efac", "#f9a8d4", "#93c5fd", "#fdba74"];
const FONT_CSS: Record<Family, string> = {
  sans: '"Doc Sans", "Doc Deva", "DejaVu Sans", sans-serif',
  serif: '"Doc Serif", "Doc Deva", serif',
  mono: '"Doc Mono", "Doc Deva", monospace',
};

const NONE: EditObject[] = [];
let seq = 0;
const newId = () => `o${Date.now().toString(36)}${(++seq).toString(36)}`;

/* ------------------------------------------------------------ geometry */

type BBox = { x: number; y: number; w: number; h: number };

function bboxOf(o: EditObject, measured?: Size): BBox {
  switch (o.type) {
    case "text":
      return { x: o.x, y: o.y, w: measured?.w ?? Math.max(20, o.text.length * o.size * 0.5), h: measured?.h ?? o.size * LINE_HEIGHT * Math.max(1, o.text.split("\n").length) };
    case "line":
      return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
    case "ink": {
      const xs = o.points.map((p) => p[0]);
      const ys = o.points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y) };
    }
    default:
      return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
}

function translate(o: EditObject, dx: number, dy: number): EditObject {
  switch (o.type) {
    case "line":
      return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
    case "ink":
      return { ...o, points: o.points.map(([x, y]) => [x + dx, y + dy] as Pt) };
    default:
      return { ...o, x: o.x + dx, y: o.y + dy };
  }
}

type Handle = "nw" | "ne" | "sw" | "se" | "p1" | "p2";

function resize(o: EditObject, h: Handle, dx: number, dy: number, start: BBox, keepRatio: boolean): EditObject {
  if (o.type === "line") return h === "p1" ? { ...o, x1: o.x1 + dx, y1: o.y1 + dy } : { ...o, x2: o.x2 + dx, y2: o.y2 + dy };
  let { x, y, w, h: hh } = start;
  if (h === "nw" || h === "sw") {
    x += dx;
    w -= dx;
  } else w += dx;
  if (h === "nw" || h === "ne") {
    y += dy;
    hh -= dy;
  } else hh += dy;
  const min = 4;
  if (keepRatio || o.type === "text") {
    const ratio = start.w / Math.max(1, start.h);
    const sx = w / Math.max(1, start.w);
    const sy = hh / Math.max(1, start.h);
    const s = Math.max(0.05, Math.abs(sx - 1) > Math.abs(sy - 1) ? sx : sy);
    w = start.w * s;
    hh = w / ratio;
    if (h === "nw" || h === "sw") x = start.x + start.w - w;
    else x = start.x;
    if (h === "nw" || h === "ne") y = start.y + start.h - hh;
    else y = start.y;
    if (o.type === "text") return { ...o, x, y, size: Math.max(4, Math.min(400, (o as TextObj).size * s)) };
  }
  if (w < min) {
    if (h === "nw" || h === "sw") x -= min - w;
    w = min;
  }
  if (hh < min) {
    if (h === "nw" || h === "ne") y -= min - hh;
    hh = min;
  }
  if (o.type === "ink") {
    const sx = w / Math.max(1, start.w);
    const sy = hh / Math.max(1, start.h);
    return { ...o, points: o.points.map(([px, py]) => [x + (px - start.x) * sx, y + (py - start.y) * sy] as Pt) };
  }
  return { ...o, x, y, w, h: hh };
}

/* ----------------------------------------------------- text under pages */

type Seg = { text: string; x: number; y: number; w: number; h: number; base: number; size: number; family: Family; bold: boolean; italic: boolean };

async function pageSegments(pdf: PDFDocumentProxy, index: number): Promise<Seg[]> {
  const { pageText, toLines, enrichFontStyles } = await import("@/lib/pdf/pdfjs");
  const { segments } = await import("@/lib/pdf/structure");
  const page = await pdf.getPage(index + 1);
  const pt = await pageText(page);
  await enrichFontStyles(page, pt.items);
  page.cleanup();
  const out: Seg[] = [];
  for (const line of toLines(pt)) {
    if (line.dir !== 0) continue;
    for (const s of segments(line)) {
      const its = s.items;
      if (!its.length || !s.text.trim()) continue;
      const y = Math.min(...its.map((i) => i.y));
      const h = Math.max(...its.map((i) => i.y + i.h)) - y;
      const chars = its.reduce((n, i) => n + i.str.length, 0) || 1;
      const size = its.reduce((n, i) => n + i.fontSize * i.str.length, 0) / chars;
      out.push({
        text: s.text.replace(/\s+/g, " ").trim(),
        x: s.x,
        y,
        w: s.x2 - s.x,
        h,
        base: its.reduce((n, i) => n + i.base, 0) / its.length,
        size,
        family: its[0].family,
        bold: its.filter((i) => i.bold).length > its.length / 2,
        italic: its.filter((i) => i.italic).length > its.length / 2,
      });
    }
  }
  return out;
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** Background and ink colours of a text box on a rendered page. */
function sampleColors(canvas: HTMLCanvasElement | null, box: BBox, k: number): { bg: string; fg: string } {
  const fallback = { bg: "#ffffff", fg: "#111827" };
  if (!canvas || !canvas.width) return fallback;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;
  const s = k;
  const x0 = Math.max(0, Math.floor((box.x - 2) * s));
  const y0 = Math.max(0, Math.floor((box.y - 2) * s));
  const x1 = Math.min(canvas.width - 1, Math.ceil((box.x + box.w + 2) * s));
  const y1 = Math.min(canvas.height - 1, Math.ceil((box.y + box.h + 2) * s));
  if (x1 <= x0 || y1 <= y0) return fallback;
  const data = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  const W = data.width;
  const H = data.height;
  const px = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return [data.data[i], data.data[i + 1], data.data[i + 2]] as const;
  };
  const lum = (c: readonly number[]) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  const border: (readonly number[])[] = [];
  for (let x = 0; x < W; x++) border.push(px(x, 0), px(x, H - 1));
  for (let y = 0; y < H; y++) border.push(px(0, y), px(W - 1, y));
  border.sort((a, b) => lum(a) - lum(b));
  const bg = border[Math.floor(border.length / 2)];
  const inner: (readonly number[])[] = [];
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) inner.push(px(x, y));
  const bl = lum(bg);
  inner.sort((a, b) => Math.abs(lum(b) - bl) - Math.abs(lum(a) - bl));
  const top = inner.slice(0, Math.max(1, Math.floor(inner.length * 0.08)));
  const avg = [0, 1, 2].map((c) => top.reduce((n, p) => n + p[c], 0) / top.length);
  const fg = Math.abs(lum(avg) - bl) < 40 ? (bl > 128 ? [17, 24, 39] : [255, 255, 255]) : avg;
  return { bg: hex(bg[0], bg[1], bg[2]), fg: hex(fg[0], fg[1], fg[2]) };
}

/* ---------------------------------------------------------- page render */

let renderChain: Promise<unknown> = Promise.resolve();
function queueRender<T>(job: () => Promise<T>): Promise<T> {
  const p = renderChain.then(job, job);
  renderChain = p.catch(() => undefined);
  return p;
}

function usePageCanvas(pdf: PDFDocumentProxy, index: number, cssWidth: number, visible: boolean) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendered = useRef(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!visible) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const target = Math.round(cssWidth * dpr);
    if (Math.abs(rendered.current - target) < 2) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void queueRender(async () => {
        if (cancelled) return;
        const { renderPage } = await import("@/lib/pdf/pdfjs");
        const page = await pdf.getPage(index + 1);
        const vp = page.getViewport({ scale: 1 });
        const src = await renderPage(page, target / vp.width, { maxPixels: 14_000_000 });
        page.cleanup();
        const c = canvasRef.current;
        if (cancelled || !c) return;
        c.width = src.width;
        c.height = src.height;
        c.getContext("2d", { willReadFrequently: true })!.drawImage(src, 0, 0);
        rendered.current = target;
        setReady(true);
      });
    }, rendered.current ? 180 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pdf, index, cssWidth, visible]);
  return { canvasRef, ready };
}

/* -------------------------------------------------------- object views */

const TextView = memo(function TextView({ o, k, onMeasure }: { o: TextObj; k: number; onMeasure: (id: string, s: Size) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) onMeasure(o.id, { w: el.offsetWidth / k, h: el.offsetHeight / k });
  });
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute whitespace-pre"
      style={{ left: o.x * k, top: o.y * k, fontFamily: FONT_CSS[o.family], fontSize: o.size * k, lineHeight: LINE_HEIGHT, color: o.color, fontWeight: o.bold ? 700 : 400, fontStyle: o.italic ? "italic" : "normal" }}
    >
      {o.text || " "}
    </div>
  );
});

function TextEditor({ o, k, onDone }: { o: TextObj; k: number; onDone: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current!;
    el.innerText = o.text;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone((ref.current?.innerText ?? "").replace(/\n+$/, ""));
  };
  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label="Text"
      aria-multiline="true"
      onBlur={finish}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          ref.current?.blur();
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
      }}
      className="absolute z-20 min-w-[2ch] whitespace-pre outline-2 outline-offset-2 outline-carbon outline-dashed"
      style={{ left: o.x * k, top: o.y * k, fontFamily: FONT_CSS[o.family], fontSize: o.size * k, lineHeight: LINE_HEIGHT, color: o.color, fontWeight: o.bold ? 700 : 400, fontStyle: o.italic ? "italic" : "normal", caretColor: "var(--carbon)" }}
    />
  );
}

function BoxView({ o, k, redactPreview }: { o: EditObject; k: number; redactPreview?: boolean }) {
  if (o.type === "image")
    return <img src={o.src} alt="" draggable={false} className="pointer-events-none absolute select-none" style={{ left: o.x * k, top: o.y * k, width: o.w * k, height: o.h * k, opacity: o.opacity ?? 1 }} />;
  if (o.type === "ellipse")
    return <div className="pointer-events-none absolute rounded-[50%]" style={{ left: o.x * k, top: o.y * k, width: o.w * k, height: o.h * k, border: o.fill ? undefined : `${Math.max(1, o.strokeWidth * k)}px solid ${o.color}`, background: o.fill ? o.color : undefined }} />;
  if (o.type !== "rect") return null;
  const style: React.CSSProperties = { left: o.x * k, top: o.y * k, width: o.w * k, height: o.h * k };
  if (o.mode === "whiteout") return <div className="pointer-events-none absolute outline-1 outline-[#94a3b8]/60 outline-dotted" style={{ ...style, background: o.color }} />;
  if (o.mode === "highlight") return <div className="pointer-events-none absolute mix-blend-multiply" style={{ ...style, background: o.color, opacity: 0.45 }} />;
  if (o.mode === "redact")
    return (
      <div
        className="pointer-events-none absolute outline-1 outline-[#ef4444]"
        style={{ ...style, background: redactPreview ? "#000" : "repeating-linear-gradient(135deg, rgb(0 0 0 / 0.86) 0 6px, rgb(40 40 40 / 0.86) 6px 12px)" }}
      />
    );
  return <div className="pointer-events-none absolute" style={{ ...style, border: o.fill ? undefined : `${Math.max(1, (o.strokeWidth ?? 2) * k)}px solid ${o.color}`, background: o.fill ? o.color : undefined }} />;
}

/* ---------------------------------------------------------------- page */

type PageProps = {
  pdf: PDFDocumentProxy;
  index: number;
  size: Size;
  k: number;
  mode: Mode;
  objects: EditObject[];
  selected: string | null;
  editing: string | null;
  style: StudioStyle;
  showSegments: boolean;
  redactPreview: boolean;
  onVisible: (index: number, ratio: number) => void;
  api: PageApi;
};

type StudioStyle = { color: string; size: number; family: Family; bold: boolean; italic: boolean; stroke: number; highlight: string; fill: boolean };

type PageApi = {
  select: (id: string | null) => void;
  setEditing: (id: string | null) => void;
  create: (o: EditObject, opts?: { edit?: boolean; select?: boolean }) => void;
  createMany: (o: EditObject[], editId?: string) => void;
  live: (fn: (cur: EditObject[]) => EditObject[]) => void;
  begin: () => void;
  end: (changedIds?: string[]) => void;
  finishText: (id: string, text: string) => void;
  segments: (index: number) => Promise<Seg[]>;
  measured: Map<string, Size>;
  onMeasure: (id: string, s: Size) => void;
  canvasFor: (index: number) => HTMLCanvasElement | null;
  registerCanvas: (index: number, c: HTMLCanvasElement | null) => void;
};

type Gesture =
  | { kind: "create"; mode: Mode; start: Pt; cur: Pt; points: Pt[] }
  | { kind: "move"; id: string; start: Pt; orig: EditObject }
  | { kind: "resize"; id: string; handle: Handle; start: Pt; orig: EditObject; box: BBox };

const StudioPage = memo(function StudioPage({ pdf, index, size, k, mode, objects, selected, editing, style, showSegments, redactPreview, onVisible, api }: PageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(index < 2);
  const cssW = size.w * k;
  const cssH = size.h * k;
  const { canvasRef, ready } = usePageCanvas(pdf, index, cssW, visible);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gRef = useRef<Gesture | null>(null);
  gRef.current = gesture;
  const [segs, setSegs] = useState<Seg[] | null>(null);
  const [hoverSeg, setHoverSeg] = useState<number>(-1);

  useEffect(() => {
    api.registerCanvas(index, canvasRef.current);
    return () => api.registerCanvas(index, null);
  }, [api, index, canvasRef]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Render a little ahead of scrolling…
    const near = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "900px 0px" });
    // …and track how much of the page is on screen, to know the "current" page.
    const seen = new IntersectionObserver((entries) => entries.forEach((e) => onVisible(index, e.intersectionRatio)), { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    near.observe(el);
    seen.observe(el);
    return () => {
      near.disconnect();
      seen.disconnect();
    };
  }, [index, onVisible]);

  useEffect(() => {
    if (!showSegments || !visible || segs) return;
    let alive = true;
    api.segments(index).then((s) => alive && setSegs(s));
    return () => {
      alive = false;
    };
  }, [showSegments, visible, segs, api, index]);

  const toPt = (e: { clientX: number; clientY: number }): Pt => {
    const r = overlayRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  };
  const segAt = (p: Pt) => (segs ?? []).findIndex((s) => p[0] >= s.x - 2 && p[0] <= s.x + s.w + 2 && p[1] >= s.y - 2 && p[1] <= s.y + s.h + 2);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toPt(e);
    if (editing) {
      // A click outside the text being typed just finishes it.
      (document.activeElement as HTMLElement | null)?.blur();
      e.preventDefault();
      return;
    }
    if (mode === "select") {
      api.select(null);
      return;
    }
    if (mode === "text") {
      const o: TextObj = { id: newId(), page: index, type: "text", x: p[0], y: p[1] - style.size * 0.6, text: "", size: style.size, color: style.color, family: style.family, bold: style.bold, italic: style.italic };
      api.create(o, { edit: true, select: true });
      e.preventDefault();
      return;
    }
    if (mode === "edit-text") {
      const i = segAt(p);
      if (i < 0) {
        toast.message(segs && !segs.length ? "This page has no editable text. Scanned pages need OCR first, or use Text and Whiteout." : "Click directly on a line of text.");
        return;
      }
      const s = segs![i];
      const { bg, fg } = sampleColors(api.canvasFor(index), s, (canvasRef.current?.width ?? cssW) / size.w);
      const cover: EditObject = { id: newId(), page: index, type: "rect", mode: "whiteout", x: s.x - 1, y: s.y - 0.5, w: s.w + 2, h: s.h + 1, color: bg };
      const text: TextObj = { id: newId(), page: index, type: "text", x: s.x, y: s.base - BASELINE * s.size, text: s.text, original: s.text, size: Math.round(s.size * 10) / 10, color: fg, family: s.family, bold: s.bold, italic: s.italic, coverId: cover.id };
      api.createMany([cover, text], text.id);
      e.preventDefault();
      return;
    }
    overlayRef.current?.setPointerCapture(e.pointerId);
    setGesture({ kind: "create", mode, start: p, cur: p, points: [p] });
  };

  const onMove = (e: React.PointerEvent) => {
    const g = gRef.current;
    if (!g) {
      if (mode === "edit-text" && segs) setHoverSeg(segAt(toPt(e)));
      return;
    }
    const p = toPt(e);
    if (g.kind === "create") {
      const pts = g.mode === "draw" ? (Math.hypot(p[0] - g.cur[0], p[1] - g.cur[1]) > 0.8 / Math.max(0.3, k) ? [...g.points, p] : g.points) : g.points;
      setGesture({ ...g, cur: p, points: pts });
    } else if (g.kind === "move") {
      const dx = p[0] - g.start[0];
      const dy = p[1] - g.start[1];
      api.live((cur) => cur.map((o) => (o.id === g.id ? translate(g.orig, dx, dy) : o)));
    } else {
      const dx = p[0] - g.start[0];
      const dy = p[1] - g.start[1];
      api.live((cur) => cur.map((o) => (o.id === g.id ? resize(g.orig, g.handle, dx, dy, g.box, g.orig.type === "image" && !e.shiftKey) : o)));
    }
  };

  const onUp = () => {
    const g = gRef.current;
    setGesture(null);
    if (!g) return;
    if (g.kind !== "create") {
      api.end([g.id]);
      return;
    }
    const [x0, y0] = g.start;
    const [x1, y1] = g.cur;
    const dragged = Math.hypot(x1 - x0, y1 - y0) > 3;
    const box = dragged ? { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) } : null;
    const base = { id: newId(), page: index };
    switch (g.mode) {
      case "draw":
        if (g.points.length) api.create({ ...base, type: "ink", points: g.points, color: style.color, strokeWidth: style.stroke });
        break;
      case "highlight": {
        if (box && box.h >= 6) {
          api.create({ ...base, type: "rect", mode: "highlight", color: style.highlight, ...box });
          break;
        }
        // A flat drag or a click: snap to the line of text underneath.
        const cy = (y0 + y1) / 2;
        const lo = Math.min(x0, x1);
        const hi = Math.max(x0, x1);
        const color = style.highlight;
        void api.segments(index).then((segs) => {
          const line = segs.find((sg) => cy >= sg.y - 1.5 && cy <= sg.y + sg.h + 1.5 && hi >= sg.x - 2 && lo <= sg.x + sg.w + 2);
          const hb = line
            ? dragged
              ? { x: Math.max(line.x, lo), y: line.y, w: Math.min(line.x + line.w, hi) - Math.max(line.x, lo), h: line.h }
              : { x: line.x, y: line.y, w: line.w, h: line.h }
            : { x: dragged ? lo : lo - 40, y: cy - 7, w: dragged ? hi - lo : 80, h: 14 };
          if (hb.w > 1) api.create({ ...base, type: "rect", mode: "highlight", color, ...hb });
        });
        break;
      }
      case "whiteout": {
        const b = box ?? { x: x0 - 50, y: y0 - 10, w: 100, h: 20 };
        api.create({ ...base, type: "rect", mode: "whiteout", color: sampleColors(api.canvasFor(index), b, (canvasRef.current?.width ?? cssW) / size.w).bg, ...b });
        break;
      }
      case "redact":
        api.create({ ...base, type: "rect", mode: "redact", color: "#000000", ...(box ?? { x: x0 - 50, y: y0 - 8, w: 100, h: 16 }) });
        break;
      case "rect":
        api.create({ ...base, type: "rect", mode: "box", color: style.color, strokeWidth: style.stroke, fill: style.fill, ...(box ?? { x: x0 - 50, y: y0 - 30, w: 100, h: 60 }) }, { select: true });
        break;
      case "ellipse":
        api.create({ ...base, type: "ellipse", color: style.color, strokeWidth: style.stroke, fill: style.fill, ...(box ?? { x: x0 - 40, y: y0 - 40, w: 80, h: 80 }) }, { select: true });
        break;
      case "line":
      case "arrow":
        api.create({ ...base, type: "line", x1: x0, y1: y0, x2: dragged ? x1 : x0 + 100, y2: dragged ? y1 : y0, color: style.color, strokeWidth: style.stroke, arrow: g.mode === "arrow" }, { select: true });
        break;
    }
  };

  const startMove = (e: React.PointerEvent, o: EditObject) => {
    if (mode !== "select" || e.button !== 0) return;
    e.stopPropagation();
    api.select(o.id);
    api.begin();
    overlayRef.current?.setPointerCapture(e.pointerId);
    setGesture({ kind: "move", id: o.id, start: toPt(e), orig: o });
  };
  const startResize = (e: React.PointerEvent, o: EditObject, handle: Handle) => {
    e.stopPropagation();
    api.begin();
    overlayRef.current?.setPointerCapture(e.pointerId);
    setGesture({ kind: "resize", id: o.id, handle, start: toPt(e), orig: o, box: bboxOf(o, api.measured.get(o.id)) });
  };

  const svgObjects = objects.filter((o) => o.type === "line" || o.type === "ink");
  const sel = selected ? objects.find((o) => o.id === selected) : undefined;
  const draft = gesture?.kind === "create" ? gesture : null;
  const cursor = mode === "select" ? "default" : mode === "text" ? "text" : mode === "edit-text" ? (hoverSeg >= 0 ? "text" : "default") : "crosshair";

  return (
    <div ref={wrapRef} data-page={index} className="relative mx-auto" style={{ width: cssW, height: cssH }}>
      <div className="absolute inset-0 overflow-hidden rounded-[3px] bg-white shadow-[0_1px_3px_rgb(0_0_0/0.18),0_0_0_1px_rgb(0_0_0/0.06)]">
        <canvas ref={canvasRef} className={cn("size-full transition-opacity", ready ? "opacity-100" : "opacity-0")} />
        {!ready ? (
          <div className="absolute inset-0 grid place-items-center text-[#9aa1b0]">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : null}
      </div>
      <div
        ref={overlayRef}
        className="absolute inset-0"
        style={{ cursor, touchAction: mode === "select" || mode === "edit-text" || mode === "text" ? "pan-x pan-y" : "none" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setHoverSeg(-1)}
      >
        {showSegments && segs
          ? segs.map((s, i) => (
              <div
                key={i}
                className={cn("pointer-events-none absolute rounded-[2px]", i === hoverSeg ? "bg-carbon/10 outline-2 outline-carbon" : "outline-1 outline-carbon/25 outline-dashed")}
                style={{ left: (s.x - 1.5) * k, top: (s.y - 1) * k, width: (s.w + 3) * k, height: (s.h + 2) * k }}
              />
            ))
          : null}
        {objects.map((o) =>
          o.type === "text" ? (
            editing === o.id ? (
              <TextEditor key={o.id} o={o} k={k} onDone={(t) => api.finishText(o.id, t)} />
            ) : (
              <div key={o.id} onPointerDown={(e) => startMove(e, o)} onDoubleClick={() => mode === "select" && api.setEditing(o.id)}>
                <TextView o={o} k={k} onMeasure={api.onMeasure} />
                <HitBox o={o} k={k} measured={api.measured.get(o.id)} active={mode === "select"} />
              </div>
            )
          ) : o.type === "line" || o.type === "ink" ? null : (
            <div key={o.id} onPointerDown={(e) => startMove(e, o)}>
              <BoxView o={o} k={k} redactPreview={redactPreview} />
              <HitBox o={o} k={k} active={mode === "select"} />
            </div>
          ),
        )}
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none">
          {svgObjects.map((o) => {
            const d = o.type === "ink" ? svgInk(o.points) : `M ${o.x1} ${o.y1} L ${o.x2} ${o.y2}`;
            return (
              <g key={o.id}>
                <path d={d} fill="none" stroke={o.color} strokeWidth={o.strokeWidth} strokeLinecap="round" strokeLinejoin="round" opacity={o.type === "ink" ? (o.opacity ?? 1) : 1} />
                {o.type === "line" && o.arrow ? <path d={arrowHead(o.x1, o.y1, o.x2, o.y2, o.strokeWidth)} fill={o.color} /> : null}
                <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(10 / k, o.strokeWidth + 6)} className={mode === "select" ? "pointer-events-[stroke] cursor-move" : ""} onPointerDown={(e) => startMove(e, o)} />
              </g>
            );
          })}
          {draft && draft.mode === "draw" ? <path d={svgInk(draft.points)} fill="none" stroke={style.color} strokeWidth={style.stroke} strokeLinecap="round" strokeLinejoin="round" /> : null}
          {draft && (draft.mode === "line" || draft.mode === "arrow") ? <path d={`M ${draft.start[0]} ${draft.start[1]} L ${draft.cur[0]} ${draft.cur[1]}`} stroke={style.color} strokeWidth={style.stroke} strokeLinecap="round" /> : null}
        </svg>
        {draft && draft.mode !== "draw" && draft.mode !== "line" && draft.mode !== "arrow" ? (
          <div
            className={cn("pointer-events-none absolute", draft.mode === "ellipse" && "rounded-[50%]")}
            style={{
              left: Math.min(draft.start[0], draft.cur[0]) * k,
              top: Math.min(draft.start[1], draft.cur[1]) * k,
              width: Math.abs(draft.cur[0] - draft.start[0]) * k,
              height: Math.abs(draft.cur[1] - draft.start[1]) * k,
              background: draft.mode === "highlight" ? style.highlight : draft.mode === "whiteout" ? "#ffffff" : draft.mode === "redact" ? "rgb(0 0 0 / 0.8)" : style.fill ? style.color : undefined,
              opacity: draft.mode === "highlight" ? 0.45 : 1,
              mixBlendMode: draft.mode === "highlight" ? "multiply" : undefined,
              border: draft.mode === "rect" || draft.mode === "ellipse" ? (style.fill ? undefined : `${Math.max(1, style.stroke * k)}px solid ${style.color}`) : draft.mode === "whiteout" ? "1px dashed #94a3b8" : undefined,
            }}
          />
        ) : null}
        {sel && mode === "select" && editing !== sel.id ? <Selection o={sel} k={k} measured={api.measured.get(sel.id)} onHandle={startResize} /> : null}
      </div>
    </div>
  );
});

function HitBox({ o, k, measured, active }: { o: EditObject; k: number; measured?: Size; active: boolean }) {
  const b = bboxOf(o, measured);
  return <div className={cn("absolute", active ? "cursor-move" : "pointer-events-none")} style={{ left: b.x * k - 2, top: b.y * k - 2, width: b.w * k + 4, height: b.h * k + 4, touchAction: "none" }} />;
}

function Selection({ o, k, measured, onHandle }: { o: EditObject; k: number; measured?: Size; onHandle: (e: React.PointerEvent, o: EditObject, h: Handle) => void }) {
  const handle = (h: Handle, x: number, y: number) => (
    <span
      key={h}
      onPointerDown={(e) => onHandle(e, o, h)}
      className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-carbon bg-paper shadow"
      style={{ left: x, top: y, cursor: h === "nw" || h === "se" ? "nwse-resize" : h === "ne" || h === "sw" ? "nesw-resize" : "move", touchAction: "none" }}
    />
  );
  if (o.type === "line")
    return (
      <div className="pointer-events-none absolute inset-0 [&>span]:pointer-events-auto">
        {handle("p1", o.x1 * k, o.y1 * k)}
        {handle("p2", o.x2 * k, o.y2 * k)}
      </div>
    );
  const b = bboxOf(o, measured);
  const L = b.x * k - 3;
  const T = b.y * k - 3;
  const W = b.w * k + 6;
  const H = b.h * k + 6;
  return (
    <div className="pointer-events-none absolute outline-[1.5px] outline-carbon outline-solid" style={{ left: L, top: T, width: W, height: H }}>
      <div className="pointer-events-none absolute inset-0 [&>span]:pointer-events-auto">
        {handle("nw", 0, 0)}
        {handle("ne", W, 0)}
        {handle("sw", 0, H)}
        {handle("se", W, H)}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- shell */

function Swatches({ colors, value, onChange, label }: { colors: string[]; value: string; onChange: (c: string) => void; label: string }) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label={label}>
      {colors.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} onClick={() => onChange(c)} className={cn("grid size-7 place-items-center rounded-full", value === c && "ring-2 ring-carbon")}>
          <span className="size-5 rounded-full border border-black/15" style={{ background: c }} />
        </button>
      ))}
      <label className="relative grid size-7 cursor-pointer place-items-center rounded-full" title="Custom colour">
        <span className="size-5 rounded-full border border-black/15 bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]" />
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Custom colour" />
      </label>
    </div>
  );
}

async function fileToDataUrl(f: File): Promise<{ src: string; w: number; h: number }> {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("That image could not be opened."));
      i.src = url;
    });
    const max = 2400;
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    const keepPng = f.type === "image/png" || f.type === "image/webp" || f.type === "image/gif";
    return { src: c.toDataURL(keepPng ? "image/png" : "image/jpeg", 0.92), w: c.width, h: c.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Loaded = { pdf: PDFDocumentProxy; close: () => Promise<void>; sizes: Size[]; file: File; password?: string };

export default function Studio({ tool }: { tool: Tool }) {
  const toolset = TOOLSETS[tool.slug] ?? TOOLSETS["edit-pdf"];
  const isRedact = tool.slug === "redact-pdf";
  const isSign = tool.slug === "sign-pdf";
  const [doc, setDoc] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [objects, setObjectsState] = useState<EditObject[]>([]);
  const objRef = useRef(objects);
  const past = useRef<EditObject[][]>([]);
  const future = useRef<EditObject[][]>([]);
  const snapshot = useRef<EditObject[] | null>(null);
  const [, force] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(START_MODE[tool.slug] ?? "select");
  const [style, setStyle] = useState<StudioStyle>({ color: "#111827", size: 14, family: "sans", bold: false, italic: false, stroke: 2, highlight: HIGHLIGHTS[0], fill: false });
  const [zoom, setZoom] = useState(1);
  const [colWidth, setColWidth] = useState(0);
  const colRef = useRef<HTMLDivElement>(null);
  const [sigOpen, setSigOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<OutFile[] | null>(null);
  const [error, setError] = useState<string>();
  const [redactPreview, setRedactPreview] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [searching, setSearching] = useState(false);
  const { progress, report, reset } = useThrottledProgress();
  const { ask, dialog } = usePasswordPrompt();
  const measured = useRef(new Map<string, Size>()).current;
  const canvases = useRef(new Map<number, HTMLCanvasElement | null>()).current;
  const segCache = useRef(new Map<number, Promise<Seg[]>>()).current;
  const boxExtras = useRef(new Map<string, Pick<Box, "snap" | "ref">>()).current;
  const visibility = useRef(new Map<number, number>()).current;

  const setObjects = useCallback((next: EditObject[]) => {
    objRef.current = next;
    setObjectsState(next);
  }, []);
  const commit = useCallback(
    (next: EditObject[]) => {
      past.current.push(objRef.current);
      if (past.current.length > 150) past.current.shift();
      future.current = [];
      setObjects(next);
    },
    [setObjects],
  );

  /* ---- open a file */
  const openFile = useCallback(
    async (file: File, password?: string): Promise<void> => {
      setLoading(true);
      setLoadError(undefined);
      try {
        const { openPdfjs, PdfjsPasswordError } = await import("@/lib/pdf/pdfjs");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let opened;
        try {
          opened = await openPdfjs(bytes, password);
        } catch (e) {
          if (e instanceof PdfjsPasswordError) {
            const pw = await ask(file.name, e.wrong);
            if (pw == null) return setLoading(false);
            return openFile(file, pw);
          }
          throw e;
        }
        const sizes: Size[] = [];
        for (let i = 1; i <= opened.pageCount; i++) {
          const p = await opened.pdf.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          sizes.push({ w: vp.width, h: vp.height });
        }
        setDoc((old) => {
          void old?.close().catch(() => undefined);
          return { pdf: opened.pdf, close: opened.close, sizes, file, password };
        });
        past.current = [];
        future.current = [];
        setObjects([]);
        segCache.clear();
        boxExtras.clear();
        setSelected(null);
        setEditing(null);
        setResults(null);
        if (isSign && !savedCount()) setSigOpen(true);
      } catch (e) {
        setLoadError(`This PDF could not be opened: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setLoading(false);
      }
    },
    [ask, isSign, segCache, boxExtras, setObjects],
  );

  useEffect(() => {
    const parked = take();
    const f = parked?.files.find((x) => /\.pdf$/i.test(x.name) || x.type === "application/pdf");
    if (f) void openFile(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => void doc?.close().catch(() => undefined), [doc]);

  /* ---- layout */
  useEffect(() => {
    const el = colRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setColWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);
  // Each page is fitted to the column on its own, so a landscape page doesn't shrink the portrait ones.
  const fitWidth = colWidth ? Math.min(colWidth - 8, 940) * zoom : 0;
  const kOf = (i: number) => (doc && fitWidth ? fitWidth / doc.sizes[i].w : 1);

  /* ---- page api (stable) */
  const docRef = useRef(doc);
  docRef.current = doc;
  const api = useMemo<PageApi>(
    () => ({
      select: (id) => {
        setSelected(id);
        if (!id) setEditing(null);
      },
      setEditing: (id) => setEditing(id),
      create: (o, opts) => {
        commit([...objRef.current, o]);
        if (opts?.select || opts?.edit) setSelected(o.id);
        if (opts?.edit) setEditing(o.id);
        if (opts?.select && !opts.edit && (o.type === "rect" || o.type === "ellipse" || o.type === "line") && (o.type !== "rect" || o.mode === "box")) setMode("select");
      },
      createMany: (list, editId) => {
        commit([...objRef.current, ...list]);
        if (editId) {
          setSelected(editId);
          setEditing(editId);
        }
      },
      live: (fn) => setObjects(fn(objRef.current)),
      begin: () => {
        snapshot.current = objRef.current;
      },
      end: (ids) => {
        const before = snapshot.current;
        snapshot.current = null;
        if (before && before !== objRef.current) {
          past.current.push(before);
          future.current = [];
          for (const id of ids ?? []) boxExtras.delete(id);
          force((n) => n + 1);
        }
      },
      finishText: (id, text) => {
        setEditing(null);
        const cur = objRef.current;
        const o = cur.find((x) => x.id === id) as TextObj | undefined;
        if (!o) return;
        if (!text.trim() || (o.coverId && text === o.original && o.text === o.original)) {
          // Empty, or an untouched line from Edit text: drop it and its cover so the page stays as it was.
          setObjects(cur.filter((x) => x.id !== id && x.id !== o.coverId));
          setSelected(null);
          return;
        }
        if (text !== o.text) setObjects(cur.map((x) => (x.id === id ? { ...o, text } : x)));
      },
      segments: (i) => {
        let p = segCache.get(i);
        if (!p) {
          p = docRef.current ? pageSegments(docRef.current.pdf, i).catch(() => [] as Seg[]) : Promise.resolve([] as Seg[]);
          segCache.set(i, p);
        }
        return p;
      },
      measured,
      onMeasure: (id, s) => measured.set(id, s),
      canvasFor: (i) => canvases.get(i) ?? null,
      registerCanvas: (i, c) => {
        if (c) canvases.set(i, c);
        else canvases.delete(i);
      },
    }),
    [commit, setObjects, segCache, measured, canvases, boxExtras],
  );

  const onVisible = useCallback((i: number, r: number) => visibility.set(i, r), [visibility]);
  const byPage = useMemo(() => {
    const m = new Map<number, EditObject[]>();
    for (const o of objects) {
      const l = m.get(o.page);
      if (l) l.push(o);
      else m.set(o.page, [o]);
    }
    return m;
  }, [objects]);
  const currentPage = () => {
    let best = 0;
    let bestR = -1;
    for (const [i, r] of visibility) if (r > bestR) [best, bestR] = [i, r];
    return best;
  };

  /* ---- actions */
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(objRef.current);
    setObjects(prev);
    setSelected(null);
    setEditing(null);
  }, [setObjects]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(objRef.current);
    setObjects(next);
  }, [setObjects]);
  const remove = useCallback(
    (id: string) => {
      const o = objRef.current.find((x) => x.id === id);
      const cover = o?.type === "text" ? o.coverId : undefined;
      commit(objRef.current.filter((x) => x.id !== id && x.id !== cover));
      setSelected(null);
      setEditing(null);
    },
    [commit],
  );
  const patchSelected = (patch: Partial<EditObject> & Record<string, unknown>) => {
    if (!selected) return;
    commit(objRef.current.map((o) => (o.id === selected ? ({ ...o, ...patch } as EditObject) : o)));
  };
  const setStyleAndSelected = (patch: Partial<StudioStyle>) => {
    setStyle((s) => ({ ...s, ...patch }));
    const o = objRef.current.find((x) => x.id === selected);
    if (!o) return;
    const p: Record<string, unknown> = {};
    if (patch.color !== undefined && o.type !== "image" && !(o.type === "rect" && (o.mode === "highlight" || o.mode === "redact" || o.mode === "whiteout"))) p.color = patch.color;
    if (patch.highlight !== undefined && o.type === "rect" && o.mode === "highlight") p.color = patch.highlight;
    if (o.type === "text") {
      if (patch.size !== undefined) p.size = patch.size;
      if (patch.family !== undefined) p.family = patch.family;
      if (patch.bold !== undefined) p.bold = patch.bold;
      if (patch.italic !== undefined) p.italic = patch.italic;
    }
    if (patch.stroke !== undefined && (o.type === "line" || o.type === "ink" || o.type === "ellipse" || (o.type === "rect" && o.mode === "box"))) p.strokeWidth = patch.stroke;
    if (patch.fill !== undefined && (o.type === "ellipse" || (o.type === "rect" && o.mode === "box"))) p.fill = patch.fill;
    if (Object.keys(p).length) patchSelected(p);
  };

  /** Centre of the part of the current page that is on screen, in page points. */
  const visibleSpot = () => {
    const pi = currentPage();
    const ps = doc!.sizes[pi];
    const el = document.querySelector<HTMLElement>(`[data-page="${pi}"]`);
    if (!el) return { pi, x: ps.w / 2, y: ps.h / 2 };
    const r = el.getBoundingClientRect();
    const top = Math.max(r.top, 180);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const cy = bottom > top ? (top + bottom) / 2 - r.top : r.height / 2;
    return { pi, x: ps.w / 2, y: Math.min(ps.h - 20, Math.max(20, cy / kOf(pi))) };
  };
  const placeImage = (img: { src: string; w: number; h: number }, widthPt: number) => {
    if (!doc) return;
    const { pi, x, y } = visibleSpot();
    const ps = doc.sizes[pi];
    const w = Math.min(widthPt, ps.w * 0.6);
    const h = (w * img.h) / img.w;
    const o: EditObject = { id: newId(), page: pi, type: "image", src: img.src, x: x - w / 2, y: Math.max(0, Math.min(ps.h - h, y - h / 2)), w, h };
    commit([...objRef.current, o]);
    setSelected(o.id);
    setMode("select");
  };
  const imagePicker = useFilePicker("image/png,image/jpeg,image/webp,image/gif", false, async (files) => {
    try {
      placeImage(await fileToDataUrl(files[0]), 200);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  });
  const addDate = () => {
    if (!doc) return;
    const { pi, x, y } = visibleSpot();
    const text = new Date().toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
    const o: TextObj = { id: newId(), page: pi, type: "text", x: x - 40, y: y + 40, text, size: style.size, color: style.color, family: style.family };
    commit([...objRef.current, o]);
    setSelected(o.id);
    setMode("select");
  };

  const findAndMark = async () => {
    if (!doc || !query.trim()) return;
    setSearching(true);
    try {
      const { pageText } = await import("@/lib/pdf/pdfjs");
      const { findOnPage } = await import("@/lib/pdf/redact");
      const added: EditObject[] = [];
      let textPages = 0;
      for (let i = 0; i < doc.sizes.length; i++) {
        const page = await doc.pdf.getPage(i + 1);
        const pt = await pageText(page);
        page.cleanup();
        if (pt.items.some((it) => it.str.trim())) textPages++;
        for (const f of await findOnPage(pt, i, { kinds: [], terms: [query], caseSensitive: matchCase })) {
          for (const b of f.boxes) {
            const id = newId();
            added.push({ id, page: i, type: "rect", mode: "redact", color: "#000000", x: b.x, y: b.y, w: b.w, h: b.h });
            boxExtras.set(id, { snap: b.snap, ref: b.ref });
          }
        }
      }
      if (!textPages) toast.error("This PDF has no text layer, so it can't be searched. Run OCR first, or draw boxes by hand.");
      else if (!added.length) toast.message(`No matches for “${query}”.`);
      else {
        commit([...objRef.current, ...added]);
        toast.success(`Marked ${added.length} match${added.length === 1 ? "" : "es"} for redaction.`);
      }
    } finally {
      setSearching(false);
    }
  };

  const save = async () => {
    if (!doc) return;
    setEditing(null);
    await new Promise((r) => setTimeout(r, 30));
    const list = objRef.current;
    setError(undefined);
    if (isRedact && !list.some((o) => o.type === "rect" && o.mode === "redact")) return setError("Draw a box over anything you want removed, or search for text to mark it.");
    if (!isRedact && !list.length) return setError("Add something to the page first: text, a signature, a drawing…");
    setSaving(true);
    reset("Preparing");
    try {
      const src = { bytes: new Uint8Array(await doc.file.arrayBuffer()), name: doc.file.name, password: doc.password };
      let out: OutFile;
      if (isRedact) {
        const { redactBoxes } = await import("@/lib/pdf/redact");
        const boxes: Box[] = list.flatMap((o) => (o.type === "rect" && o.mode === "redact" ? [{ page: o.page, x: o.x, y: o.y, w: o.w, h: o.h, ...(boxExtras.get(o.id) ?? {}) }] : []));
        out = await redactBoxes(src, boxes, {}, report);
        out.filename = doc.file.name.replace(/\.pdf$/i, "") + "-redacted.pdf";
      } else {
        const { applyEdits } = await import("@/lib/pdf/edit");
        out = await applyEdits(src, list, report);
        if (isSign) out.filename = doc.file.name.replace(/\.pdf$/i, "") + "-signed.pdf";
      }
      setResults([out]);
    } catch (e) {
      if (isPasswordError(e)) setError("This PDF needs its password again. Reopen the file.");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  /* ---- keyboard */
  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        e.preventDefault();
        remove(selected);
        return;
      }
      if (e.key === "Escape") {
        setSelected(null);
        setMode("select");
        return;
      }
      if (selected && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
        const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        commit(objRef.current.map((o) => (o.id === selected ? translate(o, dx, dy) : o)));
        return;
      }
      if (selected && e.key === "Enter") {
        const o = objRef.current.find((x) => x.id === selected);
        if (o?.type === "text") {
          e.preventDefault();
          setEditing(o.id);
        }
        return;
      }
      if (!mod && !e.altKey) {
        const m = toolset.find((x) => MODES[x].key === e.key.toLowerCase());
        if (m) setMode(m);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, selected, undo, redo, remove, commit, toolset]);

  /* ---- render */
  if (!doc)
    return (
      <div className="grid gap-4">
        {loading ? (
          <div className="grid min-h-72 place-items-center rounded-lg border border-line bg-paper">
            <span className="flex items-center gap-2 text-sm text-ink-2">
              <Spinner /> Opening the PDF…
            </span>
          </div>
        ) : (
          <DropZone accept="application/pdf,.pdf" onFiles={(f) => void openFile(f[0])} label={tool.input?.label ?? "Choose a PDF"} />
        )}
        {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
        {dialog}
      </div>
    );

  const sel = objects.find((o) => o.id === selected);
  const showText = sel?.type === "text" || (!sel && (mode === "text" || mode === "edit-text"));
  const showStroke = sel ? sel.type === "line" || sel.type === "ink" || sel.type === "ellipse" || (sel.type === "rect" && sel.mode === "box") : mode === "draw" || mode === "rect" || mode === "ellipse" || mode === "line" || mode === "arrow";
  const showFill = sel ? sel.type === "ellipse" || (sel.type === "rect" && sel.mode === "box") : mode === "rect" || mode === "ellipse";
  const showHighlight = sel ? sel.type === "rect" && sel.mode === "highlight" : mode === "highlight";
  const showColor = showText || showStroke;
  const cur: StudioStyle = sel
    ? {
        ...style,
        ...(sel.type === "text" ? { color: sel.color, size: sel.size, family: sel.family, bold: !!sel.bold, italic: !!sel.italic } : {}),
        ...(sel.type === "line" || sel.type === "ink" || sel.type === "ellipse" ? { color: sel.color, stroke: sel.strokeWidth } : {}),
        ...(sel.type === "rect" && sel.mode === "box" ? { color: sel.color, stroke: sel.strokeWidth ?? 2, fill: !!sel.fill } : {}),
        ...(sel.type === "ellipse" ? { fill: !!sel.fill } : {}),
        ...(sel.type === "rect" && sel.mode === "highlight" ? { highlight: sel.color } : {}),
      }
    : style;
  const redactCount = objects.filter((o) => o.type === "rect" && o.mode === "redact").length;

  return (
    <div className="-mx-4 sm:-mx-6">
      <div className="sticky top-14 z-20 border-y border-line bg-paper/95 backdrop-blur">
        <div className="flex items-center gap-1 px-3 py-2 sm:px-4">
          <div role="toolbar" aria-label="Tools" className={cn("flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [mask-image:linear-gradient(to_right,black_85%,transparent)] [scrollbar-width:none] sm:[mask-image:none]")}>
            {toolset.map((m) => {
              const M = MODES[m];
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  title={`${M.label} (${M.key.toUpperCase()})`}
                  className={cn("flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors", mode === m ? "bg-carbon text-carbon-ink" : "text-ink-2 hover:bg-paper-2 hover:text-ink", isSign && "order-3")}
                >
                  <M.icon className="size-4" />
                  <span className={cn(toolset.length > 6 ? "hidden 2xl:inline" : "hidden sm:inline")}>{M.label}</span>
                </button>
              );
            })}
            {!isRedact ? (
              <>
                <span className={cn("mx-1 h-6 w-px shrink-0 bg-line", isSign && "order-2")} />
                <button type="button" onClick={() => setSigOpen(true)} className={cn("flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium", isSign ? "bg-carbon-soft text-carbon hover:bg-carbon hover:text-carbon-ink" : "text-ink-2 hover:bg-paper-2 hover:text-ink")} title="Add a signature">
                  <SignatureIcon className="size-4" />
                  <span className={cn(isSign ? "inline" : "hidden 2xl:inline")}>Signature</span>
                </button>
                <button type="button" onClick={imagePicker.open} className="flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-ink-2 hover:bg-paper-2 hover:text-ink" title="Add an image">
                  <ImagePlus className="size-4" />
                  <span className={cn(isSign ? "hidden sm:inline" : "hidden 2xl:inline")}>Image</span>
                </button>
                {isSign ? (
                  <button type="button" onClick={addDate} className="flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-ink-2 hover:bg-paper-2 hover:text-ink" title="Add today's date">
                    <CalendarDays className="size-4" />
                    <span className="hidden sm:inline">Date</span>
                  </button>
                ) : null}
                {imagePicker.input}
              </>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5 pl-1">
            <Button variant="ghost" size="icon" onClick={undo} disabled={!past.current.length} aria-label="Undo" title="Undo (Ctrl+Z)">
              <Undo2 />
            </Button>
            <Button variant="ghost" size="icon" onClick={redo} disabled={!future.current.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
              <Redo2 />
            </Button>
            <span className="mx-1 hidden h-6 w-px bg-line sm:block" />
            <Button variant="ghost" size="icon" className="hidden sm:inline-flex" onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.15) * 100) / 100))} aria-label="Zoom out">
              <ZoomOut />
            </Button>
            <button type="button" onClick={() => setZoom(1)} className="hidden w-12 text-center text-xs text-ink-2 tabular sm:block" title="Fit width">
              {Math.round(zoom * 100)}%
            </button>
            <Button variant="ghost" size="icon" className="hidden sm:inline-flex" onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.15) * 100) / 100))} aria-label="Zoom in">
              <ZoomIn />
            </Button>
            <Button variant="primary" onClick={save} busy={saving} disabled={saving} className="ml-1.5">
              {tool.cta}
            </Button>
          </div>
        </div>
        <div className={cn("min-h-11 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line-2 px-3 py-1.5 text-[13px] sm:px-4", showText || showColor || showHighlight || showStroke || showFill || isRedact || sel ? "flex" : "hidden md:flex")}>
          {showText ? (
            <>
              <Select aria-label="Font" value={cur.family} onChange={(e) => setStyleAndSelected({ family: e.target.value as Family })} className="h-8 w-28 text-[13px]">
                <option value="sans">Sans</option>
                <option value="serif">Serif</option>
                <option value="mono">Mono</option>
              </Select>
              <div className="flex items-center gap-1">
                <Input aria-label="Text size" type="number" min={4} max={200} value={Math.round(cur.size * 10) / 10} onChange={(e) => e.target.valueAsNumber > 0 && setStyleAndSelected({ size: e.target.valueAsNumber })} className="h-8 w-16 text-[13px] tabular" />
                <span className="text-ink-3">pt</span>
              </div>
              <div className="flex">
                <Button variant="ghost" size="iconSm" aria-pressed={cur.bold} onClick={() => setStyleAndSelected({ bold: !cur.bold })} className={cn(cur.bold && "bg-paper-2 text-ink")} aria-label="Bold">
                  <Bold />
                </Button>
                <Button variant="ghost" size="iconSm" aria-pressed={cur.italic} onClick={() => setStyleAndSelected({ italic: !cur.italic })} className={cn(cur.italic && "bg-paper-2 text-ink")} aria-label="Italic">
                  <Italic />
                </Button>
              </div>
            </>
          ) : null}
          {showColor ? <Swatches colors={COLORS} value={cur.color} onChange={(c) => setStyleAndSelected({ color: c })} label="Colour" /> : null}
          {showHighlight ? <Swatches colors={HIGHLIGHTS} value={cur.highlight} onChange={(c) => setStyleAndSelected({ highlight: c })} label="Highlight colour" /> : null}
          {showStroke ? (
            <label className="flex items-center gap-2 text-ink-2">
              Width
              <input type="range" min={0.5} max={12} step={0.5} value={cur.stroke} onChange={(e) => setStyleAndSelected({ stroke: e.target.valueAsNumber })} className="w-24 accent-[var(--carbon)]" aria-label="Line width" />
            </label>
          ) : null}
          {showFill ? <Switch checked={cur.fill} onChange={(v) => setStyleAndSelected({ fill: v })} label="Filled" /> : null}
          {isRedact ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void findAndMark();
              }}
            >
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find text to redact" aria-label="Find text to redact" className="h-8 w-52 pl-8 text-[13px]" />
              </div>
              <Button type="submit" size="sm" variant="secondary" busy={searching} disabled={!query.trim() || searching}>
                Mark all
              </Button>
              <label className="flex items-center gap-1.5 text-ink-2">
                <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} className="accent-[var(--carbon)]" /> Match case
              </label>
              <label className="flex items-center gap-1.5 text-ink-2">
                <input type="checkbox" checked={redactPreview} onChange={(e) => setRedactPreview(e.target.checked)} className="accent-[var(--carbon)]" /> Preview
              </label>
              <span className="text-ink-3 tabular">
                {redactCount} area{redactCount === 1 ? "" : "s"} marked
              </span>
            </form>
          ) : null}
          {sel ? (
            <Button variant="ghost" size="sm" onClick={() => remove(sel.id)} className="ml-auto text-danger hover:bg-danger-soft hover:text-danger">
              <Trash2 /> Delete
            </Button>
          ) : (
            <span className="ml-auto hidden text-ink-3 md:inline">{MODES[mode].hint}</span>
          )}
        </div>
      </div>

      {error ? (
        <div className="px-4 pt-3 sm:px-6">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}
      {isRedact ? (
        <p className="px-4 pt-3 text-xs text-ink-3 sm:px-6">Redaction is permanent: marked areas are burned into the page image and the text, images and drawings underneath are deleted from the file. The rest of each page stays searchable.</p>
      ) : null}

      <div ref={colRef} className="grid gap-6 px-1 py-6 sm:px-6" onPointerDown={(e) => e.target === e.currentTarget && setSelected(null)}>
        {doc.sizes.map((s, i) => (
          <div key={i} className="grid gap-1.5">
            <StudioPage
              pdf={doc.pdf}
              index={i}
              size={s}
              k={kOf(i)}
              mode={mode}
              objects={byPage.get(i) ?? NONE}
              selected={selected}
              editing={editing}
              style={style}
              showSegments={mode === "edit-text"}
              redactPreview={redactPreview}
              onVisible={onVisible}
              api={api}
            />
            <p className="text-center text-xs text-ink-3 tabular">
              {i + 1} / {doc.sizes.length}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3 px-4 pb-4 text-sm text-ink-2">
        <span className="truncate">{doc.file.name}</span>
        <Button variant="ghost" size="sm" onClick={() => setDoc(null)}>
          Open another PDF
        </Button>
      </div>

      <SignatureDialog
        open={sigOpen}
        onClose={() => setSigOpen(false)}
        onPick={(s: Signature) => {
          setSigOpen(false);
          placeImage(s, 160);
        }}
      />
      <Dialog open={saving} onClose={() => undefined} title="Saving">
        <Progress value={progress.value} label={progress.label} />
      </Dialog>
      <Dialog open={!!results} onClose={() => setResults(null)} title={isRedact ? "Redacted" : "Saved"}>
        {results ? <ResultList results={results} tool={tool.slug} onReset={() => setResults(null)} resetLabel="Keep editing" /> : null}
      </Dialog>
      {dialog}
    </div>
  );
}

function savedCount(): number {
  try {
    return (JSON.parse(localStorage.getItem("saved-signatures") ?? "[]") as unknown[]).length;
  } catch {
    return 0;
  }
}
