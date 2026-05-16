export interface Skill {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}

export interface MCPServerConfig {
  command?: string;       // stdio transport: e.g. "npx"
  args?: string[];        // stdio args: e.g. ["-y", "@mondaycom/mcp-server"]
  env?: Record<string, string>; // env vars; "$VAR" expands from process.env
  url?: string;           // SSE/HTTP transport for remote MCP servers
}

export interface CustomTool {
  id: string;
  name: string;
  description: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  bodyTemplate?: string;  // JSON template, {{param}} replaced by agent
  params: Array<{ name: string; description: string; required: boolean }>;
  enabled: boolean;
}

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  model: { provider: "gemini" | "claude" | "openai"; modelId: string };
  skills: Skill[];
  tools: {
    fetchUrl: boolean;
    httpRequest: boolean;
    googleSearch: boolean;
    gmail: boolean;
    googleCalendar: boolean;
    slack: boolean;
  };
  access: {
    chatEnabled: boolean;
    apiEnabled: boolean;
  };
  ui: {
    title: string;
    placeholder: string;
    starterPrompts?: string[];
  };
  mcpServers?: Record<string, MCPServerConfig>;
  customTools?: CustomTool[];
}

export const agentConfig: AgentConfig = {
  name: "Boost Agent",
  systemPrompt: "You are a helpful AI assistant. Be concise, accurate, and friendly.",
  model: { provider: "gemini" as const, modelId: "gemini-2.5-flash" },
  skills: [],
  tools: {
    fetchUrl: true,
    httpRequest: true,
    googleSearch: true,
    gmail: false,
    googleCalendar: false,
    slack: false,
  },
  access: {
    chatEnabled: true,
    apiEnabled: true,
  },
  ui: {
    title: "Boost Agent",
    placeholder: "Ask me anything...",
    starterPrompts: [],
  },
  mcpServers: {},
  customTools: [],
};
