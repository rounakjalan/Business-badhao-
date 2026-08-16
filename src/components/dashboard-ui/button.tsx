import type { ButtonHTMLAttributes } from "react";

type Variant = "gradient" | "outline" | "ghost" | "danger";

const VARIANT_CLASSES: Record<Variant, string> = {
  gradient: "bg-gradient-to-br from-bb-indigo to-bb-violet text-white hover:opacity-90",
  outline: "bg-bb-indigo/10 text-bb-indigo-2 border border-bb-indigo/30 hover:bg-bb-indigo/15",
  ghost: "border border-bb-border text-bb-text-2 hover:bg-white/5",
  danger: "bg-bb-rose/10 text-bb-rose border border-bb-rose/30 hover:bg-bb-rose/15",
};

type DashButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
};

export function DashButton({ variant = "ghost", className = "", ...props }: DashButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40 ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
}
