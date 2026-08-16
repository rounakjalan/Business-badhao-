type BadgeColor = "slate" | "blue" | "indigo" | "violet" | "amber" | "emerald" | "rose" | "sky";

const COLOR_CLASSES: Record<BadgeColor, string> = {
  slate: "bg-bb-text-3/15 text-bb-text-2 border-bb-text-3/30",
  blue: "bg-bb-sky/15 text-bb-sky border-bb-sky/30",
  indigo: "bg-bb-indigo/15 text-bb-indigo-2 border-bb-indigo/30",
  violet: "bg-bb-violet/15 text-bb-violet border-bb-violet/30",
  amber: "bg-bb-amber/15 text-bb-amber border-bb-amber/30",
  emerald: "bg-bb-emerald/15 text-bb-emerald border-bb-emerald/30",
  rose: "bg-bb-rose/15 text-bb-rose border-bb-rose/30",
  sky: "bg-bb-sky/15 text-bb-sky border-bb-sky/30",
};

export function Badge({ color = "slate", children }: { color?: BadgeColor; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${COLOR_CLASSES[color]}`}>
      {children}
    </span>
  );
}

function formatLabel(value: string) {
  return value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

const CAMPAIGN_STATUS_COLOR: Record<string, BadgeColor> = {
  draft: "slate",
  planning: "amber",
  active: "emerald",
  paused: "amber",
  completed: "indigo",
  archived: "slate",
};

const LEAD_STATUS_COLOR: Record<string, BadgeColor> = {
  new: "slate",
  contacted: "amber",
  qualified: "indigo",
  unqualified: "rose",
  converted: "emerald",
  lost: "rose",
};

const QUALIFICATION_COLOR: Record<string, BadgeColor> = {
  pending: "slate",
  qualifying: "blue",
  qualified: "emerald",
  disqualified: "rose",
};

const CONVERSATION_STATUS_COLOR: Record<string, BadgeColor> = {
  open: "indigo",
  pending: "amber",
  resolved: "emerald",
  closed: "slate",
};

const DEAL_STATUS_COLOR: Record<string, BadgeColor> = {
  open: "indigo",
  won: "emerald",
  lost: "rose",
};

const TASK_STATUS_COLOR: Record<string, BadgeColor> = {
  pending: "slate",
  in_progress: "blue",
  completed: "emerald",
  failed: "rose",
  cancelled: "slate",
};

const CHANNEL_COLOR: Record<string, BadgeColor> = {
  email: "indigo",
  sms: "amber",
  whatsapp: "emerald",
  instagram: "violet",
  linkedin: "sky",
  phone: "slate",
  web_chat: "sky",
  other: "slate",
};

function StatusBadge({ status, colorMap }: { status: string; colorMap: Record<string, BadgeColor> }) {
  return <Badge color={colorMap[status] ?? "slate"}>{formatLabel(status)}</Badge>;
}

export const CampaignStatusBadge = ({ status }: { status: string }) => <StatusBadge status={status} colorMap={CAMPAIGN_STATUS_COLOR} />;
export const LeadStatusBadge = ({ status }: { status: string }) => <StatusBadge status={status} colorMap={LEAD_STATUS_COLOR} />;
export const QualificationBadge = ({ status }: { status: string }) => <StatusBadge status={status} colorMap={QUALIFICATION_COLOR} />;
export const ConversationStatusBadge = ({ status }: { status: string }) => <StatusBadge status={status} colorMap={CONVERSATION_STATUS_COLOR} />;
export const DealStatusBadge = ({ status }: { status: string }) => <StatusBadge status={status} colorMap={DEAL_STATUS_COLOR} />;
export const TaskStatusBadge = ({ status }: { status: string }) => <StatusBadge status={status} colorMap={TASK_STATUS_COLOR} />;
export const ChannelBadge = ({ channel }: { channel: string }) => <StatusBadge status={channel} colorMap={CHANNEL_COLOR} />;

export function ScorePill({ score }: { score: number | null }) {
  if (score === null) return <span className="text-bb-text-3 text-xs font-mono">—</span>;
  const color: BadgeColor = score >= 80 ? "emerald" : score >= 60 ? "amber" : "rose";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-xs font-semibold ${COLOR_CLASSES[color]}`}>
      {score}
    </span>
  );
}
