import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { KnowledgeStore } from "../graph/store.js";
import type { QuickyConfig, LLMAdapter, CompiledViewType } from "../types.js";
import { COMPILED_VIEW_TYPES } from "../types.js";
import { generateHealthReport } from "../metabolism/health.js";
import { renderGraphData } from "../render/graph-viz.js";
import { queryKnowledge } from "../graph/query.js";
import { renderAllPages } from "../render/markdown.js";

/** Resolved from dist/cli.js → ../package.json (must stay valid when bundled). */
const APP_VERSION: string = (() => {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
})();

// Simple TTL cache — single user, invalidate on writes
class TTLCache {
  private cache = new Map<string, { data: any; expires: number }>();
  private dirty = false;

  get<T>(key: string): T | undefined {
    if (this.dirty) {
      this.cache.clear();
      this.dirty = false;
    }
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expires) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  set(key: string, data: any, ttlMs: number): void {
    this.cache.set(key, { data, expires: Date.now() + ttlMs });
  }

  invalidate(): void {
    this.dirty = true;
  }
}

export function startDashboard(
  store: KnowledgeStore,
  config: QuickyConfig,
  llm: LLMAdapter,
  port: number,
): Promise<string> {
  return new Promise((resolve) => {
    const cache = new TTLCache();
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      try {
        if (url.pathname === "/api/stats") {
          const cached = cache.get("stats");
          if (cached) {
            json(res, cached);
            return;
          }
          const data = store.stats();
          cache.set("stats", data, 5000);
          json(res, data);
        } else if (url.pathname === "/api/pages") {
          const cached = cache.get("pages");
          if (cached) {
            json(res, cached);
            return;
          }
          const data = store.listPagesFlat();
          cache.set("pages", data, 10000);
          json(res, data);
        } else if (url.pathname === "/api/entities") {
          const cached = cache.get("entities");
          if (cached) {
            json(res, cached);
            return;
          }
          const rows = store.listEntitiesWithStats();
          const data = rows.map((e) => ({
            id: e.id,
            type: e.type,
            canonicalName: e.canonicalName,
            status: e.status,
            metadata: e.metadata,
            aliasCount: e.aliasCount,
            claimCount: e.claimCount,
            relationCount: e.relationCount,
            primaryPageId: e.primaryPageId,
          }));
          cache.set("entities", data, 10000);
          json(res, data);
        } else if (url.pathname === "/api/entity") {
          const id = url.searchParams.get("id");
          if (!id) {
            json(res, { error: "Missing id" }, 400);
            return;
          }
          const detail = store.getEntityDetail(id);
          if (!detail) {
            json(res, { error: "Not found" }, 404);
            return;
          }
          const summaryView = store.getCompiledView(id, "summary");
          json(res, {
            entity: {
              id: detail.entity.id,
              type: detail.entity.type,
              canonicalName: detail.entity.canonicalName,
              status: detail.entity.status,
              metadata: detail.entity.metadata,
            },
            aliases: detail.aliases,
            primaryPageId: detail.primaryPage?.id ?? null,
            primaryPageTitle: detail.primaryPage?.title ?? null,
            summary: summaryView
              ? { body: summaryView.body, stale: summaryView.stale }
              : null,
            claims: detail.claims.map((c) => ({
              id: c.id,
              statement: c.statement,
              confidence: c.confidence,
              claimType: c.claimType,
              lastReinforced: c.lastReinforced,
            })),
            relations: detail.relations,
          });
        } else if (url.pathname === "/api/review-queue") {
          if (req.method === "GET") {
            json(res, { items: store.listPendingAliases() });
            return;
          }
          if (req.method === "POST") {
            const body = await readBody(req);
            const { action, id } = JSON.parse(body) as {
              action?: string;
              id?: string;
            };
            if (!id || !action) {
              json(res, { error: "id and action required" }, 400);
              return;
            }
            if (action === "confirm") {
              const ok = store.confirmPendingAlias(id);
              cache.invalidate();
              json(res, { success: ok });
              return;
            }
            if (action === "dismiss") {
              store.dismissPendingAlias(id);
              cache.invalidate();
              json(res, { success: true });
              return;
            }
            json(res, { error: "action must be confirm or dismiss" }, 400);
            return;
          }
        } else if (url.pathname === "/api/entity-state") {
          const entityId = url.searchParams.get("entity_id");
          json(
            res,
            entityId
              ? store.listEntityStateLog(entityId, 300)
              : store.listRecentEntityStateLog(300),
          );
        } else if (url.pathname === "/api/compiled-view") {
          const entityId = url.searchParams.get("entity_id");
          const viewType = url.searchParams.get("view_type");
          const force = url.searchParams.get("force") === "1";
          if (!entityId || !viewType) {
            json(res, { error: "entity_id and view_type required" }, 400);
            return;
          }
          if (
            !(COMPILED_VIEW_TYPES as readonly string[]).includes(viewType)
          ) {
            json(
              res,
              {
                error: `view_type must be one of: ${COMPILED_VIEW_TYPES.join(", ")}`,
              },
              400,
            );
            return;
          }
          try {
            const { ensureCompiledView } = await import(
              "../compiler/views.js"
            );
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
            json(res, {
              body,
              stale: row?.stale ?? false,
              updatedAt: row?.updatedAt ?? null,
            });
          } catch (e: any) {
            json(res, { error: e?.message || "compile failed" }, 500);
          }
        } else if (url.pathname === "/api/relations") {
          const entityId = url.searchParams.get("entity_id") ?? undefined;
          json(
            res,
            store.listRelations(
              entityId ? { entityId: entityId ?? undefined } : undefined,
            ),
          );
        } else if (url.pathname === "/api/page") {
          const id = url.searchParams.get("id");
          if (!id) {
            json(res, { error: "Missing id" }, 400);
            return;
          }
          const full = store.getPageFull(id);
          if (!full) {
            json(res, { error: "Not found" }, 404);
            return;
          }
          const linkedPages = [
            ...new Set([...full.page.linksTo, ...full.page.linkedFrom]),
          ]
            .map((pid) => store.getPage(pid))
            .filter(Boolean)
            .map((p) => ({ id: p!.id, title: p!.title }));
          let markdown = "";
          const wikiPath = join(process.cwd(), "wiki", full.page.path);
          if (existsSync(wikiPath)) {
            markdown = await readFile(wikiPath, "utf-8");
          }
          let entityRelations: any[] = [];
          let entityInfo: { id: string; canonicalName: string; type: string } | null = null;
          if (full.page.entityId) {
            const detail = store.getEntityDetail(full.page.entityId);
            if (detail) {
              entityInfo = {
                id: detail.entity.id,
                canonicalName: detail.entity.canonicalName,
                type: detail.entity.type,
              };
              entityRelations = detail.relations;
            }
          }
          json(res, {
            ...full.page,
            claims: full.claims.map((c: any) => ({
              ...c,
              sources: c.sourceCount,
            })),
            linkedPages,
            entityRelations,
            entityInfo,
            markdown,
          });
        } else if (url.pathname === "/api/claims") {
          const cached = cache.get("claims");
          if (cached) {
            json(res, cached);
            return;
          }
          const data = store.listClaimsFlat().map((c: any) => ({
            id: c.id,
            statement: c.statement,
            pageId: c.pageId,
            confidence: c.confidence,
            claimType: c.claimType,
            sources: c.sourceCount,
            firstStated: c.firstStated,
            lastReinforced: c.lastReinforced,
            contradictions: c.contradictionCount,
            dependencies: c.dependencyCount,
            tags: c.tags,
          }));
          cache.set("claims", data, 10000);
          json(res, data);
        } else if (url.pathname === "/api/source") {
          const id = url.searchParams.get("id");
          if (!id) {
            json(res, { error: "Missing id" }, 400);
            return;
          }
          const result = store.getSourceWithClaims(id);
          if (!result) {
            json(res, { error: "Not found" }, 404);
            return;
          }
          json(res, result);
        } else if (url.pathname === "/api/sources") {
          json(res, store.listSources());
        } else if (url.pathname === "/api/graph") {
          const cached = cache.get("graph");
          if (cached) {
            json(res, cached);
            return;
          }
          const data = renderGraphData(store);
          cache.set("graph", data, 30000);
          json(res, data);
        } else if (url.pathname === "/api/health") {
          json(
            res,
            generateHealthReport(store, config.metabolism.staleThresholdDays),
          );
        } else if (url.pathname === "/api/events") {
          const cached = cache.get("events");
          if (cached) {
            json(res, cached);
            return;
          }
          const data = store.listEventsFlat(200);
          cache.set("events", data, 10000);
          json(res, data);
        } else if (url.pathname === "/api/query" && req.method === "POST") {
          const body = await readBody(req);
          const { question } = JSON.parse(body);
          if (!question) {
            json(res, { error: "Missing question" }, 400);
            return;
          }
          try {
            const result = await queryKnowledge(store, llm, question, config);
            json(res, result);
          } catch (e: any) {
            json(
              res,
              {
                error:
                  e?.message || "LLM query failed. Check API key and config.",
              },
              500,
            );
          }
        } else if (url.pathname === "/api/search") {
          const q = (url.searchParams.get("q") ?? "").toLowerCase();
          if (!q) {
            json(res, { pages: [], claims: [], relations: [] });
            return;
          }
          const searchCached = cache.get<any>(`search:${q}`);
          if (searchCached) {
            json(res, searchCached);
            return;
          }
          const data =
            config.retrieval?.hybridSearch
              ? await (
                  await import("../embeddings/hybrid-search.js")
                ).hybridSearch(store, q, 20, config)
              : store.search(q, 20);
          cache.set(`search:${q}`, data, 60000);
          json(res, data);
        } else if (url.pathname === "/api/bookmark" && req.method === "POST") {
          const body = await readBody(req);
          const { url: bookmarkUrl } = JSON.parse(body);
          if (!bookmarkUrl) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "url is required" }));
            return;
          }
          try {
            const { fetchUrlToMarkdown } = await import("./fetch-url.js");
            const { ingestSource } = await import("../compiler/ingest.js");
            const { resolve: resolvePath } = await import("node:path");
            const filePath = await fetchUrlToMarkdown(
              bookmarkUrl,
              resolvePath(config.paths.raw),
            );
            const diff = await ingestSource(store, llm, filePath, { config });
            cache.invalidate();
            json(res, {
              success: true,
              source: diff.sourceTitle,
              newClaims: diff.newClaims.length,
              reinforced: diff.reinforced.length,
              challenged: diff.challenged.length,
              relationsCompiled: diff.relationsCompiled ?? 0,
            });
          } catch (e: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        } else if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods":
              "GET, POST, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
        } else if (url.pathname === "/api/claim" && req.method === "PATCH") {
          const body = await readBody(req);
          const { id, statement, confidence } = JSON.parse(body);
          if (!id) {
            json(res, { error: "Missing id" }, 400);
            return;
          }
          if (typeof statement === "string")
            store.updateClaimStatement(id, statement);
          if (typeof confidence === "number")
            store.updateClaimConfidence(id, confidence);
          cache.invalidate();
          json(res, { success: true });
        } else if (url.pathname === "/api/claim" && req.method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) {
            json(res, { error: "Missing id" }, 400);
            return;
          }
          store.deleteClaim(id);
          cache.invalidate();
          json(res, { success: true });
        } else if (url.pathname === "/api/page" && req.method === "DELETE") {
          const id = url.searchParams.get("id");
          if (!id) {
            json(res, { error: "Missing id" }, 400);
            return;
          }
          store.deletePage(id);
          cache.invalidate();
          json(res, { success: true });
        } else if (url.pathname === "/api/prune" && req.method === "POST") {
          const pruned = store.deleteEmptyPages();
          cache.invalidate();
          json(res, { success: true, pruned });
        } else if (
          url.pathname === "/api/prune-topics" &&
          req.method === "POST"
        ) {
          const pruned = store.deleteEmptyTopicPages();
          await renderAllPages(store, config.paths.wiki);
          cache.invalidate();
          json(res, { success: true, pruned });
        } else {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(dashboardHTML(config.name, APP_VERSION));
        }
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });

    server.listen(port, () => {
      resolve(`http://localhost:${port}`);
    });
  });
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: any, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dashboardHTML(wikiName: string, version: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(wikiName)} — Quicky Wiki</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>

<style>
:root {
  --bg: #F8F7F4; --surface: #FFFFFF; --surface2: #F1EFE9;
  --surface-warm: #FAF9F6; --surface-hover: #F5F3EE;
  --border: #E8E5DD; --border-hover: #D4D0C8;
  --text: #1C1917; --text-dim: #78716C; --text-xdim: #A8A29E;
  --accent: #2563EB; --accent-hover: #1D4ED8; --accent-dim: rgba(37,99,235,.08); --accent-light: rgba(37,99,235,.05);
  --green: #16A34A; --green-dim: rgba(22,163,74,.08); --green-light: #ECFDF5;
  --yellow: #D97706; --yellow-dim: rgba(217,119,6,.08); --yellow-light: #FFFBEB;
  --red: #DC2626; --red-dim: rgba(220,38,38,.08); --red-light: #FEF2F2;
  --purple: #7C3AED; --purple-dim: rgba(124,58,237,.08); --purple-light: #F5F3FF;
  --radius: 12px; --radius-sm: 8px; --radius-xs: 6px;
  --shadow-xs: 0 1px 2px rgba(28,25,23,.04);
  --shadow-sm: 0 1px 3px rgba(28,25,23,.06), 0 1px 2px rgba(28,25,23,.04);
  --shadow-md: 0 4px 6px -1px rgba(28,25,23,.06), 0 2px 4px -2px rgba(28,25,23,.04);
  --shadow-lg: 0 10px 15px -3px rgba(28,25,23,.07), 0 4px 6px -4px rgba(28,25,23,.04);
  --shadow-xl: 0 20px 25px -5px rgba(28,25,23,.08), 0 8px 10px -6px rgba(28,25,23,.04);
  --transition: all .2s cubic-bezier(.4,0,.2,1);
  --spring: all .35s cubic-bezier(.175,.885,.32,1.275);
}
@font-face{font-family:'Inter';font-display:swap}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;overflow:hidden;height:100vh;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:'cv02','cv03','cv04','cv11'}
::selection{background:rgba(37,99,235,.15);color:var(--text)}
::-webkit-scrollbar{width:7px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border-hover);border-radius:10px}::-webkit-scrollbar-thumb:hover{background:var(--text-xdim)}

