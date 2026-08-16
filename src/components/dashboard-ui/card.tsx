import type { HTMLAttributes } from "react";

export function DarkCard({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-xl border border-bb-border bg-bb-navy-2 transition-colors ${className}`}
      {...props}
    />
  );
}
