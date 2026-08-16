"use client";

import { useEffect } from "react";
import { DashButton } from "@/components/dashboard-ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="m-6 flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-bb-rose/30 bg-bb-rose/5 px-6 py-16 text-center">
      <h3 className="text-sm font-semibold text-bb-rose">Something went wrong</h3>
      <p className="mt-1.5 max-w-sm text-sm text-bb-text-2">
        We couldn&apos;t load this page. This is usually temporary — try again in a moment.
      </p>
      <div className="mt-6">
        <DashButton variant="outline" onClick={reset}>
          Try again
        </DashButton>
      </div>
    </div>
  );
}
