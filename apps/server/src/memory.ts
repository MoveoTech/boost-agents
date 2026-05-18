const OAUTH_URL = process.env.OAUTH_SERVICE_URL ?? "";
const OAUTH_KEY = process.env.OAUTH_SERVICE_KEY ?? "";
const AGENT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? "";

function auth() { return { headers: { "x-api-key": OAUTH_KEY } }; }
function base(email: string) { return `${OAUTH_URL}/api/memories/${AGENT_ID}/${encodeURIComponent(email)}`; }

export async function memorySave(email: string, key: string, value: string): Promise<string> {
  if (!OAUTH_URL || !OAUTH_KEY) return "Memory not configured (OAUTH_SERVICE_URL not set).";
  const r = await fetch(`${base(email)}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { ...auth().headers, "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!r.ok) throw new Error(`Failed to save memory: ${r.status}`);
  return `Saved memory: "${key}"`;
}

export async function memoryRecall(email: string, key?: string): Promise<string> {
  if (!OAUTH_URL || !OAUTH_KEY) return "Memory not configured.";
  const r = await fetch(key ? `${base(email)}/${encodeURIComponent(key)}` : base(email), auth());
  if (!r.ok) return key ? `No memory found for "${key}".` : "No memories saved yet.";
  const data = await r.json() as { value?: string } | Record<string, string>;
  if (key) return (data as { value?: string }).value ?? `No memory found for "${key}".`;
  const entries = data as Record<string, string>;
  if (!Object.keys(entries).length) return "No memories saved yet.";
  return Object.entries(entries).map(([k, v]) => `• ${k}: ${v}`).join("\n");
}

export async function memoryDelete(email: string, key: string): Promise<string> {
  if (!OAUTH_URL || !OAUTH_KEY) return "Memory not configured.";
  await fetch(`${base(email)}/${encodeURIComponent(key)}`, { method: "DELETE", ...auth() });
  return `Deleted memory: "${key}"`;
}
