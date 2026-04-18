import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import matter from "gray-matter";
import type { KnowledgeStore } from "../graph/store.js";
import { ENTITY_PAGE_KINDS } from "../graph/store.js";
import type {
  LLMAdapter,
  Source,
  SourceType,
  QualityTier,
  KnowledgeDiff,
  QuickyConfig,
  ClaimType,
  ResolveKnowledgeContext,
} from "../types.js";
import { normalizeClaimType } from "../types.js";
import { scoreConfidence } from "./confidence.js";
import { computeKnowledgeDiff } from "./diff.js";
import { resolveKnowledge } from "./resolve.js";
import { parseLLMJson } from "../llm/parse-json.js";

export type IngestProgress = (step: string, detail?: string) => void;

export type IngestSourceOptions = {
  type?: SourceType;
  qualityTier?: QualityTier;
  onProgress?: IngestProgress;
  /** Project config: kind rules, entity extraction prompts */
  config?: QuickyConfig;
  /** Force page kind (e.g. MCP override) */
  kind?: string;
  /** Merge into page metadata_json (e.g. MCP override) */
  metadata?: Record<string, unknown>;
};

/** Diff plus optional pipeline stats returned after `resolveKnowledge`. */
export type IngestResult = KnowledgeDiff & {
  relationsCompiled?: number;
  /** Entity IDs whose primary pages received new or updated claims in this ingest (best-effort). */
  affectedEntityIds?: string[];
};

export type IngestRawMarkdownOptions = IngestSourceOptions & {
  /** When false, skip gray-matter parsing (body = full string, empty frontmatter). Default: true if path ends with .md/.mdx or content starts with `---`. */
  parseMarkdown?: boolean;
};

/**
 * First matching kindRules entry wins. Rules use path substring match, or
 * `type:value` matched against frontmatter `type`. If no rule matches but
 * `frontmatter.type` is set, that string becomes the kind. Default: `topic`.
 */
export function inferPageKind(
  filePath: string,
  frontmatter: Record<string, unknown>,
  kindRules?: Array<{ pattern: string; kind: string }>,
): string {
  const rules = kindRules ?? [];
  const pathNorm = filePath.replace(/\\/g, "/");
  const fmType = frontmatter.type;

  for (const { pattern, kind } of rules) {
    if (pattern.startsWith("type:")) {
      const want = pattern.slice(5);
      if (fmType != null && String(fmType) === want) return kind;
    } else if (pathNorm.includes(pattern)) {
      return kind;
    }
  }

  if (fmType != null && String(fmType).length > 0) {
    return String(fmType);
  }
  return "topic";
}

const TITLE_PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

function applyPrimaryTitleTemplate(
  template: string,
  frontmatter: Record<string, unknown>,
  stem: string,
): string {
  const out = template.replace(TITLE_PLACEHOLDER_RE, (_, rawKey: string) => {
    const key = rawKey.trim();
    if (key === "stem" || key === "sourceTitle") return stem;
    const v = frontmatter[key];
    if (v != null && String(v).trim() !== "") return String(v).trim();
    return stem;
  });
  const t = out.trim();
  return t || stem;
}

/**
 * Wiki graph title for the primary entity page for this source.
 * Optional `config.primaryPageTitleRules` supplies per-kind templates; otherwise uses
 * `name` / `title` from frontmatter, then the file-derived `sourceTitle`.
 */
export function resolvePrimaryPageTitle(
  kind: string,
  frontmatter: Record<string, unknown>,
  sourceTitle: string,
  config?: QuickyConfig,
): string {
  const rules = config?.primaryPageTitleRules ?? [];
  for (const rule of rules) {
    if (rule.kind === kind && rule.template?.trim()) {
      return applyPrimaryTitleTemplate(
        rule.template.trim(),
        frontmatter,
        sourceTitle,
      );
    }
  }

  const n = frontmatter.name ?? frontmatter.title;
  if (n != null && String(n).trim()) {
    return String(n).trim();
  }
  if (frontmatter.title != null && String(frontmatter.title).trim()) {
    return String(frontmatter.title).trim();
  }
  return sourceTitle;
}

function titleToWikiPath(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") + ".md"
  );
}

function cloneMetadata(
  frontmatter: Record<string, unknown>,
  override?: Record<string, unknown>,
): Record<string, unknown> {
  const base = JSON.parse(JSON.stringify(frontmatter)) as Record<
    string,
    unknown
  >;
  return { ...base, ...(override ?? {}) };
}

