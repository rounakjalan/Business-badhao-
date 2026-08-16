import type { ReactNode } from "react";

type AlertVariant = "error" | "success" | "info";

const variantClasses: Record<AlertVariant, string> = {
  error: "border-red-200 bg-red-50 text-red-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  info: "border-slate-200 bg-slate-50 text-slate-700",
};

export function Alert({ variant = "info", children }: { variant?: AlertVariant; children: ReactNode }) {
  return (
    <div className={`rounded-lg border px-3.5 py-2.5 text-sm ${variantClasses[variant]}`} role={variant === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
