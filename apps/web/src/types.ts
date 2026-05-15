export interface DisplayMessage {
  id: string;
  role: "user" | "model";
  text: string;
  toolUses?: ToolUse[];
  pending?: boolean;
}

export interface ToolUse {
  name: string;
  input?: string;
  output?: string;
}

export interface HistoryItem {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}


export interface ChatResponse {
  reply: string;
  toolUses: ToolUse[];
  error?: string;
}

export interface Skill {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}

export interface Automation {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdBy?: string;
}

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  model: { provider: "gemini" | "claude" | "openai"; modelId: string };
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
  skills: Skill[];
}
