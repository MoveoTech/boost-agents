export interface DisplayMessage {
  id: string;
  role: "user" | "model";
  text: string;
  toolUses?: ToolUse[];
  pending?: boolean;
  feedback?: 1 | -1;
  attachment?: { name: string; mimeType: string; preview?: string };
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

export interface AutomationStep {
  id: string;
  tool: string;
  instruction: string;
  httpUrl?: string;
  httpMethod?: string;
}

export interface RunHistoryEntry {
  runAt: string;
  status: "success" | "partial" | "error";
  durationMs: number;
  steps: Array<{ id: string; tool: string; output: string; error?: string; durationMs: number; conditionFailed?: boolean }>;
}

export interface Automation {
  id: string;
  name: string;
  schedule: string;
  steps: AutomationStep[];
  enabled: boolean;
  createdBy?: string;
  oneTime?: boolean;
  runHistory?: RunHistoryEntry[];
  notifyOnFailure?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface UserSettings {
  model?: { provider: "gemini" | "claude" | "openai"; modelId: string };
  systemPrompt?: string;
  avatar?: string;
  apolloApiKey?: string;
  googleMapsApiKey?: string;
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
    slack: boolean;
    monday: boolean;
    googleTasks: boolean;
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
  skills: Skill[];
}

export interface FlowStepResult {
  id: string;
  tool: string;
  output: string;
  error?: string;
  durationMs: number;
  conditionFailed?: boolean;
}

export interface AnalyticsDayStat {
  date: string;
  messages: number;
  toolCalls: number;
  avgResponseMs: number;
}

export interface AnalyticsData {
  days: AnalyticsDayStat[];
  topTools: Array<{ name: string; count: number }>;
  models: Array<{ name: string; count: number }>;
  totalMessages: number;
  positiveFeedback: number;
  negativeFeedback: number;
}
