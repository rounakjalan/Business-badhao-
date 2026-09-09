import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateOutreach } from "@/lib/ai/agents/outreach";
import { runProspectResearch, type ProspectResearchResult } from "@/lib/ai/agents/prospect-research";
import { runLeadQualification, type LeadQualificationResult } from "@/lib/ai/agents/qualification";
import { completeAgentRun, createAgentRun, recordAgentAction } from "@/lib/ai/tracking/agent-runs";
import { getBusinessContext, selectOutreachContext, selectQualificationContext, selectResearchContext } from "@/lib/business-context";
import { getConnectionStatus as getGmailConnectionStatus } from "@/lib/gmail/tokens";
import { resolveLeadIdentity } from "@/lib/lead-names";
import { selectOutreachChannel, type WhatsAppIneligibleReason } from "@/lib/outreach/channel-selection";
import { ensureConversation } from "@/lib/outreach/conversation";
import { parseProspectRawData } from "@/lib/prospects";
import { classifyResearchConfidence } from "@/lib/research-confidence";
import { normalizePhoneNumber } from "@/lib/whatsapp/phone";
import { getWhatsAppAutomationConfig } from "@/lib/whatsapp/tokens";
import { sendWhatsAppTemplateMessage } from "@/lib/whatsapp/send";
import type { Database, Json } from "@/types/database.types";

type Client = SupabaseClient<Database>;

/**
 * The per-lead half of the pipeline — research, then qualification, then
 * (see sendAutomaticWhatsAppOutreach below) outreach — expressed without any
 * dependency on who is signed in.
 *
 * The Server Actions behind the Research and Qualify buttons resolve the
 * organization from the session and then call these. Scheduled work has no
 * session and passes the organization it already knows. Keeping one
 * implementation matters more than usual here: the rule that qualification
 * only runs on real research evidence lives in this path, and two copies
 * would eventually disagree about it.
 *
 * Every query is scoped by organization_id explicitly, because a caller may
 * be using a client that bypasses row-level security.
 */

