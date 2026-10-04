import "@fontsource/great-vibes/400.css";
import "@fontsource/dancing-script/400.css";
import { Eraser, ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { load, save } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { useFilePicker } from "./dropzone";
import { Button, Dialog, Input, Segmented, Slider, Switch } from "./ui";

export type Signature = { id: string; src: string; w: number; h: number };
const KEY = "saved-signatures";
const INKS = [
  { value: "#111827", label: "Black" },
  { value: "#1d3a8a", label: "Blue" },
  { value: "#7a1f1f", label: "Red" },
];
const FONTS = [
  { family: "Great Vibes", label: "Elegant", size: 1 },
  { family: "Dancing Script", label: "Flowing", size: 0.92 },
  { family: "Hand Caveat", label: "Casual", size: 1.05 },
  { family: "Hand Kalam", label: "Neat", size: 0.82 },
];

export function savedSignatures(): Signature[] {
  return load<Signature[]>(KEY, []);
}

/** Crop a canvas to its non-transparent pixels, with a small margin. */
function trim(canvas: HTMLCanvasElement, pad = 8): { src: string; w: number; h: number } | null {
  const ctx = canvas.getContext("2d")!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { src: out.toDataURL("image/png"), w: out.width, h: out.height };
}

function DrawPad({ ink, onChange }: { ink: string; onChange: (c: HTMLCanvasElement | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(3);
  const strokes = useRef<{ pts: [number, number, number][]; ink: string; width: number }[]>([]);
  const cur = useRef<{ pts: [number, number, number][]; ink: string; width: number } | null>(null);

  const redraw = () => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const s of [...strokes.current, ...(cur.current ? [cur.current] : [])]) {
      ctx.strokeStyle = s.ink;
      ctx.fillStyle = s.ink;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const pts = s.pts;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], s.width, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      // Width follows speed a little, like a real pen.
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1, p] = pts[i];
        ctx.lineWidth = s.width * 2 * p;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  };

  useEffect(() => {
    const c = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = c.getBoundingClientRect();
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pos = (e: React.PointerEvent) => {
    const c = ref.current!;
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height] as [number, number];
  };
  const scale = () => (ref.current ? ref.current.width / ref.current.getBoundingClientRect().width : 1);

  return (
    <div className="grid gap-3">
      <div className="relative">
        <canvas
          ref={ref}
          className="h-48 w-full touch-none rounded-md border border-line bg-white sm:h-56"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const [x, y] = pos(e);
            cur.current = { pts: [[x, y, 0.8]], ink, width: width * scale() * 0.5 };
            redraw();
          }}
          onPointerMove={(e) => {
            if (!cur.current) return;
            const [x, y] = pos(e);
            const last = cur.current.pts[cur.current.pts.length - 1];
            const d = Math.hypot(x - last[0], y - last[1]);
            if (d < 1.5) return;
            const pressure = e.pressure && e.pointerType === "pen" ? 0.4 + e.pressure : Math.max(0.55, Math.min(1.15, 1.25 - d / (40 * scale())));
            const p = last[2] * 0.6 + pressure * 0.4;
            cur.current.pts.push([x, y, p]);
            redraw();
          }}
          onPointerUp={() => {
            if (cur.current) strokes.current.push(cur.current);
            cur.current = null;
            redraw();
            onChange(strokes.current.length ? ref.current : null);
          }}
        />
        <div className="pointer-events-none absolute inset-x-8 bottom-10 border-b border-dashed border-[#c9cdd6]" />
        <span className="pointer-events-none absolute bottom-3 left-8 text-xs text-[#9aa1b0]">Sign above the line</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-48 flex-1 items-center gap-2 text-sm text-ink-2">
          Thickness
          <Slider label="Pen thickness" min={1} max={8} step={0.5} value={width} onChange={setWidth} />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            strokes.current = [];
            redraw();
            onChange(null);
          }}
        >
          <Eraser /> Clear
        </Button>
      </div>
    </div>
  );
}

