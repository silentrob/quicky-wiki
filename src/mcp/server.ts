import { createServer } from "node:http";
import { resolve } from "node:path";
import type { KnowledgeStore } from "../graph/store.js";
import type { LLMAdapter, QuickyConfig, CompiledViewType } from "../types.js";
import { COMPILED_VIEW_TYPES } from "../types.js";
import { queryKnowledge } from "../graph/query.js";
import { ingestSource } from "../compiler/ingest.js";
import { generatePageSummaries } from "../compiler/resolve.js";
import { renderAllPages } from "../render/markdown.js";
import { generateHealthReport } from "../metabolism/health.js";

/**
 * MCP-compatible JSON-RPC server that exposes the wiki as tools.
 * Implements the Model Context Protocol (MCP) specification.
 *
 * Tools exposed:
 * - query_wiki: Ask a question against the knowledge base
 * - list_pages: List wiki pages (optional kind filter)
 * - list_entities: List first-class entities by type with metadata filters
 * - get_page: Get detailed page content
 * - search_wiki: FTS search pages and claims
 * - list_claims: List claims with optional confidence filter
 * - health_report: Get knowledge health report
 * - ingest_file: Ingest a source file (optional kind/metadata overrides)
 * - update_entity_metadata: Merge fields into page metadata_json
 * - get_compiled_view: LLM-compiled entity view (summary, agent_context, status_card, briefing)
 */
export function startMCPServer(
  store: KnowledgeStore,
  config: QuickyConfig,
  llm: LLMAdapter,
  mode: "stdio" | "http",
  port?: number,
): Promise<string | void> {
  if (mode === "stdio") {
    return startStdioMCP(store, config, llm);
  }
  return startHttpMCP(store, config, llm, port ?? 3838);
}

const TOOLS = [
  {
    name: "query_wiki",
    description:
      "Ask a question against the Quicky Wiki knowledge base. Returns answer with confidence score and cited claims.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask" },
      },
      required: ["question"],
    },
  },
  {
    name: "list_pages",
    description:
      "List all wiki pages with titles, summaries, claim counts, and confidence averages.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description:
            "Optional: only pages with this entity kind (e.g. person, project, topic)",
        },
      },
    },
  },
  {
    name: "list_entities",
    description:
      "List first-class entities of a given type (person, project, etc.) with metadata, aliases, and claim counts.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Entity kind to filter by (e.g. person, project, topic)",
        },
        filter: {
          type: "object",
          description:
            "Optional key-value filters on metadata (e.g. { status: 'active' })",
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "get_page",
    description: "Get detailed wiki page including claims, links, and content.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Page title in the graph (e.g. 'Heather' for a person, 'Heather (relationship)' for a relationship vault file)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "search_wiki",
    description: "Search wiki pages and claims by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "query_graph",
    description:
      "Traverse typed relations between entities (people, projects, etc.). Use when you need structured connections, not keyword search. Known relation_type values include: child_of, spouse_of, works_on, stakeholder_of, depends_on, located_in, related_to.",
    inputSchema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description: "Entity name to start from (canonical name or alias)",
        },
        relation_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional filter: only these relation types. Omit for all types.",
        },
        direction: {
          type: "string",
          enum: ["outbound", "inbound", "both"],
          description:
            "outbound: entity → other; inbound: other → entity; both: default",
        },
      },
      required: ["entity"],
    },
  },
  {
    name: "list_claims",
    description:
      "List knowledge claims with confidence scores, optionally filtered.",
    inputSchema: {
      type: "object",
      properties: {
        min_confidence: {
          type: "number",
          description: "Minimum confidence (0-1)",
        },
        max_confidence: {
          type: "number",
          description: "Maximum confidence (0-1)",
        },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "health_report",
    description:
      "Get the knowledge base health report: confidence distribution, stale claims, contested claims, gaps.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ingest_file",
    description:
      "Ingest a source file into the wiki. File must exist in the raw/ directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the source file to ingest",
        },
        kind: {
          type: "string",
          description: "Override entity kind for the primary page from this file",
        },
        metadata: {
          type: "object",
          description: "Extra fields merged into the primary page metadata_json",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "update_entity_metadata",
    description:
      "Merge key-value pairs into a page's metadata_json. Does not change claims.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Wiki page title (relationship entities are titled '{Person} (relationship)')",
        },
        metadata: {
          type: "object",
          description: "Fields to merge into existing metadata",
        },
      },
      required: ["title", "metadata"],
    },
  },
  {
    name: "get_compiled_view",
    description:
      "Get or generate a compiled LLM view for an entity: summary, agent_context, status_card, or briefing.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "Entity UUID from list_entities",
        },
        view_type: {
          type: "string",
          enum: [...COMPILED_VIEW_TYPES],
          description: "Which compiled slice to return",
        },
        force: {
          type: "boolean",
          description: "When true, regenerate even if cached and fresh",
        },
      },
      required: ["entity_id", "view_type"],
    },
  },
];

