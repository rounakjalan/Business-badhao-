import { NextResponse } from "next/server";
import { isInstagramDiscoveryRuntimeConfigured } from "@/lib/instagram-discovery/connection";
import { getInstagramDiscoveryQueueStats } from "@/lib/instagram-discovery/jobs";

export const dynamic = "force-dynamic";

/**
 * A safe-for-monitoring aggregate the runtime's own /health endpoint calls
 * periodically so operators can see queue depth without any direct database
 * access — counts only (see getInstagramDiscoveryQueueStats's own doc
 * comment), never a job's criteria, candidates, or any organization-
 * identifying detail. Same bearer-secret boundary as claim/complete/
 * session-report — this is read-only but still server-to-server, not a
 * public endpoint.
 */
function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const token = process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;

  if (!isInstagramDiscoveryRuntimeConfigured() || !token) {
    return NextResponse.json(
      { ok: false, error: "not_configured", detail: "No Instagram discovery browser runtime is connected to this deployment yet." },
      { status: 503 }
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${token}`) return unauthorized();

  const stats = await getInstagramDiscoveryQueueStats();
  if (!stats) {
    return NextResponse.json({ ok: false, error: "not_configured", detail: "Automation isn't configured in this deployment." }, { status: 503 });
  }

  return NextResponse.json({ ok: true, queue: stats });
}