.app{display:grid;grid-template-rows:56px 1fr;grid-template-columns:232px 1fr;height:100vh}

header{grid-column:1/-1;background:rgba(255,255,255,.82);backdrop-filter:blur(16px) saturate(1.6);-webkit-backdrop-filter:blur(16px) saturate(1.6);border-bottom:1px solid var(--border);padding:0 24px;display:flex;align-items:center;gap:16px;z-index:100}
.sidebar{background:var(--surface-warm);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.main-area{overflow-y:auto;padding:28px 32px;background:var(--bg)}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;color:var(--text);letter-spacing:-.2px}.logo-icon{font-size:22px}

.search-wrapper{flex:1;max-width:480px;margin:0 auto;position:relative}
.search-box{width:100%;background:var(--surface2);border:1px solid transparent;border-radius:var(--radius);padding:8px 14px 8px 38px;color:var(--text);font-size:13.5px;outline:none;transition:var(--transition)}
.search-box:focus{background:var(--surface);border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}
.search-box::placeholder{color:var(--text-xdim)}
.search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-xdim);pointer-events:none;font-size:14px}
.search-kbd{position:absolute;right:10px;top:50%;transform:translateY(-50%);background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:2px 7px;font-size:11px;color:var(--text-xdim);font-family:inherit;box-shadow:var(--shadow-xs)}
.search-results{position:absolute;top:calc(100% + 6px);left:0;right:0;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-lg);max-height:420px;overflow-y:auto;z-index:200;display:none}
.search-results.active{display:block}
.search-result-item{padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--surface2);transition:var(--transition);font-size:13.5px}
.search-result-item:last-child{border-bottom:none}
.search-result-item:hover{background:var(--accent-light)}
.sr-type{font-size:10px;padding:2px 7px;border-radius:5px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
.sr-page{background:var(--accent-dim);color:var(--accent)}.sr-claim{background:var(--purple-dim);color:var(--purple)}.sr-entity{background:var(--green-dim,rgba(52,211,153,.15));color:var(--green,#34d399)}

.sidebar-section{padding:14px 0}
.sidebar-label{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-xdim);padding:0 18px;margin-bottom:6px;font-weight:600}
.nav-item{display:flex;align-items:center;gap:10px;padding:8px 18px;cursor:pointer;color:var(--text-dim);transition:var(--transition);font-size:13.5px;font-weight:500;border-left:2.5px solid transparent;margin:1px 0}
.nav-item:hover{color:var(--text);background:var(--surface-hover)}
.nav-item.active{color:var(--accent);background:var(--accent-light);border-left-color:var(--accent);font-weight:600}
.nav-icon{width:20px;text-align:center;font-size:16px}
.nav-badge{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:10px;background:var(--surface2);color:var(--text-dim);font-weight:600;font-variant-numeric:tabular-nums}

.sidebar-stats{padding:14px 18px;border-top:1px solid var(--border);margin-top:auto;background:var(--surface2)}
.sidebar-stat{display:flex;justify-content:space-between;padding:4px 0;font-size:12.5px}
.sidebar-stat .label{color:var(--text-dim)}.sidebar-stat .val{font-weight:600;font-variant-numeric:tabular-nums;color:var(--text)}

.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:14px;margin-bottom:28px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;transition:var(--spring);cursor:default;box-shadow:var(--shadow-xs)}
.stat-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-md);border-color:var(--border-hover)}
.stat-card .value{font-size:28px;font-weight:700;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.stat-card .label{font-size:11px;color:var(--text-xdim);text-transform:uppercase;letter-spacing:.6px;margin-top:3px;font-weight:500}
.stat-card.green .value{color:var(--green)}.stat-card.yellow .value{color:var(--yellow)}.stat-card.red .value{color:var(--red)}.stat-card.accent .value{color:var(--accent)}

.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:18px;overflow:hidden;transition:var(--transition);box-shadow:var(--shadow-xs)}
.panel:hover{box-shadow:var(--shadow-sm);border-color:var(--border-hover)}
.panel-header{padding:14px 20px;border-bottom:1px solid var(--border);font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:8px;color:var(--text);background:var(--surface-warm)}
.panel-body{padding:18px 20px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:18px}

table{width:100%;border-collapse:separate;border-spacing:0}
th{text-align:left;padding:10px 16px;color:var(--text-dim);border-bottom:2px solid var(--border);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;background:var(--surface-warm);position:sticky;top:0}
td{padding:12px 16px;border-bottom:1px solid var(--surface2);font-size:14px;line-height:1.5;color:var(--text)}
tr:last-child td{border-bottom:none}
tr{transition:var(--transition);cursor:pointer}tr:hover td{background:var(--accent-light)}

.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600;white-space:nowrap;letter-spacing:.1px}
.badge-green{background:var(--green-light);color:var(--green)}.badge-yellow{background:var(--yellow-light);color:var(--yellow)}.badge-red{background:var(--red-light);color:var(--red)}.badge-accent{background:var(--accent-dim);color:var(--accent)}.badge-purple{background:var(--purple-light);color:var(--purple)}

.page-link{color:var(--accent);cursor:pointer;font-weight:500;text-decoration:none}.page-link:hover{text-decoration:underline;color:var(--accent-hover)}
.view{display:none}.view.active{display:block}

#graph-container{width:100%;height:calc(100vh - 180px);position:relative;border-radius:var(--radius-sm);overflow:hidden}
#graph-container canvas{width:100%;height:100%;background:#1e1e2e;display:block}
.node-label{font-size:11px;fill:var(--text-dim);pointer-events:none;font-weight:500}
.graph-tooltip{position:absolute;background:rgba(30,30,46,0.95);border:1px solid rgba(255,255,255,0.1);border-radius:var(--radius-sm);padding:12px 16px;font-size:13px;pointer-events:none;display:none;z-index:10;max-width:300px;box-shadow:0 8px 32px rgba(0,0,0,0.5);color:#cdd6f4}
.graph-legend{position:absolute;bottom:16px;left:16px;background:rgba(30,30,46,0.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.08);border-radius:var(--radius-sm);padding:12px 16px;font-size:11.5px;box-shadow:0 4px 16px rgba(0,0,0,0.4)}
.legend-item{display:flex;align-items:center;gap:8px;margin-bottom:5px;color:rgba(205,214,244,0.7)}.legend-item:last-child{margin-bottom:0}
.legend-dot{width:10px;height:10px;border-radius:50%}.legend-line{width:20px;height:2.5px;border-radius:2px}

.slideOver{position:fixed;top:0;right:0;width:560px;height:100vh;background:var(--surface);border-left:1px solid var(--border);z-index:300;transform:translateX(100%);transition:transform .35s cubic-bezier(.32,.72,0,1);display:flex;flex-direction:column;box-shadow:var(--shadow-xl)}
.slideOver.open{transform:translateX(0)}
.slideOver-backdrop{position:fixed;inset:0;background:rgba(28,25,23,.18);z-index:299;opacity:0;pointer-events:none;transition:opacity .3s}
.slideOver-backdrop.open{opacity:1;pointer-events:auto}
.slideOver-header{padding:18px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px;background:rgba(255,255,255,.9);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);position:sticky;top:0;z-index:1}
.slideOver-header h2{font-size:18px;font-weight:700;flex:1;letter-spacing:-.2px;color:var(--text)}
.slideOver-close{background:var(--surface2);border:1px solid var(--border);color:var(--text-dim);width:30px;height:30px;border-radius:var(--radius-xs);cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:var(--transition)}
.slideOver-close:hover{background:var(--border);color:var(--text)}
.slideOver-body{flex:1;overflow-y:auto;padding:24px}
.slideOver-section{margin-bottom:24px}
.slideOver-section h3{font-size:11.5px;text-transform:uppercase;letter-spacing:.7px;color:var(--text-xdim);margin-bottom:10px;font-weight:600}
.md-content{font-size:14.5px;line-height:1.75;color:var(--text-dim);max-width:52ch}
.md-content h1,.md-content h2,.md-content h3{color:var(--text);margin:16px 0 8px;letter-spacing:-.2px}
.md-content h1{font-size:20px;font-weight:700}.md-content h2{font-size:17px;font-weight:600}.md-content h3{font-size:15px;font-weight:600}
.md-content ul,.md-content ol{padding-left:22px}.md-content li{margin:5px 0}
.md-content strong{color:var(--text);font-weight:600}.md-content code{background:var(--surface2);padding:2px 6px;border-radius:4px;font-size:13px;color:var(--red)}
.md-content hr{border:none;border-top:1px solid var(--border);margin:16px 0}
.linked-page-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:20px;font-size:12.5px;cursor:pointer;transition:var(--transition);margin:3px;font-weight:500;color:var(--text-dim)}
.linked-page-chip:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-light)}

