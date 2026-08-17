import type { HTMLAttributes } from "react";

export function DarkCard({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`bb-shadow-card rounded-3xl bg-bb-navy-2 transition-colors ${className}`}
      {...props}
    />
  );
}
