import type { ComponentType, ReactNode } from "react";
import type { IconProps } from "@/components/ui/icons";

type DarkEmptyStateProps = {
  icon: ComponentType<IconProps>;
  title: string;
  description: string;
  action?: ReactNode;
};

export function DarkEmptyState({ icon: Icon, title, description, action }: DarkEmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-bb-border bg-bb-navy-2 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bb-navy-3 text-bb-text-3">
        <Icon className="h-6 w-6" />
      </div>
      <h3 className="font-display mt-4 text-sm font-semibold text-bb-text">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-bb-text-3">{description}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
