import type { KnowledgeStore } from "../graph/store.js";
import type { CompiledViewType, LLMAdapter } from "../types.js";

/**
 * Return cached compiled view or run an LLM pass to fill `compiled_views`.
 */
export async function ensureCompiledView(
  store: KnowledgeStore,
  llm: LLMAdapter,
  entityId: string,
  viewType: CompiledViewType,
  opts?: { force?: boolean },
): Promise<string> {
  const entity = store.getEntity(entityId);
  if (!entity) throw new Error("Entity not found");

  const cached = store.getCompiledView(entityId, viewType);
  if (
    cached &&
    !cached.stale &&
    !opts?.force &&
    cached.body.trim().length > 0
  ) {
    return cached.body;
  }

  const detail = store.getEntityDetail(entityId);
  const claimsText = (detail?.claims ?? [])
    .map((c) => `- (${(c.confidence * 100).toFixed(0)}%) ${c.statement}`)
    .join("\n");
  const relText = (detail?.relations ?? [])
    .map(
      (r) =>
        `- ${r.relationType} ${r.direction === "outbound" ? "→" : "←"} ${r.otherCanonicalName}`,
    )
    .join("\n");

  const prompts: Record<
    CompiledViewType,
    { system: string; user: string }
  > = {
    summary: {
      system:
        "Write one concise paragraph summarizing the entity for a wiki reader. Plain text only, no markdown.",
      user: `Entity: ${entity.canonicalName} (${entity.type})\nMetadata: ${JSON.stringify(entity.metadata)}\nClaims:\n${claimsText || "(none)"}`,
    },
    agent_context: {
      system:
        "Produce a compact bullet list an AI agent can use as grounding context (roles, constraints, key facts). Plain text, max 15 lines.",
      user: `Entity: ${entity.canonicalName} (${entity.type})\nClaims:\n${claimsText || "(none)"}\nRelations:\n${relText || "(none)"}`,
    },
    status_card: {
      system:
        "Write a short status card: current state, blockers, next actions. Plain text, factual.",
      user: `Entity: ${entity.canonicalName}\nMetadata: ${JSON.stringify(entity.metadata)}\nClaims:\n${claimsText || "(none)"}`,
    },
    briefing: {
      system:
        "Week-scoped briefing: what matters now for this entity, 5–8 bullet points. Do not invent dates.",
      user: `Entity: ${entity.canonicalName} (${entity.type})\nClaims:\n${claimsText || "(none)"}\nRelations:\n${relText || "(none)"}`,
    },
  };

  const { system, user } = prompts[viewType];
  const resp = await llm.chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.3, maxTokens: 2048 },
  );
  const body = resp.content.trim();
  store.upsertCompiledView({
    entityId,
    viewType,
    body,
    stale: false,
  });
  return body;
}
