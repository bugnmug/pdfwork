import { ArrowLeft, ArrowRight, Camera, Check, ImagePlus, Maximize, RotateCcw, RotateCw, ScanLine, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useFilePicker } from "@/components/dropzone";
import { ResultList } from "@/components/results";
import { Button, Notice, Panel, Progress, Segmented, Select, Switch } from "@/components/ui";
import { take } from "@/lib/handoff";
import type { OutFile } from "@/lib/pdf/core";
import type { Quad, ScanFilter } from "@/lib/scan";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";
import { useThrottledProgress } from "./workspace";

type ScanPage = { id: string; src: HTMLCanvasElement; quad: Quad; filter: ScanFilter; rotation: number; thumb?: string };

let seq = 0;
const FILTERS: { value: ScanFilter; label: string }[] = [
  { value: "enhance", label: "Colour" },
  { value: "gray", label: "Grey" },
  { value: "bw", label: "B&W" },
  { value: "original", label: "Original" },
];

async function makeThumb(p: ScanPage): Promise<string> {
  const { process } = await import("@/lib/scan");
  return process(p.src, p.quad, p.filter, p.rotation, 420).toDataURL("image/jpeg", 0.8);
}

function CameraView({ onCapture, onClose, count }: { onCapture: (c: HTMLCanvasElement) => void; onClose: () => void; count: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play();
        }
      } catch (e) {
        setError(e instanceof Error && e.name === "NotAllowedError" ? "Camera access was blocked. Allow it in your browser's site settings, or add photos instead." : "No camera is available. Add photos instead.");
      }
    })();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);
  const snap = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d", { willReadFrequently: true })!.drawImage(v, 0, 0);
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
    onCapture(c);
  };
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="relative flex-1 overflow-hidden">
        {error ? (
          <div className="grid h-full place-items-center p-8 text-center text-white">
            <p>{error}</p>
          </div>
        ) : (
          <video ref={video} playsInline muted className="size-full object-contain" />
        )}
        {flash ? <div className="absolute inset-0 bg-white/70" /> : null}
        <button type="button" onClick={onClose} className="absolute top-4 left-4 grid size-11 place-items-center rounded-full bg-black/50 text-white" aria-label="Close camera">
          <X />
        </button>
      </div>
      <div className="flex items-center justify-between gap-4 px-6 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <span className="w-24 text-sm text-white/80">{count ? `${count} page${count === 1 ? "" : "s"}` : ""}</span>
        <button type="button" onClick={snap} disabled={!!error} className="grid size-18 place-items-center rounded-full border-4 border-white bg-white/20 disabled:opacity-40" aria-label="Take photo">
          <span className="size-14 rounded-full bg-white" />
        </button>
        <button type="button" onClick={onClose} className="w-24 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black">
          {count ? "Done" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

function CornerEditor({ page, onChange }: { page: ScanPage; onChange: (q: Quad) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [url, setUrl] = useState<string>();
  const W = page.src.width;
  const H = page.src.height;
  useEffect(() => {
    setUrl(page.src.toDataURL("image/jpeg", 0.85));
  }, [page.src]);
  const toImg = (e: React.PointerEvent): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(W, ((e.clientX - r.left) / r.width) * W)), Math.max(0, Math.min(H, ((e.clientY - r.top) / r.height) * H))];
  };
  const q = page.quad;
  return (
    <div
      ref={wrap}
      className="relative mx-auto w-full touch-none select-none"
      style={{ aspectRatio: `${W} / ${H}`, maxHeight: "70vh", maxWidth: `calc(70vh * ${W / H})` }}
      onPointerMove={(e) => {
        if (drag === null) return;
        const p = toImg(e);
        const next = q.map((c, i) => (i === drag ? p : c)) as Quad;
        onChange(next);
      }}
      onPointerUp={() => setDrag(null)}
      onPointerCancel={() => setDrag(null)}
    >
      {url ? <img src={url} alt="" className="absolute inset-0 size-full rounded-md object-fill" draggable={false} /> : null}
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full overflow-visible" preserveAspectRatio="none">
        <path d={`M0 0H${W}V${H}H0Z M${q.map((p) => p.join(" ")).join(" L")} Z`} fill="rgb(0 0 0 / 0.45)" fillRule="evenodd" />
        <polygon points={q.map((p) => p.join(",")).join(" ")} fill="none" stroke="#8691ff" strokeWidth={Math.max(W, H) / 300} />
      </svg>
      {q.map(([x, y], i) => (
        <button
          key={i}
          type="button"
          aria-label={["Top-left corner", "Top-right corner", "Bottom-right corner", "Bottom-left corner"][i]}
          onPointerDown={(e) => {
            e.currentTarget.parentElement?.setPointerCapture(e.pointerId);
            setDrag(i);
          }}
          className={cn("absolute size-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-carbon/80 shadow-lg", drag === i && "scale-125")}
          style={{ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%`, touchAction: "none" }}
        />
      ))}
    </div>
  );
}

export default function Scan({ tool }: { tool: Tool }) {
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [paper, setPaper] = useState("fit");
  const [ocr, setOcr] = useState(false);
  const [lang, setLang] = useState("eng");
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<OutFile[] | null>(null);
  const [error, setError] = useState<string>();
  const { progress, report, reset } = useThrottledProgress();

  const addCanvas = useCallback(async (c: HTMLCanvasElement) => {
    const { detectQuad } = await import("@/lib/scan");
    const page: ScanPage = { id: `p${++seq}`, src: c, quad: detectQuad(c), filter: "enhance", rotation: 0 };
    page.thumb = await makeThumb(page);
    setPages((cur) => [...cur, page]);
    setActive((a) => a ?? page.id);
    setResults(null);
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      const { fileToCanvas } = await import("@/lib/scan");
      for (const f of files) {
        try {
          await addCanvas(await fileToCanvas(f));
        } catch (e) {
          toast.error(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    },
    [addCanvas],
  );
  const picker = useFilePicker("image/*", true, (f) => void addFiles(f));

  useEffect(() => {
    const imgs = take()?.files.filter((f) => f.type.startsWith("image/"));
    if (imgs?.length) void addFiles(imgs);
  }, [addFiles]);

  const update = (id: string, patch: Partial<ScanPage>) => setPages((cur) => cur.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  // Refresh a page's thumbnail shortly after its corners/filter/rotation change.
  const cur = pages.find((p) => p.id === active) ?? null;
  useEffect(() => {
    if (!cur) return;
    const t = setTimeout(async () => {
      const thumb = await makeThumb(cur);
      setPages((list) => list.map((p) => (p.id === cur.id ? { ...p, thumb } : p)));
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.quad, cur?.filter, cur?.rotation]);

  const move = (i: number, d: -1 | 1) =>
    setPages((list) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return list;
      const next = list.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const save = async () => {
    if (!pages.length) return;
    setSaving(true);
    setError(undefined);
    reset("Straightening pages");
    try {
      const { process } = await import("@/lib/scan");
      const images: { bytes: Uint8Array; mime: string; name: string }[] = [];
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        report((i / pages.length) * (ocr ? 0.3 : 0.8), `Page ${i + 1} of ${pages.length}`);
        await new Promise((r) => setTimeout(r, 0));
        const c = process(p.src, p.quad, p.filter, p.rotation, 2400);
        const mime = p.filter === "bw" ? "image/png" : "image/jpeg";
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, mime, 0.85));
        if (!blob) throw new Error("Couldn't encode a page image.");
        images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), mime, name: `scan-${i + 1}` });
      }
      const name = `scan-${new Date().toISOString().slice(0, 10)}`;
      let out: OutFile;
      if (ocr) {
        const { ocrImages } = await import("@/lib/pdf/ocr");
        out = await ocrImages(images, { lang }, (f, l) => report(0.3 + f * 0.7, l));
      } else {
        const { imagesToPdf } = await import("@/lib/pdf/raster");
        [out] = await imagesToPdf(images, { pageSize: paper as "fit", marginMm: paper === "fit" ? 0 : 0 }, (f, l) => report(0.8 + f * 0.2, l));
      }
      out.filename = `${name}.pdf`;
      setResults([out]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!pages.length)
    return (
      <div className="grid gap-4">
        {picker.input}
        <Panel className="grid justify-items-center gap-5 px-6 py-14 text-center">
          <span className="grid size-16 place-items-center rounded-full bg-carbon-soft text-carbon">
            <ScanLine className="size-7" strokeWidth={1.7} />
          </span>
          <div className="grid gap-1">
            <p className="text-lg font-semibold">Scan paper documents</p>
            <p className="max-w-md text-sm text-ink-2">Take photos of each page. The edges are found automatically, the page is straightened, and the result is cleaned up like a real scanner.</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" size="lg" onClick={() => setCamera(true)}>
              <Camera /> Use camera
            </Button>
            <Button variant="secondary" size="lg" onClick={picker.open}>
              <ImagePlus /> Add photos
            </Button>
          </div>
          <p className="text-xs text-ink-3">Photos stay on this device. Best results: a dark surface, even light, the whole page in view.</p>
        </Panel>
        {camera ? <CameraView count={0} onCapture={(c) => void addCanvas(c)} onClose={() => setCamera(false)} /> : null}
      </div>
    );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      {picker.input}
      <div className="grid gap-4">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {pages.map((p, i) => (
            <button key={p.id} type="button" onClick={() => setActive(p.id)} className={cn("relative w-20 shrink-0 overflow-hidden rounded-md border-2 bg-paper", p.id === active ? "border-carbon" : "border-line")} aria-label={`Page ${i + 1}`}>
              {p.thumb ? <img src={p.thumb} alt="" className="aspect-[3/4] w-full object-cover" /> : <span className="block aspect-[3/4] w-full bg-paper-2" />}
              <span className="absolute bottom-1 left-1 rounded bg-ink/80 px-1 text-[10px] text-paper tabular">{i + 1}</span>
            </button>
          ))}
          <button type="button" onClick={() => setCamera(true)} className="grid w-20 shrink-0 place-items-center rounded-md border-2 border-dashed border-line text-ink-3 hover:border-carbon hover:text-carbon" aria-label="Scan another page">
            <Camera className="size-5" />
          </button>
          <button type="button" onClick={picker.open} className="grid w-20 shrink-0 place-items-center rounded-md border-2 border-dashed border-line text-ink-3 hover:border-carbon hover:text-carbon" aria-label="Add photos">
            <ImagePlus className="size-5" />
          </button>
        </div>
        {cur ? (
          <Panel className="grid gap-4 p-3 sm:p-4">
            <CornerEditor page={cur} onChange={(q) => update(cur.id, { quad: q })} />
            <div className="flex flex-wrap items-center gap-2">
              <Segmented label="Filter" value={cur.filter} onChange={(v) => update(cur.id, { filter: v as ScanFilter })} options={FILTERS} className="w-full sm:w-80" />
              <div className="flex flex-wrap gap-1">
                <Button variant="ghost" size="sm" onClick={async () => update(cur.id, { quad: (await import("@/lib/scan")).detectQuad(cur.src) })} title="Find the page edges again">
                  <ScanLine /> Auto
                </Button>
                <Button variant="ghost" size="sm" onClick={async () => update(cur.id, { quad: (await import("@/lib/scan")).fullFrame(cur.src) })} title="Use the whole photo">
                  <Maximize /> Full
                </Button>
                <Button variant="ghost" size="iconSm" onClick={() => update(cur.id, { rotation: (cur.rotation + 270) % 360 })} aria-label="Rotate left">
                  <RotateCcw />
                </Button>
                <Button variant="ghost" size="iconSm" onClick={() => update(cur.id, { rotation: (cur.rotation + 90) % 360 })} aria-label="Rotate right">
                  <RotateCw />
                </Button>
                <Button variant="ghost" size="iconSm" onClick={() => move(pages.indexOf(cur), -1)} aria-label="Move page earlier" disabled={pages[0] === cur}>
                  <ArrowLeft />
                </Button>
                <Button variant="ghost" size="iconSm" onClick={() => move(pages.indexOf(cur), 1)} aria-label="Move page later" disabled={pages[pages.length - 1] === cur}>
                  <ArrowRight />
                </Button>
                <Button
                  variant="ghost"
                  size="iconSm"
                  className="hover:text-danger"
                  onClick={() => {
                    const idx = pages.indexOf(cur);
                    const rest = pages.filter((p) => p.id !== cur.id);
                    setPages(rest);
                    setActive(rest[Math.min(idx, rest.length - 1)]?.id ?? null);
                  }}
                  aria-label="Delete page"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <p className="text-xs text-ink-3">Drag the four corners onto the corners of the paper. The page preview in the strip above updates as you go.</p>
          </Panel>
        ) : null}
      </div>
      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel className="grid gap-4 p-4">
          <p className="text-sm font-medium">
            {pages.length} page{pages.length === 1 ? "" : "s"}
          </p>
          <label className="grid gap-1.5">
            <span className="text-[13px] font-medium text-ink-2">Page size</span>
            <Select value={paper} onChange={(e) => setPaper(e.target.value)}>
              <option value="fit">Same as the photo</option>
              <option value="A4">A4</option>
              <option value="Letter">Letter</option>
            </Select>
          </label>
          <Switch checked={ocr} onChange={setOcr} label="Make text searchable (OCR)" />
          {ocr ? (
            <Segmented
              label="OCR language"
              value={lang}
              onChange={setLang}
              options={[
                { value: "eng", label: "English" },
                { value: "hin", label: "Hindi" },
                { value: "eng+hin", label: "Both" },
              ]}
            />
          ) : null}
          {saving ? <Progress value={progress.value} label={progress.label} /> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button variant="primary" size="lg" onClick={save} busy={saving} disabled={saving}>
            {!saving ? <Check /> : null} {tool.cta}
          </Button>
          {results ? <ResultList results={results} tool={tool.slug} /> : null}
        </Panel>
      </aside>
      {camera ? <CameraView count={pages.length} onCapture={(c) => void addCanvas(c)} onClose={() => setCamera(false)} /> : null}
    </div>
  );
}
