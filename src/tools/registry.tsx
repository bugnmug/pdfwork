import { lazy, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent } from "react";
import type { Tool, Ui } from "@/lib/tools/catalog";
import { Panel, Spinner } from "@/components/ui";
import Workspace from "./workspace";

type ToolUi = LazyExoticComponent<ComponentType<{ tool: Tool }>>;

const UIS: Partial<Record<Ui, ToolUi>> = {
  studio: lazy(() => import("./studio")),
  organize: lazy(() => import("./organize")),
  compare: lazy(() => import("./compare")),
  chat: lazy(() => import("./chat")),
  summary: lazy(() => import("./summary")),
  scan: lazy(() => import("./scan")),
  draw: lazy(() => import("./draw")),
  share: lazy(() => import("./share")),
  board: lazy(() => import("./board")),
  workflow: lazy(() => import("./workflow")),
  "fill-form": lazy(() => import("./fill-form")),
  metadata: lazy(() => import("./metadata")),
  invoice: lazy(() => import("./invoice")),
  pos: lazy(() => import("./pos")),
  gst: lazy(() => import("./gst")),
  resume: lazy(() => import("./resume")),
  "audio-in": lazy(() => import("./audio-in")),
  reader: lazy(() => import("./reader")),
  privacy: lazy(() => import("./privacy")),
  fingerprint: lazy(() => import("./fingerprint")),
};

function Loading() {
  return (
    <Panel className="grid min-h-72 place-items-center p-10">
      <span className="flex items-center gap-2 text-sm text-ink-2">
        <Spinner /> Loading the tool…
      </span>
    </Panel>
  );
}

/** Interactive tools render only in the browser; the server sends a placeholder. */
function ClientOnly({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <>{children}</> : <Loading />;
}

export function ToolBody({ tool }: { tool: Tool }) {
  const Ui = UIS[tool.ui];
  if (!Ui) return <Workspace key={tool.slug} tool={tool} />;
  return (
    <ClientOnly>
      <Suspense fallback={<Loading />}>
        <Ui key={tool.slug} tool={tool} />
      </Suspense>
    </ClientOnly>
  );
}
