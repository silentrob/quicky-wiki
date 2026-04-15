import type { KnowledgeStore } from "./store.js";
import type { LLMAdapter, QuickyConfig } from "../types.js";
import { parseLLMJson } from "../llm/parse-json.js";
import { hybridSearch, type RetrievalMeta } from "../embeddings/hybrid-search.js";

export interface QueryResult {
  answer: string;
  claimIds: string[];
  confidence: number;
  retrieval: RetrievalMeta;
}

export async function queryKnowledge(
  store: KnowledgeStore,
  llm: LLMAdapter,
  question: string,
  config?: QuickyConfig,
): Promise<QueryResult> {
  const useHybrid = !!(config && config.retrieval?.hybridSearch);
  const t0 = Date.now();

  const searchResult = useHybrid
    ? await hybridSearch(store, question, 50, config!)
    : store.search(question, 50);

  const searchMs = Date.now() - t0;
  const { pages: relevantPages, claims: relevantClaims, relations } = searchResult;
  const hybridMeta = "meta" in searchResult
    ? (searchResult as any).meta as RetrievalMeta
    : undefined;

  // Build context from search results, grouped by page
  const pageMap = new Map<
    string,
    { title: string; claims: typeof relevantClaims }
  >();
  for (const c of relevantClaims) {
    const key = c.pageId ?? "__orphan__";
    if (!pageMap.has(key)) {
      const p = relevantPages.find((p) => p.id === key);
      pageMap.set(key, { title: p?.title ?? "Uncategorized", claims: [] });
    }
    pageMap.get(key)!.claims.push(c);
  }
  // Also add pages with no matching claims but matching titles/summaries
  for (const p of relevantPages) {
    if (!pageMap.has(p.id)) {
      const full = store.getPageFull(p.id);
      if (full) {
        pageMap.set(p.id, {
          title: p.title,
          claims: full.claims.slice(0, 10).map((c: any) => ({
            id: c.id,
            statement: c.statement,
            confidence: c.confidence,
            pageId: p.id,
            type: "claim" as const,
          })),
        });
      }
    }
  }

  const totalClaimsInContext = [...pageMap.values()].reduce(
    (n, g) => n + g.claims.length,
    0,
  );

  const context = [...pageMap.entries()]
    .map(([, { title, claims }]) => {
      if (claims.length === 0) return "";
      const claimLines = claims
        .map(
          (c) =>
            `  - [${((c.confidence ?? 0) * 100).toFixed(0)}%] ${c.statement}`,
        )
        .join("\n");
      return `## ${title}\n${claimLines}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const relationContext =
    relations.length > 0
      ? `\n\n## Graph context (typed entity relations)\n${relations
          .map(
            (r) =>
              `- ${r.from.name} (${r.from.type}) —[${r.relation_type}]→ ${r.to.name} (${r.to.type})`,
          )
          .join("\n")}`
      : "";

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const llmT0 = Date.now();
  const response = await llm.chat(
    [
      {
        role: "system",
        content: `You are a knowledge assistant answering questions from a personal knowledge base.
Today's date is ${today}.
Each claim has a confidence score. Cite specific claims and their confidence levels.
If the knowledge base doesn't contain enough information, say so clearly.
Always be epistemically honest about uncertainty.
When answering questions about ages, durations, or time-relative facts, use today's date for calculations.

Respond in JSON format:
{
  "answer": "Your detailed answer here",
  "relevantClaimIds": ["claim-id-1", "claim-id-2"],
  "overallConfidence": 0.85,
  "caveats": ["any important caveats"]
}`,
      },
      {
        role: "user",
        content: `Knowledge base contents:\n\n${context}${relationContext}\n\nQuestion: ${question}`,
      },
    ],
    { temperature: 0.3 },
  );
  const llmMs = Date.now() - llmT0;

  const claimTypes: Record<string, number> = {};
  for (const c of relevantClaims) {
    const t = (c as any).claimType || "unknown";
    claimTypes[t] = (claimTypes[t] || 0) + 1;
  }
  const entityTypes: Record<string, number> = {};
  for (const p of relevantPages) {
    const full = store.getPage(p.id);
    if (full?.entityId) {
      const kind = (full as any).kind || "unknown";
      entityTypes[kind] = (entityTypes[kind] || 0) + 1;
    }
  }

  const retrieval: RetrievalMeta = {
    strategy: hybridMeta?.strategy ?? "fts5",
    pagesFound: relevantPages.length,
    claimsCandidates: relevantClaims.length,
    claimsInContext: totalClaimsInContext,
    relationsFound: relations.length,
    searchMs,
    llmMs,
    claimTypes: Object.keys(claimTypes).length ? claimTypes : undefined,
    entityTypes: Object.keys(entityTypes).length ? entityTypes : undefined,
    ...(hybridMeta?.embeddingsIndexed != null && {
      embeddingsIndexed: hybridMeta.embeddingsIndexed,
    }),
    ...(hybridMeta?.embeddingModel && {
      embeddingModel: hybridMeta.embeddingModel,
    }),
    ...(hybridMeta?.vectorCandidates != null && {
      vectorCandidates: hybridMeta.vectorCandidates,
    }),
  };

  try {
    const parsed = parseLLMJson(response.content);
    return {
      answer:
        parsed.answer +
        (parsed.caveats?.length
          ? "\n\nCaveats:\n" +
            parsed.caveats.map((c: string) => `- ${c}`).join("\n")
          : ""),
      claimIds: parsed.relevantClaimIds ?? [],
      confidence: parsed.overallConfidence ?? 0.5,
      retrieval,
    };
  } catch {
    return {
      answer: response.content,
      claimIds: [],
      confidence: 0.5,
      retrieval,
    };
  }
}
