import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";

const SETTINGS_SECTIONS = [
  {
    title: "Organization",
    description: "Workspace name, industry and business details.",
  },
  {
    title: "Members",
    description: "Invite teammates and manage their access.",
  },
  {
    title: "Billing",
    description: "Plan, usage and payment details.",
  },
  {
    title: "Integrations",
    description: "Connect the tools your business already uses.",
  },
];

export default function SettingsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Manage your workspace, team and account preferences."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {SETTINGS_SECTIONS.map((section) => (
          <Card key={section.title} className="p-5">
            <h3 className="text-sm font-semibold text-slate-900">{section.title}</h3>
            <p className="mt-1 text-sm text-slate-500">{section.description}</p>
            <p className="mt-4 text-xs font-medium text-slate-400">Coming soon</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
