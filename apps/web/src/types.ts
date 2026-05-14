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