.chat-container{display:flex;flex-direction:column;height:calc(100vh - 130px)}
.chat-messages{flex:1;overflow-y:auto;padding:20px 0}
.chat-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-dim);text-align:center;gap:18px}
.chat-empty-icon{font-size:52px;opacity:.5}
.chat-empty h3{font-size:18px;color:var(--text);font-weight:700;letter-spacing:-.2px}
.chat-suggestions{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;max-width:540px}
.chat-suggestion{padding:7px 16px;border:1px solid var(--border);border-radius:20px;font-size:13px;color:var(--text-dim);cursor:pointer;transition:var(--transition);background:var(--surface);box-shadow:var(--shadow-xs)}
.chat-suggestion:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-light);box-shadow:var(--shadow-sm)}
.chat-msg{display:flex;gap:14px;margin-bottom:20px;padding:0 4px}
.chat-msg-avatar{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;margin-top:2px}
.chat-msg-user .chat-msg-avatar{background:var(--accent-dim)}
.chat-msg-bot .chat-msg-avatar{background:var(--purple-dim)}
.chat-msg-body{flex:1;min-width:0}
.chat-msg-name{font-size:12px;font-weight:600;margin-bottom:5px;text-transform:uppercase;letter-spacing:.3px}
.chat-msg-user .chat-msg-name{color:var(--accent)}.chat-msg-bot .chat-msg-name{color:var(--purple)}
.chat-msg-text{font-size:14.5px;line-height:1.7;white-space:pre-wrap;color:var(--text)}
.chat-msg-meta{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap}
.chat-input-area{padding:14px 0 0;border-top:1px solid var(--border);display:flex;gap:10px}
.chat-input{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:11px 16px;color:var(--text);font-size:14px;outline:none;resize:none;font-family:inherit;min-height:44px;max-height:120px;transition:var(--transition);box-shadow:var(--shadow-xs)}
.chat-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}
.chat-input::placeholder{color:var(--text-xdim)}
.chat-send{background:var(--accent);color:#fff;border:none;padding:0 20px;border-radius:var(--radius);font-size:13.5px;font-weight:600;cursor:pointer;transition:var(--transition);white-space:nowrap;box-shadow:var(--shadow-sm)}
.chat-send:hover{background:var(--accent-hover);box-shadow:var(--shadow-md)}.chat-send:disabled{opacity:.4;cursor:not-allowed}
.chat-spinner{display:inline-block;width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.retrieval-debug{margin-top:8px}
.retrieval-toggle{border:none;border-radius:10px;padding:3px 10px;font-size:10px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;cursor:pointer;transition:var(--transition);display:inline-flex;align-items:center;gap:5px}
.retrieval-toggle .chevron{font-size:9px;opacity:.7;transition:transform .15s}
.retrieval-toggle.open .chevron{transform:rotate(180deg)}
.retrieval-toggle.fts5{background:var(--accent-dim);color:var(--accent)}
.retrieval-toggle.fts5:hover{background:var(--accent);color:#fff}
.retrieval-toggle.hybrid{background:var(--purple-dim);color:var(--purple)}
.retrieval-toggle.hybrid:hover{background:var(--purple);color:#fff}
.retrieval-toggle.warn{background:var(--yellow-dim);color:var(--yellow)}
.retrieval-toggle.warn:hover{background:var(--yellow);color:#1e1e2e}
.retrieval-detail{display:none;margin-top:6px;padding:8px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-xs);font-size:11px;color:var(--text-dim);line-height:1.7}
.retrieval-detail.open{display:block}

.tl-event{display:flex;gap:14px;padding:12px 0;border-bottom:1px solid var(--surface2);font-size:14px;align-items:flex-start}
.tl-event:last-child{border-bottom:none}
.tl-dot{width:10px;height:10px;border-radius:50%;margin-top:6px;flex-shrink:0;box-shadow:0 0 0 3px var(--surface)}
.tl-created{background:var(--accent)}.tl-reinforced{background:var(--green)}.tl-challenged{background:var(--red)}.tl-weakened{background:var(--yellow)}
.tl-date{color:var(--text-dim);min-width:140px;font-size:12.5px;font-variant-numeric:tabular-nums}
.tl-type{min-width:85px;font-weight:600;text-transform:capitalize;color:var(--text)}
.tl-stmt{flex:1;cursor:pointer;color:var(--text-dim)}.tl-stmt:hover{color:var(--accent)}
.tl-delta{font-size:12.5px;font-weight:600;min-width:110px;text-align:right;font-variant-numeric:tabular-nums}

.health-rings{display:flex;gap:36px;justify-content:center;padding:20px 0}
.health-ring{text-align:center}.health-ring svg{width:120px;height:120px}
.health-actions{list-style:none}
.health-actions li{padding:10px 0;border-bottom:1px solid var(--surface2);font-size:14px;color:var(--text-dim)}
.health-actions li:last-child{border-bottom:none}

.live-dot{width:8px;height:8px;background:var(--green);border-radius:50%;animation:pulse 2s infinite;box-shadow:0 0 0 3px rgba(22,163,74,.15)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

.md-content{font-size:14px;line-height:1.75;color:var(--text)}
.md-content h1{font-size:1.5em;font-weight:700;margin:16px 0 8px;color:var(--text)}
.md-content h2{font-size:1.25em;font-weight:600;margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--border);color:var(--text)}
.md-content h3{font-size:1.1em;font-weight:600;margin:16px 0 6px;color:var(--text)}
.md-content p{margin:6px 0}
.md-content ul{list-style:none;padding:0;margin:6px 0}
.md-content li{padding:6px 0;border-bottom:1px solid var(--surface2);font-size:13.5px}
.md-content li:last-child{border-bottom:none}
.md-content strong{font-weight:600}
.md-content em{font-style:italic;color:var(--text-dim)}
.md-content code{background:var(--surface2);padding:1px 5px;border-radius:4px;font-size:0.9em}
.md-content hr{border:none;border-top:1px solid var(--border);margin:12px 0}
.md-content .claim-hash{font-size:11px;color:var(--accent);opacity:.6;margin-left:4px;font-family:monospace}
.md-content .wiki-link{color:var(--accent);cursor:pointer;text-decoration:none;border-bottom:1px dashed var(--accent);padding-bottom:1px}
.md-content .wiki-link:hover{opacity:.8}
.md-content .conf-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}
.md-content .conf-dot.high{background:var(--green)}
.md-content .conf-dot.mid{background:var(--yellow)}
.md-content .conf-dot.low{background:var(--red)}
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="logo"><span class="logo-icon">⚡</span>${esc(wikiName)}</div>
    <div class="search-wrapper">
      <span class="search-icon">🔍</span>
      <input type="text" class="search-box" id="global-search" placeholder="Search... try entity:person or claim:fact" autocomplete="off">
      <span class="search-kbd">⌘K</span>
      <div class="search-results" id="search-results"></div>
    </div>
    <div style="display:flex;align-items:center;gap:8px"><div class="live-dot"></div><span style="font-size:11px;color:var(--text-dim)">Live</span></div>
  </header>
  <div class="sidebar">
    <div class="sidebar-section">
      <div class="sidebar-label">Navigate</div>
      <div class="nav-item active" data-view="overview"><span class="nav-icon">📊</span>Overview</div>
      <div class="nav-item" data-view="graph"><span class="nav-icon">🕸️</span>Graph</div>
      <div class="nav-item" data-view="claims"><span class="nav-icon">📋</span>Claims<span class="nav-badge" id="nav-claims-count">0</span></div>
      <div class="nav-item" data-view="pages"><span class="nav-icon">📄</span>Pages<span class="nav-badge" id="nav-pages-count">0</span></div>
      <div class="nav-item" data-view="entities"><span class="nav-icon">🏷️</span>Entities<span class="nav-badge" id="nav-entities-count">0</span></div>
      <div class="nav-item" data-view="timeline"><span class="nav-icon">🕐</span>Timeline</div>
      <div class="nav-item" data-view="health"><span class="nav-icon">💊</span>Health</div>
      <div class="nav-item" data-view="review"><span class="nav-icon">✅</span>Review<span class="nav-badge" id="nav-review-count">0</span></div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-label">Interact</div>
      <div class="nav-item" data-view="ask"><span class="nav-icon">💬</span>Ask Wiki</div>
    </div>
    <div class="sidebar-stats" id="sidebar-stats"></div>
  </div>
  <div class="main-area">
    <div id="view-overview" class="view active">
      <div class="stats-row" id="stats-row"></div>
      <div class="grid-2">
        <div class="panel"><div class="panel-header">🏆 Top Claims</div><div class="panel-body" id="top-claims"></div></div>
        <div class="panel"><div class="panel-header">⚠️ Attention</div><div class="panel-body" id="attention-items"></div></div>
      </div>
      <div class="panel" style="margin-top:16px"><div class="panel-header">📈 Confidence Distribution</div><div class="panel-body" id="conf-chart" style="height:180px"></div></div>
      <div class="grid-2" style="margin-top:16px">
        <div class="panel"><div class="panel-header">📂 Sources</div><div class="panel-body" id="sources-list"></div></div>
        <div class="panel"><div class="panel-header">📅 Recent</div><div class="panel-body" id="recent-events"></div></div>
      </div>
    </div>
    <div id="view-graph" class="view">
      <div class="panel" style="margin-bottom:0">
        <div class="panel-header">🕸️ Knowledge Graph<span style="margin-left:auto;font-weight:400;color:var(--text-dim);font-size:12px">Drag · Zoom · Click for details</span></div>
        <div id="graph-container"><canvas id="graph-canvas"></canvas>
          <div class="graph-tooltip" id="graph-tooltip"></div>
          <div id="graph-lod" style="position:absolute;top:10px;left:10px;background:rgba(30,30,46,0.8);backdrop-filter:blur(4px);border-radius:6px;padding:5px 10px;font-size:11px;color:rgba(205,214,244,0.6);pointer-events:none;z-index:8;transition:opacity 0.3s"></div>
          <div class="graph-legend">
            <div class="legend-item"><div class="legend-dot" style="background:#a78bfa"></div>High confidence</div>
            <div class="legend-item"><div class="legend-dot" style="background:#fbbf24"></div>Medium</div>
            <div class="legend-item"><div class="legend-dot" style="background:#f87171"></div>Low</div>
            <div class="legend-item"><div class="legend-line" style="background:rgba(203,213,225,0.4)"></div>Explicit link</div>
            <div class="legend-item"><div class="legend-line" style="background:rgba(203,213,225,0.15)"></div>Shared source</div>
            <div class="legend-item"><div class="legend-line" style="background:#f87171"></div>Contradiction</div>
            <div class="legend-item"><div class="legend-line" style="background:#34d399"></div>Relation (typed)</div>
            <div class="legend-item"><div class="legend-line" style="background:#f472b6"></div>Family relation</div>
            <div class="legend-item"><div class="legend-line" style="background:#38bdf8"></div>Dependency</div>
          </div>
        </div>
      </div>
    </div>
    <div id="view-claims" class="view">
      <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap">
        <select id="claim-filter" style="background:var(--surface);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:var(--radius-sm);font-size:13px;outline:none;font-family:inherit;cursor:pointer;box-shadow:var(--shadow-xs)">
          <option value="all">All confidence</option><option value="high">High (≥80%)</option><option value="mid">Medium (40-80%)</option><option value="low">Low (&lt;40%)</option>
        </select>
        <select id="claim-type-filter" style="background:var(--surface);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:var(--radius-sm);font-size:13px;outline:none;font-family:inherit;cursor:pointer;box-shadow:var(--shadow-xs)">
          <option value="all">All types</option><option value="fact">fact</option><option value="observation">observation</option><option value="preference">preference</option><option value="hypothesis">hypothesis</option><option value="status">status</option><option value="attribute">attribute</option>
        </select>
        <input type="text" id="claim-search" placeholder="Filter claims..." style="flex:1;min-width:160px;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:8px 14px;border-radius:var(--radius-sm);font-size:13.5px;outline:none;font-family:inherit;box-shadow:var(--shadow-xs)">
      </div>
      <div class="panel"><table><thead><tr><th>Conf</th><th>Type</th><th>Statement</th><th>Page</th><th>Src</th><th>Age</th><th></th></tr></thead><tbody id="claims-table"></tbody></table></div>
    </div>
    <div id="view-pages" class="view">
      <input type="text" id="page-search" placeholder="Filter pages..." style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:10px 16px;border-radius:var(--radius-sm);font-size:14px;outline:none;margin-bottom:18px;font-family:inherit;box-shadow:var(--shadow-xs)">
      <div class="panel"><table><thead><tr><th>Title</th><th>Kind</th><th>Entity</th><th>Metadata</th><th>Claims</th><th>Links</th><th>Updated</th></tr></thead><tbody id="pages-table"></tbody></table></div>
    </div>
    <div id="view-entities" class="view">
      <input type="text" id="entity-search" placeholder="Filter entities..." style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:10px 16px;border-radius:var(--radius-sm);font-size:14px;outline:none;margin-bottom:18px;font-family:inherit;box-shadow:var(--shadow-xs)">
      <div class="panel"><table><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Aliases</th><th>Claims</th><th>Rels</th><th>Page</th></tr></thead><tbody id="entities-table"></tbody></table></div>
    </div>
    <div id="view-timeline" class="view">
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <button type="button" class="tl-tab active" data-tl-tab="claims" style="background:var(--surface);border:1px solid var(--border);color:var(--text);padding:8px 14px;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;font-family:inherit">Claim events</button>
        <button type="button" class="tl-tab" data-tl-tab="entity" style="background:var(--surface2);border:1px solid var(--border);color:var(--text-dim);padding:8px 14px;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;font-family:inherit">Entity state</button>
      </div>
      <div class="panel"><div class="panel-header">🕐 Timeline</div><div class="panel-body" id="timeline-list"></div></div>
    </div>
    <div id="view-review" class="view">
      <div class="panel"><div class="panel-header">✅ Pending alias review</div><div class="panel-body" id="review-queue-list"></div></div>
    </div>
    <div id="view-health" class="view">
      <div class="panel"><div class="panel-header">📊 Knowledge Health</div><div class="panel-body"><div class="health-rings" id="health-rings"></div><div id="health-ontology" style="margin-top:14px"></div></div></div>
      <div class="grid-2" style="margin-top:16px">
        <div class="panel"><div class="panel-header">🎯 Actions</div><div class="panel-body"><ul class="health-actions" id="health-actions"></ul></div></div>
        <div class="panel"><div class="panel-header">⏰ Stale Claims</div><div class="panel-body" id="stale-claims"></div></div>
      </div>
      <div class="panel" style="margin-top:16px"><div class="panel-header">⚔️ Contested</div><div class="panel-body" id="contested-claims"></div></div>
    </div>
    <div id="view-ask" class="view">
      <div class="chat-container">
        <div class="chat-messages" id="chat-messages">
          <div class="chat-empty" id="chat-empty">
            <div class="chat-empty-icon">🧠</div>
            <h3>Ask your knowledge base anything</h3>
            <p style="max-width:400px;font-size:13px">Questions answered using your claims with confidence scores and citations.</p>
            <div class="chat-suggestions" id="chat-suggestions"></div>
          </div>
        </div>
        <div class="chat-input-area">
          <textarea class="chat-input" id="chat-input" placeholder="Ask a question... (Enter to send)" rows="1"></textarea>
          <button class="chat-send" id="chat-send">Ask ⏎</button>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="slideOver-backdrop" id="slideOver-backdrop"></div>
<div class="slideOver" id="slideOver">
  <div class="slideOver-header"><h2 id="slideOver-title">Page Detail</h2><button class="slideOver-close" id="slideOver-close">✕</button></div>
  <div class="slideOver-body" id="slideOver-body"></div>
</div>
<script>
let DATA={};let searchDebounce=null;const chatHistory=[];const APP_VERSION='${esc(version)}';let timelineTab='claims';
async function fetchAll(){
  const[stats,pages,claims,sources,graph,health,events,entities,reviewQueue,entityState]=await Promise.all([
    fetch('/api/stats').then(r=>r.json()),fetch('/api/pages').then(r=>r.json()),
    fetch('/api/claims').then(r=>r.json()),fetch('/api/sources').then(r=>r.json()),
    fetch('/api/graph').then(r=>r.json()),fetch('/api/health').then(r=>r.json()),
    fetch('/api/events').then(r=>r.json()),
    fetch('/api/entities').then(r=>r.json()),
    fetch('/api/review-queue').then(r=>r.json()),
    fetch('/api/entity-state').then(r=>r.json()),
  ]);
  DATA={stats,pages,claims,sources,graph,health,events,entities,reviewQueue,entityState};
}
async function refreshData(){await fetchAll();renderAll();}
document.querySelectorAll('.nav-item').forEach(item=>{
  item.addEventListener('click',()=>{
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('view-'+item.dataset.view).classList.add('active');
    if(item.dataset.view==='graph'&&!graphRendered)renderGraph();
  });
});
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();document.getElementById('global-search').focus();}
  if(e.key==='Escape'){closeSlideOver();closeSearch();}
});
const searchInput=document.getElementById('global-search');
const searchResultsEl=document.getElementById('search-results');
function parseSearchPrefixes(raw){
  const prefixes={};let text=raw;
  const re=/\\b(entity|claim|page|kind):(\\S+)/gi;
  let m;while((m=re.exec(raw))!==null){prefixes[m[1].toLowerCase()]=m[2].toLowerCase();text=text.replace(m[0],'');}
  return{prefixes,text:text.trim()};
}
searchInput.addEventListener('input',()=>{
  clearTimeout(searchDebounce);
  searchDebounce=setTimeout(async()=>{
    const q=searchInput.value.trim();
    if(q.length<2){closeSearch();return;}
    const{prefixes,text}=parseSearchPrefixes(q);
    const apiQ=text||q.replace(/\\S+:\\S+/g,'').trim();
    const res=apiQ.length>=2?await fetch('/api/search?q='+encodeURIComponent(apiQ)).then(r=>r.json()):{pages:[],claims:[],relations:[]};
    const rels=res.relations||[];
    const ql=(text||q).toLowerCase();
    let matchedEntities=(DATA.entities||[]).filter(e=>(e.canonicalName||'').toLowerCase().includes(ql)||(e.type||'').toLowerCase().includes(ql));
    if(prefixes.entity)matchedEntities=matchedEntities.filter(e=>(e.type||'').toLowerCase()===prefixes.entity);
    matchedEntities=matchedEntities.slice(0,8);
    let filteredClaims=res.claims||[];
    if(prefixes.claim)filteredClaims=filteredClaims.filter(c=>(c.claimType||'').toLowerCase()===prefixes.claim);
    let filteredPages=res.pages||[];
    if(prefixes.kind||prefixes.page){const k=prefixes.kind||prefixes.page;filteredPages=filteredPages.filter(p=>{const pg=DATA.pages.find(x=>x.id===p.id);return pg&&(pg.kind||'').toLowerCase()===k;});}
    const items=[...matchedEntities.map(e=>({...e,kind:'entity'})),...filteredPages.map(p=>({...p,kind:'page'})),...filteredClaims.map(c=>({...c,kind:'claim'})),...rels.map(r=>({...r,kind:'relation'}))];
    if(!items.length){searchResultsEl.innerHTML='<div style="padding:14px;text-align:center;color:var(--text-dim);font-size:13px">No results'+(Object.keys(prefixes).length?' <span style="opacity:.6">(filtered by '+Object.entries(prefixes).map(([k,v])=>k+':'+v).join(', ')+')</span>':'')+'</div>';}
    else{searchResultsEl.innerHTML=items.map(i=>{
      if(i.kind==='entity')return'<div class="search-result-item" data-action="entity" data-id="'+i.id+'"><span class="sr-type sr-entity">'+esc(i.type)+'</span><span>'+esc(i.canonicalName)+'</span><span style="font-size:11px;color:var(--text-xdim);margin-left:auto">'+i.claimCount+' claims · '+i.relationCount+' rels</span></div>';
      if(i.kind==='page')return'<div class="search-result-item" data-action="page" data-id="'+i.id+'"><span class="sr-type sr-page">Page</span><span>'+esc(i.title)+'</span></div>';
      if(i.kind==='relation')return'<div class="search-result-item" data-action="noop" style="cursor:default"><span class="sr-type" style="background:var(--accent-dim);color:var(--accent)">Rel</span><span style="font-size:12px">'+esc(i.from.name)+' <code style="font-size:10px">'+esc(i.relation_type)+'</code> '+esc(i.to.name)+'</span></div>';
      return'<div class="search-result-item" data-action="claim" data-id="'+i.pageId+'"><span class="sr-type sr-claim">'+esc(i.claimType||'claim')+'</span><span>'+esc(i.statement.slice(0,80))+'</span>'+confBadge(i.confidence)+'</div>';
    }).join('');}
    searchResultsEl.classList.add('active');
  },200);
});
searchInput.addEventListener('focus',()=>{if(searchInput.value.trim().length>=2)searchResultsEl.classList.add('active');});
searchResultsEl.addEventListener('click',e=>{const item=e.target.closest('.search-result-item');if(!item)return;const act=item.dataset.action;if(act==='noop')return;if(act==='entity'){openEntity(item.dataset.id);closeSearch();return;}openPage(item.dataset.id);closeSearch();});
document.addEventListener('click',e=>{if(!e.target.closest('.search-wrapper'))closeSearch();});
function closeSearch(){searchResultsEl.classList.remove('active');}

