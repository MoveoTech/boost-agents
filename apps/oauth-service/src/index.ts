import express from "express";
import cors from "cors";
import { Firestore } from "@google-cloud/firestore";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";

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

// ── Per-agent key auth ────────────────────────────────────────────────────────
// Each deployed agent has a unique key scoped to its own agentId.
// The master OAUTH_SERVICE_KEY (org secret, never given to clients) bypasses the
// scope check so CI/CD and the oauth-service itself retain unrestricted access.

const agentKeyCache = new Map<string, { agentId: string; ts: number }>();
const AGENT_KEY_CACHE_TTL = 5 * 60_000; // 5 minutes

async function verifyAgentKey(req: express.Request, res: express.Response, agentId: string): Promise<boolean> {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey) { res.status(401).json({ error: "Unauthorized" }); return false; }
  // Master key — unrestricted
  if (apiKey === OAUTH_SERVICE_KEY) return true;
  // Per-agent key — check cache first, then Firestore
  const cached = agentKeyCache.get(apiKey);
  if (cached && Date.now() - cached.ts < AGENT_KEY_CACHE_TTL) {
    if (cached.agentId !== agentId) { res.status(403).json({ error: "Forbidden" }); return false; }
    return true;
  }
  const snap = await db.collection("agent_keys").where("apiKey", "==", apiKey).limit(1).get();
  if (snap.empty) { res.status(401).json({ error: "Unauthorized" }); return false; }
  const keyAgentId = snap.docs[0].data().agentId as string;
  agentKeyCache.set(apiKey, { agentId: keyAgentId, ts: Date.now() });
  if (keyAgentId !== agentId) { res.status(403).json({ error: "Forbidden" }); return false; }
  return true;
}

// Per-agent Google OAuth credentials — looked up by agentId, fall back to master.
// Agents with restricted scopes bring their own OAuth app so the master consent screen
// stays clean and doesn't need restricted-scope verification.
const googleCredsCache = new Map<string, { clientId: string; clientSecret: string; ts: number }>();
const GOOGLE_CREDS_CACHE_TTL = 10 * 60_000;

async function getGoogleCreds(agentId: string): Promise<{ clientId: string; clientSecret: string }> {
  const cached = googleCredsCache.get(agentId);
  if (cached && Date.now() - cached.ts < GOOGLE_CREDS_CACHE_TTL) return cached;
  try {
    const snap = await db.collection("agent_oauth_creds").doc(agentId).get();
    if (snap.exists) {
      const { clientId, clientSecret } = snap.data() as { clientId: string; clientSecret: string };
      if (clientId && clientSecret) {
        const creds = { clientId, clientSecret, ts: Date.now() };
        googleCredsCache.set(agentId, creds);
        return creds;
      }
    }
  } catch { /* fall through to master */ }
  return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET };
}

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
  const { agentId, agentUrl, phone } = req.query as { agentId: string; agentUrl: string; phone?: string };
  // phone (optional) → WhatsApp link flow: bind this number to the email Google returns.
  const state = Buffer.from(JSON.stringify({ agentId, agentUrl, service: "identity", phone })).toString("base64url");
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
// ?agentId=xxx&agentUrl=xxx&service=gmail|calendar&extraScopes=space-separated (optional)
app.get("/auth/google/start", (req, res) => {
  const { agentId, agentUrl, service = "gmail", extraScopes } = req.query as { agentId: string; agentUrl: string; service?: string; extraScopes?: string };

  if (!SERVICE_SCOPES[service]) {
    res.status(400).send(`Unknown service: ${service}`);
    return;
  }

  const scopeSet = new Set(SERVICE_SCOPES[service].split(" "));
  if (extraScopes) extraScopes.split(" ").filter(Boolean).forEach((s) => scopeSet.add(s));
  const scope = [...scopeSet].join(" ");
  const state = Buffer.from(JSON.stringify({ agentId, agentUrl, service })).toString("base64url");
  const redirectUri = getRedirectUri(req);

  const buildAuthUrl = (clientId: string) => {
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope, access_type: "offline", prompt: "consent", state });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  };

  // Identity login always uses master credentials — it's platform-level auth, not per-agent.
  // Per-agent credentials are only for service connections (gmail, calendar, tasks).
  if (service === "identity") {
    if (!GOOGLE_CLIENT_ID) { res.status(500).send("OAuth not configured: missing client_id"); return; }
    res.redirect(buildAuthUrl(GOOGLE_CLIENT_ID));
    return;
  }

  // For service connections: look up per-agent credentials, fall back to master.
  getGoogleCreds(agentId).then(({ clientId }) => {
    const effectiveClientId = clientId || GOOGLE_CLIENT_ID;
    if (!effectiveClientId) { res.status(500).send("OAuth not configured: missing client_id"); return; }
    res.redirect(buildAuthUrl(effectiveClientId));
  }).catch(() => {
    if (!GOOGLE_CLIENT_ID) { res.status(500).send("OAuth not configured: missing client_id"); return; }
    res.redirect(buildAuthUrl(GOOGLE_CLIENT_ID));
  });
});

