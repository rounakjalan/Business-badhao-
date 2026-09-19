import { NextResponse } from "next/server";
import { isInstagramDiscoveryRuntimeConfigured } from "@/lib/instagram-discovery/connection";
import { claimNextInstagramDiscoveryJob } from "@/lib/instagram-discovery/jobs";

export const dynamic = "force-dynamic";

/**
 * The runtime's own poll loop calls this repeatedly (recommended every 3-5s
 * — see hermes-browser-runtime/README.md) looking for discovery work. Same
 * bearer-secret pattern and INSTAGRAM_DISCOVERY_RUNTIME_TOKEN as
 * api/instagram-discovery/session-report/route.ts — this is a second,
 * necessary endpoint on that same authenticated boundary (job dispatch is a
 * genuinely different operation from a connection-status report), not a
 * duplicate of it.
 *
 * Returns { job: null } — not an error — when there is nothing to claim,
 * which is the expected common case between discovery runs.
 */
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

  const job = await claimNextInstagramDiscoveryJob();
  if (!job) return NextResponse.json({ ok: true, job: null });

  return NextResponse.json({
    ok: true,
    job: { id: job.id, organizationId: job.organizationId, query: job.query, browserProfileRef: job.browserProfileRef },
  });
}
