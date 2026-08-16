"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

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
    <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-red-200 bg-red-50 px-6 py-16 text-center">
      <h3 className="text-sm font-semibold text-red-800">Something went wrong</h3>
      <p className="mt-1.5 max-w-sm text-sm text-red-700">
        We couldn&apos;t load this page. This is usually temporary — try again in a moment.
      </p>
      <div className="mt-6">
        <Button variant="secondary" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
