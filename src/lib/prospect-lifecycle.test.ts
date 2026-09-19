import { describe, expect, it } from "vitest";
import { classifyProspectStage, countProspectStages, type ProspectStage } from "@/lib/prospect-lifecycle";

describe("classifyProspectStage", () => {
  it("classifies a freshly discovered prospect (research not started) as new", () => {
    expect(classifyProspectStage({ qualificationStatus: "pending", researchStatus: "pending" })).toBe("new");
  });

  it("classifies a prospect currently being researched as researching", () => {
    expect(classifyProspectStage({ qualificationStatus: "pending", researchStatus: "researching" })).toBe("researching");
  });

  it("classifies a terminal qualified verdict as qualified regardless of research_status", () => {
    expect(classifyProspectStage({ qualificationStatus: "qualified", researchStatus: "completed" })).toBe("qualified");
  });

  it("classifies a terminal disqualified verdict as disqualified", () => {
    expect(classifyProspectStage({ qualificationStatus: "disqualified", researchStatus: "completed" })).toBe("disqualified");
  });

  it("classifies the AI's own 'qualifying' recommendation (could not confidently decide) as needs_review", () => {
    expect(classifyProspectStage({ qualificationStatus: "qualifying", researchStatus: "completed" })).toBe("needs_review");
  });

  it("classifies a failed research pass as needs_review — a real operational failure a human should look at, not a fabricated bucket", () => {
    expect(classifyProspectStage({ qualificationStatus: "pending", researchStatus: "failed" })).toBe("needs_review");
  });

  it("prioritizes a terminal qualification verdict over a research_status that would otherwise suggest a different stage", () => {
    // Qualification only ever runs after research completes, so this is a
    // defensive ordering check, not a state that occurs in steady operation.
    expect(classifyProspectStage({ qualificationStatus: "qualified", researchStatus: "researching" })).toBe("qualified");
  });

  it("falls back to new for the rare transient window where research just completed but qualification has not run yet — never invents a review bucket for this", () => {
    expect(classifyProspectStage({ qualificationStatus: "pending", researchStatus: "completed" })).toBe("new");
  });
});

describe("countProspectStages", () => {
  it("tallies real counts per stage from a real list, never a fabricated total", () => {
    const stages: ProspectStage[] = ["new", "new", "researching", "qualified", "qualified", "qualified", "disqualified", "needs_review"];
    expect(countProspectStages(stages)).toEqual({ new: 2, researching: 1, qualified: 3, disqualified: 1, needs_review: 1 });
  });

  it("returns all-zero counts for an empty list — never a fabricated non-zero count", () => {
    expect(countProspectStages([])).toEqual({ new: 0, researching: 0, qualified: 0, disqualified: 0, needs_review: 0 });
  });
});
