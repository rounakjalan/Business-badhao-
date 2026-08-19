"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { createCampaign, generateCampaignPlan, generateIcp } from "@/app/(dashboard)/campaigns/actions";
import type { CampaignPlan } from "@/lib/ai/agents/campaign-planner";
import type { Icp } from "@/lib/ai/agents/icp-schema";
import { DarkAlert } from "@/components/dashboard-ui/alert";
import { DashButton } from "@/components/dashboard-ui/button";
import { SparklesIcon } from "@/components/ui/icons";

const STEPS = ["Campaign Basics", "AI Planner", "Target Customer (ICP)", "Review & Launch"];
const OBJECTIVES = [
  "Get more customers",
  "Generate qualified leads",
  "Fill appointments",
  "Increase admissions",
  "Promote a product",
  "Enter a new market",
];

function planSections(plan: CampaignPlan) {
  return [
    { title: "Target Market", val: plan.targetMarket },
    { title: "Customer Profile", val: plan.customerProfile },
    { title: "Ideal Customer Characteristics", val: plan.idealCustomerCharacteristics.join(", ") },
    { title: "Buying Signals", val: plan.buyingSignals.join(", ") },
    { title: "Pain Points", val: plan.painPoints.join(", ") },
    { title: "Value Proposition", val: plan.valueProposition },
    { title: "Suggested Channels", val: plan.suggestedChannels.join(", ") },
    { title: "Campaign Strategy", val: plan.campaignStrategy },
    { title: "Qualification Criteria", val: plan.qualificationCriteria.join(", ") },
    { title: "Outreach Strategy", val: plan.outreachStrategy },
    { title: "Follow-up Strategy", val: plan.followUpStrategy },
  ];
}

const ICP_TEXT_FIELDS: { key: keyof Icp; label: string; placeholder: string }[] = [
  { key: "targetCustomer", label: "Target Customer / Persona", placeholder: "Who is this business trying to reach?" },
  { key: "ageRange", label: "Age Range (if relevant)", placeholder: "e.g. 30-55, or leave blank if not relevant" },
  { key: "location", label: "Location / Service Area", placeholder: "e.g. Delhi NCR" },
  { key: "industry", label: "Industry / Category", placeholder: "e.g. Retail electronics" },
  { key: "businessType", label: "Company / Business Type (if relevant)", placeholder: "e.g. Single-location physical store" },
  { key: "budgetRange", label: "Income / Budget / Purchasing Capacity (if relevant)", placeholder: "e.g. ₹5,000-₹20,000/month" },
];

const ICP_LIST_FIELDS: { key: keyof Icp; label: string }[] = [
  { key: "needs", label: "Needs" },
  { key: "painPoints", label: "Pain Points" },
  { key: "buyingSignals", label: "Buying Signals" },
  { key: "decisionFactors", label: "Decision-Making Factors" },
  { key: "disqualifiers", label: "Disqualifiers" },
  { key: "preferredChannels", label: "Preferred Channels" },
  { key: "qualificationCriteria", label: "Qualification Criteria" },
];

function inputClass() {
  return "w-full rounded-lg border border-bb-border bg-bb-navy px-4 py-2.5 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo";
}

