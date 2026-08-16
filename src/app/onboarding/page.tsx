import { redirect } from "next/navigation";
import { createOrganization } from "@/app/onboarding/actions";
import { getCurrentOrg } from "@/lib/organizations";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/ui/icons";
import { createClient } from "@/lib/supabase/server";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const currentOrg = await getCurrentOrg();
  if (currentOrg) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center bg-slate-50 px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-2 text-center">
          <LogoMark className="h-8 w-8" />
          <h1 className="mt-2 text-xl font-semibold text-slate-900">
            Create your organization
          </h1>
          <p className="text-sm text-slate-500">
            This is the workspace your team will use in Business Badhao.
            You&apos;ll be its owner.
          </p>
        </div>

        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {error ? (
            <div className="mb-4">
              <Alert variant="error">{error}</Alert>
            </div>
          ) : null}

          <form action={createOrganization} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="name" className="text-sm font-medium text-slate-700">
                Organization name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                autoComplete="organization"
                placeholder="Acme Inc"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
            </div>

            <Button type="submit" className="mt-2 w-full">
              Create organization
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
