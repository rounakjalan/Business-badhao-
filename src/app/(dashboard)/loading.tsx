export default function DashboardLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="h-6 w-40 animate-pulse rounded bg-slate-200" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {["leads", "conversations", "deals", "won"].map((key) => (
          <div key={key} className="h-24 animate-pulse rounded-xl border border-slate-200 bg-slate-100" />
        ))}
      </div>
      <div className="h-64 flex-1 animate-pulse rounded-xl border border-dashed border-slate-300 bg-slate-100" />
    </div>
  );
}
