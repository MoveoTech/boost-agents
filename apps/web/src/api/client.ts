import type { ChatResponse, HistoryItem, AgentConfig, Automation, AutomationStep, ChatSession, DisplayMessage, AnalyticsData, FlowStepResult } from "../types";

const BASE = import.meta.env.VITE_API_URL ?? "";

export async function whoami(): Promise<{ isAdmin: boolean; email: string | null; authenticated: boolean; canCreateAgents: boolean }> {
  const res = await fetch(`${BASE}/api/whoami`);
  return res.ok ? res.json() : { isAdmin: false, email: null, authenticated: false, canCreateAgents: false };
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

export async function createAgent(params: {
  agentName: string; geminiApiKey: string; adminEmails?: string;
  oauthEmails?: string; anthropicApiKey?: string; openaiApiKey?: string;
}): Promise<{ actionsUrl: string; repoName: string; createRunId?: number }> {
  const res = await fetch(`${BASE}/api/admin/create-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function retryDeploy(repoName: string): Promise<{ ok: boolean; runId?: number; error?: string }> {
  const res = await fetch(`${BASE}/api/admin/retry-deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoName }),
  });
  const data = await res.json().catch(() => ({ error: "Request failed" }));
  return res.ok ? { ok: true, ...data } : { ok: false, error: data.error };
}

export async function getCreateWorkflowStatus(runId: number): Promise<{
  phase: "pending" | "running" | "done" | "failed";
  repoCreated?: boolean;
  secretsSet?: boolean;
  deployTriggered?: boolean;
}> {
  const res = await fetch(`${BASE}/api/admin/create-workflow-status?runId=${runId}`);
  return res.ok ? res.json() : { phase: "pending" };
}

