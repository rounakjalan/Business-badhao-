"use client";

import { useState } from "react";
import { DarkAlert } from "@/components/dashboard-ui/alert";
import { DashButton } from "@/components/dashboard-ui/button";
import type { OrgRole } from "@/types/database.types";

const SECTIONS = ["Account", "Organization", "AI Settings", "Notifications", "Integrations", "Security", "Danger Zone"] as const;

const MESSAGES: Record<string, string> = {
  "profile-updated": "Your profile was updated.",
  "organization-updated": "Your organization was updated.",
};

const INTEGRATIONS = [
  { name: "WhatsApp Business", desc: "Send and receive WhatsApp messages" },
  { name: "Gmail / Google Workspace", desc: "Email outreach and conversations" },
  { name: "Outlook", desc: "Microsoft email integration" },
  { name: "Google Calendar", desc: "Sync tasks and follow-up reminders" },
  { name: "Salesforce", desc: "Sync deals and contacts" },
  { name: "HubSpot", desc: "Sync contacts and pipeline" },
];

const AI_TOGGLES = [
  "Require approval before sending outbound messages",
  "Require approval before recovery attempts",
  "Auto-research discovered prospects",
  "Auto-qualify researched prospects",
];

const NOTIFICATION_TOGGLES = [
  "New qualified lead",
  "High-intent customer detected",
  "Follow-up due",
  "Deal activity",
  "Deal won",
  "Deal lost",
];

type TeamMember = { userId: string; role: OrgRole; name: string; email: string };
type GmailStatus = { connected: boolean; emailAddress: string | null };
type GmailNotice = { status: string; detail?: string } | null;

function isSection(value: string | undefined): value is (typeof SECTIONS)[number] {
  return Boolean(value) && (SECTIONS as readonly string[]).includes(value as string);
}

