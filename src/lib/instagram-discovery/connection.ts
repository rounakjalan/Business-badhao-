import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Organization-scoped Instagram DISCOVERY connection state — the foundation
 * for Hermes browser-based lead discovery, entirely separate from
 * src/lib/instagram/* (Meta Graph API OAuth + Business Discovery
 * enrichment). This module never talks to Instagram, never opens a browser,
 * and never sees an Instagram password — it only tracks CONNECTION STATE in
 * instagram_discovery_connections (see that migration's own doc comment).
 *
 * The actual authenticated browser session lives on a separate,
 * always-available runtime an organization's operator runs outside this
 * Vercel deployment (see isInstagramDiscoveryRuntimeConfigured below) —
 * Vercel's serverless execution model cannot host a persistent authenticated
 * browser session. That runtime is the only thing that ever moves a
 * connection's status to "connected": see
 * applyInstagramDiscoveryRuntimeReport, called from the authenticated
 * session-report API route, never from this module's own request/disconnect
 * functions.
 */

export type InstagramDiscoveryConnectionStatus = "not_connected" | "authentication_required" | "connecting" | "connected" | "session_expired" | "error";

export type InstagramDiscoveryConnection = {
  status: InstagramDiscoveryConnectionStatus;
  connectedUsername: string | null;
  lastError: string | null;
  requestedAt: string | null;
  lastVerifiedAt: string | null;
};

const NOT_CONNECTED: InstagramDiscoveryConnection = {
  status: "not_connected",
  connectedUsername: null,
  lastError: null,
  requestedAt: null,
  lastVerifiedAt: null,
};

/**
 * A DEPLOYMENT-LEVEL fact — whether any external browser runtime has been
 * provisioned to report session state to this deployment at all — entirely
 * distinct from any one organization's own connection status (see this
 * module's own type above). An organization can be "authentication_required"
 * whether or not a runtime is configured; this only answers "does a runtime
 * exist that could ever move it past that."
 */
export function isInstagramDiscoveryRuntimeConfigured(): boolean {
  return Boolean(process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN);
}

/** Safe-to-render status only — never returns a profile reference or any credential. */
export async function getInstagramDiscoveryConnectionStatus(organizationId: string): Promise<InstagramDiscoveryConnection> {
  const admin = createAdminClient();
  if (!admin) return NOT_CONNECTED;

  const { data } = await admin
    .from("instagram_discovery_connections")
    .select("status, connected_username, last_error, requested_at, last_verified_at")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!data) return NOT_CONNECTED;

  return {
    status: data.status as InstagramDiscoveryConnectionStatus,
    connectedUsername: data.connected_username,
    lastError: data.last_error,
    requestedAt: data.requested_at,
    lastVerifiedAt: data.last_verified_at,
  };
}

/**
 * The real action behind Settings' "Connect Instagram Discovery" button —
 * records that this organization wants a connection, regardless of whether a
 * browser runtime is configured yet (see isInstagramDiscoveryRuntimeConfigured).
 * This never opens a browser and never contacts Instagram; it only creates
 * the durable record an operator's own runtime would later find and act on.
 */
export async function requestInstagramDiscoveryConnection(organizationId: string, requestedBy: string): Promise<{ ok: boolean }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false };

  const { error } = await admin.from("instagram_discovery_connections").upsert(
    {
      organization_id: organizationId,
      requested_by: requestedBy,
      status: "authentication_required",
      requested_at: new Date().toISOString(),
      // A fresh connection request always starts clean — any error or
      // profile reference from a previous, since-abandoned attempt must
      // never be shown as still current.
      browser_profile_ref: null,
      connected_username: null,
      last_error: null,
      last_verified_at: null,
    },
    { onConflict: "organization_id" }
  );

  return { ok: !error };
}

export async function disconnectInstagramDiscoveryConnection(organizationId: string): Promise<{ ok: boolean }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false };

  const { error } = await admin.from("instagram_discovery_connections").delete().eq("organization_id", organizationId);
  return { ok: !error };
}

export type InstagramDiscoveryRuntimeReport = {
  organizationId: string;
  status: Extract<InstagramDiscoveryConnectionStatus, "connecting" | "connected" | "session_expired" | "error">;
  username?: string | null;
  profileRef?: string | null;
  error?: string | null;
};

export type ApplyRuntimeReportResult = { ok: true } | { ok: false; code: "not_configured" | "no_pending_connection" | "db_error"; message: string };

/**
 * Applies a real status report from an organization's own external browser
 * runtime — the only code path that ever moves a connection to "connected".
 * The caller (the session-report API route) is responsible for verifying the
 * runtime's bearer token before this is ever reached; this function performs
 * no authentication of its own, matching every other tokens.ts-style
 * "save*"/"apply*" function in this codebase (e.g. saveConnectedAccount in
 * src/lib/instagram/tokens.ts).
 *
 * Deliberately UPDATE, never upsert: a report for an organization that never
 * requested a connection (no row exists yet) is treated as a real error
 * ("no_pending_connection"), not a silent no-op or an implicit new
 * connection — a report should only ever confirm/update a connection this
 * organization itself already asked for via requestInstagramDiscoveryConnection.
 */
export async function applyInstagramDiscoveryRuntimeReport(report: InstagramDiscoveryRuntimeReport): Promise<ApplyRuntimeReportResult> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, code: "not_configured", message: "Automation isn't configured in this deployment." };

  const { data, error } = await admin
    .from("instagram_discovery_connections")
    .update({
      status: report.status,
      connected_username: report.username ?? null,
      browser_profile_ref: report.profileRef ?? null,
      last_error: report.error ?? null,
      last_verified_at: report.status === "connected" ? new Date().toISOString() : null,
    })
    .eq("organization_id", report.organizationId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, code: "db_error", message: error.message };
  if (!data) return { ok: false, code: "no_pending_connection", message: "No Instagram discovery connection was requested for this organization." };
  return { ok: true };
}