async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  store: KnowledgeStore,
  config: QuickyConfig,
  llm: LLMAdapter,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (toolName) {
    case "query_wiki": {
      const result = await queryKnowledge(
        store,
        llm,
        args.question as string,
        config,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                answer: result.answer,
                confidence: result.confidence,
                claimsReferenced: result.claimIds.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case "list_pages": {
      const kindFilter = args.kind as string | undefined;
      let pages = store.listPages();
      if (kindFilter) {
        pages = pages.filter((p) => p.kind === kindFilter);
      }
      const claims = store.listClaims();
      const result = pages.map((p) => {
        const pageClaims = claims.filter((c) => c.pageId === p.id);
        const avgConf = pageClaims.length
          ? pageClaims.reduce((s, c) => s + c.confidence, 0) / pageClaims.length
          : 0;
        return {
          title: p.title,
          kind: p.kind,
          summary: p.summary || "(no summary)",
          claims: pageClaims.length,
          avgConfidence: Math.round(avgConf * 100) + "%",
          links: p.linksTo.length,
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "list_entities": {
      const kind = args.kind as string;
      const filter = args.filter as Record<string, unknown> | undefined;
      const entities = store.listEntities({ type: kind });
      const matches = entities.filter((e) => {
        if (!filter) return true;
        return Object.entries(filter).every(([k, v]) => e.metadata[k] === v);
      });
      const result = matches.map((e) => {
        const detail = store.getEntityDetail(e.id)!;
        return {
          id: e.id,
          canonicalName: e.canonicalName,
          type: e.type,
          status: e.status,
          metadata: e.metadata,
          aliases: detail.aliases,
          primaryPageTitle: detail.primaryPage?.title ?? null,
          claimCount: detail.claims.length,
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "get_page": {
      const page = store.getPageByTitle(args.title as string);
      if (!page) {
        return {
          content: [{ type: "text", text: `Page "${args.title}" not found.` }],
        };
      }
      const pageClaims = store.getClaimsByPage(page.id);
      const linkedPages = [...page.linksTo, ...page.linkedFrom]
        .map((id) => store.getPage(id))
        .filter(Boolean)
        .map((p) => p!.title);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                title: page.title,
                kind: page.kind,
                metadata: page.metadata,
                summary: page.summary,
                claims: pageClaims.map((c) => ({
                  statement: c.statement,
                  confidence: Math.round(c.confidence * 100) + "%",
                  sources: c.sources.length,
                  tags: c.tags,
                })),
                relatedPages: linkedPages,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case "search_wiki": {
      const q = args.query as string;
      const results = config.retrieval?.hybridSearch
        ? await (await import("../embeddings/hybrid-search.js")).hybridSearch(
            store,
            q,
            20,
            config,
          )
        : store.search(q, 20);
      return {
        content: [
          { type: "text", text: JSON.stringify(results, null, 2) },
        ],
      };
    }

    case "query_graph": {
      const entity = args.entity as string;
      const relationTypes = args.relation_types as string[] | undefined;
      const direction = args.direction as
        | "outbound"
        | "inbound"
        | "both"
        | undefined;
      const edges = store.queryGraph(entity, {
        relationTypes,
        direction: direction ?? "both",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(edges, null, 2) }],
      };
    }

    case "list_claims": {
      const all = store.listClaims({
        minConfidence: args.min_confidence as number | undefined,
        maxConfidence: args.max_confidence as number | undefined,
      });
      const limit = (args.limit as number) || 50;
      const result = all.slice(0, limit).map((c) => ({
        statement: c.statement,
        confidence: Math.round(c.confidence * 100) + "%",
        sources: c.sources.length,
        tags: c.tags,
        lastReinforced: c.lastReinforced,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "health_report": {
      const report = generateHealthReport(
        store,
        config.metabolism.staleThresholdDays,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    case "ingest_file": {
      const filePath = resolve(args.path as string);
      const kindOverride = args.kind as string | undefined;
      const metadataOverride = args.metadata as
        | Record<string, unknown>
        | undefined;
      const diff = await ingestSource(store, llm, filePath, {
        config,
        ...(kindOverride ? { kind: kindOverride } : {}),
        ...(metadataOverride ? { metadata: metadataOverride } : {}),
      });

      // Generate summaries
      const needSummary = store
        .listPages()
        .filter((p) => !p.summary)
        .map((p) => p.id);
      if (needSummary.length > 0) {
        await generatePageSummaries(store, llm, needSummary);
      }
      await renderAllPages(store, config.paths.wiki);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                source: diff.sourceTitle,
                newClaims: diff.newClaims.length,
                reinforced: diff.reinforced.length,
                challenged: diff.challenged.length,
                newPages: diff.newConcepts.length,
                gaps: diff.gapsIdentified.length,
                relationsCompiled: diff.relationsCompiled ?? 0,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case "get_compiled_view": {
      const entityId = args.entity_id as string;
      const viewType = args.view_type as string;
      const force = args.force === true;
      if (!entityId || !viewType) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "entity_id and view_type required" }),
            },
          ],
        };
      }
      if (!(COMPILED_VIEW_TYPES as readonly string[]).includes(viewType)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `view_type must be one of: ${COMPILED_VIEW_TYPES.join(", ")}`,
              }),
            },
          ],
        };
      }
      try {
        const { ensureCompiledView } = await import("../compiler/views.js");
        const body = await ensureCompiledView(
          store,
          llm,
          entityId,
          viewType as CompiledViewType,
          { force },
        );
        const row = store.getCompiledView(
          entityId,
          viewType as CompiledViewType,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  body,
                  stale: row?.stale ?? false,
                  updatedAt: row?.updatedAt ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: e?.message || "get_compiled_view failed",
              }),
            },
          ],
        };
      }
    }

    case "update_entity_metadata": {
      const page = store.getPageByTitle(args.title as string);
      if (!page) {
        return {
          content: [
            {
              type: "text",
              text: "Page \"" + String(args.title) + "\" not found.",
            },
          ],
        };
      }
      store.updatePageMetadata(
        page.id,
        args.metadata as Record<string, unknown>,
      );
      store.syncEntityWithPrimaryPage(page.id);
      const updated = store.getPage(page.id)!;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                title: updated.title,
                kind: updated.kind,
                metadata: updated.metadata,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    default:
      return {
        content: [
          { type: "text", text: "Unknown tool: " + String(toolName) },
        ],
      };
  }
}

// ─── stdio MCP transport ────────────────────────────────

async function startStdioMCP(
  store: KnowledgeStore,
  config: QuickyConfig,
  llm: LLMAdapter,
): Promise<void> {
  let buffer = "";

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    // JSON-RPC messages are delimited by newlines
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const response = await handleJsonRpc(msg, store, config, llm);
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      } catch {
        // Skip malformed messages
      }
    }
  });

  // Send server info on start
  process.stderr.write("Quicky Wiki MCP server started (stdio mode)\n");
  await new Promise(() => {}); // Keep alive
}

// ─── HTTP MCP transport ─────────────────────────────────

async function startHttpMCP(
  store: KnowledgeStore,
  config: QuickyConfig,
  llm: LLMAdapter,
  port: number,
): Promise<string> {
  return new Promise((resolvePromise) => {
    const server = createServer(async (req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405);
        res.end("Method Not Allowed");
        return;
      }

      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const msg = JSON.parse(body);
          const response = await handleJsonRpc(msg, store, config, llm);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify(response));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
        }
      });
    });

    server.listen(port, () => {
      resolvePromise(`http://localhost:${port}`);
    });
  });
}

// ─── JSON-RPC handler ───────────────────────────────────

async function handleJsonRpc(
  msg: any,
  store: KnowledgeStore,
  config: QuickyConfig,
  llm: LLMAdapter,
): Promise<any> {
  const id = msg.id;

  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "quicky-wiki",
            version: "0.1.0",
          },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const { name, arguments: args } = msg.params;
      try {
        const result = await handleToolCall(
          name,
          args || {},
          store,
          config,
          llm,
        );
        return { jsonrpc: "2.0", id, result };
      } catch (e: any) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error: ${e.message}` }],
            isError: true,
          },
        };
      }
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // No response for notifications

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
  }
}
