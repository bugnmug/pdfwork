/**
 * The privacy meter: counts every byte this page sends out.
 *
 * It wraps fetch, XMLHttpRequest, sendBeacon, WebSocket and WebRTC data
 * channels, and measures request bodies. Downloading the app's own code,
 * fonts or OCR data sends nothing (GET requests have no body), so the meter
 * stays at 0 B while you work. Optional features that do talk to a server
 * (AI answers, P2P connection set-up) show up here, labelled.
 */

export type NetEvent = {
  id: number;
  at: number;
  kind: "fetch" | "xhr" | "beacon" | "websocket" | "peer";
  host: string;
  method: string;
  bytes: number;
  /** Bytes that went straight to another browser (WebRTC), not to a server. */
  direct: boolean;
};

type Snapshot = { server: number; direct: number; events: NetEvent[] };

let snap: Snapshot = { server: 0, direct: 0, events: [] };
const listeners = new Set<() => void>();
let nextId = 1;
let installed = false;
let pending: Record<string, NetEvent> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  for (const l of listeners) l();
}

function record(e: Omit<NetEvent, "id" | "at">) {
  if (e.bytes <= 0) return;
  // WebRTC/WebSocket traffic arrives as many small sends: batch them per host
  // so the list stays readable.
  if (e.kind === "peer" || e.kind === "websocket") {
    const key = `${e.kind}:${e.host}`;
    const cur = pending[key];
    if (cur) cur.bytes += e.bytes;
    else pending[key] = { ...e, id: nextId++, at: Date.now() };
    if (!flushTimer) flushTimer = setTimeout(flush, 400);
    return;
  }
  push({ ...e, id: nextId++, at: Date.now() });
}

function flush() {
  flushTimer = null;
  const list = Object.values(pending);
  pending = {};
  for (const e of list) {
    const last = snap.events[0];
    if (last && last.kind === e.kind && last.host === e.host && Date.now() - last.at < 60_000) {
      const merged = { ...last, bytes: last.bytes + e.bytes, at: Date.now() };
      snap = {
        server: snap.server + (e.direct ? 0 : e.bytes),
        direct: snap.direct + (e.direct ? e.bytes : 0),
        events: [merged, ...snap.events.slice(1)],
      };
      emit();
    } else push(e);
  }
}

function push(e: NetEvent) {
  snap = {
    server: snap.server + (e.direct ? 0 : e.bytes),
    direct: snap.direct + (e.direct ? e.bytes : 0),
    events: [e, ...snap.events].slice(0, 50),
  };
  emit();
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getSnapshot(): Snapshot {
  return snap;
}

const EMPTY: Snapshot = { server: 0, direct: 0, events: [] };
export function getServerSnapshot(): Snapshot {
  return EMPTY;
}

const enc = new TextEncoder();

/** Size of a request body without consuming it (null when unknowable, e.g. a stream). */
function bodySize(body: unknown): number | null {
  if (body == null) return 0;
  if (typeof body === "string") return enc.encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return enc.encode(body.toString()).byteLength;
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    let n = 0;
    body.forEach((v, k) => {
      n += enc.encode(k).byteLength + (typeof v === "string" ? enc.encode(v).byteLength : v.size);
    });
    return n;
  }
  return null;
}

function hostOf(url: string | URL | undefined): string {
  try {
    const u = new URL(String(url ?? ""), location.href);
    return u.host === location.host ? `${u.host} (this site)` : u.host;
  } catch {
    return "unknown";
  }
}

export function installNetMeter() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const isReq = typeof Request !== "undefined" && input instanceof Request;
      const url = isReq ? (input as Request).url : String(input);
      const method = (init?.method ?? (isReq ? (input as Request).method : "GET")).toUpperCase();
      if (isReq && init?.body == null) {
        // A Request object carries its own body: measure a clone.
        if (method !== "GET" && method !== "HEAD")
          (input as Request)
            .clone()
            .arrayBuffer()
            .then((b) => record({ kind: "fetch", host: hostOf(url), method, bytes: b.byteLength, direct: false }))
            .catch(() => undefined);
      } else {
        const size = bodySize(init?.body);
        // Streams cannot be measured without consuming them; count them as 1 byte so they still show up.
        record({ kind: "fetch", host: hostOf(url), method, bytes: size ?? 1, direct: false });
      }
    } catch {
      /* never break the request because of the meter */
    }
    return origFetch(input, init);
  };

  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (this: XMLHttpRequest & { __m?: { method: string; url: string } }, method: string, url: string | URL, ...rest: unknown[]) {
    this.__m = { method: String(method).toUpperCase(), url: String(url) };
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XHR.open;
  XHR.send = function (this: XMLHttpRequest & { __m?: { method: string; url: string } }, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const size = body instanceof Document ? enc.encode(new XMLSerializer().serializeToString(body)).byteLength : (bodySize(body) ?? 0);
      record({ kind: "xhr", host: hostOf(this.__m?.url), method: this.__m?.method ?? "POST", bytes: size, direct: false });
    } catch {
      /* ignore */
    }
    return origSend.call(this, body as XMLHttpRequestBodyInit);
  };

  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      record({ kind: "beacon", host: hostOf(url), method: "POST", bytes: bodySize(data) ?? 0, direct: false });
      return origBeacon(url, data);
    };
  }

  if (typeof WebSocket !== "undefined") {
    const origWs = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      // The dev server's hot-reload socket is not part of the app.
      if (!this.protocol.startsWith("vite-")) record({ kind: "websocket", host: hostOf(this.url), method: "WS", bytes: bodySize(data) ?? 0, direct: false });
      return origWs.call(this, data as string);
    };
  }

  if (typeof RTCDataChannel !== "undefined") {
    const origDc = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: string | Blob | ArrayBuffer | ArrayBufferView) {
      record({ kind: "peer", host: "the other device (direct)", method: "P2P", bytes: bodySize(data) ?? 0, direct: true });
      return (origDc as (d: unknown) => void).call(this, data);
    };
  }
}
