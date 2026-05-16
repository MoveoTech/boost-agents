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

function expandVar(v: string): string {
  return v.startsWith("$") ? (process.env[v.slice(1)] ?? v) : v;
}

function expandEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expandVar(v)]));
}

function expandArgs(args: string[]): string[] {
  return args.map(expandVar);
}

export async function connectMCPServer(name: string, config: MCPServerConfig): Promise<MCPToolSet> {
  const client = new Client({ name: "boost-agent", version: "1.0.0" });

  if (config.url) {
    const transport = new SSEClientTransport(new URL(config.url));
    await client.connect(transport);
  } else if (config.command) {
    const resolvedEnv = config.env ? expandEnv(config.env) : {};
    // Auto-add -y for npx so it never prompts for install confirmation on a server
    const rawArgs = config.args ?? [];
    const resolvedArgs = expandArgs(
      config.command === "npx" && !rawArgs.includes("-y") ? ["-y", ...rawArgs] : rawArgs
    );

    const transport = new StdioClientTransport({
      command: config.command,
      args: resolvedArgs,
      env: { ...process.env, ...resolvedEnv } as Record<string, string>,
    });

    // Timeout so a hanging npx install doesn't block the whole chat request
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`MCP server "${name}" connection timed out after 30s`)), 30_000)),
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

// Connect all configured MCP servers and merge their tools + executors
export async function buildMCPTools(
  servers: Record<string, MCPServerConfig>
): Promise<{ tools: ToolDecl[]; execute: (name: string, args: Record<string, unknown>) => Promise<string>; close: () => Promise<void> }> {
  const toolSets: MCPToolSet[] = [];
  const executorMap = new Map<string, (args: Record<string, unknown>) => Promise<string>>();

  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      try {
        const ts = await connectMCPServer(name, cfg);
        toolSets.push(ts);
        for (const t of ts.tools) {
          executorMap.set(t.name, (args) => ts.execute(t.name, args));
        }
      } catch (err) {
        console.error(`[MCP] Failed to connect server "${name}":`, (err as Error).message);
      }
    })
  );

  const allTools = toolSets.flatMap((ts) => ts.tools);

  const execute = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const fn = executorMap.get(name);
    if (!fn) return `MCP tool "${name}" not found`;
    return fn(args);
  };

  const close = async () => {
    await Promise.all(toolSets.map((ts) => ts.close().catch(() => {})));
  };

  return { tools: allTools, execute, close };
}
