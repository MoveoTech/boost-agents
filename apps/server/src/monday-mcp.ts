import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDecl, ToolParam } from "./llm";

// Monday's official hosted MCP server. Auth is the same Monday access token we already hold for
// the owner; transport is streamable HTTP. See https://github.com/mondaycom/mcp
const MCP_URL = "https://mcp.monday.com/mcp";
const API_VERSION = process.env.MONDAY_API_VERSION || "2025-07";
const TTL = 5 * 60_000;

// The hosted server exposes ~68 tools. Handing all of them to one subagent overloads tool
// selection and corrupts arguments, so by default we expose a curated, high-value subset
// (reads + the generic API escape hatch). Override with MONDAY_MCP_TOOLS="a,b,c", or
// MONDAY_MCP_TOOLS="all" to expose every tool.
const DEFAULT_MCP_TOOLS = [
  "get_board_info", "get_board_items_page", "get_updates", "get_board_activity",
  "search", "read_docs", "list_users_and_teams", "get_user_context",
  "list_workspaces", "workspace_info", "board_insights",
  "create_item", "change_item_column_values", "create_update",
  "create_board", "create_column", "create_group",
  "all_monday_api", "get_graphql_schema", "get_column_type_info", "get_type_details",
];

export function mondayMcpEnabled(): boolean {
  const v = (process.env.MONDAY_MCP_ENABLED ?? "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function allowedMcpTools(): { all: boolean; set: Set<string> } {
  const raw = (process.env.MONDAY_MCP_TOOLS ?? "").trim();
  if (raw.toLowerCase() === "all" || raw === "*") return { all: true, set: new Set() };
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_MCP_TOOLS;
  return { all: false, set: new Set(list) };
}

interface Cached { client: Client; tools: ToolDecl[]; names: Set<string>; ts: number; }
const cache = new Map<string, Cached>();

// Flatten a JSON-schema property into our simple ToolParam (providers only read type/description/items).
function toToolParam(schema: unknown): ToolParam {
  const s = (schema ?? {}) as Record<string, any>;
  const rawType = Array.isArray(s.type) ? s.type[0] : s.type;
  const type: ToolParam["type"] = ["string", "number", "boolean", "array", "object"].includes(rawType) ? rawType : "string";
  let description: string = s.description ?? "";
  if (s.enum && Array.isArray(s.enum)) description = `${description} (one of: ${s.enum.join(", ")})`.trim();
  const param: ToolParam = { type, description };
  if (type === "array") param.items = { type: (s.items?.type as string) ?? "string" };
  return param;
}

async function getClient(token: string): Promise<Cached> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.ts < TTL) return hit;

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "Api-Version": API_VERSION } },
  });
  const client = new Client({ name: "boost-agent", version: "1.0.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  const allow = allowedMcpTools();
  const tools: ToolDecl[] = [];
  const names = new Set<string>();
  for (const t of listed.tools ?? []) {
    if (!allow.all && !allow.set.has(t.name)) continue;   // curated subset only
    const schema = (t.inputSchema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    tools.push({
      name: t.name,
      description: t.description ?? "",
      parameters: {
        properties: Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, toToolParam(v)])),
        required: schema.required ?? [],
      },
    });
    names.add(t.name);
  }
  const entry: Cached = { client, tools, names, ts: Date.now() };
  cache.set(token, entry);
  console.log(JSON.stringify({ tag: "monday-mcp", msg: "connected", toolCount: tools.length }));
  return entry;
}

// Returns the hosted Monday MCP tools (as ToolDecls) and the set of their names for routing.
// Never throws — on failure returns empty so the subagent still has its built-in Monday tools.
export async function getMondayMcpTools(token: string): Promise<{ tools: ToolDecl[]; names: Set<string> }> {
  try {
    const c = await getClient(token);
    return { tools: c.tools, names: c.names };
  } catch (e) {
    console.error(JSON.stringify({ tag: "monday-mcp", msg: "connect failed", error: (e as Error).message }));
    cache.delete(token);
    return { tools: [], names: new Set() };
  }
}

export async function callMondayMcpTool(token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const c = await getClient(token);
  const res = await c.client.callTool({ name, arguments: args });
  const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n");
  return text || JSON.stringify(res);
}
