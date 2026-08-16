const STATUS_COLORS: Record<string, string> = {
  // neutral / not-started
  draft: "bg-slate-100 text-slate-600",
  pending: "bg-slate-100 text-slate-600",
  new: "bg-slate-100 text-slate-600",

  // in progress
  planning: "bg-blue-50 text-blue-700",
  active: "bg-blue-50 text-blue-700",
  open: "bg-blue-50 text-blue-700",
  contacted: "bg-blue-50 text-blue-700",
  qualifying: "bg-blue-50 text-blue-700",
  in_progress: "bg-blue-50 text-blue-700",

  // attention
  paused: "bg-amber-50 text-amber-700",

  // positive outcomes
  qualified: "bg-emerald-50 text-emerald-700",
  won: "bg-emerald-50 text-emerald-700",
  completed: "bg-emerald-50 text-emerald-700",
  converted: "bg-emerald-50 text-emerald-700",
  resolved: "bg-emerald-50 text-emerald-700",

  // negative outcomes
  lost: "bg-red-50 text-red-700",
  unqualified: "bg-red-50 text-red-700",
  disqualified: "bg-red-50 text-red-700",
  failed: "bg-red-50 text-red-700",
  cancelled: "bg-red-50 text-red-700",

  // closed / archived
  archived: "bg-slate-100 text-slate-500",
  closed: "bg-slate-100 text-slate-500",
};

function formatLabel(status: string) {
  return status.replaceAll("_", " ").replace(/^./, (char) => char.toUpperCase());
}

export function StatusBadge({ status }: { status: string }) {
  const colorClasses = STATUS_COLORS[status] ?? "bg-slate-100 text-slate-600";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colorClasses}`}>
      {formatLabel(status)}
    </span>
  );
}
