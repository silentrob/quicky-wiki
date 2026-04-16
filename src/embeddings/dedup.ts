import type { KnowledgeStore } from "../graph/store.js";
import type { QuickyConfig } from "../types.js";
import { cosineSimilarity } from "./hybrid-search.js";

export interface DuplicateEntityPair {
  entityIdA: string;
  entityIdB: string;
  canonicalNameA: string;
  canonicalNameB: string;
  similarity: number;
  claimCountA: number;
  claimCountB: number;
}

/**
 * Find same-type entity pairs whose embeddings exceed `similarity` threshold.
 * Skips pairs already linked by canonical/alias overlap.
 */
export function detectDuplicateEntities(
  store: KnowledgeStore,
  config: QuickyConfig,
  opts?: { threshold?: number },
): DuplicateEntityPair[] {
  const threshold = opts?.threshold ?? 0.92;
  const model =
    config.retrieval?.embeddingModel ?? "text-embedding-3-small";
  const rows = store.listEmbeddingRowsForModel(model);
  const byEntity = new Map<string, Float32Array>();
  for (const r of rows) {
    if (r.subjectType !== "entity") continue;
    byEntity.set(r.subjectId, r.vector);
  }

  const entities = store.listEntities();
  const byId = new Map(entities.map((e) => [e.id, e]));
  const byType = new Map<string, typeof entities>();
  for (const e of entities) {
    const list = byType.get(e.type) ?? [];
    list.push(e);
    byType.set(e.type, list);
  }

  const out: DuplicateEntityPair[] = [];
  const seen = new Set<string>();

  for (const group of byType.values()) {
    const ids = group.map((g) => g.id).filter((id) => byEntity.has(id));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const ida = ids[i];
        const idb = ids[j];
        if (store.areEntitiesAlreadyNameLinked(ida, idb)) continue;
        const va = byEntity.get(ida)!;
        const vb = byEntity.get(idb)!;
        const sim = cosineSimilarity(va, vb);
        if (sim < threshold) continue;
        const key = ida < idb ? `${ida}:${idb}` : `${idb}:${ida}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ea = byId.get(ida)!;
        const eb = byId.get(idb)!;
        const ca = store.countClaimsForEntity(ida);
        const cb = store.countClaimsForEntity(idb);
        out.push({
          entityIdA: ida,
          entityIdB: idb,
          canonicalNameA: ea.canonicalName,
          canonicalNameB: eb.canonicalName,
          similarity: sim,
          claimCountA: ca,
          claimCountB: cb,
        });
      }
    }
  }

  return out.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Queue high-similarity pairs as `pending_aliases` for dashboard / confirm merge.
 * Skips pairs already pending. Returns number of rows inserted.
 */
export function queueEntityDuplicatesAsPending(
  store: KnowledgeStore,
  config: QuickyConfig,
  opts?: { threshold?: number },
): number {
  const pairs = detectDuplicateEntities(store, config, opts);
  let n = 0;
  for (const p of pairs) {
    const winner =
      p.claimCountA >= p.claimCountB
        ? { name: p.canonicalNameA }
        : { name: p.canonicalNameB };
    const loser =
      p.claimCountA >= p.claimCountB
        ? { name: p.canonicalNameB }
        : { name: p.canonicalNameA };
    if (store.pendingAliasPairExists(loser.name, winner.name)) continue;
    store.addPendingAlias({
      surfaceForm: loser.name,
      candidateEntityName: winner.name,
      sourceId: null,
    });
    n++;
  }
  return n;
}
