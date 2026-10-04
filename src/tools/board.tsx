import { ArrowUpRight, ChevronLeft, ChevronRight, Circle, Eraser, FileDown, FilePlus2, FileUp, Hand, Highlighter, ImageDown, Minus, MousePointer2, PenLine, Share2, Square, StickyNote, Trash2, Type, Undo2, Users } from "lucide-react";
import type { DataConnection, Peer } from "peerjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useFilePicker } from "@/components/dropzone";
import { ResultList } from "@/components/results";
import { Button, Dialog, Input, Notice, Progress, Spinner } from "@/components/ui";
import { applyOp, bbox, BH, BW, drawEl, hit, moved, type Board, type El, type Op } from "@/lib/board";
import type { OutFile } from "@/lib/pdf/core";
import type { DrawPoint } from "@/lib/pdf/draw";
import { load, save } from "@/lib/storage";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";

type ToolKind = "select" | "pen" | "marker" | "eraser" | "rect" | "ellipse" | "line" | "arrow" | "text" | "note" | "hand";
const COLORS = ["#111827", "#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c"];
const NOTE_COLORS = ["#fde68a", "#bbf7d0", "#fbcfe8", "#bfdbfe"];
const PEER_COLORS = ["#e11d48", "#0891b2", "#65a30d", "#c026d3", "#d97706", "#4f46e5"];
const KEY = "whiteboard";

