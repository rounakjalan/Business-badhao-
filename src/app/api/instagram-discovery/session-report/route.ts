import { NextResponse } from "next/server";
import { z } from "zod";
import { applyInstagramDiscoveryRuntimeReport, isInstagramDiscoveryRuntimeConfigured } from "@/lib/instagram-discovery/connection";

export const dynamic = "force-dynamic";

/**
 * The RECEIVING side of the Hermes browser runtime boundary: an
 * organization's own external, always-available Chromium/browser runtime
 * (never hosted by this Vercel deployment — see the migration and
 * connection.ts's own doc comments) calls this endpoint to report real
 * session state back after a human has manually authenticated the dedicated
 * Instagram account there. Business Badhao never calls out to a browser
 * itself; this route only ever accepts a report already produced elsewhere.
 *
 * Bearer-secret authenticated, same pattern as api/cron/lead-pipeline/route.ts
 * (CRON_SECRET) — closed by default rather than open, and honestly reports
 * "not_configured" (503) rather than silently accepting requests when no
 * runtime has ever been provisioned for this deployment.
 */

const ReportSchema = z.object({
  organizationId: z.string().min(1),
  status: z.enum(["connecting", "connected", "session_expired", "error"]),
  username: z.string().min(1).nullable().optional(),
  profileRef: z.string().min(1).nullable().optional(),
  error: z.string().min(1).nullable().optional(),
});

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  const token = process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;

  if (!isInstagramDiscoveryRuntimeConfigured() || !token) {
    return NextResponse.json(
      { ok: false, error: "not_configured", detail: "No Instagram discovery browser runtime is connected to this deployment yet." },
      { status: 503 }
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${token}`) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const parsed = ReportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body", detail: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }

  const result = await applyInstagramDiscoveryRuntimeReport({
    organizationId: parsed.data.organizationId,
    status: parsed.data.status,
    username: parsed.data.username,
    profileRef: parsed.data.profileRef,
    error: parsed.data.error,
  });

  if (!result.ok) {
    const status = result.code === "no_pending_connection" ? 404 : result.code === "not_configured" ? 503 : 500;
    return NextResponse.json({ ok: false, error: result.code, detail: result.message }, { status });
  }

  return NextResponse.json({ ok: true });
}
