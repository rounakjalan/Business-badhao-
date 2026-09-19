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
  { name: "Instagram", desc: "Verify a discovered lead's Instagram profile" },
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
type WhatsAppStatus = { connected: boolean; displayPhoneNumber: string | null; templateName: string | null; templateLanguage: string };
type WhatsAppNotice = { status: string; detail?: string } | null;
type InstagramStatus = { connected: boolean; username: string | null };
type InstagramNotice = { status: string; detail?: string } | null;
type InstagramDiscoveryConnectionStatus =
  | "not_connected"
  | "authentication_required"
  | "connecting"
  | "connected"
  | "session_expired"
  | "browser_unavailable"
  | "ready"
  | "error";
type InstagramDiscoveryStatus = { status: InstagramDiscoveryConnectionStatus; connectedUsername: string | null; lastError: string | null };
type InstagramDiscoveryNotice = { status: string; detail?: string } | null;

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
  whatsappStatus,
  whatsappNotice,
  connectWhatsAppAction,
  disconnectWhatsAppAction,
  updateWhatsAppTemplateAction,
  instagramStatus,
  instagramNotice,
  disconnectInstagramAction,
  instagramDiscoveryStatus,
  instagramDiscoveryRuntimeConfigured,
  instagramDiscoveryOrganizationId,
  instagramDiscoveryNotice,
  requestInstagramDiscoveryConnectionAction,
  disconnectInstagramDiscoveryConnectionAction,
  testInstagramDiscoveryConnectionAction,
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
  whatsappStatus: WhatsAppStatus;
  whatsappNotice: WhatsAppNotice;
  connectWhatsAppAction: (formData: FormData) => void;
  disconnectWhatsAppAction: () => void;
  updateWhatsAppTemplateAction: (formData: FormData) => void;
  instagramStatus: InstagramStatus;
  instagramNotice: InstagramNotice;
  disconnectInstagramAction: () => void;
  instagramDiscoveryStatus: InstagramDiscoveryStatus;
  instagramDiscoveryRuntimeConfigured: boolean;
  instagramDiscoveryOrganizationId: string;
  instagramDiscoveryNotice: InstagramDiscoveryNotice;
  requestInstagramDiscoveryConnectionAction: () => void;
  disconnectInstagramDiscoveryConnectionAction: () => void;
  testInstagramDiscoveryConnectionAction: () => void;
}) {
  const [section, setSection] = useState<(typeof SECTIONS)[number]>(isSection(initialTab) ? initialTab : "Account");
  const [showWhatsAppForm, setShowWhatsAppForm] = useState(false);

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
            {whatsappNotice ? (
              <div className="mb-1">
                <DarkAlert variant={whatsappNotice.status === "error" ? "error" : "success"}>
                  {whatsappNotice.status === "connected"
                    ? "WhatsApp connected."
                    : whatsappNotice.status === "disconnected"
                      ? "WhatsApp disconnected."
                      : whatsappNotice.status === "template_saved"
                        ? "WhatsApp template saved."
                        : (whatsappNotice.detail ?? "Something went wrong connecting WhatsApp.")}
                </DarkAlert>
              </div>
            ) : null}
            {instagramNotice ? (
              <div className="mb-1">
                <DarkAlert variant={instagramNotice.status === "error" ? "error" : "success"}>
                  {instagramNotice.status === "connected"
                    ? "Instagram connected."
                    : instagramNotice.status === "disconnected"
                      ? "Instagram disconnected."
                      : (instagramNotice.detail ?? "Something went wrong connecting Instagram.")}
                </DarkAlert>
              </div>
            ) : null}
            {instagramDiscoveryNotice ? (
              <div className="mb-1">
                <DarkAlert variant={instagramDiscoveryNotice.status === "error" ? "error" : "success"}>
                  {instagramDiscoveryNotice.status === "requested"
                    ? "Instagram discovery connection requested — see status below."
                    : instagramDiscoveryNotice.status === "disconnected"
                      ? "Instagram discovery connection removed."
                      : (instagramDiscoveryNotice.detail ?? "Something went wrong requesting the Instagram discovery connection.")}
                </DarkAlert>
              </div>
            ) : null}
            <div className="bb-stagger space-y-3">
              {INTEGRATIONS.map((int) =>
                int.name === "WhatsApp Business" ? (
                  <div key={int.name} className="bb-stagger-item rounded-xl border border-bb-border bg-bb-navy-2 px-5 py-4">
                    <div className="flex items-center gap-4">
                      <div className="flex-1">
                        <div className="text-sm font-medium text-bb-text">{int.name}</div>
                        <div className="text-xs text-bb-text-3">
                          {whatsappStatus.connected ? `Connected — ${whatsappStatus.displayPhoneNumber}` : int.desc}
                        </div>
                      </div>
                      {whatsappStatus.connected ? (
                        <>
                          <span className="rounded-full border border-bb-emerald/25 bg-bb-emerald/10 px-2 py-0.5 text-xs text-bb-emerald">Connected</span>
                          <form action={disconnectWhatsAppAction}>
                            <DashButton type="submit" variant="outline">
                              Disconnect
                            </DashButton>
                          </form>
                        </>
                      ) : (
                        <>
                          <span className="rounded-full border border-bb-text-3/25 bg-bb-text-3/10 px-2 py-0.5 text-xs text-bb-text-3">Not Connected</span>
                          <DashButton type="button" variant="gradient" onClick={() => setShowWhatsAppForm((v) => !v)}>
                            Connect
                          </DashButton>
                        </>
                      )}
                    </div>
                    {!whatsappStatus.connected && showWhatsAppForm ? (
                      <form action={connectWhatsAppAction} className="mt-4 space-y-3 border-t border-bb-border pt-4">
                        <p className="text-xs text-bb-text-3">
                          Get these from your Meta Business Manager WhatsApp Business API setup — this is a permanent System User
                          access token, not an OAuth login, so there is nothing to redirect to.
                        </p>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Phone Number ID</label>
                          <input
                            name="phoneNumberId"
                            required
                            className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Access Token</label>
                          <input
                            name="accessToken"
                            type="password"
                            required
                            className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Display Phone Number (optional)</label>
                          <input
                            name="displayPhoneNumber"
                            placeholder="e.g. +91 98765 43210"
                            className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                          />
                        </div>
                        <p className="text-xs text-bb-text-3">
                          Optional: an already Meta-approved message template name, for automatic outreach to a lead who has
                          never messaged you before. WhatsApp requires one for any first message — without it, WhatsApp only
                          continues conversations leads already started. You can add this later from here too.
                        </p>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Approved Template Name (optional)</label>
                          <input
                            name="templateName"
                            placeholder="e.g. first_outreach"
                            className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Template Language Code</label>
                          <input
                            name="templateLanguage"
                            placeholder="en_US"
                            defaultValue="en_US"
                            className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                          />
                        </div>
                        <DashButton type="submit" variant="gradient">
                          Save Connection
                        </DashButton>
                      </form>
                    ) : null}
                    {whatsappStatus.connected ? (
                      <form action={updateWhatsAppTemplateAction} className="mt-4 space-y-3 border-t border-bb-border pt-4">
                        <p className="text-xs text-bb-text-3">
                          {whatsappStatus.templateName
                            ? `Automatic WhatsApp outreach to new leads uses the "${whatsappStatus.templateName}" template (${whatsappStatus.templateLanguage}).`
                            : "No approved template configured yet — automatic WhatsApp outreach to a lead who hasn't messaged you is unavailable until one is set. Replies to leads who message you first are unaffected."}
                        </p>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Approved Template Name</label>
                          <input
                            name="templateName"
                            defaultValue={whatsappStatus.templateName ?? ""}
                            placeholder="e.g. first_outreach"
                            className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Template Language Code</label>
                          <input
                            name="templateLanguage"
                            defaultValue={whatsappStatus.templateLanguage}
                            className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                          />
                        </div>
                        <DashButton type="submit" variant="outline">
                          Save Template
                        </DashButton>
                      </form>
                    ) : null}
                  </div>
                ) : int.name === "Gmail / Google Workspace" ? (
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
                ) : int.name === "Instagram" ? (
                  <div key={int.name} className="bb-stagger-item flex items-center gap-4 rounded-xl border border-bb-border bg-bb-navy-2 px-5 py-4">
                    <div className="flex-1">
                      <div className="text-sm font-medium text-bb-text">{int.name}</div>
                      <div className="text-xs text-bb-text-3">
                        {instagramStatus.connected ? `Connected as @${instagramStatus.username}` : int.desc}
                      </div>
                    </div>
                    {instagramStatus.connected ? (
                      <>
                        <span className="rounded-full border border-bb-emerald/25 bg-bb-emerald/10 px-2 py-0.5 text-xs text-bb-emerald">Connected</span>
                        <form action={disconnectInstagramAction}>
                          <DashButton type="submit" variant="outline">
                            Disconnect
                          </DashButton>
                        </form>
                      </>
                    ) : (
                      <>
                        <span className="rounded-full border border-bb-text-3/25 bg-bb-text-3/10 px-2 py-0.5 text-xs text-bb-text-3">Not Connected</span>
                        <a href="/api/instagram/oauth/start">
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
              <InstagramDiscoveryCard
                status={instagramDiscoveryStatus}
                runtimeConfigured={instagramDiscoveryRuntimeConfigured}
                organizationId={instagramDiscoveryOrganizationId}
                requestConnectionAction={requestInstagramDiscoveryConnectionAction}
                disconnectAction={disconnectInstagramDiscoveryConnectionAction}
                testConnectionAction={testInstagramDiscoveryConnectionAction}
              />
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

const INSTAGRAM_DISCOVERY_STATUS_LABEL: Record<InstagramDiscoveryConnectionStatus, string> = {
  not_connected: "Not Connected",
  authentication_required: "Authentication Required",
  connecting: "Connecting…",
  connected: "Connected",
  ready: "Ready",
  session_expired: "Session Expired",
  browser_unavailable: "Browser Unavailable",
  error: "Error",
};

const INSTAGRAM_DISCOVERY_STATUS_VARIANT: Record<InstagramDiscoveryConnectionStatus, "neutral" | "amber" | "success" | "error"> = {
  not_connected: "neutral",
  authentication_required: "amber",
  connecting: "amber",
  connected: "success",
  ready: "success",
  session_expired: "error",
  browser_unavailable: "error",
  error: "error",
};

const STATUS_BADGE_CLASSES: Record<"neutral" | "amber" | "success" | "error", string> = {
  neutral: "border-bb-text-3/25 bg-bb-text-3/10 text-bb-text-3",
  amber: "border-bb-amber/25 bg-bb-amber/10 text-bb-amber",
  success: "border-bb-emerald/25 bg-bb-emerald/10 text-bb-emerald",
  error: "border-bb-rose/25 bg-bb-rose/10 text-bb-rose",
};

/**
 * A CORE lead-discovery source, deliberately presented as its own card,
 * separate from the "Instagram" (Meta Graph API Business Discovery
 * enrichment) card above it — the two are genuinely different capabilities
 * backed by genuinely different credentials (see
 * src/lib/instagram-discovery/connection.ts's own doc comment), and
 * conflating them in the UI would misrepresent which one a connection
 * actually enables.
 *
 * Deliberately shows TWO independent facts rather than one combined
 * "Connected" badge: this organization's own connection status, and whether
 * ANY browser runtime is provisioned for this deployment at all — "Connected"
 * has always meant "the runtime last reported success," never "discovery is
 * guaranteed to work right now" (see connection.ts's own isInstagramDiscoveryRuntimeConfigured
 * doc comment for why these are genuinely separate axes).
 */
/** A one-line "reason" hint for a state that needs an operator's attention, distinct from status.lastError (the runtime's own raw message, shown separately above this). */
const INSTAGRAM_DISCOVERY_STATE_HINT: Partial<Record<InstagramDiscoveryConnectionStatus, string>> = {
  browser_unavailable: "Instagram may require manual verification (CAPTCHA/2FA), or the browser runtime hit an error. Complete any verification in the runtime's own browser window, then reconnect below.",
  session_expired: "The saved Instagram session is no longer authenticated. Reconnect below to restore discovery.",
  authentication_required: "Run the login command below on your Hermes browser runtime machine to finish connecting.",
};

/** A copyable exact command, so an operator never has to guess the right organization id — click, paste into the runtime machine's terminal. */
function LoginCommandHint({ organizationId }: { organizationId: string }) {
  const [copied, setCopied] = useState(false);
  const command = `node login.mjs --org ${organizationId}`;

  return (
    <div className="mt-2 flex items-center gap-2">
      <code className="rounded bg-bb-navy-3 px-2 py-1 text-xs text-bb-text">{command}</code>
      <button
        type="button"
        className="text-xs text-bb-text-3 underline hover:text-bb-text"
        onClick={() => {
          navigator.clipboard
            ?.writeText(command)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => {});
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function InstagramDiscoveryCard({
  status,
  runtimeConfigured,
  organizationId,
  requestConnectionAction,
  disconnectAction,
  testConnectionAction,
}: {
  status: InstagramDiscoveryStatus;
  runtimeConfigured: boolean;
  organizationId: string;
  requestConnectionAction: () => void;
  disconnectAction: () => void;
  testConnectionAction: () => void;
}) {
  const hasConnection = status.status !== "not_connected";
  const canReconnect =
    status.status === "not_connected" ||
    status.status === "session_expired" ||
    status.status === "browser_unavailable" ||
    status.status === "error";
  const showLoginCommand =
    runtimeConfigured &&
    (status.status === "authentication_required" || status.status === "session_expired" || status.status === "browser_unavailable");

  return (
    <div className="bb-stagger-item rounded-xl border border-bb-border bg-bb-navy-2 px-5 py-4">
      <div className="flex items-center gap-4">
        <div className="flex-1">
          <div className="text-sm font-medium text-bb-text">Instagram Discovery (Browser)</div>
          <div className="text-xs text-bb-text-3">
            {(status.status === "connected" || status.status === "ready") && status.connectedUsername
              ? `Connected as @${status.connectedUsername} — Discovery access: Ready`
              : "Discover new prospects on Instagram via a dedicated authenticated browser account — separate from the Instagram connection above."}
          </div>
          {status.lastError ? <div className="mt-1 text-xs text-bb-rose">{status.lastError}</div> : null}
          {INSTAGRAM_DISCOVERY_STATE_HINT[status.status] ? (
            <div className="mt-1 text-xs text-bb-text-3">{INSTAGRAM_DISCOVERY_STATE_HINT[status.status]}</div>
          ) : null}
          {showLoginCommand ? <LoginCommandHint organizationId={organizationId} /> : null}
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_BADGE_CLASSES[INSTAGRAM_DISCOVERY_STATUS_VARIANT[status.status]]}`}>
          {INSTAGRAM_DISCOVERY_STATUS_LABEL[status.status]}
        </span>
        {hasConnection && runtimeConfigured ? (
          <form action={testConnectionAction}>
            <DashButton type="submit" variant="outline">
              Test Connection
            </DashButton>
          </form>
        ) : null}
        {hasConnection ? (
          <form action={disconnectAction}>
            <DashButton type="submit" variant="outline">
              Disconnect
            </DashButton>
          </form>
        ) : null}
        {canReconnect ? (
          <form action={requestConnectionAction}>
            <DashButton type="submit" variant="gradient">
              {status.status === "not_connected" ? "Connect Instagram Discovery" : "Reconnect"}
            </DashButton>
          </form>
        ) : null}
      </div>
      <div className="mt-3 border-t border-bb-border pt-3 text-xs text-bb-text-3">
        Browser runtime:{" "}
        <span className={runtimeConfigured ? "text-bb-emerald" : "text-bb-text-3"}>{runtimeConfigured ? "Configured" : "Not configured"}</span>
        {!runtimeConfigured ? (
          <span> — this deployment has no Instagram browser runtime connected yet. A connection request stays pending until an operator sets one up.</span>
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
