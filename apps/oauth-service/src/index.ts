import express from "express";
import cors from "cors";
import { Firestore } from "@google-cloud/firestore";

const app = express();
app.use(cors());
app.use(express.json());

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const OAUTH_SERVICE_KEY = process.env.OAUTH_SERVICE_KEY!;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "boost-agents-496211";

const db = new Firestore({ projectId: GCP_PROJECT_ID });

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function getRedirectUri(req: express.Request): string {
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `https://${host}/auth/google/callback`;
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Agent redirects user here to start OAuth
app.get("/auth/google/start", (req, res) => {
  const { agentId, agentUrl } = req.query as { agentId: string; agentUrl: string };

  const state = Buffer.from(JSON.stringify({ agentId, agentUrl })).toString("base64url");

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(req),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Google redirects here after user approves
app.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query as { code: string; state: string };

  try {
    const { agentId, agentUrl } = JSON.parse(Buffer.from(state, "base64url").toString());

    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: getRedirectUri(req),
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json() as { access_token: string; refresh_token: string };

    // Get user's email
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const { email } = await userInfoRes.json() as { email: string };

    // Store refresh token in Firestore keyed by agentId + email
    await db.collection("tokens").doc(agentId).collection("users").doc(email).set({
      refreshToken: tokens.refresh_token,
      email,
      connectedAt: new Date(),
    });

    // Redirect back to the agent with the connected email
    const redirect = new URL(agentUrl);
    redirect.searchParams.set("gmail_connected", "true");
    redirect.searchParams.set("gmail_email", email);
    res.redirect(redirect.toString());
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("OAuth failed. Please try again.");
  }
});

// Agents call this to retrieve a user's refresh token
app.get("/api/tokens/:agentId/:userId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { agentId, userId } = req.params;

  try {
    const doc = await db
      .collection("tokens")
      .doc(agentId)
      .collection("users")
      .doc(userId)
      .get();

    if (!doc.exists) {
      res.status(404).json({ error: "No token found for this user" });
      return;
    }

    res.json(doc.data());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const PORT = process.env.PORT ?? 8080;
app.listen(PORT, () => console.log(`OAuth service running on :${PORT}`));