export async function loadLeadContext(supabase: Client, leadId: string, organizationId: string) {
  const { data: lead } = await supabase
    .from("leads")
    .select("id, status, qualification_status, current_score, campaign_id, prospect_id")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!lead) return null;

  const [contacts, prospect, campaign, latestResearch] = await Promise.all([
    supabase.from("contacts").select("full_name, is_primary").eq("lead_id", leadId),
    lead.prospect_id
      ? supabase.from("prospects").select("company_name, website, title, raw_data").eq("id", lead.prospect_id).maybeSingle()
      : Promise.resolve({ data: null }),
    lead.campaign_id
      ? supabase.from("campaigns").select("name, objective, ideal_customer_profile_id").eq("id", lead.campaign_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("lead_research")
      .select("summary")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  let icpCriteria: Record<string, unknown> | null = null;
  if (campaign.data?.ideal_customer_profile_id) {
    const { data: icp } = await supabase
      .from("ideal_customer_profiles")
      .select("criteria")
      .eq("id", campaign.data.ideal_customer_profile_id)
      .maybeSingle();
    icpCriteria = (icp?.criteria as Record<string, unknown> | null) ?? null;
  }

  const primaryContact = contacts.data?.find((c) => c.is_primary) ?? contacts.data?.[0] ?? null;
  // The real, grounded evidence Lead Discovery captured for this prospect —
  // see prospects.ts's ProspectRawData. Without feeding this to the research
  // agent it had almost nothing prospect-specific to reason over, which is
  // why research confidence was effectively always low regardless of what
  // Lead Discovery had actually found.
  const rawData = prospect.data ? parseProspectRawData(prospect.data.raw_data) : null;

  return {
    lead,
    leadName: primaryContact?.full_name ?? prospect.data?.company_name ?? "Unnamed lead",
    companyName: prospect.data?.company_name ?? null,
    website: prospect.data?.website ?? null,
    title: prospect.data?.title ?? null,
    campaignName: campaign.data?.name ?? null,
    campaignObjective: campaign.data?.objective ?? null,
    icpCriteria,
    latestResearchSummary: latestResearch.data?.summary ?? null,
    discoveryEvidence: rawData
      ? {
          location: rawData.location,
          industry: rawData.industry,
          businessType: rawData.businessType,
          matchedIcpCriteria: rawData.matchedIcpCriteria,
          evidenceSnippet: rawData.evidenceSnippet,
          sourceUrl: rawData.sourceUrl,
          hasVerifiedContact: rawData.contact?.contactStatus === "found",
        }
      : null,
  };
}

export async function researchLead(
  supabase: Client,
  organizationId: string,
  leadId: string
): Promise<ProspectResearchResult> {
  const context = await loadLeadContext(supabase, leadId, organizationId);
  if (!context) return { ok: false, message: "Lead not found." };

  // Atomic claim: this both marks the lead as actively being researched
  // (so a page load mid-run shows "Researching" rather than stale prior
  // state) AND is the sole guard against two callers researching the same
  // lead at once — a worker-pool job and a concurrent manual "Run AI
  // Research" click, or two overlapping automatic sweeps. Postgres
  // serializes concurrent UPDATEs to the same row, so of two simultaneous
  // callers only one ever gets a row back here; the other sees the row
  // already flipped to "researching" by the time its own WHERE clause is
  // evaluated and correctly claims nothing.
  const { data: claimed } = await supabase
    .from("leads")
    .update({ research_status: "researching" })
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .neq("research_status", "researching")
    .select("id")
    .maybeSingle();

  if (!claimed) {
    return { ok: false, message: "This lead is already being researched.", code: "already_in_progress" };
  }

  const businessContext = await getBusinessContext(organizationId, supabase);

  const result = await runProspectResearch({
    organizationId,
    leadName: context.leadName,
    companyName: context.companyName,
    website: context.website,
    title: context.title,
    campaignName: context.campaignName,
    campaignObjective: context.campaignObjective,
    businessContext: selectResearchContext(businessContext),
    discoveryEvidence: context.discoveryEvidence,
    client: supabase,
  });

  if (result.ok) {
    // The model's own "confidence" self-report is never trusted at face
    // value — same reason the Deterministic Validator never trusts a
    // discovery model's own claim of groundedness. Overwritten here with a
    // classification computed from measurable evidence signals (see
    // classifyResearchConfidence) before this ever reaches storage or the
    // Research tab, so a lead can't read "High Confidence" just because the
    // model said so with nothing real behind it.
    const confidence = classifyResearchConfidence({
      hasWebsite: Boolean(context.website),
      hasEvidenceSnippet: Boolean(context.discoveryEvidence?.evidenceSnippet),
      matchedIcpCriteriaCount: context.discoveryEvidence?.matchedIcpCriteria.length ?? 0,
      hasVerifiedContact: context.discoveryEvidence?.hasVerifiedContact ?? false,
      verifiedInformationCount: result.research.verifiedInformation.length,
      businessFactsReferencedCount: result.research.businessFactsReferenced.length,
      inferredInformationCount: result.research.inferredInformation.length,
      unavailableInformationCount: result.research.unavailableInformation.length,
    });
    result.research.confidence = confidence;

    await supabase.from("lead_research").insert({
      organization_id: organizationId,
      lead_id: leadId,
      summary: result.research.companySummary,
      findings: result.research as unknown as Json,
      source: "ai",
    });
    await supabase
      .from("leads")
      .update({ research_status: "completed", research_error: null })
      .eq("id", leadId)
      .eq("organization_id", organizationId);
  } else {
    // Recorded so the automatic pipeline never retries this lead on a later
    // cycle (see finishPendingLeads) and the lead page can show it honestly
    // instead of looking indistinguishable from "never researched". The
    // existing manual "Run AI Research" button is unaffected — it calls this
    // same function regardless of the lead's current research_status.
    await supabase
      .from("leads")
      .update({ research_status: "failed", research_error: result.message })
      .eq("id", leadId)
      .eq("organization_id", organizationId);
  }

  return result;
}

export async function qualifyLead(
  supabase: Client,
  organizationId: string,
  leadId: string
): Promise<LeadQualificationResult> {
  const context = await loadLeadContext(supabase, leadId, organizationId);
  if (!context) return { ok: false, message: "Lead not found." };

  const businessContext = await getBusinessContext(organizationId, supabase);

  const result = await runLeadQualification({
    organizationId,
    leadName: context.leadName,
    companyName: context.companyName,
    currentStatus: context.lead.qualification_status,
    currentScore: context.lead.current_score,
    researchSummary: context.latestResearchSummary,
    icpCriteria: context.icpCriteria,
    campaignObjective: context.campaignObjective,
    businessContext: selectQualificationContext(businessContext),
    client: supabase,
  });

  if (result.ok) {
    const q = result.qualification;
    const reason = [
      q.positiveReasons.length > 0 ? `Positive: ${q.positiveReasons.join("; ")}` : null,
      q.negativeReasons.length > 0 ? `Negative: ${q.negativeReasons.join("; ")}` : null,
    ]
      .filter(Boolean)
      .join(". ");

    await supabase.from("lead_scores").insert({
      organization_id: organizationId,
      lead_id: leadId,
      score: Math.round(q.qualificationScore),
      reason: reason || null,
      scored_by: "agent",
    });
    await supabase
      .from("leads")
      .update({ current_score: Math.round(q.qualificationScore), qualification_status: q.recommendedStatus })
      .eq("id", leadId)
      .eq("organization_id", organizationId);
  }

  return result;
}

/**
 * A lead is never retried forever on a genuinely broken destination (a
 * disconnected number, a permanently rejecting template) — after this many
 * recorded failures for the same lead, the automatic sweep stops trying and
 * leaves it for a human, exactly like a permanently-failed research_status
 * lead already does. Not an arbitrary send *limit*; it only ever gates
 * retries of the same initial message, never anything WhatsApp's own rules
 * already allow.
 */
const MAX_AUTOMATIC_WHATSAPP_ATTEMPTS = 3;

type OutreachSkipReason =
  | "not_found"
  | "already_contacted"
  | "already_sent"
  | "max_attempts_reached"
  | "generation_failed"
  | WhatsAppIneligibleReason;

export type AutomaticOutreachResult =
  | { attempted: true; ok: true; channel: "whatsapp"; messageId: string }
  | { attempted: true; ok: false; channel: "whatsapp"; code: string; message: string }
  | { attempted: false; channel: "gmail_manual" | "none"; reason: OutreachSkipReason };

/**
 * The automatic counterpart to the existing manual outreach flow
 * (generateLeadOutreachAction + sendLeadOutreachAction in leads/actions.ts)
 * — reuses the same AI drafting (generateOutreach), the same conversation/
 * message plumbing (ensureConversation, the messages table), and the same
 * "mark contacted" signal, but decides the channel itself and sends without
 * a human previewing the draft first. Only ever sends WhatsApp; when
 * WhatsApp isn't eligible this never falls back to an automatic email —
 * see selectOutreachChannel's own doc comment for why.
 *
 * Idempotency: leads.status flips to 'contacted' only once Meta has
 * actually confirmed the send (a real message id back), never merely on
 * attempting — so a lead is safe to pass to this function on every
 * scheduled sweep indefinitely. A prior attempt that failed leaves status
 * exactly as it was, so a later sweep retries it automatically, bounded by
 * MAX_AUTOMATIC_WHATSAPP_ATTEMPTS recorded failed messages rather than
 * retrying forever.
 */
export async function sendAutomaticWhatsAppOutreach(supabase: Client, organizationId: string, leadId: string): Promise<AutomaticOutreachResult> {
  const { data: lead } = await supabase.from("leads").select("id, status, campaign_id").eq("id", leadId).eq("organization_id", organizationId).maybeSingle();

  if (!lead) return { attempted: false, channel: "none", reason: "not_found" };
  if (lead.status === "contacted") return { attempted: false, channel: "none", reason: "already_contacted" };

  const campaignRow = lead.campaign_id
    ? (
        await supabase.from("campaigns").select("whatsapp_auto_outreach_enabled").eq("id", lead.campaign_id).eq("organization_id", organizationId).maybeSingle()
      ).data
    : null;

  const identity = await resolveLeadIdentity(supabase, leadId);
  const whatsappConfig = await getWhatsAppAutomationConfig(organizationId);
  const gmailStatus = await getGmailConnectionStatus(organizationId);

  const decision = selectOutreachChannel({
    whatsappEnabledForCampaign: campaignRow?.whatsapp_auto_outreach_enabled ?? true,
    whatsappConnected: whatsappConfig.connected,
    whatsappTemplateConfigured: Boolean(whatsappConfig.templateName),
    phone: identity.phone,
    gmailConnected: gmailStatus.connected,
  });

  if (decision.channel !== "whatsapp") {
    return { attempted: false, channel: decision.channel, reason: decision.whatsappIneligibleReason };
  }
  // Guaranteed non-null by selectOutreachChannel's own eligibility check — reasserted for type safety, not as a second real validation.
  if (!identity.phone) return { attempted: false, channel: "none", reason: "invalid_or_missing_phone" };
  // Stored and sent in the same normalized international-digits form
  // (see whatsapp/phone.ts) — never the raw, inconsistently-formatted
  // string a contact/prospect record happens to have on file.
  const phone = normalizePhoneNumber(identity.phone);

  // Dedup / bounded retry: a "sent" attempt already on file means this lead
  // is done; a growing pile of "failed" ones means stop trying, not keep
  // guessing forever against a destination that keeps rejecting.
  const { data: priorMessages } = await supabase
    .from("messages")
    .select("status, metadata")
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .eq("channel", "whatsapp");

  const initialOutreachAttempts = (priorMessages ?? []).filter(
    (m) => (m.metadata as Record<string, unknown> | null)?.automationKind === "initial_outreach"
  );
  if (initialOutreachAttempts.some((m) => m.status === "sent")) return { attempted: false, channel: "none", reason: "already_sent" };
  if (initialOutreachAttempts.filter((m) => m.status === "failed").length >= MAX_AUTOMATIC_WHATSAPP_ATTEMPTS) {
    return { attempted: false, channel: "none", reason: "max_attempts_reached" };
  }

  const context = await loadLeadContext(supabase, leadId, organizationId);
  if (!context) return { attempted: false, channel: "none", reason: "not_found" };

  const businessContext = await getBusinessContext(organizationId, supabase);
  const { data: latestScore } = await supabase
    .from("lead_scores")
    .select("reason")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const draft = await generateOutreach({
    organizationId,
    leadName: context.leadName,
    companyName: context.companyName,
    channel: "whatsapp",
    campaignName: context.campaignName,
    campaignObjective: context.campaignObjective,
    icpCriteria: context.icpCriteria,
    researchSummary: context.latestResearchSummary,
    qualificationReasons: latestScore?.reason ? [latestScore.reason] : [],
    businessContext: selectOutreachContext(businessContext),
  });

  const agentRun = await createAgentRun(organizationId, "outreach_send", { leadId, channel: "whatsapp", automatic: true } as unknown as Json, supabase);

  if (!draft.ok) {
    await completeAgentRun(agentRun, "failed", { stage: "generation", message: draft.message } as unknown as Json, supabase);
    return { attempted: false, channel: "none", reason: "generation_failed" };
  }

  const conversation = await ensureConversation(supabase, organizationId, leadId, "whatsapp");
  const conversationId = conversation.ok ? conversation.conversationId : null;

  // Reserved before the real send, same pattern as sendLeadOutreachAction —
  // the row exists (with an honest status) regardless of what happens next,
  // so a crash between here and the WhatsApp call can never look like
  // nothing was attempted.
  const { data: reserved, error: reserveError } = await supabase
    .from("messages")
    .insert({
      organization_id: organizationId,
      conversation_id: conversationId,
      lead_id: leadId,
      direction: "outbound",
      channel: "whatsapp",
      sender_type: "agent",
      body: draft.draft.message,
      to_address: phone,
      send_idempotency_key: crypto.randomUUID(),
      metadata: { automationKind: "initial_outreach", aiDrafted: true, templateName: whatsappConfig.templateName } as unknown as Json,
    })
    .select("id")
    .single();

  if (!reserved) {
    await completeAgentRun(agentRun, "failed", { stage: "reserve", message: reserveError?.message } as unknown as Json, supabase);
    return { attempted: true, ok: false, channel: "whatsapp", code: "send_failed", message: reserveError?.message ?? "Could not record this send attempt." };
  }

  const sendResult = await sendWhatsAppTemplateMessage({
    organizationId,
    to: phone,
    templateName: whatsappConfig.templateName as string,
    templateLanguage: whatsappConfig.templateLanguage,
    bodyText: draft.draft.message,
  });

  if (!sendResult.ok) {
    await supabase
      .from("messages")
      .update({
        status: "failed",
        metadata: { automationKind: "initial_outreach", aiDrafted: true, error: sendResult.message, code: sendResult.code } as unknown as Json,
      })
      .eq("id", reserved.id);
    await completeAgentRun(agentRun, "failed", { stage: "send", code: sendResult.code, message: sendResult.message } as unknown as Json, supabase);
    return { attempted: true, ok: false, channel: "whatsapp", code: sendResult.code, message: sendResult.message };
  }

  await supabase
    .from("messages")
    .update({
      status: "sent",
      external_id: sendResult.messageId,
      metadata: { automationKind: "initial_outreach", aiDrafted: true, templateName: whatsappConfig.templateName } as unknown as Json,
    })
    .eq("id", reserved.id);

  if (conversationId) {
    await supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);
  }
  // The dedup gate above and every future sweep's eligibility check both
  // key off this — only ever set once a real provider message id came back.
  await supabase.from("leads").update({ status: "contacted" }).eq("id", leadId).eq("organization_id", organizationId);

  await completeAgentRun(agentRun, "completed", { messageId: sendResult.messageId, channel: "whatsapp" } as unknown as Json, supabase);
  if (agentRun) {
    await recordAgentAction({
      organizationId,
      agentRunId: agentRun.id,
      actionType: "outreach_sent",
      targetEntityType: "lead",
      targetEntityId: leadId,
      payload: { channel: "whatsapp" } as unknown as Json,
      client: supabase,
    });
  }

  return { attempted: true, ok: true, channel: "whatsapp", messageId: sendResult.messageId };
}
