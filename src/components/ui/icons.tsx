import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement>;

const base = {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function DashboardIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

export function CampaignsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 11v2a2 2 0 0 0 2 2h1l2 6h2l-1.5-6H10l8 4V5l-8 4H5a2 2 0 0 0-2 2Z" />
      <path d="M18 9v6" />
    </svg>
  );
}

export function LeadsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <circle cx="17.5" cy="9" r="2.5" />
      <path d="M15.75 20a4 4 0 0 1 6.5-3.1" />
    </svg>
  );
}

export function ConversationsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M21 12a7 7 0 0 1-7 7H8l-4 3 1-4.5A7 7 0 1 1 21 12Z" />
    </svg>
  );
}

export function DealsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 15.5c.6.6 1.5 1 2.5 1s1.9-.4 2.5-1M12 7v1.5M12 15.5V17" />
      <path d="M9 9.5h3.5a1.5 1.5 0 0 1 0 3H10a1.5 1.5 0 0 0 0 3h4" />
    </svg>
  );
}

export function BuyingIntentIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3c2.5 2.5 4 5 4 7.5a4 4 0 0 1-8 0c0-.9.3-1.8.8-2.7-.6.4-1.1 1-1.5 1.7A6 6 0 0 0 12 21a6 6 0 0 0 4.5-10 12 12 0 0 0-4.5-8Z" />
    </svg>
  );
}

export function AnalyticsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 20V10M12 20V4M20 20v-7" />
      <path d="M2 20h20" />
    </svg>
  );
}

export function KnowledgeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5A1.5 1.5 0 0 1 18.5 20H6.5A2.5 2.5 0 0 1 4 17.5Z" />
      <path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export function ProspectsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="9" r="3" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M12 2v1.5M12 16.5V18M4.5 9H3M21 9h-1.5M6.2 4.2l1 1M17.8 4.2l-1 1" />
    </svg>
  );
}

export function TasksIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="m8 12 2.5 2.5L16 9" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export function SparklesIcon(props: IconProps) {
  return (
    <svg {...base} fill="currentColor" stroke="none" {...props}>
      <path d="M12 2.5c.3 3 1.2 4.9 2.8 6.5s3.5 2.5 6.5 2.8c.3 0 .3.4 0 .4-3 .3-4.9 1.2-6.5 2.8s-2.5 3.5-2.8 6.5c0 .3-.4.3-.4 0-.3-3-1.2-4.9-2.8-6.5S6.3 12.8 3.3 12.5c-.3 0-.3-.4 0-.4 3-.3 4.9-1.2 6.5-2.8S12.3 5.8 12.6 2.5c0-.3.4-.3.4 0Z" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function LogoMark(props: IconProps) {
  return (
    <svg {...base} fill="none" {...props}>
      <rect x="2" y="2" width="20" height="20" rx="6" fill="#0f172a" stroke="none" />
      <path d="M8 15.5V8.5h3.2a2.2 2.2 0 0 1 1.1 4.1 2.4 2.4 0 0 1-1 4.4H8Z" stroke="#ffffff" strokeWidth="1.5" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