function openSlideOver(html,title){
  document.getElementById('slideOver-title').textContent=title||'Details';
  document.getElementById('slideOver-body').innerHTML=html;
  document.getElementById('slideOver').classList.add('open');
  document.getElementById('slideOver-backdrop').classList.add('open');
}
function closeSlideOver(){
  document.getElementById('slideOver').classList.remove('open');
  document.getElementById('slideOver-backdrop').classList.remove('open');
}
document.getElementById('slideOver-close').addEventListener('click',closeSlideOver);
document.getElementById('slideOver-backdrop').addEventListener('click',closeSlideOver);

function findPageIdByTitle(title){
  if(!title||!DATA.pages)return null;
  const t=title.replace(/\\s+/g,' ').trim();const lower=t.toLowerCase();
  const p=DATA.pages.find(x=>{
    const xt=x.title.replace(/\\s+/g,' ').trim();
    return xt===t||xt.toLowerCase()===lower;
  });
  return p?p.id:null;
}
document.getElementById('slideOver-body').addEventListener('click',function(e){
  const chip=e.target.closest('.linked-page-chip[data-page-id]');
  if(chip){
    e.preventDefault();e.stopPropagation();
    const id=chip.getAttribute('data-page-id');
    if(id)openPage(id);
    return;
  }
  const wiki=e.target.closest('.md-content .wiki-link');
  if(wiki){
    e.preventDefault();e.stopPropagation();
    const raw=wiki.getAttribute('data-wiki-target');
    const pid=findPageIdByTitle(raw||'')||findPageIdByTitle(wiki.textContent||'');
    if(pid)openPage(pid);
    return;
  }
});

async function openPage(pageId){
  closeSearch();
  const page=await fetch('/api/page?id='+pageId).then(r=>r.json());
  if(page.error)return;
  let html='';
  const hasSummary=page.summary&&!page.summary.match(/no summary yet/i);
  const hasClaims=page.claims&&page.claims.length;
  const hasLinks=page.linkedPages&&page.linkedPages.length;
  const hasMd=!!page.markdown;
  if(hasSummary)html+='<div class="slideOver-section"><h3>Summary</h3><p style="font-size:13px;color:var(--text-dim)">'+esc(page.summary)+'</p></div>';
  if(hasClaims){
    html+='<div class="slideOver-section"><h3>Claims ('+page.claims.length+')</h3>';
    html+=page.claims.map(c=>'<div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:10px">'+confBadge(c.confidence)+claimTypeBadge(c.claimType||'fact')+'<div style="flex:1"><div style="font-size:13px">'+esc(c.statement)+'</div><div style="font-size:11px;color:var(--text-dim);margin-top:2px">'+c.sources+' source'+(c.sources!==1?'s':'')+' · '+relTime(c.lastReinforced)+'</div></div><button class="del-page-claim" data-claim-id="'+c.id+'" style="background:none;border:none;cursor:pointer;color:var(--text-xdim);font-size:13px;padding:2px 6px;border-radius:4px;flex-shrink:0" title="Delete claim">✕</button></div>').join('');
    html+='</div>';
  }
  if(page.entityRelations&&page.entityRelations.length){
    html+='<div class="slideOver-section"><h3>Relations ('+page.entityRelations.length+')</h3><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5">';
    html+=page.entityRelations.map(r=>'<li><code>'+esc(r.relationType)+'</code> → <strong class="entity-chip" data-entity-id="'+esc(r.otherEntityId)+'" style="cursor:pointer">'+esc(r.otherCanonicalName)+'</strong> <span style="color:var(--text-dim)">('+esc(r.direction)+')</span></li>').join('');
    html+='</ul></div>';
  }
  if(hasLinks){
    html+='<div class="slideOver-section"><h3>Linked Pages ('+page.linkedPages.length+')</h3><div>';
    html+=page.linkedPages.map(p=>'<span class="linked-page-chip" data-page-id="'+p.id+'">'+esc(p.title)+'</span>').join('');
    html+='</div></div>';
  }
  if(page.entityInfo){
    html+='<div class="slideOver-section"><h3>Entity</h3><div><span class="entity-chip" data-entity-id="'+esc(page.entityInfo.id)+'" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:6px;background:var(--surface2);border:1px solid var(--border);font-size:13px"><strong>'+esc(page.entityInfo.canonicalName)+'</strong><code style="font-size:11px">'+esc(page.entityInfo.type)+'</code></span></div></div>';
  }
  if(page.markdown)html+='<div class="slideOver-section"><div class="md-content">'+renderMarkdown(page.markdown)+'</div></div>';
  const sparse=!hasSummary&&!hasClaims&&!hasLinks&&!hasMd;
  if(sparse){
    html+='<div class="slideOver-section"><p style="font-size:13px;color:var(--text-dim);line-height:1.45">This page has no claims or compiled wiki file yet. Ingest sources that mention this topic, or edit the vault if this is a primary entity.</p></div>';
    if(page.kind)html+='<div class="slideOver-section"><h3>Kind</h3><p style="font-size:13px"><span class="badge badge-accent">'+esc(page.kind)+'</span></p></div>';
    const meta=page.metadata&&typeof page.metadata==='object'?page.metadata:null;
    if(meta&&Object.keys(meta).length){
      html+='<div class="slideOver-section"><h3>Entity metadata</h3><pre style="font-size:11px;overflow:auto;max-height:220px;background:var(--bg-elevated);padding:10px;border-radius:var(--radius-xs);border:1px solid var(--border)">'+esc(JSON.stringify(meta,null,2))+'</pre></div>';
    }
  }
  html+='<div class="slideOver-section" style="border-top:2px solid var(--red-dim);padding-top:16px;margin-top:8px"><button id="delete-page-btn" style="background:var(--red-dim);color:var(--red);border:1px solid transparent;border-radius:var(--radius-xs);padding:6px 16px;cursor:pointer;font-size:12px;font-weight:600;transition:var(--transition)" onmouseover="this.style.background=\\'var(--red)\\';this.style.color=\\'white\\'" onmouseout="this.style.background=\\'var(--red-dim)\\';this.style.color=\\'var(--red)\\'">Delete Page</button></div>';
  openSlideOver(html,page.title);
  document.querySelectorAll('.del-page-claim').forEach(btn=>{btn.addEventListener('click',async()=>{if(!confirm('Delete this claim?'))return;await fetch('/api/claim?id='+btn.dataset.claimId,{method:'DELETE'});await refreshData();openPage(page.id);});});
  document.getElementById('delete-page-btn').addEventListener('click',async()=>{if(!confirm('Delete page "'+page.title+'" and all its claims?'))return;await fetch('/api/page?id='+page.id,{method:'DELETE'});await refreshData();closeSlideOver();renderPages();});
}

async function openSource(sourceId){
  const data=await fetch('/api/source?id='+sourceId).then(r=>r.json());
  if(data.error)return;
  const src=data.source;const claims=data.claims;
  let html='<div class="slideOver-section"><h3>Details</h3><div style="display:flex;flex-direction:column;gap:6px;font-size:13px">';
  html+='<div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Type</span><span>'+esc(src.type)+'</span></div>';
  html+='<div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Quality</span><span class="badge badge-accent">'+esc(src.qualityTier)+'</span></div>';
  html+='<div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Ingested</span><span>'+new Date(src.ingestedAt).toLocaleString()+'</span></div>';
  html+='<div style="display:flex;justify-content:space-between"><span style="color:var(--text-dim)">Path</span><span style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:right" title="'+esc(src.path)+'">'+esc(src.path)+'</span></div>';
  html+='</div></div>';
  if(claims.length){
    const pages=[...new Map(claims.map(c=>[c.pageId,c.pageTitle])).entries()];
    html+='<div class="slideOver-section"><h3>Pages ('+pages.length+')</h3><div>';
    html+=pages.map(([id,title])=>'<span class="linked-page-chip" data-page-id="'+id+'">'+esc(title)+'</span>').join('');
    html+='</div></div>';
    html+='<div class="slideOver-section"><h3>Claims ('+claims.length+')</h3>';
    html+=claims.map(c=>'<div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:10px">'+confBadge(c.confidence)+'<div style="flex:1"><div style="font-size:13px">'+esc(c.statement)+'</div><div style="font-size:11px;color:var(--text-dim);margin-top:2px"><span class="page-link" data-page-id="'+c.pageId+'" style="cursor:pointer">'+esc(c.pageTitle)+'</span> · '+c.sources+' source'+(c.sources!==1?'s':'')+' · '+relTime(c.lastReinforced)+'</div></div></div>').join('');
    html+='</div>';
  }else{
    html+='<div class="slideOver-section"><p style="font-size:13px;color:var(--text-dim)">No claims linked to this source.</p></div>';
  }
  const meta=src.metadata&&Object.keys(src.metadata).length?src.metadata:null;
  if(meta){
    html+='<div class="slideOver-section"><h3>Metadata</h3><pre style="font-size:11px;overflow:auto;max-height:220px;background:var(--surface2);padding:10px;border-radius:var(--radius-xs);border:1px solid var(--border)">'+esc(JSON.stringify(meta,null,2))+'</pre></div>';
  }
  openSlideOver(html,src.title);
  document.getElementById('slideOver-body').querySelectorAll('.page-link[data-page-id]').forEach(el=>{el.addEventListener('click',()=>openPage(el.dataset.pageId));});
}

