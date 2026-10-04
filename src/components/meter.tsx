import { ArrowUpRight } from "lucide-react";
import { useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, subscribe, type NetEvent } from "@/lib/netmeter";
import { cn, formatBytes } from "@/lib/utils";
import { Popover } from "./ui";

export function useNetMeter() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const KIND: Record<NetEvent["kind"], string> = {
  fetch: "Request",
  xhr: "Request",
  beacon: "Beacon",
  websocket: "Connection set-up",
  peer: "Direct transfer",
};

function MeterDetails({ server, direct, events }: { server: number; direct: number; events: NetEvent[] }) {
  return (
    <div className="grid w-[22rem] gap-4 p-4">
      <div>
        <p className="text-xs font-medium tracking-wide text-ink-3 uppercase">Sent to servers this session</p>
        <p className="mt-1 text-3xl font-semibold tabular">{formatBytes(server)}</p>
        {direct > 0 ? <p className="mt-1 text-sm text-ink-2 tabular">Plus {formatBytes(direct)} sent to the other device over an encrypted peer-to-peer connection.</p> : null}
      </div>
      <p className="text-sm leading-relaxed text-ink-2">
        Your files are opened and processed by this browser. This meter counts every byte the page sends out: requests, beacons, sockets and peer connections. Loading the app and its engines only downloads; it sends nothing of yours.
      </p>
      {events.length ? (
        <div className="grid gap-1.5">
          <p className="text-xs font-medium tracking-wide text-ink-3 uppercase">What was sent</p>
          <ul className="grid max-h-48 gap-1 overflow-auto text-[13px]">
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 rounded-md bg-paper-2 px-2.5 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate text-ink">{e.host}</span>
                  <span className="text-xs text-ink-3">
                    {KIND[e.kind]} · {new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </span>
                <span className="shrink-0 tabular text-ink-2">{formatBytes(e.bytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="rounded-md bg-marker/40 px-3 py-2 text-sm text-ink">Nothing has left this device.</p>
      )}
      <p className="text-xs text-ink-3">Check it yourself: open your browser&apos;s developer tools, Network tab, and watch while a tool runs.</p>
    </div>
  );
}

export function MeterPill({ className }: { className?: string }) {
  const s = useNetMeter();
  const clean = s.server === 0;
  return (
    <Popover
      button={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={`Sent to servers: ${formatBytes(s.server)}. Show details.`}
          className={cn(
            "group inline-flex h-9 items-center gap-2 rounded-full border border-line bg-paper pr-3 pl-1.5 text-[13px] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink",
            className,
          )}
        >
          <span className={cn("inline-flex h-6 items-center rounded-full px-2 font-semibold tabular", clean ? "bg-marker text-marker-ink" : "bg-carbon-soft text-carbon")}>{formatBytes(s.server)}</span>
          <span className="hidden sm:inline">sent to servers</span>
          <ArrowUpRight className="size-3.5 text-ink-3 transition-transform group-hover:-translate-y-px group-hover:translate-x-px" aria-hidden />
        </button>
      )}
    >
      <MeterDetails {...s} />
    </Popover>
  );
}

/** Large inline version for the home page. */
export function MeterInline() {
  const s = useNetMeter();
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="rounded-sm bg-marker px-1.5 font-semibold text-marker-ink tabular">{formatBytes(s.server)}</span>
      <span>sent to servers so far</span>
    </span>
  );
}
