import { Link } from "@tanstack/react-router";
import type { Tool } from "@/lib/tools/catalog";
import { cn } from "@/lib/utils";
import { IconTile } from "./icons";

export function ToolCard({ tool, className, onClick }: { tool: Tool; className?: string; onClick?: () => void }) {
  return (
    <Link
      to="/$slug"
      params={{ slug: tool.slug }}
      onClick={onClick}
      className={cn(
        "group relative flex h-full flex-col gap-2.5 rounded-lg border border-line bg-paper p-3 transition-[border-color,box-shadow,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-ink-3/60 hover:shadow-panel focus-visible:-translate-y-0.5 sm:flex-row sm:gap-3 sm:p-4",
        className,
      )}
    >
      <IconTile name={tool.icon} category={tool.category} />
      <span className="min-w-0">
        <span className="block text-[14px] leading-snug font-semibold text-ink group-hover:text-carbon sm:text-[15px]">{tool.name}</span>
        <span className="mt-0.5 hidden text-[13px] leading-snug text-ink-2 sm:block">{tool.blurb}</span>
      </span>
    </Link>
  );
}
