import type { KnowledgeStore } from "../graph/store.js";
import type {
  LLMAdapter,
  Source,
  KnowledgeDiff,
  QuickyConfig,
  ResolveKnowledgeContext,
} from "../types.js";
import { propagateCascade } from "../graph/cascade.js";
import { parseLLMJson } from "../llm/parse-json.js";
import { buildGroundedEntityCatalogForAssignment } from "./entity-assignment-catalog.js";

export async function resolveKnowledge(
  store: KnowledgeStore,
  llm: LLMAdapter,
  diff: KnowledgeDiff,
  source: Source,
  config?: QuickyConfig,
  resolveContext?: ResolveKnowledgeContext,
): Promise<{ relationsCompiled: number }> {
  let relationsCompiled = 0;
  // 1. Reinforce existing claims
  for (const r of diff.reinforced) {
    store.reinforceClaim(
      r.claimId,
      source.id,
      r.confidenceAfter,
      `Reinforced by ${source.title}`,
    );
  }

  // 2. Challenge existing claims + cascade
  for (const c of diff.challenged) {
    store.challengeClaim(c.claimId, source.id, c.confidenceAfter, c.reason);
    const delta = c.confidenceAfter - c.confidenceBefore;
    propagateCascade(store, c.claimId, delta);
  }

  // 3. Create new concept pages + link them
  for (const nc of diff.newConcepts) {
    const existing = store.getPageByTitle(nc.title);
    if (!existing) {
      const path = titleToPath(nc.title);
      try {
        const page = store.addPage(nc.title, path);
        nc.pageId = page.id;
      } catch {
        // Path collision — find existing page with that path
        const byPath = store.listPages().find((p) => p.path === path);
        if (byPath) {
          nc.pageId = byPath.id;
        } else {
          const page = store.addPage(
            nc.title,
            path.replace(".md", `-${Date.now()}.md`),
          );
          nc.pageId = page.id;
        }
      }
    } else {
      nc.pageId = existing.id;
    }
  }

  // Wire up concept links (linkedTo contains page titles)
  for (const nc of diff.newConcepts) {
    for (const linkedTitle of nc.linkedTo) {
      const target = store.getPageByTitle(linkedTitle);
      if (target && target.id !== nc.pageId) {
        store.addPageLink(nc.pageId, target.id);
      }
    }
  }

  // 4. Add new claims + create page links between claim pages
  const claimPageIds: string[] = [];
  const batchSize = 8;
  const useEntityAssignment = store.listEntities().length > 0;

  for (let i = 0; i < diff.newClaims.length; i += batchSize) {
    const batch = diff.newClaims.slice(i, i + batchSize);
    const statements = batch.map((nc) => nc.statement);

    if (useEntityAssignment) {
      const labels = await batchAssignClaimsToEntities(
        llm,
        statements,
        store,
        resolveContext,
      );
      for (let j = 0; j < batch.length; j++) {
        const nc = batch[j];
        const label = (labels[j] ?? "").trim();
        let pageId: string | null = label
          ? resolveEntityLabelToPageId(store, label)
          : null;
        // Plan (a): non-catalog / unresolvable entity → page-title assignment for this claim only
        if (!pageId) {
          const titles = await batchAssignClaimsToPages(
            llm,
            [nc.statement],
            store,
          );
          const page = ensurePageForTitle(store, titles[0]);
          pageId = page.id;
        }
        const claim = store.addClaim({
          statement: nc.statement,
          pageId,
          confidence: nc.confidence,
          sourceIds: [source.id],
          tags: nc.tags ?? [],
          claimType: nc.claimType,
        });
        nc.claimId = claim.id;
        claimPageIds.push(pageId);
      }
    } else {
      const assignments = await batchAssignClaimsToPages(llm, statements, store);
      for (let j = 0; j < batch.length; j++) {
        const nc = batch[j];
        const page = ensurePageForTitle(store, assignments[j]);
        const claim = store.addClaim({
          statement: nc.statement,
          pageId: page.id,
          confidence: nc.confidence,
          sourceIds: [source.id],
          tags: nc.tags ?? [],
          claimType: nc.claimType,
        });
        nc.claimId = claim.id;
        claimPageIds.push(page.id);
      }
    }
  }

  const newClaimRefs = diff.newClaims
    .filter((nc) => nc.claimId)
    .map((nc) => ({ claimId: nc.claimId, statement: nc.statement }));
  if (newClaimRefs.length > 0) {
    try {
      const { compileRelationsFromClaims } = await import(
        "./relation-compiler.js"
      );
      relationsCompiled = await compileRelationsFromClaims(
        store,
        llm,
        newClaimRefs,
        source.id,
      );
    } catch {
      // Relation extraction is best-effort
    }
  }

  // Link all pages that share the same source (co-citation linking)
  const uniquePageIds = [...new Set(claimPageIds)];
  for (let i = 0; i < uniquePageIds.length; i++) {
    for (let j = i + 1; j < uniquePageIds.length; j++) {
      store.addPageLink(uniquePageIds[i], uniquePageIds[j]);
      store.addPageLink(uniquePageIds[j], uniquePageIds[i]);
    }
  }

  // Generate summaries for pages that were touched
  const touchedPageIds = new Set<string>(uniquePageIds);
  for (const r of diff.reinforced) {
    const pageId = store.getClaimPageId(r.claimId);
    if (pageId) touchedPageIds.add(pageId);
  }
  for (const c of diff.challenged) {
    const pageId = store.getClaimPageId(c.claimId);
    if (pageId) touchedPageIds.add(pageId);
  }
  // Also summarize all pages that still lack a summary
  for (const pid of store.listPagesWithoutSummary()) {
    touchedPageIds.add(pid);
  }
  await generatePageSummaries(store, llm, [...touchedPageIds]);

  if (config) {
    try {
      const { syncEmbeddings } = await import("../embeddings/sync.js");
      await syncEmbeddings(store, config);
    } catch {
      // Embeddings are optional (missing API key, network, etc.)
    }
  }

  return { relationsCompiled };
}