export function CampaignCreateWizard({ error }: { error?: string }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState(OBJECTIVES[0]);
  const [description, setDescription] = useState("");
  const [customerType, setCustomerType] = useState("");
  const [location, setLocation] = useState("");
  const [generating, startGenerating] = useTransition();
  const [plan, setPlan] = useState<CampaignPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [generatingIcp, startGeneratingIcp] = useTransition();
  const [icp, setIcp] = useState<Icp | null>(null);
  const [icpError, setIcpError] = useState<string | null>(null);

  const targetAudience = [customerType, location].filter(Boolean).join(" · ");

  const generatePlan = () => {
    setPlanError(null);
    startGenerating(async () => {
      const result = await generateCampaignPlan({ name, objective, description, customerType, location });
      if (result.ok) {
        setPlan(result.plan);
        setIcp(null); // a regenerated plan invalidates any ICP already generated from the old one
      } else {
        setPlanError(result.message);
      }
    });
  };

  const generateIcpFromPlan = () => {
    if (!plan) return;
    setIcpError(null);
    startGeneratingIcp(async () => {
      const result = await generateIcp({ name, objective, description, plan });
      if (result.ok) {
        setIcp(result.icp);
      } else {
        setIcpError(result.message);
      }
    });
  };

  const updateIcpText = (key: keyof Icp, value: string) => {
    setIcp((prev) => (prev ? { ...prev, [key]: value || null } : prev));
  };

  const updateIcpList = (key: keyof Icp, value: string) => {
    setIcp((prev) => (prev ? { ...prev, [key]: value.split("\n") } : prev));
  };

  const icpForSubmit = icp
    ? {
        ...icp,
        needs: icp.needs.map((s) => s.trim()).filter(Boolean),
        painPoints: icp.painPoints.map((s) => s.trim()).filter(Boolean),
        buyingSignals: icp.buyingSignals.map((s) => s.trim()).filter(Boolean),
        decisionFactors: icp.decisionFactors.map((s) => s.trim()).filter(Boolean),
        disqualifiers: icp.disqualifiers.map((s) => s.trim()).filter(Boolean),
        preferredChannels: icp.preferredChannels.map((s) => s.trim()).filter(Boolean),
        qualificationCriteria: icp.qualificationCriteria.map((s) => s.trim()).filter(Boolean),
      }
    : null;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-6 flex items-center gap-3 text-sm">
        <Link href="/campaigns" className="text-bb-text-3 hover:text-bb-text">
          ← Campaigns
        </Link>
        <span className="text-bb-border">/</span>
        <span className="text-bb-text">Create Campaign</span>
      </div>

      {error ? (
        <div className="mb-4">
          <DarkAlert variant="error">{error}</DarkAlert>
        </div>
      ) : null}

      <div className="mb-8 flex flex-wrap gap-2">
        {STEPS.map((s, i) => (
          <button
            key={s}
            type="button"
            onClick={() => setStep(i)}
            className={`bb-press flex-1 rounded-lg border py-2 text-center text-xs font-medium transition-all ${
              i === step
                ? "border-bb-indigo bg-bb-indigo/20 text-bb-indigo-2"
                : i < step
                  ? "border-bb-emerald/40 bg-bb-emerald/10 text-bb-emerald"
                  : "border-bb-border bg-bb-navy-3 text-bb-text-3"
            }`}
          >
            {i < step ? "✓ " : ""}
            {s}
          </button>
        ))}
      </div>

      {step === 0 ? (
        <div className="bb-animate-fade-in space-y-5 rounded-xl border border-bb-border bg-bb-navy-2 p-6">
          <h3 className="font-display text-lg font-semibold text-bb-text">Campaign Basics</h3>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Campaign Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 2025 Student Admissions Drive"
              className={inputClass()}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Objective</label>
            <select value={objective} onChange={(e) => setObjective(e.target.value)} className={inputClass()}>
              {OBJECTIVES.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Description (optional)</label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={`${inputClass()} resize-none`}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Customer Type (optional)</label>
              <input
                value={customerType}
                onChange={(e) => setCustomerType(e.target.value)}
                placeholder="e.g. Parents of school-age children"
                className={inputClass()}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Location (optional)</label>
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. Delhi, Gurugram, Noida"
                className={inputClass()}
              />
            </div>
          </div>
          <p className="text-xs text-bb-text-3">These feed the AI planner and ICP steps next — rough guesses are fine.</p>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="bb-animate-fade-in space-y-5 rounded-xl border border-bb-border bg-bb-navy-2 p-6">
          <h3 className="font-display text-lg font-semibold text-bb-text">AI Campaign Planner</h3>
          <p className="text-sm text-bb-text-3">
            Generates a real plan from Hermes based on the basics you entered. The next step (Target Customer) builds
            your Ideal Customer Profile from this plan.
          </p>
          {planError ? <DarkAlert variant="error">{planError}</DarkAlert> : null}
          {!plan ? (
            <DashButton variant="gradient" onClick={generatePlan} disabled={generating}>
              {generating ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Generating plan...
                </>
              ) : (
                <>
                  <SparklesIcon className="h-3.5 w-3.5" /> Generate AI Plan
                </>
              )}
            </DashButton>
          ) : (
            <div className="bb-stagger space-y-3">
              {planSections(plan).map((s) => (
                <div key={s.title} className="bb-stagger-item rounded-lg border border-bb-border bg-bb-navy p-4">
                  <div className="mb-1 text-xs font-medium text-bb-indigo-2">{s.title}</div>
                  <div className="text-sm text-bb-text-2">{s.val}</div>
                </div>
              ))}
              <div className="flex gap-3">
                <DashButton variant="ghost" onClick={generatePlan} disabled={generating}>
                  Regenerate
                </DashButton>
                <DashButton
                  variant="ghost"
                  onClick={() => {
                    setPlan(null);
                    setIcp(null);
                  }}
                >
                  Discard
                </DashButton>
              </div>
              <p className="text-xs text-bb-text-3">This plan will be used to build the Target Customer step next.</p>
            </div>
          )}
        </div>
      ) : null}

      {step === 2 ? (
        <div className="bb-animate-fade-in space-y-5 rounded-xl border border-bb-border bg-bb-navy-2 p-6">
          <h3 className="font-display text-lg font-semibold text-bb-text">Target Customer (ICP)</h3>
          {!plan ? (
            <div className="space-y-3">
              <p className="text-sm text-bb-text-3">
                Generate an AI campaign plan first — the Ideal Customer Profile is built from it.
              </p>
              <DashButton variant="ghost" onClick={() => setStep(1)}>
                ← Go to AI Planner
              </DashButton>
            </div>
          ) : (
            <>
              <p className="text-sm text-bb-text-3">
                Generates a structured, editable Ideal Customer Profile from your campaign plan. Review and adjust
                anything below before continuing.
              </p>
              {icpError ? <DarkAlert variant="error">{icpError}</DarkAlert> : null}
              {!icp ? (
                <DashButton variant="gradient" onClick={generateIcpFromPlan} disabled={generatingIcp}>
                  {generatingIcp ? (
                    <>
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      Generating ICP...
                    </>
                  ) : (
                    <>
                      <SparklesIcon className="h-3.5 w-3.5" /> Generate ICP
                    </>
                  )}
                </DashButton>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {ICP_TEXT_FIELDS.map((f) => (
                      <div key={f.key}>
                        <label className="mb-1.5 block text-xs font-medium text-bb-text-2">{f.label}</label>
                        <input
                          value={(icp[f.key] as string | null) ?? ""}
                          onChange={(e) => updateIcpText(f.key, e.target.value)}
                          placeholder={f.placeholder}
                          className={inputClass()}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {ICP_LIST_FIELDS.map((f) => (
                      <div key={f.key}>
                        <label className="mb-1.5 block text-xs font-medium text-bb-text-2">{f.label} (one per line)</label>
                        <textarea
                          rows={3}
                          value={(icp[f.key] as string[]).join("\n")}
                          onChange={(e) => updateIcpList(f.key, e.target.value)}
                          className={`${inputClass()} resize-none`}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-3">
                    <DashButton variant="ghost" onClick={generateIcpFromPlan} disabled={generatingIcp}>
                      Regenerate
                    </DashButton>
                    <DashButton variant="ghost" onClick={() => setIcp(null)}>
                      Discard
                    </DashButton>
                  </div>
                  <p className="text-xs text-bb-text-3">This ICP will be saved and linked to the campaign when you launch.</p>
                </div>
              )}
            </>
          )}
        </div>
      ) : null}

      {step === 3 ? (
        <div className="bb-animate-fade-in space-y-4 rounded-xl border border-bb-border bg-bb-navy-2 p-6 text-center">
          <h3 className="font-display text-xl font-semibold text-bb-text">Ready to launch</h3>
          <p className="text-sm text-bb-text-3">Review your campaign below, then save it as a draft or launch it now.</p>
          <div className="rounded-xl border border-bb-border bg-bb-navy p-4 text-left text-sm">
            <Row label="Name" val={name || "—"} />
            <Row label="Objective" val={objective} />
            <Row label="Target Audience" val={targetAudience || "—"} />
            <Row label="ICP" val={icp ? icp.targetCustomer : "Not generated"} />
          </div>
          <form action={createCampaign} className="flex justify-center gap-3">
            <input type="hidden" name="name" value={name} />
            <input type="hidden" name="objective" value={objective} />
            <input type="hidden" name="description" value={description} />
            <input type="hidden" name="targetAudience" value={targetAudience} />
            <input type="hidden" name="icp" value={icpForSubmit ? JSON.stringify(icpForSubmit) : ""} />
            <input type="hidden" name="launch" value="false" />
            <DashButton type="submit" variant="ghost">
              Save as Draft
            </DashButton>
          </form>
          <form action={createCampaign} className="flex justify-center gap-3">
            <input type="hidden" name="name" value={name} />
            <input type="hidden" name="objective" value={objective} />
            <input type="hidden" name="description" value={description} />
            <input type="hidden" name="targetAudience" value={targetAudience} />
            <input type="hidden" name="icp" value={icpForSubmit ? JSON.stringify(icpForSubmit) : ""} />
            <input type="hidden" name="launch" value="true" />
            <DashButton type="submit" variant="gradient" disabled={!name.trim()}>
              Launch Campaign 🚀
            </DashButton>
          </form>
        </div>
      ) : null}

      <div className="mt-6 flex items-center justify-between">
        <DashButton variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} className={step === 0 ? "invisible" : ""}>
          ← Back
        </DashButton>
        {step < 3 ? (
          <DashButton variant="gradient" onClick={() => setStep((s) => s + 1)} disabled={step === 0 && !name.trim()}>
            Continue →
          </DashButton>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}

function Row({ label, val }: { label: string; val: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-bb-text-3">{label}</span>
      <span className="text-bb-text-2">{val}</span>
    </div>
  );
}
