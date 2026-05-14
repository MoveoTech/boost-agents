export interface AgentConfig {
  name: string;
  systemPrompt: string;
  tools: {
    fetchUrl: boolean;
    httpRequest: boolean;
    googleSearch: boolean;
    codeExecution: boolean;
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
  tools: {
    fetchUrl: true,
    httpRequest: true,
    googleSearch: true,
    codeExecution: false,
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
