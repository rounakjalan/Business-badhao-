import type { ComponentType } from "react";
import {
  AnalyticsIcon,
  BuyingIntentIcon,
  CampaignsIcon,
  ConversationsIcon,
  DashboardIcon,
  DealsIcon,
  type IconProps,
  KnowledgeIcon,
  LeadsIcon,
  ProspectsIcon,
  SettingsIcon,
  TasksIcon,
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
  { label: "Leads", href: "/leads", description: "Qualified prospects ready for outreach", icon: LeadsIcon },
  { label: "Prospects", href: "/prospects", description: "Discovered contacts being researched", icon: ProspectsIcon },
  { label: "Conversations", href: "/conversations", description: "Messages with leads", icon: ConversationsIcon },
  { label: "Buying Intent", href: "/buying-intent", description: "Leads by AI-detected buying intent", icon: BuyingIntentIcon },
  { label: "Deals", href: "/deals", description: "Pipeline and deal tracking", icon: DealsIcon },
  { label: "Analytics", href: "/analytics", description: "Performance insights", icon: AnalyticsIcon },
  { label: "Knowledge", href: "/knowledge", description: "Knowledge base", icon: KnowledgeIcon },
  { label: "Tasks", href: "/tasks", description: "To-dos and follow-ups", icon: TasksIcon },
  { label: "Settings", href: "/settings", description: "Account and workspace settings", icon: SettingsIcon },
];