function renderTyped(name: string, family: string, ink: string, k: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const size = 110 * k;
  const ctx = c.getContext("2d")!;
  ctx.font = `${size}px "${family}"`;
  const w = Math.ceil(ctx.measureText(name).width) + 80;
  c.width = Math.max(200, w);
  c.height = Math.ceil(size * 1.8);
  const ctx2 = c.getContext("2d")!;
  ctx2.font = `${size}px "${family}"`;
  ctx2.fillStyle = ink;
  ctx2.textBaseline = "middle";
  ctx2.fillText(name, 40, c.height / 2);
  return c;
}

/** Turns a photo of a signature on paper into ink on a transparent background. */
function removeBackground(img: HTMLImageElement, threshold: number, recolor: string | null): HTMLCanvasElement {
  const max = 1600;
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  // Estimate paper brightness from the brightest 30% of pixels, so shadows and grey paper work.
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) hist[(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0]++;
  let acc = 0;
  let paper = 255;
  const total = px.length / 4;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc > total * 0.3) {
      paper = v;
      break;
    }
  }
  const cut = paper * threshold;
  const rgb = recolor ? [parseInt(recolor.slice(1, 3), 16), parseInt(recolor.slice(3, 5), 16), parseInt(recolor.slice(5, 7), 16)] : null;
  for (let i = 0; i < px.length; i += 4) {
    const l = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    if (l >= cut) px[i + 3] = 0;
    else {
      // Soft edge: fade pixels close to the cut-off.
      const a = Math.min(1, (cut - l) / Math.max(1, cut * 0.25));
      px[i + 3] = Math.round(255 * a);
      if (rgb) [px[i], px[i + 1], px[i + 2]] = rgb;
    }
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

function UploadSig({ ink, onChange }: { ink: string; onChange: (c: HTMLCanvasElement | null) => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [threshold, setThreshold] = useState(0.78);
  const [recolor, setRecolor] = useState(true);
  const preview = useRef<HTMLCanvasElement | null>(null);
  const [url, setUrl] = useState<string>();
  const picker = useFilePicker("image/*", false, (files) => {
    const u = URL.createObjectURL(files[0]);
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = u;
  });
  useEffect(() => {
    if (!img) return;
    const c = removeBackground(img, threshold, recolor ? ink : null);
    preview.current = c;
    setUrl(c.toDataURL("image/png"));
    onChange(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, threshold, recolor, ink]);
  return (
    <div className="grid gap-3">
      {picker.input}
      {url ? (
        <img src={url} alt="Signature preview" className="checker max-h-56 w-full rounded-md border border-line object-contain" />
      ) : (
        <button type="button" onClick={picker.open} className="grid h-48 place-items-center rounded-md border-2 border-dashed border-line text-sm text-ink-2 hover:border-carbon hover:text-carbon">
          <span className="grid justify-items-center gap-2">
            <ImagePlus className="size-6" />
            Choose a photo or scan of your signature
          </span>
        </button>
      )}
      {img ? (
        <div className="grid gap-3">
          <div className="flex items-center gap-3 text-sm text-ink-2">
            <span className="shrink-0">Background removal</span>
            <Slider label="Background removal strength" min={0.5} max={0.95} step={0.01} value={threshold} onChange={setThreshold} format={(v) => `${Math.round(v * 100)}%`} />
          </div>
          <Switch checked={recolor} onChange={setRecolor} label="Use the selected ink colour" />
          <Button variant="ghost" size="sm" className="justify-self-start" onClick={picker.open}>
            Choose another image
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function SignatureDialog({ open, onClose, onPick, title = "Your signature" }: { open: boolean; onClose: () => void; onPick: (s: Signature) => void; title?: string }) {
  const [saved, setSaved] = useState<Signature[]>([]);
  const [tab, setTab] = useState("draw");
  const [ink, setInk] = useState(INKS[0].value);
  const [name, setName] = useState("");
  const [font, setFont] = useState(FONTS[0].family);
  const [remember, setRemember] = useState(true);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    if (!open) return;
    const s = savedSignatures();
    setSaved(s);
    setTab(s.length ? "saved" : "draw");
    setHasInk(false);
    canvas.current = null;
    Promise.all(FONTS.map((f) => document.fonts.load(`48px "${f.family}"`))).finally(() => setFontsReady(true));
  }, [open]);

  const finish = () => {
    let c = canvas.current;
    if (tab === "type") {
      if (!name.trim()) return;
      const f = FONTS.find((x) => x.family === font)!;
      c = renderTyped(name.trim(), f.family, ink, f.size);
    }
    if (!c) return;
    const t = trim(c);
    if (!t) return;
    const sig: Signature = { id: `s${Date.now()}`, ...t };
    if (remember) {
      const next = [sig, ...savedSignatures()].slice(0, 6);
      if (!save(KEY, next)) save(KEY, next.slice(0, 2));
    }
    onPick(sig);
  };

  const canFinish = tab === "type" ? !!name.trim() : hasInk;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={title}
      footer={
        tab === "saved" ? undefined : (
          <>
            <label className="mr-auto flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-[var(--carbon)]" />
              Remember on this device
            </label>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={finish} disabled={!canFinish}>
              Use signature
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-4">
        <Segmented
          label="Signature type"
          value={tab}
          onChange={(v) => {
            setTab(v);
            setHasInk(false);
            canvas.current = null;
          }}
          options={[...(saved.length ? [{ value: "saved", label: "Saved" }] : []), { value: "draw", label: "Draw" }, { value: "type", label: "Type" }, { value: "upload", label: "Upload" }]}
        />
        {tab !== "saved" ? (
          <div className="flex items-center gap-2 text-sm text-ink-2">
            Ink
            {INKS.map((i) => (
              <button key={i.value} type="button" onClick={() => setInk(i.value)} aria-label={i.label} aria-pressed={ink === i.value} className={cn("size-7 rounded-full border-2", ink === i.value ? "border-carbon" : "border-transparent")}>
                <span className="block size-full rounded-full border-2 border-paper" style={{ background: i.value }} />
              </button>
            ))}
          </div>
        ) : null}
        {tab === "saved" ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {saved.map((s) => (
              <li key={s.id} className="group relative">
                <button type="button" onClick={() => onPick(s)} className="grid h-28 w-full place-items-center rounded-md border border-line bg-white p-3 hover:border-carbon">
                  <img src={s.src} alt="Saved signature" className="max-h-full max-w-full object-contain" />
                </button>
                <button
                  type="button"
                  aria-label="Delete saved signature"
                  onClick={() => {
                    const next = saved.filter((x) => x.id !== s.id);
                    save(KEY, next);
                    setSaved(next);
                    if (!next.length) setTab("draw");
                  }}
                  className="absolute top-1.5 right-1.5 rounded-md bg-paper p-1.5 text-ink-3 shadow-sm hover:text-danger"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : tab === "draw" ? (
          <DrawPad
            ink={ink}
            onChange={(c) => {
              canvas.current = c;
              setHasInk(!!c);
            }}
          />
        ) : tab === "type" ? (
          <div className="grid gap-3">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Type your name" aria-label="Your name" autoFocus />
            <div className="grid gap-2 sm:grid-cols-2">
              {FONTS.map((f) => (
                <button
                  key={f.family}
                  type="button"
                  onClick={() => setFont(f.family)}
                  aria-pressed={font === f.family}
                  className={cn("grid h-20 place-items-center overflow-hidden rounded-md border bg-white px-3", font === f.family ? "border-carbon ring-2 ring-carbon/20" : "border-line hover:border-ink-3")}
                  style={{ fontFamily: `"${f.family}"`, color: ink, fontSize: 34 * f.size, opacity: fontsReady ? 1 : 0.4 }}
                >
                  <span className="truncate">{name || "Your Name"}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <UploadSig
            ink={ink}
            onChange={(c) => {
              canvas.current = c;
              setHasInk(!!c);
            }}
          />
        )}
      </div>
    </Dialog>
  );
}
