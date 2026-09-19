import "server-only";
import type { DiscoverySearchTool } from "@/lib/ai/agents/hermes-lead-discovery-agent";
import type { SearchHit } from "@/lib/ai/agents/discovery";
import { createInstagramDiscoveryJob, pollInstagramDiscoveryJobResult, type InstagramDiscoveryCandidate } from "@/lib/instagram-discovery/jobs";
import { wakeHermesSandboxRuntime } from "@/lib/instagram-discovery/sandbox-runtime";

/**
 * The REAL DiscoverySearchTool backed by Hermes + local Chromium — real,
 * because "real" here means what actually reaches HermesLeadDiscoveryAgent's
 * existing pipeline is either genuine content a runtime's Chromium actually
 * rendered from Instagram, or an honest failure. This class never fabricates
 * a result: search() either returns SearchHit[] built only from fields
 * hermes-browser-runtime reported finding on a real page, or ok:false.
 *
 * Deliberately thin: exactly like TavilyDiscoveryProvider's own .search(),
 * this has no query planning, extraction, review or validation of its own —
 * those remain HermesLeadDiscoveryAgent's job (see discovery.ts). It turns
 * one query into a job, waits (bounded) for a real runtime to answer it, and
 * maps whatever real candidates come back into the exact same SearchHit
 * shape Tavily/Exa already produce — so the existing Nemotron extraction
 * step (extractProspectsFromResults) needs no Instagram-specific code at
 * all; it already knows how to turn {title, url, content} into a
 * DiscoveredProspect for any source.
 */
export class InstagramDiscoveryTool implements DiscoverySearchTool {
  readonly name = "instagram";

  constructor(
    private readonly organizationId: string,
    /** Overridable only for tests — production always uses the real default below. */
    private readonly timeoutMs: number = InstagramDiscoveryTool.defaultTimeoutMs()
  ) {}

  private static defaultTimeoutMs(): number {
    const raw = Number(process.env.INSTAGRAM_DISCOVERY_JOB_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
  }

  async search(query: string): Promise<{ ok: true; results: SearchHit[] } | { ok: false; message: string }> {
    const job = await createInstagramDiscoveryJob(this.organizationId, query);
    if (!job) {
      return { ok: false, message: "Could not dispatch an Instagram discovery job — automation isn't configured in this deployment." };
    }

    // Fire-and-forget: ensures a real worker.mjs is actually polling for
    // this job (see sandbox-runtime.ts's own doc comment for why this is
    // needed at all). Runs concurrently with the poll below rather than
    // being awaited first — pollInstagramDiscoveryJobResult already waits
    // up to this.timeoutMs regardless of when the worker actually picks the
    // job up, so serializing the two would only add latency, never safety.
    // Never rejects (wakeHermesSandboxRuntime catches its own errors); the
    // .catch() here is defense in depth only.
    void wakeHermesSandboxRuntime().catch(() => {});

    const result = await pollInstagramDiscoveryJobResult(job.jobId, this.timeoutMs);
    if (!result.ok) return result;

    return { ok: true, results: result.candidates.map((candidate) => toSearchHit(candidate)) };
  }
}

/**
 * Only fields the runtime actually reported finding on a real Instagram page
 * — never invented here. `content` is deliberately the concatenation of
 * whatever real fields came back (bio/category/external link), exactly the
 * kind of short excerpt extractProspectsFromResults already knows how to
 * read a business name and description out of for Tavily/Exa hits.
 */
function toSearchHit(candidate: InstagramDiscoveryCandidate): SearchHit {
  const contentParts = [candidate.bio, candidate.category ? `Category: ${candidate.category}` : null, candidate.externalUrl ? `Link: ${candidate.externalUrl}` : null].filter(
    (part): part is string => Boolean(part && part.trim())
  );

  return {
    title: candidate.displayName?.trim() || `@${candidate.username}`,
    url: candidate.profileUrl,
    content: contentParts.join(" | ") || `Instagram business account @${candidate.username}`,
    source: "instagram",
  };
}
