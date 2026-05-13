import type { ChatResponse, HistoryItem } from "../types";

// In dev, VITE_API_URL is unset and Vite proxies /api → localhost:8080.
// In production the CI passes the server's Cloud Run URL as a build arg.
const BASE = import.meta.env.VITE_API_URL ?? "";

export async function sendMessage(
  message: string,
  history: HistoryItem[]
): Promise<ChatResponse> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  return res.json();
}
