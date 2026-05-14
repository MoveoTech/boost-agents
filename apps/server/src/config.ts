export interface AgentConfig {
  name: string;
  systemPrompt: string;
  tools: {
    fetchUrl: boolean;
    httpRequest: boolean;
    googleSearch: boolean;
    codeExecution: boolean;
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
    codeExecution: true,
  },
  ui: {
    title: "Boost Agent",
    placeholder: "Ask me anything...",
  },
};
