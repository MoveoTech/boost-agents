import type { ChatResponse, HistoryItem, AgentConfig, Automation, ChatSession, DisplayMessage, AnalyticsData } from "../types";

const BASE = import.meta.env.VITE_API_URL ?? "";

export async function whoami(): Promise<{ isAdmin: boolean; email: string | null; authenticated: boolean }> {
  const res = await fetch(`${BASE}/api/whoami`);
  return res.ok ? res.json() : { isAdmin: false, email: null, authenticated: false };
}

export async function identityComplete(identityToken: string): Promise<{ isAdmin: boolean; email: string }> {
  const res = await fetch(`${BASE}/api/auth/identity/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identityToken }),
  });
  if (!res.ok) throw new Error("Identity verification failed");
  const { isAdmin, email } = await res.json();
  return { isAdmin: !!isAdmin, email };
}

export async function getApiKey(): Promise<string> {
  const res = await fetch(`${BASE}/api/admin/key`);
  if (!res.ok) return "";
  const { apiKey } = await res.json();
  return apiKey;
}

export async function listAutomations(): Promise<Automation[]> {
  const res = await fetch(`${BASE}/api/automations`);
  return res.ok ? res.json() : [];
}

export async function saveAutomation(automation: Automation): Promise<void> {
  await fetch(`${BASE}/api/automations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ automation, agentUrl: BASE || window.location.origin }),
  });
}

export async function getProviders(): Promise<{ gemini: boolean; claude: boolean; openai: boolean; slack: boolean }> {
  const res = await fetch(`${BASE}/api/providers`);
  return res.ok ? res.json() : { gemini: true, claude: false, openai: false, slack: false };
}

export async function listChats(): Promise<ChatSession[]> {
  const res = await fetch(`${BASE}/api/chats`);
  const data = res.ok ? await res.json() : { sessions: [] };
  return data.sessions ?? [];
}

export async function createChat(title: string): Promise<string> {
  const res = await fetch(`${BASE}/api/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const { id } = await res.json();
  return id;
}

export async function loadChat(id: string): Promise<{ messages: DisplayMessage[] } | null> {
  const res = await fetch(`${BASE}/api/chats/${id}`);
  if (!res.ok) return null;
  return res.json();
}

export async function saveChat(id: string, messages: DisplayMessage[], title?: string): Promise<void> {
  const stored = messages
    .filter((m) => !m.pending)
    .map(({ id: mid, role, text, toolUses }) => ({ id: mid, role, text, toolUses }));
  await fetch(`${BASE}/api/chats/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: stored, ...(title ? { title } : {}) }),
  });
}

export async function deleteChat(id: string): Promise<void> {
  await fetch(`${BASE}/api/chats/${id}`, { method: "DELETE" });
}

export async function getUserSettings(): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/api/user-settings`);
  return res.ok ? res.json() : {};
}

export async function saveUserSettings(settings: Record<string, unknown>): Promise<void> {
  await fetch(`${BASE}/api/user-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
}

export async function getConnections(): Promise<{ gmail: boolean; calendar: boolean; monday: boolean; tasks: boolean; whatsapp: boolean }> {
  const res = await fetch(`${BASE}/api/connections`);
  return res.ok ? res.json() : { gmail: false, calendar: false, monday: false, tasks: false, whatsapp: false };
}

export async function disconnectService(service: "gmail" | "calendar" | "monday" | "tasks"): Promise<void> {
  await fetch(`${BASE}/api/connections/${service}`, { method: "DELETE" });
}

export async function getWhatsAppStatus(): Promise<"connected" | "disconnected" | "connecting" | "qr"> {
  const res = await fetch(`${BASE}/api/whatsapp/status`);
  return res.ok ? (await res.json()).status : "disconnected";
}

export async function disconnectWhatsApp(): Promise<void> {
  await fetch(`${BASE}/api/whatsapp`, { method: "DELETE" });
}

export interface WhatsAppConfig {
  replyTrigger: "mention" | "keyword" | "always";
  keyword?: string;
  replyInGroups: boolean;
  replyInDMs: boolean;
  customPrompt?: string;
}

export async function getWhatsAppConfig(): Promise<WhatsAppConfig> {
  const res = await fetch(`${BASE}/api/whatsapp/config`);
  return res.ok ? res.json() : { replyTrigger: "mention", replyInGroups: true, replyInDMs: false };
}

export async function saveWhatsAppConfig(config: WhatsAppConfig): Promise<void> {
  await fetch(`${BASE}/api/whatsapp/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

export function subscribeWhatsAppQR(
  onQR: (dataUrl: string) => void,
  onConnected: () => void,
  onError: (msg: string) => void,
): () => void {
  const es = new EventSource(`${BASE}/api/whatsapp/qr`);
  es.onmessage = (e) => {
    const data = JSON.parse(e.data) as { type: string; qr?: string; message?: string };
    if (data.type === "qr" && data.qr) onQR(data.qr);
    else if (data.type === "connected") { onConnected(); es.close(); }
    else if (data.type === "timeout" || data.type === "error") { onError(data.message ?? "Timed out"); es.close(); }
  };
  es.onerror = () => { onError("Connection lost"); es.close(); };
  return () => es.close();
}

export async function triggerAutomation(id: string): Promise<void> {
  await fetch(`${BASE}/api/automations/${id}/run`, { method: "POST" });
}

export async function removeAutomation(id: string): Promise<void> {
  await fetch(`${BASE}/api/automations/${id}`, { method: "DELETE" });
}

export async function getConfig(): Promise<AgentConfig> {
  const res = await fetch(`${BASE}/api/config`);
  if (!res.ok) throw new Error("Failed to load config");
  return res.json();
}

export async function applyConfigLive(patch: Partial<AgentConfig>): Promise<void> {
  await fetch(`${BASE}/api/config/live`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function saveConfig(config: AgentConfig): Promise<{ commitUrl: string }> {
  const res = await fetch(`${BASE}/api/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function submitFeedback(
  messageId: string,
  rating: 1 | -1,
  context?: { userMessage?: string; agentResponse?: string },
): Promise<void> {
  await fetch(`${BASE}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId, rating, ...context }),
  });
}

export async function getAnalytics(): Promise<AnalyticsData> {
  const res = await fetch(`${BASE}/api/analytics`);
  if (!res.ok) throw new Error("Failed to load analytics");
  return res.json();
}

export async function sendMessage(
  message: string,
  history: HistoryItem[],
  mode: "search" | "tools" = "tools",
  systemPrompt?: string,
  model?: { provider: string; modelId: string },
  attachment?: { data: string; mimeType: string; name: string },
): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history, mode, systemPrompt, model, attachment }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export type StreamEvent =
  | { type: "token"; content: string }
  | { type: "tool_start"; tool: { name: string; input: string } }
  | { type: "tool_complete"; tool: { name: string; output: string } }
  | { type: "done"; toolUses: Array<{ name: string; input: string; output: string }> }
  | { type: "error"; message: string };

export async function* streamMessage(
  message: string,
  history: HistoryItem[],
  mode: "search" | "tools" = "tools",
  systemPrompt?: string,
  model?: { provider: string; modelId: string },
  attachment?: { data: string; mimeType: string; name: string },
): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history, mode, systemPrompt, model, attachment, stream: true }),
  });
  if (!res.ok || !res.body) {
    throw new Error("Stream request failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6);
      if (raw === "[DONE]") return;
      try { yield JSON.parse(raw) as StreamEvent; } catch { /* skip malformed */ }
    }
  }
}
