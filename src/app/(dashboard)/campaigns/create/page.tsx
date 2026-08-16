import { CampaignCreateWizard } from "@/app/(dashboard)/campaigns/create/campaign-create-wizard";

export default async function CampaignCreatePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col p-4 sm:p-6">
      <CampaignCreateWizard error={error} />
    </div>
  );
}
