"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { signOut } from "@/app/auth/actions";
import { Sidebar } from "@/components/layout/sidebar";
import { GlobalSearch } from "@/components/layout/global-search";
import { BellIcon, CloseIcon, MenuIcon, SearchIcon, SparklesIcon } from "@/components/ui/icons";
import { NAV_ITEMS } from "@/lib/navigation";

type DashboardShellProps = {
  organizationName: string;
  userEmail: string;
  userFullName: string;
  children: ReactNode;
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

export function DashboardShell({ organizationName, userEmail, userFullName, children }: DashboardShellProps) {
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  const pageTitle = NAV_ITEMS.find((item) => pathname === item.href || pathname?.startsWith(`${item.href}/`))?.label ?? "Business Badhao";
  const displayName = userFullName || userEmail;

  return (
    <div className="font-outfit flex h-dvh overflow-hidden bg-bb-navy text-bb-text">
      <aside className={`hidden shrink-0 transition-all duration-300 md:flex ${collapsed ? "w-16" : "w-56"}`}>
        <Sidebar collapsed={collapsed} onToggleCollapsed={() => setCollapsed((v) => !v)} />
      </aside>

      {isMobileNavOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-bb-navy/70"
            onClick={() => setIsMobileNavOpen(false)}
          />
          <div className="relative flex h-full w-64 max-w-[80vw] flex-col shadow-xl">
            <button
              type="button"
              onClick={() => setIsMobileNavOpen(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded-md text-bb-text-3 hover:bg-white/5 hover:text-bb-text"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
            <Sidebar collapsed={false} onNavigate={() => setIsMobileNavOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-bb-border bg-bb-navy-2 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setIsMobileNavOpen(true)}
            aria-label="Open navigation"
            className="flex h-9 w-9 items-center justify-center rounded-md text-bb-text-3 hover:bg-white/5 hover:text-bb-text md:hidden"
          >
            <MenuIcon className="h-5 w-5" />
          </button>

          <h1 className="font-display hidden text-base font-semibold text-bb-text sm:block">{pageTitle}</h1>
          <div className="flex-1" />

          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="hidden items-center gap-2 rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-1.5 text-sm text-bb-text-3 transition-colors hover:bg-white/5 sm:flex sm:min-w-44"
          >
            <SearchIcon className="h-4 w-4" />
            <span>Search...</span>
            <span className="ml-auto text-xs opacity-50">⌘K</span>
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            className="flex h-9 w-9 items-center justify-center rounded-md text-bb-text-3 hover:bg-white/5 sm:hidden"
          >
            <SearchIcon className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="hidden items-center gap-2 rounded-lg border border-bb-indigo/30 bg-bb-indigo/12 px-3 py-1.5 text-sm text-bb-indigo-2 transition-colors hover:bg-bb-indigo/20 sm:flex"
          >
            <SparklesIcon className="h-3.5 w-3.5" />
            <span>Ask AI</span>
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={() => setNotifOpen((v) => !v)}
              aria-label="Notifications"
              className="relative flex h-9 w-9 items-center justify-center rounded-lg text-bb-text-3 transition-colors hover:bg-white/5"
            >
              <BellIcon className="h-[18px] w-[18px]" />
            </button>
            {notifOpen ? (
              <div className="bb-animate-fade-in absolute right-0 top-11 z-50 w-72 rounded-xl border border-bb-border bg-bb-navy-3 py-2 shadow-2xl">
                <div className="border-b border-bb-border px-4 py-2 text-sm font-medium text-bb-text">Notifications</div>
                <div className="px-4 py-6 text-center text-sm text-bb-text-3">You&apos;re all caught up.</div>
              </div>
            ) : null}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setProfileOpen((v) => !v)}
              className="flex items-center gap-2 rounded-lg px-1 py-1 transition-colors hover:bg-white/5"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-bb-indigo to-bb-violet text-xs font-semibold text-white">
                {initialsFor(displayName)}
              </div>
            </button>
            {profileOpen ? (
              <div className="bb-animate-fade-in absolute right-0 top-11 z-50 min-w-52 rounded-xl border border-bb-border bg-bb-navy-3 py-2 shadow-2xl">
                <div className="border-b border-bb-border px-4 py-2">
                  <div className="truncate text-sm font-medium text-bb-text">{displayName}</div>
                  <div className="truncate text-xs text-bb-text-3">{userEmail}</div>
                  <div className="mt-1 truncate text-xs text-bb-indigo-2">{organizationName}</div>
                </div>
                <Link
                  href="/settings"
                  onClick={() => setProfileOpen(false)}
                  className="block w-full px-4 py-2 text-left text-sm text-bb-text-2 transition-colors hover:bg-white/5"
                >
                  Settings
                </Link>
                <div className="mt-1 border-t border-bb-border pt-1">
                  <form action={signOut}>
                    <button
                      type="submit"
                      className="w-full px-4 py-2 text-left text-sm text-bb-rose transition-colors hover:bg-white/5"
                    >
                      Sign out
                    </button>
                  </form>
                </div>
              </div>
            ) : null}
          </div>
        </header>

        <main className="flex flex-1 flex-col overflow-y-auto bg-bb-navy">{children}</main>
      </div>

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
