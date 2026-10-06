import { Lock } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Button, Dialog, Input, Notice } from "./ui";

type Ask = { name: string; wrong: boolean; resolve: (v: string | null) => void };

/** Asks for a PDF's password in a dialog. `ask` resolves with the password, or null if cancelled. */
export function usePasswordPrompt() {
  const [cur, setCur] = useState<Ask | null>(null);
  const [value, setValue] = useState("");
  const ref = useRef<Ask | null>(null);
  ref.current = cur;
  const ask = useCallback(
    (name: string, wrong = false) =>
      new Promise<string | null>((resolve) => {
        setValue("");
        setCur({ name, wrong, resolve });
      }),
    [],
  );
  const close = useCallback((v: string | null) => {
    ref.current?.resolve(v);
    setCur(null);
  }, []);
  const dialog = (
    <Dialog
      open={!!cur}
      onClose={() => close(null)}
      title="Password needed"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => close(value)} disabled={!value}>
            Unlock
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) close(value);
        }}
      >
        <p className="flex items-start gap-2 text-sm text-ink-2">
          <Lock className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <span>
            <b className="font-medium text-ink">{cur?.name}</b> is locked. Type its password to open it here; the password never leaves this device.
          </span>
        </p>
        {cur?.wrong ? <Notice tone="danger">That isn&apos;t the password for this file. Passwords are case-sensitive.</Notice> : null}
        <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Password" aria-label="Password" />
      </form>
    </Dialog>
  );
  return { ask, dialog };
}

/** Recognises the "needs a password" errors thrown by PDF.js as well as by pdf-lib. */
export function isPasswordError(e: unknown): e is Error & { fileName?: string; wrong: boolean } {
  return e instanceof Error && e.name === "PasswordError";
}
