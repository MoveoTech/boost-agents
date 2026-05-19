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
import type { Content } from "@google/generative-ai";

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
  const { prompt, id, oneTime } = req.body as { prompt: string; name: string; id: string; oneTime?: boolean };
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
    const { users } = await usersRes.json() as { users: { email: string; gmail: boolean; calendar: boolean; monday: boolean; tasks: boolean }[] };
    const results = [];
    for (const user of users) {
      try {
        const autoMondayToken = user.monday ? (await getUserAccessToken("monday", user.email).catch(() => null)) ?? undefined : undefined;
        const autoTasksUser = user.tasks ? user.email : undefined;
        const result = await chat(prompt, [], "tools", undefined,
          user.gmail ? user.email : undefined,
          user.calendar ? user.email : undefined,
          undefined, autoMondayToken, autoTasksUser,
        );
        results.push({ email: user.email, success: true, reply: result.reply });
      } catch (err) {
        results.push({ email: user.email, success: false, error: (err as Error).message });
      }
    }
    res.json({ ok: true, results });
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
    res.json({ gmail: !!user?.gmail, calendar: !!user?.calendar, monday: !!user?.monday, tasks: !!user?.tasks });
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
    const result = await chat(effectiveMessage.trim(), history, mode, systemPrompt, sessionEmail, sessionEmail, model, mondayToken, tasksUser, sessionEmail, imageAttachment);
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
  // Patch all Cloud Scheduler jobs with the current AUTOMATION_SECRET so
  // previously-created automations don't fail with 401 after a redeploy.
  resyncAutomationSecrets();
});
