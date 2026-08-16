import type { ReactNode } from "react";

type AlertVariant = "error" | "success" | "info";

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  error: "border-bb-rose/30 bg-bb-rose/10 text-bb-rose",
  success: "border-bb-emerald/30 bg-bb-emerald/10 text-bb-emerald",
  info: "border-bb-border bg-bb-navy-3 text-bb-text-2",
};

export function DarkAlert({ variant = "info", children }: { variant?: AlertVariant; children: ReactNode }) {
  return (
    <div className={`rounded-lg border px-3.5 py-2.5 text-sm ${VARIANT_CLASSES[variant]}`} role={variant === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
