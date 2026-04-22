import { describe, it, expect } from "vitest";
import { KnowledgeStore } from "../graph/store.js";
import { collectOpenIssues } from "./open-issues.js";

describe("collectOpenIssues", () => {
  it("collects pending aliases, contradictions, and unsupported hypotheses", () => {
    const store = new KnowledgeStore(":memory:");
    const src = store.addSource({
      path: "raw/t.md",
      title: "t",
      type: "note",
      qualityTier: "personal",
      contentHash: "x",
      ingestedAt: new Date().toISOString(),
      metadata: {},
    });

    const pageA = store.addPage("Alice", "alice.md", "", "person", {});
    store.syncEntityWithPrimaryPage(pageA.id);

    const pageB = store.addPage("Bob", "bob.md", "", "person", {});
    store.syncEntityWithPrimaryPage(pageB.id);

    store.addPendingAlias({
      surfaceForm: "Ali",
      candidateEntityName: "Alice",
    });

    const h = store.addClaim({
      statement: "Maybe X causes Y",
      pageId: pageA.id,
      confidence: 0.7,
      sourceIds: [src.id],
      claimType: "hypothesis",
    });

    const c1 = store.addClaim({
      statement: "Sky is blue",
      pageId: pageA.id,
      confidence: 0.9,
      sourceIds: [src.id],
    });
    const c2 = store.addClaim({
      statement: "Sky is not blue",
      pageId: pageB.id,
      confidence: 0.85,
      sourceIds: [src.id],
    });
    store.addClaimContradiction(c1.id, c2.id);

    const issues = collectOpenIssues(store);
    expect(issues.some((i) => i.kind === "pending_alias")).toBe(true);
    expect(issues.some((i) => i.pendingAliasId)).toBe(true);

    const contra = issues.filter((i) => i.kind === "unresolved_contradiction");
    expect(contra.length).toBeGreaterThan(0);
    expect(contra[0].claimIds).toContain(c1.id);
    expect(contra[0].contradictingClaimIds).toContain(c2.id);

    const hyp = issues.filter((i) => i.kind === "unsupported_hypothesis");
    expect(hyp.some((i) => i.claimIds?.includes(h.id))).toBe(true);
  });

  it("filters by entityId", () => {
    const store = new KnowledgeStore(":memory:");
    const src = store.addSource({
      path: "raw/u.md",
      title: "u",
      type: "note",
      qualityTier: "personal",
      contentHash: "y",
      ingestedAt: new Date().toISOString(),
      metadata: {},
    });

    const pageA = store.addPage("Carol", "carol.md", "", "person", {});
    store.syncEntityWithPrimaryPage(pageA.id);
    const entA = store.getPage(pageA.id)!.entityId!;

    const pageB = store.addPage("Dan", "dan.md", "", "person", {});
    store.syncEntityWithPrimaryPage(pageB.id);

    store.addPendingAlias({
      surfaceForm: "Cee",
      candidateEntityName: "Carol",
    });

    store.addClaim({
      statement: "H1",
      pageId: pageB.id,
      confidence: 0.8,
      sourceIds: [src.id],
      claimType: "hypothesis",
    });

    const forA = collectOpenIssues(store, { entityId: entA });
    expect(forA.some((i) => i.kind === "pending_alias")).toBe(true);
    expect(forA.some((i) => i.kind === "unsupported_hypothesis")).toBe(false);
  });
});
