import type { KnowledgeStore } from "../graph/store.js";
import type { QuickyConfig, Claim } from "../types.js";
import {
  fetchOpenAIEmbedding,
  resolveOpenAIKeyForEmbeddings,
} from "./openai-embed.js";

export interface RetrievalMeta {
  strategy: "fts5" | "hybrid" | "hybrid-no-key" | "hybrid-no-embeddings";
  pagesFound: number;
  claimsCandidates: number;
  claimsInContext: number;
  relationsFound: number;
  searchMs: number;
  llmMs?: number;
  embeddingsIndexed?: number;
  embeddingModel?: string;
  vectorCandidates?: number;
  claimTypes?: Record<string, number>;
  entityTypes?: Record<string, number>;
}

interface HybridResult {
  pages: any[];
  claims: any[];
  relations: Array<{
    from: { id: string; name: string; type: string };
    relation_type: string;
    to: { id: string; name: string; type: string };
  }>;
  meta: RetrievalMeta;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-8 ? dot / denom : 0;
}

function baseMeta(
  base: { pages: any[]; claims: any[]; relations: any[] },
  strategy: RetrievalMeta["strategy"],
  extras?: Partial<RetrievalMeta>,
): RetrievalMeta {
  return {
    strategy,
    pagesFound: base.pages.length,
    claimsCandidates: base.claims.length,
    claimsInContext: base.claims.length,
    relationsFound: base.relations.length,
    searchMs: 0,
    ...extras,
  };
}

export async function hybridSearch(
  store: KnowledgeStore,
  query: string,
  limit: number,
  config: QuickyConfig,
): Promise<HybridResult> {
  const ftsCap = Math.max(limit * 4, 48);
  const base = store.search(query, ftsCap);
  const r = config.retrieval ?? {};
  if (!r.hybridSearch)
    return { ...base, meta: baseMeta(base, "fts5") };

  const apiKey = resolveOpenAIKeyForEmbeddings(config);
  const model = r.embeddingModel ?? "text-embedding-3-small";
  if (!apiKey)
    return { ...base, meta: baseMeta(base, "hybrid-no-key") };

  let qVec: Float32Array;
  try {
    qVec = await fetchOpenAIEmbedding(query.slice(0, 8000), apiKey, model);
  } catch {
    return { ...base, meta: baseMeta(base, "hybrid-no-key") };
  }

  const rows = store.listEmbeddingRowsForModel(model);
  if (rows.length === 0)
    return { ...base, meta: baseMeta(base, "hybrid-no-embeddings", { embeddingModel: model, embeddingsIndexed: 0 }) };

  const wFts = r.wFts ?? 0.35;
  const wVec = r.wVec ?? 0.35;
  const wConf = r.wConf ?? 0.15;
  const wRec = r.wRec ?? 0.1;
  const wType = r.wType ?? 0.05;

  const vecScores = new Map<string, number>();
  for (const row of rows) {
    if (row.subjectType !== "claim" && row.subjectType !== "entity") continue;
    const key = `${row.subjectType}:${row.subjectId}`;
    const sim = cosineSimilarity(qVec, row.vector);
    vecScores.set(key, Math.max(vecScores.get(key) ?? -2, sim));
  }

  const ftsClaimRank = new Map<string, number>();
  base.claims.forEach((c, i) =>
    ftsClaimRank.set(c.id, 1 - i / Math.max(base.claims.length, 1)),
  );

  const claimIds = new Set<string>();
  for (const c of base.claims) claimIds.add(c.id);
  for (const [k, v] of vecScores) {
    if (!k.startsWith("claim:")) continue;
    if (v > 0.22) claimIds.add(k.slice(6));
  }

  const now = Date.now();
  function recency(iso: string): number {
    const t = new Date(iso).getTime();
    const days = (now - t) / 86400000;
    return Math.max(0, 1 - days / 120);
  }

  const scored = [...claimIds]
    .map((cid) => {
      const claim = store.getClaim(cid);
      if (!claim) return null;
      const page = store.getPage(claim.pageId);
      const ftsS = ftsClaimRank.get(cid) ?? 0;
      const vecS = vecScores.get("claim:" + cid) ?? 0;
      const hybrid =
        wFts * ftsS +
        wVec * vecS +
        wConf * claim.confidence +
        wRec * recency(claim.lastReinforced) +
        wType * (page?.entityId ? 1 : 0);
      return { claim, hybrid };
    })
    .filter(Boolean) as Array<{ claim: Claim; hybrid: number }>;

  scored.sort((a, b) => b.hybrid - a.hybrid);
  const topClaims = scored.slice(0, limit).map(({ claim }) => ({
    id: claim.id,
    statement: claim.statement,
    pageId: claim.pageId,
    confidence: claim.confidence,
    claimType: claim.claimType,
    type: "claim" as const,
  }));

  const pageIds = new Set<string>();
  for (const p of base.pages) pageIds.add(p.id);
  for (const c of topClaims) pageIds.add(c.pageId);
  for (const [k, v] of vecScores) {
    if (!k.startsWith("entity:") || v <= 0.28) continue;
    const pid = store.getPrimaryPageIdForEntity(k.slice(7));
    if (pid) pageIds.add(pid);
  }

  const pagesOut = [...pageIds]
    .map((pid) => {
      const p = store.getPage(pid);
      if (!p) return null;
      return {
        id: p.id,
        title: p.title,
        summary: p.summary,
        type: "page" as const,
      };
    })
    .filter(Boolean) as typeof base.pages;

  pagesOut.sort((a, b) => a.title.localeCompare(b.title));

  return {
    pages: pagesOut.slice(0, limit),
    claims: topClaims,
    relations: base.relations,
    meta: {
      strategy: "hybrid",
      pagesFound: pagesOut.length,
      claimsCandidates: scored.length,
      claimsInContext: topClaims.length,
      relationsFound: base.relations.length,
      searchMs: 0,
      embeddingsIndexed: rows.length,
      embeddingModel: model,
      vectorCandidates: vecScores.size,
    },
  };
}
