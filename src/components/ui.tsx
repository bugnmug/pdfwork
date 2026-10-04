import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[background-color,color,box-shadow,opacity] duration-150 disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-carbon text-carbon-ink hover:bg-carbon-hover",
        secondary: "border border-line bg-paper text-ink hover:border-ink-3",
        ghost: "text-ink-2 hover:bg-paper-2 hover:text-ink",
        danger: "bg-danger text-white hover:opacity-90",
        soft: "bg-carbon-soft text-carbon hover:bg-carbon hover:text-carbon-ink",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-5 text-[15px]",
        icon: "size-9",
        iconSm: "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild,
  busy,
  children,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean; busy?: boolean }) {
  if (asChild)
    return (
      <Slot className={cn(buttonVariants({ variant, size }), className)} {...props}>
        {children}
      </Slot>
    );
  return (
    <button type="button" className={cn(buttonVariants({ variant, size }), className)} {...props}>
      {busy ? <Loader2 className="animate-spin" /> : null}
      {children}
    </button>
  );
}

export const inputClass =
  "w-full rounded-md border border-line bg-paper px-3 text-sm text-ink placeholder:text-ink-3 transition-colors hover:border-ink-3 focus:border-carbon focus:outline-none focus-visible:outline-none focus:ring-2 focus:ring-carbon/25 disabled:opacity-50";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(inputClass, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn(inputClass, "min-h-28 py-2.5 leading-relaxed", className)} {...props} />;
}

export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select className={cn(inputClass, "h-10 appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9", className)} style={{ backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23747b8c' stroke-width='2'><path d='m6 9 6 6 6-6'/></svg>\")" }} {...props}>
      {children}
    </select>
  );
}

export function Field({ label, help, children, htmlFor, className }: { label: ReactNode; help?: ReactNode; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink-2">
        {label}
      </label>
      {children}
      {help ? <p className="text-xs text-ink-3">{help}</p> : null}
    </div>
  );
}

export function Segmented({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: ReactNode }[];
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap gap-1 rounded-md border border-line bg-paper-2 p-1", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "min-h-8 flex-1 rounded-[5px] px-2.5 text-[13px] font-medium transition-colors",
              on ? "bg-paper text-ink shadow-[0_1px_2px_rgb(0_0_0/0.12)] ring-1 ring-line" : "text-ink-2 hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; id?: string }) {
  const auto = useId();
  const sid = id ?? auto;
  return (
    <label htmlFor={sid} className="flex items-start gap-3 text-sm text-ink">
      <button
        id={sid}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-carbon" : "bg-line")}
      >
        <span className={cn("absolute top-0.5 left-0.5 size-4 rounded-full bg-paper shadow transition-transform", checked && "translate-x-4")} />
      </button>
      <span className="leading-snug">{label}</span>
    </label>
  );
}

export function Slider({ value, onChange, min, max, step = 1, format, label }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; format?: (v: number) => string; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        className="h-2 w-full cursor-pointer accent-[var(--carbon)]"
      />
      <span className="w-14 shrink-0 text-right text-[13px] text-ink-2 tabular">{format ? format(value) : value}</span>
    </div>
  );
}

export function Progress({ value, label }: { value: number | null; label?: string }) {
  return (
    <div className="grid gap-1.5" role="status" aria-live="polite">
      <div className="h-1.5 overflow-hidden rounded-full bg-line-2">
        <div
          className={cn("h-full rounded-full bg-carbon transition-[width] duration-300", value === null && "w-1/3 animate-pulse")}
          style={value === null ? undefined : { width: `${Math.max(3, Math.min(100, value * 100))}%` }}
        />
      </div>
      {label ? <p className="truncate text-xs text-ink-2">{label}</p> : null}
    </div>
  );
}

export function Panel({ className, children, ...props }: React.ComponentProps<"section">) {
  return (
    <section className={cn("rounded-lg border border-line bg-paper", className)} {...props}>
      {children}
    </section>
  );
}

export function Notice({ tone = "info", children, className }: { tone?: "info" | "ok" | "warn" | "danger"; children: ReactNode; className?: string }) {
  const tones = {
    info: "border-line bg-paper-2 text-ink-2",
    ok: "border-ok/30 bg-ok-soft text-ok",
    warn: "border-warn/30 bg-warn-soft text-warn",
    danger: "border-danger/30 bg-danger-soft text-danger",
  };
  return (
    <div role={tone === "danger" ? "alert" : undefined} className={cn("rounded-md border px-3.5 py-2.5 text-sm", tones[tone], className)}>
      {children}
    </div>
  );
}

export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const root = ref.current;
      const el = root?.querySelector<HTMLElement>("[data-autofocus]") ?? root?.querySelector<HTMLElement>('input:not([type=range]):not([type=checkbox]):not([type=color]):not([type=radio]),textarea,select');
      el?.focus();
    }, 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} className={cn("max-h-[92dvh] w-full overflow-auto rounded-t-xl border border-line bg-paper shadow-panel sm:rounded-lg", wide ? "sm:max-w-3xl" : "sm:max-w-md")}>
        <div className="flex items-center justify-between gap-3 border-b border-line-2 px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button variant="ghost" size="iconSm" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line-2 px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-paper-2 px-1.5 py-0.5 font-sans text-[11px] text-ink-3">{children}</kbd>;
}

/** Click-to-open panel anchored to its trigger. Closes on outside click and Escape. */
export function Popover({
  button,
  children,
  align = "end",
  className,
}: {
  button: (p: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div ref={ref} className="relative">
      {button({ open, toggle: () => setOpen((o) => !o) })}
      {open ? (
        <div
          className={cn(
            "absolute top-full z-40 mt-2 max-w-[calc(100vw-24px)] rounded-lg border border-line bg-paper shadow-panel",
            align === "end" ? "right-0" : "left-0",
            className,
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      ) : null}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin", className)} aria-hidden />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-2 px-6 py-10 text-center">
      {icon ? <div className="text-ink-3 [&_svg]:size-8">{icon}</div> : null}
      <p className="font-medium text-ink">{title}</p>
      {children ? <div className="max-w-md text-sm text-ink-2">{children}</div> : null}
    </div>
  );
}
