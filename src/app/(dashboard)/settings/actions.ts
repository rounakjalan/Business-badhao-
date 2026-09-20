"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { disconnectAccount } from "@/lib/gmail/tokens";
import { disconnectAccount as disconnectInstagramAccount } from "@/lib/instagram/tokens";
import {
  disconnectInstagramDiscoveryConnection,
  getInstagramDiscoveryConnectionStatus,
  isInstagramDiscoveryRuntimeConfigured,
  requestInstagramDiscoveryConnection,
} from "@/lib/instagram-discovery/connection";
import { createInstagramDiscoveryVerificationJob, pollInstagramDiscoveryJobResult } from "@/lib/instagram-discovery/jobs";
import { attemptSandboxCredentialLogin, wakeHermesSandboxRuntime } from "@/lib/instagram-discovery/sandbox-runtime";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { disconnectWhatsAppAccount, saveWhatsAppAccount, updateWhatsAppTemplate } from "@/lib/whatsapp/tokens";

export async function updateProfile(formData: FormData) {
  const fullName = String(formData.get("fullName") ?? "").trim();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { error } = await supabase.from("profiles").update({ full_name: fullName }).eq("id", user.id);

  if (error) {
    redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/settings");
  redirect("/settings?message=profile-updated");
}

export async function updateOrganization(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    redirect(`/settings?error=${encodeURIComponent("Organization name is required.")}`);
  }

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    redirect("/onboarding");
  }

  const supabase = await createClient();
  // RLS also enforces this (only admins/owners can update an organization),
  // this check just produces a clearer error message than a generic RLS
  // rejection would.
  if (currentOrg.role !== "owner" && currentOrg.role !== "admin") {
    redirect(`/settings?error=${encodeURIComponent("Only owners and admins can rename the organization.")}`);
  }

  const { error } = await supabase.from("organizations").update({ name }).eq("id", currentOrg.organizationId);

  if (error) {
    redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/settings");
  redirect("/settings?message=organization-updated");
}

export async function disconnectGmailAction() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  await disconnectAccount(currentOrg.organizationId);

  revalidatePath("/settings");
  revalidatePath("/leads");
  redirect("/settings?tab=Integrations&gmail=disconnected");
}

export async function disconnectInstagramAction() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  await disconnectInstagramAccount(currentOrg.organizationId);

  revalidatePath("/settings");
  redirect("/settings?tab=Integrations&instagram=disconnected");
}

/**
 * The real action behind "Connect Instagram Discovery" — separate from
 * disconnectInstagramAction/the Meta Graph API OAuth flow above, which is
 * enrichment-only and unrelated to discovery (see
 * src/lib/instagram-discovery/connection.ts's own doc comment). This never
 * opens a browser itself; it only records that this organization wants a
 * connection, for an operator's own external browser runtime to pick up.
 */
export async function requestInstagramDiscoveryConnectionAction() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const result = await requestInstagramDiscoveryConnection(currentOrg.organizationId, user.id);
  if (!result.ok) {
    redirect(
      `/settings?tab=Integrations&instagramDiscovery=error&instagramDiscoveryMessage=${encodeURIComponent("Could not record the Instagram discovery connection request. Please try again.")}`
    );
  }

  revalidatePath("/settings");
  redirect("/settings?tab=Integrations&instagramDiscovery=requested");
}

/**
 * The real action behind Settings' username/password "Connect Instagram"
 * form — the org admin's own credentials for that organization's dedicated
 * Instagram account, used exactly once to complete a real login via
 * attemptSandboxCredentialLogin, then discarded. Never written to Supabase
 * (no column for it exists on instagram_discovery_connections or anywhere
 * else — see connection.ts), never logged, never returned to the client:
 * this function's own local `password` binding goes out of scope the
 * moment it returns, and nothing it calls persists it either.
 *
 * Only meaningful when this deployment uses the automatic Sandbox runtime
 * (see isInstagramDiscoverySandboxHostingEnabled) — an operator who opted
 * into running their own Docker/systemd runtime instead keeps using
 * login.mjs's own human-supervised flow, unaffected by this action.
 */
export async function connectInstagramWithCredentialsAction(formData: FormData) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const username = String(formData.get("instagramUsername") ?? "").trim();
  const password = String(formData.get("instagramPassword") ?? "");

  if (!username || !password) {
    redirect(
      `/settings?tab=Integrations&instagramDiscovery=error&instagramDiscoveryMessage=${encodeURIComponent("Enter both the Instagram username and password.")}`
    );
  }

  // Records the pending connection the same way the old "Connect Instagram
  // Discovery" button did — reused, not reinvented — so Settings shows
  // "Connecting..." while the login below actually runs.
  await requestInstagramDiscoveryConnection(currentOrg.organizationId, user.id);

  const result = await attemptSandboxCredentialLogin(currentOrg.organizationId, username, password);
  // `password` is not referenced again below and is never returned — it goes
  // out of scope when this function returns.

  revalidatePath("/settings");

  if (!result.ok) {
    redirect(`/settings?tab=Integrations&instagramDiscovery=error&instagramDiscoveryMessage=${encodeURIComponent(result.message)}`);
  }

  redirect(`/settings?tab=Integrations&instagramDiscovery=tested&instagramDiscoveryMessage=${encodeURIComponent(`Connected as @${result.username}.`)}`);
}

export async function disconnectInstagramDiscoveryConnectionAction() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  await disconnectInstagramDiscoveryConnection(currentOrg.organizationId);

  revalidatePath("/settings");
  redirect("/settings?tab=Integrations&instagramDiscovery=disconnected");
}

