import type { KnowledgeStore } from "../graph/store.js";
import type { Entity } from "../types.js";

export interface GroundedCatalogOptions {
  /** Max aliases listed per entity (excluding canonical name). Default 5. */
  maxAliasesPerEntity?: number;
  /** Truncate primary page summary per entity. Default 200. */
  maxSummaryCharsPerEntity?: number;
  /** Budget for trimmed metadata snippet per entity. Default 120. */
  maxMetadataCharsPerEntity?: number;
  /** Hard cap on entire catalog string (characters). Default 28000. */
  maxTotalChars?: number;
}

const DEFAULTS: Required<GroundedCatalogOptions> = {
  maxAliasesPerEntity: 5,
  maxSummaryCharsPerEntity: 200,
  maxMetadataCharsPerEntity: 120,
  maxTotalChars: 28000,
};

/** Preferred metadata keys for catalog grounding (first match wins per entity). */
const METADATA_KEYS_BY_TYPE: Record<string, string[]> = {
  person: [
    "importance",
    "cadence",
    "active_topics",
    "last_contact",
    "notable_dates",
  ],
  project: ["status", "priority", "mode", "milestones"],
  place: ["region", "timezone", "coordinates_decimal", "elevation_m"],
  organization: ["industry", "size", "headquarters"],
  life_area: ["focus", "notes"],
  relationship: ["relationship_type", "notes"],
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function trimMetadataSnippet(
  entity: Entity,
  maxChars: number,
): string {
  const meta = entity.metadata;
  if (!meta || typeof meta !== "object" || Object.keys(meta).length === 0) {
    return "";
  }
  const preferred =
    METADATA_KEYS_BY_TYPE[entity.type] ??
    ["status", "priority", "notes", "description"];
  const parts: string[] = [];
  let used = 0;
  const tryKey = (k: string) => {
    if (used >= maxChars) return;
    if (!(k in meta)) return;
    const v = meta[k];
    let fragment: string;
    if (v === null || v === undefined) return;
    if (typeof v === "object") {
      fragment = `${k}: ${truncate(JSON.stringify(v), 80)}`;
    } else {
      fragment = `${k}: ${String(v)}`;
    }
    if (used + fragment.length > maxChars) {
      fragment = truncate(fragment, maxChars - used);
    }
    parts.push(fragment);
    used += fragment.length + 2;
  };
  for (const k of preferred) tryKey(k);
  if (used < maxChars) {
    for (const k of Object.keys(meta).sort()) {
      if (preferred.includes(k)) continue;
      tryKey(k);
      if (parts.length >= 4) break;
    }
  }
  return parts.join("; ");
}

/**
 * Build a single user-message block listing entities with bounded grounding
 * (summary, aliases, metadata) for LLM claim-to-entity assignment.
 */
export function buildGroundedEntityCatalogForAssignment(
  store: KnowledgeStore,
  opts?: GroundedCatalogOptions,
): string {
  const o = { ...DEFAULTS, ...opts };
  const entities = store.listEntities();
  if (entities.length === 0) return "(no entities yet)";

  const ids = entities.map((e) => e.id);
  const aliasesByEntity = store.listAliasesForEntities(ids);
  const summariesByEntity = store.getPrimaryPageSummariesByEntityId(ids);

  const lines: string[] = [];
  let total = 0;

  for (const e of entities) {
    const parts: string[] = [];
    parts.push(`- "${e.canonicalName}" (${e.type}) id:${e.id}`);

    const summary = summariesByEntity.get(e.id);
    if (summary) {
      const s = truncate(summary.trim(), o.maxSummaryCharsPerEntity);
      parts.push(`summary: ${s}`);
    }

    const aliases = (aliasesByEntity.get(e.id) ?? []).filter(
      (a) => a.toLowerCase() !== e.canonicalName.toLowerCase(),
    );
    if (aliases.length > 0) {
      const shown = aliases.slice(0, o.maxAliasesPerEntity);
      const aliasStr = shown.join(", ");
      const extra =
        aliases.length > o.maxAliasesPerEntity
          ? ` (+${aliases.length - o.maxAliasesPerEntity} more)`
          : "";
      parts.push(`aliases: ${aliasStr}${extra}`);
    }

    const metaSnip = trimMetadataSnippet(e, o.maxMetadataCharsPerEntity);
    if (metaSnip) parts.push(`meta: ${metaSnip}`);

    const line = parts.join(" | ");
    if (total + line.length + 1 > o.maxTotalChars) {
      lines.push(
        `… catalog truncated (${entities.length - lines.length} entities not shown)`,
      );
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }

  return lines.join("\n");
}
