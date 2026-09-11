const MIN_PASSWORD_LENGTH = 6;

export type PasswordValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Mirrors the `minLength={6}` already enforced on the signup page's password
 * input (src/app/signup/page.tsx) so the reset flow requires the same
 * minimum, plus the confirmation-match check a single password field can't
 * express. Checked again server-side in the reset-password Server Action
 * since client-side `minLength`/`required` can be bypassed.
 */
export function validateNewPassword(password: string, confirmPassword: string): PasswordValidationResult {
  if (!password || !confirmPassword) {
    return { ok: false, error: "Please fill in both password fields." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password !== confirmPassword) {
    return { ok: false, error: "Passwords do not match." };
  }
  return { ok: true };
}
