const OAUTH_SERVICE_URL = process.env.OAUTH_SERVICE_URL;
const OAUTH_SERVICE_KEY = process.env.OAUTH_SERVICE_KEY;

// Cache tokens for 3 minutes — OAuth access tokens are valid for 1 hour,
// so reusing them across multiple tool calls in the same agent response is safe.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_CACHE_TTL = 3 * 60 * 1000;

export async function getUserAccessToken(service: "gmail" | "calendar" | "monday" | "tasks", userEmail: string): Promise<string | null> {
  // Local dev override: skip the oauth-service and use a Monday token straight from env.
  // Set MONDAY_TOKEN in .env to test Monday locally without a connected account.
  if (service === "monday" && process.env.MONDAY_TOKEN) return process.env.MONDAY_TOKEN;

  if (!OAUTH_SERVICE_URL || !OAUTH_SERVICE_KEY) return null;

  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!agentId) return null;

  const cacheKey = `${service}:${agentId}:${userEmail}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${OAUTH_SERVICE_URL}/api/access-token/${service}/${agentId}/${userEmail}`, {
      headers: { "x-api-key": OAUTH_SERVICE_KEY },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const { accessToken } = await res.json() as { accessToken: string };
    tokenCache.set(cacheKey, { token: accessToken, expiresAt: Date.now() + TOKEN_CACHE_TTL });
    return accessToken;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
