import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ResultList } from "@/components/results";
import { Button, Input, Notice, Panel, Segmented, Spinner, Textarea } from "@/components/ui";
import type { Resume } from "@/lib/pdf/business";
import type { OutFile } from "@/lib/pdf/core";
import { usePersistent } from "@/lib/storage";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";
import { L, RemoveRow, Section } from "./biz-common";

const EXP = { role: "", org: "", start: "", end: "", points: "" };
const EDU = { degree: "", school: "", year: "", detail: "" };
const EMPTY: Resume = {
  name: "",
  title: "",
  email: "",
  phone: "",
  location: "",
  links: "",
  summary: "",
  experience: [{ ...EXP }],
  education: [{ ...EDU }],
  skills: "",
  extras: [],
  template: "classic",
  accent: "#1f3a5f",
};
const ACCENTS = ["#1f3a5f", "#0f766e", "#7c2d12", "#4c1d95", "#111827", "#b45309"];

function usePreview(r: Resume) {
  const [img, setImg] = useState<{ url: string; pages: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (!r.name.trim()) return setImg(null);
    const my = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const { resumePdf } = await import("@/lib/pdf/business");
        const { openPdfjs, renderPage } = await import("@/lib/pdf/pdfjs");
        const out = await resumePdf(r);
        const o = await openPdfjs(out.bytes);
        try {
          const page = await o.pdf.getPage(1);
          const vp = page.getViewport({ scale: 1 });
          const c = await renderPage(page, 900 / vp.width);
          page.cleanup();
          if (my === seq.current) setImg({ url: c.toDataURL("image/png"), pages: o.pageCount });
        } finally {
          await o.close().catch(() => undefined);
        }
      } catch {
        /* the preview is best-effort */
      } finally {
        if (my === seq.current) setBusy(false);
      }
    }, 700);
    return () => clearTimeout(t);
  }, [r]);
  return { img, busy };
}

