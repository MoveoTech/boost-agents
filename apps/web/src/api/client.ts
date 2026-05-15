import type { ChatResponse, HistoryItem, AgentConfig, Automation } from "../types";

const BASE = import.meta.env.VITE_API_URL ?? "";

// All requests rely on the HttpOnly session cookie set by the server.
// No tokens are stored client-side — the browser sends the cookie automatically.

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
  // Server sets HttpOnly cookie in the response — no client-side storage needed
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

export async function getProviders(): Promise<{ gemini: boolean; claude: boolean; openai: boolean }> {
  const res = await fetch(`${BASE}/api/providers`);
  return res.ok ? res.json() : { gemini: true, claude: false, openai: false };
}

export async function fetchGoogleToken(email: string, service: "gmail" | "calendar"): Promise<string | null> {
  const res = await fetch(`${BASE}/api/google-token?email=${encodeURIComponent(email)}&service=${service}`);
  if (!res.ok) return null;
  const { token } = await res.json();
  return token;
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

export async function sendMessage(
  message: string,
  history: HistoryItem[],
  mode: "search" | "tools" = "tools",
  systemPrompt?: string,
  gmailToken?: string,
  calendarToken?: string,
  model?: { provider: string; modelId: string },
): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history, mode, systemPrompt, gmailToken, calendarToken, model }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}