// Google redirects here after user approves
app.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query as { code: string; state: string };

  try {
    const { agentId, agentUrl, service, phone } = JSON.parse(Buffer.from(state, "base64url").toString());

    // Identity uses master credentials; service connections use per-agent credentials.
    const { clientId: cbClientId, clientSecret: cbClientSecret } = service === "identity"
      ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET }
      : await getGoogleCreds(agentId);
    const redirectUri = getRedirectUri(req);
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: cbClientId,
        client_secret: cbClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json() as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
    if (!tokenRes.ok || !tokens.access_token) {
      console.error("Token exchange failed", { agentId, error: tokens.error, description: tokens.error_description, clientId: cbClientId, redirectUri });
      throw new Error(`Token exchange failed: ${tokens.error ?? "no access_token"}`);
    }

    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userInfoRes.json() as { email?: string };
    if (!userInfo.email) throw new Error("Failed to retrieve user email from Google");
    const { email } = userInfo;

    if (service === "identity") {
      // WhatsApp link flow: bind the sender's phone to this email, then show a success page.
      if (phone) {
        await phoneLinkRef(agentId, phone).set({ email, connectedAt: new Date().toISOString() });
        const redirect = new URL(agentUrl);
        redirect.searchParams.set("wa_linked", "1");
        res.redirect(redirect.toString());
        return;
      }
      // Web login: issue a short-lived token the agent server will exchange for a session
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
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;

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
    const { clientId: rfClientId, clientSecret: rfClientSecret } = await getGoogleCreds(agentId);
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: rfClientId,
        client_secret: rfClientSecret,
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
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
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
    scope: "boards:read boards:write updates:read updates:write me:read users:read account:read workspaces:read",
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
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, userId } = req.params;
  try {
    const doc = await db.collection("user_settings").doc(agentId).collection("users").doc(userId).get();
    res.json(doc.exists ? doc.data() : {});
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.put("/api/user-settings/:agentId/:userId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, userId } = req.params;
  try {
    await db.collection("user_settings").doc(agentId).collection("users").doc(userId).set(req.body, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Custom tools (agent-wide tool definitions, built conversationally) ─────────
// Definitions are shared across all users of an agent. Credentials are per-user
// (stored in user_settings.customCredentials). Each doc keeps up to 10 prior
// versions for rollback.
const CUSTOM_TOOL_HISTORY = 10;

function customToolsRef(agentId: string) {
  return db.collection("custom_tools").doc(agentId).collection("tools");
}

app.get("/api/custom-tools/:agentId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  try {
    const snap = await customToolsRef(req.params.agentId).get();
    res.json(snap.docs.map((d) => d.data()));
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.put("/api/custom-tools/:agentId/:toolId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, toolId } = req.params;
  try {
    const ref = customToolsRef(agentId).doc(toolId);
    const prev = await ref.get();
    const history: unknown[] = prev.exists ? ((prev.data()!.history as unknown[]) ?? []) : [];
    if (prev.exists) {
      const { history: _omit, ...prevDef } = prev.data() as Record<string, unknown>;
      history.unshift(prevDef);
    }
    const def = { ...req.body, id: toolId, updatedAt: new Date().toISOString() };
    await ref.set({ ...def, history: history.slice(0, CUSTOM_TOOL_HISTORY) });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.delete("/api/custom-tools/:agentId/:toolId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  try {
    await customToolsRef(req.params.agentId).doc(req.params.toolId).delete();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Chat history ─────────────────────────────────────────────────────────────

function chatRef(agentId: string, email: string) {
  return db.collection("chats").doc(agentId).collection("users").doc(email).collection("sessions");
}

app.get("/api/chats/:agentId/:email", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
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
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, email } = req.params;
  const { title = "New Chat" } = req.body as { title?: string };
  try {
    const ref = chatRef(agentId, email).doc();
    await ref.set({ id: ref.id, title, messages: [], createdAt: new Date(), updatedAt: new Date() });
    res.json({ id: ref.id });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get("/api/chats/:agentId/:email/:sessionId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, email, sessionId } = req.params;
  try {
    const doc = await chatRef(agentId, email).doc(sessionId).get();
    if (!doc.exists) { res.status(404).json({ error: "Not found" }); return; }
    res.json(doc.data());
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.put("/api/chats/:agentId/:email/:sessionId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, email, sessionId } = req.params;
  try {
    await chatRef(agentId, email).doc(sessionId).set({ ...req.body, updatedAt: new Date() }, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.delete("/api/chats/:agentId/:email/:sessionId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, email, sessionId } = req.params;
  try {
    await chatRef(agentId, email).doc(sessionId).delete();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// Disconnects a user from a service
app.delete("/api/users/:agentId/:service/:userId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
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
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
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
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, userId } = req.params;
  try {
    const doc = await memRef(agentId, userId).get();
    res.json(doc.exists ? (doc.data() ?? {}) : {});
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get("/api/memories/:agentId/:userId/:key", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, userId, key } = req.params;
  try {
    const doc = await memRef(agentId, userId).get();
    const value = doc.data()?.[key];
    if (value === undefined) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ value });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.put("/api/memories/:agentId/:userId/:key", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, userId, key } = req.params;
  const { value } = req.body as { value: string };
  try {
    await memRef(agentId, userId).set({ [key]: value }, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.delete("/api/memories/:agentId/:userId/:key", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
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
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId } = req.params;
  try {
    const snap = await db.collection("whatsapp").doc(agentId).collection("sessions").get();
    // Only count sessions that still hold credentials. A DELETE preserves a config-only
    // doc, which must NOT keep the single-owner WhatsApp slot locked.
    res.json({ users: snap.docs.filter((d) => d.data().creds).map((d) => d.id) });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get("/api/whatsapp/:agentId/:userId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, userId } = req.params;
  try {
    const snap = await waRef(agentId, userId).get();
    if (!snap.exists) { res.json(null); return; }
    res.json(snap.data());
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.put("/api/whatsapp/:agentId/:userId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, userId } = req.params;
  const { creds, keys } = req.body as { creds: string; keys: string };
  try {
    await waRef(agentId, userId).set({ creds, keys, updatedAt: new Date().toISOString() }, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.patch("/api/whatsapp/:agentId/:userId/config", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, userId } = req.params;
  const { config } = req.body as { config: string };
  try {
    await waRef(agentId, userId).set({ config, updatedAt: new Date().toISOString() }, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.delete("/api/whatsapp/:agentId/:userId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
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

// ── Phone → identity links ────────────────────────────────────────────────────
// Maps a WhatsApp sender's E.164 phone number to their Boost email so inbound
// messages resolve to the sender's own connected tools. Written by the identity
// OAuth callback (state.phone), read by the agent on each inbound message.

function phoneLinkRef(agentId: string, phone: string) {
  return db.collection("phone_links").doc(agentId).collection("numbers").doc(phone);
}

app.get("/api/phone-link/:agentId/:phone", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, phone } = req.params;
  try {
    const snap = await phoneLinkRef(agentId, phone).get();
    if (!snap.exists) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ email: snap.data()?.email });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.put("/api/phone-link/:agentId/:phone", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, phone } = req.params;
  const { email } = req.body as { email: string };
  if (!email) { res.status(400).json({ error: "email required" }); return; }
  try {
    await phoneLinkRef(agentId, phone).set({ email, connectedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.delete("/api/phone-link/:agentId/:phone", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId, phone } = req.params;
  try {
    await phoneLinkRef(agentId, phone).delete();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// Agent's own public URL (saved to the registry at deploy time). Lets the agent build
// self-referencing links (e.g. WhatsApp identity link) without an env var.
app.get("/api/agent-url/:agentId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId } = req.params;
  try {
    const snap = await db.collection("agents").where("agentId", "==", agentId).limit(1).get();
    res.json({ agentUrl: snap.empty ? null : (snap.docs[0].data().agentUrl ?? null) });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Feedback ──────────────────────────────────────────────────────────────────

function feedbackRef(agentId: string) {
  return db.collection("feedback").doc(agentId).collection("entries");
}

app.post("/api/feedback/:agentId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
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
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { agentId } = req.params;
  const { rating } = req.query;
  try {
    let query: FirebaseFirestore.Query = feedbackRef(agentId).orderBy("timestamp", "desc").limit(200);
    if (rating !== undefined) query = query.where("rating", "==", Number(rating));
    const snap = await query.get();
    res.json(snap.docs.map((d) => d.data()));
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// Register per-agent Google OAuth credentials (called by the agent server at startup).
// Uses the agent's own scoped key — only that agent can write its own credentials.
app.post("/api/agent-oauth-creds/:agentId", async (req, res) => {
  if (!await verifyAgentKey(req, res, req.params.agentId)) return;
  const { clientId, clientSecret } = req.body as { clientId?: string; clientSecret?: string };
  if (!clientId || !clientSecret) { res.status(400).json({ error: "clientId and clientSecret required" }); return; }
  try {
    await db.collection("agent_oauth_creds").doc(req.params.agentId).set({ clientId, clientSecret, updatedAt: new Date().toISOString() });
    googleCredsCache.delete(req.params.agentId); // bust cache
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Per-agent key provisioning ────────────────────────────────────────────────
// Called by CI/CD during agent deploy to provision a scoped key for the new agent.
// Restricted to the master OAUTH_SERVICE_KEY — never callable by an agent itself.

function requireMasterKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (req.headers["x-api-key"] !== OAUTH_SERVICE_KEY) { res.status(403).json({ error: "Forbidden" }); return; }
  next();
}

// Check if a key already exists for this agent (idempotency for CI/CD retries)
app.get("/api/agent-keys/:agentId", requireMasterKey, async (req, res) => {
  const { agentId } = req.params;
  try {
    const snap = await db.collection("agent_keys").where("agentId", "==", agentId).limit(1).get();
    res.json({ exists: !snap.empty });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// Provision a new scoped key for an agent
app.post("/api/agent-keys", requireMasterKey, async (req, res) => {
  const { agentId } = req.body as { agentId: string };
  if (!agentId) { res.status(400).json({ error: "agentId required" }); return; }
  try {
    // Idempotent: return existing key if already provisioned
    const existing = await db.collection("agent_keys").where("agentId", "==", agentId).limit(1).get();
    if (!existing.empty) {
      res.json({ apiKey: existing.docs[0].data().apiKey });
      return;
    }
    const apiKey = randomUUID();
    await db.collection("agent_keys").add({ apiKey, agentId, createdAt: new Date().toISOString() });
    res.json({ apiKey });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Super-admin: Agent Registry ───────────────────────────────────────────────
// All endpoints below require the master OAUTH_SERVICE_KEY.

// Register a new agent in the agents collection (called by the hub server on creation)
app.post("/api/admin/agents", requireMasterKey, async (req, res) => {
  const { repoName, agentId, adminEmails, createdBy } = req.body as {
    repoName: string; agentId: string; adminEmails?: string; createdBy?: string;
  };
  if (!repoName || !agentId) { res.status(400).json({ error: "repoName and agentId required" }); return; }
  try {
    await db.collection("agents").doc(repoName).set({
      repoName, agentId, adminEmails: adminEmails ?? "", createdBy: createdBy ?? "",
      createdAt: new Date().toISOString(), status: "active",
    }, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// Update any fields on an agent record (e.g. agentUrl after deploy)
app.patch("/api/admin/agents/:agentId", requireMasterKey, async (req, res) => {
  const { agentId } = req.params;
  try {
    const snap = await db.collection("agents").where("agentId", "==", agentId).limit(1).get();
    if (snap.empty) { res.status(404).json({ error: "Agent not found" }); return; }
    await snap.docs[0].ref.set(req.body, { merge: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// List all agents (active + tombstones)
app.get("/api/admin/agents", requireMasterKey, async (_req, res) => {
  try {
    const snap = await db.collection("agents").orderBy("createdAt", "desc").get();
    res.json(snap.docs.map((d) => d.data()));
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// Get connected services summary for a single agent
app.get("/api/admin/agents/:agentId/connections", requireMasterKey, async (req, res) => {
  const { agentId } = req.params;
  try {
    const services = ["gmail_tokens", "calendar_tokens", "tasks_tokens", "monday_tokens"] as const;
    const result: Record<string, string[]> = {};
    await Promise.all(services.map(async (svc) => {
      const snap = await db.collection(svc).doc(agentId).collection("users").get();
      result[svc.replace("_tokens", "")] = snap.docs.map((d) => d.id);
    }));
    const waSnap = await db.collection("whatsapp").doc(agentId).collection("sessions").get();
    result.whatsapp = waSnap.docs.map((d) => d.id);
    res.json(result);
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// Wipe all Firestore data for an agent and mark it as deleted (tombstone preserved)
app.delete("/api/admin/agents/:agentId/data", requireMasterKey, async (req, res) => {
  const { agentId } = req.params;
  const { repoName } = req.query as { repoName?: string };
  try {
    const deleteSubcollection = async (parentPath: string, subcol: string) => {
      const snap = await db.collection(parentPath).doc(agentId).collection(subcol).get();
      if (snap.empty) return;
      const chunks = [];
      for (let i = 0; i < snap.docs.length; i += 400) chunks.push(snap.docs.slice(i, i + 400));
      for (const chunk of chunks) {
        const batch = db.batch();
        chunk.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
    };

    // Token collections (agentId → users subcollection)
    for (const svc of ["gmail_tokens", "calendar_tokens", "tasks_tokens", "monday_tokens"]) {
      await deleteSubcollection(svc, "users");
      await db.collection(svc).doc(agentId).delete();
    }

    // user_settings
    await deleteSubcollection("user_settings", "users");
    await db.collection("user_settings").doc(agentId).delete();

    // custom tool definitions
    await deleteSubcollection("custom_tools", "tools");
    await db.collection("custom_tools").doc(agentId).delete();

    // memories
    await deleteSubcollection("memories", "users");
    await db.collection("memories").doc(agentId).delete();

    // whatsapp sessions
    await deleteSubcollection("whatsapp", "sessions");
    await db.collection("whatsapp").doc(agentId).delete();

    // feedback entries
    await deleteSubcollection("feedback", "entries");
    await db.collection("feedback").doc(agentId).delete();

    // chats: 3-level nesting (agentId → users → sessions)
    const chatUsersSnap = await db.collection("chats").doc(agentId).collection("users").get();
    for (const userDoc of chatUsersSnap.docs) {
      const sessSnap = await userDoc.ref.collection("sessions").get();
      if (!sessSnap.empty) {
        const batch = db.batch();
        sessSnap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      await userDoc.ref.delete();
    }
    await db.collection("chats").doc(agentId).delete();

    // agent_keys (keyed by field, not path)
    const keysSnap = await db.collection("agent_keys").where("agentId", "==", agentId).get();
    if (!keysSnap.empty) {
      const batch = db.batch();
      keysSnap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }

    // Mark tombstone (preserve record so GCP project ID isn't reused)
    const docRef = repoName ? db.collection("agents").doc(repoName) : null;
    if (docRef) {
      await docRef.set({ status: "deleted", deletedAt: new Date().toISOString() }, { merge: true });
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// Verify an identity token — callable by any valid agent key (master or per-agent).
// Agents use this to verify login tokens without needing the master signing key.
app.post("/api/auth/identity/verify", async (req, res) => {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey) { res.status(401).json({ error: "Unauthorized" }); return; }
  const isMaster = apiKey === OAUTH_SERVICE_KEY;
  if (!isMaster) {
    const snap = await db.collection("agent_keys").where("apiKey", "==", apiKey).limit(1).get();
    if (snap.empty) { res.status(401).json({ error: "Unauthorized" }); return; }
  }
  const { identityToken } = req.body as { identityToken: string };
  try {
    const payload = jwt.verify(identityToken, OAUTH_SERVICE_KEY) as { email: string; type: string };
    if (payload.type !== "identity") throw new Error("bad type");
    res.json({ email: payload.email });
  } catch {
    res.status(401).json({ error: "Invalid or expired identity token" });
  }
});

const PORT = process.env.PORT ?? 8080;
app.listen(PORT, () => console.log(`OAuth service running on :${PORT}`));
