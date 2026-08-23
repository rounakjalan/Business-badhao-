"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { CampaignsIcon, DealsIcon, LeadsIcon, SearchIcon } from "@/components/ui/icons";
import { formatCurrency } from "@/lib/format";

type SearchResult = {
  key: string;
  href: string;
  icon: typeof CampaignsIcon;
  label: string;
  sub: string;
};

export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <GlobalSearchModal onClose={onClose} />;
}

function GlobalSearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      const supabase = createClient();
      const term = `%${trimmed}%`;

      const [campaigns, deals, contacts, prospects] = await Promise.all([
        supabase.from("campaigns").select("id, name, status").ilike("name", term).limit(5),
        supabase.from("deals").select("id, title, value, currency").ilike("title", term).limit(5),
        supabase.from("contacts").select("lead_id, full_name, email").ilike("full_name", term).limit(5),
        // Discovered leads have a company but no contact, so searching
        // contacts alone can never find them.
        supabase.from("prospects").select("id, company_name").ilike("company_name", term).limit(5),
      ]);

      if (cancelled) return;

      const prospectIds = (prospects.data ?? []).map((p) => p.id);
      const { data: leadsForProspects } = prospectIds.length
        ? await supabase.from("leads").select("id, prospect_id").in("prospect_id", prospectIds)
        : { data: [] };

      if (cancelled) return;

      const companyByProspect = new Map((prospects.data ?? []).map((p) => [p.id, p.company_name]));
      const leadIdsFromContacts = new Set((contacts.data ?? []).map((c) => c.lead_id));
      const companyResults = (leadsForProspects ?? []).flatMap((l) => {
        const companyName = l.prospect_id ? companyByProspect.get(l.prospect_id) : null;
        if (!companyName || leadIdsFromContacts.has(l.id)) return [];
        return [{ leadId: l.id, companyName }];
      });

      const next: SearchResult[] = [
        ...(campaigns.data ?? []).map((c) => ({
          key: `campaign-${c.id}`,
          href: `/campaigns/${c.id}`,
          icon: CampaignsIcon,
          label: c.name,
          sub: `Campaign · ${c.status}`,
        })),
        ...(deals.data ?? []).map((d) => ({
          key: `deal-${d.id}`,
          href: `/deals/${d.id}`,
          icon: DealsIcon,
          label: d.title,
          sub: `Deal · ${formatCurrency(Number(d.value), d.currency)}`,
        })),
        ...(contacts.data ?? []).map((c) => ({
          key: `contact-${c.lead_id}-${c.full_name}`,
          href: `/leads/${c.lead_id}`,
          icon: LeadsIcon,
          label: c.full_name ?? "Unnamed contact",
          sub: `Lead · ${c.email ?? "No email"}`,
        })),
        ...companyResults.map((r) => ({
          key: `company-${r.leadId}`,
          href: `/leads/${r.leadId}`,
          icon: LeadsIcon,
          label: r.companyName,
          sub: "Lead · Company",
        })),
      ];

      setResults(next);
      setLoading(false);
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const trimmedQuery = query.trim();
  const displayResults = trimmedQuery.length < 2 ? [] : results;

  return (
    <div
      className="bb-animate-fade-in fixed inset-0 z-50 flex items-start justify-center bg-[#333333]/35 pt-24"
      onClick={onClose}
    >
      <div
        className="bb-animate-scale-in bb-shadow-dropdown w-full max-w-xl overflow-hidden rounded-2xl bg-bb-navy-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-bb-navy-3 px-5 py-4">
          <SearchIcon className="h-4 w-4 text-bb-indigo" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder="Search campaigns, leads, deals..."
            className="flex-1 bg-transparent text-sm text-bb-text outline-none placeholder:text-bb-text-3"
          />
          <kbd className="rounded bg-bb-navy-4 px-2 py-1 text-xs text-bb-text-3">ESC</kbd>
        </div>
        <div className="max-h-96 overflow-y-auto p-3">
          {loading ? <div className="px-4 py-6 text-center text-sm text-bb-text-3">Searching...</div> : null}
          {!loading && trimmedQuery.length >= 2 && displayResults.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-bb-text-3">No results for &ldquo;{query}&rdquo;.</div>
          ) : null}
          {trimmedQuery.length < 2 ? (
            <div className="px-4 py-6 text-center text-sm text-bb-text-3">Type at least 2 characters to search.</div>
          ) : null}
          {displayResults.map((r) => (
            <button
              key={r.key}
              onClick={() => {
                onClose();
                router.push(r.href);
              }}
              className="bb-press flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-bb-navy-3"
            >
              <r.icon className="h-4 w-4 shrink-0 text-bb-indigo" />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-bb-text">{r.label}</div>
                <div className="truncate text-xs text-bb-text-3">{r.sub}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