/** Ensure the primary wiki page for this source has kind + metadata (frontmatter authoritative). */
function syncPrimaryPageEntity(
  store: KnowledgeStore,
  pageTitle: string,
  kind: string,
  metadata: Record<string, unknown>,
): void {
  let page = store.getPageByTitle(pageTitle);
  if (!page) {
    const path = titleToWikiPath(pageTitle);
    try {
      const p = store.addPage(pageTitle, path, "", kind, metadata);
      store.syncEntityWithPrimaryPage(p.id);
    } catch {
      const byPath = store.listPages().find((p) => p.path === path);
      if (byPath) {
        store.updatePageKind(byPath.id, kind);
        store.updatePageMetadata(byPath.id, metadata);
        store.syncEntityWithPrimaryPage(byPath.id);
      } else {
        const p = store.addPage(
          pageTitle,
          path.replace(".md", `-${Date.now()}.md`),
          "",
          kind,
          metadata,
        );
        store.syncEntityWithPrimaryPage(p.id);
      }
    }
    return;
  }
  store.updatePageKind(page.id, kind);
  store.updatePageMetadata(page.id, metadata);
  store.syncEntityWithPrimaryPage(page.id);
}

function collectAffectedEntityIds(
  store: KnowledgeStore,
  diff: KnowledgeDiff,
): string[] {
  const ids = new Set<string>();
  const addForClaim = (claimId: string) => {
    const pageId = store.getClaimPageId(claimId);
    if (!pageId) return;
    const page = store.getPage(pageId);
    if (page?.entityId) ids.add(page.entityId);
  };
  for (const nc of diff.newClaims) {
    if (nc.claimId) addForClaim(nc.claimId);
  }
  for (const r of diff.reinforced) {
    if (r.claimId) addForClaim(r.claimId);
  }
  for (const c of diff.challenged) {
    if (c.claimId) addForClaim(c.claimId);
  }
  return [...ids];
}

function shouldParseMarkdown(
  virtualPath: string,
  raw: string,
  explicit?: boolean,
): boolean {
  if (explicit === false) return false;
  if (explicit === true) return true;
  const ext = extname(virtualPath).toLowerCase();
  if (ext === ".md" || ext === ".mdx") return true;
  return raw.trimStart().startsWith("---");
}

function defaultTitleFromPath(virtualPath: string): string {
  const base = basename(virtualPath, extname(virtualPath));
  if (base && base !== virtualPath) return base;
  const parts = virtualPath.split(/[:/\\]/).filter(Boolean);
  return parts[parts.length - 1] || "Source";
}

/**
 * Ingest markdown (or plain text) from memory using a stable virtual `sources.path`
 * (e.g. `pulse:conversation:<sessionId>:<YYYY-MM-DD>`). Same pipeline as {@link ingestSource}.
 */
