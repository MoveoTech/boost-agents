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
    res.json({ isAdmin: true });
    return;
  }
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  const tokenToVerify = bearer ?? req.cookies[COOKIE_NAME];
  try {
    const payload = jwt.verify(tokenToVerify, COOKIE_SECRET) as { admin?: boolean };
    res.json({ isAdmin: !!payload.admin });
  } catch {
    res.json({ isAdmin: false });
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

app.get("/api/config", (_req, res) => {
  res.json(agentConfig);
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
  const { message, history = [], mode = "tools", systemPrompt, gmailUser, calendarUser } = req.body as {
    message: string;
    history: Content[];
    mode?: "search" | "tools";
    systemPrompt?: string;
    gmailUser?: string;
    calendarUser?: string;
  };

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const result = await chat(message.trim(), history, mode, systemPrompt, gmailUser, calendarUser);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Agent error",
      details: (err as Error).message,
    });
  }
});

// Fallback: serve the SPA for any non-API route (single-service mode)
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

const PORT = process.env.PORT ?? 8080;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
