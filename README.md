# ⚡ Quicky Wiki

**Turn any collection of documents into a living, confidence-scored knowledge graph — powered by LLMs.**

Quicky Wiki extracts claims from your sources, tracks confidence over time, discovers relationships between entities, and gives you a visual dashboard to explore everything. Think of it as a personal Wikipedia with an opinion about what it's unsure about.

[![npm version](https://img.shields.io/npm/v/quicky-wiki)](https://www.npmjs.com/package/quicky-wiki)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

---

## 30-Second Demo

```bash
npx quicky-wiki init --name "My Research"   # auto-detects your API keys
qw ingest paper.pdf                          # extract claims from a paper
qw ingest https://arxiv.org/abs/2401.12345   # or a URL
qw serve                                     # open the dashboard
```

That's it. Open `http://localhost:3737` and you've got:

- A **knowledge graph** with typed entities and semantic relationships
- **Ask Wiki** — chat with your knowledge base, get answers with confidence scores, citations, and retrieval diagnostics
- Entities, claims, pages, timeline, health, and review views

## What Makes It Different

| Feature | Traditional Wiki | Quicky Wiki |
|---------|-----------------|-------------|
| Who writes it? | You | LLM extracts claims from your sources |
| Confidence? | ❌ Everything looks equally true | ✅ Every claim has a confidence score |
| Contradictions? | Hidden in edit history | Surfaced automatically |
| Temporal tracking? | ❌ | ✅ Claims strengthen, weaken, and decay over time |
| Knowledge gaps? | Unknown unknowns | Discovered and suggested |
| Entity awareness? | ❌ Flat pages | ✅ First-class entities with typed relationships |
| Search? | Keyword only | FTS5 + optional hybrid vector search |
| Multi-format output? | Just a wiki | Wiki, slides, flashcards, graph, timeline |

## Fork: Knowledge Substrate Edition

This fork evolves quicky-wiki from a claim-tracking document tool into a **knowledge substrate** — a structured graph of entities, typed relationships, and confidence-scored claims that can serve as the grounding layer for AI agents.

### What changed from the original

**Entities as first-class objects.** People, projects, places, and organizations are no longer just pages — they're typed entities with canonical names, aliases, structured metadata, and stable IDs that survive renames and re-ingests.

**Typed relationships.** The graph has semantic edges: `child_of`, `spouse_of`, `works_on`, `stakeholder_of`, `depends_on`, `located_in`. Relationships are extracted automatically from claims by a relation compiler, carry confidence scores, and support temporal validity (`valid_from` / `valid_to`).

**Claim subtypes.** Not all claims are created equal. Six types — `fact`, `observation`, `preference`, `hypothesis`, `status`, `attribute` — each with appropriate decay rates and retrieval weights. "Ted lives in Seattle" (fact, slow decay) is treated differently from "Hypercard is in proof-of-concept" (status, fast decay).

**Hybrid retrieval.** Optional FTS5 + vector embedding search. When enabled, queries are scored with a weighted blend of lexical match, cosine similarity, confidence, recency, and entity-type boost. Configurable weights in `config.yaml`.

**Smarter extraction.** The ingestion pipeline runs a relation compiler over new claims, extracts structured entity metadata per kind (person schemas, project schemas), and performs identity resolution against the known entity catalog with alias tracking.

**Compiled views.** Pre-computed, entity-scoped views (`summary`, `agent_context`) stored in SQLite. Automatically marked stale when underlying claims or relations change, regenerated on demand.

**Entity state tracking.** A change log (`entity_state_log`) records world-state transitions — "project status changed active → paused", "last_contact updated" — separate from epistemic events about belief changes.

**Enhanced dashboard.** Entities view, review queue for pending aliases, retrieval debug panel in Ask Wiki, type-prefixed search (`entity:person`, `claim:fact`), entity counts on the overview, and graph visualization with typed relation edges.

## Install

```bash
npm install -g quicky-wiki
```

The package exposes three equivalent commands: **`quicky-wiki`**, **`qw`**, and **`create-quicky-wiki`** (all run the same CLI). Use whichever fits your muscle memory or tooling.

Or use directly with npx:

```bash
npx quicky-wiki init
```

From a git clone of this repo, run **`npm run build`** before `npx quicky-wiki …`, `node dist/cli.js …`, or `npm start`, because the published CLI is the compiled `dist/` bundle.

### Requirements

- **Node.js >= 20**
- An API key from **one** of these providers:

| Provider | Env Variable | Example Model |
|----------|-------------|---------------|
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.0-flash` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| Ollama | _(local, no key)_ | `llama3` |
| Any OpenAI-compatible | Custom env var + `--base-url` | Groq, Together, vLLM, LM Studio |

`qw init` **auto-detects** whichever API key you have set — no config needed.

## Usage

### Initialize

```bash
mkdir my-wiki && cd my-wiki
qw init --name "My Research"

# Or specify a provider explicitly
qw init --provider gemini --model gemini-2.0-flash
qw init --provider openai --model gpt-4o

# OpenAI-compatible (Groq, Together, etc.)
qw init --provider openai-compatible \
  --base-url https://api.groq.com/openai/v1 \
  --api-key-env GROQ_API_KEY
```

### Ingest Sources

```bash
# Local files (markdown, text, PDF)
qw ingest paper.md --type paper --quality peer-reviewed
qw ingest notes.md --type note

# URLs (fetches and extracts automatically)
qw ingest https://example.com/article

# Batch ingest a directory
qw ingest raw/
```

### Query Your Knowledge

```bash
qw query "What are the key approaches to reinforcement learning?"
qw query "How do transformers compare to RNNs?"
```

### Explore with the Dashboard

```bash
qw serve                 # http://localhost:3737
qw serve --port 8080     # custom port
```

The dashboard includes:
- **Overview** — Stats at a glance: sources, pages, entities, claims, confidence distribution
- **Knowledge Graph** — Interactive canvas visualization with typed relation edges and entity-type indicators
- **Claims** — Browse all claims with confidence scores, type badges, and type filters
- **Pages** — Wiki pages with entity badges and kind grouping
- **Entities** — Browse entities by type (person, project, place, ...) with alias, claim, and relation counts
- **Timeline** — Epistemic events and entity state transitions
- **Health** — Knowledge integrity: stale claims, contradictions, gaps
- **Review Queue** — Pending alias resolutions flagged during ingestion
- **Ask Wiki** — Chat with your knowledge base; retrieval debug shows search strategy, claim/entity type breakdown, and timing

When you open a page, the slideout shows **Linked pages** (graph neighbors) and the **rendered wiki markdown** from `wiki/`. Inline **Obsidian-style wikilinks** work in that preview: `[[Page Title]]` and `[[label|Page Title]]` open the matching page by title. The dashboard script is embedded in the built CLI, so after changing TypeScript sources, run **`npm run build`** and restart `serve` to see UI updates.

### Knowledge Health

```bash
qw lint                        # check for issues
qw metabolism --report         # full health report
qw metabolism --decay          # apply confidence decay over time
qw metabolism --resurface      # find stale claims worth revisiting
qw metabolism --redteam        # challenge high-confidence claims
```

### Compile to Other Formats

```bash
qw compile markdown            # Obsidian-compatible wiki pages
qw compile slides --topic X    # Marp slide deck
qw compile anki                # flashcards
qw compile graph               # D3 knowledge graph
qw compile timeline            # temporal visualization
```

### Discover New Directions

```bash
qw discover --mode gaps          # what's missing?
qw discover --mode horizon       # frontier topics
qw discover --mode bridges       # connections between distant concepts
qw discover --mode contradictions # conflicting claims
```

## How It Works

```
Source Document
     ↓
LLM Extraction → Claims (typed: fact, status, preference, ...)
     ↓                   ↓
Entity Resolution    Relation Compiler
     ↓                   ↓
Entities + Relations + Claims ← Knowledge Graph (SQLite)
     ↓                              ↓
Compiled Views              Epistemic Events (belief log)
     ↓                     Entity State Log (world-state log)
     ↓
Wiki pages, slides, graph, timeline, agent context cards
     ↓
Dashboard (interactive visualization + chat + retrieval debug)
```

### Key Concepts

- **Entity** — A first-class object (person, project, place, organization) with a canonical name, type, aliases, structured metadata, and stable ID.
- **Relation** — A typed, directed edge between entities (`child_of`, `works_on`, `spouse_of`, ...) with confidence, temporal validity, and claim provenance.
- **Claim** — An atomic, verifiable statement extracted from a source. Has a confidence score, a type (fact/observation/preference/hypothesis/status/attribute), provenance, and dependency chain.
- **Epistemic Event** — A change in belief: created, reinforced, challenged, weakened, superseded, or resolved.
- **Knowledge Diff** — When you ingest a new source, you see what's new, reinforced, challenged, and what gaps were found.
- **Cascade** — When a foundational claim is challenged, confidence changes propagate through dependent claims.
- **Compiled View** — A pre-computed, entity-scoped output (summary, agent context card) that stays fresh via staleness tracking.
- **Metabolism** — Active maintenance: decay, resurfacing, red-teaming.

## MCP Server

Quicky Wiki includes a built-in [Model Context Protocol](https://modelcontextprotocol.io/) server for integration with AI agents:

```bash
qw mcp                          # stdio mode (for Claude Desktop, etc.)
qw mcp --http --port 3000       # HTTP mode
```

Tools include querying (with hybrid retrieval), search (FTS + optional vector), listing pages/claims/entities/relations, ingestion, graph traversal, and health reporting. Entity-aware tools: **`list_entities`** (filter by kind and metadata), **`query_graph`** (traverse typed relations), and **`update_entity_metadata`** (deep-merge metadata without re-ingesting). Use each tool’s schema in your MCP client for full argument lists.

## Project Structure

```
my-wiki/
├── .quicky/
│   ├── config.yaml          # LLM provider, model, wiki name, retrieval config
│   └── graph.sqlite         # knowledge graph (see schema below)
├── raw/                     # your source documents (immutable)
└── wiki/                    # compiled output (Obsidian-compatible markdown)
```

### SQLite schema (`graph.sqlite`)

| Table | Purpose |
|-------|---------|
| `sources` | Ingested source files with content hashes |
| `entities` | First-class typed entities (person, project, place, ...) |
| `entity_aliases` | Name variants per entity for search resolution |
| `pages` | Wiki pages with optional `entity_id` FK |
| `claims` | Confidence-scored, typed claims (`fact`, `status`, `preference`, ...) |
| `claim_sources` | Claim ↔ source provenance |
| `claim_dependencies` | Logical claim dependencies |
| `claim_contradictions` | Claim contradictions |
| `relations` | Typed edges between entities with temporal validity |
| `epistemic_events` | Belief change timeline |
| `embeddings` | Vector embeddings for hybrid search |
| `compiled_views` | Pre-computed entity views with staleness tracking |
| `entity_state_log` | World-state change history |
| `pending_aliases` | Unresolved alias candidates for review |
| `page_links` | Legacy page-level links |
| `claims_fts` / `pages_fts` | FTS5 indexes |

## Configuration

Project settings live in **`.quicky/config.yaml`** (JSON syntax is fine). Besides `llm`, `paths`, and `metabolism`, you can set optional **`kindRules`**, **`entityPrompts`**, **`primaryPageTitleRules`**, **`author`**, **`defaultQualityTier`**, and **`qualityWeights`** — see the type definitions in the library or your project’s config for examples.

### Hybrid search (`retrieval`)

Enable optional embedding-based search for semantic retrieval alongside FTS5:

```yaml
retrieval:
  hybridSearch: true                      # enable hybrid FTS + vector search
  embeddingModel: text-embedding-3-small  # default model
  # Ranking weights (must sum to ~1.0):
  wFts: 0.35      # lexical precision
  wVec: 0.35      # semantic recall
  wConf: 0.15     # prefer high-confidence claims
  wRec: 0.10      # prefer recently reinforced
  wType: 0.05     # boost entity matches
```

Requires an OpenAI API key (`OPENAI_API_KEY`) for embedding generation. Without it, the system gracefully falls back to FTS5-only — the Ask Wiki retrieval debug pill shows the active strategy.

Optional: **`autoDedup: true`** — after each embedding sync, enqueue high-similarity same-type entity pairs into the **Review Queue** (`pending_aliases`) for confirmation (confirming runs a full merge when the surface form is another entity’s canonical name).

Retroactive cleanup:

```bash
qw dedup-entities              # interactive: merge pairs (embedding similarity)
qw dedup-entities --dry-run
qw dedup-entities --auto-merge --threshold 0.92
```

### Primary page titles (`primaryPageTitleRules`)

When ingesting a source, Quicky syncs a **primary wiki page** for that file’s entity (`kind` + frontmatter metadata). By default the page title is **`name` → `title` → filename stem**, which can collide if two files share a stem but represent different entity kinds (e.g. a person note and a relationship note both named `Jane.md`).

**`primaryPageTitleRules`** is a list of `{ "kind": "<page kind>", "template": "..." }` objects. The **first** rule whose `kind` matches the inferred page kind is used. **`template`** may include placeholders:

| Placeholder | Resolved from |
|-------------|----------------|
| `{{stem}}` | File-derived title (usually the filename without extension). Same as `{{sourceTitle}}`. |
| `{{sourceTitle}}` | Same as `{{stem}}`. |
| `{{anyField}}` | Any key from the file’s YAML frontmatter (and ingest metadata overrides). If the value is missing or empty, the placeholder falls back to the stem. |

Literal text outside `{{...}}` is copied as-is (spaces, parentheses, suffixes).

**Example** — relationship pages titled like the person, but disambiguated in the graph:

```json
"primaryPageTitleRules": [
  { "kind": "relationship", "template": "{{person}} (relationship)" }
]
```

With frontmatter `person: Jane` and file `Jane.md`, the graph page title becomes **`Jane (relationship)`**; a separate person source can still use the default title **`Jane`**.

You can define multiple rules for different `kind` values. Kinds are whatever your **`kindRules`** and frontmatter produce (not built into Quicky).

## Development

```bash
git clone <repo-url> quicky-wiki && cd quicky-wiki
npm install
npm run build # required before serve / dist-based CLI picks up TS changes
npm run typecheck      # optional
```

## License

MIT
