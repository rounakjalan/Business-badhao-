"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  const [aiOpen, setAiOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const pathname = usePathname();

  const pageTitle = NAV_ITEMS.find((item) => pathname === item.href || pathname?.startsWith(`${item.href}/`))?.label ?? "Business Badhao";
  const displayName = userFullName || userEmail;

  return (
    <div className="font-outfit flex h-dvh overflow-hidden bg-bb-navy text-bb-text">
      <aside className={`hidden shrink-0 transition-all duration-300 md:flex ${collapsed ? "w-[72px]" : "w-[240px]"}`}>
        <Sidebar collapsed={collapsed} onToggleCollapsed={() => setCollapsed((v) => !v)} />
      </aside>

      {isMobileNavOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-[#333333]/35"
            onClick={() => setIsMobileNavOpen(false)}
          />
          <div className="relative flex h-full w-64 max-w-[80vw] flex-col shadow-xl">
            <button
              type="button"
              onClick={() => setIsMobileNavOpen(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded-md text-bb-text-3 hover:bg-bb-navy-3 hover:text-bb-text"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
            <Sidebar collapsed={false} onNavigate={() => setIsMobileNavOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          onClick={() => {
            setNotifOpen(false);
            setProfileOpen(false);
          }}
          className="relative z-20 flex h-16 shrink-0 items-center gap-3.5 border-b border-bb-border bg-bb-navy-2 px-4 sm:px-7"
        >
          <button
            type="button"
            onClick={() => setIsMobileNavOpen(true)}
            aria-label="Open navigation"
            className="flex h-9 w-9 items-center justify-center rounded-md text-bb-text-3 hover:bg-bb-navy-3 hover:text-bb-text md:hidden"
          >
            <MenuIcon className="h-5 w-5" />
          </button>

          <h1 className="hidden text-lg font-semibold tracking-[-0.22px] text-bb-text sm:block">{pageTitle}</h1>
          <div className="flex-1" />

          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="hidden items-center gap-2 rounded-full border border-bb-border-2 bg-bb-navy-3 px-4 py-2 text-sm text-bb-text-3 transition-colors hover:bg-bb-navy-4 sm:flex sm:min-w-44"
          >
            <SearchIcon className="h-4 w-4" />
            <span>Search...</span>
            <span className="ml-auto text-xs opacity-60">⌘K</span>
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search"
            className="flex h-9 w-9 items-center justify-center rounded-md text-bb-text-3 hover:bg-bb-navy-3 sm:hidden"
          >
            <SearchIcon className="h-4 w-4" />
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setAiOpen((v) => !v);
                setNotifOpen(false);
                setProfileOpen(false);
              }}
              className="hidden items-center gap-1.5 rounded-full border border-[#dbdbff] bg-[#e7ecff] px-4.5 py-2 text-sm font-medium text-bb-indigo transition-colors hover:bg-[#dbdbff] sm:flex"
            >
              <SparklesIcon className="h-3.5 w-3.5" />
              <span>Ask AI</span>
            </button>
            {aiOpen ? (
              <div
                onClick={(e) => e.stopPropagation()}
                className="bb-animate-fade-in bb-shadow-dropdown absolute right-0 top-12 z-50 w-[300px] rounded-2xl bg-bb-navy-2 p-4"
              >
                <div className="mb-2 text-sm font-semibold text-bb-text">Sidekick suggestion</div>
                <p className="text-[13px] leading-relaxed text-bb-text-2">
                  Ask your top-scored leads and open deals what needs attention today — this preview will connect to
                  live suggestions once the AI assistant ships.
                </p>
                <p className="mt-3 text-[11px] text-bb-text-3">Preview only — no request has been sent to an AI model.</p>
              </div>
            ) : null}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setNotifOpen((v) => !v);
                setAiOpen(false);
                setProfileOpen(false);
              }}
              aria-label="Notifications"
              className="relative flex h-9.5 w-9.5 items-center justify-center rounded-full text-bb-text-2 transition-colors hover:bg-bb-navy-3"
            >
              <BellIcon className="h-[18px] w-[18px]" />
            </button>
            {notifOpen ? (
              <div
                onClick={(e) => e.stopPropagation()}
                className="bb-animate-fade-in bb-shadow-dropdown absolute right-0 top-12 z-50 w-70 overflow-hidden rounded-2xl bg-bb-navy-2"
              >
                <div className="border-b border-bb-navy-3 px-4 py-3 text-sm font-semibold text-bb-text">Notifications</div>
                <div className="px-4 py-6 text-center text-sm text-bb-text-3">You&apos;re all caught up.</div>
              </div>
            ) : null}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setProfileOpen((v) => !v);
                setAiOpen(false);
                setNotifOpen(false);
              }}
              className="flex items-center gap-2 rounded-full transition-opacity hover:opacity-90"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-bb-indigo to-bb-violet text-[13px] font-semibold text-white">
                {initialsFor(displayName)}
              </div>
            </button>
            {profileOpen ? (
              <div
                onClick={(e) => e.stopPropagation()}
                className="bb-animate-fade-in bb-shadow-dropdown absolute right-0 top-12 z-50 w-50 overflow-hidden rounded-2xl bg-bb-navy-2"
              >
                <div className="border-b border-bb-navy-3 px-4 py-3">
                  <div className="truncate text-sm font-semibold text-bb-text">{displayName}</div>
                  <div className="truncate text-xs text-bb-text-3">{userEmail}</div>
                  <div className="mt-1 truncate text-xs text-bb-indigo">{organizationName}</div>
                </div>
                <Link
                  href="/settings"
                  onClick={() => setProfileOpen(false)}
                  className="block w-full px-4 py-2.5 text-left text-sm text-bb-text transition-colors hover:bg-bb-navy-3"
                >
                  Settings
                </Link>
                <div className="border-t border-bb-navy-3">
                  <form action={signOut}>
                    <button
                      type="submit"
                      className="w-full px-4 py-2.5 text-left text-sm text-bb-rose transition-colors hover:bg-bb-navy-3"
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
