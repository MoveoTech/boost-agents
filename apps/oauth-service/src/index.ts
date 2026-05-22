import express from "express";
import cors from "cors";
import { Firestore } from "@google-cloud/firestore";
import jwt from "jsonwebtoken";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const MONDAY_CLIENT_ID = process.env.MONDAY_CLIENT_ID!;
const MONDAY_CLIENT_SECRET = process.env.MONDAY_CLIENT_SECRET!;
const OAUTH_SERVICE_KEY = process.env.OAUTH_SERVICE_KEY!;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "boost-agents-496211";

const db = new Firestore({ projectId: GCP_PROJECT_ID });

const SERVICE_SCOPES: Record<string, string> = {
  gmail: [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" "),
  calendar: [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" "),
  tasks: [
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" "),
  identity: "openid email profile",
};

function getRedirectUri(req: express.Request): string {
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `https://${host}/auth/google/callback`;
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Identity-only login (no Gmail/Calendar scopes — just email)
// ?agentId=xxx&agentUrl=xxx
app.get("/auth/identity/start", (req, res) => {
  const { agentId, agentUrl } = req.query as { agentId: string; agentUrl: string };
  const state = Buffer.from(JSON.stringify({ agentId, agentUrl, service: "identity" })).toString("base64url");
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(req),
    response_type: "code",
    scope: SERVICE_SCOPES.identity,
    access_type: "online",
    prompt: "select_account",
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Agent redirects user here to start OAuth
// ?agentId=xxx&agentUrl=xxx&service=gmail|calendar
app.get("/auth/google/start", (req, res) => {
  const { agentId, agentUrl, service = "gmail" } = req.query as { agentId: string; agentUrl: string; service?: string };

  if (!SERVICE_SCOPES[service]) {
    res.status(400).send(`Unknown service: ${service}`);
    return;
  }

  const state = Buffer.from(JSON.stringify({ agentId, agentUrl, service })).toString("base64url");

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(req),
    response_type: "code",
    scope: SERVICE_SCOPES[service],
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
    const { agentId, agentUrl, service } = JSON.parse(Buffer.from(state, "base64url").toString());

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

    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const { email } = await userInfoRes.json() as { email: string };

    if (service === "identity") {
      // Issue a short-lived token the agent server will exchange for a session
      const identityToken = jwt.sign({ email, type: "identity" }, OAUTH_SERVICE_KEY, { expiresIn: "5m" });
      const redirect = new URL(agentUrl);
      redirect.searchParams.set("identity_token", identityToken);
      res.redirect(redirect.toString());
      return;
    }

    // Store in service-specific collection
    await db.collection(`${service}_tokens`).doc(agentId).collection("users").doc(email).set({
      refreshToken: tokens.refresh_token,
      email,
      connectedAt: new Date(),
    });

    const redirect = new URL(agentUrl);
    redirect.searchParams.set("google_connected", "true");
    redirect.searchParams.set("google_service", service);
    redirect.searchParams.set("google_email", email);
    res.redirect(redirect.toString());
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("OAuth failed. Please try again.");
  }
});

// Agents call this to get a fresh access token
// GET /api/access-token/:service/:agentId/:userId
app.get("/api/access-token/:service/:agentId/:userId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { service, agentId, userId } = req.params;

  try {
    const doc = await db
      .collection(`${service}_tokens`)
      .doc(agentId)
      .collection("users")
      .doc(userId)
      .get();

    if (!doc.exists) {
      res.status(404).json({ error: "No token found for this user" });
      return;
    }

    const data = doc.data() as { refreshToken?: string; accessToken?: string };

    // Monday stores the access token directly (long-lived, no refresh needed)
    if (data.accessToken) {
      res.json({ accessToken: data.accessToken });
      return;
    }

    // Google services use refresh token flow
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: data.refreshToken!,
        grant_type: "refresh_token",
      }),
    });

    const { access_token, error } = await tokenRes.json() as { access_token?: string; error?: string };
    if (!access_token) {
      res.status(500).json({ error: error ?? "Failed to refresh access token" });
      return;
    }

    res.json({ accessToken: access_token });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Issues a signed API token for a connected user
