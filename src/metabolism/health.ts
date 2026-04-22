import type { KnowledgeStore } from "../graph/store.js";
import type { HealthReport } from "../types.js";
import { findCascadeRisks } from "../graph/cascade.js";
import { collectOpenIssues } from "./open-issues.js";

export function generateHealthReport(
  store: KnowledgeStore,
  staleThresholdDays: number,
): HealthReport {
  const allClaims = store.listClaims();
  const openIssues = collectOpenIssues(store);
  const now = Date.now();

  const highConfidence = allClaims.filter((c) => c.confidence > 0.8).length;
  const lowConfidence = allClaims.filter((c) => c.confidence < 0.4).length;
  const mediumConfidence = allClaims.length - highConfidence - lowConfidence;

  const staleClaims = allClaims
    .filter((c) => {
      const days = (now - new Date(c.lastReinforced).getTime()) / 86400000;
      return days > staleThresholdDays;
    })
    .map((c) => ({
      claimId: c.id,
      statement: c.statement,
      lastReinforced: c.lastReinforced,
      daysSince: Math.floor(
        (now - new Date(c.lastReinforced).getTime()) / 86400000,
      ),
    }));

  const contestedClaims = openIssues
    .filter((o) => o.kind === "unresolved_contradiction")
    .map((o) => {
      const cid = o.claimIds?.[0];
      const claim = cid ? store.getClaim(cid) : null;
      return {
        claimId: cid ?? "",
        statement: claim?.statement ?? "",
        contradictions: o.contradictingClaimIds?.length ?? 0,
      };
    })
    .filter((r) => r.claimId);

  const cascadeRisks = findCascadeRisks(store)
    .filter((r) => r.dependentCount >= 2)
    .map((r) => ({
      claimId: r.claim.id,
      statement: r.claim.statement,
      dependents: r.dependentCount,
      confidence: r.claim.confidence,
    }));

  const ontology = store.getOntologyHealthSnapshot();

  const suggestedActions: string[] = [];
  if (ontology.pendingAliasCount > 0)
    suggestedActions.push(
      `${ontology.pendingAliasCount} pending alias candidate(s) — review in the portal (Review queue)`,
    );
  if (ontology.staleCompiledViewCount > 8)
    suggestedActions.push(
      `${ontology.staleCompiledViewCount} compiled entity views are stale — open Entities and refresh compiled tabs`,
    );
  if (
    ontology.entityCount > 0 &&
    ontology.entitiesWithPrimaryPage < ontology.entityCount * 0.5
  )
    suggestedActions.push(
      "Many entities lack a linked primary wiki page — check ingest / vault kinds",
    );
  if (staleClaims.length > 5)
    suggestedActions.push(
      `Review ${staleClaims.length} stale claims that haven't been reinforced recently`,
    );
  if (contestedClaims.length > 0)
    suggestedActions.push(
      `Resolve ${contestedClaims.length} contested claims with contradicting evidence`,
    );
  const unsupportedHyp = openIssues.filter(
    (o) => o.kind === "unsupported_hypothesis",
  ).length;
  if (unsupportedHyp > 0)
    suggestedActions.push(
      `${unsupportedHyp} hypothesis claim(s) lack supporting claim links — add evidence or dependencies`,
    );
  if (lowConfidence > allClaims.length * 0.3)
    suggestedActions.push(
      `${lowConfidence} claims have low confidence — consider finding better sources`,
    );
  for (const risk of cascadeRisks.slice(0, 3)) {
    if (risk.confidence < 0.6) {
      suggestedActions.push(
        `Foundational claim "${risk.statement.slice(0, 60)}..." has ${risk.dependents} dependents but only ${(risk.confidence * 100).toFixed(0)}% confidence`,
      );
    }
  }

  return {
    totalClaims: allClaims.length,
    highConfidence,
    mediumConfidence,
    lowConfidence,
    openIssues,
    staleClaims,
    contestedClaims,
    cascadeRisks,
    gaps: [],
    suggestedActions,
    ontology,
  };
}