export async function ingestRawMarkdown(
  store: KnowledgeStore,
  llm: LLMAdapter,
  virtualPath: string,
  rawMarkdown: string,
  opts?: IngestRawMarkdownOptions,
): Promise<IngestResult> {
  const progress = opts?.onProgress ?? (() => {});
  const contentHash = createHash("sha256").update(rawMarkdown).digest("hex");

  const parseMd = shouldParseMarkdown(
    virtualPath,
    rawMarkdown,
    opts?.parseMarkdown,
  );
  let content = rawMarkdown;
  let frontmatter: Record<string, unknown> = {};
  if (parseMd) {
    const parsed = matter(rawMarkdown);
    content = parsed.content;
    frontmatter = parsed.data;
  }

  const title =
    (frontmatter.title as string) || defaultTitleFromPath(virtualPath);

  const resolvedKind =
    opts?.kind ??
    inferPageKind(virtualPath, frontmatter, opts?.config?.kindRules);
  const pageMetadata = cloneMetadata(frontmatter, opts?.metadata);
  const primaryPageTitle = resolvePrimaryPageTitle(
    resolvedKind,
    pageMetadata,
    title,
    opts?.config,
  );

  const existing = store.getSourceByPath(virtualPath);
  if (existing && existing.contentHash === contentHash) {
    syncPrimaryPageEntity(store, primaryPageTitle, resolvedKind, pageMetadata);
    return {
      sourceId: existing.id,
      sourceTitle: existing.title,
      reinforced: [],
      challenged: [],
      newConcepts: [],
      newClaims: [],
      gapsIdentified: [],
      affectedEntityIds: [],
    };
  }

  const type = opts?.type || inferSourceType(virtualPath, frontmatter);
  const qualityTier =
    opts?.qualityTier ?? inferQuality(frontmatter, opts?.config);

  let source: Source;
  if (existing) {
    store.updateSourceHash(existing.id, contentHash);
    source = { ...existing, contentHash };
  } else {
    source = store.addSource({
      path: virtualPath,
      title,
      type,
      qualityTier,
      contentHash,
      ingestedAt: new Date().toISOString(),
      metadata: frontmatter,
    });
  }

  const extractCtx = {
    pageKind: resolvedKind,
    entityPrompts: opts?.config?.entityPrompts,
    author: opts?.config?.author,
  };

  progress("extracting", `Extracting claims from "${title}"...`);
  const { claims: extractedClaims, entityMetadata } = await extractClaims(
    llm,
    content,
    title,
    source,
    extractCtx,
    store,
  );
  progress("extracted", `Found ${extractedClaims.length} claims`);

  progress("diffing", `Comparing against existing knowledge...`);
  const diff = await computeKnowledgeDiff(store, llm, source, extractedClaims);
  progress(
    "diffed",
    `${diff.newClaims.length} new, ${diff.reinforced.length} reinforced, ${diff.challenged.length} challenged`,
  );

  syncPrimaryPageEntity(store, primaryPageTitle, resolvedKind, pageMetadata);

  const primaryPageAfterSync = store.getPageByTitle(primaryPageTitle);
  let sourcePrimaryCanonicalName: string | undefined;
  if (primaryPageAfterSync?.entityId) {
    const ent = store.getEntity(primaryPageAfterSync.entityId);
    sourcePrimaryCanonicalName = ent?.canonicalName;
  }
  const resolveContext: ResolveKnowledgeContext = {
    sourcePrimaryEntityId: primaryPageAfterSync?.entityId ?? undefined,
    sourcePrimaryCanonicalName,
    pageKind: resolvedKind,
  };

  progress("resolving", `Resolving knowledge graph...`);
  const { relationsCompiled } = await resolveKnowledge(
    store,
    llm,
    diff,
    source,
    opts?.config,
    resolveContext,
  );
  progress("done", `Ingestion complete`);

  if (
    entityMetadata &&
    Object.keys(entityMetadata).length > 0 &&
    ENTITY_PAGE_KINDS.has(resolvedKind)
  ) {
    const page = store.getPageByTitle(primaryPageTitle);
    if (page?.entityId) {
      store.mergeEntityMetadata(page.entityId, entityMetadata, source.id);
    }
  }

  // newClaims.claimId is populated during resolveKnowledge
  const affectedEntityIds = collectAffectedEntityIds(store, diff);

  return { ...diff, relationsCompiled, affectedEntityIds };
}

export async function ingestSource(
  store: KnowledgeStore,
  llm: LLMAdapter,
  filePath: string,
  opts?: IngestSourceOptions,
): Promise<IngestResult> {
  const raw = await readFile(filePath, "utf-8");
  const ext = extname(filePath).toLowerCase();
  const parseMarkdown = ext === ".md" || ext === ".mdx" || raw.trimStart().startsWith("---");
  return ingestRawMarkdown(store, llm, filePath, raw, {
    ...opts,
    parseMarkdown,
  });
}

interface ExtractedClaim {
  statement: string;
  confidence: number;
  claimType: ClaimType;
  tags: string[];
  relatedConcepts: string[];
  dependsOnStatements: string[];
}

function entityMetadataSchemaHint(kind: string): string {
  const preamble = `IMPORTANT: Do NOT put relationship-like data in "entity_metadata". Connections between entities (employer, team membership, reports-to, located-in, depends-on, collaborates-with, etc.) belong in claims with claim_type "attribute" — they will be extracted as graph relations in a later pass. "entity_metadata" is only for scalar properties intrinsic to this single entity that cannot be expressed as a relation edge.\n`;
  switch (kind) {
    case "person":
      return preamble + `Use "entity_metadata" with: importance (string), cadence (string), last_contact (string|null), active_topics (string[]), notable_dates (object of string keys to ISO date strings). Omit keys you cannot infer. Do NOT include organizations, roles, or relationship_type here — express those as "attribute" claims instead.`;
    case "project":
      return preamble + `Use "entity_metadata" with: status (string), priority (string), mode (string), milestones (array of {name, status, date?}). Omit keys you cannot infer. Do NOT include stakeholders or dependencies here — express those as "attribute" claims instead.`;
    case "place":
      return (
        preamble +
        `For place entities, include location in both forms when the source gives enough detail (omit either form if unknown):\n` +
        `- coordinates_decimal: { "latitude": <number>, "longitude": <number> } in WGS84 (decimal degrees; use negative longitude for west of prime meridian, negative latitude for south).\n` +
        `- coordinates_dms: { "latitude": "<deg>° <min>' <sec>\" <N|S>", "longitude": "<deg>° <min>' <sec>\" <E|W>" } matching the same point as coordinates_decimal when both are present.\n` +
        `Also use "entity_metadata" for other intrinsic fields: region (string), timezone (string), elevation_m (number|null), notes (string). Do NOT include links to other entities — express those as "attribute" claims instead.`
      );
    case "organization":
    case "life_area":
    case "relationship":
      return preamble + `Use "entity_metadata" with flat string or string[] fields that describe intrinsic properties of this ${kind} (e.g. region, sector, founding date). Do NOT include links to other entities — express those as "attribute" claims instead.`;
    default:
      return "";
  }
}