// GET /api/user-token/:agentId/:service/:userId
app.get("/api/user-token/:agentId/:service/:userId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { agentId, service, userId } = req.params;
  try {
    const doc = await db.collection(`${service}_tokens`).doc(agentId).collection("users").doc(userId).get();
    if (!doc.exists) {
      res.status(404).json({ error: "User not connected" });
      return;
    }
    const token = jwt.sign(
      { email: userId, agentId, service },
      OAUTH_SERVICE_KEY,
      { expiresIn: "90d" }
    );
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Monday OAuth ──────────────────────────────────────────────────────────────

function getMondayRedirectUri(req: express.Request): string {
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `https://${host}/auth/monday/callback`;
}

app.get("/auth/monday/start", (req, res) => {
  const { agentId, agentUrl } = req.query as { agentId: string; agentUrl: string };
  const state = Buffer.from(JSON.stringify({ agentId, agentUrl })).toString("base64url");
  const params = new URLSearchParams({
    client_id: MONDAY_CLIENT_ID,
    redirect_uri: getMondayRedirectUri(req),
    response_type: "code",
    scope: "boards:read boards:write updates:read updates:write me:read users:read teams:read",
    state,
  });
  res.redirect(`https://auth.monday.com/oauth2/authorize?${params}`);
});

app.get("/auth/monday/callback", async (req, res) => {
  const { code, state } = req.query as { code: string; state: string };
  try {
    const { agentId, agentUrl } = JSON.parse(Buffer.from(state, "base64url").toString());

    const tokenRes = await fetch("https://auth.monday.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: MONDAY_CLIENT_ID,
        client_secret: MONDAY_CLIENT_SECRET,
        redirect_uri: getMondayRedirectUri(req),
        grant_type: "authorization_code",
      }),
    });
    const { access_token } = await tokenRes.json() as { access_token: string };

    // Get the user's email from Monday API
    const meRes = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access_token}` },
      body: JSON.stringify({ query: "{ me { email } }" }),
    });
    const { data } = await meRes.json() as { data: { me: { email: string } } };
    const email = data.me.email;

    // Store access token directly (Monday tokens are long-lived, no refresh needed)
    await db.collection("monday_tokens").doc(agentId).collection("users").doc(email).set({
      accessToken: access_token,
      email,
      connectedAt: new Date(),
    });

    const redirect = new URL(agentUrl);
    redirect.searchParams.set("monday_connected", "true");
    redirect.searchParams.set("monday_email", email);
    res.redirect(redirect.toString());
  } catch (err) {
    console.error("Monday OAuth callback error:", err);
    res.status(500).send("Monday OAuth failed. Please try again.");
  }
});

// Per-user settings (model preference, personal instructions, avatar)
app.get("/api/user-settings/:agentId/:userId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, userId } = req.params;
  try {
    const doc = await db.collection("user_settings").doc(agentId).collection("users").doc(userId).get();
    res.json(doc.exists ? doc.data() : {});
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.put("/api/user-settings/:agentId/:userId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, userId } = req.params;
  try {
    await db.collection("user_settings").doc(agentId).collection("users").doc(userId).set(req.body, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Chat history ─────────────────────────────────────────────────────────────

function chatRef(agentId: string, email: string) {
  return db.collection("chats").doc(agentId).collection("users").doc(email).collection("sessions");
}

app.get("/api/chats/:agentId/:email", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, email } = req.params;
  try {
    const snap = await chatRef(agentId, email).orderBy("updatedAt", "desc").limit(50).get();
    const sessions = snap.docs.map(d => {
      const data = d.data();
      return { id: d.id, title: data.title, updatedAt: data.updatedAt?.toDate?.() ?? data.updatedAt, messageCount: (data.messages ?? []).length };
    });
    res.json({ sessions });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.post("/api/chats/:agentId/:email", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, email } = req.params;
  const { title = "New Chat" } = req.body as { title?: string };
  try {
    const ref = chatRef(agentId, email).doc();
    await ref.set({ id: ref.id, title, messages: [], createdAt: new Date(), updatedAt: new Date() });
    res.json({ id: ref.id });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get("/api/chats/:agentId/:email/:sessionId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, email, sessionId } = req.params;
  try {
    const doc = await chatRef(agentId, email).doc(sessionId).get();
    if (!doc.exists) { res.status(404).json({ error: "Not found" }); return; }
    res.json(doc.data());
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.put("/api/chats/:agentId/:email/:sessionId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, email, sessionId } = req.params;
  try {
    await chatRef(agentId, email).doc(sessionId).set({ ...req.body, updatedAt: new Date() }, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.delete("/api/chats/:agentId/:email/:sessionId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, email, sessionId } = req.params;
  try {
    await chatRef(agentId, email).doc(sessionId).delete();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// Disconnects a user from a service
app.delete("/api/users/:agentId/:service/:userId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { agentId, service, userId } = req.params;
  try {
    await db.collection(`${service}_tokens`).doc(agentId).collection("users").doc(userId).delete();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Returns all users connected for any service in this agent
app.get("/api/users/:agentId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { agentId } = req.params;
  try {
    const services = ["gmail", "calendar", "monday", "tasks"] as const;
    const userMap: Record<string, { gmail: boolean; calendar: boolean; monday: boolean; tasks: boolean }> = {};
    for (const service of services) {
      const snapshot = await db.collection(`${service}_tokens`).doc(agentId).collection("users").get();
      snapshot.forEach((doc) => {
        if (!userMap[doc.id]) userMap[doc.id] = { gmail: false, calendar: false, monday: false, tasks: false };
        userMap[doc.id][service] = true;
      });
    }
    res.json({ users: Object.entries(userMap).map(([email, s]) => ({ email, ...s })) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Persistent memory ─────────────────────────────────────────────────────────

function memRef(agentId: string, email: string) {
  return db.collection("memories").doc(agentId).collection("users").doc(email);
}

app.get("/api/memories/:agentId/:userId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, userId } = req.params;
  try {
    const doc = await memRef(agentId, userId).get();
    res.json(doc.exists ? (doc.data() ?? {}) : {});
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get("/api/memories/:agentId/:userId/:key", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, userId, key } = req.params;
  try {
    const doc = await memRef(agentId, userId).get();
    const value = doc.data()?.[key];
    if (value === undefined) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ value });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.put("/api/memories/:agentId/:userId/:key", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, userId, key } = req.params;
  const { value } = req.body as { value: string };
  try {
    await memRef(agentId, userId).set({ [key]: value }, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.delete("/api/memories/:agentId/:userId/:key", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, userId, key } = req.params;
  try {
    const { FieldValue } = await import("@google-cloud/firestore");
    await memRef(agentId, userId).update({ [key]: FieldValue.delete() });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── WhatsApp Credentials ──────────────────────────────────────────────────────

function waRef(agentId: string, userId: string) {
  return db.collection("whatsapp").doc(agentId).collection("sessions").doc(userId);
}

app.get("/api/whatsapp/:agentId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId } = req.params;
  try {
    const snap = await db.collection("whatsapp").doc(agentId).collection("sessions").get();
    res.json({ users: snap.docs.map((d) => d.id) });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get("/api/whatsapp/:agentId/:userId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, userId } = req.params;
  try {
    const snap = await waRef(agentId, userId).get();
    if (!snap.exists) { res.json(null); return; }
    res.json(snap.data());
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.put("/api/whatsapp/:agentId/:userId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, userId } = req.params;
  const { creds, keys } = req.body as { creds: string; keys: string };
  try {
    await waRef(agentId, userId).set({ creds, keys, updatedAt: new Date().toISOString() }, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.patch("/api/whatsapp/:agentId/:userId/config", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, userId } = req.params;
  const { config } = req.body as { config: string };
  try {
    await waRef(agentId, userId).set({ config, updatedAt: new Date().toISOString() }, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.delete("/api/whatsapp/:agentId/:userId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId, userId } = req.params;
  try {
    // Preserve config settings — only wipe session credentials
    const snap = await waRef(agentId, userId).get();
    const config = snap.data()?.config;
    if (config) {
      await waRef(agentId, userId).set({ config, updatedAt: new Date().toISOString() });
    } else {
      await waRef(agentId, userId).delete();
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Feedback ──────────────────────────────────────────────────────────────────

function feedbackRef(agentId: string) {
  return db.collection("feedback").doc(agentId).collection("entries");
}

app.post("/api/feedback/:agentId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId } = req.params;
  const { messageId, userEmail, rating, userMessage, agentResponse, model } = req.body as {
    messageId: string; userEmail: string; rating: number;
    userMessage?: string; agentResponse?: string; model?: string;
  };
  if (!messageId) { res.status(400).json({ error: "messageId required" }); return; }
  try {
    await feedbackRef(agentId).doc(messageId).set({
      messageId, userEmail, rating,
      userMessage: userMessage ?? null,
      agentResponse: agentResponse ?? null,
      model: model ?? null,
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get("/api/feedback/:agentId", async (req, res) => {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { agentId } = req.params;
  const { rating } = req.query;
  try {
    let query: FirebaseFirestore.Query = feedbackRef(agentId).orderBy("timestamp", "desc").limit(200);
    if (rating !== undefined) query = query.where("rating", "==", Number(rating));
    const snap = await query.get();
    res.json(snap.docs.map((d) => d.data()));
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

const PORT = process.env.PORT ?? 8080;
app.listen(PORT, () => console.log(`OAuth service running on :${PORT}`));
