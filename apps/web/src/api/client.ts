import type { ChatResponse, HistoryItem, AgentConfig, Mode } from "../types";

const BASE = import.meta.env.VITE_API_URL ?? "";
const TOKEN_KEY = "auth_token";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function whoami(): Promise<{ isAdmin: boolean }> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/whoami`, { headers });
  return res.ok ? res.json() : { isAdmin: false };
}

export async function getApiKey(): Promise<string> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/admin/key`, { headers });
  if (!res.ok) return "";
  const { apiKey } = await res.json();
  return apiKey;
}

export async function login(password: string): Promise<{ isAdmin: boolean }> {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (!res.ok) throw new Error("Invalid password");

  const { token, isAdmin } = await res.json();
  if (token) saveToken(token);
  return { isAdmin: !!isAdmin };
}

export async function getConfig(): Promise<AgentConfig> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/config`, { headers });
  if (!res.ok) throw new Error("Failed to load config");
  return res.json();
}

export async function saveConfig(config: AgentConfig): Promise<{ commitUrl: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/configure`, {
    method: "POST",
    headers,
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
  mode: Mode = "tools",
  systemPrompt?: string,
  gmailUser?: string
): Promise<ChatResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, history, mode, systemPrompt, gmailUser }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  return res.json();
}
