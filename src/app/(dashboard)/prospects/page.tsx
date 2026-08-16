import { PageHeader } from "@/components/layout/page-header";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { DataTable } from "@/components/dashboard-ui/table";
import { ProspectsIcon } from "@/components/ui/icons";
import { formatDate } from "@/lib/format";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function ProspectsPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prospects")
    .select("id, company_name, contact_name, email, website, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  const prospects = data ?? [];

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="Prospects"
        description="Discovered contacts being researched and qualified"
        action={
          <DashButton variant="gradient" disabled title="Coming soon">
            Find Prospects
          </DashButton>
        }
      />

      {prospects.length === 0 ? (
        <DarkEmptyState
          icon={ProspectsIcon}
          title="No prospects yet"
          description="Raw, unqualified contacts will appear here before they're promoted to leads."
        />
      ) : (
        <DataTable
          columns={[
            { header: "Contact", cell: (p) => p.contact_name ?? "—" },
            { header: "Company", cell: (p) => p.company_name ?? "—" },
            { header: "Email", cell: (p) => p.email ?? "—" },
            { header: "Website", cell: (p) => p.website ?? "—" },
            { header: "Added", cell: (p) => formatDate(p.created_at) },
          ]}
          rows={prospects}
          getRowKey={(p) => p.id}
        />
      )}
    </div>
  );
}
