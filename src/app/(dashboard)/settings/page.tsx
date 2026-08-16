import { PageHeader } from "@/components/layout/page-header";
import { updateOrganization, updateProfile } from "@/app/(dashboard)/settings/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

const MESSAGES: Record<string, string> = {
  "profile-updated": "Your profile was updated.",
  "organization-updated": "Your organization was updated.",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { error, message } = await searchParams;

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email")
    .eq("id", user?.id ?? "")
    .maybeSingle();

  const canManageOrganization = currentOrg.role === "owner" || currentOrg.role === "admin";

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Manage your workspace, team and account preferences."
      />

      {error ? <Alert variant="error">{error}</Alert> : null}
      {message && MESSAGES[message] ? <Alert variant="success">{MESSAGES[message]}</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">Your profile</h3>
          <p className="mt-1 text-sm text-slate-500">Your personal account details.</p>

          <form action={updateProfile} className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="fullName" className="text-xs font-medium text-slate-600">
                Full name
              </label>
              <input
                id="fullName"
                name="fullName"
                type="text"
                defaultValue={profile?.full_name ?? ""}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600">Email</label>
              <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">
                {profile?.email ?? user?.email}
              </p>
            </div>
            <Button type="submit" variant="secondary" className="self-start">
              Save profile
            </Button>
          </form>
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">Organization</h3>
          <p className="mt-1 text-sm text-slate-500">
            You are a{currentOrg.role === "owner" ? "n" : ""} {currentOrg.role} of this organization.
          </p>

          <form action={updateOrganization} className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="name" className="text-xs font-medium text-slate-600">
                Organization name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                defaultValue={currentOrg.organizationName}
                disabled={!canManageOrganization}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:bg-slate-50 disabled:text-slate-400"
              />
            </div>
            <Button type="submit" variant="secondary" className="self-start" disabled={!canManageOrganization}>
              Save organization
            </Button>
          </form>
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">Members</h3>
          <p className="mt-1 text-sm text-slate-500">Invite teammates and manage their access.</p>
          <p className="mt-4 text-xs font-medium text-slate-400">Coming soon</p>
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">Billing</h3>
          <p className="mt-1 text-sm text-slate-500">Plan, usage and payment details.</p>
          <p className="mt-4 text-xs font-medium text-slate-400">Coming soon</p>
        </Card>
      </div>
    </div>
  );
}