function formatResolveContextHint(ctx?: ResolveKnowledgeContext): string {
  if (!ctx) return "";
  const parts: string[] = [];
  if (ctx.sourcePrimaryCanonicalName || ctx.sourcePrimaryEntityId) {
    parts.push(
      `This source is primarily about entity "${ctx.sourcePrimaryCanonicalName ?? "unknown"}"` +
        (ctx.sourcePrimaryEntityId
          ? ` (id: ${ctx.sourcePrimaryEntityId})`
          : "") +
        ".",
    );
  }
  if (ctx.pageKind) {
    parts.push(`Source page kind: ${ctx.pageKind}.`);
  }
  if (parts.length > 0) {
    parts.push(
      "Claims that are mainly about this primary subject should be assigned to that entity when it appears in the catalog.",
    );
  }
  return parts.join(" ");
}

function resolveEntityLabelToPageId(
  store: KnowledgeStore,
  label: string,
): string | null {
  const raw = label.trim();
  if (!raw) return null;
  const uuidLike =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      raw,
    );
  if (uuidLike) {
    const ent = store.getEntity(raw);
    if (ent) return store.getPrimaryPageIdForEntity(ent.id);
  }
  const byName = store.getEntityByCanonicalName(raw);
  if (byName) return store.getPrimaryPageIdForEntity(byName.id);
  const byAlias = store.resolveEntityAlias(raw);
  if (byAlias) return store.getPrimaryPageIdForEntity(byAlias);
  return null;
}

async function batchAssignClaimsToEntities(
  llm: LLMAdapter,
  statements: string[],
  store: KnowledgeStore,
  resolveContext?: ResolveKnowledgeContext,
): Promise<string[]> {
  const catalog = buildGroundedEntityCatalogForAssignment(store);
  const ctxHint = formatResolveContextHint(resolveContext);
  const prefix = ctxHint ? `Instructions:\n${ctxHint}\n\n` : "";

  if (statements.length === 1) {
    const resp = await llm.chat(
      [
        {
          role: "system",
          content: `You assign a factual claim to the ONE entity the claim is MAINLY about. Pick only from the Entities list (match canonical name, id, or listed alias).
Respond JSON only: { "entity": "canonical name from list", "entity_id": "optional uuid if known" }`,
        },
        {
          role: "user",
          content: `${prefix}Entities:\n${catalog}\n\nClaim:\n${statements[0]}`,
        },
      ],
      { temperature: 0.2 },
    );
    try {
      const parsed = parseLLMJson(resp.content);
      const id = String(parsed.entity_id ?? "").trim();
      const name = String(parsed.entity ?? "").trim();
      return [id || name || ""];
    } catch {
      return [""];
    }
  }

  const numberedClaims = statements.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const resp = await llm.chat(
    [
      {
        role: "system",
        content: `You assign each factual claim to the ONE entity that claim is MAINLY about. Use only entities from the catalog (canonical name, id, or listed alias).
Respond JSON only: { "assignments": [ { "index": 1, "entity": "canonical name", "entity_id": "optional" } ] }`,
      },
      {
        role: "user",
        content: `${prefix}Entities:\n${catalog}\n\nClaims:\n${numberedClaims}`,
      },
    ],
    { temperature: 0.2 },
  );

  try {
    const parsed = parseLLMJson(resp.content);
    const assignments = parsed.assignments as {
      index: number;
      entity?: string;
      entity_id?: string;
    }[];
    const result: string[] = [];
    for (let i = 0; i < statements.length; i++) {
      const match = assignments?.find((a) => a.index === i + 1);
      const id = String(match?.entity_id ?? "").trim();
      const name = String(match?.entity ?? "").trim();
      result.push(id || name || "");
    }
    return result;
  } catch {
    return statements.map(() => "");
  }
}

