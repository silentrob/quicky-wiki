import type { KnowledgeStore } from "../graph/store.js";
import type { OpenIssue } from "../types.js";

export interface CollectOpenIssuesOpts {
  /** Max issues returned after sorting (default 50). */
  maxTotal?: number;
  /** Max issues per kind before merge (default 20). */
  maxPerKind?: number;
  /** Only issues touching this entity (primary page entity, alias candidate, or contradicting claim pages). */
  entityId?: string;
  /** Minimum confidence for unsupported-hypothesis issues (default 0). */
  minHypothesisConfidence?: number;
}

const PRI_ORDER: Record<OpenIssue["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function issueTouchesEntity(
  issue: OpenIssue,
  entityId: string,
): boolean {
  if (!issue.entityIds?.length) return false;
  return issue.entityIds.includes(entityId);
}

/**
 * Collect deterministic open issues: pending aliases, stored claim contradictions,
 * and hypotheses with no claim_dependencies.
 */
export function collectOpenIssues(
  store: KnowledgeStore,
  opts?: CollectOpenIssuesOpts,
): OpenIssue[] {
  const maxTotal = opts?.maxTotal ?? 50;
  const maxPerKind = opts?.maxPerKind ?? 20;
  const minHyp = opts?.minHypothesisConfidence ?? 0;
  const entityFilter = opts?.entityId;

  const byKind: Record<OpenIssue["kind"], OpenIssue[]> = {
    pending_alias: [],
    unresolved_contradiction: [],
    unsupported_hypothesis: [],
  };

  for (const pa of store.listPendingAliases()) {
    const ent = store.getEntityByCanonicalName(pa.candidateEntityName);
    byKind.pending_alias.push({
      kind: "pending_alias",
      priority: "medium",
      summary: `Resolve alias: "${pa.surfaceForm}" → ${pa.candidateEntityName}`,
      pendingAliasId: pa.id,
      entityIds: ent ? [ent.id] : [],
    });
  }

  for (const c of store.listClaims()) {
    if (c.contradictedBy.length === 0) continue;
    const pageId = store.getClaimPageId(c.id);
    const page = pageId ? store.getPage(pageId) : null;
    const entityIds = new Set<string>();
    if (page?.entityId) entityIds.add(page.entityId);
    for (const oid of c.contradictedBy) {
      const pid = store.getClaimPageId(oid);
      const p = pid ? store.getPage(pid) : null;
      if (p?.entityId) entityIds.add(p.entityId);
    }
    byKind.unresolved_contradiction.push({
      kind: "unresolved_contradiction",
      priority: "high",
      summary: `Contested claim (${c.contradictedBy.length} contradicting): ${truncate(c.statement, 120)}`,
      claimIds: [c.id],
      contradictingClaimIds: [...c.contradictedBy],
      entityIds: [...entityIds],
    });
  }

  for (const c of store.listClaims()) {
    if (c.claimType !== "hypothesis") continue;
    if (c.dependsOn.length > 0) continue;
    if (c.confidence < minHyp) continue;
    const page = store.getPage(c.pageId);
    const eid = page?.entityId;
    byKind.unsupported_hypothesis.push({
      kind: "unsupported_hypothesis",
      priority: "medium",
      summary: `Hypothesis without supporting claims: ${truncate(c.statement, 120)}`,
      claimIds: [c.id],
      entityIds: eid ? [eid] : [],
    });
  }

  for (const k of [
    "pending_alias",
    "unresolved_contradiction",
    "unsupported_hypothesis",
  ] as const) {
    byKind[k] = byKind[k].slice(0, maxPerKind);
  }

  let merged: OpenIssue[] = [
    ...byKind.pending_alias,
    ...byKind.unresolved_contradiction,
    ...byKind.unsupported_hypothesis,
  ];

  merged.sort(
    (a, b) => PRI_ORDER[a.priority] - PRI_ORDER[b.priority],
  );

  if (entityFilter) {
    merged = merged.filter((i) => issueTouchesEntity(i, entityFilter));
  }

  return merged.slice(0, maxTotal);
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

/** Plain-text bullets for LLM grounding (entity compiled views). */
export function formatOpenIssuesForPrompt(issues: OpenIssue[]): string {
  if (issues.length === 0) return "(none)";
  return issues
    .map((i, idx) => `${idx + 1}. [${i.kind}] ${i.summary}`)
    .join("\n");
}