export async function getAgentStatus(repoName: string): Promise<{ status: "pending" | "in_progress" | "success" | "failed"; runUrl?: string; agentUrl?: string }> {
  const res = await fetch(`${BASE}/api/admin/agent-status?repoName=${encodeURIComponent(repoName)}`);
  return res.ok ? res.json() : { status: "pending" };
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

export type WhatsAppStatus = "connected" | "disconnected" | "connecting" | "qr";

export async function getConnections(): Promise<{ gmail: boolean; calendar: boolean; monday: boolean; tasks: boolean; whatsapp: boolean; whatsappStatus: WhatsAppStatus; whatsappOwners: string[] }> {
  const res = await fetch(`${BASE}/api/connections`);
  return res.ok ? res.json() : { gmail: false, calendar: false, monday: false, tasks: false, whatsapp: false, whatsappStatus: "disconnected", whatsappOwners: [] };
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
  ownerOnly?: boolean;
  customPrompt?: string;
  model?: { provider: "gemini" | "claude" | "openai"; modelId: string };
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
  let resolved = false;
  es.onmessage = (e) => {
    const data = JSON.parse(e.data) as { type: string; qr?: string; message?: string };
    if (data.type === "qr" && data.qr) onQR(data.qr);
    else if (data.type === "connected") { resolved = true; onConnected(); es.close(); }
    else if (data.type === "timeout" || data.type === "error") { resolved = true; onError(data.message ?? "Timed out"); es.close(); }
  };
  es.onerror = () => {
    es.close();
    if (resolved) return;
    // Server closes the SSE stream after sending "connected" — the onerror may fire
    // before or after onmessage. Check actual status before reporting an error.
    fetch(`${BASE}/api/whatsapp/status`)
      .then((r) => r.json())
      .then(({ status }: { status: string }) => {
        if (status === "connected") { resolved = true; onConnected(); }
        else if (!resolved) onError("Connection lost");
      })
      .catch(() => { if (!resolved) onError("Connection lost"); });
  };
  return () => es.close();
}

export async function triggerAutomation(id: string): Promise<void> {
  await fetch(`${BASE}/api/automations/${id}/run`, { method: "POST" });
}

export async function runFlowDirect(id: string): Promise<{ stepResults: FlowStepResult[] }> {
  const res = await fetch(`${BASE}/api/flows/${id}/run-direct`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Run failed" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function generateFlow(
  description: string,
  connectedTools: string[],
): Promise<{ suggestedName: string; suggestedSchedule: string; steps: AutomationStep[] }> {
  const res = await fetch(`${BASE}/api/flows/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description, connectedTools }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Generation failed" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export type FlowStepEvent =
  | { type: "start"; stepId: string; tool: string }
  | { type: "done"; id: string; tool: string; output: string; error?: string; durationMs: number; conditionFailed?: boolean }
  | { type: "error"; error: string };

export async function* runFlowSteps(steps: AutomationStep[], priorResults?: FlowStepResult[]): AsyncGenerator<FlowStepEvent> {
  const res = await fetch(`${BASE}/api/flows/run-steps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ steps, priorResults }),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({ error: "Run failed" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
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
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") return;
      try { yield JSON.parse(raw) as FlowStepEvent; } catch { /* skip malformed */ }
    }
  }
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

export interface AgentRecord {
  repoName: string;
  agentId: string;
  adminEmails: string;
  createdBy: string;
  createdAt: string;
  status: "active" | "deleted";
  deletedAt?: string;
  agentUrl?: string;
}

export interface AgentConnections {
  gmail: string[];
  calendar: string[];
  tasks: string[];
  monday: string[];
  whatsapp: string[];
}

export async function listAgents(): Promise<AgentRecord[]> {
  const res = await fetch(`${BASE}/api/superadmin/agents`);
  return res.ok ? res.json() : [];
}

export async function getAgentConnections(repoName: string): Promise<AgentConnections> {
  const res = await fetch(`${BASE}/api/superadmin/agents/${encodeURIComponent(repoName)}/connections`);
  return res.ok ? res.json() : { gmail: [], calendar: [], tasks: [], monday: [], whatsapp: [] };
}

export async function getAgentConfig(repoName: string): Promise<{ config: AgentConfig } | { error: string }> {
  const res = await fetch(`${BASE}/api/superadmin/agents/${encodeURIComponent(repoName)}/config`);
  if (res.ok) return { config: await res.json() };
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return { error: data.error ?? `HTTP ${res.status}` };
}

export async function updateAgentConfig(repoName: string, config: AgentConfig): Promise<{ ok: boolean; runId?: number; error?: string }> {
  const res = await fetch(`${BASE}/api/superadmin/agents/${encodeURIComponent(repoName)}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const data = await res.json().catch(() => ({ error: "Request failed" }));
  return res.ok ? { ok: true, ...data } : { ok: false, error: data.error };
}

export async function deleteAgent(repoName: string): Promise<{ ok: boolean; errors?: string[] }> {
  const res = await fetch(`${BASE}/api/superadmin/agents/${encodeURIComponent(repoName)}`, { method: "DELETE" });
  return res.json().catch(() => ({ ok: false, errors: ["Request failed"] }));
}

export async function disconnectAgentConnection(repoName: string, service: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(
    `${BASE}/api/superadmin/agents/${encodeURIComponent(repoName)}/connections/${service}/${encodeURIComponent(userId)}`,
    { method: "DELETE" }
  );
  const data = await res.json().catch(() => ({ error: "Request failed" }));
  return res.ok ? { ok: true } : { ok: false, error: data.error };
}

export async function importContacts(vcf: string): Promise<{ imported: number; contacts: { name: string; phone: string }[] }> {
  const res = await fetch(`${BASE}/api/contacts/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vcf }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Import failed" }));
    throw new Error(err.error ?? "Import failed");
  }
  return res.json();
}

export async function listContacts(): Promise<{ name: string; phone: string }[]> {
  const res = await fetch(`${BASE}/api/contacts`);
  if (!res.ok) return [];
  const { contacts } = await res.json();
  return contacts ?? [];
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