function ensurePageForTitle(store: KnowledgeStore, pageTitle: string) {
  let page = store.getPageByTitle(pageTitle);
  if (!page) {
    const path = titleToPath(pageTitle);
    try {
      page = store.addPage(pageTitle, path);
    } catch {
      const existing = store.listPages().find((p) => p.path === path);
      page = existing ?? store.addPage(pageTitle, path + "-" + Date.now() + ".md");
    }
  }
  return page;
}

export async function generatePageSummaries(
  store: KnowledgeStore,
  llm: LLMAdapter,
  pageIds: string[],
): Promise<void> {
  // Process in parallel with concurrency limit of 3
  const concurrency = 3;
  const queue = [...pageIds];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const pageId = queue.shift()!;
      const page = store.getPage(pageId);
      if (!page) continue;
      const claims = store.getClaimsByPage(pageId);
      if (claims.length === 0) continue;

      const claimList = claims
        .map((c) => `- (${(c.confidence * 100).toFixed(0)}%) ${c.statement}`)
        .join("\n");

      try {
        const resp = await llm.chat([
          {
            role: "system",
            content:
              "You are a wiki editor. Given a page title and its claims, write a single concise summary sentence (max 30 words) that captures the essence of the page. Respond with just the summary sentence, nothing else.",
          },
          {
            role: "user",
            content: `Page: "${page.title}"\n\nClaims:\n${claimList}`,
          },
        ]);

        const summary = resp.content.trim().replace(/^["']|["']$/g, "");
        if (summary && summary.length > 5) {
          store.updatePageSummary(pageId, summary);
        }
      } catch {
        // Non-critical — skip summary on failure
      }
    }
  });
  await Promise.allSettled(workers);
}

async function batchAssignClaimsToPages(
  llm: LLMAdapter,
  statements: string[],
  store: KnowledgeStore,
): Promise<string[]> {
  const existingPages = store.listPageTitles();
  const pageTitles = existingPages.map((p) => p.title);

  if (statements.length === 1) {
    // Single claim — simpler prompt
    if (pageTitles.length === 0) {
      const resp = await llm.chat(
        [
          {
            role: "system",
            content: `Given a claim, suggest a concise wiki page title (1-4 words) it belongs to. Respond with just the title, nothing else.`,
          },
          { role: "user", content: statements[0] },
        ],
        { temperature: 0.2 },
      );
      return [resp.content.trim().replace(/['"]/g, "")];
    }
    const resp = await llm.chat(
      [
        {
          role: "system",
          content: `Given a claim and a list of existing wiki pages, either assign it to an existing page or suggest a new page title.
Respond in JSON: { "page": "Page Title", "isNew": false }`,
        },
        {
          role: "user",
          content: `Existing pages: ${pageTitles.join(", ")}\n\nClaim: ${statements[0]}`,
        },
      ],
      { temperature: 0.2 },
    );
    try {
      const parsed = parseLLMJson(resp.content);
      return [parsed.page || pageTitles[0]];
    } catch {
      return [pageTitles[0] || "General"];
    }
  }

  // Batch: multiple claims in one call
  const numberedClaims = statements.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const resp = await llm.chat(
    [
      {
        role: "system",
        content: `Given multiple claims and a list of existing wiki pages, assign each claim to an existing page or suggest a new title.
Respond in JSON: { "assignments": [{"index": 1, "page": "Page Title"}] }`,
      },
      {
        role: "user",
        content: `Existing pages: ${pageTitles.length > 0 ? pageTitles.join(", ") : "(none yet)"}\n\nClaims:\n${numberedClaims}`,
      },
    ],
    { temperature: 0.2 },
  );

  try {
    const parsed = parseLLMJson(resp.content);
    const assignments = parsed.assignments as { index: number; page: string }[];
    const result: string[] = [];
    for (let i = 0; i < statements.length; i++) {
      const match = assignments?.find((a) => a.index === i + 1);
      result.push(match?.page || pageTitles[0] || "General");
    }
    return result;
  } catch {
    // Fallback: assign all to first page
    return statements.map(() => pageTitles[0] || "General");
  }
}

function titleToPath(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") + ".md"
  );
}
