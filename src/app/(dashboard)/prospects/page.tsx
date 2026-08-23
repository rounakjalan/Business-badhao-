import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { DataTable } from "@/components/dashboard-ui/table";
import { ProspectsIcon } from "@/components/ui/icons";
import { formatDate } from "@/lib/format";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default async function ProspectsPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prospects")
    .select("id, company_name, contact_name, email, website, raw_data, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  // Discovery records where it found a business but nothing displayed it,
  // so every discovered prospect looked like an empty row.
  const prospects = (data ?? []).map((p) => {
    const raw = (p.raw_data ?? {}) as { sourceUrl?: unknown };
    return { ...p, sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : null };
  });

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="Prospects"
        description="Discovered contacts being researched and qualified"
        action={
          <Link href="/campaigns">
            <DashButton variant="gradient">Find Prospects</DashButton>
          </Link>
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
            {
              header: "Found via",
              cell: (p) =>
                p.sourceUrl ? (
                  <a
                    href={p.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-bb-indigo transition-colors hover:text-bb-indigo-3"
                  >
                    {hostnameOf(p.sourceUrl)}
                  </a>
                ) : (
                  "—"
                ),
            },
            { header: "Added", cell: (p) => formatDate(p.created_at) },
          ]}
          rows={prospects}
          getRowKey={(p) => p.id}
        />
      )}
    </div>
  );
}