function authorPromptExtra(author?: QuickyConfig["author"]): string {
  if (!author?.name?.trim()) return "";
  const ctx = author.context?.trim();
  return `\n\nThe knowledge base belongs to ${author.name.trim()}.${ctx ? ` ${ctx}` : ""} When extracting claims, refer to this person by name ("${author.name.trim()}") instead of vague phrases like "the author", "the user", or "I" (unless the source is a direct first-person quote).`;
}

type ExtractClaimsResult = {
  claims: ExtractedClaim[];
  entityMetadata?: Record<string, unknown>;
};

function formatEntityCatalog(store: KnowledgeStore): string {
  const lines: string[] = [];
  for (const e of store.listEntities()) {
    lines.push(`- ${e.canonicalName} (${e.type}) [id:${e.id}]`);
  }
  return lines.length
    ? lines.join("\n")
    : "(no entities in graph yet — use natural names; new pages may be created)";
}

async function extractClaims(
  llm: LLMAdapter,
  content: string,
  title: string,
  source: Source,
  ctx: {
    pageKind: string;
    entityPrompts?: Record<string, string>;
    author?: QuickyConfig["author"];
  },
  store: KnowledgeStore,
): Promise<ExtractClaimsResult> {
  if (content.length > 12000) {
    return extractClaimsChunked(llm, content, title, source, ctx, store);
  }
  return extractClaimsSingle(llm, content, title, source, ctx, store);
}