/**
 * How this deployment's runtime-execution boundary bounds a live check
 * before giving up honestly, rather than leaving the operator staring at a
 * spinner indefinitely. Comfortably inside a Server Action's own execution
 * budget on this platform, and generous relative to the runtime's own
 * default poll interval (WORKER_POLL_INTERVAL_MS, 4s) — a running worker
 * has several chances to claim and answer within this window.
 */
const TEST_CONNECTION_TIMEOUT_MS = 20_000;

/**
 * Behind Settings' "Test Connection" — an on-demand real check of whether an
 * organization's saved Instagram session is still usable, instead of
 * silently waiting for the next scheduled discovery run to (maybe) reveal a
 * dead session. Reuses the EXISTING job queue (instagram_discovery_jobs) and
 * polling helper (pollInstagramDiscoveryJobResult) — a "verify" job is not a
 * second parallel mechanism, just the same real dispatch/claim/complete
 * contract a search job already uses, with no query to search. The
 * connection's own status (not the job's own completion) is what's reported
 * back, since that's what the runtime actually updates via session-report
 * while processing the job — see hermes-browser-runtime/worker.mjs.
 */
export async function testInstagramDiscoveryConnectionAction() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  if (!isInstagramDiscoveryRuntimeConfigured()) {
    redirect(
      `/settings?tab=Integrations&instagramDiscovery=error&instagramDiscoveryMessage=${encodeURIComponent(
        "No Instagram discovery browser runtime is configured for this deployment yet."
      )}`
    );
  }

  const job = await createInstagramDiscoveryVerificationJob(currentOrg.organizationId);
  if (!job) {
    redirect(
      `/settings?tab=Integrations&instagramDiscovery=error&instagramDiscoveryMessage=${encodeURIComponent("Could not start a connection test. Please try again.")}`
    );
  }

  // See instagram-discovery-tool.ts's identical call for why this runs
  // concurrently with the poll below rather than being awaited first.
  void wakeHermesSandboxRuntime().catch(() => {});

  const polled = await pollInstagramDiscoveryJobResult(job.jobId, TEST_CONNECTION_TIMEOUT_MS);

  revalidatePath("/settings");

  if (!polled.ok) {
    redirect(
      `/settings?tab=Integrations&instagramDiscovery=error&instagramDiscoveryMessage=${encodeURIComponent(
        "No response from the Instagram browser runtime. Confirm worker.mjs is running and polling this deployment."
      )}`
    );
  }

  const status = await getInstagramDiscoveryConnectionStatus(currentOrg.organizationId);

  const message =
    status.status === "connected" || status.status === "ready"
      ? `Connection verified — session is authenticated${status.connectedUsername ? ` as @${status.connectedUsername}` : ""}.`
      : (status.lastError ?? "The runtime reported the session is not currently usable.");

  redirect(`/settings?tab=Integrations&instagramDiscovery=tested&instagramDiscoveryMessage=${encodeURIComponent(message)}`);
}

/**
 * WhatsApp Cloud API has no OAuth consent screen the way Gmail does — the
 * org admin enters the phone_number_id and access_token they already
 * obtained directly from Meta Business Manager (see the doc comment on
 * src/lib/whatsapp/config.ts for why). This just validates and stores them.
 */
export async function connectWhatsAppAction(formData: FormData) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  const phoneNumberId = String(formData.get("phoneNumberId") ?? "").trim();
  const accessToken = String(formData.get("accessToken") ?? "").trim();
  const displayPhoneNumber = String(formData.get("displayPhoneNumber") ?? "").trim();
  const templateName = String(formData.get("templateName") ?? "").trim();
  const templateLanguage = String(formData.get("templateLanguage") ?? "").trim();

  if (!phoneNumberId || !accessToken) {
    redirect(`/settings?tab=Integrations&whatsapp=error&whatsappMessage=${encodeURIComponent("Phone Number ID and Access Token are both required.")}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const saved = await saveWhatsAppAccount({
    organizationId: currentOrg.organizationId,
    connectedBy: user.id,
    phoneNumberId,
    businessAccountId: null,
    displayPhoneNumber: displayPhoneNumber || null,
    accessToken,
    templateName: templateName || null,
    templateLanguage: templateLanguage || undefined,
  });

  if (!saved.ok) {
    redirect(`/settings?tab=Integrations&whatsapp=error&whatsappMessage=${encodeURIComponent(saved.message ?? "Could not save this WhatsApp connection.")}`);
  }

  revalidatePath("/settings");
  redirect("/settings?tab=Integrations&whatsapp=connected");
}

/**
 * Lets an already-connected org add or change its approved cold-outreach
 * template without re-entering phone_number_id/access_token — see the doc
 * comment on updateWhatsAppTemplate (whatsapp/tokens.ts) for why this is a
 * separate action from connectWhatsAppAction.
 */
export async function updateWhatsAppTemplateAction(formData: FormData) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  const templateName = String(formData.get("templateName") ?? "").trim();
  const templateLanguage = String(formData.get("templateLanguage") ?? "").trim() || "en_US";

  const result = await updateWhatsAppTemplate(currentOrg.organizationId, { templateName: templateName || null, templateLanguage });

  if (!result.ok) {
    redirect(`/settings?tab=Integrations&whatsapp=error&whatsappMessage=${encodeURIComponent(result.message ?? "Could not save the WhatsApp template.")}`);
  }

  revalidatePath("/settings");
  redirect("/settings?tab=Integrations&whatsapp=template_saved");
}

export async function disconnectWhatsAppAction() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  await disconnectWhatsAppAccount(currentOrg.organizationId);

  revalidatePath("/settings");
  redirect("/settings?tab=Integrations&whatsapp=disconnected");
}
