import Link from "next/link";
import { requestPasswordReset } from "@/app/auth/actions";
import { Alert } from "@/components/ui/alert";
import { AuthSubmitButton } from "@/components/ui/auth-submit-button";
import { LogoMark } from "@/components/ui/icons";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { error, message } = await searchParams;

  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center bg-slate-50 px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-2 text-center">
          <Link href="/" className="flex items-center gap-2">
            <LogoMark className="h-8 w-8" />
          </Link>
          <h1 className="mt-2 text-xl font-semibold text-slate-900">Reset your password</h1>
          <p className="text-sm text-slate-500">
            Enter your email and we&apos;ll send you a link to reset your password.
          </p>
        </div>

        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {error ? (
            <div className="mb-4">
              <Alert variant="error">{error}</Alert>
            </div>
          ) : null}
          {message === "check-email" ? (
            <div className="mb-4">
              <Alert variant="success">
                If an account exists for that email, you&apos;ll receive a password reset link shortly.
              </Alert>
            </div>
          ) : null}

          <form action={requestPasswordReset} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-sm font-medium text-slate-700">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@company.com"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
            </div>

            <AuthSubmitButton idleLabel="Send reset link" pendingLabel="Sending..." />
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