export function SettingsSections({
  error,
  message,
  profile,
  organization,
  teamMembers,
  updateProfileAction,
  updateOrganizationAction,
  initialTab,
  gmailStatus,
  gmailNotice,
  disconnectGmailAction,
}: {
  error?: string;
  message?: string;
  profile: { fullName: string; email: string };
  organization: { name: string; role: OrgRole; canManage: boolean };
  teamMembers: TeamMember[];
  updateProfileAction: (formData: FormData) => void;
  updateOrganizationAction: (formData: FormData) => void;
  initialTab?: string;
  gmailStatus: GmailStatus;
  gmailNotice: GmailNotice;
  disconnectGmailAction: () => void;
}) {
  const [section, setSection] = useState<(typeof SECTIONS)[number]>(isSection(initialTab) ? initialTab : "Account");

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col md:flex-row">
      <div className="bb-stagger shrink-0 border-b border-bb-border p-4 md:w-52 md:border-b-0 md:border-r">
        {SECTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`bb-stagger-item mb-0.5 w-full rounded-lg border-l-2 px-4 py-2.5 text-left text-sm font-medium transition-all ${
              section === s
                ? "border-bb-indigo bg-bb-indigo/15 text-bb-indigo-2"
                : s === "Danger Zone"
                  ? "border-transparent text-bb-rose hover:bg-bb-navy-3"
                  : "border-transparent text-bb-text-3 hover:bg-bb-navy-3"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="max-w-2xl flex-1 overflow-y-auto p-4 sm:p-8">
        {error ? (
          <div className="mb-4">
            <DarkAlert variant="error">{error}</DarkAlert>
          </div>
        ) : null}
        {message && MESSAGES[message] ? (
          <div className="mb-4">
            <DarkAlert variant="success">{MESSAGES[message]}</DarkAlert>
          </div>
        ) : null}

        {section === "Account" ? (
          <Section title="Account" desc="Your personal profile and credentials">
            <form action={updateProfileAction} className="space-y-4">
              <Field label="Full Name" name="fullName" defaultValue={profile.fullName} />
              <div>
                <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Email</label>
                <p className="rounded-lg border border-bb-border bg-bb-navy-2 px-4 py-2.5 text-sm text-bb-text-3">{profile.email}</p>
              </div>
              <DashButton type="submit" variant="gradient">
                Save Changes
              </DashButton>
            </form>
          </Section>
        ) : null}

        {section === "Organization" ? (
          <Section title="Organization" desc="Your workspace and its members">
            <form action={updateOrganizationAction} className="space-y-4">
              <Field label="Organization Name" name="name" defaultValue={organization.name} disabled={!organization.canManage} />
              <DashButton type="submit" variant="gradient" disabled={!organization.canManage}>
                Save Organization
              </DashButton>
            </form>

            <div className="mt-6">
              <h4 className="mb-3 text-sm font-semibold text-bb-text">Members</h4>
              <div className="overflow-hidden rounded-xl border border-bb-border">
                {teamMembers.map((m) => (
                  <div key={m.userId} className="flex items-center gap-3 border-b border-bb-navy-3 px-4 py-3 last:border-0">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-bb-indigo to-bb-violet text-xs font-bold text-white">
                      {m.name[0]?.toUpperCase() ?? "?"}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-bb-text">{m.name}</div>
                      <div className="text-xs text-bb-text-3">{m.email}</div>
                    </div>
                    <span className="rounded-full border border-bb-indigo/25 bg-bb-indigo/12 px-2 py-0.5 text-xs capitalize text-bb-indigo-2">{m.role}</span>
                  </div>
                ))}
              </div>
              <DashButton variant="outline" disabled title="Coming soon" className="mt-4">
                + Invite Member
              </DashButton>
            </div>
          </Section>
        ) : null}

        {section === "AI Settings" ? (
          <Section title="AI Settings" desc="Configure AI behavior and approval requirements — coming soon">
            <div className="space-y-1">
              {AI_TOGGLES.map((label) => (
                <ToggleRow key={label} label={label} />
              ))}
            </div>
            <div className="mt-6 rounded-xl border border-bb-border bg-bb-navy-2 p-4 text-sm text-bb-text-3">
              <strong className="text-bb-text-2">AI Provider:</strong> Business Badhao uses a provider-agnostic AI layer. No AI
              provider is connected yet — these settings will take effect once one is.
            </div>
          </Section>
        ) : null}

        {section === "Notifications" ? (
          <Section title="Notifications" desc="Choose what you want to be notified about — coming soon">
            <div className="space-y-1">
              {NOTIFICATION_TOGGLES.map((label) => (
                <ToggleRow key={label} label={label} />
              ))}
            </div>
          </Section>
        ) : null}

        {section === "Integrations" ? (
          <Section title="Integrations" desc="Connect external tools and services">
            {gmailNotice ? (
              <div className="mb-1">
                <DarkAlert variant={gmailNotice.status === "error" ? "error" : "success"}>
                  {gmailNotice.status === "connected"
                    ? "Gmail connected."
                    : gmailNotice.status === "disconnected"
                      ? "Gmail disconnected."
                      : (gmailNotice.detail ?? "Something went wrong connecting Gmail.")}
                </DarkAlert>
              </div>
            ) : null}
            <div className="bb-stagger space-y-3">
              {INTEGRATIONS.map((int) =>
                int.name === "Gmail / Google Workspace" ? (
                  <div key={int.name} className="bb-stagger-item flex items-center gap-4 rounded-xl border border-bb-border bg-bb-navy-2 px-5 py-4">
                    <div className="flex-1">
                      <div className="text-sm font-medium text-bb-text">{int.name}</div>
                      <div className="text-xs text-bb-text-3">
                        {gmailStatus.connected ? `Connected as ${gmailStatus.emailAddress}` : int.desc}
                      </div>
                    </div>
                    {gmailStatus.connected ? (
                      <>
                        <span className="rounded-full border border-bb-emerald/25 bg-bb-emerald/10 px-2 py-0.5 text-xs text-bb-emerald">Connected</span>
                        <form action={disconnectGmailAction}>
                          <DashButton type="submit" variant="outline">
                            Disconnect
                          </DashButton>
                        </form>
                      </>
                    ) : (
                      <>
                        <span className="rounded-full border border-bb-text-3/25 bg-bb-text-3/10 px-2 py-0.5 text-xs text-bb-text-3">Not Connected</span>
                        <a href="/api/gmail/oauth/start">
                          <DashButton type="button" variant="gradient">
                            Connect
                          </DashButton>
                        </a>
                      </>
                    )}
                  </div>
                ) : (
                  <div key={int.name} className="bb-stagger-item flex items-center gap-4 rounded-xl border border-bb-border bg-bb-navy-2 px-5 py-4">
                    <div className="flex-1">
                      <div className="text-sm font-medium text-bb-text">{int.name}</div>
                      <div className="text-xs text-bb-text-3">{int.desc}</div>
                    </div>
                    <span className="rounded-full border border-bb-text-3/25 bg-bb-text-3/10 px-2 py-0.5 text-xs text-bb-text-3">Not Connected</span>
                    <DashButton variant="outline" disabled title="Coming soon">
                      Connect
                    </DashButton>
                  </div>
                )
              )}
            </div>
          </Section>
        ) : null}

        {section === "Security" ? (
          <Section title="Security" desc="Sessions and account security">
            <div className="rounded-xl border border-bb-border bg-bb-navy-2 p-5 text-sm text-bb-text-3">
              Session management is coming soon. Your account is currently protected by Supabase Auth.
            </div>
          </Section>
        ) : null}

        {section === "Danger Zone" ? (
          <Section title="Danger Zone" desc="Irreversible destructive actions">
            <div className="mb-4 rounded-xl border border-bb-rose/20 bg-bb-rose/5 p-5">
              <div className="mb-2 text-sm font-semibold text-bb-rose">Delete Organization</div>
              <div className="mb-4 text-sm text-bb-text-2">
                Permanently deletes all campaigns, leads, conversations, deals, and data associated with this organization. This
                action cannot be undone.
              </div>
              <DashButton variant="danger" disabled title="Coming soon">
                Delete Organization
              </DashButton>
            </div>
            <div className="rounded-xl border border-bb-rose/20 bg-bb-rose/5 p-5">
              <div className="mb-2 text-sm font-semibold text-bb-rose">Delete Account</div>
              <div className="mb-4 text-sm text-bb-text-2">Permanently delete your personal account. You will be removed from all organizations.</div>
              <DashButton variant="danger" disabled title="Coming soon">
                Delete Account
              </DashButton>
            </div>
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="bb-animate-fade-in space-y-5">
      <div>
        <h2 className="font-display mb-1 text-xl font-semibold text-bb-text">{title}</h2>
        <p className="text-sm text-bb-text-3">{desc}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Field({ label, name, defaultValue, disabled }: { label: string; name: string; defaultValue: string; disabled?: boolean }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-bb-text-2">{label}</label>
      <input
        name={name}
        defaultValue={defaultValue}
        disabled={disabled}
        className="w-full rounded-lg border border-bb-border bg-bb-navy-2 px-4 py-2.5 text-sm text-bb-text outline-none focus:border-bb-indigo disabled:bg-bb-navy disabled:text-bb-text-3"
      />
    </div>
  );
}

function ToggleRow({ label }: { label: string }) {
  const [on, setOn] = useState(false);
  return (
    <div className="flex items-center justify-between border-b border-bb-navy-3 py-3 last:border-0">
      <span className="text-sm text-bb-text-2">{label}</span>
      <button
        type="button"
        onClick={() => setOn((v) => !v)}
        className={`bb-press relative h-5 w-10 shrink-0 rounded-full transition-colors duration-200 ${on ? "bg-bb-indigo" : "bg-bb-border"}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all duration-200 ease-out ${on ? "left-[22px]" : "left-0.5"}`}
        />
      </button>
    </div>
  );
}
