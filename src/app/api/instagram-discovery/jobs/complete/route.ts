import { NextResponse } from "next/server";
import { z } from "zod";
import { isInstagramDiscoveryRuntimeConfigured } from "@/lib/instagram-discovery/connection";
import { completeInstagramDiscoveryJob } from "@/lib/instagram-discovery/jobs";

export const dynamic = "force-dynamic";

/**
 * The runtime reports one claimed job's real outcome here after actually
 * navigating/searching Instagram with the organization's own authenticated
 * Chromium profile — candidates are only ever what CandidateSchema's fields
 * describe as actually found on a real page; this route performs no
 * enrichment or fabrication of its own. Same bearer-secret boundary as
 * jobs/claim and session-report.
 */

const CandidateSchema = z.object({
  username: z.string().min(1),
  profileUrl: z.string().min(1),
  displayName: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  externalUrl: z.string().nullable().optional(),
});

const CompleteSchema = z.discriminatedUnion("status", [
  z.object({ jobId: z.string().min(1), status: z.literal("completed"), candidates: z.array(CandidateSchema) }),
  z.object({ jobId: z.string().min(1), status: z.literal("failed"), error: z.string().min(1) }),
]);

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

  const parsed = CompleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "invalid_body", detail: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }

  const result = await completeInstagramDiscoveryJob(
    parsed.data.status === "completed"
      ? { jobId: parsed.data.jobId, status: "completed", candidates: parsed.data.candidates }
      : { jobId: parsed.data.jobId, status: "failed", error: parsed.data.error }
  );

  if (!result.ok) {
    const status = result.code === "not_configured" ? 503 : result.code === "not_claimed" ? 404 : 500;
    return NextResponse.json({ ok: false, error: result.code, detail: result.message }, { status });
  }

  return NextResponse.json({ ok: true });
}
