import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import path from "path";
import { chat } from "./agent";
import { agentConfig } from "./config";
import { commitConfig } from "./configure";
import type { AgentConfig } from "./config";
import { listAutomations, upsertAutomation, deleteAutomation, runAutomationNow } from "./automations";
import type { Automation } from "./automations";
import type { Content } from "@google/generative-ai";

const app = express();

const COOKIE_SECRET = process.env.COOKIE_SECRET ?? "dev-secret";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
const API_KEY = process.env.API_KEY;
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS ?? "").split(",").map(e => e.trim()).filter(Boolean));
const COOKIE_NAME = "session";
const IS_PROD = process.env.NODE_ENV === "production";

app.use(cors());
app.use(express.json());
app.use(cookieParser(COOKIE_SECRET));

// Serve web app static files when running as a single service
const staticDir = path.join(__dirname, "public");
app.use(express.static(staticDir));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/whoami", (req, res) => {
  if (!ACCESS_PASSWORD && !API_KEY) {
    res.json({ isAdmin: true, email: null, authenticated: true });
    return;
  }
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  const tokenToVerify = bearer ?? req.cookies[COOKIE_NAME];
  try {
    const payload = jwt.verify(tokenToVerify, COOKIE_SECRET) as { admin?: boolean; email?: string };
    res.json({ isAdmin: !!payload.admin, email: payload.email ?? null, authenticated: true });
  } catch {
    res.json({ isAdmin: false, email: null, authenticated: false });
  }
});

