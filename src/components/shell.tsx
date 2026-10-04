import { Link, useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { Monitor, Moon, Search, Sun } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BRAND } from "@/lib/brand";
import { load, save } from "@/lib/storage";
import { CATEGORIES, TOOLS } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";
import { IconTile } from "./icons";
import { MeterPill } from "./meter";
import { Button, Kbd } from "./ui";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-carbon" />
      <path d="M10 5.5h9.2l5.3 5.3V26a1.5 1.5 0 0 1-1.5 1.5H10A1.5 1.5 0 0 1 8.5 26V7A1.5 1.5 0 0 1 10 5.5z" fill="#ffffff" />
      <path d="M19.2 5.5v5.3h5.3z" fill="#c9cdf6" />
      <rect x="11" y="15.2" width="10.6" height="3.6" rx="1" fill="#f7e35a" />
      <path d="M11.8 12.4h6M11.8 21.8h8.4M11.8 24.6h5.2" stroke="#2d3bd6" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  const name: string = BRAND.name;
  const accent: string = BRAND.accent;
  const i = accent ? name.lastIndexOf(accent) : -1;
  return (
    <span className={cn("text-[17px] font-bold tracking-[-0.02em] text-ink", className)}>
      {i > 0 ? (
        <>
          {name.slice(0, i)}
          <span className="text-carbon">{name.slice(i)}</span>
        </>
      ) : (
        name
      )}
    </span>
  );
}

type ThemeChoice = "system" | "light" | "dark";

export const themeScript = `try{var t=localStorage.getItem("theme");if(t==='"light"'||t==='"dark"')document.documentElement.dataset.theme=JSON.parse(t)}catch(e){}`;

function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => setChoice(load<ThemeChoice>("theme", "system")), []);
  const next = () => {
    const order: ThemeChoice[] = ["system", "light", "dark"];
    const n = order[(order.indexOf(choice) + 1) % order.length];
    setChoice(n);
    save("theme", n);
    if (n === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = n;
  };
  const Icon = choice === "light" ? Sun : choice === "dark" ? Moon : Monitor;
  const label = choice === "light" ? "Light theme" : choice === "dark" ? "Dark theme" : "Theme follows your device";
  return (
    <Button variant="ghost" size="icon" onClick={next} aria-label={`${label}. Click to change.`} title={label}>
      <Icon />
    </Button>
  );
}

const PALETTE_EVENT = "open-tool-palette";
export function openPalette() {
  window.dispatchEvent(new Event(PALETTE_EVENT));
}

function ToolPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(PALETTE_EVENT, onOpen);
    };
  }, []);
  const go = useCallback(
    (slug: string) => {
      setOpen(false);
      void navigate({ to: "/$slug", params: { slug } });
    },
    [navigate],
  );
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 px-3 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <Command label="Find a tool" className="w-full max-w-xl overflow-hidden rounded-lg border border-line bg-paper shadow-panel" loop>
        <div className="flex items-center gap-2 border-b border-line-2 px-4">
          <Search className="size-4 text-ink-3" aria-hidden />
          <Command.Input autoFocus placeholder={`Search ${TOOLS.length} tools: “compress”, “jpg”, “sign”, “aadhaar”…`} className="h-12 w-full bg-transparent text-[15px] text-ink placeholder:text-ink-3 focus:outline-none" />
          <Kbd>Esc</Kbd>
        </div>
        <Command.List className="max-h-[min(60vh,28rem)] overflow-auto p-2">
          <Command.Empty className="px-3 py-8 text-center text-sm text-ink-2">No tool matches that. Try a simpler word.</Command.Empty>
          {CATEGORIES.map((c) => (
            <Command.Group key={c.id} heading={c.name} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3">
              {TOOLS.filter((t) => t.category === c.id).map((t) => (
                <Command.Item
                  key={t.slug}
                  value={t.slug}
                  keywords={[t.name, t.blurb, t.keywords ?? "", ...(t.aliases ?? [])]}
                  onSelect={() => go(t.slug)}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-carbon-soft"
                >
                  <IconTile name={t.icon} category={t.category} size="sm" />
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{t.name}</span>
                    <span className="block truncate text-xs text-ink-2">{t.blurb}</span>
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-desk/85 backdrop-blur-md supports-[backdrop-filter]:bg-desk/70">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2 rounded-md" aria-label={`${BRAND.name} home`}>
          <LogoMark />
          <Wordmark />
        </Link>
        <button
          type="button"
          onClick={openPalette}
          className="ml-auto hidden h-9 w-72 items-center gap-2 rounded-md border border-line bg-paper px-3 text-sm text-ink-3 transition-colors hover:border-ink-3 md:flex"
        >
          <Search className="size-4" aria-hidden />
          <span>Search {TOOLS.length} tools</span>
          <span className="ml-auto flex gap-1">
            <Kbd>/</Kbd>
          </span>
        </button>
        <div className="ml-auto flex items-center gap-1.5 md:ml-0">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={openPalette} aria-label="Search tools">
            <Search />
          </Button>
          <MeterPill />
          <ThemeToggle />
        </div>
      </div>
      <ToolPalette />
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-line bg-paper">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-sm">
            <Link to="/" className="flex items-center gap-2">
              <LogoMark />
              <Wordmark />
            </Link>
            <p className="mt-3 text-sm text-ink-2">{BRAND.tagline} Every tool runs in your browser: no uploads, no account, no watermark, no page limits.</p>
          </div>
          <nav aria-label="Site" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <Link to="/" hash="tools" className="text-ink-2 hover:text-ink">
              All tools
            </Link>
            <Link to="/privacy" className="text-ink-2 hover:text-ink">
              How privacy works
            </Link>
          </nav>
        </div>
        <div className="mt-10 grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
          {CATEGORIES.map((c) => (
            <div key={c.id}>
              <p className="text-xs font-semibold tracking-wide text-ink-3 uppercase">{c.name}</p>
              <ul className="mt-2.5 grid gap-1.5">
                {TOOLS.filter((t) => t.category === c.id).map((t) => (
                  <li key={t.slug}>
                    <Link to="/$slug" params={{ slug: t.slug }} className="text-[13px] text-ink-2 hover:text-carbon">
                      {t.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-12 text-xs text-ink-3">
          © {new Date().getFullYear()} {BRAND.name}. PDF rendering by PDF.js, OCR by Tesseract, fonts by Google Noto (OFL).
        </p>
      </div>
    </footer>
  );
}

export function Page({ children, className, ...props }: React.ComponentProps<"div"> & { children: ReactNode }) {
  return (
    <div className={cn("mx-auto w-full max-w-7xl px-4 sm:px-6", className)} {...props}>
      {children}
    </div>
  );
}
