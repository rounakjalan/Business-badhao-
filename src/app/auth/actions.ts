"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSiteUrl } from "@/lib/site-url";
import { validateNewPassword } from "@/lib/password";

function safeRedirectPath(path: FormDataEntryValue | null): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    return "/dashboard";
  }
  return path;
}

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const redirectTo = safeRedirectPath(formData.get("redirectTo"));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}&redirectTo=${encodeURIComponent(redirectTo)}`);
  }

  redirect(redirectTo);
}

export async function signUp(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const fullName = String(formData.get("fullName") ?? "");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
      // Without this, Supabase builds the confirmation link from the
      // project's dashboard-configured Site URL instead of wherever this
      // is actually deployed — see src/lib/site-url.ts.
      emailRedirectTo: `${getSiteUrl()}/auth/callback`,
    },
  });

  if (error) {
    redirect(`/signup?error=${encodeURIComponent(error.message)}`);
  }

  // If email confirmation is required, Supabase returns a user but no
  // session yet — send the user to check their inbox instead of onboarding.
  if (!data.session) {
    redirect("/signup?message=check-email");
  }

  redirect("/onboarding");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

// Always redirects to the same "check your email" state, whether or not the
// address belongs to an account. Supabase's own resetPasswordForEmail API
// already avoids confirming/denying an account's existence (it returns
// success either way), but this keeps that guarantee even if the call
// itself fails (rate limiting, a transient Auth error, etc.) — those are
// logged server-side instead of surfaced, so nothing about an error ever
// leaks whether the email is registered.
export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();

  if (!email) {
    redirect(`/forgot-password?error=${encodeURIComponent("Please enter your email address.")}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    // Reuses the existing generic code-exchange route (src/app/auth/callback/route.ts)
    // unmodified — it already supports redirecting anywhere via ?next=.
    redirectTo: `${getSiteUrl()}/auth/callback?next=/reset-password`,
  });

  if (error) {
    console.error("requestPasswordReset: resetPasswordForEmail failed", error.message);
  }

  redirect("/forgot-password?message=check-email");
}

// Requires an authenticated recovery session, established by following the
// emailed reset link through /auth/callback. Supabase Auth remains fully
// responsible for password storage/hashing via updateUser; this app never
// sees or stores the password anywhere else.
export async function updatePassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  const validation = validateNewPassword(password, confirmPassword);
  if (!validation.ok) {
    redirect(`/reset-password?error=${encodeURIComponent(validation.error)}`);
  }

  const supabase = await createClient();

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect(
      `/reset-password?error=${encodeURIComponent("That reset link is invalid or has expired. Please request a new one.")}`
    );
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    redirect(`/reset-password?error=${encodeURIComponent(error.message)}`);
  }

  // Sign out the recovery session so the user logs in fresh with the new
  // password, rather than silently landing in the dashboard on a session
  // that started as a password-recovery link.
  await supabase.auth.signOut();
  redirect("/login?message=password-updated");
}
