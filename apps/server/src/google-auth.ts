const OAUTH_SERVICE_URL = process.env.OAUTH_SERVICE_URL;
const OAUTH_SERVICE_KEY = process.env.OAUTH_SERVICE_KEY;

export async function getUserAccessToken(gmailUser: string): Promise<string | null> {
  if (!OAUTH_SERVICE_URL || !OAUTH_SERVICE_KEY) return null;

  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!agentId) return null;

  const res = await fetch(`${OAUTH_SERVICE_URL}/api/access-token/${agentId}/${gmailUser}`, {
    headers: { "x-api-key": OAUTH_SERVICE_KEY },
  });

  if (!res.ok) return null;
  const { accessToken } = await res.json() as { accessToken: string };
  return accessToken;
}
