import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";

export function AppErrorComponent({ error, reset }: ErrorComponentProps) {
  const message = error instanceof Error && error.message ? error.message : typeof error === "string" ? error : "An unexpected error occurred.";
  return (
    <div className="mx-auto grid max-w-xl justify-items-center gap-3 px-6 py-24 text-center">
      <TriangleAlert className="size-10 text-danger" strokeWidth={1.8} aria-hidden />
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm break-words text-ink-2">{message}</p>
      <p className="text-sm text-ink-3">Your files never left this device. Reloading the page usually fixes this.</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => reset()} className="h-10 rounded-md bg-carbon px-4 text-sm font-medium text-carbon-ink">
          Try again
        </button>
        <button type="button" onClick={() => location.reload()} className="h-10 rounded-md border border-line bg-paper px-4 text-sm font-medium">
          Reload
        </button>
      </div>
    </div>
  );
}
