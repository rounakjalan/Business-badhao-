"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { DashButton } from "@/components/dashboard-ui/button";
import { DealStatusBadge } from "@/components/dashboard-ui/badge";
import { DataTable } from "@/components/dashboard-ui/table";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { DealsIcon } from "@/components/ui/icons";
import { DEAL_STAGES, DEAL_STAGE_LABELS } from "@/lib/deals";
import { formatCurrency, formatDate } from "@/lib/format";

type Deal = {
  id: string;
  title: string;
  status: string;
  value: number;
  currency: string;
  probability: number | null;
  expected_close_date: string | null;
  created_at: string;
};

const STAGES = DEAL_STAGES;
const STAGE_COLOR: Record<string, string> = {
  new: "bg-bb-indigo",
  qualified: "bg-bb-sky",
  proposal: "bg-bb-amber",
  payment_pending: "bg-bb-violet",
  won: "bg-bb-emerald",
  lost: "bg-bb-rose",
};

export function DealsListClient({ deals }: { deals: Deal[] }) {
  const router = useRouter();
  const [view, setView] = useState<"pipeline" | "list">("pipeline");

  const totalPipeline = deals.filter((d) => d.status !== "lost").reduce((sum, d) => sum + Number(d.value), 0);
  const currency = deals[0]?.currency ?? "INR";

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="Deals"
        description={
          <>
            Pipeline value: <span className="font-jetbrains font-semibold text-bb-emerald">{formatCurrency(totalPipeline, currency)}</span>
          </>
        }
        action={
          <div className="flex items-center gap-3">
            <Link href="/deals/lost-intelligence">
              <DashButton variant="ghost">Lost Deal Intelligence</DashButton>
            </Link>
            <div className="flex overflow-hidden rounded-lg border border-bb-border">
              {(["pipeline", "list"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`bb-press px-4 py-2 text-xs font-medium capitalize transition-all ${
                    view === v ? "bg-bb-indigo/20 text-bb-indigo-2" : "text-bb-text-3 hover:bg-bb-navy-3"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {deals.length === 0 ? (
        <DarkEmptyState icon={DealsIcon} title="No deals yet" description="Deals created from your conversations and leads will be tracked here." />
      ) : view === "pipeline" ? (
        <div className="bb-stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {STAGES.map((stage) => {
            const stageDeals = deals.filter((d) => d.status === stage);
            return (
              <div key={stage} className="bb-stagger-item">
                <div className="mb-3 flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${STAGE_COLOR[stage]}`} />
                    <span className="text-xs font-semibold text-bb-text-2">{DEAL_STAGE_LABELS[stage]}</span>
                  </div>
                  <span className="font-jetbrains text-xs text-bb-text-3">{stageDeals.length}</span>
                </div>
                <div className="min-h-48 space-y-2 rounded-xl border border-bb-border bg-bb-navy-2 p-2">
                  {stageDeals.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => router.push(`/deals/${d.id}`)}
                      className="bb-press bb-lift w-full rounded-lg border border-bb-border bg-bb-navy p-3 text-left transition-colors hover:border-bb-indigo/40"
                    >
                      <div className="mb-1 text-xs font-semibold leading-tight text-bb-text">{d.title}</div>
                      <div className="flex items-center justify-between">
                        <span className="font-jetbrains text-xs font-bold text-bb-text-2">{formatCurrency(d.value, d.currency)}</span>
                        {d.probability !== null ? <span className="text-xs text-bb-text-3">{d.probability}%</span> : null}
                      </div>
                      {d.probability !== null ? (
                        <div className="mt-2 h-1 rounded-full bg-bb-navy-3">
                          <div
                            className={`h-full rounded-full transition-[width] duration-700 ease-out ${STAGE_COLOR[stage]}`}
                            style={{ width: `${d.probability}%` }}
                          />
                        </div>
                      ) : null}
                    </button>
                  ))}
                  {stageDeals.length === 0 ? <div className="py-8 text-center text-xs text-bb-text-3">No deals</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <DataTable
          onRowClick={(d) => router.push(`/deals/${d.id}`)}
          columns={[
            { header: "Deal", cell: (d) => <span className="font-medium text-bb-text">{d.title}</span> },
            { header: "Value", cell: (d) => <span className="font-jetbrains font-semibold text-bb-emerald">{formatCurrency(d.value, d.currency)}</span> },
            { header: "Stage", cell: (d) => <DealStatusBadge status={d.status} /> },
            { header: "Expected Close", cell: (d) => formatDate(d.expected_close_date) },
          ]}
          rows={deals}
          getRowKey={(d) => d.id}
        />
      )}
    </div>
  );
}
