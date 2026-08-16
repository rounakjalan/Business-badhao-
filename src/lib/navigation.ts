import type { ComponentType } from "react";
import {
  AnalyticsIcon,
  CampaignsIcon,
  ConversationsIcon,
  DashboardIcon,
  DealsIcon,
  type IconProps,
  KnowledgeIcon,
  LeadsIcon,
  SettingsIcon,
} from "@/components/ui/icons";

export type NavItem = {
  label: string;
  href: string;
  description: string;
  icon: ComponentType<IconProps>;
};

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", description: "Overview of your account", icon: DashboardIcon },
  { label: "Campaigns", href: "/campaigns", description: "Outreach campaigns", icon: CampaignsIcon },
  { label: "Leads", href: "/leads", description: "Prospects and contacts", icon: LeadsIcon },
  { label: "Conversations", href: "/conversations", description: "Messages with leads", icon: ConversationsIcon },
  { label: "Deals", href: "/deals", description: "Pipeline and deal tracking", icon: DealsIcon },
  { label: "Analytics", href: "/analytics", description: "Performance insights", icon: AnalyticsIcon },
  { label: "Knowledge", href: "/knowledge", description: "Knowledge base", icon: KnowledgeIcon },
  { label: "Settings", href: "/settings", description: "Account and workspace settings", icon: SettingsIcon },
];
