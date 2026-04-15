import type { KnowledgeStore } from "../graph/store.js";
import type { LLMAdapter } from "../types.js";
import { parseLLMJson } from "../llm/parse-json.js";

export interface NewClaimRef {
  claimId: string;
  statement: string;
}

/**
 * Second-pass LLM: extract entity–relation triples from new claims, resolve to entity IDs,
 * and persist with provenance (source_claim_id). Symmetric types are canonicalized in the store.
 */
export async function compileRelationsFromClaims(
  store: KnowledgeStore,
  llm: LLMAdapter,
  newClaims: NewClaimRef[],
  _sourceId: string,
): Promise<number> {
  if (newClaims.length === 0) return 0;

  const entities = store.listEntities();
  if (entities.length < 2) return 0;

  const catalog = entities
    .map((e) => `- "${e.canonicalName}" (${e.type})`)
    .join("\n");

  const claimsBlock = newClaims
    .map((c, i) => `${i + 1}. [claim_id:${c.claimId}] ${c.statement}`)
    .join("\n");

  const resp = await llm.chat(
    [
      {
        role: "system",
        content: `You extract typed relations between known entities from factual claims.
Only use entity names that appear in the catalog (exact canonical_name, or a clear alias match).
Use snake_case relation types, e.g.: works_at, reports_to, spouse_of, related_to, parent_of, child_of, collaborates_on, member_of, located_in, depends_on, knows.
For vague "associated with" use related_to. Omit relations you cannot ground in both endpoints.
Respond JSON only:
{ "relations": [ { "from_entity": "Name", "to_entity": "Name", "relation_type": "snake_case", "claim_index": 1, "confidence": 0.0-1.0 } ] }
claim_index refers to the numbered claim in the user list (1-based).`,
      },
      {
        role: "user",
        content: `Entities:\n${catalog}\n\nClaims:\n${claimsBlock}`,
      },
    ],
    { temperature: 0.1, maxTokens: 4096 },
  );

  let parsed: { relations?: any[] };
  try {
    parsed = parseLLMJson(resp.content);
  } catch {
    return 0;
  }

  const rels = parsed.relations;
  if (!Array.isArray(rels) || rels.length === 0) return 0;

  function resolveEntityId(name: string): string | null {
    const n = name.trim();
    if (!n) return null;
    const direct = store.getEntityByCanonicalName(n);
    if (direct) return direct.id;
    const viaAlias = store.resolveEntityAlias(n);
    return viaAlias;
  }

  let added = 0;
  for (const r of rels) {
    const fromName = String(r.from_entity ?? r.from ?? "").trim();
    const toName = String(r.to_entity ?? r.to ?? "").trim();
    const relationType = String(r.relation_type ?? r.relation ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    if (!fromName || !toName || !relationType) continue;
    if (fromName === toName) continue;

    const idx = Number(r.claim_index ?? r.index);
    const claimRef =
      Number.isFinite(idx) && idx >= 1 && idx <= newClaims.length
        ? newClaims[idx - 1]
        : newClaims[0];
    const sourceClaimId = claimRef?.claimId ?? null;

    const fromId = resolveEntityId(fromName);
    const toId = resolveEntityId(toName);
    if (!fromId || !toId) continue;

    const conf =
      typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1
        ? r.confidence
        : 0.75;

    store.addRelation({
      fromEntityId: fromId,
      toEntityId: toId,
      relationType,
      confidence: conf,
      sourceClaimId,
    });
    added += 1;
  }

  return added;
}
