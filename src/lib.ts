/**
 * Quicky Wiki — Library API
 *
 * Public entry point for embedding quicky-wiki as a dependency.
 * Import from "quicky-wiki" to get typed access to the knowledge store,
 * query engine, ingest pipeline, and LLM adapter factory.
 */

// Core store
export { KnowledgeStore, ENTITY_PAGE_KINDS } from "./graph/store.js";

// Query engine
export { queryKnowledge } from "./graph/query.js";

// Ingest pipeline
export {
  ingestSource,
  inferPageKind,
  resolvePrimaryPageTitle,
} from "./compiler/ingest.js";
export type {
  IngestSourceOptions,
  IngestProgress,
  IngestResult,
} from "./compiler/ingest.js";
export { ensureCompiledView } from "./compiler/views.js";
export { compileRelationsFromClaims } from "./compiler/relation-compiler.js";

// Knowledge resolution (summaries, page rendering)
export { resolveKnowledge, generatePageSummaries } from "./compiler/resolve.js";
export { renderAllPages } from "./render/markdown.js";

// LLM adapter
export { createLLMAdapter } from "./llm/adapter.js";
export type { AdapterConfig } from "./llm/adapter.js";

// Config helpers
export {
  DEFAULT_CONFIG,
  normalizeClaimType,
  CLAIM_TYPES,
  COMPILED_VIEW_TYPES,
} from "./types.js";

// Types
export type {
  QuickyAuthor,
  PrimaryPageTitleRule,
  QuickyConfig,
  WikiPage,
  Entity,
  KnowledgeRelation,
  Claim,
  ClaimType,
  Source,
  EpistemicEvent,
  EpistemicEventType,
  KnowledgeDiff,
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  LLMOptions,
  LLMProvider,
  SourceType,
  QualityTier,
  CompiledViewType,
  CompiledView,
  EntityStateChange,
} from "./types.js";
