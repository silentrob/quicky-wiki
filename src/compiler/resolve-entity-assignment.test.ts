import { describe, it, expect, vi } from "vitest";
import { KnowledgeStore } from "../graph/store.js";
import type { KnowledgeDiff, LLMAdapter, Source } from "../types.js";
import { resolveKnowledge } from "./resolve.js";

describe("resolveKnowledge entity assignment", () => {
  it("places claims on primary page for resolved entity and includes context in prompt", async () => {
    const store = new KnowledgeStore(":memory:");
    const page = store.addPage(
      "Carol Jones",
      "carol-jones.md",
      "",
      "person",
      {},
    );
    store.syncEntityWithPrimaryPage(page.id);
    const entId = store.getPage(page.id)!.entityId!;
    const primaryPid = store.getPrimaryPageIdForEntity(entId)!;

    const source = store.addSource({
      path: "/tmp/note.md",
      title: "Note",
      type: "note",
      qualityTier: "personal",
      contentHash: "abc",
      ingestedAt: new Date().toISOString(),
      metadata: {},
    });

    const diff: KnowledgeDiff = {
      sourceId: source.id,
      sourceTitle: source.title,
      reinforced: [],
      challenged: [],
      newConcepts: [],
      newClaims: [
        {
          claimId: "",
          statement: "Carol maintains the wiki taxonomy.",
          confidence: 0.85,
          claimType: "fact",
          tags: [],
        },
      ],
      gapsIdentified: [],
    };

    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({ entity: "Carol Jones" }),
      })
      .mockResolvedValueOnce({
        content: "Carol organizes knowledge structures for the team.",
      });

    const llm: LLMAdapter = { chat, name: "mock" };

    await resolveKnowledge(store, llm, diff, source, undefined, {
      sourcePrimaryEntityId: entId,
      sourcePrimaryCanonicalName: "Carol Jones",
      pageKind: "person",
    });

    expect(chat).toHaveBeenCalled();
    const firstUser = chat.mock.calls[0][0][1].content as string;
    expect(firstUser).toContain("Carol Jones");
    expect(firstUser).toContain("primarily about entity");
    expect(firstUser).toContain("person");

    const claims = store.getClaimsByPage(primaryPid);
    expect(claims).toHaveLength(1);
    expect(claims[0].statement).toContain("taxonomy");
  });

  it("falls back to page titles when entity label does not resolve", async () => {
    const store = new KnowledgeStore(":memory:");
    const page = store.addPage(
      "Dana Lee",
      "dana-lee.md",
      "",
      "person",
      {},
    );
    store.syncEntityWithPrimaryPage(page.id);

    const source = store.addSource({
      path: "/tmp/x.md",
      title: "X",
      type: "note",
      qualityTier: "personal",
      contentHash: "def",
      ingestedAt: new Date().toISOString(),
      metadata: {},
    });

    const diff: KnowledgeDiff = {
      sourceId: source.id,
      sourceTitle: source.title,
      reinforced: [],
      challenged: [],
      newConcepts: [],
      newClaims: [
        {
          claimId: "",
          statement: "Quantum flux varies by hour.",
          confidence: 0.7,
          claimType: "fact",
          tags: [],
        },
      ],
      gapsIdentified: [],
    };

    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({ entity: "Totally Unknown Entity" }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ page: "Physics", isNew: true }),
      })
      .mockResolvedValueOnce({
        content: "Page about physical phenomena.",
      });

    const llm: LLMAdapter = { chat, name: "mock" };

    await resolveKnowledge(store, llm, diff, source);

    const physics = store.getPageByTitle("Physics");
    expect(physics).not.toBeNull();
    const claims = store.getClaimsByPage(physics!.id);
    expect(claims).toHaveLength(1);
  });
});
