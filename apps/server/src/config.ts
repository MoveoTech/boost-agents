export interface Skill {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  skills: Skill[];
  tools: {
    fetchUrl: boolean;
    httpRequest: boolean;
    googleSearch: boolean;
    gmail: boolean;
    googleCalendar: boolean;
  };
  access: {
    chatEnabled: boolean;
    apiEnabled: boolean;
  };
  ui: {
    title: string;
    placeholder: string;
  };
}

export const agentConfig: AgentConfig = {
  name: "Boost Agent",
  systemPrompt: "You are a helpful AI assistant. Be concise, accurate, and friendly.",
  skills: [],
  tools: {
    fetchUrl: true,
    httpRequest: true,
    googleSearch: true,
    gmail: false,
    googleCalendar: false,
  },
  access: {
    chatEnabled: true,
    apiEnabled: true,
  },
  ui: {
    title: "Boost Agent",
    placeholder: "Ask me anything...",
  },
};
