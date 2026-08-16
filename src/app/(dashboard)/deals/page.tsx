import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DealsIcon } from "@/components/ui/icons";
import { SimpleTable } from "@/components/ui/simple-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatCurrency, formatDate } from "@/lib/format";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function DealsPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("deals")
    .select("id, title, status, value, currency, expected_close_date, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const deals = data ?? [];

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Deals"
        description="Track opportunities as they move through your pipeline."
        action={
          <Button disabled title="Coming soon">
            New deal
          </Button>
        }
      />
      {deals.length === 0 ? (
        <EmptyState
          icon={DealsIcon}
          title="No deals yet"
          description="Deals created from your conversations and leads will be tracked here."
        />
      ) : (
        <SimpleTable
          columns={[
            { header: "Deal", cell: (d) => <span className="font-medium text-slate-900">{d.title}</span> },
            { header: "Status", cell: (d) => <StatusBadge status={d.status} /> },
            { header: "Value", cell: (d) => formatCurrency(Number(d.value), d.currency) },
            { header: "Expected close", cell: (d) => formatDate(d.expected_close_date) },
            { header: "Created", cell: (d) => formatDate(d.created_at) },
          ]}
          rows={deals}
          getRowKey={(d) => d.id}
        />
      )}
    </div>
  );
}