export default function ResumeTool({ tool }: { tool: Tool }) {
  const [r, setR] = usePersistent<Resume>("resume-draft", EMPTY, 500);
  const [results, setResults] = useState<OutFile[] | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const preview = usePreview(r);
  const set = (patch: Partial<Resume>) => setR((cur) => ({ ...cur, ...patch }));
  const setList = <K extends "experience" | "education" | "extras">(key: K, i: number, patch: Partial<Resume[K][number]>) => setR((cur) => ({ ...cur, [key]: (cur[key] as Resume[K][number][]).map((x, j) => (j === i ? { ...x, ...patch } : x)) }));

  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { resumePdf } = await import("@/lib/pdf/business");
      setResults([await resumePdf(r)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <div className="grid gap-4">
        <Section title="About you">
          <div className="grid gap-4 sm:grid-cols-2">
            <L label="Full name">
              <Input value={r.name} onChange={(e) => set({ name: e.target.value })} autoComplete="name" />
            </L>
            <L label="Job title">
              <Input value={r.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Sales Manager" />
            </L>
            <L label="Email">
              <Input value={r.email} onChange={(e) => set({ email: e.target.value })} type="email" autoComplete="email" />
            </L>
            <L label="Phone">
              <Input value={r.phone} onChange={(e) => set({ phone: e.target.value })} type="tel" autoComplete="tel" />
            </L>
            <L label="City">
              <Input value={r.location} onChange={(e) => set({ location: e.target.value })} />
            </L>
            <L label="Links" hint="LinkedIn, portfolio… separated by commas">
              <Input value={r.links} onChange={(e) => set({ links: e.target.value })} />
            </L>
          </div>
          <L label="Summary" hint="Two or three lines about what you do best.">
            <Textarea rows={3} value={r.summary} onChange={(e) => set({ summary: e.target.value })} className="min-h-20" />
          </L>
        </Section>

        <Section title="Experience">
          {r.experience.map((e, i) => (
            <div key={i} className="grid gap-3 rounded-md border border-line-2 bg-paper-2/50 p-3">
              <div className="flex items-start gap-2">
                <div className="grid flex-1 gap-3 sm:grid-cols-2">
                  <L label="Role">
                    <Input value={e.role} onChange={(ev) => setList("experience", i, { role: ev.target.value })} />
                  </L>
                  <L label="Company">
                    <Input value={e.org} onChange={(ev) => setList("experience", i, { org: ev.target.value })} />
                  </L>
                  <L label="From">
                    <Input value={e.start} onChange={(ev) => setList("experience", i, { start: ev.target.value })} placeholder="Jan 2022" />
                  </L>
                  <L label="To">
                    <Input value={e.end} onChange={(ev) => setList("experience", i, { end: ev.target.value })} placeholder="Present" />
                  </L>
                </div>
                <RemoveRow onClick={() => set({ experience: r.experience.filter((_, j) => j !== i) })} label="Remove this job" />
              </div>
              <L label="What you did" hint="One achievement per line. Numbers help.">
                <Textarea rows={3} value={e.points} onChange={(ev) => setList("experience", i, { points: ev.target.value })} className="min-h-20" />
              </L>
            </div>
          ))}
          <Button variant="ghost" className="justify-self-start" onClick={() => set({ experience: [...r.experience, { ...EXP }] })}>
            <Plus /> Add a job
          </Button>
        </Section>

        <Section title="Education">
          {r.education.map((e, i) => (
            <div key={i} className="flex items-start gap-2 rounded-md border border-line-2 bg-paper-2/50 p-3">
              <div className="grid flex-1 gap-3 sm:grid-cols-2">
                <L label="Degree or course">
                  <Input value={e.degree} onChange={(ev) => setList("education", i, { degree: ev.target.value })} />
                </L>
                <L label="School or university">
                  <Input value={e.school} onChange={(ev) => setList("education", i, { school: ev.target.value })} />
                </L>
                <L label="Year">
                  <Input value={e.year} onChange={(ev) => setList("education", i, { year: ev.target.value })} />
                </L>
                <L label="Details (optional)">
                  <Input value={e.detail} onChange={(ev) => setList("education", i, { detail: ev.target.value })} placeholder="Grade, honours…" />
                </L>
              </div>
              <RemoveRow onClick={() => set({ education: r.education.filter((_, j) => j !== i) })} label="Remove this entry" />
            </div>
          ))}
          <Button variant="ghost" className="justify-self-start" onClick={() => set({ education: [...r.education, { ...EDU }] })}>
            <Plus /> Add education
          </Button>
        </Section>

        <Section title="Skills and more">
          <L label="Skills" hint="Separate with commas.">
            <Textarea rows={2} value={r.skills} onChange={(e) => set({ skills: e.target.value })} className="min-h-16" />
          </L>
          {r.extras.map((x, i) => (
            <div key={i} className="flex items-start gap-2 rounded-md border border-line-2 bg-paper-2/50 p-3">
              <div className="grid flex-1 gap-3">
                <L label="Section title">
                  <Input value={x.heading} onChange={(e) => setList("extras", i, { heading: e.target.value })} placeholder="Certifications, Languages, Awards…" />
                </L>
                <L label="Content" hint="One item per line.">
                  <Textarea rows={3} value={x.body} onChange={(e) => setList("extras", i, { body: e.target.value })} className="min-h-20" />
                </L>
              </div>
              <RemoveRow onClick={() => set({ extras: r.extras.filter((_, j) => j !== i) })} label="Remove this section" />
            </div>
          ))}
          <Button variant="ghost" className="justify-self-start" onClick={() => set({ extras: [...r.extras, { heading: "", body: "" }] })}>
            <Plus /> Add a section
          </Button>
        </Section>
      </div>

      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        <Panel className="grid gap-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Template"
              value={r.template}
              onChange={(v) => set({ template: v as Resume["template"] })}
              options={[
                { value: "classic", label: "Classic" },
                { value: "modern", label: "Modern" },
              ]}
              className="w-48"
            />
            <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Accent colour">
              {ACCENTS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={r.accent === c} aria-label={c} onClick={() => set({ accent: c })} className={cn("size-7 rounded-full border-2", r.accent === c ? "border-carbon" : "border-transparent")}>
                  <span className="block size-full rounded-full border-2 border-paper" style={{ background: c }} />
                </button>
              ))}
            </div>
          </div>
          <div className="relative grid min-h-64 place-items-center overflow-hidden rounded-md border border-line bg-paper-2">
            {preview.img ? <img src={preview.img.url} alt="Resume preview" className="w-full bg-white" /> : <p className="p-6 text-center text-sm text-ink-3">Start with your name and a live preview appears here.</p>}
            {preview.busy ? (
              <span className="absolute top-2 right-2 rounded-full bg-paper/90 p-1.5 shadow">
                <Spinner className="text-ink-3" />
              </span>
            ) : null}
          </div>
          {preview.img && preview.img.pages > 1 ? <p className="text-xs text-ink-3">Your resume runs to {preview.img.pages} pages; the preview shows the first.</p> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button variant="primary" size="lg" onClick={download} busy={busy} disabled={busy}>
            {tool.cta}
          </Button>
          {results ? <ResultList results={results} tool={tool.slug} /> : null}
          <p className="text-xs text-ink-3">Saved in this browser as you type. The PDF has real, selectable text, so applicant tracking systems can read it.</p>
          <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => confirm("Clear the whole resume?") && (setR(EMPTY), setResults(null))}>
            Start from scratch
          </Button>
        </Panel>
      </aside>
    </div>
  );
}
