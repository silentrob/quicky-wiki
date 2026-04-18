import { describe, it, expect } from "vitest";
import { KnowledgeStore } from "../graph/store.js";
import { buildGroundedEntityCatalogForAssignment } from "./entity-assignment-catalog.js";

describe("buildGroundedEntityCatalogForAssignment", () => {
  it("includes summary, aliases, and bounded metadata", () => {
    const store = new KnowledgeStore(":memory:");
    const page = store.addPage(
      "Bob Smith",
      "bob-smith.md",
      "Engineer at Acme; focuses on search.",
      "person",
      {},
    );
    store.syncEntityWithPrimaryPage(page.id);
    const updated = store.getPage(page.id);
    const entityId = updated!.entityId!;
    store.addEntityAlias(entityId, "Bobby");
    store.addEntityAlias(entityId, "Robert Smith");
    store.mergeEntityMetadata(
      entityId,
      { importance: "high", cadence: "weekly", noise: "x".repeat(500) },
      null,
    );

    const text = buildGroundedEntityCatalogForAssignment(store, {
      maxMetadataCharsPerEntity: 80,
      maxSummaryCharsPerEntity: 60,
      maxAliasesPerEntity: 3,
    });

    expect(text).toContain("Bob Smith");
    expect(text).toContain("person");
    expect(text).toContain(entityId);
    expect(text).toContain("summary:");
    expect(text).toContain("Engineer at Acme");
    expect(text).toContain("aliases:");
    expect(text).toContain("Bobby");
    expect(text).toContain("meta:");
    expect(text).toContain("importance");
    expect(text.length).toBeLessThan(5000);
  });
});
