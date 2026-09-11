import Link from "next/link";
import { updatePassword } from "@/app/auth/actions";
import { Alert } from "@/components/ui/alert";
import { AuthSubmitButton } from "@/components/ui/auth-submit-button";
import { LogoMark } from "@/components/ui/icons";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center bg-slate-50 px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-2 text-center">
          <Link href="/" className="flex items-center gap-2">
            <LogoMark className="h-8 w-8" />
          </Link>
          <h1 className="mt-2 text-xl font-semibold text-slate-900">Choose a new password</h1>
          <p className="text-sm text-slate-500">
            Enter a new password for your account below.
          </p>
        </div>

        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {error ? (
            <div className="mb-4">
              <Alert variant="error">{error}</Alert>
            </div>
          ) : null}

          <form action={updatePassword} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm font-medium text-slate-700">
                New password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                placeholder="At least 6 characters"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="confirmPassword" className="text-sm font-medium text-slate-700">
                Confirm new password
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                placeholder="Re-enter your new password"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
            </div>

            <AuthSubmitButton idleLabel="Update password" pendingLabel="Updating..." />
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-slate-500">
          <Link href="/login" className="font-medium text-slate-700 hover:text-slate-900">
            Back to login
          </Link>
        </p>
      </div>
    </div>
  );
}