function confBadge(val){const pct=(val*100).toFixed(0)+'%';if(val>=0.8)return'<span class="badge badge-green">'+pct+'</span>';if(val>=0.4)return'<span class="badge badge-yellow">'+pct+'</span>';return'<span class="badge badge-red">'+pct+'</span>';}
function relTime(iso){if(!iso)return'';const diff=Date.now()-new Date(iso).getTime();if(diff<3600000)return Math.floor(diff/60000)+'m ago';if(diff<86400000)return Math.floor(diff/3600000)+'h ago';return Math.floor(diff/86400000)+'d ago';}
function esc(s){return s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):'';}
function formatEntityLocationHtml(meta){
  if(!meta||typeof meta!=='object')return '';
  const dec=meta.coordinates_decimal;
  const dms=meta.coordinates_dms;
  let lat=null,lng=null;
  if(dec&&typeof dec==='object'){
    const la=dec.latitude,lo=dec.longitude;
    if(typeof la==='number'&&typeof lo==='number'){lat=la;lng=lo;}
    else if(typeof la==='string'&&typeof lo==='string'){const a=parseFloat(la),b=parseFloat(lo);if(!isNaN(a)&&!isNaN(b)){lat=a;lng=b;}}
  }
  let dmsLat='',dmsLng='';
  if(dms&&typeof dms==='object'){
    if(dms.latitude!=null)dmsLat=String(dms.latitude);
    if(dms.longitude!=null)dmsLng=String(dms.longitude);
  }
  if(lat==null&&lng==null&&!dmsLat&&!dmsLng)return '';
  let h='<div class="slideOver-section"><h3>Location</h3>';
  if(lat!=null&&lng!=null){
    h+='<p style="font-size:13px;margin:0 0 8px 0;line-height:1.45"><strong>Decimal (WGS84):</strong> '+lat.toFixed(6)+', '+lng.toFixed(6);
    const enc='https://www.openstreetmap.org/?mlat='+encodeURIComponent(String(lat))+'&mlon='+encodeURIComponent(String(lng))+'#map=15/'+encodeURIComponent(String(lat))+'/'+encodeURIComponent(String(lng));
    h+=' <a href="'+enc+'" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:12px;margin-left:8px">Open map ↗</a></p>';
  }
  if(dmsLat||dmsLng)h+='<p style="font-size:13px;margin:0;color:var(--text-dim);line-height:1.45"><strong>DMS:</strong> '+(dmsLat?esc(dmsLat):'—')+(dmsLat&&dmsLng?' · ':'')+(dmsLng?esc(dmsLng):'')+'</p>';
  h+='</div>';
  return h;
}
function claimTypeBadge(t){
  const k=String(t||'fact');
  const map={fact:'#78716C',observation:'#0EA5E9',preference:'#16A34A',hypothesis:'#A855F7',status:'#CA8A04',attribute:'#6366F1'};
  const c=map[k]||'#78716C';
  return'<span style="display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;background:'+c+'22;color:'+c+'">'+esc(k)+'</span>';
}
function renderMarkdown(md){
  if(!md)return'';
  let text=md.replace(/^---[\\s\\S]*?---/,'').trim();
  const lines=text.split('\\n');
  let html='';let inList=false;
  for(let i=0;i<lines.length;i++){
    let line=lines[i];
    if(line.match(/^#{1,3}\\s/)){
      if(inList){html+='</ul>';inList=false;}
      const level=line.match(/^(#+)/)[1].length;
      const content=line.replace(/^#+\\s*/,'');
      html+='<h'+level+'>'+esc(content)+'</h'+level+'>';
      continue;
    }
    if(line.match(/^---\\s*$/)){if(inList){html+='</ul>';inList=false;}html+='<hr>';continue;}
    if(line.match(/^- /)){
      if(!inList){html+='<ul>';inList=true;}
      let item=line.replace(/^- /,'');
      item=formatInline(item);
      html+='<li>'+item+'</li>';
      continue;
    }
    if(line.trim()===''){if(inList){html+='</ul>';inList=false;}continue;}
    if(inList){html+='</ul>';inList=false;}
    html+='<p>'+formatInline(line)+'</p>';
  }
  if(inList)html+='</ul>';
  return html;
}
function formatInline(s){
  const wikiPh=[];
  s=s.replace(/\\[\\[([^\\]]+)\\]\\]/g,function(_,inner){
    const parts=inner.split('|');
    const target=(parts.length>1?parts[parts.length-1]:parts[0]).trim();
    const label=parts.length>1?parts.slice(0,-1).join('|').trim():target;
    const i=wikiPh.length;
    wikiPh.push('<span class="wiki-link" data-wiki-target="'+esc(target)+'">'+esc(label)+'</span>');
    return'__WIKILINK_'+i+'__';
  });
  s=esc(s);
  s=s.replace(/__WIKILINK_(\\d+)__/g,function(_,i){return wikiPh[parseInt(i,10)]||'';});
  s=s.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  s=s.replace(/(?:^|[^\\w])_([^_]+?)_(?:[^\\w]|$)/g,function(m,p1){return m.replace('_'+p1+'_','<em>'+p1+'</em>');});
  s=s.replace(/\\*([^*]+?)\\*/g,'<em>$1</em>');
  s=s.replace(/\`([^\`]+?)\`/g,'<code>$1</code>');
  s=s.replace(/\\^([a-f0-9]{6,})/g,'<span class="claim-hash">↗$1</span>');
  s=s.replace(/(🟢)/g,'<span class="conf-dot high"></span>').replace(/(🟡)/g,'<span class="conf-dot mid"></span>').replace(/(🔴)/g,'<span class="conf-dot low"></span>');
  return s;
}

function renderStatsRow(){
  const{stats,health}=DATA;
  const entCount=(DATA.entities||[]).length;
  document.getElementById('stats-row').innerHTML=sCard(stats.sources,'Sources','accent')+sCard(stats.pages,'Pages','accent')+sCard(entCount,'Entities','green')+sCard(stats.claims,'Claims','accent')+sCard(health.highConfidence,'High Conf','green')+sCard(health.mediumConfidence,'Mid Conf','yellow')+sCard(health.lowConfidence,'Low Conf','red')+sCard(stats.events,'Events','accent');
}
function sCard(v,l,c){return'<div class="stat-card '+c+'"><div class="value">'+v+'</div><div class="label">'+l+'</div></div>';}
function renderSidebarStats(){
  const{stats}=DATA;
  document.getElementById('sidebar-stats').innerHTML='<div class="sidebar-stat"><span class="label">Sources</span><span class="val">'+stats.sources+'</span></div><div class="sidebar-stat"><span class="label">Pages</span><span class="val">'+stats.pages+'</span></div><div class="sidebar-stat"><span class="label">Claims</span><span class="val">'+stats.claims+'</span></div><div class="sidebar-stat"><span class="label">Events</span><span class="val">'+stats.events+'</span></div><div style="margin-top:10px;display:flex;flex-direction:column;gap:6px"><button id="prune-btn" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-xs);padding:5px 10px;cursor:pointer;font-size:11px;color:var(--text-dim);transition:var(--transition)" onmouseover="this.style.borderColor=\\'var(--red)\\';this.style.color=\\'var(--red)\\'" onmouseout="this.style.borderColor=\\'var(--border)\\';this.style.color=\\'var(--text-dim)\\'">Prune Empty Pages</button><button id="prune-topics-btn" style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-xs);padding:5px 10px;cursor:pointer;font-size:11px;color:var(--text-dim);transition:var(--transition)" onmouseover="this.style.borderColor=\\'var(--accent)\\';this.style.color=\\'var(--accent)\\'" onmouseout="this.style.borderColor=\\'var(--border)\\';this.style.color=\\'var(--text-dim)\\'">Prune Topic Stubs</button></div><div style="margin-top:10px;text-align:center;font-size:10px;color:var(--text-xdim);letter-spacing:.3px;opacity:.6">v'+APP_VERSION+'</div>';
  document.getElementById('prune-btn').addEventListener('click',async()=>{if(!confirm('Delete all pages with no claims?'))return;const r=await fetch('/api/prune',{method:'POST'}).then(r=>r.json());alert('Pruned '+r.pruned+' empty pages');await refreshData();});
  document.getElementById('prune-topics-btn').addEventListener('click',async()=>{if(!confirm('Delete topic pages (kind=topic) that have no claims? Typed entities are kept.'))return;const r=await fetch('/api/prune-topics',{method:'POST'}).then(x=>x.json());alert('Pruned '+r.pruned+' topic stubs; wiki re-rendered.');await refreshData();});
  document.getElementById('nav-claims-count').textContent=stats.claims;
  document.getElementById('nav-pages-count').textContent=stats.pages;
  const ent=(DATA.entities||[]).length;
  const nec=document.getElementById('nav-entities-count');
  if(nec)nec.textContent=ent;
}
function renderOverview(){
  const{claims,health,events,sources}=DATA;
  const sorted=[...claims].sort((a,b)=>b.confidence-a.confidence);
  document.getElementById('top-claims').innerHTML='<table><tbody>'+sorted.slice(0,6).map(c=>'<tr data-page-id="'+c.pageId+'"><td style="width:70px">'+confBadge(c.confidence)+'</td><td>'+esc(c.statement.slice(0,80))+'</td></tr>').join('')+'</tbody></table>';
  const items=[];
  if(health.lowConfidence>0)items.push('🔴 '+health.lowConfidence+' low-confidence claims');
  if(health.contestedClaims.length)items.push('⚔️ '+health.contestedClaims.length+' contested');
  if(health.staleClaims.length)items.push('⏰ '+health.staleClaims.length+' stale');
  health.suggestedActions.forEach(a=>items.push('💡 '+a));
  if(!items.length)items.push('✅ Knowledge base is healthy!');
  document.getElementById('attention-items').innerHTML=items.map(i=>'<div style="padding:5px 0;font-size:13px">'+i+'</div>').join('');
  document.getElementById('sources-list').innerHTML=sources.length===0?'<p style="color:var(--text-dim)">No sources yet.</p>':'<table><tbody>'+sources.map(s=>'<tr data-source-id="'+s.id+'" style="cursor:pointer"><td style="color:var(--accent)">'+esc(s.title)+'</td><td><span class="badge badge-accent">'+s.qualityTier+'</span></td><td style="color:var(--text-dim)">'+relTime(s.ingestedAt)+'</td></tr>').join('')+'</tbody></table>';
  const recent=events.slice(0,5);
  document.getElementById('recent-events').innerHTML=recent.length===0?'<p style="color:var(--text-dim)">No events yet.</p>':recent.map(e=>'<div style="padding:5px 0;border-bottom:1px solid var(--border);font-size:13px;display:flex;gap:8px"><span style="font-weight:600;text-transform:capitalize;min-width:70px">'+e.type+'</span><span style="flex:1;color:var(--text-dim)">'+esc(e.claimStatement.slice(0,50))+'</span><span style="color:'+(e.confidenceAfter>=e.confidenceBefore?'var(--green)':'var(--red)')+';font-size:12px">'+(e.confidenceBefore*100).toFixed(0)+'%→'+(e.confidenceAfter*100).toFixed(0)+'%</span></div>').join('');
  renderConfChart();
}
function renderConfChart(){
  const{claims}=DATA;const bins=Array(10).fill(0);
  claims.forEach(c=>{bins[Math.min(9,Math.floor(c.confidence*10))]++;});
  const container=document.getElementById('conf-chart');const w=container.clientWidth,h=160;
  const svg=d3.select(container).html('').append('svg').attr('width',w).attr('height',h);
  const maxVal=Math.max(...bins,1);const barW=(w-40)/10;
  svg.selectAll('rect').data(bins).enter().append('rect').attr('x',(d,i)=>20+i*barW+2).attr('y',d=>h-28-(d/maxVal)*(h-48)).attr('width',barW-4).attr('height',d=>(d/maxVal)*(h-48)).attr('rx',5).attr('fill',(d,i)=>i>=8?'#16A34A':i>=4?'#D97706':'#DC2626').attr('opacity',.8);
  svg.selectAll('.ct').data(bins).enter().append('text').attr('x',(d,i)=>20+i*barW+barW/2).attr('y',d=>h-32-(d/maxVal)*(h-48)).attr('text-anchor','middle').attr('fill','#78716C').attr('font-size','11px').attr('font-weight','600').text(d=>d||'');
  svg.selectAll('.lbl').data(bins).enter().append('text').attr('x',(d,i)=>20+i*barW+barW/2).attr('y',h-6).attr('text-anchor','middle').attr('fill','#A8A29E').attr('font-size','10px').text((d,i)=>(i*10)+'%');
}
function renderClaims(){applyClaimFilters();}
function applyClaimFilters(){
  const filter=document.getElementById('claim-filter').value;
  const typeFilter=document.getElementById('claim-type-filter').value;
  const search=(document.getElementById('claim-search').value||'').toLowerCase();
  const pageMap=Object.fromEntries(DATA.pages.map(p=>[p.id,p.title]));
  let filtered=DATA.claims;
  if(filter==='high')filtered=filtered.filter(c=>c.confidence>=0.8);
  else if(filter==='mid')filtered=filtered.filter(c=>c.confidence>=0.4&&c.confidence<0.8);
  else if(filter==='low')filtered=filtered.filter(c=>c.confidence<0.4);
  if(typeFilter!=='all')filtered=filtered.filter(c=>(c.claimType||'fact')===typeFilter);
  if(search)filtered=filtered.filter(c=>c.statement.toLowerCase().includes(search)||(pageMap[c.pageId]||'').toLowerCase().includes(search));
  document.getElementById('claims-table').innerHTML=filtered.map(c=>'<tr data-page-id="'+c.pageId+'"><td style="width:70px">'+confBadge(c.confidence)+'</td><td style="width:88px">'+claimTypeBadge(c.claimType||'fact')+'</td><td>'+esc(c.statement)+'</td><td><span class="page-link">'+esc(pageMap[c.pageId]||'?')+'</span></td><td style="text-align:center">'+c.sources+'</td><td style="color:var(--text-dim)">'+relTime(c.lastReinforced)+'</td><td style="width:36px;text-align:center"><button class="delete-claim-btn" data-claim-id="'+c.id+'" title="Delete claim" style="background:none;border:none;cursor:pointer;color:var(--text-xdim);font-size:14px;padding:2px 6px;border-radius:4px;transition:var(--transition)" onmouseover="this.style.color=\\'var(--red)\\';this.style.background=\\'var(--red-dim)\\'" onmouseout="this.style.color=\\'var(--text-xdim)\\';this.style.background=\\'none\\'">✕</button></td></tr>').join('');
  document.querySelectorAll('.delete-claim-btn').forEach(btn=>{btn.addEventListener('click',async(e)=>{e.stopPropagation();if(!confirm('Delete this claim?'))return;await fetch('/api/claim?id='+btn.dataset.claimId,{method:'DELETE'});await refreshData();renderClaims();});});
}
document.getElementById('claim-filter').addEventListener('change',applyClaimFilters);
document.getElementById('claim-type-filter').addEventListener('change',applyClaimFilters);
document.getElementById('claim-search').addEventListener('input',applyClaimFilters);
function renderPages(){applyPageFilter();}
function applyPageFilter(){
  const q=(document.getElementById('page-search').value||'').toLowerCase();
  let pages=DATA.pages;
  if(q)pages=pages.filter(p=>{
    const metaStr=JSON.stringify(p.metadata||{}).toLowerCase();
    return p.title.toLowerCase().includes(q)||String(p.kind||'topic').toLowerCase().includes(q)||metaStr.includes(q);
  });
  const byKind={};
  for(const p of pages){
    const k=p.kind||'topic';
    (byKind[k]=byKind[k]||[]).push(p);
  }
  const keys=Object.keys(byKind).sort();
  let html='';
  for(const k of keys){
    html+='<tr class="kind-section"><td colspan="7" style="background:var(--surface-hover);font-weight:600;padding:8px 12px">'+esc(k)+' <span style="font-weight:400;color:var(--text-dim)">('+byKind[k].length+')</span></td></tr>';
    for(const p of byKind[k]){
      const rawMeta=JSON.stringify(p.metadata||{});
      const metaPreview=p.metadata&&Object.keys(p.metadata).length?(esc(rawMeta.length>80?rawMeta.slice(0,80)+'…':rawMeta)):'—';
      const entCell=p.entityId?'<span class="entity-chip" data-entity-id="'+esc(p.entityId)+'" style="cursor:pointer;display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;background:var(--accent-dim);color:var(--accent)">🏷️ Entity</span>':'—';
      html+='<tr data-page-id="'+p.id+'"><td><span class="page-link">'+esc(p.title)+'</span></td><td><code style="font-size:11px">'+esc(String(p.kind||'topic'))+'</code></td><td style="text-align:center">'+entCell+'</td><td style="font-size:11px;color:var(--text-dim);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(rawMeta)+'">'+metaPreview+'</td><td style="text-align:center">'+p.claimCount+'</td><td style="text-align:center">'+p.linkCount+'</td><td style="color:var(--text-dim)">'+relTime(p.updatedAt)+'</td></tr>';
    }
  }
  document.getElementById('pages-table').innerHTML=html;
}
document.getElementById('page-search').addEventListener('input',applyPageFilter);
function renderEntities(){applyEntityFilter();}
function applyEntityFilter(){
  const q=(document.getElementById('entity-search').value||'').toLowerCase();
  let list=DATA.entities||[];
  if(q)list=list.filter(e=>(e.canonicalName||'').toLowerCase().includes(q)||(e.type||'').toLowerCase().includes(q)||JSON.stringify(e.metadata||{}).toLowerCase().includes(q));
  const byType={};
  for(const e of list){
    const t=e.type||'unknown';
    (byType[t]=byType[t]||[]).push(e);
  }
  const keys=Object.keys(byType).sort();
  let html='';
  for(const t of keys){
    html+='<tr class="entity-kind-section"><td colspan="7" style="background:var(--surface-hover);font-weight:600;padding:8px 12px">'+esc(t)+' <span style="font-weight:400;color:var(--text-dim)">('+byType[t].length+')</span></td></tr>';
    for(const e of byType[t]){
      const pageCell=e.primaryPageId?'<span class="page-link-entity" data-page-id="'+esc(e.primaryPageId)+'" style="cursor:pointer;color:var(--accent)">open</span>':'—';
      html+='<tr data-entity-id="'+esc(e.id)+'" style="cursor:pointer"><td>'+esc(e.canonicalName)+'</td><td><code style="font-size:11px">'+esc(e.type)+'</code></td><td>'+esc(e.status||'active')+'</td><td style="text-align:center">'+(e.aliasCount||0)+'</td><td style="text-align:center">'+(e.claimCount||0)+'</td><td style="text-align:center">'+(e.relationCount||0)+'</td><td>'+pageCell+'</td></tr>';
    }
  }
  if(!html)html='<tr><td colspan="7" style="padding:16px;color:var(--text-dim)">No entities yet. Ingest typed vault notes (person, project, …) to create entity rows.</td></tr>';
  document.getElementById('entities-table').innerHTML=html;
}
document.getElementById('entity-search').addEventListener('input',applyEntityFilter);
async function openEntity(entityId){
  const d=await fetch('/api/entity?id='+encodeURIComponent(entityId)).then(r=>r.json());
  if(d.error){alert(d.error);return;}
  const meta=JSON.stringify(d.entity.metadata||{},null,2);
  let html='<div class="slideOver-section"><h3>'+esc(d.entity.canonicalName)+'</h3><p style="font-size:12px;color:var(--text-dim)"><code>'+esc(d.entity.type)+'</code> · '+esc(d.entity.status)+'</p></div>';
  html+=formatEntityLocationHtml(d.entity.metadata);
  if(d.summary&&d.summary.body)html+='<div class="slideOver-section"><h3>Summary'+(d.summary.stale?' <span style="font-size:10px;font-weight:400;color:var(--yellow);margin-left:6px">stale</span>':'')+'</h3><p style="font-size:13px;color:var(--text-dim);line-height:1.5;white-space:pre-wrap">'+esc(d.summary.body)+'</p></div>';
  if(d.relations&&d.relations.length){
    html+='<div class="slideOver-section"><h3>Relations ('+d.relations.length+')</h3><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5">';
    html+=d.relations.map(r=>'<li><code>'+esc(r.relationType)+'</code> → <strong class="entity-chip" data-entity-id="'+esc(r.otherEntityId)+'" style="cursor:pointer">'+esc(r.otherCanonicalName)+'</strong> <span style="color:var(--text-dim)">('+esc(r.direction)+')</span></li>').join('');
    html+='</ul></div>';
  }
  if(d.claims&&d.claims.length){
    html+='<div class="slideOver-section"><h3>Claims ('+d.claims.length+')</h3>';
    html+=d.claims.map(c=>'<div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:10px">'+confBadge(c.confidence)+claimTypeBadge(c.claimType||'fact')+'<div style="flex:1;font-size:13px">'+esc(c.statement)+'</div></div>').join('');
    html+='</div>';
  }
  if(d.aliases&&d.aliases.length)html+='<div class="slideOver-section"><h3>Aliases</h3><p style="font-size:13px">'+d.aliases.map(a=>'<code style="margin-right:6px">'+esc(a)+'</code>').join('')+'</p></div>';
  html+='<div class="slideOver-section"><details><summary style="cursor:pointer;font-weight:600;font-size:14px">Metadata</summary><pre style="font-size:11px;overflow:auto;max-height:180px;background:var(--surface);padding:10px;border-radius:6px;margin-top:8px">'+esc(meta)+'</pre></details></div>';
  html+='<div class="slideOver-section"><h3>Compiled views</h3><p style="font-size:12px;color:var(--text-dim)">Cached LLM summaries (regenerate on demand).</p>';
  html+='<div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">';
  [['summary','Summary'],['agent_context','Agent ctx'],['status_card','Status'],['briefing','Briefing']].forEach(function(p){html+='<button type="button" class="cv-load" data-vt="'+p[0]+'" style="background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit">'+p[1]+'</button>';});
  html+='</div><pre id="cv-out" style="font-size:12px;white-space:pre-wrap;max-height:220px;overflow:auto;background:var(--surface);padding:10px;border-radius:6px;margin:0">Select a tab…</pre></div>';
  if(d.primaryPageId)html+='<div style="margin-top:12px"><button type="button" class="open-primary-page-btn" data-page-id="'+esc(d.primaryPageId)+'" style="background:var(--accent);color:white;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px">Open primary page</button></div>';
  openSlideOver(html,d.entity.canonicalName);
  const sbody=document.getElementById('slideOver-body');
  const cvOut=sbody.querySelector('#cv-out');
  sbody.querySelectorAll('.cv-load').forEach(function(btn){
    btn.addEventListener('click',async function(){
      if(cvOut)cvOut.textContent='Loading…';
      const r=await fetch('/api/compiled-view?entity_id='+encodeURIComponent(entityId)+'&view_type='+btn.dataset.vt).then(function(x){return x.json();});
      if(cvOut)cvOut.textContent=r.error?r.error:(r.body||'');
    });
  });
  const ob=sbody.querySelector('.open-primary-page-btn');
  if(ob)ob.addEventListener('click',()=>openPage(ob.dataset.pageId));
}
document.addEventListener('click',e=>{
  const chip=e.target.closest('.entity-chip');
  if(chip){e.stopPropagation();openEntity(chip.dataset.entityId);return;}
  const entRow=e.target.closest('tr[data-entity-id]');
  if(entRow&&!e.target.closest('.page-link-entity')){openEntity(entRow.dataset.entityId);return;}
  const pl=e.target.closest('.page-link-entity');
  if(pl){e.stopPropagation();openPage(pl.dataset.pageId);return;}
  const srow=e.target.closest('tr[data-source-id]');
  if(srow){openSource(srow.dataset.sourceId);return;}
  const row=e.target.closest('tr[data-page-id]');
  if(row)openPage(row.dataset.pageId);
});

function renderTimeline(){
  const el=document.getElementById('timeline-list');
  if(timelineTab==='entity'){
    const rows=DATA.entityState||[];
    if(!rows.length){el.innerHTML='<p style="color:var(--text-dim)">No entity metadata changes logged yet.</p>';return;}
    el.innerHTML=rows.map(function(r){
      const ov=typeof r.oldValue==='object'?JSON.stringify(r.oldValue):String(r.oldValue==null?'—':r.oldValue);
      const nv=typeof r.newValue==='object'?JSON.stringify(r.newValue):String(r.newValue==null?'—':r.newValue);
      return'<div class="tl-event"><div class="tl-dot tl-created"></div><span class="tl-date">'+new Date(r.createdAt).toLocaleString()+'</span><span class="tl-type">entity</span><span class="tl-stmt tl-ent-st" data-entity-id="'+esc(r.entityId)+'" style="cursor:pointer"><strong>'+esc(r.entityCanonicalName)+'</strong> · <code>'+esc(r.fieldPath)+'</code><br><span style="font-size:11px;color:var(--text-dim)">'+esc(ov.slice(0,80))+' → '+esc(nv.slice(0,80))+'</span></span></div>';
    }).join('');
    el.querySelectorAll('.tl-ent-st').forEach(function(x){x.addEventListener('click',function(){openEntity(x.dataset.entityId);});});
    return;
  }
  const{events}=DATA;
  if(!events.length){el.innerHTML='<p style="color:var(--text-dim)">No events yet.</p>';return;}
  el.innerHTML=events.map(e=>{
    const up=e.confidenceAfter>=e.confidenceBefore;
    return'<div class="tl-event"><div class="tl-dot tl-'+e.type+'"></div><span class="tl-date">'+new Date(e.date).toLocaleString()+'</span><span class="tl-type">'+e.type+'</span><span class="tl-stmt" data-claim-id="'+(e.claimId||'')+'">'+esc(e.claimStatement.slice(0,70))+'</span><span class="tl-delta" style="color:'+(up?'var(--green)':'var(--red)')+'">'+(e.confidenceBefore*100).toFixed(0)+'% '+(up?'↑':'↓')+' '+(e.confidenceAfter*100).toFixed(0)+'%</span></div>';
  }).join('');
  el.querySelectorAll('.tl-stmt[data-claim-id]').forEach(el=>{el.addEventListener('click',()=>{const claim=DATA.claims.find(c=>c.id===el.dataset.claimId);if(claim)openPage(claim.pageId);});});
}
document.querySelectorAll('.tl-tab').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('.tl-tab').forEach(function(b){b.classList.remove('active');});
    btn.classList.add('active');
    timelineTab=btn.dataset.tlTab;
    renderTimeline();
  });
});
function renderReviewQueue(){
  const items=(DATA.reviewQueue&&DATA.reviewQueue.items)||[];
  const el=document.getElementById('review-queue-list');
  const badge=document.getElementById('nav-review-count');
  if(badge)badge.textContent=String(items.length);
  if(!el)return;
  if(!items.length){el.innerHTML='<p style="color:var(--text-dim)">No pending aliases. Extraction may add candidates via <code>possible_alias</code>.</p>';return;}
  el.innerHTML='<table><thead><tr><th>Surface</th><th>Candidate entity</th><th>When</th><th></th></tr></thead><tbody>'+
    items.map(function(it){return'<tr><td><code>'+esc(it.surfaceForm)+'</code></td><td>'+esc(it.candidateEntityName)+'</td><td style="color:var(--text-dim);font-size:12px">'+relTime(it.createdAt)+'</td><td><button type="button" class="rq-confirm" data-id="'+esc(it.id)+'" style="margin-right:6px;background:var(--accent);color:#fff;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px">Confirm</button><button type="button" class="rq-dismiss" data-id="'+esc(it.id)+'" style="background:var(--surface2);border:1px solid var(--border);padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px">Dismiss</button></td></tr>';}).join('')+
    '</tbody></table>';
  el.querySelectorAll('.rq-confirm').forEach(function(b){b.addEventListener('click',async function(){await fetch('/api/review-queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'confirm',id:b.dataset.id})});await refreshData();});});
  el.querySelectorAll('.rq-dismiss').forEach(function(b){b.addEventListener('click',async function(){await fetch('/api/review-queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'dismiss',id:b.dataset.id})});await refreshData();});});
}
function renderHealth(){
  const{health}=DATA;const total=health.totalClaims||1;
  document.getElementById('health-rings').innerHTML=healthRing(health.highConfidence/total,'var(--green)','High',health.highConfidence)+healthRing(health.mediumConfidence/total,'var(--yellow)','Medium',health.mediumConfidence)+healthRing(health.lowConfidence/total,'var(--red)','Low',health.lowConfidence);
  const ho=document.getElementById('health-ontology');
  const ont=health.ontology;
  if(ho&&ont){
    ho.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;font-size:12px;color:var(--text-dim)">'+
      '<div><div style="font-weight:700;color:var(--text);font-size:18px">'+ont.entityCount+'</div>Entities</div>'+
      '<div><div style="font-weight:700;color:var(--text);font-size:18px">'+ont.entitiesWithPrimaryPage+'</div>Linked pages</div>'+
      '<div><div style="font-weight:700;color:var(--text);font-size:18px">'+ont.relationCount+'</div>Relations</div>'+
      '<div><div style="font-weight:700;color:var(--text);font-size:18px">'+ont.pendingAliasCount+'</div>Pending aliases</div>'+
      '<div><div style="font-weight:700;color:var(--text);font-size:18px">'+ont.staleCompiledViewCount+'</div>Stale views</div>'+
      '</div>';
  }
  const actions=health.suggestedActions.length?health.suggestedActions:['No actions needed.'];
  document.getElementById('health-actions').innerHTML=actions.map(a=>'<li>💡 '+esc(a)+'</li>').join('');
  document.getElementById('stale-claims').innerHTML=health.staleClaims.length===0?'<p style="color:var(--text-dim)">None</p>':'<table><tbody>'+health.staleClaims.slice(0,8).map(c=>'<tr><td>'+esc(c.statement.slice(0,50))+'…</td><td style="color:var(--yellow);text-align:right">'+c.daysSince+'d</td></tr>').join('')+'</tbody></table>';
  document.getElementById('contested-claims').innerHTML=health.contestedClaims.length===0?'<p style="color:var(--text-dim)">None</p>':'<table><tbody>'+health.contestedClaims.map(c=>'<tr><td>'+esc(c.statement.slice(0,50))+'…</td><td style="color:var(--red);text-align:right">'+c.contradictions+'</td></tr>').join('')+'</tbody></table>';
}
function healthRing(pct,color,label,count){
  const r=38,circ=2*Math.PI*r;
  return'<div class="health-ring"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="'+r+'" fill="none" stroke="#E8E5DD" stroke-width="7"/><circle cx="50" cy="50" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="7" stroke-dasharray="'+(pct*circ)+' '+circ+'" transform="rotate(-90 50 50)" stroke-linecap="round"/><text x="50" y="46" text-anchor="middle" fill="'+color+'" font-size="20" font-weight="700">'+count+'</text><text x="50" y="62" text-anchor="middle" fill="#78716C" font-size="11" font-weight="500">'+label+'</text></svg></div>';
}

let graphRendered=false;let graphSim=null;
function renderGraph(){
  graphRendered=true;const{graph}=DATA;
  const container=document.getElementById('graph-container');const tooltip=document.getElementById('graph-tooltip');
  const lodBadge=document.getElementById('graph-lod');
  const canvas=document.getElementById('graph-canvas');
  const dpr=window.devicePixelRatio||1;
  const width=container.clientWidth,height=container.clientHeight||600;
  canvas.width=width*dpr;canvas.height=height*dpr;
  canvas.style.width=width+'px';canvas.style.height=height+'px';
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);

  /* ---- data prep ---- */
  const allEdges=graph.edges.map(e=>({source:e.source,target:e.target,type:e.type,weight:e.weight||1,importance:e.importance||0,relationType:e.relationType}));
  const nodes=graph.nodes;
  const sourceGroups=graph.sourceGroups||{};
  const nodeById=new Map();nodes.forEach(n=>nodeById.set(n.id,n));

  if(!nodes.length){ctx.fillStyle='rgba(205,214,244,0.4)';ctx.font='14px system-ui';ctx.textAlign='center';ctx.fillText('No data — ingest sources first',width/2,height/2);return;}

  /* spread initial positions — wide to avoid starting clustered */
  const spread=Math.max(width,height)*0.8;
  nodes.forEach(n=>{if(n.x===undefined){n.x=width/2+(Math.random()-0.5)*spread;n.y=height/2+(Math.random()-0.5)*spread;}});

  let transform=d3.zoomIdentity;let hoveredNode=null;let dragNode=null;
  const edgeColor='rgba(148,163,184,0.12)';
  const hoverEdgeColor='rgba(167,139,250,0.7)';
  const contradictionColor='#f87171';

  /* ---- LOD: edges sorted by importance (pre-sorted from backend) ---- */
  /* Determine how many edges to show based on zoom — very aggressive at low zoom */
  function lodEdgeCount(zoom){
    const total=allEdges.length;
    if(total<=200)return total;
    if(zoom>=2.0)return total;
    if(zoom>=1.2)return Math.ceil(total*0.5);
    if(zoom>=0.7)return Math.ceil(total*0.15);
    if(zoom>=0.4)return Math.min(400,Math.ceil(total*0.03));
    if(zoom>=0.2)return Math.min(200,Math.ceil(total*0.01));
    return Math.min(100,Math.ceil(total*0.003));
  }
  function lodLabel(){
    const z=transform.k;const pct=Math.min(100,Math.round(lodEdgeCount(z)/allEdges.length*100));
    return pct>=100?'All connections visible':'Showing '+pct+'% of connections · zoom in for more';
  }

  /* ---- shared-source neighbours for on-demand hover ---- */
  const sharedSourceNeighbours=new Map();
  (function buildSharedSourceIndex(){
    const pgToSrc=new Map();
    for(const[srcId,pageIds] of Object.entries(sourceGroups)){
      for(const pid of pageIds){if(!pgToSrc.has(pid))pgToSrc.set(pid,new Set());pgToSrc.get(pid).add(srcId);}
    }
    for(const[pid,srcs] of pgToSrc.entries()){
      const neighbours=new Set();
      for(const sid of srcs){for(const other of sourceGroups[sid]||[]){if(other!==pid)neighbours.add(other);}}
      sharedSourceNeighbours.set(pid,neighbours);
    }
  })();

  /* ---- adjacency (full) for hover: explicit links ---- */
  const adj=new Map();nodes.forEach(n=>adj.set(n.id,new Set()));
  allEdges.forEach(l=>{const sid=typeof l.source==='object'?l.source.id:l.source;const tid=typeof l.target==='object'?l.target.id:l.target;if(adj.has(sid))adj.get(sid).add(tid);if(adj.has(tid))adj.get(tid).add(sid);});

  /* total connection count per node (explicit + shared-source) for hidden-indicator */
  const totalDeg=new Map();nodes.forEach(n=>{
    const e=(adj.get(n.id)||new Set()).size;
    const s=(sharedSourceNeighbours.get(n.id)||new Set()).size;
    totalDeg.set(n.id,e+s);
  });

  /* ---- layout simulation uses top N edges for structure (not all edges!) ---- */
  const simEdgeCap=Math.min(allEdges.length,Math.max(200,Math.ceil(nodes.length*1.5)));
  const simLinks=allEdges.slice(0,simEdgeCap).map(e=>({source:e.source,target:e.target,type:e.type,weight:e.weight}));

  /* ---- viewport culling helper ---- */
  function inView(x,y,pad){
    const sx=x*transform.k+transform.x, sy=y*transform.k+transform.y;
    return sx>=-pad&&sx<=width+pad&&sy>=-pad&&sy<=height+pad;
  }

  /* ---- draw loop ---- */
  function draw(){
    ctx.save();ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,width,height);
    ctx.translate(transform.x,transform.y);ctx.scale(transform.k,transform.k);

    const visCount=lodEdgeCount(transform.k);
    const isHover=!!hoveredNode;
    const hoverId=isHover?hoveredNode.id:null;
    const hoverAdj=isHover?(adj.get(hoverId)||new Set()):null;
    const hoverShared=isHover?(sharedSourceNeighbours.get(hoverId)||new Set()):null;

    /* ---- edges: LOD visible subset ---- */
    for(let i=0;i<visCount;i++){
      const l=allEdges[i];
      const src=typeof l.source==='object'?l.source:nodeById.get(l.source);
      const tgt=typeof l.target==='object'?l.target:nodeById.get(l.target);
      if(!src||!tgt||src.x===undefined)continue;
      if(!inView(src.x,src.y,100)&&!inView(tgt.x,tgt.y,100))continue;
      const sid=src.id,tid=tgt.id;
      let strokeC=edgeColor;
      if(l.type==='contradiction')strokeC=contradictionColor;
      else if(l.type==='relation'){
        const rt=String(l.relationType||'').toLowerCase();
        if(rt==='child_of'||rt==='spouse_of')strokeC='rgba(244,114,182,0.9)';
        else if(rt==='depends_on'||rt==='works_on'||rt==='stakeholder_of')strokeC='rgba(56,189,248,0.9)';
        else strokeC='rgba(52,211,153,0.85)';
      }
      if(isHover&&sid!==hoverId&&tid!==hoverId){ctx.globalAlpha=0.03;ctx.strokeStyle=edgeColor;}else if(isHover){ctx.globalAlpha=1;ctx.strokeStyle=hoverEdgeColor;}else{ctx.globalAlpha=1;ctx.strokeStyle=strokeC;}
      ctx.lineWidth=(l.type==='contradiction'?1.5:l.type==='relation'?1.1:0.7)/transform.k;
      ctx.beginPath();ctx.moveTo(src.x,src.y);ctx.lineTo(tgt.x,tgt.y);
      if(l.type==='contradiction'){ctx.setLineDash([4/transform.k,3/transform.k]);}else{ctx.setLineDash([]);}
      ctx.stroke();
    }

    /* ---- hover: draw ALL explicit edges for hovered node ---- */
    if(isHover){
      ctx.setLineDash([]);ctx.globalAlpha=1;ctx.strokeStyle=hoverEdgeColor;ctx.lineWidth=0.8/transform.k;
      allEdges.forEach(l=>{
        const src=typeof l.source==='object'?l.source:nodeById.get(l.source);
        const tgt=typeof l.target==='object'?l.target:nodeById.get(l.target);
        if(!src||!tgt||src.x===undefined)return;
        const sid=src.id,tid=tgt.id;
        if(sid!==hoverId&&tid!==hoverId)return;
        let hStroke=hoverEdgeColor;
        if(l.type==='contradiction')hStroke=contradictionColor;
        else if(l.type==='relation'){
          const rt=String(l.relationType||'').toLowerCase();
          if(rt==='child_of'||rt==='spouse_of')hStroke='rgba(244,114,182,0.95)';
          else if(rt==='depends_on'||rt==='works_on'||rt==='stakeholder_of')hStroke='rgba(56,189,248,0.95)';
          else hStroke='rgba(52,211,153,0.9)';
        }
        ctx.strokeStyle=hStroke;
        ctx.lineWidth=(l.type==='contradiction'?1.5:l.type==='relation'?1.2:0.8)/transform.k;
        if(l.type==='contradiction'){ctx.setLineDash([4/transform.k,3/transform.k]);}else{ctx.setLineDash([]);}
        ctx.beginPath();ctx.moveTo(src.x,src.y);ctx.lineTo(tgt.x,tgt.y);ctx.stroke();
      });
      /* shared-source on hover */
      ctx.setLineDash([3/transform.k,3/transform.k]);ctx.strokeStyle='rgba(148,163,184,0.35)';ctx.lineWidth=0.6/transform.k;ctx.globalAlpha=1;
      for(const nid of hoverShared){
        const tgt=nodeById.get(nid);
        if(!tgt||tgt.x===undefined)continue;
        ctx.beginPath();ctx.moveTo(hoveredNode.x,hoveredNode.y);ctx.lineTo(tgt.x,tgt.y);ctx.stroke();
      }
    }

    ctx.setLineDash([]);ctx.globalAlpha=1;

    /* ---- nodes ---- */
    const labelThreshold=0.6;
    nodes.forEach(n=>{
      if(!inView(n.x,n.y,50))return;
      const r=Math.max(3,n.size/2);
      const isConnected=isHover&&(hoverId===n.id||hoverAdj.has(n.id)||hoverShared.has(n.id));
      let alpha=0.85;
      if(isHover&&!isConnected)alpha=0.08;
      ctx.globalAlpha=alpha;

      /* soft glow behind node */
      const glowR=r*2.5;
      const grd=ctx.createRadialGradient(n.x,n.y,r*0.3,n.x,n.y,glowR);
      grd.addColorStop(0,n.color+'60');grd.addColorStop(1,n.color+'00');
      ctx.fillStyle=grd;ctx.beginPath();ctx.arc(n.x,n.y,glowR,0,Math.PI*2);ctx.fill();

      /* node circle — no border, just clean fill */
      ctx.beginPath();ctx.arc(n.x,n.y,r,0,Math.PI*2);
      ctx.fillStyle=n.color;ctx.fill();

      /* brighter ring on hover-connected nodes */
      if(isHover&&isConnected){
        ctx.strokeStyle=n.color;ctx.lineWidth=1.5/transform.k;
        ctx.stroke();
      }

      /* label — light on dark */
      if(transform.k>=labelThreshold||isHover&&isConnected){
        ctx.fillStyle='rgba(205,214,244,'+(isConnected||!isHover?'0.9':'0.3')+')';ctx.font='bold '+Math.max(9,10/transform.k)+'px system-ui,sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';
        ctx.fillText(n.label,n.x+r+4/transform.k,n.y);
      }
      ctx.globalAlpha=1;
    });
    ctx.restore();

    /* LOD badge */
    if(lodBadge)lodBadge.textContent=lodLabel();
  }

  /* ---- simulation ---- */
  if(graphSim)graphSim.stop();
  const N=nodes.length;

  /* degree map for hub-dampened link strength */
  const simDeg=new Map();
  simLinks.forEach(l=>{simDeg.set(l.source,(simDeg.get(l.source)||0)+1);simDeg.set(l.target,(simDeg.get(l.target)||0)+1);});

  const chargeStr=N>200?-1500:N>50?-600:-180;
  const linkDist=N>200?250:N>50?160:70;
  graphSim=d3.forceSimulation(nodes)
    .force('link',d3.forceLink(simLinks).id(d=>d.id).distance(linkDist)
      .strength(l=>{
        /* weaken links to/from hubs so they don't collapse everything */
        const ds=(simDeg.get(typeof l.source==='object'?l.source.id:l.source)||1);
        const dt=(simDeg.get(typeof l.target==='object'?l.target.id:l.target)||1);
        return 0.5/Math.max(ds,dt);
      }))
    .force('charge',d3.forceManyBody().strength(chargeStr).theta(0.9))
    .force('x',d3.forceX(width/2).strength(0.008))
    .force('y',d3.forceY(height/2).strength(0.008))
    .force('collision',d3.forceCollide().radius(d=>d.size/2+10).strength(1).iterations(3))
    .alphaDecay(0.01)
    .velocityDecay(0.35)
    .on('tick',draw)
    .on('end',()=>{
      let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
      nodes.forEach(n=>{x0=Math.min(x0,n.x);y0=Math.min(y0,n.y);x1=Math.max(x1,n.x);y1=Math.max(y1,n.y);});
      const pad=60;x0-=pad;y0-=pad;x1+=pad;y1+=pad;
      const bw=x1-x0,bh=y1-y0;
      const sc=Math.min(width/bw,height/bh,1.5);
      const tx=width/2-(x0+bw/2)*sc,ty=height/2-(y0+bh/2)*sc;
      transform=d3.zoomIdentity.translate(tx,ty).scale(sc);
      d3.select(canvas).call(zoomBehavior.transform,transform);
      draw();
    });

  /* ---- hit test helper (radius grows when zoomed out so nodes stay interactive) ---- */
  function hitNode(mx,my){const pt=[((mx-transform.x)/transform.k),((my-transform.y)/transform.k)];const minScreen=12;let best=null,bestD=Infinity;nodes.forEach(n=>{const dx=n.x-pt[0],dy=n.y-pt[1],d=Math.sqrt(dx*dx+dy*dy),r=Math.max(n.size/2,minScreen/transform.k);if(d<r&&d<bestD){bestD=d;best=n;}});return best;}

  /* ---- zoom ---- */
  const zoomBehavior=d3.zoom().scaleExtent([0.05,10]).on('zoom',event=>{transform=event.transform;draw();});
  d3.select(canvas).call(zoomBehavior).on('dblclick.zoom',null);

  /* ---- drag ---- */
  d3.select(canvas).call(d3.drag()
    .subject(event=>{const n=hitNode(event.x,event.y);if(n){n.fx=n.x;n.fy=n.y;}return n;})
    .on('start',(event)=>{if(!event.active)graphSim.alphaTarget(0.3).restart();dragNode=event.subject;dragNode.fx=dragNode.x;dragNode.fy=dragNode.y;})
    .on('drag',(event)=>{if(!dragNode)return;dragNode.fx=(event.x-transform.x)/transform.k;dragNode.fy=(event.y-transform.y)/transform.k;})
    .on('end',(event)=>{if(!event.active)graphSim.alphaTarget(0);if(dragNode){dragNode.fx=null;dragNode.fy=null;}dragNode=null;})
  );

  /* ---- mouse interactions ---- */
  canvas.addEventListener('mousemove',function(e){
    const rect=canvas.getBoundingClientRect();const mx=e.clientX-rect.left,my=e.clientY-rect.top;
    const n=hitNode(mx,my);
    if(n!==hoveredNode){hoveredNode=n;draw();
      if(n){
        const hAdj=(adj.get(n.id)||new Set()).size;
        const hShared=(sharedSourceNeighbours.get(n.id)||new Set()).size;
        canvas.style.cursor='pointer';tooltip.style.display='block';
        const entLab=n.metadata.isEntity?' · <span style="color:#34d399">entity</span>':'';
        tooltip.innerHTML='<strong style="color:#cdd6f4">'+esc(n.label)+'</strong>'+entLab+'<br><span style="color:rgba(205,214,244,0.5)">'+(n.metadata.claims||0)+' claims</span><br>'+confBadge(n.metadata.avgConfidence||0)+'<br><span style="color:rgba(205,214,244,0.4);font-size:11px">'+hAdj+' links · '+hShared+' shared-source</span>';
      }else{canvas.style.cursor='grab';tooltip.style.display='none';}
    }
    if(hoveredNode){tooltip.style.left=(mx+15)+'px';tooltip.style.top=(my-10)+'px';}
  });
  canvas.addEventListener('mouseleave',function(){if(hoveredNode){hoveredNode=null;draw();tooltip.style.display='none';}});
  canvas.addEventListener('click',function(e){const rect=canvas.getBoundingClientRect();const n=hitNode(e.clientX-rect.left,e.clientY-rect.top);if(n)openPage(n.id);});
}

const chatInput=document.getElementById('chat-input');const chatSend=document.getElementById('chat-send');
const chatMessages=document.getElementById('chat-messages');const chatEmpty=document.getElementById('chat-empty');
function renderChatSuggestions(){
  const suggestions=[];
  if(DATA.pages.length)suggestions.push('Tell me about '+DATA.pages[0].title);
  suggestions.push('What are the key concepts?','Which claims need more evidence?','How do the topics connect?');
  if(DATA.health.contestedClaims.length)suggestions.push('What claims are contested?');
  document.getElementById('chat-suggestions').innerHTML=suggestions.map(s=>'<button class="chat-suggestion" data-q="'+esc(s)+'">'+esc(s)+'</button>').join('');
  document.querySelectorAll('.chat-suggestion').forEach(btn=>{btn.addEventListener('click',()=>askQuestion(btn.dataset.q));});
}
async function askQuestion(q){
  if(!q||!q.trim())return;chatInput.value='';chatEmpty.style.display='none';chatSend.disabled=true;
  chatHistory.push({role:'user',text:q});chatHistory.push({role:'bot',text:'<div class="chat-spinner"></div>',loading:true});renderChatMessages();
  try{
    const r=await fetch('/api/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q})});
    const res=await r.json();
    chatHistory.pop();
    if(res.error){chatHistory.push({role:'bot',text:'<span style="color:var(--red)">'+esc(res.error)+'</span>'});}
    else{
      const cited=res.claimIds||[];
      let answerHtml=formatInline(res.answer||'No answer returned.');
      answerHtml=answerHtml.replace(/\\n/g,'<br>');
      const meta='<div class="chat-msg-meta">'+confBadge(res.confidence||0)+'<span style="font-size:12px;color:var(--text-dim)">'+cited.length+' claims cited</span></div>';
      if(cited.length){
        const claimsList=DATA.claims.filter(c=>cited.includes(c.id));
        if(claimsList.length){
          answerHtml+='<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)"><div style="font-size:11px;font-weight:600;color:var(--text-dim);margin-bottom:4px">CITED CLAIMS</div>';
          answerHtml+=claimsList.map(c=>'<div style="font-size:12px;padding:3px 0;display:flex;gap:6px;align-items:flex-start">'+confBadge(c.confidence)+'<span>'+esc(c.statement.slice(0,80))+'</span></div>').join('');
          answerHtml+='</div>';
        }
      }
      const rv=res.retrieval;
      if(rv){
        const rid='rd'+Date.now();
        const strat=rv.strategy||'fts5';
        const pillClass=strat==='hybrid'?'hybrid':(strat.startsWith('hybrid-')?'warn':'fts5');
        const stratLabel=strat==='fts5'?'FTS5':strat==='hybrid'?'Hybrid':strat==='hybrid-no-key'?'FTS5 (no embed key)':'FTS5 (no embeddings)';
        let detail='<b>Strategy:</b> '+stratLabel;
        detail+=' · <b>Pages:</b> '+rv.pagesFound;
        detail+=' · <b>Claims found:</b> '+rv.claimsCandidates;
        detail+=' · <b>In context:</b> '+rv.claimsInContext;
        detail+=' · <b>Relations:</b> '+rv.relationsFound;
        if(rv.searchMs!=null)detail+=' · <b>Search:</b> '+rv.searchMs+'ms';
        if(rv.llmMs!=null)detail+=' · <b>LLM:</b> '+rv.llmMs+'ms';
        if(rv.claimTypes&&Object.keys(rv.claimTypes).length){detail+='<br><b>Claim types:</b> '+Object.entries(rv.claimTypes).map(([t,n])=>t+' ('+n+')').join(', ');}
        if(rv.entityTypes&&Object.keys(rv.entityTypes).length){detail+=' · <b>Entity types:</b> '+Object.entries(rv.entityTypes).map(([t,n])=>t+' ('+n+')').join(', ');}
        if(rv.embeddingModel)detail+='<br><b>Embedding model:</b> '+esc(rv.embeddingModel);
        if(rv.embeddingsIndexed!=null)detail+=' · <b>Indexed:</b> '+rv.embeddingsIndexed;
        if(rv.vectorCandidates!=null)detail+=' · <b>Vector candidates:</b> '+rv.vectorCandidates;
        answerHtml+='<div class="retrieval-debug"><button class="retrieval-toggle '+pillClass+'" onclick="this.classList.toggle(\\'open\\');document.getElementById(\\''+rid+'\\').classList.toggle(\\'open\\')">'+stratLabel+'<span class="chevron">\u25BE</span></button><div class="retrieval-detail" id="'+rid+'">'+detail+'</div></div>';
      }
      chatHistory.push({role:'bot',text:answerHtml+meta});
    }
  }catch(err){chatHistory.pop();chatHistory.push({role:'bot',text:'<span style="color:var(--red)">Failed to get answer: '+(err.message||'Check LLM config & API key.')+'</span>'});}
  chatSend.disabled=false;renderChatMessages();
}
function renderChatMessages(){
  chatMessages.innerHTML=chatHistory.map(m=>{const isUser=m.role==='user';
    return'<div class="chat-msg '+(isUser?'chat-msg-user':'chat-msg-bot')+'"><div class="chat-msg-avatar">'+(isUser?'👤':'🧠')+'</div><div class="chat-msg-body"><div class="chat-msg-name">'+(isUser?'You':'Wiki')+'</div><div class="chat-msg-text">'+(m.loading?m.text:(isUser?esc(m.text):m.text))+'</div></div></div>';
  }).join('');chatMessages.scrollTop=chatMessages.scrollHeight;
}
chatSend.addEventListener('click',()=>askQuestion(chatInput.value));
chatInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();askQuestion(chatInput.value);}});
chatInput.addEventListener('input',()=>{chatInput.style.height='auto';chatInput.style.height=Math.min(chatInput.scrollHeight,120)+'px';});

setInterval(async()=>{try{const s=await fetch('/api/stats').then(r=>r.json());if(JSON.stringify(s)!==JSON.stringify(DATA.stats)){await fetchAll();renderAll();}}catch{}},5000);

function renderAll(){renderStatsRow();renderSidebarStats();renderOverview();renderClaims();renderPages();renderEntities();renderReviewQueue();renderTimeline();renderHealth();renderChatSuggestions();if(graphRendered){graphRendered=false;renderGraph();}}
fetchAll().then(()=>renderAll());
<\/script>
</body>
</html>`;
}
