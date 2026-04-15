import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  normalizeClaimType,
  type Source,
  type Claim,
  type WikiPage,
  type Entity,
  type EpistemicEvent,
  type EpistemicEventType,
  type SourceType,
  type QualityTier,
  type ClaimType,
  type KnowledgeRelation,
  type CompiledViewType,
} from "../types.js";

/** Page kinds that get a first-class entity row + primary page link. */
export const ENTITY_PAGE_KINDS = new Set([
  "person",
  "project",
  "relationship",
  "life_area",
  "place",
  "organization",
]);

/** Stored with canonical (lexicographic) entity order for undirected semantics. */
const SYMMETRIC_RELATION_TYPES = new Set(["spouse_of", "related_to"]);

function canonicalRelationEndpoints(
  fromEntityId: string,
  toEntityId: string,
  relationType: string,
): [string, string] {
  if (SYMMETRIC_RELATION_TYPES.has(relationType)) {
    return fromEntityId < toEntityId
      ? [fromEntityId, toEntityId]
      : [toEntityId, fromEntityId];
  }
  return [fromEntityId, toEntityId];
}

function safeJsonCell(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Recursively merge `patch` into `base`, preserving existing keys in nested
 * objects that the patch doesn't mention.  Patch values win on leaf conflicts.
 * Arrays and primitives are replaced wholesale (no array concatenation).
 */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(patch)) {
    const bVal = base[key];
    const pVal = patch[key];
    if (isPlainObject(bVal) && isPlainObject(pVal)) {
      result[key] = deepMerge(bVal, pVal);
    } else {
      result[key] = pVal;
    }
  }
  return result;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  quality_tier TEXT NOT NULL DEFAULT 'unknown',
  content_hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  canonical_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_aliases (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (entity_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_alias ON entity_aliases(alias);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'topic',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  confidence REAL NOT NULL DEFAULT 0.5,
  first_stated TEXT NOT NULL,
  last_reinforced TEXT NOT NULL,
  decay_rate REAL NOT NULL DEFAULT 0.002,
  tags_json TEXT NOT NULL DEFAULT '[]',
  claim_type TEXT NOT NULL DEFAULT 'fact'
);

CREATE TABLE IF NOT EXISTS claim_sources (
  claim_id TEXT NOT NULL REFERENCES claims(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  PRIMARY KEY (claim_id, source_id)
);

CREATE TABLE IF NOT EXISTS claim_dependencies (
  claim_id TEXT NOT NULL REFERENCES claims(id),
  depends_on_claim_id TEXT NOT NULL REFERENCES claims(id),
  PRIMARY KEY (claim_id, depends_on_claim_id)
);

CREATE TABLE IF NOT EXISTS claim_contradictions (
  claim_id TEXT NOT NULL REFERENCES claims(id),
  contradicted_by_claim_id TEXT NOT NULL REFERENCES claims(id),
  PRIMARY KEY (claim_id, contradicted_by_claim_id)
);

CREATE TABLE IF NOT EXISTS epistemic_events (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  trigger_source_id TEXT REFERENCES sources(id),
  confidence_before REAL NOT NULL,
  confidence_after REAL NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS page_links (
  from_page_id TEXT NOT NULL REFERENCES pages(id),
  to_page_id TEXT NOT NULL REFERENCES pages(id),
  PRIMARY KEY (from_page_id, to_page_id)
);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  to_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  confidence REAL NOT NULL DEFAULT 0.8,
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TEXT,
  valid_to TEXT,
  source_claim_id TEXT REFERENCES claims(id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_endpoints_type ON relations(from_entity_id, to_entity_id, relation_type);

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  model TEXT NOT NULL,
  vector_blob BLOB NOT NULL,
  text_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(subject_type, subject_id, model)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_subject ON embeddings(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS pending_aliases (
  id TEXT PRIMARY KEY,
  surface_form TEXT NOT NULL,
  candidate_entity_name TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_aliases_status ON pending_aliases(status);

CREATE TABLE IF NOT EXISTS compiled_views (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  view_type TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  stale INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE(entity_id, view_type)
);

CREATE INDEX IF NOT EXISTS idx_compiled_views_entity ON compiled_views(entity_id);

CREATE TABLE IF NOT EXISTS entity_state_log (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  field_path TEXT NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_state_entity ON entity_state_log(entity_id);

CREATE INDEX IF NOT EXISTS idx_claims_page ON claims(page_id);
CREATE INDEX IF NOT EXISTS idx_claims_confidence ON claims(confidence);
CREATE INDEX IF NOT EXISTS idx_events_claim ON epistemic_events(claim_id);
CREATE INDEX IF NOT EXISTS idx_events_date ON epistemic_events(date);
CREATE INDEX IF NOT EXISTS idx_sources_hash ON sources(content_hash);
CREATE INDEX IF NOT EXISTS idx_events_source ON epistemic_events(trigger_source_id);
CREATE INDEX IF NOT EXISTS idx_claims_last_reinforced ON claims(last_reinforced);
CREATE INDEX IF NOT EXISTS idx_page_links_to ON page_links(to_page_id);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(
  statement,
  content=claims,
  content_rowid=rowid
);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  summary,
  content=pages,
  content_rowid=rowid
);
`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS claims_ai AFTER INSERT ON claims BEGIN
  INSERT INTO claims_fts(rowid, statement) VALUES (NEW.rowid, NEW.statement);
END;
CREATE TRIGGER IF NOT EXISTS claims_ad AFTER DELETE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, statement) VALUES('delete', OLD.rowid, OLD.statement);
END;
CREATE TRIGGER IF NOT EXISTS claims_au AFTER UPDATE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, statement) VALUES('delete', OLD.rowid, OLD.statement);
  INSERT INTO claims_fts(rowid, statement) VALUES (NEW.rowid, NEW.statement);
END;

CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, summary) VALUES (NEW.rowid, NEW.title, NEW.summary);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, summary) VALUES('delete', OLD.rowid, OLD.title, OLD.summary);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, summary) VALUES('delete', OLD.rowid, OLD.title, OLD.summary);
  INSERT INTO pages_fts(rowid, title, summary) VALUES (NEW.rowid, NEW.title, NEW.summary);
END;
`;

export class KnowledgeStore {
  private db: Database.Database;

  // Pre-prepared hot statements
  private stmts!: ReturnType<KnowledgeStore["prepareStatements"]>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // Turbo PRAGMAs
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("cache_size = -64000"); // 64MB page cache
    this.db.pragma("mmap_size = 268435456"); // 256MB memory-mapped I/O
    this.db.pragma("synchronous = NORMAL"); // safe with WAL, faster than FULL
    this.db.pragma("temp_store = MEMORY"); // temp tables in RAM
    this.db.exec(SCHEMA);
    this.ensurePageEntityColumns();
    this.ensureClaimTypeColumn();
    this.promoteTypedPagesToEntities();
    this.migratePageLinksToRelatedRelations();
    this.db.exec(FTS_SCHEMA);
    this.db.exec(FTS_TRIGGERS);
    this.rebuildFtsIfEmpty();
    this.stmts = this.prepareStatements();
  }

  /** Add kind + metadata_json to existing DBs created before entity typing. */
  private ensurePageEntityColumns(): void {
    const cols = this.db.prepare("PRAGMA table_info(pages)").all() as {
      name: string;
    }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("kind")) {
      this.db.exec(
        "ALTER TABLE pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'topic'",
      );
    }
    if (!names.has("metadata_json")) {
      this.db.exec(
        "ALTER TABLE pages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
      );
    }
    if (!names.has("entity_id")) {
      this.db.exec(
        "ALTER TABLE pages ADD COLUMN entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL",
      );
    }
    // Must run after entity_id exists — legacy DBs skip CREATE TABLE pages, so the column is added above.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_pages_entity ON pages(entity_id)",
    );
  }

  /** One-time / idempotent: typed pages without entity_id get an entities row. */
  /**
   * Best-effort: entity-linked pages with explicit page_links become `related_to`
   * rows (idempotent via UNIQUE index).
   */
  private migratePageLinksToRelatedRelations(): void {
    try {
      const rows = this.db
        .prepare(
          `SELECT pl.from_page_id, pl.to_page_id,
            pf.entity_id AS efrom, pt.entity_id AS eto
           FROM page_links pl
           INNER JOIN pages pf ON pf.id = pl.from_page_id
           INNER JOIN pages pt ON pt.id = pl.to_page_id
           WHERE pf.entity_id IS NOT NULL AND pt.entity_id IS NOT NULL
             AND pf.entity_id != pt.entity_id`,
        )
        .all() as {
        efrom: string;
        eto: string;
      }[];
      const now = new Date().toISOString();
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO relations (
           id, from_entity_id, relation_type, to_entity_id, confidence, status,
           valid_from, valid_to, source_claim_id, metadata_json, created_at, updated_at
         ) VALUES (?, ?, 'related_to', ?, 0.5, 'active', NULL, NULL, NULL, ?, ?, ?)`,
      );
      const seen = new Set<string>();
      for (const r of rows) {
        const [fromId, toId] = canonicalRelationEndpoints(
          r.efrom,
          r.eto,
          "related_to",
        );
        const key = `${fromId}|${toId}|related_to`;
        if (seen.has(key)) continue;
        seen.add(key);
        ins.run(
          randomUUID(),
          fromId,
          toId,
          JSON.stringify({ migratedFrom: "page_links" }),
          now,
          now,
        );
      }
    } catch {
      // relations table missing in corrupted state — skip
    }
  }

  private promoteTypedPagesToEntities(): void {
    const kindList = Array.from(ENTITY_PAGE_KINDS);
    const kinds = kindList.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, title, kind, metadata_json, entity_id FROM pages WHERE kind IN (${kinds})`,
      )
      .all(...kindList) as any[];
    for (const row of rows) {
      if (row.entity_id) continue;
      this.linkPageToNewOrExistingEntity(row);
    }
  }

  private parsePageMetadata(metadataJson: string): Record<string, unknown> {
    try {
      return JSON.parse(metadataJson || "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private metadataAliases(
    meta: Record<string, unknown>,
    canonicalTitle: string,
  ): string[] {
    const raw = meta.aliases;
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    const canon = canonicalTitle.toLowerCase();
    for (const a of raw) {
      const s = String(a).trim();
      if (s && s.toLowerCase() !== canon) out.push(s);
    }
    return out;
  }

  private seedAliasesForEntity(
    entityId: string,
    canonicalTitle: string,
    meta: Record<string, unknown>,
  ): void {
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO entity_aliases (entity_id, alias) VALUES (?, ?)",
    );
    for (const a of this.metadataAliases(meta, canonicalTitle)) {
      ins.run(entityId, a);
    }
  }

  /** Create or attach entity for a typed primary page row (no entity_id). */
  private linkPageToNewOrExistingEntity(pageRow: any): void {
    const title = pageRow.title as string;
    const kind = pageRow.kind as string;
    const meta = this.parsePageMetadata(pageRow.metadata_json);
    const now = new Date().toISOString();
    let entityId = (
      this.db
        .prepare("SELECT id FROM entities WHERE canonical_name = ?")
        .get(title) as { id: string } | undefined
    )?.id;
    if (!entityId) {
      entityId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO entities (id, type, canonical_name, status, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(entityId, kind, title, JSON.stringify(meta), now, now);
    } else {
      this.db
        .prepare(
          "UPDATE entities SET metadata_json = ?, type = ?, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(meta), kind, now, entityId);
    }
    this.seedAliasesForEntity(entityId, title, meta);
    this.db
      .prepare("UPDATE pages SET entity_id = ? WHERE id = ?")
      .run(entityId, pageRow.id);
  }

  /**
   * Keep entities row in sync with primary wiki page (from ingest / vault).
   */
  syncEntityWithPrimaryPage(pageId: string): void {
    const row = this.stmts.getPageById.get(pageId) as any;
    if (!row || !ENTITY_PAGE_KINDS.has(row.kind)) return;
    const pageMeta = this.parsePageMetadata(row.metadata_json);
    const now = new Date().toISOString();
    const title = row.title as string;
    if (row.entity_id) {
      let existing: Record<string, unknown> = {};
      try {
        const eRow = this.db
          .prepare("SELECT metadata_json FROM entities WHERE id = ?")
          .get(row.entity_id) as { metadata_json: string } | undefined;
        if (eRow) existing = JSON.parse(eRow.metadata_json || "{}");
      } catch {
        existing = {};
      }
      const merged = deepMerge(existing, pageMeta);
      this.db
        .prepare(
          "UPDATE entities SET metadata_json = ?, type = ?, updated_at = ? WHERE id = ?",
        )
        .run(JSON.stringify(merged), row.kind, now, row.entity_id);
      this.seedAliasesForEntity(row.entity_id, title, merged);
      return;
    }
    this.linkPageToNewOrExistingEntity(row);
  }

  /** Deep-merge patch into entity metadata_json; log field diffs + mark compiled views stale. */
  mergeEntityMetadata(
    entityId: string,
    patch: Record<string, unknown>,
    sourceId?: string | null,
  ): void {
    const row = this.db
      .prepare("SELECT metadata_json FROM entities WHERE id = ?")
      .get(entityId) as { metadata_json: string } | undefined;
    if (!row) return;
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(row.metadata_json || "{}") as Record<
        string,
        unknown
      >;
    } catch {
      current = {};
    }
    const next = deepMerge(current, patch);
    const now = new Date().toISOString();
    for (const key of Object.keys(patch)) {
      const oldV = current[key];
      const newV = next[key];
      if (JSON.stringify(oldV) !== JSON.stringify(newV)) {
        this.logEntityStateChange(
          entityId,
          key,
          oldV,
          newV,
          sourceId ?? null,
        );
      }
    }
    this.db
      .prepare(
        "UPDATE entities SET metadata_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(next), now, entityId);
    this.markViewsStaleForEntity(entityId);
  }

  private logEntityStateChange(
    entityId: string,
    fieldPath: string,
    oldValue: unknown,
    newValue: unknown,
    sourceId: string | null,
  ): void {
    const ser = (v: unknown) =>
      v === undefined ? null : JSON.stringify(v);
    this.db
      .prepare(
        `INSERT INTO entity_state_log (id, entity_id, field_path, old_value_json, new_value_json, source_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        entityId,
        fieldPath,
        ser(oldValue),
        ser(newValue),
        sourceId,
        new Date().toISOString(),
      );
  }

  markViewsStaleForEntity(entityId: string): void {
    this.db
      .prepare(
        "UPDATE compiled_views SET stale = 1, updated_at = ? WHERE entity_id = ?",
      )
      .run(new Date().toISOString(), entityId);
  }

  getCompiledView(
    entityId: string,
    viewType: CompiledViewType,
  ): { body: string; stale: boolean; updatedAt: string } | null {
    const row = this.db
      .prepare(
        "SELECT body, stale, updated_at FROM compiled_views WHERE entity_id = ? AND view_type = ?",
      )
      .get(entityId, viewType) as
      | { body: string; stale: number; updated_at: string }
      | undefined;
    if (!row) return null;
    return {
      body: row.body,
      stale: !!row.stale,
      updatedAt: row.updated_at,
    };
  }

  upsertCompiledView(opts: {
    entityId: string;
    viewType: CompiledViewType;
    body: string;
    stale?: boolean;
  }): void {
    const now = new Date().toISOString();
    const stale = opts.stale ? 1 : 0;
    const existing = this.db
      .prepare(
        "SELECT id FROM compiled_views WHERE entity_id = ? AND view_type = ?",
      )
      .get(opts.entityId, opts.viewType) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE compiled_views SET body = ?, stale = ?, updated_at = ? WHERE id = ?`,
        )
        .run(opts.body, stale, now, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO compiled_views (id, entity_id, view_type, body, stale, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          opts.entityId,
          opts.viewType,
          opts.body,
          stale,
          now,
        );
    }
  }

  listEntityStateLog(
    entityId: string,
    limit = 100,
  ): Array<{
    id: string;
    fieldPath: string;
    oldValue: unknown;
    newValue: unknown;
    sourceId: string | null;
    createdAt: string;
  }> {
    return (
      this.db
        .prepare(
          `SELECT id, field_path, old_value_json, new_value_json, source_id, created_at
           FROM entity_state_log WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(entityId, limit) as any[]
    ).map((r) => ({
      id: r.id,
      fieldPath: r.field_path,
      oldValue: safeJsonCell(r.old_value_json),
      newValue: safeJsonCell(r.new_value_json),
      sourceId: r.source_id,
      createdAt: r.created_at,
    }));
  }

  /** Recent metadata field changes across all entities (for timeline). */
  listRecentEntityStateLog(
    limit = 200,
  ): Array<{
    id: string;
    entityId: string;
    entityCanonicalName: string;
    fieldPath: string;
    oldValue: unknown;
    newValue: unknown;
    sourceId: string | null;
    createdAt: string;
  }> {
    return (
      this.db
        .prepare(
          `SELECT l.id, l.entity_id, e.canonical_name AS entity_canonical_name,
                  l.field_path, l.old_value_json, l.new_value_json, l.source_id, l.created_at
           FROM entity_state_log l
           JOIN entities e ON e.id = l.entity_id
           ORDER BY l.created_at DESC
           LIMIT ?`,
        )
        .all(limit) as any[]
    ).map((r) => ({
      id: r.id,
      entityId: r.entity_id,
      entityCanonicalName: r.entity_canonical_name,
      fieldPath: r.field_path,
      oldValue: safeJsonCell(r.old_value_json),
      newValue: safeJsonCell(r.new_value_json),
      sourceId: r.source_id,
      createdAt: r.created_at,
    }));
  }

  countStaleCompiledViews(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as c FROM compiled_views WHERE stale = 1",
      )
      .get() as { c: number };
    return row?.c ?? 0;
  }

  getOntologyHealthSnapshot(): {
    entityCount: number;
    entitiesWithPrimaryPage: number;
    relationCount: number;
    pendingAliasCount: number;
    staleCompiledViewCount: number;
  } {
    const entityCount =
      (
        this.db.prepare("SELECT COUNT(*) as c FROM entities").get() as {
          c: number;
        }
      ).c ?? 0;
    const entitiesWithPrimaryPage =
      (
        this.db
          .prepare(
            "SELECT COUNT(DISTINCT entity_id) as c FROM pages WHERE entity_id IS NOT NULL",
          )
          .get() as { c: number }
      ).c ?? 0;
    const relationCount =
      (
        this.db.prepare("SELECT COUNT(*) as c FROM relations").get() as {
          c: number;
        }
      ).c ?? 0;
    const pendingAliasCount =
      (
        this.db
          .prepare(
            "SELECT COUNT(*) as c FROM pending_aliases WHERE status = 'pending'",
          )
          .get() as { c: number }
      ).c ?? 0;
    return {
      entityCount,
      entitiesWithPrimaryPage,
      relationCount,
      pendingAliasCount,
      staleCompiledViewCount: this.countStaleCompiledViews(),
    };
  }

  getEntity(id: string): Entity | null {
    const row = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as
      | any
      | undefined;
    if (!row) return null;
    return this.rowToEntity(row);
  }

  getEntityByCanonicalName(name: string): Entity | null {
    const row = this.db
      .prepare("SELECT * FROM entities WHERE canonical_name = ?")
      .get(name) as any;
    return row ? this.rowToEntity(row) : null;
  }

  /** Resolve alias (case-insensitive) to entity id, if any. */
  resolveEntityAlias(alias: string): string | null {
    const row = this.db
      .prepare(
        `SELECT entity_id FROM entity_aliases WHERE alias = ? COLLATE NOCASE LIMIT 1`,
      )
      .get(alias.trim()) as { entity_id: string } | undefined;
    return row?.entity_id ?? null;
  }

  listEntities(opts?: { type?: string; status?: string }): Entity[] {
    let sql = "SELECT * FROM entities WHERE 1=1";
    const params: string[] = [];
    if (opts?.type) {
      sql += " AND type = ?";
      params.push(opts.type);
    }
    if (opts?.status) {
      sql += " AND status = ?";
      params.push(opts.status);
    }
    sql += " ORDER BY type ASC, canonical_name ASC";
    return (this.db.prepare(sql).all(...params) as any[]).map((r) =>
      this.rowToEntity(r),
    );
  }

  listEntitiesWithStats(): Array<
    Entity & {
      aliasCount: number;
      claimCount: number;
      relationCount: number;
      primaryPageId: string | null;
    }
  > {
    const rows = this.db
      .prepare(
        `
      SELECT e.*,
        (SELECT COUNT(*) FROM entity_aliases ea WHERE ea.entity_id = e.id) AS alias_count,
        (SELECT COUNT(*) FROM claims c
          INNER JOIN pages p ON c.page_id = p.id
          WHERE p.entity_id = e.id) AS claim_count,
        (SELECT COUNT(*) FROM relations r
          WHERE r.from_entity_id = e.id OR r.to_entity_id = e.id) AS relation_count,
        (SELECT p.id FROM pages p WHERE p.entity_id = e.id LIMIT 1) AS primary_page_id
      FROM entities e
      ORDER BY e.type ASC, e.canonical_name ASC
    `,
      )
      .all() as any[];
    return rows.map((r) => ({
      ...this.rowToEntity(r),
      aliasCount: r.alias_count,
      claimCount: r.claim_count,
      relationCount: r.relation_count,
      primaryPageId: r.primary_page_id ?? null,
    }));
  }

  getEntityDetail(entityId: string): {
    entity: Entity;
    aliases: string[];
    primaryPage: WikiPage | null;
    claims: Claim[];
    relations: Array<{
      id: string;
      relationType: string;
      confidence: number;
      otherEntityId: string;
      otherCanonicalName: string;
      direction: "outbound" | "inbound";
    }>;
  } | null {
    const entity = this.getEntity(entityId);
    if (!entity) return null;
    const aliases = (
      this.db
        .prepare(
          "SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias",
        )
        .all(entityId) as { alias: string }[]
    ).map((x) => x.alias);
    const pageRow = this.db
      .prepare("SELECT * FROM pages WHERE entity_id = ? LIMIT 1")
      .get(entityId) as any;
    const primaryPage = pageRow ? this.rowToPage(pageRow) : null;
    const claims = primaryPage
      ? this.getClaimsByPage(primaryPage.id)
      : [];
    const relRows = this.db
      .prepare(
        `SELECT r.id, r.from_entity_id, r.to_entity_id, r.relation_type, r.confidence
         FROM relations r
         WHERE r.from_entity_id = ? OR r.to_entity_id = ?`,
      )
      .all(entityId, entityId) as any[];
    const relations = relRows.map((r) => {
      const outbound = r.from_entity_id === entityId;
      const otherId = outbound ? r.to_entity_id : r.from_entity_id;
      const other = this.getEntity(otherId);
      return {
        id: r.id,
        relationType: r.relation_type,
        confidence: r.confidence,
        otherEntityId: otherId,
        otherCanonicalName: other?.canonicalName ?? otherId,
        direction: outbound ? ("outbound" as const) : ("inbound" as const),
      };
    });
    return { entity, aliases, primaryPage, claims, relations };
  }

  addRelation(opts: {
    fromEntityId: string;
    toEntityId: string;
    relationType: string;
    confidence?: number;
    status?: string;
    sourceClaimId?: string | null;
    validFrom?: string | null;
    validTo?: string | null;
    metadata?: Record<string, unknown>;
  }): string {
    const [fromId, toId] = canonicalRelationEndpoints(
      opts.fromEntityId,
      opts.toEntityId,
      opts.relationType,
    );
    const id = randomUUID();
    const now = new Date().toISOString();
    const confidence = opts.confidence ?? 0.8;
    const status = opts.status ?? "active";
    this.db
      .prepare(
        `INSERT OR IGNORE INTO relations (
           id, from_entity_id, relation_type, to_entity_id, confidence, status,
           valid_from, valid_to, source_claim_id, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fromId,
        opts.relationType,
        toId,
        confidence,
        status,
        opts.validFrom ?? null,
        opts.validTo ?? null,
        opts.sourceClaimId ?? null,
        JSON.stringify(opts.metadata ?? {}),
        now,
        now,
      );
    this.markViewsStaleForEntity(fromId);
    this.markViewsStaleForEntity(toId);
    return id;
  }

  listRelations(opts?: { entityId?: string }): KnowledgeRelation[] {
    let sql = "SELECT * FROM relations WHERE 1=1";
    const params: string[] = [];
    if (opts?.entityId) {
      sql +=
        " AND (from_entity_id = ? OR to_entity_id = ?)";
      params.push(opts.entityId, opts.entityId);
    }
    sql += " ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all(...params) as any[]).map((r) =>
      this.rowToRelation(r),
    );
  }

  /** Primary wiki page id for an entity, if linked. */
  getPrimaryPageIdForEntity(entityId: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM pages WHERE entity_id = ? LIMIT 1")
      .get(entityId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private rowToRelation(row: any): KnowledgeRelation {
    return {
      id: row.id,
      fromEntityId: row.from_entity_id,
      relationType: row.relation_type,
      toEntityId: row.to_entity_id,
      confidence: row.confidence,
      status: row.status,
      validFrom: row.valid_from ?? null,
      validTo: row.valid_to ?? null,
      sourceClaimId: row.source_claim_id ?? null,
      metadata: this.parsePageMetadata(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  addEntityAlias(entityId: string, alias: string): void {
    const a = alias.trim();
    if (!a) return;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO entity_aliases (entity_id, alias) VALUES (?, ?)",
      )
      .run(entityId, a);
  }

  addPendingAlias(opts: {
    surfaceForm: string;
    candidateEntityName: string;
    sourceId: string;
  }): void {
    const sf = opts.surfaceForm.trim();
    const cn = opts.candidateEntityName.trim();
    if (!sf || !cn) return;
    this.db
      .prepare(
        `INSERT INTO pending_aliases (id, surface_form, candidate_entity_name, source_id, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(randomUUID(), sf, cn, opts.sourceId, new Date().toISOString());
  }

  listPendingAliases(): Array<{
    id: string;
    surfaceForm: string;
    candidateEntityName: string;
    sourceId: string | null;
    createdAt: string;
  }> {
    return (
      this.db
        .prepare(
          `SELECT id, surface_form, candidate_entity_name, source_id, created_at
           FROM pending_aliases WHERE status = 'pending' ORDER BY created_at DESC`,
        )
        .all() as any[]
    ).map((r) => ({
      id: r.id,
      surfaceForm: r.surface_form,
      candidateEntityName: r.candidate_entity_name,
      sourceId: r.source_id,
      createdAt: r.created_at,
    }));
  }

  confirmPendingAlias(id: string): boolean {
    const row = this.db
      .prepare(
        "SELECT * FROM pending_aliases WHERE id = ? AND status = 'pending'",
      )
      .get(id) as any;
    if (!row) return false;
    const ent = this.getEntityByCanonicalName(row.candidate_entity_name);
    if (!ent) return false;
    this.addEntityAlias(ent.id, row.surface_form);
    this.db
      .prepare("UPDATE pending_aliases SET status = 'confirmed' WHERE id = ?")
      .run(id);
    return true;
  }

  dismissPendingAlias(id: string): void {
    this.db
      .prepare("UPDATE pending_aliases SET status = 'dismissed' WHERE id = ?")
      .run(id);
  }

  private rowToEntity(row: any): Entity {
    return {
      id: row.id,
      type: row.type,
      canonicalName: row.canonical_name,
      status: row.status ?? "active",
      metadata: this.parsePageMetadata(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Add claim_type to claims for existing DBs. */
  private ensureClaimTypeColumn(): void {
    const cols = this.db.prepare("PRAGMA table_info(claims)").all() as {
      name: string;
    }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("claim_type")) {
      this.db.exec(
        "ALTER TABLE claims ADD COLUMN claim_type TEXT NOT NULL DEFAULT 'fact'",
      );
    }
  }

  private rebuildFtsIfEmpty(): void {
    const count = (
      this.db.prepare("SELECT COUNT(*) as c FROM claims").get() as any
    ).c;
    if (count === 0) return;
    try {
      const ftsCount = (
        this.db.prepare("SELECT COUNT(*) as c FROM claims_fts").get() as any
      ).c;
      if (ftsCount === 0) {
        this.db.exec(
          "INSERT INTO claims_fts(rowid, statement) SELECT rowid, statement FROM claims",
        );
        this.db.exec(
          "INSERT INTO pages_fts(rowid, title, summary) SELECT rowid, title, summary FROM pages",
        );
      }
    } catch {
      // FTS index corrupted — drop and recreate
      this.db.exec("DROP TABLE IF EXISTS claims_fts");
      this.db.exec("DROP TABLE IF EXISTS pages_fts");
      this.db.exec("DROP TRIGGER IF EXISTS claims_ai");
      this.db.exec("DROP TRIGGER IF EXISTS claims_ad");
      this.db.exec("DROP TRIGGER IF EXISTS claims_au");
      this.db.exec("DROP TRIGGER IF EXISTS pages_ai");
      this.db.exec("DROP TRIGGER IF EXISTS pages_ad");
      this.db.exec("DROP TRIGGER IF EXISTS pages_au");
      this.db.exec(FTS_SCHEMA);
      this.db.exec(FTS_TRIGGERS);
      this.db.exec(
        "INSERT INTO claims_fts(rowid, statement) SELECT rowid, statement FROM claims",
      );
      this.db.exec(
        "INSERT INTO pages_fts(rowid, title, summary) SELECT rowid, title, summary FROM pages",
      );
    }
  }

  private prepareStatements() {
    return {
      getSourceByPath: this.db.prepare("SELECT * FROM sources WHERE path = ?"),
      getSource: this.db.prepare("SELECT * FROM sources WHERE id = ?"),
      getPageById: this.db.prepare("SELECT * FROM pages WHERE id = ?"),
      getPageByTitle: this.db.prepare("SELECT * FROM pages WHERE title = ?"),
      getClaimById: this.db.prepare("SELECT * FROM claims WHERE id = ?"),
      claimsByPage: this.db.prepare(
        "SELECT * FROM claims WHERE page_id = ? ORDER BY confidence DESC",
      ),
      claimSourceIds: this.db.prepare(
        "SELECT source_id FROM claim_sources WHERE claim_id = ?",
      ),
      claimContradictions: this.db.prepare(
        "SELECT contradicted_by_claim_id FROM claim_contradictions WHERE claim_id = ?",
      ),
      claimDependsOn: this.db.prepare(
        "SELECT depends_on_claim_id FROM claim_dependencies WHERE claim_id = ?",
      ),
      claimDerived: this.db.prepare(
        "SELECT claim_id FROM claim_dependencies WHERE depends_on_claim_id = ?",
      ),
      claimTimeline: this.db.prepare(
        "SELECT * FROM epistemic_events WHERE claim_id = ? ORDER BY date ASC",
      ),
      pageClaimIds: this.db.prepare("SELECT id FROM claims WHERE page_id = ?"),
      pageLinksTo: this.db.prepare(
        "SELECT to_page_id FROM page_links WHERE from_page_id = ?",
      ),
      pageLinkedFrom: this.db.prepare(
        "SELECT from_page_id FROM page_links WHERE to_page_id = ?",
      ),
      allPages: this.db.prepare("SELECT * FROM pages ORDER BY updated_at DESC"),
      allSources: this.db.prepare(
        "SELECT * FROM sources ORDER BY ingested_at DESC",
      ),
      stats: this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM sources) as sources,
          (SELECT COUNT(*) FROM pages) as pages,
          (SELECT COUNT(*) FROM claims) as claims,
          (SELECT COUNT(*) FROM epistemic_events) as events
      `),
      // Flat listing queries — no N+1
      listClaimsFlat: this.db.prepare(`
        SELECT c.*,
          (SELECT COUNT(*) FROM claim_sources cs WHERE cs.claim_id = c.id) as source_count,
          (SELECT COUNT(*) FROM claim_contradictions cc WHERE cc.claim_id = c.id) as contradiction_count,
          (SELECT COUNT(*) FROM claim_dependencies cd WHERE cd.claim_id = c.id) as dependency_count
        FROM claims c ORDER BY c.confidence DESC
      `),
      listPagesFlat: this.db.prepare(`
        SELECT p.*,
          (SELECT COUNT(*) FROM claims c WHERE c.page_id = p.id) as claim_count,
          (SELECT COUNT(*) FROM page_links pl WHERE pl.from_page_id = p.id) + 
          (SELECT COUNT(*) FROM page_links pl2 WHERE pl2.to_page_id = p.id) as link_count
        FROM pages p ORDER BY p.updated_at DESC
      `),
      // Events with claim statement — no N+1
      listEventsRecent: this.db.prepare(`
        SELECT e.*, c.statement as claim_statement
        FROM epistemic_events e
        JOIN claims c ON e.claim_id = c.id
        ORDER BY e.date DESC
        LIMIT ?
      `),
      // FTS5 search
      searchClaims: this.db.prepare(`
        SELECT c.id, c.statement, c.page_id, c.confidence, c.first_stated, c.last_reinforced, c.tags_json, c.claim_type
        FROM claims_fts fts
        JOIN claims c ON c.rowid = fts.rowid
        WHERE claims_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
      searchPages: this.db.prepare(`
        SELECT p.id, p.title, p.summary
        FROM pages_fts fts
        JOIN pages p ON p.rowid = fts.rowid
        WHERE pages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
      // Page detail with claims in one go
      pageClaimsFull: this.db.prepare(`
        SELECT c.*,
          (SELECT COUNT(*) FROM claim_sources cs WHERE cs.claim_id = c.id) as source_count
        FROM claims c WHERE c.page_id = ? ORDER BY c.confidence DESC
      `),
      getClaimPageId: this.db.prepare(
        "SELECT page_id FROM claims WHERE id = ?",
      ),
      claimsBySource: this.db.prepare(`
        SELECT c.*, p.title as page_title,
          (SELECT COUNT(*) FROM claim_sources cs2 WHERE cs2.claim_id = c.id) as source_count
        FROM claim_sources cs
        JOIN claims c ON c.id = cs.claim_id
        JOIN pages p ON p.id = c.page_id
        WHERE cs.source_id = ?
        ORDER BY c.confidence DESC
      `),
      pagesWithoutSummary: this.db.prepare(
        "SELECT id FROM pages WHERE summary = ''",
      ),
      pageTitles: this.db.prepare("SELECT id, title FROM pages ORDER BY title"),
      staleClaims: this.db.prepare(
        "SELECT * FROM claims WHERE last_reinforced < ? ORDER BY last_reinforced ASC",
      ),
      contestedClaims: this.db.prepare(`
        SELECT c.* FROM claims c
        WHERE EXISTS (SELECT 1 FROM claim_contradictions cc WHERE cc.claim_id = c.id)
        ORDER BY c.confidence ASC
      `),
      dependentsOf: this.db.prepare(`
        SELECT c.* FROM claims c
        JOIN claim_dependencies cd ON cd.claim_id = c.id
        WHERE cd.depends_on_claim_id = ?
      `),
    };
  }

  close(): void {
    this.db.close();
  }

  // ---- Sources ----

  addSource(source: Omit<Source, "id">): Source {
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO sources (id, path, title, type, quality_tier, content_hash, ingested_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        source.path,
        source.title,
        source.type,
        source.qualityTier,
        source.contentHash,
        source.ingestedAt,
        JSON.stringify(source.metadata),
      );
    return { id, ...source };
  }

  getSourceByPath(path: string): Source | null {
    const row = this.stmts.getSourceByPath.get(path) as any;
    return row ? this.rowToSource(row) : null;
  }

  getSource(id: string): Source | null {
    const row = this.stmts.getSource.get(id) as any;
    return row ? this.rowToSource(row) : null;
  }

  updateSourceHash(id: string, contentHash: string): void {
    this.db
      .prepare(
        "UPDATE sources SET content_hash = ?, ingested_at = ? WHERE id = ?",
      )
      .run(contentHash, new Date().toISOString(), id);
  }

  listSources(): Source[] {
    return (this.stmts.allSources.all() as any[]).map((r) =>
      this.rowToSource(r),
    );
  }

  getSourceWithClaims(id: string): {
    source: Source;
    claims: {
      id: string;
      statement: string;
      confidence: number;
      pageId: string;
      pageTitle: string;
      sources: number;
      lastReinforced: string;
      claimType: ClaimType;
    }[];
  } | null {
    const source = this.getSource(id);
    if (!source) return null;
    const rows = this.stmts.claimsBySource.all(id) as any[];
    const claims = rows.map((r) => ({
      id: r.id,
      statement: r.statement,
      confidence: r.confidence,
      pageId: r.page_id,
      pageTitle: r.page_title,
      sources: r.source_count,
      lastReinforced: r.last_reinforced,
      claimType: normalizeClaimType(r.claim_type),
    }));
    return { source, claims };
  }

  // ---- Pages ----

  addPage(
    title: string,
    path: string,
    summary: string = "",
    kind: string = "topic",
    metadata: Record<string, unknown> = {},
  ): WikiPage {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO pages (id, title, path, summary, kind, metadata_json, entity_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `,
      )
      .run(
        id,
        title,
        path,
        summary,
        kind,
        JSON.stringify(metadata),
        now,
        now,
      );
    return {
      id,
      title,
      path,
      summary,
      kind,
      metadata: { ...metadata },
      entityId: null,
      claims: [],
      linksTo: [],
      linkedFrom: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  getPageByTitle(title: string): WikiPage | null {
    const row = this.stmts.getPageByTitle.get(title) as any;
    return row ? this.rowToPage(row) : null;
  }

  getPage(id: string): WikiPage | null {
    const row = this.stmts.getPageById.get(id) as any;
    return row ? this.rowToPage(row) : null;
  }

  updatePageSummary(id: string, summary: string): void {
    this.db
      .prepare("UPDATE pages SET summary = ?, updated_at = ? WHERE id = ?")
      .run(summary, new Date().toISOString(), id);
  }

  updatePageKind(id: string, kind: string): void {
    this.db
      .prepare("UPDATE pages SET kind = ?, updated_at = ? WHERE id = ?")
      .run(kind, new Date().toISOString(), id);
  }

  updatePageMetadata(id: string, patch: Record<string, unknown>): void {
    const row = this.stmts.getPageById.get(id) as any;
    if (!row) return;
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(row.metadata_json || "{}");
    } catch {
      current = {};
    }
    const next = { ...current, ...patch };
    this.db
      .prepare(
        "UPDATE pages SET metadata_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(next), new Date().toISOString(), id);
  }

  listPages(): WikiPage[] {
    return (this.stmts.allPages.all() as any[]).map((r) => this.rowToPage(r));
  }

  addPageLink(fromId: string, toId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO page_links (from_page_id, to_page_id) VALUES (?, ?)",
      )
      .run(fromId, toId);
  }

  // ---- Claims ----

  addClaim(opts: {
    statement: string;
    pageId: string;
    confidence: number;
    sourceIds: string[];
    decayRate?: number;
    tags?: string[];
    claimType?: ClaimType;
  }): Claim {
    const id = randomUUID();
    const now = new Date().toISOString();
    const decayRate = opts.decayRate ?? 0.002;
    const tags = opts.tags ?? [];
    const claimType = normalizeClaimType(opts.claimType);

    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO claims (id, statement, page_id, confidence, first_stated, last_reinforced, decay_rate, tags_json, claim_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          opts.statement,
          opts.pageId,
          opts.confidence,
          now,
          now,
          decayRate,
          JSON.stringify(tags),
          claimType,
        );

      for (const sid of opts.sourceIds) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO claim_sources (claim_id, source_id) VALUES (?, ?)",
          )
          .run(id, sid);
      }

      // Record creation event
      this.db
        .prepare(
          `
        INSERT INTO epistemic_events (id, claim_id, date, type, trigger_source_id, confidence_before, confidence_after, note)
        VALUES (?, ?, ?, 'created', ?, 0, ?, 'Claim first extracted')
      `,
        )
        .run(randomUUID(), id, now, opts.sourceIds[0] ?? null, opts.confidence);
    });

    insert();

    const pageEnt = this.db
      .prepare("SELECT entity_id FROM pages WHERE id = ?")
      .get(opts.pageId) as { entity_id: string | null } | undefined;
    if (pageEnt?.entity_id) {
      this.markViewsStaleForEntity(pageEnt.entity_id);
    }

    return {
      id,
      statement: opts.statement,
      pageId: opts.pageId,
      confidence: opts.confidence,
      claimType,
      sources: opts.sourceIds,
      firstStated: now,
      lastReinforced: now,
      contradictedBy: [],
      dependsOn: [],
      derivedClaims: [],
      decayRate,
      tags,
      timeline: [],
    };
  }

  getClaim(id: string): Claim | null {
    const row = this.stmts.getClaimById.get(id) as any;
    if (!row) return null;
    return this.rowToClaim(row);
  }

  getClaimsByPage(pageId: string): Claim[] {
    return (this.stmts.claimsByPage.all(pageId) as any[]).map((r) =>
      this.rowToClaim(r),
    );
  }

  updateClaimConfidence(id: string, confidence: number): void {
    this.db
      .prepare(
        "UPDATE claims SET confidence = ?, last_reinforced = ? WHERE id = ?",
      )
      .run(confidence, new Date().toISOString(), id);
  }

  reinforceClaim(
    claimId: string,
    sourceId: string,
    newConfidence: number,
    note: string = "",
  ): void {
    const claim = this.getClaim(claimId);
    if (!claim) return;

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE claims SET confidence = ?, last_reinforced = ? WHERE id = ?",
        )
        .run(newConfidence, now, claimId);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO claim_sources (claim_id, source_id) VALUES (?, ?)",
        )
        .run(claimId, sourceId);
      this.db
        .prepare(
          `
        INSERT INTO epistemic_events (id, claim_id, date, type, trigger_source_id, confidence_before, confidence_after, note)
        VALUES (?, ?, ?, 'reinforced', ?, ?, ?, ?)
      `,
        )
        .run(
          randomUUID(),
          claimId,
          now,
          sourceId,
          claim.confidence,
          newConfidence,
          note,
        );
    })();
  }

  challengeClaim(
    claimId: string,
    sourceId: string,
    newConfidence: number,
    note: string,
  ): void {
    const claim = this.getClaim(claimId);
    if (!claim) return;

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE claims SET confidence = ? WHERE id = ?")
        .run(newConfidence, claimId);
      this.db
        .prepare(
          `
        INSERT INTO epistemic_events (id, claim_id, date, type, trigger_source_id, confidence_before, confidence_after, note)
        VALUES (?, ?, ?, 'challenged', ?, ?, ?, ?)
      `,
        )
        .run(
          randomUUID(),
          claimId,
          now,
          sourceId,
          claim.confidence,
          newConfidence,
          note,
        );
    })();
  }

  addClaimDependency(claimId: string, dependsOnId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO claim_dependencies (claim_id, depends_on_claim_id) VALUES (?, ?)",
      )
      .run(claimId, dependsOnId);
  }

  addClaimContradiction(claimId: string, contradictedById: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO claim_contradictions (claim_id, contradicted_by_claim_id) VALUES (?, ?)",
      )
      .run(claimId, contradictedById);
  }

  listClaims(opts?: {
    minConfidence?: number;
    maxConfidence?: number;
    pageId?: string;
  }): Claim[] {
    let sql = "SELECT * FROM claims WHERE 1=1";
    const params: any[] = [];
    if (opts?.minConfidence !== undefined) {
      sql += " AND confidence >= ?";
      params.push(opts.minConfidence);
    }
    if (opts?.maxConfidence !== undefined) {
      sql += " AND confidence <= ?";
      params.push(opts.maxConfidence);
    }
    if (opts?.pageId) {
      sql += " AND page_id = ?";
      params.push(opts.pageId);
    }
    sql += " ORDER BY confidence DESC";
    return (this.db.prepare(sql).all(...params) as any[]).map((r) =>
      this.rowToClaim(r),
    );
  }

  getStaleClaims(thresholdDays: number): Claim[] {
    const cutoff = new Date(
      Date.now() - thresholdDays * 86400000,
    ).toISOString();
    return (this.stmts.staleClaims.all(cutoff) as any[]).map((r) =>
      this.rowToClaim(r),
    );
  }

  getContestedClaims(): Claim[] {
    return (this.stmts.contestedClaims.all() as any[]).map((r) =>
      this.rowToClaim(r),
    );
  }

  getDependents(claimId: string): Claim[] {
    return (this.stmts.dependentsOf.all(claimId) as any[]).map((r) =>
      this.rowToClaim(r),
    );
  }

  // ---- Epistemic Events ----

  getClaimTimeline(claimId: string): EpistemicEvent[] {
    return (this.stmts.claimTimeline.all(claimId) as any[]).map((r) =>
      this.rowToEvent(r),
    );
  }

  addEvent(event: Omit<EpistemicEvent, "id">): EpistemicEvent {
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO epistemic_events (id, claim_id, date, type, trigger_source_id, confidence_before, confidence_after, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        event.claimId,
        event.date,
        event.type,
        event.triggerSourceId,
        event.confidenceBefore,
        event.confidenceAfter,
        event.note,
      );
    return { id, ...event };
  }

  // ---- Stats ----

  stats(): { sources: number; pages: number; claims: number; events: number } {
    return this.stmts.stats.get() as any;
  }

  // ---- Fast flat methods (no N+1) ----

  listClaimsFlat(): any[] {
    return (this.stmts.listClaimsFlat.all() as any[]).map((r) => ({
      id: r.id,
      statement: r.statement,
      pageId: r.page_id,
      confidence: r.confidence,
      claimType: normalizeClaimType(r.claim_type),
      sourceCount: r.source_count,
      contradictionCount: r.contradiction_count,
      dependencyCount: r.dependency_count,
      firstStated: r.first_stated,
      lastReinforced: r.last_reinforced,
      tags: JSON.parse(r.tags_json),
    }));
  }

  listPagesFlat(): any[] {
    return (this.stmts.listPagesFlat.all() as any[]).map((r) => {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(r.metadata_json || "{}");
      } catch {
        metadata = {};
      }
      return {
        id: r.id,
        title: r.title,
        path: r.path,
        summary: r.summary,
        kind: r.kind ?? "topic",
        metadata,
        entityId: r.entity_id ?? null,
        claimCount: r.claim_count,
        linkCount: r.link_count,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  listEventsFlat(limit: number = 200): any[] {
    return (this.stmts.listEventsRecent.all(limit) as any[]).map((r) => ({
      id: r.id,
      claimId: r.claim_id,
      date: r.date,
      type: r.type,
      triggerSourceId: r.trigger_source_id,
      confidenceBefore: r.confidence_before,
      confidenceAfter: r.confidence_after,
      note: r.note,
      claimStatement: r.claim_statement,
    }));
  }

  /** Resolve entity id from canonical name, alias, or partial canonical match. */
  resolveEntityIdFromName(name: string): string | null {
    const n = name.trim();
    if (!n) return null;
    const exact = this.getEntityByCanonicalName(n);
    if (exact) return exact.id;
    const alias = this.resolveEntityAlias(n);
    if (alias) return alias;
    const row = this.db
      .prepare(
        "SELECT id FROM entities WHERE canonical_name LIKE ? COLLATE NOCASE LIMIT 1",
      )
      .get(`%${n}%`) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Traverse typed relations from an entity name (canonical, alias, or partial).
   */
  queryGraph(
    entity: string,
    opts?: {
      relationTypes?: string[];
      direction?: "outbound" | "inbound" | "both";
    },
  ): Array<{
    from: { id: string; name: string; type: string };
    relation_type: string;
    to: { id: string; name: string; type: string };
    confidence: number;
  }> {
    const eid = this.resolveEntityIdFromName(entity);
    if (!eid) return [];
    const dir = opts?.direction ?? "both";
    const types =
      opts?.relationTypes?.length && opts.relationTypes.length > 0
        ? new Set(opts.relationTypes)
        : null;
    const rels = this.listRelations({ entityId: eid });
    const out: Array<{
      from: { id: string; name: string; type: string };
      relation_type: string;
      to: { id: string; name: string; type: string };
      confidence: number;
    }> = [];
    for (const rel of rels) {
      if (types && !types.has(rel.relationType)) continue;
      const outbound = rel.fromEntityId === eid;
      if (dir === "outbound" && !outbound) continue;
      if (dir === "inbound" && outbound) continue;
      const fe = this.getEntity(rel.fromEntityId);
      const te = this.getEntity(rel.toEntityId);
      if (!fe || !te) continue;
      out.push({
        from: {
          id: fe.id,
          name: fe.canonicalName,
          type: fe.type,
        },
        relation_type: rel.relationType,
        to: { id: te.id, name: te.canonicalName, type: te.type },
        confidence: rel.confidence,
      });
    }
    return out;
  }

  private graphRelationsForSearch(
    matchedPages: { id: string }[],
    words: string[],
    limit: number,
  ): Array<{
    from: { id: string; name: string; type: string };
    relation_type: string;
    to: { id: string; name: string; type: string };
  }> {
    const entityIds = new Set<string>();
    for (const pr of matchedPages) {
      const page = this.getPage(pr.id);
      if (page?.entityId) entityIds.add(page.entityId);
    }
    for (const w of words) {
      const pattern = `%${w}%`;
      const entRows = this.db
        .prepare(
          "SELECT id FROM entities WHERE canonical_name LIKE ? COLLATE NOCASE LIMIT 8",
        )
        .all(pattern) as { id: string }[];
      for (const r of entRows) entityIds.add(r.id);
      const aliasRows = this.db
        .prepare(
          "SELECT entity_id FROM entity_aliases WHERE alias LIKE ? COLLATE NOCASE LIMIT 8",
        )
        .all(pattern) as { entity_id: string }[];
      for (const r of aliasRows) entityIds.add(r.entity_id);
    }
    const out: Array<{
      from: { id: string; name: string; type: string };
      relation_type: string;
      to: { id: string; name: string; type: string };
    }> = [];
    const seen = new Set<string>();
    for (const eid of entityIds) {
      for (const rel of this.listRelations({ entityId: eid })) {
        if (seen.has(rel.id)) continue;
        seen.add(rel.id);
        const fe = this.getEntity(rel.fromEntityId);
        const te = this.getEntity(rel.toEntityId);
        if (!fe || !te) continue;
        out.push({
          from: {
            id: fe.id,
            name: fe.canonicalName,
            type: fe.type,
          },
          relation_type: rel.relationType,
          to: { id: te.id, name: te.canonicalName, type: te.type },
        });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  search(
    query: string,
    limit: number = 20,
  ): {
    pages: any[];
    claims: any[];
    relations: Array<{
      from: { id: string; name: string; type: string };
      relation_type: string;
      to: { id: string; name: string; type: string };
    }>;
  } {
    const safeQ = query.replace(/[^a-zA-Z0-9\s]/g, "").trim();
    if (!safeQ) return { pages: [], claims: [], relations: [] };
    const stopWords = new Set([
      "a",
      "an",
      "the",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "shall",
      "should",
      "may",
      "might",
      "must",
      "can",
      "could",
      "of",
      "in",
      "to",
      "for",
      "with",
      "on",
      "at",
      "from",
      "by",
      "about",
      "as",
      "into",
      "through",
      "during",
      "before",
      "after",
      "above",
      "below",
      "between",
      "out",
      "off",
      "over",
      "under",
      "again",
      "further",
      "then",
      "once",
      "here",
      "there",
      "when",
      "where",
      "why",
      "how",
      "all",
      "both",
      "each",
      "few",
      "more",
      "most",
      "other",
      "some",
      "such",
      "no",
      "nor",
      "not",
      "only",
      "own",
      "same",
      "so",
      "than",
      "too",
      "very",
      "what",
      "which",
      "who",
      "whom",
      "this",
      "that",
      "these",
      "those",
      "it",
      "its",
      "i",
      "me",
      "my",
      "we",
      "our",
      "you",
      "your",
      "he",
      "him",
      "his",
      "she",
      "her",
    ]);
    const words = safeQ
      .split(/\s+/)
      .filter((w) => !stopWords.has(w.toLowerCase()) && w.length > 1);
    if (words.length === 0) return { pages: [], claims: [], relations: [] };
    const ftsQuery = words.map((w) => `${w}*`).join(" OR ");
    try {
      const pages = (this.stmts.searchPages.all(ftsQuery, limit) as any[]).map(
        (r) => ({
          id: r.id,
          title: r.title,
          summary: r.summary,
          type: "page" as const,
        }),
      );
      const claims = (
        this.stmts.searchClaims.all(ftsQuery, limit) as any[]
      ).map((r) => ({
        id: r.id,
        statement: r.statement,
        pageId: r.page_id,
        confidence: r.confidence,
        claimType: normalizeClaimType(r.claim_type),
        type: "claim" as const,
      }));
      const relations = this.graphRelationsForSearch(pages, words, limit);
      return { pages, claims, relations };
    } catch (e) {
      // FTS5 query syntax error — fall back to LIKE with individual words
      const likeConditions = words
        .map(() => "(title LIKE ? OR summary LIKE ?)")
        .join(" OR ");
      const likeParams = words.flatMap((w) => {
        const l = `%${w}%`;
        return [l, l];
      });
      const pages = (
        this.db
          .prepare(
            `SELECT id, title, summary FROM pages WHERE ${likeConditions} LIMIT ?`,
          )
          .all(...likeParams, limit) as any[]
      ).map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        type: "page" as const,
      }));
      const claimConditions = words.map(() => "statement LIKE ?").join(" OR ");
      const claimParams = words.map((w) => `%${w}%`);
      const claims = (
        this.db
          .prepare(
            `SELECT id, statement, page_id, confidence, claim_type FROM claims WHERE ${claimConditions} LIMIT ?`,
          )
          .all(...claimParams, limit) as any[]
      ).map((r) => ({
        id: r.id,
        statement: r.statement,
        pageId: r.page_id,
        confidence: r.confidence,
        claimType: normalizeClaimType(r.claim_type),
        type: "claim" as const,
      }));
      const relations = this.graphRelationsForSearch(pages, words, limit);
      return { pages, claims, relations };
    }
  }

  // ---- Embeddings (vector search) ----

  upsertEmbedding(opts: {
    subjectType: string;
    subjectId: string;
    model: string;
    vector: Float32Array;
    textHash: string;
  }): void {
    const now = new Date().toISOString();
    const buf = Buffer.from(
      opts.vector.buffer,
      opts.vector.byteOffset,
      opts.vector.byteLength,
    );
    const existing = this.db
      .prepare(
        `SELECT id FROM embeddings WHERE subject_type = ? AND subject_id = ? AND model = ?`,
      )
      .get(opts.subjectType, opts.subjectId, opts.model) as
      | { id: string }
      | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE embeddings SET vector_blob = ?, text_hash = ?, created_at = ? WHERE id = ?`,
        )
        .run(buf, opts.textHash, now, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO embeddings (id, subject_type, subject_id, model, vector_blob, text_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          opts.subjectType,
          opts.subjectId,
          opts.model,
          buf,
          opts.textHash,
          now,
        );
    }
  }

  getEmbeddingRecordHash(
    subjectType: string,
    subjectId: string,
    model: string,
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT text_hash FROM embeddings WHERE subject_type = ? AND subject_id = ? AND model = ?`,
      )
      .get(subjectType, subjectId, model) as { text_hash: string } | undefined;
    return row?.text_hash ?? null;
  }

  listEmbeddingRowsForModel(model: string): Array<{
    subjectType: string;
    subjectId: string;
    vector: Float32Array;
  }> {
    const rows = this.db
      .prepare(
        `SELECT subject_type, subject_id, vector_blob FROM embeddings WHERE model = ?`,
      )
      .all(model) as {
      subject_type: string;
      subject_id: string;
      vector_blob: Buffer;
    }[];
    return rows.map((r) => ({
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      vector: new Float32Array(
        r.vector_blob.buffer,
        r.vector_blob.byteOffset,
        r.vector_blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
      ),
    }));
  }

  getPageFull(id: string): { page: WikiPage; claims: any[] } | null {
    const page = this.getPage(id);
    if (!page) return null;
    const claims = (this.stmts.pageClaimsFull.all(id) as any[]).map((r) => ({
      id: r.id,
      statement: r.statement,
      confidence: r.confidence,
      claimType: normalizeClaimType(r.claim_type),
      sourceCount: r.source_count,
      firstStated: r.first_stated,
      lastReinforced: r.last_reinforced,
      tags: JSON.parse(r.tags_json),
    }));
    return { page, claims };
  }

  getClaimPageId(claimId: string): string | null {
    const row = this.stmts.getClaimPageId.get(claimId) as any;
    return row ? row.page_id : null;
  }

  listPageTitles(): { id: string; title: string }[] {
    return this.stmts.pageTitles.all() as any[];
  }

  listPagesWithoutSummary(): string[] {
    return (this.stmts.pagesWithoutSummary.all() as any[]).map((r) => r.id);
  }

  // ---- Mutations for dashboard editing ----

  deletePage(id: string): void {
    this.db.transaction(() => {
      // Delete claims on this page + their events, sources, deps, contradictions
      const claimIds = (
        this.db
          .prepare("SELECT id FROM claims WHERE page_id = ?")
          .all(id) as any[]
      ).map((r) => r.id);
      for (const cid of claimIds) {
        this.db
          .prepare("DELETE FROM epistemic_events WHERE claim_id = ?")
          .run(cid);
        this.db
          .prepare("DELETE FROM claim_sources WHERE claim_id = ?")
          .run(cid);
        this.db
          .prepare(
            "DELETE FROM claim_dependencies WHERE claim_id = ? OR depends_on_claim_id = ?",
          )
          .run(cid, cid);
        this.db
          .prepare(
            "DELETE FROM claim_contradictions WHERE claim_id = ? OR contradicted_by_claim_id = ?",
          )
          .run(cid, cid);
      }
      this.db.prepare("DELETE FROM claims WHERE page_id = ?").run(id);
      this.db
        .prepare(
          "DELETE FROM page_links WHERE from_page_id = ? OR to_page_id = ?",
        )
        .run(id, id);
      this.db.prepare("DELETE FROM pages WHERE id = ?").run(id);
    })();
  }

  deleteClaim(id: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM epistemic_events WHERE claim_id = ?")
        .run(id);
      this.db.prepare("DELETE FROM claim_sources WHERE claim_id = ?").run(id);
      this.db
        .prepare(
          "DELETE FROM claim_dependencies WHERE claim_id = ? OR depends_on_claim_id = ?",
        )
        .run(id, id);
      this.db
        .prepare(
          "DELETE FROM claim_contradictions WHERE claim_id = ? OR contradicted_by_claim_id = ?",
        )
        .run(id, id);
      this.db.prepare("DELETE FROM claims WHERE id = ?").run(id);
    })();
  }

  updateClaimStatement(id: string, statement: string): void {
    this.db
      .prepare("UPDATE claims SET statement = ? WHERE id = ?")
      .run(statement, id);
  }

  deleteEmptyPages(): number {
    const emptyPages = this.db
      .prepare(
        "SELECT p.id FROM pages p LEFT JOIN claims c ON c.page_id = p.id GROUP BY p.id HAVING COUNT(c.id) = 0",
      )
      .all() as any[];
    for (const row of emptyPages) {
      this.db
        .prepare(
          "DELETE FROM page_links WHERE from_page_id = ? OR to_page_id = ?",
        )
        .run(row.id, row.id);
      this.db.prepare("DELETE FROM pages WHERE id = ?").run(row.id);
    }
    return emptyPages.length;
  }

  /**
   * Remove topic pages with no claims (LLM stubs / related-concept shells).
   * Does not delete typed entity pages (person, project, relationship, etc.).
   */
  deleteEmptyTopicPages(): number {
    const emptyTopics = this.db
      .prepare(
        `SELECT p.id FROM pages p
         LEFT JOIN claims c ON c.page_id = p.id
         WHERE p.kind = 'topic'
         GROUP BY p.id
         HAVING COUNT(c.id) = 0`,
      )
      .all() as any[];
    for (const row of emptyTopics) {
      this.db
        .prepare(
          "DELETE FROM page_links WHERE from_page_id = ? OR to_page_id = ?",
        )
        .run(row.id, row.id);
      this.db.prepare("DELETE FROM pages WHERE id = ?").run(row.id);
    }
    return emptyTopics.length;
  }

  // ---- Row mappers ----

  private rowToSource(row: any): Source {
    return {
      id: row.id,
      path: row.path,
      title: row.title,
      type: row.type as SourceType,
      qualityTier: row.quality_tier as QualityTier,
      contentHash: row.content_hash,
      ingestedAt: row.ingested_at,
      metadata: JSON.parse(row.metadata_json),
    };
  }

  private rowToPage(row: any): WikiPage {
    const id = row.id;
    const claims = (this.stmts.pageClaimIds.all(id) as any[]).map((r) => r.id);
    const linksTo = (this.stmts.pageLinksTo.all(id) as any[]).map(
      (r) => r.to_page_id,
    );
    const linkedFrom = (this.stmts.pageLinkedFrom.all(id) as any[]).map(
      (r) => r.from_page_id,
    );
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadata_json || "{}");
    } catch {
      metadata = {};
    }
    return {
      id,
      title: row.title,
      path: row.path,
      summary: row.summary,
      kind: row.kind ?? "topic",
      metadata,
      entityId: row.entity_id ?? null,
      claims,
      linksTo,
      linkedFrom,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToClaim(row: any): Claim {
    const id = row.id;
    const sources = (this.stmts.claimSourceIds.all(id) as any[]).map(
      (r) => r.source_id,
    );
    const contradictedBy = (
      this.stmts.claimContradictions.all(id) as any[]
    ).map((r) => r.contradicted_by_claim_id);
    const dependsOn = (this.stmts.claimDependsOn.all(id) as any[]).map(
      (r) => r.depends_on_claim_id,
    );
    const derivedClaims = (this.stmts.claimDerived.all(id) as any[]).map(
      (r) => r.claim_id,
    );
    const timeline = this.getClaimTimeline(id);
    return {
      id,
      statement: row.statement,
      pageId: row.page_id,
      confidence: row.confidence,
      claimType: normalizeClaimType(row.claim_type),
      sources,
      firstStated: row.first_stated,
      lastReinforced: row.last_reinforced,
      contradictedBy,
      dependsOn,
      derivedClaims,
      decayRate: row.decay_rate,
      tags: JSON.parse(row.tags_json),
      timeline,
    };
  }

  private rowToEvent(row: any): EpistemicEvent {
    return {
      id: row.id,
      claimId: row.claim_id,
      date: row.date,
      type: row.type as EpistemicEventType,
      triggerSourceId: row.trigger_source_id,
      confidenceBefore: row.confidence_before,
      confidenceAfter: row.confidence_after,
      note: row.note,
    };
  }
}
