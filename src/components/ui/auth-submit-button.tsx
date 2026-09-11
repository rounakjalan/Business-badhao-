"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/**
 * Same rationale as WizardSubmitButton (campaign-create-wizard.tsx): derives
 * pending state from useFormStatus() rather than local state, so the button
 * only disables once the submit is actually in flight instead of racing the
 * browser's own form submission.
 */
export function AuthSubmitButton({ idleLabel, pendingLabel }: { idleLabel: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" className="mt-2 w-full" disabled={pending}>
      {pending ? pendingLabel : idleLabel}
    </Button>
  );
}
