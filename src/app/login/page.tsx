import Link from "next/link";
import { signIn } from "@/app/auth/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/ui/icons";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirectTo?: string; message?: string }>;
}) {
  const { error, redirectTo, message } = await searchParams;

  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center bg-slate-50 px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-2 text-center">
          <Link href="/" className="flex items-center gap-2">
            <LogoMark className="h-8 w-8" />
          </Link>
          <h1 className="mt-2 text-xl font-semibold text-slate-900">
            Log in to Business Badhao
          </h1>
          <p className="text-sm text-slate-500">
            Enter your details to access your workspace.
          </p>
        </div>

        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          {error ? (
            <div className="mb-4">
              <Alert variant="error">{error}</Alert>
            </div>
          ) : null}
          {message === "password-updated" ? (
            <div className="mb-4">
              <Alert variant="success">Your password has been updated. Log in with your new password.</Alert>
            </div>
          ) : null}

          <form action={signIn} className="flex flex-col gap-4">
            <input type="hidden" name="redirectTo" value={redirectTo ?? "/dashboard"} />

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

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="text-sm font-medium text-slate-700">
                  Password
                </label>
                <Link href="/forgot-password" className="text-sm font-medium text-slate-500 hover:text-slate-900">
                  Forgot password?
                </Link>
              </div>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={6}
                placeholder="••••••••"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              />
            </div>

            <Button type="submit" className="mt-2 w-full">
              Log in
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-slate-500">
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="font-medium text-slate-700 hover:text-slate-900">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
