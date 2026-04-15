import { createHash } from "node:crypto";
import type { KnowledgeStore } from "../graph/store.js";
import type { QuickyConfig } from "../types.js";
import {
  fetchOpenAIEmbedding,
  resolveOpenAIKeyForEmbeddings,
} from "./openai-embed.js";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildEntityEmbedText(store: KnowledgeStore, entityId: string): string {
  const detail = store.getEntityDetail(entityId);
  if (!detail) return "";
  const parts: string[] = [
    detail.entity.canonicalName,
    detail.entity.type,
    detail.primaryPage?.summary ?? "",
  ];
  const facts = detail.claims
    .filter(
      (c) => c.claimType === "fact" || c.claimType === "attribute",
    )
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
    .map((c) => c.statement);
  parts.push(...facts);
  return parts.filter(Boolean).join("\n");
}

/**
 * Refresh embeddings for entities and high-value claims (fact, preference, status).
 */
export async function syncEmbeddings(
  store: KnowledgeStore,
  config: QuickyConfig,
): Promise<void> {
  const apiKey = resolveOpenAIKeyForEmbeddings(config);
  if (!apiKey) return;
  const model =
    config.retrieval?.embeddingModel ?? "text-embedding-3-small";

  for (const entity of store.listEntities()) {
    const text = buildEntityEmbedText(store, entity.id).trim();
    if (!text) continue;
    const hash = sha256(text);
    if (store.getEmbeddingRecordHash("entity", entity.id, model) === hash) {
      continue;
    }
    const vec = await fetchOpenAIEmbedding(
      text.slice(0, 8000),
      apiKey,
      model,
    );
    store.upsertEmbedding({
      subjectType: "entity",
      subjectId: entity.id,
      model,
      vector: vec,
      textHash: hash,
    });
  }

  const embedClaimTypes = new Set(["fact", "preference", "status"]);
  for (const claim of store.listClaims()) {
    if (!embedClaimTypes.has(claim.claimType)) continue;
    const text = claim.statement.trim();
    if (!text) continue;
    const hash = sha256(text);
    if (store.getEmbeddingRecordHash("claim", claim.id, model) === hash) {
      continue;
    }
    const vec = await fetchOpenAIEmbedding(
      text.slice(0, 8000),
      apiKey,
      model,
    );
    store.upsertEmbedding({
      subjectType: "claim",
      subjectId: claim.id,
      model,
      vector: vec,
      textHash: hash,
    });
  }
}
