import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { MCPServerConfig } from "./config";
import type { ToolDecl } from "./llm";

export interface MCPToolSet {
  tools: ToolDecl[];
  execute: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
}

// ── Connection cache — one persistent process per config ──────────────────────

interface CachedConnection {
  toolSet: MCPToolSet;
  configKey: string;
  lastUsed: number;
}

const connectionCache = new Map<string, CachedConnection>();

// Close stale connections after 10 min of inactivity
setInterval(() => {
  const staleAt = Date.now() - 10 * 60 * 1000;
  for (const [key, cached] of connectionCache) {
    if (cached.lastUsed < staleAt) {
      cached.toolSet.close().catch(() => {});
      connectionCache.delete(key);
    }
  }
}, 60_000).unref();

function configKey(name: string, cfg: MCPServerConfig): string {
  return JSON.stringify({ name, ...cfg });
}

// ── Env / args expansion ──────────────────────────────────────────────────────

function expandVar(v: string): string {
  return v.startsWith("$") ? (process.env[v.slice(1)] ?? v) : v;
}

function expandEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expandVar(v)]));
}

function expandArgs(args: string[]): string[] {
  return args.map(expandVar);
}

// ── Connect a single MCP server ───────────────────────────────────────────────

async function connectMCPServer(name: string, config: MCPServerConfig): Promise<MCPToolSet> {
  const client = new Client({ name: "boost-agent", version: "1.0.0" });

  if (config.url) {
    const transport = new SSEClientTransport(new URL(config.url));
    await client.connect(transport);
  } else if (config.command) {
    const resolvedEnv = config.env ? expandEnv(config.env) : {};

    // Auto-add -y so npx never prompts for install confirmation on a server
    const rawArgs = config.args ?? [];
    const resolvedArgs = expandArgs(
      config.command === "npx" && !rawArgs.includes("-y") ? ["-y", ...rawArgs] : rawArgs
    );

    const transport = new StdioClientTransport({
      command: config.command,
      args: resolvedArgs,
      env: { ...process.env, ...resolvedEnv } as Record<string, string>,
    });

    // First run: allow 90s for npx to download the package
    // Subsequent runs hit the cache and never need to reconnect
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MCP server "${name}" timed out — npx may still be downloading the package`)), 90_000)
      ),
    ]);
  } else {
    throw new Error(`MCP server "${name}" has neither url nor command`);
  }

  const { tools: rawTools } = await client.listTools();

  const tools: ToolDecl[] = rawTools.map((t) => ({
    name: `mcp__${name}__${t.name}`,
    description: `[MCP:${name}] ${t.description ?? t.name}`,
    parameters: {
      properties: Object.fromEntries(
        Object.entries((t.inputSchema as any)?.properties ?? {}).map(([k, v]: [string, any]) => [
          k,
          {
            type: (v.type ?? "string") as any,
            description: v.description ?? k,
            ...(v.items ? { items: { type: v.items.type ?? "string" } } : {}),
          },
        ])
      ),
      required: ((t.inputSchema as any)?.required ?? []) as string[],
    },
  }));

  const execute = async (toolName: string, args: Record<string, unknown>): Promise<string> => {
    const mcpToolName = toolName.replace(`mcp__${name}__`, "");
    const result = await client.callTool({ name: mcpToolName, arguments: args });
    return (result.content as any[])
      .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
      .join("\n");
  };

  const close = () => client.close();
  return { tools, execute, close };
}

// ── Build all MCP tools for a request (uses cache) ───────────────────────────

export async function buildMCPTools(
  servers: Record<string, MCPServerConfig>,
  errors: string[] = []
): Promise<{
  tools: ToolDecl[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
}> {
  const executorMap = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
  const allTools: ToolDecl[] = [];

  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const key = configKey(name, cfg);
      let cached = connectionCache.get(key);

      if (!cached) {
        try {
          const toolSet = await connectMCPServer(name, cfg);
          cached = { toolSet, configKey: key, lastUsed: Date.now() };
          connectionCache.set(key, cached);
        } catch (err) {
          const msg = `MCP server "${name}" failed to connect: ${(err as Error).message}`;
          console.error("[MCP]", msg);
          errors.push(msg);
          return;
        }
      }

      cached.lastUsed = Date.now();

      for (const t of cached.toolSet.tools) {
        allTools.push(t);
        executorMap.set(t.name, (args) => cached!.toolSet.execute(t.name, args));
      }
    })
  );

  // Invalidate cache entries whose config has changed
  for (const [key] of connectionCache) {
    const stillActive = Object.entries(servers).some(([n, c]) => configKey(n, c) === key);
    if (!stillActive) {
      connectionCache.get(key)?.toolSet.close().catch(() => {});
      connectionCache.delete(key);
    }
  }

  const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const fn = executorMap.get(name);
    if (!fn) return `MCP tool "${name}" not found`;
    return fn(args);
  };

  // close() is a no-op now — connections stay alive in cache
  const close = async () => {};

  return { tools: allTools, execute, close };
}
