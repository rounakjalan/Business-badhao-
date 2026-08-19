import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: fromMock })),
}));

import { executeTool, HERMES_TOOL_DEFINITIONS } from "@/lib/ai/tools/registry";

function leadsTable(row: unknown) {
  return {
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
    }),
  };
}

function dealsTable(row: unknown) {
  return leadsTable(row);
}

describe("HERMES_TOOL_DEFINITIONS", () => {
  it("defines exactly the three read-only lookup tools, each with a description and a JSON-schema parameter object", () => {
    const names = HERMES_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(["lookup_lead", "search_leads", "lookup_deal"]);
    for (const tool of HERMES_TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toHaveProperty("properties");
    }
  });
});

describe("executeTool", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("rejects unparsable tool-call arguments without touching the database", async () => {
    const result = await executeTool("org-1", "lookup_lead", "not json");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("invalid arguments") });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown tool name", async () => {
    const result = await executeTool("org-1", "delete_everything", "{}");
    expect(result).toEqual({ ok: false, error: "unknown tool: delete_everything" });
  });

  it("lookup_lead scopes the query to the given organization and the lead id", async () => {
    const eqSpy = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: async () => ({ data: { id: "lead-1" }, error: null }) }) });
    fromMock.mockReturnValue({ select: () => ({ eq: eqSpy }) });

    const result = await executeTool("org-1", "lookup_lead", JSON.stringify({ leadId: "lead-1" }));

    expect(fromMock).toHaveBeenCalledWith("leads");
    expect(eqSpy).toHaveBeenCalledWith("id", "lead-1");
    expect(result).toEqual({ ok: true, data: { id: "lead-1" } });
  });

  it("lookup_lead returns a not-found error rather than throwing when no row matches", async () => {
    fromMock.mockReturnValue(leadsTable(null));

    const result = await executeTool("org-1", "lookup_lead", JSON.stringify({ leadId: "lead-does-not-exist" }));

    expect(result).toEqual({ ok: false, error: expect.stringContaining("no lead found") });
  });

  it("lookup_lead rejects missing required arguments", async () => {
    const result = await executeTool("org-1", "lookup_lead", JSON.stringify({}));
    expect(result).toEqual({ ok: false, error: expect.stringContaining("invalid arguments") });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("lookup_deal scopes the query to the given organization and the deal id", async () => {
    fromMock.mockReturnValue(dealsTable({ id: "deal-1", title: "Acme Deal" }));

    const result = await executeTool("org-1", "lookup_deal", JSON.stringify({ dealId: "deal-1" }));

    expect(fromMock).toHaveBeenCalledWith("deals");
    expect(result).toEqual({ ok: true, data: { id: "deal-1", title: "Acme Deal" } });
  });

  it("search_leads returns an empty match list rather than an error when nothing matches", async () => {
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          ilike: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
        }),
      }),
    });

    const result = await executeTool("org-1", "search_leads", JSON.stringify({ query: "Nobody" }));

    expect(result).toEqual({ ok: true, data: { matches: [] } });
  });

  it("search_leads joins matching contacts to their lead's status and score", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "contacts") {
        return {
          select: () => ({
            eq: () => ({
              ilike: () => ({
                limit: async () => ({ data: [{ full_name: "Priya Sharma", lead_id: "lead-1" }], error: null }),
              }),
            }),
          }),
        };
      }
      // leads
      return {
        select: () => ({
          in: () => ({
            eq: async () => ({ data: [{ id: "lead-1", status: "qualified", qualification_status: "qualified", current_score: 82 }], error: null }),
          }),
        }),
      };
    });

    const result = await executeTool("org-1", "search_leads", JSON.stringify({ query: "Priya" }));

    expect(result).toEqual({
      ok: true,
      data: { matches: [{ leadId: "lead-1", contactName: "Priya Sharma", status: "qualified", score: 82 }] },
    });
  });
});
