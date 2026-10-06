import { Check, Copy, Download, KeyRound, Link2, Lock, Plus, Radio, Send, X } from "lucide-react";
import type { DataConnection, Peer } from "peerjs";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DropZone, useFilePicker } from "@/components/dropzone";
import { Button, Input, Notice, Panel, Progress, Segmented } from "@/components/ui";
import { take } from "@/lib/handoff";
import type { Tool } from "@/lib/tools/catalog";
import { cn, downloadBlob, formatBytes } from "@/lib/utils";

type Meta = { name: string; size: number; type: string };
/** First message from the sender. `iter` is the PBKDF2 work factor used with `salt`. */
type Hello = { t: "hello"; v: 2; files: Meta[]; encrypted: boolean; salt?: string; iter?: number; check?: string };

function CopyField({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} className="font-mono text-[13px]" />
      <Button
        variant="secondary"
        size="icon"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
      >
        {done ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------- sender */

function Sender({ initial }: { initial: File[] }) {
  const [files, setFiles] = useState<File[]>(initial);
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "starting" | "waiting" | "sending" | "done" | "error">("idle");
  const [code, setCode] = useState("");
  const [qr, setQr] = useState("");
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(0);
  const [receivers, setReceivers] = useState(0);
  const peer = useRef<Peer | null>(null);
  const picker = useFilePicker("*/*", true, (f) => setFiles((c) => [...c, ...f]));
  const total = files.reduce((s, f) => s + f.size, 0);

  useEffect(() => () => peer.current?.destroy(), []);

  const serve = async (conn: DataConnection, key: CryptoKey | null, salt: Uint8Array | null) => {
    const p2p = await import("@/lib/p2p");
    const hello: Hello = { t: "hello", v: 2, files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })), encrypted: !!key };
    if (key && salt) {
      hello.salt = p2p.b64(salt);
      hello.iter = p2p.KDF_ITERATIONS;
      hello.check = p2p.b64(await p2p.seal(key, new TextEncoder().encode(p2p.CHECK)));
    }
    conn.send(JSON.stringify(hello));
    conn.on("data", async (d) => {
      if (typeof d !== "string") return;
      const msg = JSON.parse(d) as { t: string };
      if (msg.t !== "ready") return;
      setState("sending");
      setSent(0);
      let done = 0;
      try {
        for (let i = 0; i < files.length; i++) {
          conn.send(JSON.stringify({ t: "file", i }));
          const f = files[i];
          for (let off = 0; off < f.size || (off === 0 && f.size === 0); off += p2p.CHUNK) {
            const buf = await f.slice(off, off + p2p.CHUNK).arrayBuffer();
            await p2p.drain(conn);
            if (!conn.open) throw new Error("The other device disconnected.");
            conn.send(key ? await p2p.seal(key, buf) : buf);
            done += buf.byteLength;
            setSent(done);
            if (f.size === 0) break;
          }
          conn.send(JSON.stringify({ t: "end", i }));
        }
        conn.send(JSON.stringify({ t: "done" }));
        setState("done");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState("waiting");
      }
    });
  };

  const start = async () => {
    setError(undefined);
    setState("starting");
    try {
      const p2p = await import("@/lib/p2p");
      const { peer: p, code: c } = await p2p.openPeer();
      peer.current = p;
      setCode(c);
      const link = `${location.origin}${location.pathname}#${c}`;
      const QR = await import("qrcode");
      setQr(await QR.toDataURL(link, { margin: 1, width: 360, errorCorrectionLevel: "M", color: { dark: "#14161c", light: "#ffffff" } }));
      let key: CryptoKey | null = null;
      let salt: Uint8Array | null = null;
      if (password) {
        salt = crypto.getRandomValues(new Uint8Array(16));
        key = await p2p.deriveKey(password, salt);
      }
      p.on("connection", (conn) => {
        conn.on("open", () => {
          setReceivers((n) => n + 1);
          void serve(conn, key, salt);
        });
        conn.on("close", () => setReceivers((n) => Math.max(0, n - 1)));
      });
      p.on("disconnected", () => p.reconnect());
      setState("waiting");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  };

  const stop = () => {
    peer.current?.destroy();
    peer.current = null;
    setState("idle");
    setCode("");
    setReceivers(0);
  };

  if (!files.length) return <DropZone multiple onFiles={setFiles} label="Choose files to send" hint="Any files, any size" />;

  const link = code ? `${typeof location !== "undefined" ? location.origin + location.pathname : ""}#${code}` : "";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Panel className="grid gap-3 p-4">
        {picker.input}
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">
            {files.length} file{files.length === 1 ? "" : "s"} · <span className="text-ink-3 tabular">{formatBytes(total)}</span>
          </p>
          {state === "idle" || state === "error" ? (
            <Button variant="ghost" size="sm" onClick={picker.open}>
              <Plus /> Add
            </Button>
          ) : null}
        </div>
        <ul className="grid gap-1.5">
          {files.map((f, i) => (
            <li key={i} className="flex items-center gap-3 rounded-md bg-paper-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-ink-3 tabular">{formatBytes(f.size)}</span>
              {state === "idle" || state === "error" ? (
                <button type="button" onClick={() => setFiles((c) => c.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="text-ink-3 hover:text-danger">
                  <X className="size-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel className="grid gap-4 p-4">
        {state === "idle" || state === "error" || state === "starting" ? (
          <>
            <label className="grid gap-1.5">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink-2">
                <KeyRound className="size-3.5" /> Password (optional)
              </span>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Adds end-to-end encryption" autoComplete="new-password" />
              <span className="text-xs text-ink-3">The receiver will need it. Tell them in person or by phone, not in the same message as the link.</span>
            </label>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <Button variant="primary" size="lg" onClick={start} busy={state === "starting"} disabled={state === "starting"}>
              <Send /> Start sharing
            </Button>
          </>
        ) : (
          <>
            <div className="grid justify-items-center gap-2 text-center">
              <p className="text-xs font-medium tracking-wide text-ink-3 uppercase">Share code</p>
              <p className="font-mono text-4xl font-bold tracking-[0.2em] text-ink">{code}</p>
              {qr ? <img src={qr} alt="QR code for the share link" className="size-44 rounded-md border border-line bg-white p-1" /> : null}
            </div>
            <CopyField value={link} label="share link" />
            <div className={cn("flex items-center gap-2 rounded-md px-3 py-2 text-sm", state === "done" ? "bg-ok-soft text-ok" : "bg-paper-2 text-ink-2")}>
              {state === "done" ? <Check className="size-4" /> : <Radio className="size-4 animate-pulse text-carbon" />}
              {state === "waiting" ? (receivers ? "Connected. Waiting for them to accept…" : "Waiting for the other device… keep this page open.") : state === "sending" ? "Sending…" : "Sent! You can share again with the same code."}
            </div>
            {state === "sending" ? <Progress value={total ? sent / total : null} label={`${formatBytes(sent)} of ${formatBytes(total)}`} /> : null}
            {password ? (
              <p className="flex items-center gap-1.5 text-xs text-ink-3">
                <Lock className="size-3.5" /> End-to-end encrypted with your password
              </p>
            ) : null}
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <Button variant="secondary" onClick={stop}>
              Stop sharing
            </Button>
          </>
        )}
      </Panel>
    </div>
  );
}

/* ----------------------------------------------------------- receiver */

function Receiver({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [state, setState] = useState<"idle" | "connecting" | "offer" | "password" | "receiving" | "done">("idle");
  const [hello, setHello] = useState<Hello | null>(null);
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);
  const [got, setGot] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string>();
  const peer = useRef<Peer | null>(null);
  const conn = useRef<DataConnection | null>(null);
  const key = useRef<CryptoKey | null>(null);

  const started = useRef(false);
  useEffect(() => {
    // Guard against React running mount effects twice in development.
    if (initialCode && !started.current) {
      started.current = true;
      void join(initialCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => peer.current?.destroy(), []);

  const join = async (raw: string) => {
    const p2p = await import("@/lib/p2p");
    const c = p2p.cleanCode(raw);
    if (c.length < 4) return setError("Enter the code shown on the other device.");
    setError(undefined);
    setState("connecting");
    try {
      peer.current?.destroy();
      const p = await p2p.openGuest();
      peer.current = p;
      const cn = await p2p.connect(p, c);
      conn.current = cn;
      let current: { meta: Meta; parts: ArrayBuffer[] } | null = null;
      let received = 0;
      const out: File[] = [];
      let queue = Promise.resolve();
      let h: Hello | null = null;
      cn.on("data", (d) => {
        // Decryption is async; keep chunks in order with a promise chain.
        queue = queue.then(async () => {
          if (typeof d === "string") {
            const msg = JSON.parse(d);
            if (msg.t === "hello") {
              h = msg as Hello;
              setHello(h);
              setState(h.encrypted ? "password" : "offer");
            } else if (msg.t === "file" && h) current = { meta: h.files[msg.i], parts: [] };
            else if (msg.t === "end" && current) {
              out.push(new File(current.parts, current.meta.name, { type: current.meta.type || "application/octet-stream" }));
              setFiles([...out]);
              current = null;
            } else if (msg.t === "done") setState("done");
            return;
          }
          if (!current) return;
          const buf = key.current ? await p2p.open(key.current, d as ArrayBuffer) : (d as ArrayBuffer);
          current.parts.push(buf);
          received += buf.byteLength;
          setGot(received);
        });
      });
      cn.on("close", () => setState((s) => (s === "done" ? s : "idle")));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  };

  const unlock = async () => {
    if (!hello?.salt || !hello.check) return;
    const p2p = await import("@/lib/p2p");
    try {
      const k = await p2p.deriveKey(password, p2p.unb64(hello.salt), hello.iter);
      const plain = new TextDecoder().decode(await p2p.open(k, p2p.unb64(hello.check).buffer as ArrayBuffer));
      if (plain !== p2p.CHECK) throw new Error();
      key.current = k;
      accept();
    } catch {
      setWrong(true);
    }
  };
  const accept = () => {
    conn.current?.send(JSON.stringify({ t: "ready" }));
    setState("receiving");
  };

  const total = hello?.files.reduce((s, f) => s + f.size, 0) ?? 0;
  return (
    <Panel className="mx-auto grid w-full max-w-lg gap-4 p-5">
      {state === "idle" || state === "connecting" ? (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void join(code);
          }}
        >
          <label className="grid gap-1.5">
            <span className="text-[13px] font-medium text-ink-2">Code from the other device</span>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. k7m2qa" autoCapitalize="none" autoComplete="off" spellCheck={false} className="h-12 text-center font-mono text-2xl tracking-[0.2em]" />
          </label>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button type="submit" variant="primary" size="lg" busy={state === "connecting"} disabled={state === "connecting"}>
            <Link2 /> Connect
          </Button>
        </form>
      ) : null}
      {hello && (state === "offer" || state === "password") ? (
        <div className="grid gap-3">
          <p className="font-semibold">
            Incoming: {hello.files.length} file{hello.files.length === 1 ? "" : "s"} ({formatBytes(total)})
          </p>
          <ul className="grid max-h-56 gap-1 overflow-auto">
            {hello.files.map((f, i) => (
              <li key={i} className="flex justify-between gap-3 rounded-md bg-paper-2 px-3 py-1.5 text-sm">
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 text-xs text-ink-3 tabular">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
          {state === "password" ? (
            <form
              className="grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void unlock();
              }}
            >
              <label className="grid gap-1.5">
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink-2">
                  <Lock className="size-3.5" /> These files are password-protected
                </span>
                <Input type="password" value={password} onChange={(e) => (setPassword(e.target.value), setWrong(false))} autoFocus />
              </label>
              {wrong ? <Notice tone="danger">That password isn&apos;t right.</Notice> : null}
              <Button type="submit" variant="primary" disabled={!password}>
                Unlock and receive
              </Button>
            </form>
          ) : (
            <Button variant="primary" size="lg" onClick={accept}>
              <Download /> Receive
            </Button>
          )}
        </div>
      ) : null}
      {state === "receiving" || state === "done" ? (
        <div className="grid gap-3">
          {state === "receiving" ? <Progress value={total ? got / total : null} label={`${formatBytes(got)} of ${formatBytes(total)}`} /> : <p className="flex items-center gap-2 font-semibold text-ok"><Check className="size-5" /> Received</p>}
          <ul className="grid gap-1.5">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-3 rounded-md border border-line-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-xs text-ink-3 tabular">{formatBytes(f.size)}</span>
                <Button variant="ghost" size="iconSm" onClick={() => downloadBlob(f, f.name)} aria-label={`Download ${f.name}`}>
                  <Download />
                </Button>
              </li>
            ))}
          </ul>
          {state === "done" && files.length > 1 ? (
            <Button variant="primary" onClick={() => files.forEach((f, i) => setTimeout(() => downloadBlob(f, f.name), i * 300))}>
              <Download /> Download all
            </Button>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

export default function Share({ tool: _tool }: { tool: Tool }) {
  const [mode, setMode] = useState<"send" | "receive">("send");
  const [code, setCode] = useState("");
  const [initial, setInitial] = useState<File[]>([]);
  useEffect(() => {
    const h = location.hash.slice(1);
    if (h) {
      setCode(h);
      setMode("receive");
    }
    const parked = take();
    if (parked?.files.length) setInitial(parked.files);
  }, []);
  useEffect(() => {
    if (!navigator.onLine) toast.message("You're offline. P2P Share needs a connection to find the other device.");
  }, []);
  return (
    <div className="grid gap-5">
      <Segmented
        label="Send or receive"
        value={mode}
        onChange={(v) => setMode(v as "send" | "receive")}
        options={[
          { value: "send", label: "Send files" },
          { value: "receive", label: "Receive files" },
        ]}
        className="mx-auto w-full max-w-sm"
      />
      {mode === "send" ? <Sender key="send" initial={initial} /> : <Receiver key={`recv-${code}`} initialCode={code} />}
    </div>
  );
}
