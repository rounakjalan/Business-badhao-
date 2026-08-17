"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/lib/navigation";

type SidebarProps = {
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
};

export function Sidebar({ collapsed, onToggleCollapsed, onNavigate }: SidebarProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col border-r border-bb-border bg-bb-navy-2 font-outfit">
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-bb-border px-5">
        <div
          className="h-8 w-8 shrink-0 rounded-[10px]"
          style={{
            background:
              "conic-gradient(from 270deg, #8181ff 15%, #33dbdb 40%, #33d58e 55%, #ffd633 65%, #fc527d 85%, #8181ff 100%)",
          }}
        />
        {!collapsed ? (
          <span className="truncate text-[15px] font-semibold tracking-[-0.16px] text-bb-text">Business Badhao</span>
        ) : null}
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isActive ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
                isActive ? "bg-[#e7ecff] text-bb-indigo" : "text-bb-text-2 hover:translate-x-0.5 hover:bg-bb-navy-3"
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full transition-transform duration-200 group-hover:scale-125 ${isActive ? "bg-bb-indigo" : "bg-[#cacbcd]"}`}
              />
              {!collapsed ? <span className="truncate">{item.label}</span> : null}
            </Link>
          );
        })}
      </nav>

      {onToggleCollapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="bb-press mx-auto mb-4 flex h-8 w-8 items-center justify-center rounded-full border border-bb-border-2 bg-bb-navy-3 text-sm text-bb-text-2 transition-colors hover:bg-bb-navy-4"
        >
          {collapsed ? "→" : "←"}
        </button>
      ) : null}
    </div>
  );
}
