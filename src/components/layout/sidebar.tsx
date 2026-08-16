"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { NAV_ITEMS } from "@/lib/navigation";
import { LogoMark } from "@/components/ui/icons";

type SidebarProps = {
  organizationName: string;
  userEmail: string;
  onNavigate?: () => void;
};

function initialsFor(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function Sidebar({ organizationName, userEmail, onNavigate }: SidebarProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-slate-900 text-slate-300">
      <div className="flex h-16 shrink-0 items-center gap-2 px-5">
        <LogoMark className="h-7 w-7" />
        <span className="text-sm font-semibold tracking-wide text-white">
          Business Badhao
        </span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const isActive =
            pathname === item.href || pathname?.startsWith(`${item.href}/`);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isActive ? "page" : undefined}
              className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-slate-800 text-white"
                  : "text-slate-400 hover:bg-slate-800/60 hover:text-white"
              }`}
            >
              <Icon
                className={`h-5 w-5 shrink-0 ${
                  isActive ? "text-white" : "text-slate-500 group-hover:text-white"
                }`}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-slate-800 px-3 py-4">
        <div className="flex items-center gap-3 rounded-lg px-3 py-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-white">
            {initialsFor(organizationName)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{organizationName}</p>
            <p className="truncate text-xs text-slate-500">{userEmail}</p>
          </div>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md px-2 py-1 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
