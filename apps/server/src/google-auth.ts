const OAUTH_SERVICE_URL = process.env.OAUTH_SERVICE_URL;
const OAUTH_SERVICE_KEY = process.env.OAUTH_SERVICE_KEY;

export async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const { access_token } = await res.json() as { access_token: string };
  return access_token;
}

export async function getUserAccessToken(gmailUser: string): Promise<string | null> {
  if (!OAUTH_SERVICE_URL || !OAUTH_SERVICE_KEY) return null;

  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!agentId) return null;

  const res = await fetch(`${OAUTH_SERVICE_URL}/api/tokens/${agentId}/${gmailUser}`, {
    headers: { "x-api-key": OAUTH_SERVICE_KEY },
  });

  if (!res.ok) return null;
  const { refreshToken } = await res.json() as { refreshToken: string };
  return getAccessToken(refreshToken);
}