let n = 0;
const uid = () => `${Date.now().toString(36)}${(++n).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const newBoard = (): Board => ({ pages: [{ id: uid() }], els: {} });

type Remote = { id: string; name: string; color: string; x: number; y: number; page: string; at: number };

/* Messages bigger than this are split, because data channels cap message size. */
const MAX_MSG = 60_000;
function sendBig(conn: DataConnection, obj: unknown) {
  const s = JSON.stringify(obj);
  if (s.length <= MAX_MSG) return conn.send(s);
  const id = uid();
  const n = Math.ceil(s.length / MAX_MSG);
  for (let i = 0; i < n; i++) conn.send(JSON.stringify({ t: "part", id, i, n, s: s.slice(i * MAX_MSG, (i + 1) * MAX_MSG) }));
}
function reassembler(onMsg: (m: Record<string, unknown>) => void) {
  const parts = new Map<string, string[]>();
  return (raw: unknown) => {
    if (typeof raw !== "string") return;
    const m = JSON.parse(raw) as Record<string, unknown>;
    if (m.t !== "part") return onMsg(m);
    const list = parts.get(m.id as string) ?? new Array(m.n as number).fill("");
    list[m.i as number] = m.s as string;
    parts.set(m.id as string, list);
    if (list.every((x) => x)) {
      parts.delete(m.id as string);
      onMsg(JSON.parse(list.join("")));
    }
  };
}

export default function BoardTool({ tool: _tool }: { tool: Tool }) {
  const [board, setBoard] = useState<Board>(newBoard);
  const boardRef = useRef(board);
  boardRef.current = board;
  const [pageId, setPageId] = useState(board.pages[0].id);
  const [kind, setKind] = useState<ToolKind>("pen");
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(4);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<Record<string, Remote>>({});
  const [room, setRoom] = useState<{ code: string; host: boolean } | null>(null);
  const [joining, setJoining] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [qr, setQr] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<OutFile[] | null>(null);
  const [error, setError] = useState<string>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [cssW, setCssW] = useState(960);
  const draft = useRef<El | null>(null);
  const drag = useRef<{ id: string; x: number; y: number; orig: El } | null>(null);
  const undoStack = useRef<Op[][]>([]);
  const peer = useRef<Peer | null>(null);
  const conns = useRef<Map<string, DataConnection>>(new Map());
  const me = useRef({ id: uid(), color: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)] });
  const lastCursor = useRef(0);
  const bgImages = useRef(new Map<string, HTMLImageElement>());
  const joinStarted = useRef(false);
  const [, force] = useState(0);
  const k = cssW / BW;
  const page = board.pages.find((p) => p.id === pageId) ?? board.pages[0];
  const pageIndex = board.pages.indexOf(page);

  /* ---- persistence (local only) */
  useEffect(() => {
    const saved = load<Board | null>(KEY, null);
    const h = location.hash.slice(1);
    if (saved?.pages?.length && !h) {
      setBoard(saved);
      setPageId(saved.pages[0].id);
    }
    setName(load("board-name", ""));
    if (h && !joinStarted.current) {
      joinStarted.current = true;
      void join(h);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (room && !room.host) return; // guests don't overwrite their own saved board
    const t = setTimeout(() => {
      if (!save(KEY, board)) save(KEY, { ...board, pages: board.pages.map((p) => ({ id: p.id })) });
    }, 600);
    return () => clearTimeout(t);
  }, [board, room]);

  /* ---- layout + drawing */
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setCssW(Math.min(1400, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bgFor = useCallback((src?: string) => {
    if (!src) return null;
    let img = bgImages.current.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => force((x) => x + 1);
      img.src = src;
      bgImages.current.set(src, img);
    }
    return img.complete ? img : null;
  }, []);

  const els = useMemo(() => Object.values(board.els).filter((e) => e.page === page.id), [board.els, page.id]);

  const render = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssW * (BH / BW) * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
    const bg = bgFor(page.bg);
    if (bg) {
      const s = Math.min(BW / bg.naturalWidth, BH / bg.naturalHeight);
      ctx.drawImage(bg, (BW - bg.naturalWidth * s) / 2, (BH - bg.naturalHeight * s) / 2, bg.naturalWidth * s, bg.naturalHeight * s);
    } else {
      ctx.fillStyle = "#e5e7eb";
      for (let y = 40; y < BH; y += 40) for (let x = 40; x < BW; x += 40) ctx.fillRect(x - 1, y - 1, 2, 2);
    }
    for (const e of els) if (e.id !== editing) drawEl(ctx, e);
    if (draft.current) drawEl(ctx, draft.current);
    const sel = selected ? board.els[selected] : null;
    if (sel && sel.page === page.id) {
      const b = bbox(sel, ctx);
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = "#2d3bd6";
      ctx.lineWidth = 2 / k;
      ctx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
      ctx.setLineDash([]);
    }
  }, [cssW, k, page, els, editing, selected, board.els, bgFor]);
  useEffect(() => render(), [render]);

  /* ---- ops: apply locally, record for undo, broadcast */
  const broadcast = useCallback((msg: unknown, except?: string) => {
    for (const [id, c] of conns.current) if (id !== except && c.open) sendBig(c, msg);
  }, []);
  const doOps = useCallback(
    (ops: Op[], record = true) => {
      if (record) {
        // Inverse ops for undo.
        const inv: Op[] = [];
        for (const op of ops) {
          if (op.type === "put") inv.push(boardRef.current.els[op.el.id] ? { type: "put", el: boardRef.current.els[op.el.id] } : { type: "remove", ids: [op.el.id] });
          if (op.type === "remove") for (const id of op.ids) if (boardRef.current.els[id]) inv.push({ type: "put", el: boardRef.current.els[id] });
          if (op.type === "clear") for (const e of Object.values(boardRef.current.els)) if (e.page === op.page) inv.push({ type: "put", el: e });
        }
        undoStack.current.push(inv);
        if (undoStack.current.length > 100) undoStack.current.shift();
      }
      let b = boardRef.current;
      for (const op of ops) b = applyOp(b, op);
      boardRef.current = b;
      setBoard(b);
      broadcast({ t: "ops", ops });
    },
    [broadcast],
  );
  const undo = () => {
    const inv = undoStack.current.pop();
    if (inv?.length) doOps(inv, false);
  };

  /* ---- networking */
  const handleMsg = useCallback(
    (from: string, m: Record<string, unknown>) => {
      if (m.t === "ops") {
        let b = boardRef.current;
        for (const op of m.ops as Op[]) b = applyOp(b, op);
        boardRef.current = b;
        setBoard(b);
        if (room?.host) broadcast(m, from);
      } else if (m.t === "state") {
        const b = m.board as Board;
        boardRef.current = b;
        setBoard(b);
        setPageId(b.pages[0].id);
      } else if (m.t === "cursor") {
        const r = m as unknown as Remote;
        setRemotes((cur) => ({ ...cur, [r.id]: { ...r, at: Date.now() } }));
        if (room?.host) broadcast(m, from);
      } else if (m.t === "bye") {
        setRemotes((cur) => {
          const next = { ...cur };
          delete next[m.id as string];
          return next;
        });
      }
    },
    [room, broadcast],
  );
  const handleRef = useRef(handleMsg);
  handleRef.current = handleMsg;

  const host = async () => {
    setError(undefined);
    setBusy("Opening a room…");
    try {
      const p2p = await import("@/lib/p2p");
      const { peer: p, code } = await p2p.openPeer();
      peer.current = p;
      p.on("connection", (c) => {
        c.on("open", () => {
          conns.current.set(c.peer, c);
          sendBig(c, { t: "state", board: boardRef.current });
          force((x) => x + 1);
        });
        c.on("data", reassembler((m) => handleRef.current(c.peer, m)));
        c.on("close", () => {
          conns.current.delete(c.peer);
          force((x) => x + 1);
        });
      });
      p.on("disconnected", () => p.reconnect());
      setRoom({ code, host: true });
      const QR = await import("qrcode");
      setQr(await QR.toDataURL(`${location.origin}${location.pathname}#${code}`, { margin: 1, width: 300 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  async function join(raw: string) {
    setJoining(true);
    setError(undefined);
    try {
      const p2p = await import("@/lib/p2p");
      const code = p2p.cleanCode(raw);
      const p = await p2p.openGuest();
      peer.current = p;
      const c = await p2p.connect(p, code);
      conns.current.set(c.peer, c);
      c.on("data", reassembler((m) => handleRef.current(c.peer, m)));
      c.on("close", () => {
        toast.message("The host closed the board. You can keep drawing on your own copy.");
        setRoom(null);
        conns.current.clear();
      });
      setRoom({ code, host: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  }

  const leave = () => {
    broadcast({ t: "bye", id: me.current.id });
    peer.current?.destroy();
    peer.current = null;
    conns.current.clear();
    setRoom(null);
    setRemotes({});
    history.replaceState(null, "", location.pathname);
  };
  useEffect(() => () => peer.current?.destroy(), []);

  // Fade out cursors of people who went quiet.
  useEffect(() => {
    const t = setInterval(() => setRemotes((cur) => Object.fromEntries(Object.entries(cur).filter(([, r]) => Date.now() - r.at < 15000))), 3000);
    return () => clearInterval(t);
  }, []);

  /* ---- pointer input */
  const pt = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * BW, ((e.clientY - r.top) / r.height) * BH];
  };
  const ctx2d = () => canvas.current?.getContext("2d") ?? undefined;

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (kind === "hand") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = pt(e);
    if (editing) setEditing(null);
    if (kind === "select") {
      const target = [...els].reverse().find((el) => hit(el, x, y, 8, ctx2d()));
      setSelected(target?.id ?? null);
      if (target) drag.current = { id: target.id, x, y, orig: target };
      return;
    }
    if (kind === "eraser") {
      const hits = els.filter((el) => hit(el, x, y, 10, ctx2d())).map((el) => el.id);
      if (hits.length) doOps([{ type: "remove", ids: hits }]);
      return;
    }
    if (kind === "text" || kind === "note") {
      // Stop the click from moving focus away from the text box we're about to open.
      e.preventDefault();
      const el: El = kind === "text" ? { id: uid(), page: page.id, kind: "text", color, size: 28, x, y, text: "" } : { id: uid(), page: page.id, kind: "note", color: NOTE_COLORS[0], x: x - 100, y: y - 70, w: 220, h: 160, text: "" };
      doOps([{ type: "put", el }]);
      setSelected(el.id);
      setEditing(el.id);
      return;
    }
    const pressure = e.pointerType === "pen" && e.pressure ? e.pressure : 0.6;
    draft.current =
      kind === "pen" || kind === "marker"
        ? { id: uid(), page: page.id, kind, color: kind === "marker" ? (color === COLORS[0] ? "#facc15" : color) : color, width: kind === "marker" ? width * 5 : width, points: [[x, y, pressure]] }
        : { id: uid(), page: page.id, kind, color, width, x1: x, y1: y, x2: x, y2: y };
    render();
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = pt(e);
    const now = performance.now();
    if (room && now - lastCursor.current > 50) {
      lastCursor.current = now;
      broadcast({ t: "cursor", id: me.current.id, name: name || "Guest", color: me.current.color, x, y, page: page.id });
    }
    if (drag.current) {
      const d = drag.current;
      const el = moved(d.orig, x - d.x, y - d.y);
      boardRef.current = applyOp(boardRef.current, { type: "put", el });
      setBoard(boardRef.current);
      return;
    }
    if (kind === "eraser" && e.buttons) {
      const hits = els.filter((el) => hit(el, x, y, 10, ctx2d())).map((el) => el.id);
      if (hits.length) doOps([{ type: "remove", ids: hits }]);
      return;
    }
    const d = draft.current;
    if (!d) return;
    if (d.kind === "pen" || d.kind === "marker") {
      for (const ev of (e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]) as PointerEvent[]) {
        const [px, py] = pt(ev);
        const last = d.points[d.points.length - 1];
        const dist = Math.hypot(px - last[0], py - last[1]);
        if (dist < 1.2) continue;
        const p = ev.pointerType === "pen" && ev.pressure ? ev.pressure : Math.max(0.3, Math.min(0.85, 0.9 - dist / 30));
        d.points.push([px, py, last[2] * 0.6 + p * 0.4] as DrawPoint);
      }
    } else if ("x2" in d) {
      d.x2 = x;
      d.y2 = y;
    }
    render();
  };

  const onUp = () => {
    if (drag.current) {
      const d = drag.current;
      drag.current = null;
      const el = boardRef.current.els[d.id];
      if (el && el !== d.orig) {
        undoStack.current.push([{ type: "put", el: d.orig }]);
        broadcast({ t: "ops", ops: [{ type: "put", el }] });
      }
      return;
    }
    const d = draft.current;
    draft.current = null;
    if (!d) return;
    if ((d.kind === "rect" || d.kind === "ellipse" || d.kind === "line" || d.kind === "arrow") && Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 4) return render();
    doOps([{ type: "put", el: d }]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        doOps([{ type: "remove", ids: [selected] }]);
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ---- pages, import, export */
  const addPage = (bg?: string) => {
    const pg = { id: uid(), bg };
    doOps([{ type: "page", page: pg, after: page.id }], false);
    setPageId(pg.id);
    return pg;
  };
  const pdfPicker = useFilePicker("application/pdf,.pdf,image/*", false, async (files) => {
    const f = files[0];
    setBusy("Importing…");
    try {
      if (f.type.startsWith("image/")) {
        const url = await new Promise<string>((res) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.readAsDataURL(f);
        });
        addPage(url);
        return;
      }
      const { openPdfjs, renderPage } = await import("@/lib/pdf/pdfjs");
      const o = await openPdfjs(new Uint8Array(await f.arrayBuffer()));
      try {
        let after = page.id;
        let first: string | null = null;
        for (let i = 1; i <= Math.min(o.pageCount, 30); i++) {
          setBusy(`Importing page ${i} of ${Math.min(o.pageCount, 30)}…`);
          const p = await o.pdf.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          const c = await renderPage(p, Math.min(1600 / vp.width, 1000 / vp.height) * 1.2);
          p.cleanup();
          const pg = { id: uid(), bg: c.toDataURL("image/jpeg", 0.82) };
          doOps([{ type: "page", page: pg, after }], false);
          after = pg.id;
          first ??= pg.id;
        }
        if (first) setPageId(first);
        if (o.pageCount > 30) toast.message("Imported the first 30 pages.");
      } finally {
        await o.close();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  });

  const exportPdf = async () => {
    setBusy("Making the PDF…");
    try {
      const { boardToPdf } = await import("@/lib/board");
      setResults([await boardToPdf(boardRef.current)]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const exportPng = async () => {
    const c = document.createElement("canvas");
    c.width = BW;
    c.height = BH;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, BW, BH);
    const bg = bgFor(page.bg);
    if (bg) {
      const s = Math.min(BW / bg.naturalWidth, BH / bg.naturalHeight);
      ctx.drawImage(bg, (BW - bg.naturalWidth * s) / 2, (BH - bg.naturalHeight * s) / 2, bg.naturalWidth * s, bg.naturalHeight * s);
    }
    for (const e of els) drawEl(ctx, e);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (blob) setResults([{ filename: `whiteboard-page-${pageIndex + 1}.png`, bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png" }]);
  };

  const editingEl = editing ? board.els[editing] : null;
  const tools: [ToolKind, typeof PenLine, string][] = [
    ["select", MousePointer2, "Select and move"],
    ["pen", PenLine, "Pen"],
    ["marker", Highlighter, "Highlighter"],
    ["eraser", Eraser, "Eraser"],
    ["rect", Square, "Rectangle"],
    ["ellipse", Circle, "Ellipse"],
    ["line", Minus, "Line"],
    ["arrow", ArrowUpRight, "Arrow"],
    ["text", Type, "Text"],
    ["note", StickyNote, "Sticky note"],
    ["hand", Hand, "Scroll (no drawing)"],
  ];
  const people = Object.values(remotes).filter((r) => r.page === page.id);

  return (
    <div className="grid gap-3">
      {pdfPicker.input}
      <div className="sticky top-14 z-20 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-line bg-paper/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap gap-0.5" role="toolbar" aria-label="Drawing tools">
          {tools.map(([t, Icon, label]) => (
            <button key={t} type="button" onClick={() => (setKind(t), setSelected(null))} aria-pressed={kind === t} title={label} aria-label={label} className={cn("grid size-9 place-items-center rounded-md", kind === t ? "bg-carbon text-carbon-ink" : "text-ink-2 hover:bg-paper-2")}>
              <Icon className="size-4" />
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
          {COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)} className={cn("grid size-7 place-items-center rounded-full", color === c && "ring-2 ring-carbon")}>
              <span className="size-5 rounded-full" style={{ background: c }} />
            </button>
          ))}
        </div>
        <input type="range" min={1} max={16} value={width} onChange={(e) => setWidth(e.target.valueAsNumber)} className="w-24 accent-[var(--carbon)]" aria-label="Line width" />
        <Button variant="ghost" size="icon" onClick={undo} aria-label="Undo">
          <Undo2 />
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={pdfPicker.open} title="Import a PDF or image as new pages">
            <FileUp /> <span className="hidden md:inline">Import</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={exportPng} title="This page as PNG">
            <ImageDown /> <span className="hidden md:inline">PNG</span>
          </Button>
          <Button variant="secondary" size="sm" onClick={exportPdf}>
            <FileDown /> PDF
          </Button>
          <Button variant={room ? "soft" : "primary"} size="sm" onClick={() => (room ? setShareOpen(true) : void host().then(() => setShareOpen(true)))} busy={busy === "Opening a room…"}>
            {room ? <Users /> : <Share2 />} {room ? `${conns.current.size + 1} here` : "Share"}
          </Button>
        </div>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {joining ? (
        <Notice className="flex items-center gap-2">
          <Spinner /> Joining the board…
        </Notice>
      ) : null}
      <div ref={wrap} className="relative" style={{ height: cssW * (BH / BW) }}>
        <canvas
          ref={canvas}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className={cn("absolute inset-0 rounded-md border border-line bg-white shadow-sm", kind === "hand" ? "touch-auto" : "touch-none", kind === "select" ? "cursor-default" : kind === "eraser" ? "cursor-cell" : kind === "text" ? "cursor-text" : "cursor-crosshair")}
          style={{ width: cssW, height: cssW * (BH / BW) }}
        />
        {people.map((r) => (
          <div key={r.id} className="pointer-events-none absolute transition-[left,top] duration-75" style={{ left: r.x * k, top: r.y * k }}>
            <svg width="18" height="18" viewBox="0 0 24 24" style={{ color: r.color }} aria-hidden>
              <path d="M3 2l7 19 2.5-7.5L20 11z" fill="currentColor" stroke="white" strokeWidth="1.5" />
            </svg>
            <span className="ml-3 rounded px-1.5 py-0.5 text-[11px] font-medium text-white" style={{ background: r.color }}>
              {r.name}
            </span>
          </div>
        ))}
        {editingEl && (editingEl.kind === "text" || editingEl.kind === "note") ? (
          <textarea
            autoFocus
            defaultValue={editingEl.text}
            onBlur={(e) => {
              const text = e.target.value;
              setEditing(null);
              if (!text.trim()) doOps([{ type: "remove", ids: [editingEl.id] }], false);
              else doOps([{ type: "put", el: { ...editingEl, text } }], false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
            }}
            className="absolute resize-none border-0 p-0 outline-2 outline-carbon outline-dashed"
            style={
              editingEl.kind === "note"
                ? { left: editingEl.x * k, top: editingEl.y * k, width: editingEl.w * k, height: editingEl.h * k, background: editingEl.color, padding: 14 * k, fontSize: 22 * k, lineHeight: `${28 * k}px`, fontFamily: '"Doc Sans", sans-serif', color: "#1f2937" }
                : { left: editingEl.x * k, top: editingEl.y * k, minWidth: 220 * k, height: editingEl.size * 1.25 * k * Math.max(2, editingEl.text.split("\n").length + 1), background: "transparent", fontSize: editingEl.size * k, lineHeight: 1.25, fontFamily: '"Doc Sans", sans-serif', color: editingEl.color }
            }
            placeholder={editingEl.kind === "note" ? "Write a note…" : "Type…"}
          />
        ) : null}
        {busy && busy !== "Opening a room…" ? (
          <div className="absolute inset-0 grid place-items-center rounded-md bg-paper/70">
            <span className="flex items-center gap-2 rounded-md bg-paper px-3 py-2 text-sm shadow">
              <Spinner /> {busy}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => setPageId(board.pages[Math.max(0, pageIndex - 1)].id)} disabled={pageIndex <= 0} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="text-sm text-ink-2 tabular">
          Page {pageIndex + 1} of {board.pages.length}
        </span>
        <Button variant="ghost" size="icon" onClick={() => setPageId(board.pages[Math.min(board.pages.length - 1, pageIndex + 1)].id)} disabled={pageIndex >= board.pages.length - 1} aria-label="Next page">
          <ChevronRight />
        </Button>
        <Button variant="secondary" size="sm" onClick={() => addPage()}>
          <FilePlus2 /> New page
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="hover:text-danger"
          onClick={() => {
            if (board.pages.length > 1) {
              const next = board.pages[pageIndex === 0 ? 1 : pageIndex - 1].id;
              doOps([{ type: "drop-page", id: page.id }], false);
              setPageId(next);
            } else doOps([{ type: "clear", page: page.id }]);
          }}
        >
          <Trash2 /> {board.pages.length > 1 ? "Delete page" : "Clear page"}
        </Button>
      </div>

      <Dialog open={shareOpen} onClose={() => setShareOpen(false)} title={room?.host ? "Draw together" : "Shared board"}>
        {room ? (
          <div className="grid gap-4">
            {room.host ? (
              <>
                <p className="text-sm text-ink-2">Anyone with this link can draw on the board with you, live. Drawings travel directly between browsers.</p>
                {qr ? <img src={qr} alt="QR code for the board link" className="mx-auto size-40 rounded-md border border-line bg-white p-1" /> : null}
                <div className="flex gap-2">
                  <Input readOnly value={`${location.origin}${location.pathname}#${room.code}`} onFocus={(e) => e.target.select()} className="font-mono text-[13px]" aria-label="Board link" />
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      await navigator.clipboard.writeText(`${location.origin}${location.pathname}#${room.code}`);
                      toast.success("Link copied");
                    }}
                  >
                    Copy
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-ink-2">You&apos;re drawing on someone else&apos;s board. Export it any time to keep a copy.</p>
            )}
            <label className="grid gap-1.5">
              <span className="text-[13px] font-medium text-ink-2">Your name (shown next to your cursor)</span>
              <Input value={name} onChange={(e) => (setName(e.target.value), save("board-name", e.target.value))} placeholder="Guest" />
            </label>
            <p className="text-xs text-ink-3">{conns.current.size ? `${conns.current.size} other ${conns.current.size === 1 ? "person" : "people"} connected.` : "Nobody else has joined yet."}</p>
            <Button variant="ghost" onClick={() => (leave(), setShareOpen(false))}>
              {room.host ? "Stop sharing" : "Leave the board"}
            </Button>
          </div>
        ) : (
          <Progress value={null} label="Opening a room…" />
        )}
      </Dialog>
      <Dialog open={!!results} onClose={() => setResults(null)} title="Export">
        {results ? <ResultList results={results} tool="whiteboard" /> : null}
      </Dialog>
    </div>
  );
}
