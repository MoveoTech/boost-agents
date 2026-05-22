import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import path from "path";
import { chat, chatStream, type ImageAttachment } from "./agent";
import { getUserAccessToken } from "./google-auth";
import { logger } from "./logger";
import { slackSendMessage, slackGetUserEmail } from "./slack";
import { agentConfig } from "./config";
import { commitConfig } from "./configure";
import type { AgentConfig } from "./config";
import { listAutomations, upsertAutomation, deleteAutomation, runAutomationNow, resyncAutomationSecrets } from "./automations";
import type { Automation } from "./automations";
import { connectSession, disconnectSession, getStatus, initAllSessions, type MentionHandler, type WhatsAppConfig, DEFAULT_WA_CONFIG } from "./whatsapp";
import type { Content } from "@google/generative-ai";
import QRCode from "qrcode";

const app = express();

// ── In-memory analytics (resets on restart) ──────────────────────────────────
interface DayStat { messages: number; toolCalls: number; totalMs: number }
const dailyStats = new Map<string, DayStat>();
const toolUsageCounts = new Map<string, number>();
const modelUsageCounts = new Map<string, number>();

function trackUsage(modelId: string, toolNames: string[], durationMs: number) {
  const day = new Date().toISOString().slice(0, 10);
  const s = dailyStats.get(day) ?? { messages: 0, toolCalls: 0, totalMs: 0 };
  s.messages++;
  s.toolCalls += toolNames.length;
  s.totalMs += durationMs;
  dailyStats.set(day, s);
  modelUsageCounts.set(modelId, (modelUsageCounts.get(modelId) ?? 0) + 1);
  toolNames.forEach((t) => toolUsageCounts.set(t, (toolUsageCounts.get(t) ?? 0) + 1));
}

const COOKIE_SECRET = process.env.COOKIE_SECRET ?? "dev-secret";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
const API_KEY = process.env.API_KEY;
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS ?? "").split(/[,;|\s]+/).map(e => e.trim()).filter(Boolean));
const COOKIE_NAME = "session";
const IS_PROD = process.env.NODE_ENV === "production";

app.use(cors());
app.use(express.json({
  verify: (req: any, _res, buf) => { req.rawBody = buf; },
}));
app.use(cookieParser(COOKIE_SECRET));