async function extractClaimsChunked(
  llm: LLMAdapter,
  content: string,
  title: string,
  source: Source,
  ctx: {
    pageKind: string;
    entityPrompts?: Record<string, string>;
    author?: QuickyConfig["author"];
  },
  store: KnowledgeStore,
): Promise<ExtractClaimsResult> {
  const chunkSize = 8000;
  const overlap = 500;
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += chunkSize - overlap) {
    chunks.push(content.slice(i, i + chunkSize));
  }

  const allClaims: ExtractedClaim[] = [];
  let mergedMeta: Record<string, unknown> | undefined;
  for (const chunk of chunks) {
    const { claims, entityMetadata } = await extractClaimsSingle(
      llm,
      chunk,
      title,
      source,
      ctx,
      store,
    );
    allClaims.push(...claims);
    if (entityMetadata && Object.keys(entityMetadata).length > 0) {
      mergedMeta = { ...mergedMeta, ...entityMetadata };
    }
  }

  const seen = new Set<string>();
  const deduped = allClaims.filter((c) => {
    const key = c.statement
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { claims: deduped, entityMetadata: mergedMeta };
}

async function extractClaimsSingle(
  llm: LLMAdapter,
  content: string,
  title: string,
  source: Source,
  ctx: {
    pageKind: string;
    entityPrompts?: Record<string, string>;
    author?: QuickyConfig["author"];
  },
  store: KnowledgeStore,
): Promise<ExtractClaimsResult> {
  const entityExtra = ctx.entityPrompts?.[ctx.pageKind]?.trim();
  const extra = entityExtra
    ? `\n\nAdditional instructions for this entity kind (${ctx.pageKind}):\n${entityExtra}`
    : "";
  const authorExtra = authorPromptExtra(ctx.author);
  const metaHint = ENTITY_PAGE_KINDS.has(ctx.pageKind)
    ? `\n\nAlso extract structured fields for this primary entity (${ctx.pageKind}):\n${entityMetadataSchemaHint(ctx.pageKind)}\nInclude a top-level JSON key "entity_metadata" (object). Use canonical entity names from the catalog when referring to people/projects.\n\nKnown entities catalog:\n${formatEntityCatalog(store)}\n\nIf a surface form might be an alias of an existing entity but you are not certain, add "possible_alias": { "surface": "...", "candidate_entity_name": "..." } at the top level (optional, may omit).`
    : "";

  const systemPrompt = `You extract atomic, verifiable claims from source material.
Each claim should be a single factual statement. Be precise and specific.
Assign an initial confidence based on how well-supported the claim is by the source.
For each claim, set claim_type to exactly one of: fact, observation, preference, hypothesis, status, attribute.
  - fact: durable biographical or world fact
  - observation: something noticed, time-bound
  - preference: declared taste or value
  - hypothesis: inferred pattern, testable
  - status: current state of something
  - attribute: structured entity property (roles, dates, relationship labels)

IMPORTANT — prefer "attribute" claims over entity_metadata for anything that links two entities:
  Connections like "works at Acme", "member of Team X", "reports to Jane", "located in NYC", or "depends on Project Y" MUST be extracted as claims (claim_type "attribute"), NOT stuffed into entity_metadata. A later pass converts these into typed graph relation edges. Reserve entity_metadata for scalar properties intrinsic to a single entity (e.g. importance, cadence, founding date).

Tag each claim with relevant topic tags.
Identify related concepts (potential wiki page titles) for cross-linking.
If a claim logically depends on another claim you're extracting, note the dependency.${authorExtra}${extra}${metaHint}

Respond in JSON format:
{
  "claims": [
    {
      "statement": "Precise factual claim",
      "confidence": 0.85,
      "claim_type": "fact",
      "tags": ["topic1", "topic2"],
      "relatedConcepts": ["Concept A", "Concept B"],
      "dependsOnStatements": []
    }
  ],
  "entity_metadata": {},
  "possible_alias": null
}`;

  const response = await llm.chat(
    [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: `Source: "${title}" (type: ${source.type}, quality: ${source.qualityTier})\n\n${content}`,
      },
    ],
    { temperature: 0.2, maxTokens: 8192 },
  );

  try {
    const parsed = parseLLMJson(response.content);
    const claims = (parsed.claims ?? []).map((c: any) => ({
      statement: c.statement,
      confidence: scoreConfidence(c.confidence, source.qualityTier),
      claimType: normalizeClaimType(c.claim_type ?? c.claimType),
      tags: c.tags ?? [],
      relatedConcepts: c.relatedConcepts ?? [],
      dependsOnStatements: c.dependsOnStatements ?? [],
    }));
    const rawMeta = parsed.entity_metadata;
    const entityMetadata =
      rawMeta &&
      typeof rawMeta === "object" &&
      !Array.isArray(rawMeta) &&
      ENTITY_PAGE_KINDS.has(ctx.pageKind)
        ? (rawMeta as Record<string, unknown>)
        : undefined;
    const pa = parsed.possible_alias;
    if (
      pa &&
      typeof pa === "object" &&
      pa.surface &&
      pa.candidate_entity_name &&
      source.id
    ) {
      try {
        store.addPendingAlias({
          surfaceForm: String(pa.surface),
          candidateEntityName: String(pa.candidate_entity_name),
          sourceId: source.id,
        });
      } catch {
        /* optional */
      }
    }
    return { claims, entityMetadata };
  } catch (err) {
    console.error(
      `[extractClaims] JSON parse failed: ${err}`,
      response.content.slice(0, 300),
    );
    return { claims: [] };
  }
}

/** Vault / entity document types: stored as markdown sources but not valid SourceType values. */
const ENTITY_DOC_TYPES = new Set([
  "person",
  "relationship",
  "project",
  "daily_review",
  "weekly_review",
  "focus",
  "life_area",
  "review",
]);

const SOURCE_TYPES: ReadonlySet<string> = new Set<SourceType>([
  "article",
  "paper",
  "repo",
  "dataset",
  "image",
  "note",
  "book",
  "video",
  "conversation",
  "chat",
  "other",
]);

function inferSourceType(
  filePath: string,
  frontmatter: Record<string, unknown>,
): SourceType {
  const st = frontmatter.sourceType;
  if (st === "chat" || st === "conversation") return st as SourceType;
  const fmType = frontmatter.type != null ? String(frontmatter.type) : "";
  if (fmType === "chat" || fmType === "conversation") return fmType as SourceType;
  if (fmType && ENTITY_DOC_TYPES.has(fmType)) return "note";
  if (fmType && SOURCE_TYPES.has(fmType)) return fmType as SourceType;
  const ext = extname(filePath).toLowerCase();
  if ([".pdf"].includes(ext)) return "paper";
  if ([".md", ".mdx", ".txt"].includes(ext)) return "note";
  return "other";
}

function inferQuality(
  frontmatter: Record<string, unknown>,
  config?: QuickyConfig,
): QualityTier {
  if (frontmatter.quality) return frontmatter.quality as QualityTier;
  if (frontmatter.doi || frontmatter.arxiv) return "peer-reviewed";
  if (frontmatter.publisher) return "book";
  return config?.defaultQualityTier ?? "unknown";
}
