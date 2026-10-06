import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Cpu, Gauge, MonitorSmartphone, X } from "lucide-react";
import { useState } from "react";
import { DropZone } from "@/components/dropzone";
import { IconTile } from "@/components/icons";
import { MeterInline } from "@/components/meter";
import { Page } from "@/components/shell";
import { ToolCard } from "@/components/tool-card";
import { Button, Panel } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { extOf, suggestFor } from "@/lib/files";
import { park } from "@/lib/handoff";
import { CATEGORIES, FAQ, POPULAR, TOOLS } from "@/lib/tools/catalog";
import { formatBytes } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: `${BRAND.name}: ${TOOLS.length} free PDF tools that never upload your files` },
      { name: "description", content: BRAND.description },
    ],
    links: BRAND.url ? [{ rel: "canonical", href: `${BRAND.url}/` }] : [],
  }),
  component: Home,
});

function HomeDrop() {
  const [files, setFiles] = useState<File[]>([]);
  const navigate = useNavigate();
  if (!files.length)
    return (
      <DropZone multiple onFiles={setFiles} label="Choose files" hint="PDF, Word, Excel, PowerPoint, images, EPUB, text…" className="min-h-[17rem] border-line/90 shadow-panel sm:min-h-[22rem]">
        <p className="text-xs text-ink-3">We&apos;ll show the tools that fit them.</p>
      </DropZone>
    );
  const tools = suggestFor(files);
  return (
    <Panel className="grid min-h-[17rem] content-start gap-4 p-5 shadow-panel sm:min-h-[22rem]">
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold">What do you want to do?</p>
        <Button variant="ghost" size="sm" onClick={() => setFiles([])}>
          <X /> Clear
        </Button>
      </div>
      <ul className="flex flex-wrap gap-2">
        {files.slice(0, 6).map((f, i) => (
          <li key={i} className="flex max-w-full items-center gap-2 rounded-full border border-line bg-paper-2 py-1 pr-3 pl-1 text-[13px]">
            <span className="rounded-full bg-ink px-1.5 text-[10px] font-bold text-paper">{extOf(f.name)}</span>
            <span className="max-w-48 truncate">{f.name}</span>
            <span className="text-ink-3 tabular">{formatBytes(f.size)}</span>
          </li>
        ))}
        {files.length > 6 ? <li className="py-1 text-[13px] text-ink-3">+{files.length - 6} more</li> : null}
      </ul>
      <ul className="grid gap-2 sm:grid-cols-2">
        {tools.slice(0, 10).map((t) => (
          <li key={t.slug}>
            <button
              type="button"
              onClick={() => {
                park(files, "home");
                void navigate({ to: "/$slug", params: { slug: t.slug } });
              }}
              className="flex w-full items-center gap-3 rounded-md border border-line bg-paper p-2.5 text-left transition-colors hover:border-carbon"
            >
              <IconTile name={t.icon} category={t.category} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{t.name}</span>
                <span className="block truncate text-xs text-ink-3">{t.blurb}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Home() {
  return (
    <>
      <section className="relative overflow-hidden">
        <Page className="grid grid-cols-[minmax(0,1fr)] items-center gap-10 pt-8 pb-14 sm:pt-16 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-14 lg:pb-20">
          <div className="min-w-0">
            <p className="inline-flex items-center gap-2 rounded-full border border-line bg-paper px-3 py-1 text-[13px] text-ink-2">
              <span className="size-1.5 rounded-full bg-ok" aria-hidden />
              {TOOLS.length} tools · free · private · no watermark
            </p>
            <h1 className="mt-5 text-[2.5rem] leading-[1.04] font-bold tracking-[-0.035em] sm:text-6xl lg:text-[3.5rem] xl:text-[4rem]">
              Every PDF tool.{" "}
              <span className="bg-[linear-gradient(transparent_62%,var(--hl)_62%,var(--hl)_90%,transparent_90%)] box-decoration-clone">None of the uploading.</span>
            </h1>
            <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-ink-2">
              Compress, combine, sign, edit, convert, OCR and redact without leaving this page. Nothing you open is sent anywhere, and you don&apos;t have to trust us on that: the meter counts every byte that leaves.
            </p>
            <p className="mt-5 text-[15px] text-ink-2">
              <MeterInline />
            </p>
          </div>
          <div className="relative min-w-0">
            {/* a small stack of paper behind the drop zone */}
            <div className="absolute inset-0 translate-x-3 translate-y-3 rotate-[2.2deg] rounded-lg border border-line bg-paper-2" aria-hidden />
            <div className="absolute inset-0 -translate-x-2 translate-y-1.5 -rotate-[1.6deg] rounded-lg border border-line bg-paper" aria-hidden />
            <div className="relative">
              <HomeDrop />
            </div>
          </div>
        </Page>
      </section>

      <Page id="tools" className="scroll-mt-20">
        <div className="flex items-end justify-between gap-4">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Most used</h2>
        </div>
        <ul className="mt-5 grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
          {POPULAR.slice(0, 12).map((t) => (
            <li key={t.slug}>
              <ToolCard tool={t} />
            </li>
          ))}
        </ul>

        <nav aria-label="Tool categories" className="sticky top-14 z-20 -mx-4 mt-16 overflow-x-auto border-y border-line/70 bg-desk/90 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6">
          <ul className="flex w-max gap-1">
            {CATEGORIES.map((c) => (
              <li key={c.id}>
                <a href={`#${c.id}`} className="block rounded-full px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-ink-2 hover:bg-paper hover:text-ink">
                  {c.name}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {CATEGORIES.map((c) => {
          const list = TOOLS.filter((t) => t.category === c.id);
          return (
            <section key={c.id} id={c.id} className="mt-12 scroll-mt-32">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-xl font-bold tracking-tight">{c.name}</h2>
                <p className="text-sm text-ink-3">{c.blurb}</p>
              </div>
              <ul className="mt-4 grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-3 xl:grid-cols-4">
                {list.map((t) => (
                  <li key={t.slug}>
                    <ToolCard tool={t} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        <section className="mt-24 grid grid-cols-[minmax(0,1fr)] gap-8 rounded-xl border border-line bg-paper p-6 sm:p-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Counted, not promised</h2>
            <p className="mt-3 text-ink-2">Plenty of “secure” PDF sites upload your document and promise to delete it afterwards. {BRAND.name} never gets a copy in the first place.</p>
            <Link to="/privacy" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-carbon hover:underline">
              How privacy works <ChevronRight className="size-4" />
            </Link>
          </div>
          <ul className="grid gap-6 sm:grid-cols-3">
            {[
              { icon: MonitorSmartphone, title: "Opened by your browser", body: "Files are read by this page on your device, the way a desktop app reads them. Files open straight away because nothing has to travel to a server first." },
              { icon: Cpu, title: "Processed on your device", body: "PDF.js, pdf-lib and Tesseract run locally. After a tool's engine has loaded, it keeps working with the internet off." },
              { icon: Gauge, title: "Every byte counted", body: "The meter in the top bar counts everything this page sends. Run any tool and watch it stay at 0 B." },
            ].map((x) => (
              <li key={x.title}>
                <x.icon className="size-6 text-carbon" strokeWidth={1.7} aria-hidden />
                <p className="mt-3 font-semibold">{x.title}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{x.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-20 grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <h2 className="text-2xl font-bold tracking-tight">Questions</h2>
          <div className="grid gap-2">
            {FAQ.map((f) => (
              <details key={f.q} className="group rounded-lg border border-line bg-paper px-5 py-4">
                <summary className="flex list-none items-center justify-between gap-3 font-medium text-ink [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <ChevronRight className="size-4 shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
                </summary>
                <p className="mt-2.5 text-[15px] leading-relaxed text-ink-2">{f.a}</p>
              </details>
            ))}
          </div>
        </section>
      </Page>
    </>
  );
}