// Serve web app static files when running as a single service
const staticDir = path.join(__dirname, "public");
app.use(express.static(staticDir));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Client-side error reporting — receives errors from the browser and logs them server-side
app.post("/api/log", (req, res) => {
  const { level = "error", message, context } = req.body as { level?: string; message: string; context?: Record<string, unknown> };
  const email = getSessionEmail(req);
  const logFn = level === "warn" ? logger.warn : level === "info" ? logger.info : logger.error;
  logFn(`[client] ${message}`, { userEmail: email, ...context });
  res.json({ ok: true });
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
  const { prompt, id, oneTime, createdBy } = req.body as { prompt: string; name: string; id: string; oneTime?: boolean; createdBy?: string };
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !oauthServiceKey || !agentId) {
    res.status(500).json({ error: "Not configured" });
    return;
  }
  if (!createdBy) {
    res.status(400).json({ error: "Automation has no createdBy — cannot determine which user to run as" });
    return;
  }
  try {
    const usersRes = await fetch(`${oauthServiceUrl}/api/users/${agentId}`, {
      headers: { "x-api-key": oauthServiceKey },
    });
    const { users } = await usersRes.json() as { users: { email: string; gmail: boolean; calendar: boolean; monday: boolean; tasks: boolean }[] };
    const user = users.find((u) => u.email === createdBy);
    if (!user) {
      res.status(404).json({ error: `User ${createdBy} not found — they may have disconnected` });
      return;
    }
    const autoMondayToken = user.monday ? (await getUserAccessToken("monday", user.email).catch(() => null)) ?? undefined : undefined;
    const autoTasksUser = user.tasks ? user.email : undefined;
    const result = await chat(prompt, [], "tools", undefined,
      user.gmail ? user.email : undefined,
      user.calendar ? user.email : undefined,
      undefined, autoMondayToken, autoTasksUser,
    );
    res.json({ ok: true, results: [{ email: user.email, success: true, reply: result.reply }] });
    // Self-delete after running if this is a one-time automation
    if (oneTime && id) {
      await deleteAutomation(id).catch(() => {});
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Slack Events API — receives mentions and responds via the agent
app.post("/slack/events", async (req, res) => {
  const payload = req.body as {
    type: string;
    challenge?: string;
    event?: { type: string; text: string; channel: string; ts: string; thread_ts?: string; bot_id?: string; user?: string };
  };

  // Respond to URL verification challenge immediately — no signature needed
  if (payload.type === "url_verification") {
    res.json({ challenge: payload.challenge });
    return;
  }

  // Verify Slack signature for all other events
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "";
  const signature = req.headers["x-slack-signature"] as string ?? "";
  const timestamp = req.headers["x-slack-request-timestamp"] as string ?? "0";
  const rawBody = (req as any).rawBody?.toString() ?? "";

  // Reject stale requests (>5 min old) to prevent replay attacks
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    res.status(401).json({ error: "Request too old" });
    return;
  }

  const hmac = crypto.createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  const expected = `v0=${hmac}`;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
  } catch {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // Respond immediately — Slack requires <3s
  res.json({ ok: true });

  const event = payload.event;
  if (event?.type !== "app_mention" || event.bot_id) return; // ignore bot messages

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) return;

  const text = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const threadTs = event.thread_ts ?? event.ts;

  // Resolve the Slack user's email to load all their connected services
  const userEmail = event.user ? await slackGetUserEmail(slackToken, event.user).catch(() => undefined) : undefined;
  const slackMondayToken = userEmail ? (await getUserAccessToken("monday", userEmail).catch(() => null)) ?? undefined : undefined;
  const slackTasksUser = userEmail ? (await getUserAccessToken("tasks", userEmail).catch(() => null)) ? userEmail : undefined : undefined;

  try {
    const result = await chat(text, [], "tools", undefined, userEmail, userEmail, undefined, slackMondayToken, slackTasksUser);
    await slackSendMessage(slackToken, event.channel, result.reply, threadTs);
  } catch (err) {
    await slackSendMessage(slackToken, event.channel, `Sorry, something went wrong: ${(err as Error).message}`, threadTs).catch(() => {});
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

app.get("/api/auth/monday/start", (req, res) => {
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !agentId) { res.status(500).json({ error: "OAuth service not configured" }); return; }
  const agentUrl = (req.query.returnUrl as string) || `${req.protocol}://${req.get("host")}`;
  const params = new URLSearchParams({ agentId, agentUrl });
  res.redirect(`${oauthServiceUrl}/auth/monday/start?${params}`);
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

app.get("/api/automations", async (req, res) => {
  try {
    const email = getSessionEmail(req);
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    const tok = bearer ?? req.cookies[COOKIE_NAME];
    const isAdmin = (() => { try { return !!(jwt.verify(tok, COOKIE_SECRET) as { admin?: boolean }).admin; } catch { return false; } })();
    const all = await listAutomations();
    // Admins see all automations; regular users only see their own
    res.json(isAdmin ? all : all.filter((a) => a.createdBy === email));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/automations", async (req, res) => {
  try {
    const { automation, agentUrl } = req.body as { automation: Automation; agentUrl: string };
    // Always stamp createdBy from the session — never trust the client value
    const email = getSessionEmail(req);
    if (email) automation.createdBy = email;
    await upsertAutomation(automation, agentUrl);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/automations/:id", async (req, res) => {
  try {
    const email = getSessionEmail(req);
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
    const tok = bearer ?? req.cookies[COOKIE_NAME];
    const isAdmin = (() => { try { return !!(jwt.verify(tok, COOKIE_SECRET) as { admin?: boolean }).admin; } catch { return false; } })();
    // Verify the requester owns this automation (admins can delete any)
    if (!isAdmin) {
      const all = await listAutomations();
      const automation = all.find((a) => a.id === req.params.id);
      if (automation && automation.createdBy && automation.createdBy !== email) {
        res.status(403).json({ error: "You can only delete your own automations" });
        return;
      }
    }
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
    slack:   !!process.env.SLACK_BOT_TOKEN,
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

// Per-user settings (model, instructions, avatar) — stored in oauth-service Firestore
app.get("/api/user-settings", async (req, res) => {
  const email = getSessionEmail(req);
  if (!email) { res.json({}); return; }
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !oauthServiceKey || !agentId) { res.json({}); return; }
  try {
    const r = await fetch(`${oauthServiceUrl}/api/user-settings/${agentId}/${encodeURIComponent(email)}`, {
      headers: { "x-api-key": oauthServiceKey },
    });
    res.json(r.ok ? await r.json() : {});
  } catch { res.json({}); }
});

app.put("/api/user-settings", async (req, res) => {
  const email = getSessionEmail(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !oauthServiceKey || !agentId) { res.status(500).json({ error: "Not configured" }); return; }
  try {
    await fetch(`${oauthServiceUrl}/api/user-settings/${agentId}/${encodeURIComponent(email)}`, {
      method: "PUT",
      headers: { "x-api-key": oauthServiceKey, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Chat history ─────────────────────────────────────────────────────────────

function oauthProxy(req: express.Request) {
  return {
    url: process.env.OAUTH_SERVICE_URL ?? "",
    key: process.env.OAUTH_SERVICE_KEY ?? "",
    agentId: process.env.GOOGLE_CLOUD_PROJECT ?? "",
    email: getSessionEmail(req) ?? "",
  };
}

app.get("/api/chats", async (req, res) => {
  const { url, key, agentId, email } = oauthProxy(req);
  if (!email) { res.json({ sessions: [] }); return; }
  try {
    const r = await fetch(`${url}/api/chats/${agentId}/${encodeURIComponent(email)}`, { headers: { "x-api-key": key } });
    res.json(r.ok ? await r.json() : { sessions: [] });
  } catch { res.json({ sessions: [] }); }
});

app.post("/api/chats", async (req, res) => {
  const { url, key, agentId, email } = oauthProxy(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const r = await fetch(`${url}/api/chats/${agentId}/${encodeURIComponent(email)}`, {
      method: "POST", headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.json(r.ok ? await r.json() : { error: "Failed" });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get("/api/chats/:id", async (req, res) => {
  const { url, key, agentId, email } = oauthProxy(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const r = await fetch(`${url}/api/chats/${agentId}/${encodeURIComponent(email)}/${req.params.id}`, { headers: { "x-api-key": key } });
    if (!r.ok) { res.status(404).json({ error: "Not found" }); return; }
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.put("/api/chats/:id", async (req, res) => {
  const { url, key, agentId, email } = oauthProxy(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    await fetch(`${url}/api/chats/${agentId}/${encodeURIComponent(email)}/${req.params.id}`, {
      method: "PUT", headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.delete("/api/chats/:id", async (req, res) => {
  const { url, key, agentId, email } = oauthProxy(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    await fetch(`${url}/api/chats/${agentId}/${encodeURIComponent(email)}/${req.params.id}`, {
      method: "DELETE", headers: { "x-api-key": key },
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

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
    const { users } = await r.json() as { users: { email: string; gmail: boolean; calendar: boolean; monday: boolean; tasks: boolean }[] };
    const user = users.find((u) => u.email === email);
    res.json({ gmail: !!user?.gmail, calendar: !!user?.calendar, monday: !!user?.monday, tasks: !!user?.tasks, whatsapp: getStatus(email) === "connected" });
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

// Apply config changes to the running server immediately (no git commit)
app.patch("/api/config/live", requireAdmin, (req, res) => {
  Object.assign(agentConfig, req.body as Partial<AgentConfig>);
  res.json({ ok: true });
});

app.post("/api/configure", requireAdmin, async (req, res) => {
  try {
    const newConfig = req.body as AgentConfig;
    const commitUrl = await commitConfig(newConfig);
    // Update the running server's in-memory config so changes take effect immediately
    Object.assign(agentConfig, newConfig);
    res.json({ ok: true, commitUrl });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── WhatsApp ──────────────────────────────────────────────────────────────────

// SSE: streams QR codes then a "connected" event to the client
app.get("/api/whatsapp/qr", async (req, res) => {
  const email = getSessionEmail(req);
  if (!email) { res.status(401).end(); return; }
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL ?? "";
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY ?? "";
  const agentId = process.env.GOOGLE_CLOUD_PROJECT ?? "";

  console.log(JSON.stringify({ tag: "whatsapp", user: email, msg: "QR SSE stream opened" }));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: object) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ }
  };

  const onQR = async (qr: string) => {
    try {
      console.log(JSON.stringify({ tag: "whatsapp", user: email, msg: "converting QR to data URL and sending to client" }));
      const dataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      send({ type: "qr", qr: dataUrl });
    } catch (err) {
      console.error(JSON.stringify({ tag: "whatsapp", user: email, msg: "QR image conversion failed", error: (err as Error).message }));
    }
  };

  let done = false;
  const finish = (data: object) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    clearInterval(statusPoll);
    send(data);
    res.end();
  };

  const onConnected = () => {
    console.log(JSON.stringify({ tag: "whatsapp", user: email, msg: "connected — closing QR SSE stream" }));
    prewarmWASession(email, agentId, oauthServiceUrl, oauthServiceKey);
    finish({ type: "connected" });
  };

  // Baileys fires a 515 "restart required" on first login, which causes our session to delete
  // and reconnect — losing the onConnected callback. Poll every second as a safety net so the
  // QR popup always closes once the session reaches "connected" state.
  const statusPoll = setInterval(() => {
    if (getStatus(email) === "connected") {
      console.log(JSON.stringify({ tag: "whatsapp", user: email, msg: "status poll detected connected — closing QR SSE stream" }));
      finish({ type: "connected" });
    }
  }, 1000);

  const timeout = setTimeout(() => {
    console.log(JSON.stringify({ tag: "whatsapp", user: email, msg: "QR timeout — no scan after 3 minutes" }));
    finish({ type: "timeout" });
  }, 3 * 60 * 1000);

  req.on("close", () => {
    clearTimeout(timeout);
    clearInterval(statusPoll);
    console.log(JSON.stringify({ tag: "whatsapp", user: email, msg: "QR SSE stream closed by client" }));
  });

  try {
    const mentionHandler = buildMentionHandler(agentId, oauthServiceUrl, oauthServiceKey);
    await connectSession(email, agentId, oauthServiceUrl, oauthServiceKey, mentionHandler, onQR, onConnected);
  } catch (err) {
    console.error(JSON.stringify({ tag: "whatsapp", user: email, msg: "connectSession threw", error: (err as Error).message, stack: (err as Error).stack }));
    send({ type: "error", message: (err as Error).message });
    res.end();
  }
});

app.get("/api/whatsapp/status", (req, res) => {
  const email = getSessionEmail(req);
  res.json({ status: email ? getStatus(email) : "disconnected" });
});

app.delete("/api/whatsapp", async (req, res) => {
  const email = getSessionEmail(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL ?? "";
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY ?? "";
  const agentId = process.env.GOOGLE_CLOUD_PROJECT ?? "";
  try {
    await disconnectSession(email, agentId, oauthServiceUrl, oauthServiceKey);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── WhatsApp config endpoints ─────────────────────────────────────────────────

// Cache config per user — falls back to stale cache when oauth-service is unreachable
const waConfigCache = new Map<string, { config: WhatsAppConfig; ts: number }>();

// Cache users data per agentId — changes infrequently, 5 min TTL


async function loadWAConfig(email: string, agentId: string, oauthServiceUrl: string, oauthServiceKey: string): Promise<WhatsAppConfig> {
  const cached = waConfigCache.get(email);
  if (cached && Date.now() - cached.ts < 5 * 60_000) return cached.config;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5_000);
    const res = await fetch(`${oauthServiceUrl}/api/whatsapp/${agentId}/${encodeURIComponent(email)}`, {
      headers: { "x-api-key": oauthServiceKey },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return cached?.config ?? DEFAULT_WA_CONFIG;
    const data = await res.json() as { config?: string } | null;
    const config = data?.config ? { ...DEFAULT_WA_CONFIG, ...JSON.parse(data.config) } : DEFAULT_WA_CONFIG;
    waConfigCache.set(email, { config, ts: Date.now() });
    return config;
  } catch {
    return cached?.config ?? DEFAULT_WA_CONFIG;
  }
}

app.get("/api/whatsapp/config", async (req, res) => {
  const email = getSessionEmail(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL ?? "";
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY ?? "";
  const agentId = process.env.GOOGLE_CLOUD_PROJECT ?? "";
  res.json(await loadWAConfig(email, agentId, oauthServiceUrl, oauthServiceKey));
});

app.put("/api/whatsapp/config", async (req, res) => {
  const email = getSessionEmail(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL ?? "";
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY ?? "";
  const agentId = process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const config = req.body as WhatsAppConfig;
  try {
    const patchRes = await fetch(`${oauthServiceUrl}/api/whatsapp/${agentId}/${encodeURIComponent(email)}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-key": oauthServiceKey },
      body: JSON.stringify({ config: JSON.stringify(config) }),
    });
    if (!patchRes.ok) {
      const text = await patchRes.text().catch(() => "");
      res.status(502).json({ error: `oauth-service returned ${patchRes.status}`, detail: text });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Build the message handler — applies user config to decide when to reply, runs agent with all tools
// Pre-warm per-user caches immediately on session connect so the first message
// doesn't hit cold loadWAConfig or mondayToken fetches (each up to 5s).
function prewarmWASession(email: string, agentId: string, oauthServiceUrl: string, oauthServiceKey: string): void {
  Promise.all([
    loadWAConfig(email, agentId, oauthServiceUrl, oauthServiceKey),
    getUserAccessToken("monday", email),
  ]).catch(() => {});
}

function buildMentionHandler(agentId: string, oauthServiceUrl: string, oauthServiceKey: string): MentionHandler {
  return async ({ email, fromName, text, isGroup, groupName, isMentioned, fromMe, recentMessages }) => {
    const ctx = { tag: "whatsapp", user: email, fromName, isGroup, groupName: groupName ?? null, isMentioned };
    const tHandler = Date.now();
    try {
      const tConfig0 = Date.now();
      const config = await loadWAConfig(email, agentId, oauthServiceUrl, oauthServiceKey);
      console.log(JSON.stringify({ ...ctx, msg: "timing: loadWAConfig", ms: Date.now() - tConfig0 }));

      console.log(JSON.stringify({ ...ctx, msg: "evaluating reply trigger", trigger: config.replyTrigger, replyInGroups: config.replyInGroups, replyInDMs: config.replyInDMs, ownerOnly: !!config.ownerOnly, keyword: config.keyword ?? null }));

      if (config.ownerOnly && !fromMe) {
        console.log(JSON.stringify({ ...ctx, msg: "skipping — ownerOnly mode, message not from account owner" }));
        return null;
      }
      if (isGroup && !config.replyInGroups) {
        console.log(JSON.stringify({ ...ctx, msg: "skipping — group messages disabled in config" }));
        return null;
      }
      if (!isGroup && !config.replyInDMs) {
        console.log(JSON.stringify({ ...ctx, msg: "skipping — DM messages disabled in config" }));
        return null;
      }
      if (config.replyTrigger === "mention") {
        // In groups: require an @mention. In DMs: no @mention possible, so treat as "always".
        // But with ownerOnly:true this still means every DM you send triggers the agent,
        // which causes replies in private conversations. Prefer "keyword" trigger with ownerOnly.
        if (isGroup && !isMentioned) {
          console.log(JSON.stringify({ ...ctx, msg: "skipping — not mentioned in group (trigger=mention)" }));
          return null;
        }
      } else if (config.replyTrigger === "keyword") {
        const kw = (config.keyword ?? "").trim();
        const kwLower = kw.toLowerCase();
        const found = kw && (text.toLowerCase().includes(kwLower) || text.includes(kw));
        if (!found) {
          console.log(JSON.stringify({ ...ctx, msg: "skipping — keyword not found", keyword: kw }));
          return null;
        }
      }
      // "always" trigger: no additional check needed

      const agentStartMs = Date.now();
      console.log(JSON.stringify({ ...ctx, msg: "trigger matched — running agent", textLength: text.length, text, msSinceHandlerStart: agentStartMs - tHandler }));

      const tMonday0 = Date.now();
      const mondayToken = await Promise.race([
        getUserAccessToken("monday", email).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      console.log(JSON.stringify({ ...ctx, msg: "timing: mondayToken", ms: Date.now() - tMonday0, cached: mondayToken !== null }));

      const location = isGroup ? `WhatsApp group "${groupName ?? "a group"}"` : "WhatsApp DM";

      // Build proper alternating conversation history from the recent message buffer.
      // Consecutive messages from the same role are merged so Claude sees clean turns.
      const historyRaw = recentMessages.slice(0, -1); // exclude current message
      const history: Content[] = [];
      for (const m of historyRaw) {
        if (!m.text) continue;
        const role: "user" | "model" = m.from === "Assistant" ? "model" : "user";
        const content = m.from === "Assistant" ? m.text : `${m.from}: ${m.text}`;
        const last = history[history.length - 1];
        if (last && last.role === role) {
          // Merge consecutive same-role messages
          (last.parts[0] as { text: string }).text += `\n${content}`;
        } else {
          history.push({ role, parts: [{ text: content }] });
        }
      }
      // Claude requires alternating turns. Drop any leading model turn, then drop any
      // trailing user turns — they have no bot reply and would create consecutive user
      // turns when the current message is appended (→ 400 from the API).
      if (history.length > 0 && history[0].role === "model") history.shift();
      while (history.length > 0 && history[history.length - 1].role === "user") history.pop();

      const now = new Date().toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
      const systemPrompt = [
        `You are ${fromName}'s personal WhatsApp assistant. The user you are talking to is ${fromName}. Current context: ${location}. Current time: ${now}.`,
        `Reply directly to the user as if texting them. Be brief and natural. Do not use markdown. Do NOT call any send-message tools — your text reply is delivered automatically.`,
        `CRITICAL RULES (override all other instructions):`,
        `- You have ONE response. There is no follow-up. Act NOW or not at all.`,
        `- NEVER say "one sec", "let me check", "I'll do that", "creating now" without calling the tool immediately in this same response.`,
        `- When the user provides all info needed — execute immediately. Do NOT ask for confirmation.`,
        `- If a tool fails, say so honestly. Never claim success unless the tool returned success.`,
        `- Only ask a question if a required piece of info is genuinely missing. Ask at most ONE question per response.`,
        `- Default timezone: Israel (Asia/Jerusalem, UTC+3) unless the user specifies otherwise.`,
        config.customPrompt || "",
      ].filter(Boolean).join("\n");

      const agentTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("agent timed out after 55s")), 55_000)
      );

      const tChat0 = Date.now();
      const result = await Promise.race([
        chat(
          text,
          history,
          "tools",
          systemPrompt,
          email,   // gmailUser
          email,   // calendarUser
          { ...(config.model ?? { provider: "claude" as const, modelId: "claude-haiku-4-5-20251001" }), noThinking: false },
          mondayToken ?? undefined,
          email,   // tasksUser
          undefined,
          undefined,
          undefined,
        ),
        agentTimeout,
      ]);

      const elapsedSec = Math.round((Date.now() - agentStartMs) / 1000);
      console.log(JSON.stringify({ ...ctx, msg: "timing: chat()", ms: Date.now() - tChat0, toolsUsed: result.toolUses?.length ?? 0 }));
      console.log(JSON.stringify({ ...ctx, msg: "agent reply ready", replyLength: result.reply?.length ?? 0, toolsUsed: result.toolUses?.length ?? 0, elapsedSec }));
      const reply = result.reply ? `🤖 ${result.reply}\n\n_(${elapsedSec}s)_` : null;
      return reply;
    } catch (err) {
      const errMsg = (err as Error).message;
      console.error(JSON.stringify({ ...ctx, msg: "message handler threw", error: errMsg }));
      return "🤖 Something went wrong — try again in a moment.";
    }
  };
}

// In-memory feedback store (keyed by messageId)
const feedbackStore = new Map<string, { rating: number; comment?: string }>();

app.post("/api/feedback", async (req, res) => {
  const { messageId, rating, comment, userMessage, agentResponse } = req.body as {
    messageId: string; rating: 1 | -1; comment?: string; userMessage?: string; agentResponse?: string;
  };
  if (!messageId) { res.status(400).json({ error: "messageId required" }); return; }
  feedbackStore.set(messageId, { rating, comment });

  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  const email = (req as any).session?.email ?? "unknown";
  const model = agentConfig.model?.modelId ?? "gemini-2.5-flash";
  if (oauthServiceUrl && oauthServiceKey && agentId) {
    fetch(`${oauthServiceUrl}/api/feedback/${agentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": oauthServiceKey },
      body: JSON.stringify({ messageId, userEmail: email, rating, userMessage, agentResponse, model }),
    }).catch(() => {});
  }

  res.json({ ok: true });
});

app.get("/api/analytics", requireAdmin, (_req, res) => {
  const days = Array.from(dailyStats.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, s]) => ({
      date,
      messages: s.messages,
      toolCalls: s.toolCalls,
      avgResponseMs: s.messages ? Math.round(s.totalMs / s.messages) : 0,
    }));
  const topTools = Array.from(toolUsageCounts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  const models = Array.from(modelUsageCounts.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => ({ name, count }));
  const totalMessages = days.reduce((n, d) => n + d.messages, 0);
  const positiveFeedback = Array.from(feedbackStore.values()).filter((f) => f.rating === 1).length;
  const negativeFeedback = Array.from(feedbackStore.values()).filter((f) => f.rating === -1).length;
  res.json({ days, topTools, models, totalMessages, positiveFeedback, negativeFeedback });
});

function buildMessageWithAttachment(message: string, att: { data: string; mimeType: string; name: string }): string {
  const isText = att.mimeType.startsWith("text/")
    || att.mimeType === "application/json"
    || att.mimeType === "application/xml"
    || att.mimeType === "application/javascript"
    || /\.(txt|md|csv|json|xml|yaml|yml|js|ts|py|java|cpp|c|h|css|sql|sh|log|ini|toml|env|html|htm)$/i.test(att.name);

  if (isText) {
    try {
      const content = Buffer.from(att.data, "base64").toString("utf-8");
      const truncated = content.length > 50_000 ? content.slice(0, 50_000) + "\n[truncated]" : content;
      return `${message}\n\n[File: ${att.name}]\n\`\`\`\n${truncated}\n\`\`\``;
    } catch {
      return `${message}\n\n[Attached file: ${att.name}]`;
    }
  }

  // For images and other binary files, signal the model via a marker — handled as multimodal by the LLM layer
  return `${message}\n\n[Attached image: ${att.name}]`;
}

app.post("/api/chat", async (req, res) => {
  const {
    message, history = [], mode = "tools", systemPrompt, model,
    userEmail: bodyEmail, stream: wantStream = false,
    attachment,
  } = req.body as {
    message: string;
    history: Content[];
    mode?: "search" | "tools";
    systemPrompt?: string;
    model?: { provider: "gemini" | "claude" | "openai"; modelId: string };
    userEmail?: string;
    stream?: boolean;
    attachment?: { data: string; mimeType: string; name: string };
  };

  const sessionEmail = getSessionEmail(req) ?? bodyEmail;
  const isImageAttachment = !!attachment && attachment.mimeType.startsWith("image/");
  const effectiveMessage = attachment && !isImageAttachment
    ? buildMessageWithAttachment(message, attachment)
    : message;
  const imageAttachment: ImageAttachment | undefined = isImageAttachment
    ? { data: attachment!.data, mimeType: attachment!.mimeType }
    : undefined;

  if (!effectiveMessage?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const modelId = model?.modelId ?? agentConfig.model?.modelId ?? "gemini-2.5-flash";
  const t0 = Date.now();

  if (wantStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const toolUses: { name: string; input: string; output: string }[] = [];

    const mondayTokenStream = sessionEmail ? (await getUserAccessToken("monday", sessionEmail).catch(() => null)) ?? undefined : undefined;
    const tasksUserStream   = sessionEmail ? (await getUserAccessToken("tasks",   sessionEmail).catch(() => null)) ? sessionEmail : undefined : undefined;
    const waUserStream      = sessionEmail && getStatus(sessionEmail) === "connected" ? sessionEmail : undefined;
    try {
      await chatStream(
        effectiveMessage.trim(), history, mode, systemPrompt, sessionEmail, sessionEmail, model,
        {
          onToken: (token) => send({ type: "token", content: token }),
          onToolStart: (name, input) => {
            toolUses.push({ name, input, output: "" });
            send({ type: "tool_start", tool: { name, input } });
          },
          onToolComplete: (name, output) => {
            const t = toolUses.find((x) => x.name === name && x.output === "");
            if (t) t.output = output.slice(0, 500);
            send({ type: "tool_complete", tool: { name, output: output.slice(0, 500) } });
          },
        },
        mondayTokenStream,
        tasksUserStream,
        sessionEmail,
        imageAttachment,
        waUserStream,
      );
      send({ type: "done", toolUses });
      trackUsage(modelId, toolUses.map((t) => t.name), Date.now() - t0);
    } catch (err) {
      send({ type: "error", message: (err as Error).message });
    } finally {
      res.end();
    }
    return;
  }

  try {
    const mondayToken = sessionEmail ? (await getUserAccessToken("monday", sessionEmail).catch(() => null)) ?? undefined : undefined;
    const tasksUser   = sessionEmail ? (await getUserAccessToken("tasks",   sessionEmail).catch(() => null)) ? sessionEmail : undefined : undefined;
    const waUser      = sessionEmail && getStatus(sessionEmail) === "connected" ? sessionEmail : undefined;
    const result = await chat(effectiveMessage.trim(), history, mode, systemPrompt, sessionEmail, sessionEmail, model, mondayToken, tasksUser, sessionEmail, imageAttachment, waUser);
    trackUsage(modelId, result.toolUses.map((t) => t.name), Date.now() - t0);
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
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
  resyncAutomationSecrets();
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL ?? "";
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY ?? "";
  const agentId = process.env.GOOGLE_CLOUD_PROJECT ?? "";
  initAllSessions(agentId, oauthServiceUrl, oauthServiceKey, buildMentionHandler(agentId, oauthServiceUrl, oauthServiceKey),
    (email) => prewarmWASession(email, agentId, oauthServiceUrl, oauthServiceKey),
    (email) => prewarmWASession(email, agentId, oauthServiceUrl, oauthServiceKey));
});

// Baileys fires unhandled rejections from internal retry machinery (e.g. sendRetryRequest
// when the socket closes mid-flight). Catch them so they don't crash the process.
process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  console.error(JSON.stringify({ tag: "process", msg: "unhandledRejection", reason: msg }));
  if (msg.includes("Unsupported state or unable to authenticate data")) {
    // Native AES-GCM auth failure — corrupted key material in Firestore.
    // Purge session keys for all connecting sessions so Baileys re-establishes fresh sessions.
    const { purgeConnectingSessionKeys } = require("./whatsapp");
    purgeConnectingSessionKeys();
  }
});
process.on("uncaughtException", (err) => {
  console.error(JSON.stringify({ tag: "process", msg: "uncaughtException", error: err.message, stack: err.stack }));
});
