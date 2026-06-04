export interface Skill {
  id: string;
  name: string;
  content: string;
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
    // fields added after initial release — optional so old child configs still compile
    jinaReader?: boolean;
    monday?: boolean;
    googleTasks?: boolean;
    memory?: boolean;
    customTools?: boolean;
  };
  access: {
    chatEnabled: boolean;
    apiEnabled: boolean;
  };
  // Extra OAuth scopes appended to the base scopes for a given service.
  // Example: { gmail: ["https://www.googleapis.com/auth/gmail.modify"] }
  // The scope must be added to the agent's OWN Google OAuth consent screen (not boost-agents-496211).
  // Requires GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET set as repo secrets so the agent uses its own OAuth app.
  extraOAuthScopes?: Partial<Record<"gmail" | "calendar" | "tasks", string[]>>;
  ui: {
    title: string;
    placeholder: string;
    starterPrompts?: string[];
  };
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
    jinaReader: true,
    gmail: false,
    googleCalendar: false,
    slack: true,
    monday: false,
    googleTasks: false,
    memory: true,
    customTools: true,
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
};