app.post("/api/login", (req, res) => {
  const { password } = req.body as { password?: string };

  const noAuth = !ACCESS_PASSWORD && !API_KEY;
  const isAdmin = noAuth || (!!API_KEY && password === API_KEY);
  const isUser = noAuth || (!!ACCESS_PASSWORD && password === ACCESS_PASSWORD);

  if (!isAdmin && !isUser) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  const token = jwt.sign({ ok: true, admin: isAdmin }, COOKIE_SECRET, { expiresIn: "7d" });

  // Cookie for same-origin (local dev via Vite proxy)
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  // Return token in body for cross-origin (two-service production setup)
  res.json({ ok: true, token, isAdmin });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// Called by Cloud Scheduler — no user JWT, secured by AUTOMATION_SECRET header
app.post("/api/run-automation", async (req, res) => {
  if (req.headers["x-automation-secret"] !== process.env.AUTOMATION_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { prompt } = req.body as { prompt: string; name: string; id: string };
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !oauthServiceKey || !agentId) {
    res.status(500).json({ error: "Not configured" });
    return;
  }
  try {
    const usersRes = await fetch(`${oauthServiceUrl}/api/users/${agentId}`, {
      headers: { "x-api-key": oauthServiceKey },
    });
    const { users } = await usersRes.json() as { users: { email: string; gmail: boolean; calendar: boolean }[] };
    const results = [];
    for (const user of users) {
      try {
        const result = await chat(prompt, [], "tools", undefined,
          user.gmail ? user.email : undefined,
          user.calendar ? user.email : undefined
        );
        results.push({ email: user.email, success: true, reply: result.reply });
      } catch (err) {
        results.push({ email: user.email, success: false, error: (err as Error).message });
      }
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Google identity login (no Gmail/Calendar scopes — just verifies who the user is)
app.get("/api/auth/identity/start", (req, res) => {
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !agentId) {
    res.status(500).json({ error: "OAuth service not configured" });
    return;
  }
  const agentUrl = (req.query.returnUrl as string) || `${req.protocol}://${req.get("host")}`;
  const params = new URLSearchParams({ agentId, agentUrl });
  res.redirect(`${oauthServiceUrl}/auth/identity/start?${params}`);
});

// Exchanges the short-lived identity token for a session JWT
app.post("/api/auth/identity/complete", (req, res) => {
  const { identityToken } = req.body as { identityToken: string };
  const oauthKey = process.env.OAUTH_SERVICE_KEY ?? "";
  try {
    const payload = jwt.verify(identityToken, oauthKey) as { email: string; type: string };
    if (payload.type !== "identity") throw new Error("Invalid token type");
    const isAdmin = ADMIN_EMAILS.size === 0 || ADMIN_EMAILS.has(payload.email);
    const token = jwt.sign({ ok: true, admin: isAdmin, email: payload.email }, COOKIE_SECRET, { expiresIn: "7d" });
    res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: IS_PROD, sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, token, isAdmin, email: payload.email });
  } catch {
    res.status(401).json({ error: "Invalid or expired identity token" });
  }
});

app.get("/api/auth/google/start", (req, res) => {
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !agentId) {
    res.status(500).json({ error: "OAuth service not configured" });
    return;
  }
  const agentUrl = (req.query.returnUrl as string) || `${req.protocol}://${req.get("host")}`;
  const service = (req.query.service as string) || "gmail";
  const params = new URLSearchParams({ agentId, agentUrl, service });
  res.redirect(`${oauthServiceUrl}/auth/google/start?${params}`);
});

// Auth: x-api-key header (programmatic), Bearer token (cross-origin browser), or cookie (same-origin)
app.use((req, res, next) => {
  if (!ACCESS_PASSWORD && !API_KEY) return next();

  if (API_KEY && req.headers["x-api-key"] === API_KEY) return next();

  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;

  const tokenToVerify = bearer ?? req.cookies[COOKIE_NAME];
  try {
    jwt.verify(tokenToVerify, COOKIE_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
});

app.get("/api/automations", async (_req, res) => {
  try {
    res.json(await listAutomations());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/automations", async (req, res) => {
  try {
    const { automation, agentUrl } = req.body as { automation: Automation; agentUrl: string };
    // Stamp createdBy from the session JWT if not already set
    if (!automation.createdBy) {
      const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
      const tok = bearer ?? req.cookies[COOKIE_NAME];
      try {
        const p = jwt.verify(tok, COOKIE_SECRET) as { email?: string };
        if (p.email) automation.createdBy = p.email;
      } catch { /* no email in token */ }
    }
    await upsertAutomation(automation, agentUrl);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/automations/:id", async (req, res) => {
  try {
    await deleteAutomation(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/automations/:id/run", requireAdmin, async (req, res) => {
  try {
    await runAutomationNow(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Returns a signed API token for the connected Google service user
app.get("/api/google-token", async (req, res) => {
  const { email, service } = req.query as { email: string; service: string };
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !oauthServiceKey || !agentId) {
    res.status(500).json({ error: "Not configured" });
    return;
  }
  try {
    const r = await fetch(`${oauthServiceUrl}/api/user-token/${agentId}/${service}/${email}`, {
      headers: { "x-api-key": oauthServiceKey },
    });
    if (!r.ok) { res.status(404).json({ error: "User not connected" }); return; }
    const { token } = await r.json() as { token: string };
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/providers", (_req, res) => {
  res.json({
    gemini:  !!process.env.GEMINI_API_KEY,
    claude:  !!process.env.ANTHROPIC_API_KEY,
    openai:  !!process.env.OPENAI_API_KEY,
  });
});

app.get("/api/config", (_req, res) => {
  res.json(agentConfig);
});

// Extracts the authenticated user's email from the session cookie or Bearer token
function getSessionEmail(req: express.Request): string | undefined {
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7) : null;
  const tok = bearer ?? req.cookies[COOKIE_NAME];
  try { return (jwt.verify(tok, COOKIE_SECRET) as { email?: string }).email ?? undefined; }
  catch { return undefined; }
}

// Returns which Google services the current user has connected
app.get("/api/connections", async (req, res) => {
  const email = getSessionEmail(req);
  if (!email) { res.json({ gmail: false, calendar: false }); return; }
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !oauthServiceKey || !agentId) {
    res.json({ gmail: false, calendar: false }); return;
  }
  try {
    const r = await fetch(`${oauthServiceUrl}/api/users/${agentId}`, {
      headers: { "x-api-key": oauthServiceKey },
    });
    const { users } = await r.json() as { users: { email: string; gmail: boolean; calendar: boolean }[] };
    const user = users.find((u) => u.email === email);
    res.json({ gmail: !!user?.gmail, calendar: !!user?.calendar });
  } catch { res.json({ gmail: false, calendar: false }); }
});

// Disconnect a Google service for the current user
app.delete("/api/connections/:service", async (req, res) => {
  const email = getSessionEmail(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { service } = req.params;
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !oauthServiceKey || !agentId) {
    res.status(500).json({ error: "Not configured" }); return;
  }
  try {
    await fetch(`${oauthServiceUrl}/api/users/${agentId}/${service}/${encodeURIComponent(email)}`, {
      method: "DELETE",
      headers: { "x-api-key": oauthServiceKey },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

function requireAdmin(req: any, res: any, next: any) {
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  const tokenToVerify = bearer ?? req.cookies[COOKIE_NAME];
  try {
    const payload = jwt.verify(tokenToVerify, COOKIE_SECRET) as { admin?: boolean };
    if (!payload.admin) throw new Error();
    next();
  } catch {
    res.status(403).json({ error: "Admin access required" });
  }
}

app.get("/api/admin/key", requireAdmin, (_req, res) => {
  res.json({ apiKey: API_KEY ?? "" });
});

app.post("/api/configure", requireAdmin, async (req, res) => {
  try {
    const commitUrl = await commitConfig(req.body as AgentConfig);
    res.json({ ok: true, commitUrl });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message, history = [], mode = "tools", systemPrompt, model } = req.body as {
    message: string;
    history: Content[];
    mode?: "search" | "tools";
    systemPrompt?: string;
    model?: { provider: "gemini" | "claude" | "openai"; modelId: string };
  };

  // Use the session email server-side — no tokens needed from the client
  const sessionEmail = getSessionEmail(req);

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const result = await chat(message.trim(), history, mode, systemPrompt, sessionEmail, sessionEmail, model);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Agent error", details: (err as Error).message });
  }
});

// Fallback: serve the SPA for any non-API route (single-service mode)
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

const PORT = process.env.PORT ?? 8080;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
