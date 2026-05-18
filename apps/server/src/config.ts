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
