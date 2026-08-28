import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { DarkCard } from "@/components/dashboard-ui/card";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { DealsIcon } from "@/components/ui/icons";
import { parseProspectRawData } from "@/lib/prospects";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/format";
import type { LossAnalysis } from "@/lib/ai/agents/loss-analysis";
import type { Json } from "@/types/database.types";

type PersistedLossDetails = Partial<LossAnalysis>;

function asDetails(details: Json | null): PersistedLossDetails {
  return details && typeof details === "object" && !Array.isArray(details) ? (details as PersistedLossDetails) : {};
}

/**
 * Counts occurrences of free-text items (objections, pricing concerns,
 * etc.) across every analyzed lost deal. This is an exact-string count —
 * real repeated phrasing across deals, not a fuzzy/AI-clustered theme — so
 * it never shows a pattern the data doesn't actually contain.
 */
function countStrings(lists: (string[] | undefined)[]): { text: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const list of lists) {
    for (const raw of list ?? []) {
      const text = raw.trim();
      if (!text) continue;
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

export default async function LostDealIntelligencePage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();

  const { data: lostDeals, error } = await supabase
    .from("deals")
    .select("id, title, value, currency, loss_reason, lead_id, lost_at, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .eq("status", "lost")
    .order("lost_at", { ascending: false, nullsFirst: false });

  if (error) throw new Error(error.message);

  const deals = lostDeals ?? [];
  const currency = deals[0]?.currency ?? "INR";

  if (deals.length === 0) {
    return (
      <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
        <PageHeader
          title="Lost Deal Intelligence"
          description="Patterns across every deal marked Lost — reasons, objections, and recovery opportunities."
          action={
            <Link href="/deals" className="text-sm text-bb-text-3 hover:text-bb-text">
              ← Deals
            </Link>
          }
        />
        <DarkEmptyState icon={DealsIcon} title="No lost deals yet" description="Once a deal is marked Lost, its analysis and patterns across all lost deals will show up here." />
      </div>
    );
  }

  const dealIds = deals.map((d) => d.id);
  const leadIds = [...new Set(deals.map((d) => d.lead_id).filter((id): id is string => Boolean(id)))];

  const [lossAnalysisRows, recoveryAttemptRows, leadRows] = await Promise.all([
    supabase
      .from("loss_analysis")
      .select("deal_id, reason_category, details, created_at")
      .eq("organization_id", currentOrg.organizationId)
      .in("deal_id", dealIds)
      .order("created_at", { ascending: false }),
    supabase.from("recovery_attempts").select("deal_id, status").eq("organization_id", currentOrg.organizationId).in("deal_id", dealIds),
    leadIds.length ? supabase.from("leads").select("id, prospect_id").in("id", leadIds) : Promise.resolve({ data: [] as { id: string; prospect_id: string | null }[] }),
  ]);

  // Most recent loss_analysis row per deal — runLossAnalysisAction updates
  // the same row in place, so this is normally already unique per deal,
  // but takes the latest defensively rather than assuming that.
  const analysisByDeal = new Map<string, { reason_category: string | null; details: PersistedLossDetails }>();
  for (const row of lossAnalysisRows.data ?? []) {
    if (!analysisByDeal.has(row.deal_id)) {
      analysisByDeal.set(row.deal_id, { reason_category: row.reason_category, details: asDetails(row.details) });
    }
  }

  const recoveryCountByDeal = new Map<string, number>();
  for (const r of recoveryAttemptRows.data ?? []) {
    recoveryCountByDeal.set(r.deal_id, (recoveryCountByDeal.get(r.deal_id) ?? 0) + 1);
  }

  const prospectIdByLead = new Map((leadRows.data ?? []).map((l) => [l.id, l.prospect_id]));
  const prospectIds = [...new Set([...prospectIdByLead.values()].filter((id): id is string => Boolean(id)))];
  const { data: prospectRows } = prospectIds.length
    ? await supabase.from("prospects").select("id, raw_data").in("id", prospectIds)
    : { data: [] as { id: string; raw_data: Json }[] };
  const prospectById = new Map((prospectRows ?? []).map((p) => [p.id, p]));

  const industryForDeal = (leadId: string | null) => {
    if (!leadId) return null;
    const prospectId = prospectIdByLead.get(leadId);
    const prospect = prospectId ? prospectById.get(prospectId) : null;
    return prospect ? parseProspectRawData(prospect.raw_data).industry : null;
  };

  const totalLostValue = deals.reduce((sum, d) => sum + Number(d.value), 0);
  const analyzedDeals = deals.filter((d) => Object.keys(analysisByDeal.get(d.id)?.details ?? {}).length > 0);

  // Human-selected reason (LOSS_REASONS in deal-detail-tabs.tsx) — always
  // present once a deal is marked lost, unlike the AI fields below which
  // need analysis to have been run.
  const reasonCounts = new Map<string, { count: number; value: number }>();
  for (const d of deals) {
    const key = d.loss_reason ?? "Not specified";
    const entry = reasonCounts.get(key) ?? { count: 0, value: 0 };
    entry.count += 1;
    entry.value += Number(d.value);
    reasonCounts.set(key, entry);
  }
  const topReasons = [...reasonCounts.entries()].sort((a, b) => b[1].count - a[1].count);

  const objectionCounts = countStrings(analyzedDeals.map((d) => analysisByDeal.get(d.id)?.details.objections));
  const pricingConcernCounts = countStrings(analyzedDeals.map((d) => analysisByDeal.get(d.id)?.details.pricingConcerns));

  const productCounts = new Map<string, { count: number; value: number }>();
  for (const d of analyzedDeals) {
    const product = analysisByDeal.get(d.id)?.details.productOrServiceInvolved;
    if (!product) continue;
    const entry = productCounts.get(product) ?? { count: 0, value: 0 };
    entry.count += 1;
    entry.value += Number(d.value);
    productCounts.set(product, entry);
  }
  const topProducts = [...productCounts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8);

  const industryCounts = new Map<string, { count: number; value: number }>();
  for (const d of deals) {
    const industry = industryForDeal(d.lead_id);
    if (!industry) continue;
    const entry = industryCounts.get(industry) ?? { count: 0, value: 0 };
    entry.count += 1;
    entry.value += Number(d.value);
    industryCounts.set(industry, entry);
  }
  const topIndustries = [...industryCounts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8);

  const recoveryOpportunities = analyzedDeals
    .map((d) => ({ deal: d, opportunity: analysisByDeal.get(d.id)?.details.recoveryOpportunity }))
    .filter((r): r is { deal: (typeof deals)[number]; opportunity: NonNullable<PersistedLossDetails["recoveryOpportunity"]> } => Boolean(r.opportunity?.justified));

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="Lost Deal Intelligence"
        description="Patterns across every deal marked Lost — reasons, objections, and recovery opportunities."
        action={
          <Link href="/deals" className="text-sm text-bb-text-3 hover:text-bb-text">
            ← Deals
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Lost Deals", val: String(deals.length) },
          { label: "Lost Value", val: formatCurrency(totalLostValue, currency) },
          { label: "Analyzed", val: `${analyzedDeals.length} of ${deals.length}` },
          { label: "Recovery Opportunities", val: String(recoveryOpportunities.length) },
        ].map((m) => (
          <div key={m.label} className="rounded-lg bg-bb-navy-3 p-3 text-center">
            <div className="mb-1 text-xs text-bb-text-3">{m.label}</div>
            <div className="font-jetbrains text-sm font-semibold text-bb-text">{m.val}</div>
          </div>
        ))}
      </div>

      {analyzedDeals.length < deals.length ? (
        <p className="text-xs text-bb-text-3">
          {deals.length - analyzedDeals.length} lost {deals.length - analyzedDeals.length === 1 ? "deal hasn't" : "deals haven't"} had AI analysis run
          yet — objection, pricing, and product patterns below only reflect deals that have. Open a lost deal and run analysis to include it.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DarkCard className="p-5">
          <h4 className="mb-3 text-sm font-semibold text-bb-text">Most Common Loss Reasons</h4>
          <BarList
            rows={topReasons.map(([label, v]) => ({ label, count: v.count, sublabel: formatCurrency(v.value, currency) }))}
            max={topReasons[0]?.[1].count ?? 1}
          />
        </DarkCard>

        <DarkCard className="p-5">
          <h4 className="mb-3 text-sm font-semibold text-bb-text">Recurring Objections</h4>
          {objectionCounts.length === 0 ? (
            <EmptyNote text="No objections recorded yet — run AI analysis on lost deals to surface them." />
          ) : (
            <BarList rows={objectionCounts.map((o) => ({ label: o.text, count: o.count }))} max={objectionCounts[0]?.count ?? 1} />
          )}
        </DarkCard>

        <DarkCard className="p-5">
          <h4 className="mb-3 text-sm font-semibold text-bb-text">Pricing Objections</h4>
          {pricingConcernCounts.length === 0 ? (
            <EmptyNote text="No pricing-specific concerns recorded yet." />
          ) : (
            <BarList rows={pricingConcernCounts.map((o) => ({ label: o.text, count: o.count }))} max={pricingConcernCounts[0]?.count ?? 1} />
          )}
        </DarkCard>

        <DarkCard className="p-5">
          <h4 className="mb-3 text-sm font-semibold text-bb-text">Patterns by Product / Service</h4>
          {topProducts.length === 0 ? (
            <EmptyNote text="No product/service was identified in analyzed conversations yet." />
          ) : (
            <BarList
              rows={topProducts.map(([label, v]) => ({ label, count: v.count, sublabel: formatCurrency(v.value, currency) }))}
              max={topProducts[0]?.[1].count ?? 1}
            />
          )}
        </DarkCard>

        <DarkCard className="p-5 lg:col-span-2">
          <h4 className="mb-3 text-sm font-semibold text-bb-text">Patterns by Customer / Company Type</h4>
          {topIndustries.length === 0 ? (
            <EmptyNote text="No industry/business-type data is on file for these leads yet — this comes from Lead Discovery." />
          ) : (
            <BarList
              rows={topIndustries.map(([label, v]) => ({ label, count: v.count, sublabel: formatCurrency(v.value, currency) }))}
              max={topIndustries[0]?.[1].count ?? 1}
            />
          )}
        </DarkCard>
      </div>

      <DarkCard className="p-5">
        <h4 className="mb-1 text-sm font-semibold text-bb-text">Recovery Opportunities</h4>
        <p className="mb-4 text-xs text-bb-text-3">
          Lost deals the AI flagged as having a real, evidence-backed reason to re-engage — never a suggestion to contact
          automatically, always a human call from the deal page.
        </p>
        {recoveryOpportunities.length === 0 ? (
          <EmptyNote text="No lost deal currently has a justified recovery opportunity flagged." />
        ) : (
          <div className="space-y-2">
            {recoveryOpportunities.map(({ deal, opportunity }) => (
              <Link
                key={deal.id}
                href={`/deals/${deal.id}`}
                className="block rounded-lg border border-bb-border bg-bb-navy p-3 text-sm transition-colors hover:border-bb-indigo/40"
              >
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-bb-text">{deal.title}</span>
                  <span className="font-jetbrains text-xs text-bb-text-3">{formatCurrency(Number(deal.value), deal.currency)}</span>
                </div>
                <p className="text-xs text-bb-text-3">{opportunity.reasoning}</p>
                {(recoveryCountByDeal.get(deal.id) ?? 0) > 0 ? (
                  <p className="mt-1 text-xs text-bb-indigo-2">{recoveryCountByDeal.get(deal.id)} recovery attempt(s) already logged</p>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </DarkCard>
    </div>
  );
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-xs text-bb-text-3">{text}</p>;
}

function BarList({ rows, max }: { rows: { label: string; count: number; sublabel?: string }[]; max: number }) {
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-bb-text-2" title={r.label}>
              {r.label}
            </span>
            <span className="shrink-0 font-jetbrains text-bb-text-3">
              {r.count}
              {r.sublabel ? ` · ${r.sublabel}` : ""}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-bb-navy-3">
            <div className="h-full rounded-full bg-bb-indigo" style={{ width: `${Math.max(6, (r.count / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
