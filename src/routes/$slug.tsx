import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { ChevronRight, ShieldCheck, Wifi } from "lucide-react";
import { IconTile } from "@/components/icons";
import { Page } from "@/components/shell";
import { Notice } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { CATEGORIES, FAQ, POPULAR, TOOL_BY_SLUG, TOOLS, type Tool } from "@/lib/tools/catalog";
import { ToolBody } from "@/tools/registry";

export const Route = createFileRoute("/$slug")({
  beforeLoad: ({ params }) => {
    const tool = TOOL_BY_SLUG[params.slug];
    if (!tool) throw notFound();
    if (tool.slug !== params.slug) throw redirect({ to: "/$slug", params: { slug: tool.slug }, statusCode: 301 });
  },
  loader: ({ params }) => ({ slug: TOOL_BY_SLUG[params.slug]?.slug ?? params.slug }),
  head: ({ loaderData }) => {
    const tool = loaderData ? TOOL_BY_SLUG[loaderData.slug] : undefined;
    if (!tool) return {};
    const title = `${tool.name}: free, no upload | ${BRAND.name}`;
    const description = clip(`${tool.blurb} ${tool.long}`, 158);
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
      ],
      links: BRAND.url ? [{ rel: "canonical", href: `${BRAND.url}/${tool.slug}` }] : [],
    };
  },
  component: ToolPage,
});

function clip(s: string, n: number) {
  return s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…`;
}

function stepsOf(t: Tool): string[] {
  if (t.steps?.length) return t.steps;
  if (t.input && !t.input.optional) return [`${t.input.label}${t.input.multiple ? ", or drop them on the page" : ", or drop it on the page"}.`, t.options?.length ? "Adjust the options if you need to." : "Check the file list.", `Press “${t.cta}”, then download the result.`];
  return ["Fill in the details or type your text.", t.options?.length ? "Pick the look you want." : "Review what you've entered.", `Press “${t.cta}” to download.`];
}

function ToolPage() {
  const { slug } = Route.useLoaderData();
  const tool = TOOL_BY_SLUG[slug];
  const cat = CATEGORIES.find((c) => c.id === tool.category)!;
  const related = [...TOOLS.filter((t) => t.category === tool.category && t.slug !== tool.slug), ...POPULAR.filter((t) => t.category !== tool.category)].slice(0, 8);
  return (
    <Page className="pt-6 sm:pt-8">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[13px] text-ink-3">
        <Link to="/" className="hover:text-ink">
          All tools
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <Link to="/" hash={tool.category} className="hover:text-ink">
          {cat.name}
        </Link>
      </nav>
      <header className="mt-3 flex items-start gap-4">
        <IconTile name={tool.icon} category={tool.category} size="lg" className="hidden sm:inline-flex" />
        <div className="min-w-0">
          <h1 className="text-[28px] leading-tight font-bold sm:text-[34px]">{tool.name}</h1>
          <p className="mt-1 max-w-2xl text-[15px] text-ink-2 sm:text-base">{tool.blurb}</p>
        </div>
      </header>
      {tool.online ? (
        <Notice className="mt-4 flex items-start gap-2">
          <Wifi className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{tool.online}</span>
        </Notice>
      ) : null}
      <div className="mt-6">
        <ToolBody tool={tool} />
      </div>

      <section className="mt-16 grid gap-10 border-t border-line pt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <h2 className="text-xl font-semibold">How to use {tool.name}</h2>
          <ol className="mt-4 grid gap-3">
            {stepsOf(tool).map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-carbon-soft text-sm font-semibold text-carbon tabular">{i + 1}</span>
                <span className="pt-0.5 text-[15px] text-ink-2">{s}</span>
              </li>
            ))}
          </ol>
          <h2 className="mt-10 text-xl font-semibold">About this tool</h2>
          <p className="mt-3 max-w-prose text-[15px] leading-relaxed text-ink-2">{tool.long}</p>
          <div className="mt-6 flex max-w-prose items-start gap-3 rounded-lg border border-line bg-paper p-4">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden />
            <p className="text-sm text-ink-2">
              <b className="font-medium text-ink">Your files stay on this device.</b> {BRAND.name} opens and processes them inside your browser. The counter in the top bar shows how many bytes this page has sent to any server: it should read 0 B.{" "}
              <Link to="/privacy" className="text-carbon underline-offset-2 hover:underline">
                How this works
              </Link>
            </p>
          </div>
        </div>
        <div>
          <h2 className="text-xl font-semibold">Related tools</h2>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {related.map((t) => (
              <li key={t.slug}>
                <Link to="/$slug" params={{ slug: t.slug }} className="flex items-center gap-3 rounded-md border border-line bg-paper p-2.5 transition-colors hover:border-ink-3">
                  <IconTile name={t.icon} category={t.category} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{t.name}</span>
                    <span className="block truncate text-xs text-ink-3">{t.blurb}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <h2 className="mt-10 text-xl font-semibold">Questions</h2>
          <div className="mt-3 grid gap-2">
            {FAQ.slice(0, 4).map((f) => (
              <details key={f.q} className="group rounded-md border border-line bg-paper px-4 py-3">
                <summary className="flex list-none items-center justify-between gap-3 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <ChevronRight className="size-4 shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
                </summary>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </Page>
  );
}
