import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LeadsIcon } from "@/components/ui/icons";
import { SimpleTable } from "@/components/ui/simple-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate, shortId } from "@/lib/format";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function LeadsPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("leads")
    .select("id, status, qualification_status, current_score, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const leads = data ?? [];

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Leads"
        description="Prospects discovered or imported into your workspace."
        action={
          <Button disabled title="Coming soon">
            Add lead
          </Button>
        }
      />
      {leads.length === 0 ? (
        <EmptyState
          icon={LeadsIcon}
          title="No leads yet"
          description="Leads you add or discover will show up here with their contact details and status."
        />
      ) : (
        <SimpleTable
          columns={[
            { header: "Lead", cell: (l) => <span className="font-mono text-xs text-slate-500">{shortId(l.id)}</span> },
            { header: "Status", cell: (l) => <StatusBadge status={l.status} /> },
            { header: "Qualification", cell: (l) => <StatusBadge status={l.qualification_status} /> },
            { header: "Score", cell: (l) => l.current_score ?? "—" },
            { header: "Created", cell: (l) => formatDate(l.created_at) },
          ]}
          rows={leads}
          getRowKey={(l) => l.id}
        />
      )}
    </div>
  );
}
