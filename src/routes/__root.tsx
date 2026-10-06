import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";
import appCss from "../styles.css?url";
import { SiteFooter, SiteHeader, themeScript } from "@/components/shell";
import { Button } from "@/components/ui";
import { BRAND } from "@/lib/brand";
import { startAnalytics } from "@/lib/analytics";
import { installNetMeter } from "@/lib/netmeter";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: `${BRAND.name}: free PDF tools that never upload your files` },
      { name: "description", content: BRAND.description },
      { property: "og:site_name", content: BRAND.name },
      { property: "og:type", content: "website" },
      { property: "og:image", content: `${BRAND.url}/og.jpg` },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootLayout() {
  useEffect(() => {
    // The meter first, so it also counts what the visit counter sends.
    installNetMeter();
    startAnalytics();
  }, []);
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-paper focus:px-3 focus:py-2">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
      <Toaster position="bottom-center" richColors closeButton theme="system" />
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto grid max-w-xl justify-items-center gap-4 px-6 py-24 text-center">
      <p className="text-6xl font-bold text-carbon tabular">404</p>
      <h1 className="text-2xl font-semibold">That page isn&apos;t here</h1>
      <p className="text-ink-2">The tool may have moved. Search for it, or browse every tool from the home page.</p>
      <Button asChild variant="primary">
        <Link to="/">See all tools</Link>
      </Button>
    </div>
  );
}
