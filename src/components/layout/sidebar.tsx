"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/lib/navigation";
import { LogoMark } from "@/components/ui/icons";

type SidebarProps = {
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onNavigate?: () => void;
};

export function Sidebar({ collapsed, onToggleCollapsed, onNavigate }: SidebarProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-bb-navy-2 font-outfit">
      <div className="flex h-[60px] shrink-0 items-center gap-3 border-b border-bb-border px-4">
        <LogoMark className="h-8 w-8 shrink-0" />
        {!collapsed ? (
          <span className="font-display truncate text-base font-semibold text-bb-text">Business Badhao</span>
        ) : null}
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto py-4">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isActive ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              className={`mx-2 mb-0.5 flex items-center gap-3 rounded-lg border-l-2 px-3 py-2.5 text-sm font-medium transition-all ${
                isActive
                  ? "border-bb-indigo bg-gradient-to-r from-bb-indigo/25 to-bb-indigo/8 text-bb-indigo-2"
                  : "border-transparent text-bb-text-3 hover:bg-white/5"
              }`}
            >
              <Icon className="h-[18px] w-5 shrink-0" />
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
          className="mx-auto mb-4 flex h-8 w-8 items-center justify-center rounded-lg text-bb-text-3 transition-colors hover:bg-white/5"
        >
          {collapsed ? "→" : "←"}
        </button>
      ) : null}
    </div>
  );
}
