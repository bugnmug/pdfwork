/**
 * Visit counting with Plausible: no cookies, no personal data, and never any file
 * content. It runs only on the live site (not on previews, local copies or this
 * computer), starts after the privacy meter so the meter sees every request it
 * makes, and drops everything after "#" from page addresses, because P2P Share and
 * the whiteboard keep their access codes there.
 */
import { BRAND } from "./brand";

type Payload = { u: string } & Record<string, unknown>;
type Plausible = ((...args: unknown[]) => void) & { q?: unknown[][]; o?: object; init?: (o?: object) => void };

/** The server that receives visit counts, so the meter can label them. */
export const ANALYTICS_HOST = (() => {
  try {
    return BRAND.analytics ? new URL(BRAND.analytics).host : "";
  } catch {
    return "";
  }
})();

const site = (host: string) => host.replace(/^www\./, "");

export function startAnalytics() {
  if (typeof window === "undefined" || !BRAND.analytics || !BRAND.url) return;
  try {
    if (site(location.hostname) !== site(new URL(BRAND.url).hostname)) return;
  } catch {
    return;
  }
  const w = window as unknown as { plausible?: Plausible };
  if (w.plausible) return;
  // Plausible's own queueing stub: calls made before the script arrives are replayed.
  const stub: Plausible = (...args: unknown[]) => {
    (stub.q ??= []).push(args);
  };
  stub.init = (o?: object) => {
    stub.o = o ?? {};
  };
  w.plausible = stub;
  stub.init({ transformRequest: (p: Payload) => ({ ...p, u: p.u.split("#")[0] }) });
  const s = document.createElement("script");
  s.async = true;
  s.src = BRAND.analytics;
  document.head.append(s);
}
