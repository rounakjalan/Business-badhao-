type BadgeColor = "slate" | "blue" | "indigo" | "violet" | "amber" | "emerald" | "rose" | "sky";

// Pastel pill pairs from the Command Center design handoff — bg/text aren't
// opacity-derived from one hue, so each pair is spelled out explicitly.
const COLOR_CLASSES: Record<BadgeColor, string> = {
  slate: "bg-[#f0f0f0] text-[#535768]",
  blue: "bg-[#abf0ff] text-[#0e7a9e]",
  indigo: "bg-[#e7ecff] text-bb-indigo",
  violet: "bg-[#eddff7] text-bb-violet",
  amber: "bg-[#ffe8d4] text-bb-amber",
  emerald: "bg-[#d9fbc4] text-bb-emerald",
  rose: "bg-[#ffe0e8] text-bb-rose",
  sky: "bg-[#d1faff] text-bb-sky",
};

export function Badge({ color = "slate", children }: { color?: BadgeColor; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${COLOR_CLASSES[color]}`}>
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
  new: "indigo",
  qualified: "sky",
  proposal: "amber",
  payment_pending: "violet",
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

const OWNER_COLOR: Record<string, BadgeColor> = {
  ai: "violet",
  human: "amber",
};

const OWNER_LABEL: Record<string, string> = {
  ai: "AI-controlled",
  human: "Human-controlled",
};

const BUYING_INTENT_COLOR: Record<string, BadgeColor> = {
  low: "slate",
  medium: "amber",
  high: "emerald",
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
export const OwnerBadge = ({ owner }: { owner: string }) => <Badge color={OWNER_COLOR[owner] ?? "slate"}>{OWNER_LABEL[owner] ?? formatLabel(owner)}</Badge>;
export const BuyingIntentBadge = ({ intent }: { intent: string }) => <Badge color={BUYING_INTENT_COLOR[intent] ?? "slate"}>{formatLabel(intent)} intent</Badge>;

export function ScorePill({ score }: { score: number | null }) {
  if (score === null) return <span className="text-bb-text-3 text-xs font-mono">—</span>;
  const color: BadgeColor = score >= 80 ? "emerald" : score >= 60 ? "amber" : "rose";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-xs font-semibold ${COLOR_CLASSES[color]}`}>
      {score}
    </span>
  );
}
