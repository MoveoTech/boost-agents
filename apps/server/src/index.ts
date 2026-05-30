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
import { commitConfig, commitConfigToRepo, readConfigFromRepo } from "./configure";
import type { AgentConfig } from "./config";
import { listAutomations, upsertAutomation, deleteAutomation, runAutomationNow, resyncAutomationSecrets, getAutomation, patchAutomationBody } from "./automations";
import type { Automation, AutomationStep, RunHistoryEntry } from "./automations";
import { connectSession, disconnectSession, getStatus, initAllSessions, sendMessage as waSendMessage, flushAllSessions, type MentionHandler, type WhatsAppConfig, DEFAULT_WA_CONFIG } from "./whatsapp";
import { parseVCards, importContacts, listContacts } from "./contacts";
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
  limit: "20mb", // large enough for base64-encoded PDF/image attachments (~10MB file → ~13MB base64)
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

const CAN_CREATE_AGENTS = process.env.BOOST_HUB === "true";

app.get("/api/whoami", (req, res) => {
  if (!ACCESS_PASSWORD && !API_KEY) {
    res.json({ isAdmin: true, email: null, authenticated: true, canCreateAgents: CAN_CREATE_AGENTS });
    return;
  }
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  const tokenToVerify = bearer ?? req.cookies[COOKIE_NAME];
  try {
    const payload = jwt.verify(tokenToVerify, COOKIE_SECRET) as { admin?: boolean; email?: string };
    res.json({ isAdmin: !!payload.admin, email: payload.email ?? null, authenticated: true, canCreateAgents: CAN_CREATE_AGENTS });
  } catch {
    res.json({ isAdmin: false, email: null, authenticated: false, canCreateAgents: false });
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

// In-memory SSE listeners for webhook "catch" mode (admin listens for next incoming payload)
const webhookListeners = new Map<string, import("express").Response>();

const FLOW_TOOL_LABELS: Record<string, string> = {
  agent_prompt: "AI Model",
  condition: "Condition",
  google_tasks: "Google Tasks",
  whatsapp: "WhatsApp",
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  slack: "Slack",
  monday: "Monday.com",
  google_maps: "Google Maps",
  apollo: "Apollo.io",
  http_request: "HTTP Request",
  web_fetch: "Web Fetch",
  google_search: "Google Search",
};

interface StepResult {
  id: string;
  tool: string;
  output: string;
  error?: string;
  durationMs: number;
  conditionFailed?: boolean;
}

async function executeStepsSequentially(
  steps: AutomationStep[],
  gmailUser: string | undefined,
  calendarUser: string | undefined,
  mondayToken: string | undefined,
  tasksUser: string | undefined,
  whatsappUser: string | undefined,
  onStepStart?: (stepId: string, tool: string) => void,
  onStepDone?: (result: StepResult) => void,
  priorResults?: StepResult[],
  apolloApiKey?: string,
  googleMapsApiKey?: string,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let context = "";

  // Seed context from prior completed steps (retry-from-N support)
  if (priorResults?.length) {
    for (const pr of priorResults) {
      const label = FLOW_TOOL_LABELS[pr.tool] ?? pr.tool;
      if (pr.output) context += `\n[Prior Step — ${label}]:\n${pr.output}`;
    }
  }

  for (const step of steps) {
    onStepStart?.(step.id, step.tool);
    const stepStart = Date.now();
    const label = FLOW_TOOL_LABELS[step.tool] ?? step.tool;
    let instruction = step.instruction;
    if (step.tool === "http_request" && step.httpUrl) {
      instruction += ` Use HTTP ${step.httpMethod ?? "POST"} to ${step.httpUrl}.`;
      if (step.httpAuthHeader && step.httpAuthValue) {
        instruction += ` Include this header: "${step.httpAuthHeader}: ${step.httpAuthValue}".`;
      }
    }
    const prompt = context
      ? `Context from previous steps:\n${context}\n\nCurrent task (${label}): ${instruction}`
      : instruction;

    // Condition step: evaluate true/false and stop if not met
    if (step.tool === "condition") {
      const condPrompt = context
        ? `Based on the following context, evaluate this condition. Reply ONLY with "true" or "false", nothing else.\n\nContext:\n${context}\n\nCondition: ${instruction}`
        : `Evaluate this condition. Reply ONLY with "true" or "false", nothing else.\n\nCondition: ${instruction}`;
      try {
        const condResult = await chat(condPrompt, [], "no_tools");
        const passed = condResult.reply.trim().toLowerCase().startsWith("true");
        const stepResult: StepResult = {
          id: step.id, tool: step.tool, durationMs: Date.now() - stepStart,
          output: passed ? "Condition met — continuing" : "Condition not met — flow stopped",
          conditionFailed: !passed,
        };
        results.push(stepResult);
        onStepDone?.(stepResult);
        console.log(JSON.stringify({ tag: "flow", msg: "condition", stepId: step.id, passed, ms: stepResult.durationMs }));
        if (!passed) break;
        context += `\n[Step ${results.length} — ${label}]: Condition passed`;
      } catch (err) {
        const stepResult: StepResult = { id: step.id, tool: step.tool, output: "", error: (err as Error).message, durationMs: Date.now() - stepStart };
        results.push(stepResult);
        onStepDone?.(stepResult);
        console.log(JSON.stringify({ tag: "flow", msg: "step_error", stepId: step.id, tool: step.tool, error: stepResult.error }));
        break;
      }
      continue;
    }

    // Google Maps: direct API calls (geocode / places search / directions)
    if (step.tool === "google_maps") {
      const mapsKey = googleMapsApiKey ?? process.env.GOOGLE_MAPS_API_KEY;
      if (!mapsKey) {
        const stepResult: StepResult = { id: step.id, tool: step.tool, output: "", error: "GOOGLE_MAPS_API_KEY not configured", durationMs: Date.now() - stepStart };
        results.push(stepResult); onStepDone?.(stepResult); break;
      }
      try {
        const parsePrompt = `Parse this Google Maps request. Reply ONLY with JSON: {"type":"geocode"|"places"|"directions","query":"...","origin":"...","destination":"..."}\nFor geocode: address lookup. For places: business/POI search. For directions: include origin and destination.\nInstruction: ${instruction}`;
        const parsed = await chat(parsePrompt, [], "no_tools");
        const q = JSON.parse(parsed.reply.match(/\{[\s\S]*?\}/)?.[0] ?? "{}") as { type?: string; query?: string; origin?: string; destination?: string };
        let mapsData: string;
        if (q.type === "directions" && q.origin && q.destination) {
          const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(q.origin)}&destination=${encodeURIComponent(q.destination)}&key=${mapsKey}`;
          const r = await fetch(url); const data = await r.json() as { routes?: Array<{ legs?: Array<{ start_address?: string; end_address?: string; distance?: { text: string }; duration?: { text: string }; steps?: Array<{ html_instructions?: string; distance?: { text: string } }> }> }> };
          const leg = data.routes?.[0]?.legs?.[0];
          mapsData = leg ? `From: ${leg.start_address}\nTo: ${leg.end_address}\nDistance: ${leg.distance?.text}\nDuration: ${leg.duration?.text}\nSteps:\n${leg.steps?.slice(0, 8).map((s) => `  - ${s.html_instructions?.replace(/<[^>]+>/g, "")} (${s.distance?.text})`).join("\n")}` : "No route found";
        } else if (q.type === "geocode" && q.query) {
          const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q.query)}&key=${mapsKey}`;
          const r = await fetch(url); const data = await r.json() as { results?: Array<{ formatted_address?: string; geometry?: { location?: { lat: number; lng: number } } }> };
          mapsData = data.results?.slice(0, 3).map((p) => `${p.formatted_address} (${p.geometry?.location?.lat}, ${p.geometry?.location?.lng})`).join("\n") ?? "No results";
        } else {
          const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q.query ?? instruction)}&key=${mapsKey}`;
          const r = await fetch(url); const data = await r.json() as { results?: Array<{ name?: string; formatted_address?: string; rating?: number; user_ratings_total?: number; opening_hours?: { open_now?: boolean } }> };
          mapsData = data.results?.slice(0, 6).map((p) => `${p.name}: ${p.formatted_address}${p.rating ? ` ★${p.rating} (${p.user_ratings_total})` : ""}${p.opening_hours ? ` — ${p.opening_hours.open_now ? "Open" : "Closed"}` : ""}`).join("\n") ?? "No places found";
        }
        const sumPrompt = context ? `Context:\n${context}\n\nGoogle Maps result for "${instruction}":\n${mapsData}\n\nPresent this clearly.` : `Google Maps result for "${instruction}":\n${mapsData}\n\nPresent this clearly.`;
        const summary = await chat(sumPrompt, [], "no_tools");
        const stepResult: StepResult = { id: step.id, tool: step.tool, output: summary.reply, durationMs: Date.now() - stepStart };
        results.push(stepResult); onStepDone?.(stepResult);
        console.log(JSON.stringify({ tag: "flow", msg: "step_ok", stepId: step.id, tool: step.tool, ms: stepResult.durationMs }));
        context += `\n[Step ${results.length} — Google Maps]:\n${summary.reply}`;
      } catch (err) {
        const stepResult: StepResult = { id: step.id, tool: step.tool, output: "", error: (err as Error).message, durationMs: Date.now() - stepStart };
        results.push(stepResult); onStepDone?.(stepResult);
        console.log(JSON.stringify({ tag: "flow", msg: "step_error", stepId: step.id, tool: step.tool, error: stepResult.error, ms: stepResult.durationMs }));
        break;
      }
      continue;
    }

    // Apollo.io: people/org search and enrichment via REST API
    if (step.tool === "apollo") {
      if (!apolloApiKey) {
        const stepResult: StepResult = { id: step.id, tool: step.tool, output: "", error: "Apollo.io API key not configured — add it in My Connections", durationMs: Date.now() - stepStart };
        results.push(stepResult); onStepDone?.(stepResult); break;
      }
      try {
        const parsePrompt = `Parse this Apollo.io request. Reply ONLY with JSON: {"type":"people_search"|"org_search"|"person_enrich"|"org_enrich","params":{...}}\npeople_search params: person_titles[], q_organization_name, person_seniorities[], num_employees_ranges[]\norg_search params: q_organization_name, organization_industry_tag_ids[], num_employees_ranges[]\nperson_enrich params: email OR (first_name, last_name, domain)\norg_enrich params: domain OR name\nInstruction: ${instruction}`;
        const parsed = await chat(parsePrompt, [], "no_tools");
        const q = JSON.parse(parsed.reply.match(/\{[\s\S]*?\}/)?.[0] ?? "{}") as { type?: string; params?: Record<string, unknown> };
        const headers = { "x-api-key": apolloApiKey, "Content-Type": "application/json", "Cache-Control": "no-cache" };
        let apolloResult: unknown;
        if (q.type === "people_search") {
          const r = await fetch("https://api.apollo.io/api/v1/mixed_people/search", { method: "POST", headers, body: JSON.stringify({ page: 1, per_page: 10, ...q.params }) });
          const data = await r.json() as { people?: Array<{ name?: string; title?: string; organization_name?: string; email?: string; linkedin_url?: string; city?: string; state?: string; country?: string }> };
          apolloResult = (data.people ?? []).slice(0, 10).map((p) => ({ name: p.name, title: p.title, company: p.organization_name, email: p.email, linkedin: p.linkedin_url, location: [p.city, p.state, p.country].filter(Boolean).join(", ") }));
        } else if (q.type === "org_search") {
          const r = await fetch("https://api.apollo.io/api/v1/mixed_companies/search", { method: "POST", headers, body: JSON.stringify({ page: 1, per_page: 10, ...q.params }) });
          const data = await r.json() as { organizations?: Array<{ name?: string; website_url?: string; industry?: string; estimated_num_employees?: number; city?: string; country?: string }> };
          apolloResult = (data.organizations ?? []).slice(0, 10).map((o) => ({ name: o.name, website: o.website_url, industry: o.industry, employees: o.estimated_num_employees, location: [o.city, o.country].filter(Boolean).join(", ") }));
        } else if (q.type === "person_enrich") {
          const r = await fetch("https://api.apollo.io/api/v1/people/match", { method: "POST", headers, body: JSON.stringify({ reveal_personal_emails: true, ...q.params }) });
          apolloResult = await r.json();
        } else {
          const r = await fetch("https://api.apollo.io/api/v1/organizations/enrich", { method: "POST", headers, body: JSON.stringify(q.params) });
          apolloResult = await r.json();
        }
        const sumPrompt = context ? `Context:\n${context}\n\nApollo.io data for "${instruction}":\n${JSON.stringify(apolloResult, null, 2)}\n\nPresent this clearly and concisely.` : `Apollo.io data for "${instruction}":\n${JSON.stringify(apolloResult, null, 2)}\n\nPresent this clearly and concisely.`;
        const summary = await chat(sumPrompt, [], "no_tools");
        const stepResult: StepResult = { id: step.id, tool: step.tool, output: summary.reply, durationMs: Date.now() - stepStart };
        results.push(stepResult); onStepDone?.(stepResult);
        console.log(JSON.stringify({ tag: "flow", msg: "step_ok", stepId: step.id, tool: step.tool, ms: stepResult.durationMs }));
        context += `\n[Step ${results.length} — Apollo.io]:\n${summary.reply}`;
      } catch (err) {
        const stepResult: StepResult = { id: step.id, tool: step.tool, output: "", error: (err as Error).message, durationMs: Date.now() - stepStart };
        results.push(stepResult); onStepDone?.(stepResult);
        console.log(JSON.stringify({ tag: "flow", msg: "step_error", stepId: step.id, tool: step.tool, error: stepResult.error, ms: stepResult.durationMs }));
        break;
      }
      continue;
    }

    const isLlmStep = step.tool === "agent_prompt";
    const systemPrompt = isLlmStep
      ? "Process and transform the provided information. Return a concise, structured result. Do not call any tools."
      : undefined;
    const mode = isLlmStep ? "no_tools" : "tools";

    try {
      const result = await chat(prompt, [], mode, systemPrompt, gmailUser, calendarUser, undefined, mondayToken, tasksUser, undefined, undefined, whatsappUser);
      const stepResult: StepResult = { id: step.id, tool: step.tool, output: result.reply, durationMs: Date.now() - stepStart };
      results.push(stepResult);
      onStepDone?.(stepResult);
      console.log(JSON.stringify({ tag: "flow", msg: "step_ok", stepId: step.id, tool: step.tool, ms: stepResult.durationMs }));
      context += `\n[Step ${results.length} — ${label}]:\n${result.reply}`;
    } catch (err) {
      const stepResult: StepResult = { id: step.id, tool: step.tool, output: "", error: (err as Error).message, durationMs: Date.now() - stepStart };
      results.push(stepResult);
      onStepDone?.(stepResult);
      console.log(JSON.stringify({ tag: "flow", msg: "step_error", stepId: step.id, tool: step.tool, error: stepResult.error, ms: stepResult.durationMs }));
      break;
    }
  }
  return results;
}

// Called by Cloud Scheduler — no user JWT, secured by AUTOMATION_SECRET header
app.post("/api/run-automation", async (req, res) => {
  if (req.headers["x-automation-secret"] !== process.env.AUTOMATION_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { steps, id, oneTime, createdBy } = req.body as { steps?: AutomationStep[]; name: string; id: string; oneTime?: boolean; createdBy?: string };
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
    const mondayToken = user.monday ? (await getUserAccessToken("monday", user.email).catch(() => null)) ?? undefined : undefined;
    const whatsappUser = getStatus(user.email) === "connected" ? user.email : undefined;
    let apolloApiKeyCron: string | undefined;
    let googleMapsApiKeyCron: string | undefined;
    try {
      const settingsRes = await fetch(`${oauthServiceUrl}/api/user-settings/${agentId}/${encodeURIComponent(user.email)}`, { headers: { "x-api-key": oauthServiceKey } });
      if (settingsRes.ok) { const s = await settingsRes.json() as { apolloApiKey?: string; googleMapsApiKey?: string }; apolloApiKeyCron = s.apolloApiKey; googleMapsApiKeyCron = s.googleMapsApiKey; }
    } catch { /* non-fatal — fall back to env vars */ }
    const runStart = Date.now();
    const stepResults = await executeStepsSequentially(
      steps ?? [],
      user.gmail ? user.email : undefined,
      user.calendar ? user.email : undefined,
      mondayToken,
      user.tasks ? user.email : undefined,
      whatsappUser,
      undefined,
      undefined,
      undefined,
      apolloApiKeyCron,
      googleMapsApiKeyCron,
    );
    res.json({ ok: true, stepResults });
    // Async post-run: save history + notify on failure
    const { notifyOnFailure } = req.body as { notifyOnFailure?: boolean };
    const hasError = stepResults.some((r) => r.error);
    const historyEntry: RunHistoryEntry = {
      runAt: new Date().toISOString(),
      status: hasError ? (stepResults.some((r) => !r.error && !r.conditionFailed) ? "partial" : "error") : "success",
      durationMs: Date.now() - runStart,
      steps: stepResults.map((r) => ({ id: r.id, tool: r.tool, output: r.output.slice(0, 400), error: r.error, durationMs: r.durationMs, conditionFailed: r.conditionFailed })),
    };
    if (id) {
      patchAutomationBody(id, { runHistory: [historyEntry] }).catch(() => {});
    }
    if (notifyOnFailure && hasError && whatsappUser) {
      const failed = stepResults.find((r) => r.error);
      if (failed) {
        const msg = `⚠️ Flow failed at step: ${FLOW_TOOL_LABELS[failed.tool] ?? failed.tool}\n\nError: ${failed.error}`;
        waSendMessage(whatsappUser, whatsappUser, msg).catch(() => {});
      }
    }
    if (oneTime && id) {
      await deleteAutomation(id).catch(() => {});
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Webhook-triggered flows ───────────────────────────────────────────────────

// Public endpoint — third-party apps POST here to trigger a flow.
// Auth: X-Webhook-Secret header must match the stored secret.
// If an admin SSE listener is active (catch mode), payload is forwarded there instead of running the flow.
app.post("/api/webhooks/:webhookId", async (req, res) => {
  const { webhookId } = req.params;
  const payload = req.body as Record<string, unknown>;

  // Check for active catch-mode listener first — admin already authed to open SSE,
  // so accept payload even when flow is unsaved or disabled
  const listener = webhookListeners.get(webhookId);
  if (listener) {
    res.json({ ok: true, received: true });
    try { listener.write(`data: ${JSON.stringify({ type: "payload", payload })}\n\n`); } catch {}
    return;
  }

  let automation: Automation | undefined;
  try {
    const all = await listAutomations();
    automation = all.find((a) => a.webhookId === webhookId);
  } catch {
    res.status(503).json({ error: "Service unavailable" });
    return;
  }

  if (!automation || !automation.enabled) {
    res.status(404).json({ error: "Webhook not found" });
    return;
  }

  const incomingSecret = req.headers["x-webhook-secret"] as string | undefined;
  if (automation.webhookSecret && incomingSecret !== automation.webhookSecret) {
    res.status(401).json({ error: "Invalid webhook secret" });
    return;
  }

  // Respond 200 immediately — third-party apps must not wait
  res.json({ ok: true, received: true });

  // Run the flow in background
  if (!automation.createdBy) return;

  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !oauthServiceKey || !agentId) return;

  const snap = automation; // capture for async closure
  (async () => {
    try {
      const usersRes = await fetch(`${oauthServiceUrl}/api/users/${agentId}`, { headers: { "x-api-key": oauthServiceKey } });
      const { users } = await usersRes.json() as { users: { email: string; gmail: boolean; calendar: boolean; monday: boolean; tasks: boolean }[] };
      const user = users.find((u) => u.email === snap.createdBy);
      if (!user) return;

      const mondayToken = user.monday ? (await getUserAccessToken("monday", user.email).catch(() => null)) ?? undefined : undefined;
      const whatsappUser = getStatus(user.email) === "connected" ? user.email : undefined;
      let apolloApiKey: string | undefined;
      let googleMapsApiKey: string | undefined;
      try {
        const settingsRes = await fetch(`${oauthServiceUrl}/api/user-settings/${agentId}/${encodeURIComponent(user.email)}`, { headers: { "x-api-key": oauthServiceKey } });
        if (settingsRes.ok) {
          const s = await settingsRes.json() as { apolloApiKey?: string; googleMapsApiKey?: string };
          apolloApiKey = s.apolloApiKey;
          googleMapsApiKey = s.googleMapsApiKey;
        }
      } catch { /* non-fatal */ }

      // Inject webhook payload as first context step
      const contextStep: AutomationStep = {
        id: "_webhook_ctx",
        tool: "agent_prompt",
        instruction: `A webhook was triggered with the following payload:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\nRemember this data and use it in subsequent steps as instructed.`,
      };

      const runStart = Date.now();
      const stepResults = await executeStepsSequentially(
        [contextStep, ...snap.steps],
        user.gmail ? user.email : undefined,
        user.calendar ? user.email : undefined,
        mondayToken,
        user.tasks ? user.email : undefined,
        whatsappUser,
        undefined, undefined, undefined,
        apolloApiKey, googleMapsApiKey,
      );

      const hasError = stepResults.some((r) => r.error);
      const historyEntry: RunHistoryEntry = {
        runAt: new Date().toISOString(),
        status: hasError ? (stepResults.some((r) => !r.error && !r.conditionFailed) ? "partial" : "error") : "success",
        durationMs: Date.now() - runStart,
        steps: stepResults.map((r) => ({ id: r.id, tool: r.tool, output: r.output.slice(0, 400), error: r.error, durationMs: r.durationMs, conditionFailed: r.conditionFailed })),
      };
      patchAutomationBody(snap.id, { runHistory: [historyEntry] }).catch(() => {});

      if (snap.notifyOnFailure && hasError && whatsappUser) {
        const failed = stepResults.find((r) => r.error);
        if (failed) {
          waSendMessage(whatsappUser, whatsappUser, `⚠️ Flow "${snap.name}" webhook run failed at: ${FLOW_TOOL_LABELS[failed.tool] ?? failed.tool}\n\nError: ${failed.error}`).catch(() => {});
        }
      }
    } catch (err) {
      console.error("[webhook] flow execution error:", (err as Error).message);
    }
  })();
});

// Admin SSE endpoint — admin opens this to catch the next incoming webhook payload.
// When a POST arrives at /api/webhooks/:webhookId while this listener is open, the payload
// is forwarded here and the flow is NOT run (catch-only mode, 60s timeout).
app.get("/api/webhooks/:webhookId/listen", requireAdmin, (req, res) => {
  const { webhookId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  webhookListeners.set(webhookId, res);
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  const timeout = setTimeout(() => {
    webhookListeners.delete(webhookId);
    res.write(`data: ${JSON.stringify({ type: "timeout" })}\n\n`);
    res.end();
  }, 60000);

  req.on("close", () => {
    clearTimeout(timeout);
    webhookListeners.delete(webhookId);
  });
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
app.post("/api/auth/identity/complete", async (req, res) => {
  const { identityToken } = req.body as { identityToken: string };
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthKey = process.env.OAUTH_SERVICE_KEY ?? "";
  try {
    let email: string;
    if (oauthServiceUrl) {
      // Verify via oauth-service so per-agent keys work (agent key ≠ master signing key)
      const r = await fetch(`${oauthServiceUrl}/api/auth/identity/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": oauthKey },
        body: JSON.stringify({ identityToken }),
      });
      if (!r.ok) throw new Error("Invalid token");
      ({ email } = await r.json() as { email: string });
    } else {
      // Fallback: local verification (only works when OAUTH_SERVICE_KEY is the master key)
      const payload = jwt.verify(identityToken, oauthKey) as { email: string; type: string };
      if (payload.type !== "identity") throw new Error("Invalid token type");
      email = payload.email;
    }
    if (CAN_CREATE_AGENTS && !email.endsWith("@moveoboost.com")) {
      res.status(403).json({ error: "Access to this hub is restricted to @moveoboost.com accounts." });
      return;
    }
    const isAdmin = ADMIN_EMAILS.size === 0 || ADMIN_EMAILS.has(email);
    const token = jwt.sign({ ok: true, admin: isAdmin, email }, COOKIE_SECRET, { expiresIn: "7d" });
    res.cookie(COOKIE_NAME, token, { httpOnly: true, secure: IS_PROD, sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, token, isAdmin, email });
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

app.get("/api/auth/google/start", async (req, res) => {
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !agentId) {
    res.status(500).json({ error: "OAuth service not configured" });
    return;
  }
  // If this agent has its own Google OAuth app, register credentials now (synchronous,
  // so they're guaranteed in Firestore before the oauth-service handles the redirect).
  const ownClientId = process.env.GOOGLE_CLIENT_ID;
  const ownClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (ownClientId && ownClientSecret && oauthServiceKey) {
    try {
      await fetch(`${oauthServiceUrl}/api/agent-oauth-creds/${agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": oauthServiceKey },
        body: JSON.stringify({ clientId: ownClientId, clientSecret: ownClientSecret }),
      });
    } catch (err) {
      console.warn(`Failed to register agent OAuth credentials: ${(err as Error).message}`);
    }
  }
  const agentUrl = (req.query.returnUrl as string) || `${req.protocol}://${req.get("host")}`;
  const service = (req.query.service as string) || "gmail";
  const params = new URLSearchParams({ agentId, agentUrl, service });
  const extra = (agentConfig as any).extraOAuthScopes?.[service];
  if (extra?.length) params.set("extraScopes", extra.join(" "));
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

app.post("/api/flows/:id/run-direct", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !oauthServiceKey || !agentId) {
    res.status(500).json({ error: "Not configured" });
    return;
  }
  try {
    const automation = await getAutomation(id);
    if (!automation) { res.status(404).json({ error: "Flow not found" }); return; }
    if (!automation.createdBy) { res.status(400).json({ error: "Flow has no owner" }); return; }
    const usersRes = await fetch(`${oauthServiceUrl}/api/users/${agentId}`, {
      headers: { "x-api-key": oauthServiceKey },
    });
    const { users } = await usersRes.json() as { users: { email: string; gmail: boolean; calendar: boolean; monday: boolean; tasks: boolean }[] };
    const user = users.find((u) => u.email === automation.createdBy);
    if (!user) { res.status(404).json({ error: `User ${automation.createdBy} not found` }); return; }
    const mondayToken = user.monday ? (await getUserAccessToken("monday", user.email).catch(() => null)) ?? undefined : undefined;
    const whatsappUser = getStatus(user.email) === "connected" ? user.email : undefined;
    let apolloApiKeyDirect: string | undefined;
    let googleMapsApiKeyDirect: string | undefined;
    try {
      const settingsRes = await fetch(`${oauthServiceUrl}/api/user-settings/${agentId}/${encodeURIComponent(user.email)}`, { headers: { "x-api-key": oauthServiceKey } });
      if (settingsRes.ok) { const s = await settingsRes.json() as { apolloApiKey?: string; googleMapsApiKey?: string }; apolloApiKeyDirect = s.apolloApiKey; googleMapsApiKeyDirect = s.googleMapsApiKey; }
    } catch { /* non-fatal */ }
    const runStart = Date.now();
    const stepResults = await executeStepsSequentially(
      automation.steps,
      user.gmail ? user.email : undefined,
      user.calendar ? user.email : undefined,
      mondayToken,
      user.tasks ? user.email : undefined,
      whatsappUser,
      undefined,
      undefined,
      undefined,
      apolloApiKeyDirect,
      googleMapsApiKeyDirect,
    );
    res.json({ ok: true, stepResults });
    const hasError = stepResults.some((r) => r.error);
    const historyEntry: RunHistoryEntry = {
      runAt: new Date().toISOString(),
      status: hasError ? (stepResults.some((r) => !r.error && !r.conditionFailed) ? "partial" : "error") : "success",
      durationMs: Date.now() - runStart,
      steps: stepResults.map((r) => ({ id: r.id, tool: r.tool, output: r.output.slice(0, 400), error: r.error, durationMs: r.durationMs, conditionFailed: r.conditionFailed })),
    };
    patchAutomationBody(id, { runHistory: [historyEntry] }).catch(() => {});
    if (automation.notifyOnFailure && hasError && whatsappUser) {
      const failed = stepResults.find((r) => r.error);
      if (failed) {
        const msg = `⚠️ Flow "${automation.name}" failed at: ${FLOW_TOOL_LABELS[failed.tool] ?? failed.tool}\n\nError: ${failed.error}`;
        waSendMessage(whatsappUser, whatsappUser, msg).catch(() => {});
      }
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// SSE endpoint — streams each step result as it completes; accepts steps inline (no saved ID needed)
app.post("/api/flows/run-steps", requireAdmin, async (req, res) => {
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
  const tokenToVerify = bearer ?? (req as any).cookies[COOKIE_NAME];
  let userEmail: string | undefined;
  try {
    const payload = jwt.verify(tokenToVerify, COOKIE_SECRET) as { email?: string };
    userEmail = payload.email;
  } catch { /* ignore — requireAdmin already verified */ }

  const { steps, priorResults } = req.body as { steps: AutomationStep[]; priorResults?: StepResult[] };
  if (!steps?.length) { res.status(400).json({ error: "steps required" }); return; }

  const oauthServiceUrl = process.env.OAUTH_SERVICE_URL;
  const oauthServiceKey = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!oauthServiceUrl || !oauthServiceKey || !agentId) {
    res.status(500).json({ error: "Not configured" }); return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: object | string) => {
    try { res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ }
  };

  try {
    let gmailUser: string | undefined;
    let calendarUser: string | undefined;
    let mondayToken: string | undefined;
    let tasksUser: string | undefined;
    let whatsappUser: string | undefined;
    let apolloApiKey: string | undefined;
    let googleMapsApiKey: string | undefined;

    if (userEmail) {
      const [usersRes, settingsRes] = await Promise.all([
        fetch(`${oauthServiceUrl}/api/users/${agentId}`, { headers: { "x-api-key": oauthServiceKey } }),
        fetch(`${oauthServiceUrl}/api/user-settings/${agentId}/${encodeURIComponent(userEmail)}`, { headers: { "x-api-key": oauthServiceKey } }),
      ]);
      const { users } = await usersRes.json() as { users: { email: string; gmail: boolean; calendar: boolean; monday: boolean; tasks: boolean }[] };
      const user = users.find((u) => u.email === userEmail);
      if (user) {
        gmailUser = user.gmail ? user.email : undefined;
        calendarUser = user.calendar ? user.email : undefined;
        mondayToken = user.monday ? (await getUserAccessToken("monday", user.email).catch(() => null)) ?? undefined : undefined;
        tasksUser = user.tasks ? user.email : undefined;
        whatsappUser = getStatus(user.email) === "connected" ? user.email : undefined;
      }
      if (settingsRes.ok) {
        const settings = await settingsRes.json() as { apolloApiKey?: string; googleMapsApiKey?: string };
        apolloApiKey = settings.apolloApiKey;
        googleMapsApiKey = settings.googleMapsApiKey;
      }
    }

    await executeStepsSequentially(
      steps,
      gmailUser,
      calendarUser,
      mondayToken,
      tasksUser,
      whatsappUser,
      (stepId, tool) => send({ type: "start", stepId, tool }),
      (result) => send({ type: "done", ...result }),
      priorResults,
      apolloApiKey,
      googleMapsApiKey,
    );
  } catch (err) {
    send({ type: "error", error: (err as Error).message });
  }

  send("[DONE]");
  res.end();
});

app.post("/api/flows/generate", requireAdmin, async (req, res) => {
  const { description, connectedTools, webhookPayloadSchema } = req.body as { description: string; connectedTools: string[]; webhookPayloadSchema?: Record<string, unknown> };
  if (!description?.trim()) { res.status(400).json({ error: "description required" }); return; }

  const toolList = connectedTools.length
    ? connectedTools.map((k) => FLOW_TOOL_LABELS[k] ?? k).join(", ")
    : Object.values(FLOW_TOOL_LABELS).join(", ");

  const schemaSection = webhookPayloadSchema
    ? `\n\nWebhook payload schema (the trigger provides this data — reference fields in step instructions using the field paths below):\n${JSON.stringify(webhookPayloadSchema, null, 2)}\n\nThe first step will automatically receive this webhook data as context. Reference fields directly in step instructions (e.g. "use payload.item.name").`
    : "";

  const systemPrompt = `You are an automation flow designer. Given a description of what a user wants to automate, generate a structured list of steps.

Available tool keys: ${connectedTools.length ? connectedTools.join(", ") : Object.keys(FLOW_TOOL_LABELS).join(", ")}, agent_prompt
Available tool labels: ${toolList}, AI Processing${schemaSection}

Return ONLY valid JSON — no markdown, no explanation. Format:
{
  "suggestedName": "...",
  "suggestedSchedule": "0 9 * * *",
  "steps": [
    { "id": "step-1", "tool": "<tool_key>", "instruction": "..." },
    { "id": "step-2", "tool": "<tool_key>", "instruction": "... using results from step 1 ..." }
  ]
}

Tool selection rules:
- Use "agent_prompt" for ANY reasoning, filtering, summarizing, formatting, classification, or data transformation. This calls the AI model internally — no external HTTP needed. This is the correct tool for "summarize", "generate", "format", "analyze", etc.
- NEVER use "http_request" unless the user's description explicitly names a specific real external API with a URL (e.g. "call the FlightAware API at https://..."). NEVER invent or guess an httpUrl. NEVER use http_request for tasks our own server can handle (AI processing, tool integrations).
- If you would need to invent an httpUrl, use "agent_prompt" instead.
- Use service-specific tools (gmail, google_tasks, whatsapp, etc.) for interacting with those services.
- Step instructions should reference prior steps naturally (e.g. "using the tasks from step 1")
- suggestedSchedule must be a valid cron expression`;

  try {
    const result = await chat(description, [], "no_tools", systemPrompt);
    const jsonMatch = result.reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { res.status(500).json({ error: "LLM did not return valid JSON" }); return; }
    const parsed = JSON.parse(jsonMatch[0]) as { suggestedName?: string; suggestedSchedule?: string; steps?: AutomationStep[] };
    res.json({
      suggestedName: parsed.suggestedName ?? "",
      suggestedSchedule: parsed.suggestedSchedule ?? "0 9 * * *",
      steps: (parsed.steps ?? []).map((s, i) => ({ ...s, id: s.id ?? `step-${i + 1}` })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/flows/suggest", requireAdmin, async (req, res) => {
  const { webhookPayloadSchema, connectedTools } = req.body as { webhookPayloadSchema: Record<string, unknown>; connectedTools: string[] };
  if (!webhookPayloadSchema) { res.status(400).json({ error: "webhookPayloadSchema required" }); return; }

  const toolList = (connectedTools ?? []).length
    ? connectedTools.map((k) => FLOW_TOOL_LABELS[k] ?? k).join(", ")
    : Object.values(FLOW_TOOL_LABELS).join(", ");

  const systemPrompt = `You are a workflow automation expert. Given a webhook payload schema (field names with types, not real values) and a list of available integration tools, suggest ONE specific high-value automation flow.

Available tools: ${toolList}

Respond with 2-3 sentences only. Name actual fields from the schema and actual tools. Be concrete and actionable. No bullet points, no headers, no caveats.`;

  try {
    const result = await chat(
      `Webhook payload schema:\n${JSON.stringify(webhookPayloadSchema, null, 2)}\n\nWhat flow should I build?`,
      [], "no_tools", systemPrompt
    );
    res.json({ suggestion: result.reply });
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

app.post("/api/connections/validate-key", async (req, res) => {
  const { service, key } = req.body as { service: string; key: string };
  if (!service || !key) { res.status(400).json({ ok: false, error: "service and key required" }); return; }
  try {
    if (service === "apollo") {
      const r = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
        method: "POST",
        headers: { "x-api-key": key, "Content-Type": "application/json", "Cache-Control": "no-cache" },
        body: JSON.stringify({ per_page: 1 }),
        signal: AbortSignal.timeout(8_000),
      });
      if (r.status === 401 || r.status === 403) { res.json({ ok: false, error: "Invalid API key" }); return; }
      res.json({ ok: r.ok || r.status < 500 });
    } else if (service === "google_maps") {
      const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=London&key=${encodeURIComponent(key)}`, {
        signal: AbortSignal.timeout(8_000),
      });
      const data = await r.json() as { status: string; error_message?: string };
      if (data.status === "REQUEST_DENIED") { res.json({ ok: false, error: data.error_message ?? "Invalid API key" }); return; }
      res.json({ ok: true });
    } else {
      res.status(400).json({ ok: false, error: "Unknown service" });
    }
  } catch (err) {
    res.json({ ok: false, error: (err as Error).message });
  }
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
    const waStatus = getStatus(email);
    // Fetch all WhatsApp users registered to this agent so the UI can show whether
    // another user has already connected (we only allow one WhatsApp owner per agent).
    let whatsappOwners: string[] = [];
    try {
      const waRes = await fetch(`${oauthServiceUrl}/api/whatsapp/${agentId}`, { headers: { "x-api-key": oauthServiceKey } });
      if (waRes.ok) {
        const data = await waRes.json() as { users?: string[] };
        whatsappOwners = data.users ?? [];
      }
    } catch { /* non-fatal — UI just won't show the lockout message */ }
    res.json({ gmail: !!user?.gmail, calendar: !!user?.calendar, monday: !!user?.monday, tasks: !!user?.tasks, whatsapp: waStatus === "connected", whatsappStatus: waStatus, whatsappOwners, googleMaps: !!process.env.GOOGLE_MAPS_API_KEY });
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

// Trigger the create-agent.yml GitHub Actions workflow to provision a new agent repo
app.post("/api/admin/create-agent", requireAdmin, async (req, res) => {
  const { agentName, geminiApiKey, adminEmails, oauthEmails, anthropicApiKey, openaiApiKey } = req.body as {
    agentName: string; geminiApiKey: string; adminEmails?: string;
    oauthEmails?: string; anthropicApiKey?: string; openaiApiKey?: string;
  };

  if (!agentName?.trim() || !geminiApiKey?.trim()) {
    res.status(400).json({ error: "agentName and geminiApiKey are required" });
    return;
  }

  const ghPat = process.env.GH_PAT;
  if (!ghPat) {
    res.status(500).json({ error: "GH_PAT not configured on this server" });
    return;
  }

  try {
    const r = await fetch(
      "https://api.github.com/repos/MoveoTech/boost-agents/actions/workflows/create-agent.yml/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ghPat}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            agent_name: agentName.trim(),
            gemini_api_key: geminiApiKey.trim(),
            admin_emails: adminEmails?.trim() ?? "",
            oauth_emails: oauthEmails?.trim() ?? "",
            anthropic_api_key: anthropicApiKey?.trim() ?? "",
            openai_api_key: openaiApiKey?.trim() ?? "",
          },
        }),
      }
    );

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ error: `GitHub returned ${r.status}: ${txt}` });
      return;
    }

    const repoName = agentName.trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .replace(/^boost-/, "")
      .slice(0, 30);

    // Wait for GitHub to register the dispatched run, then capture its ID
    await new Promise((resolve) => setTimeout(resolve, 3000));
    let createRunId: number | undefined;
    try {
      const runsRes = await fetch(
        "https://api.github.com/repos/MoveoTech/boost-agents/actions/runs?workflow_id=create-agent.yml&branch=main&per_page=1",
        { headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json" } }
      );
      if (runsRes.ok) {
        const runsData = await runsRes.json() as any;
        createRunId = runsData.workflow_runs?.[0]?.id;
      }
    } catch { /* non-fatal */ }

    // Register agent in Firestore via oauth-service (non-fatal if it fails)
    const oauthMasterKey = process.env.OAUTH_MASTER_KEY ?? "";
    const oauthUrl = process.env.OAUTH_SERVICE_URL ?? "";
    const gcpProject = `boost-${repoName}-v7`;
    if (oauthMasterKey && oauthUrl) {
      fetch(`${oauthUrl}/api/admin/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": oauthMasterKey },
        body: JSON.stringify({
          repoName,
          agentId: gcpProject,
          adminEmails: adminEmails?.trim() ?? "",
          createdBy: getSessionEmail(req) ?? "",
        }),
      }).catch(() => {});
    }

    res.json({
      ok: true,
      repoName,
      createRunId,
      actionsUrl: "https://github.com/MoveoTech/boost-agents/actions/workflows/create-agent.yml",
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/admin/agent-status", requireAdmin, async (req, res) => {
  const repoName = req.query.repoName as string;
  if (!repoName) { res.status(400).json({ error: "repoName required" }); return; }
  const ghPat = process.env.GH_PAT;
  try {
    const r = await fetch(
      `https://api.github.com/repos/MoveoTech/${repoName}/actions/runs?workflow_id=deploy.yml&branch=main&per_page=1`,
      {
        headers: {
          ...(ghPat ? { Authorization: `Bearer ${ghPat}` } : {}),
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!r.ok) { res.json({ status: "pending" }); return; }
    const data = await r.json() as any;
    const run = data.workflow_runs?.[0];
    if (!run) { res.json({ status: "pending" }); return; }
    const status = run.status === "completed"
      ? (run.conclusion === "success" ? "success" : "failed")
      : "in_progress";

    // On success, fetch the agent URL from Firestore via oauth-service
    let agentUrl: string | undefined;
    if (status === "success") {
      const gcpProject = `boost-${repoName}-v7`;
      const oauthUrl = process.env.OAUTH_SERVICE_URL ?? "";
      const oauthKey = process.env.OAUTH_MASTER_KEY || process.env.OAUTH_SERVICE_KEY || "";
      try {
        const agentRes = await fetch(`${oauthUrl}/api/admin/agents`, { headers: { "x-api-key": oauthKey } });
        if (agentRes.ok) {
          const agents = await agentRes.json() as Array<{ agentId: string; agentUrl?: string }>;
          agentUrl = agents.find((a) => a.agentId === gcpProject)?.agentUrl;
        }
      } catch { /* non-fatal */ }
    }

    res.json({ status, runUrl: run.html_url, agentUrl });
  } catch {
    res.json({ status: "pending" });
  }
});

// Infra: grant a GitHub user push access to an agent repo.
// Not called yet — activate once workers are added to the MoveoTech org.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function addCollaboratorToRepo(repoName: string, githubUsername: string): Promise<void> {
  const ghPat = process.env.GH_PAT;
  if (!ghPat || !githubUsername || !repoName) return;
  await fetch(`https://api.github.com/repos/MoveoTech/${repoName}/collaborators/${encodeURIComponent(githubUsername)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ permission: "push" }),
  });
}

app.post("/api/admin/retry-deploy", requireAdmin, async (req, res) => {
  const { repoName } = req.body as { repoName: string };
  if (!repoName) { res.status(400).json({ error: "repoName required" }); return; }
  const ghPat = process.env.GH_PAT;
  if (!ghPat) { res.status(500).json({ error: "GH_PAT not configured" }); return; }
  try {
    const r = await fetch(
      `https://api.github.com/repos/MoveoTech/${repoName}/actions/workflows/deploy.yml/dispatches`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main" }),
      }
    );
    if (r.status === 404) {
      res.status(404).json({ error: "Repo not found — the initial setup likely failed. Contact boazt@moveoboost.com." });
      return;
    }
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      res.status(502).json({ error: `GitHub returned ${r.status}: ${txt}` });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
    let runId: number | undefined;
    try {
      const runsRes = await fetch(
        `https://api.github.com/repos/MoveoTech/${repoName}/actions/runs?workflow_id=deploy.yml&branch=main&per_page=1`,
        { headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json" } }
      );
      if (runsRes.ok) {
        const data = await runsRes.json() as any;
        runId = data.workflow_runs?.[0]?.id;
      }
    } catch { /* non-fatal */ }
    res.json({ ok: true, runId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/admin/create-workflow-status", requireAdmin, async (req, res) => {
  const runId = req.query.runId as string;
  if (!runId) { res.status(400).json({ error: "runId required" }); return; }
  const ghPat = process.env.GH_PAT;
  const headers = { ...(ghPat ? { Authorization: `Bearer ${ghPat}` } : {}), Accept: "application/vnd.github+json" };
  try {
    const runRes = await fetch(`https://api.github.com/repos/MoveoTech/boost-agents/actions/runs/${runId}`, { headers });
    if (!runRes.ok) { res.json({ phase: "pending" }); return; }
    const run = await runRes.json() as any;

    if (run.status === "completed") {
      res.json({ phase: run.conclusion === "success" ? "done" : "failed" });
      return;
    }

    // Fetch job steps to see which have finished
    const jobsRes = await fetch(`https://api.github.com/repos/MoveoTech/boost-agents/actions/runs/${runId}/jobs`, { headers });
    if (!jobsRes.ok) { res.json({ phase: "running", repoCreated: false, secretsSet: false, deployTriggered: false }); return; }
    const jobs = await jobsRes.json() as any;
    const steps: Array<{ name: string; conclusion: string | null }> = jobs.jobs?.[0]?.steps ?? [];
    const done = (name: string) => steps.some((s) => s.conclusion === "success" && s.name.toLowerCase().includes(name));

    res.json({
      phase: "running",
      repoCreated: done("create github repo"),
      secretsSet: done("set repo secrets"),
      deployTriggered: done("trigger first deploy"),
    });
  } catch {
    res.json({ phase: "pending" });
  }
});

// ── Super-admin endpoints (boazt@moveoboost.com only) ────────────────────────

const OAUTH_MASTER_KEY = process.env.OAUTH_MASTER_KEY ?? "";

function requireSuperAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const email = getSessionEmail(req);
  if (email !== "boazt@moveoboost.com") { res.status(403).json({ error: "Forbidden" }); return; }
  next();
}

function oauthMaster(path: string) {
  const base = process.env.OAUTH_SERVICE_URL ?? "";
  return { url: `${base}${path}`, key: OAUTH_MASTER_KEY };
}

app.post("/api/superadmin/agents/import", requireAdmin, requireSuperAdmin, async (req, res) => {
  const { repoName } = req.body as { repoName: string };
  if (!repoName?.trim()) { res.status(400).json({ error: "repoName required" }); return; }
  const clean = repoName.trim();
  const gcpProject = `boost-${clean}-v7`;
  const { url, key } = oauthMaster("/api/admin/agents");
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ repoName: clean, agentId: gcpProject, createdBy: getSessionEmail(req) ?? "", adminEmails: "" }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: `OAuth service returned ${r.status}` }));
      res.status(502).json(err); return;
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get("/api/superadmin/agents", requireAdmin, requireSuperAdmin, async (_req, res) => {
  const { url, key } = oauthMaster("/api/admin/agents");
  try {
    const r = await fetch(url, { headers: { "x-api-key": key } });
    if (!r.ok) { res.status(502).json({ error: "Failed to fetch agents" }); return; }
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get("/api/superadmin/agents/:repoName/connections", requireAdmin, requireSuperAdmin, async (req, res) => {
  const gcpProject = `boost-${req.params.repoName}-v7`;
  const { url, key } = oauthMaster(`/api/admin/agents/${encodeURIComponent(gcpProject)}/connections`);
  try {
    const r = await fetch(url, { headers: { "x-api-key": key } });
    if (!r.ok) { res.status(502).json({ error: "Failed to fetch connections" }); return; }
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.delete("/api/superadmin/agents/:repoName", requireAdmin, requireSuperAdmin, async (req, res) => {
  const { repoName } = req.params;
  const ghPat = process.env.GH_PAT;
  const gcpProject = `boost-${repoName}-v7`;
  const errors: string[] = [];
  try {
    // 1. Delete GitHub repo
    if (ghPat) {
      const ghRes = await fetch(`https://api.github.com/repos/MoveoTech/${repoName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json" },
      });
      if (!ghRes.ok && ghRes.status !== 404) {
        errors.push(`GitHub delete failed: ${ghRes.status}`);
      }
    } else {
      errors.push("GH_PAT not set — GitHub repo not deleted");
    }
    // 2. Wipe Firestore data + mark tombstone
    const { url, key } = oauthMaster(`/api/admin/agents/${encodeURIComponent(gcpProject)}/data?repoName=${encodeURIComponent(repoName)}`);
    const wipeRes = await fetch(url, { method: "DELETE", headers: { "x-api-key": key } });
    if (!wipeRes.ok) errors.push(`Firestore wipe failed: ${wipeRes.status}`);

    if (errors.length > 0) {
      res.status(207).json({ ok: false, errors });
    } else {
      res.json({ ok: true });
    }
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.get("/api/superadmin/agents/:repoName/config", requireAdmin, requireSuperAdmin, async (req, res) => {
  const { repoName } = req.params;
  const ghPat = process.env.GH_PAT;
  if (!ghPat) { res.status(500).json({ error: "GH_PAT not configured" }); return; }
  try {
    const { config } = await readConfigFromRepo(`MoveoTech/${repoName}`, ghPat);
    res.json(config);
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

app.patch("/api/superadmin/agents/:repoName/config", requireAdmin, requireSuperAdmin, async (req, res) => {
  const { repoName } = req.params;
  const config = req.body as AgentConfig;
  const ghPat = process.env.GH_PAT;
  if (!ghPat) { res.status(500).json({ error: "GH_PAT not configured" }); return; }
  try {
    // Commit config.ts to child repo — push triggers deploy.yml automatically
    await commitConfigToRepo(`MoveoTech/${repoName}`, config, ghPat);

    // Wait for deploy run to register then capture ID for frontend polling
    await new Promise((resolve) => setTimeout(resolve, 4000));
    let runId: number | undefined;
    try {
      const runsRes = await fetch(
        `https://api.github.com/repos/MoveoTech/${repoName}/actions/runs?workflow_id=deploy.yml&branch=main&per_page=1`,
        { headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json" } }
      );
      if (runsRes.ok) runId = ((await runsRes.json()) as any).workflow_runs?.[0]?.id;
    } catch { /* non-fatal */ }

    res.json({ ok: true, runId });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// Disconnect a specific user from a service on an agent
// service: "whatsapp" | "gmail" | "calendar" | "tasks" | "monday"
// For whatsapp: wipes session creds (preserves config), user must re-scan QR
// For others: deletes OAuth token, user must reconnect
app.delete("/api/superadmin/agents/:repoName/connections/:service/:userId", requireAdmin, requireSuperAdmin, async (req, res) => {
  const { repoName, service, userId } = req.params;
  const gcpProject = `boost-${repoName}-v7`;
  const oauthBase = process.env.OAUTH_SERVICE_URL ?? "";
  const masterKey = OAUTH_MASTER_KEY;
  try {
    let path: string;
    if (service === "whatsapp") {
      path = `/api/whatsapp/${encodeURIComponent(gcpProject)}/${encodeURIComponent(userId)}`;
    } else {
      path = `/api/users/${encodeURIComponent(gcpProject)}/${service}/${encodeURIComponent(userId)}`;
    }
    const r = await fetch(`${oauthBase}${path}`, { method: "DELETE", headers: { "x-api-key": masterKey } });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: `OAuth service returned ${r.status}` }));
      res.status(502).json(err); return;
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
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

  // Enforce single-owner: refuse if a different user already owns WhatsApp on this agent.
  try {
    const waRes = await fetch(`${oauthServiceUrl}/api/whatsapp/${agentId}`, { headers: { "x-api-key": oauthServiceKey } });
    if (waRes.ok) {
      const data = await waRes.json() as { users?: string[] };
      const otherOwner = (data.users ?? []).find((u) => u !== email);
      if (otherOwner) {
        console.log(JSON.stringify({ tag: "whatsapp", user: email, msg: "QR connect blocked — already owned by another user", otherOwner }));
        res.status(409).json({ error: `WhatsApp is already connected to ${otherOwner}. Only one WhatsApp account per agent.` });
        return;
      }
    }
  } catch { /* non-fatal — proceed with normal flow */ }

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


// When config can't be loaded and no cache exists, block everything rather than
// fall back to permissive defaults — prevents replying to strangers on config fetch errors.
const WA_FAILSAFE_CONFIG: WhatsAppConfig = {
  replyTrigger: "keyword",
  keyword: undefined,
  replyInGroups: false,
  replyInDMs: false,
};

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
    if (!res.ok) {
      console.warn(JSON.stringify({ msg: "loadWAConfig fetch failed", status: res.status, email, usingStale: !!cached }));
      return cached?.config ?? WA_FAILSAFE_CONFIG;
    }
    const data = await res.json() as { config?: string } | null;
    const config = data?.config ? { ...DEFAULT_WA_CONFIG, ...JSON.parse(data.config) } : DEFAULT_WA_CONFIG;
    waConfigCache.set(email, { config, ts: Date.now() });
    return config;
  } catch (err) {
    console.warn(JSON.stringify({ msg: "loadWAConfig threw", error: (err as Error).message, email, usingStale: !!cached }));
    return cached?.config ?? WA_FAILSAFE_CONFIG;
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
    // Invalidate cache so the next message uses the new config immediately
    waConfigCache.delete(email);
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

// Slash command expansions for WhatsApp — mirrors the UI slash command palette.
// When a message contains one of these after the trigger keyword, the command is
// replaced with its full natural-language prompt before being sent to the agent.
const WA_SLASH_COMMANDS: Record<string, string> = {
  "/today":         "What's on my calendar and task list today?",
  "/week":          "Show me everything on my calendar and tasks for this week.",
  "/tasks":         "Show me all my open tasks.",
  "/new-event":     "Create a calendar event:\nTitle: \nDate: \nTime: \nDuration: \nAttendees: \nDescription: ",
  "/availability":  "Check my calendar availability on [date] between [time] and [time]",
  "/email":         "Send an email:\nTo: \nSubject: \nMessage:\n",
  "/new-task":      "Create a task:\nTitle: \nDue date: \nNotes: ",
  "/monday-item":   "Create a Monday item:\nBoard: \nItem name: \nGroup: \nWork day: \nWorking hours: \nOwner: \nStatus: ",
  "/monday-update": "Update Monday item ID [id] on board [boardId]:\nSet [column] to [value]",
  "/monday-find":   "Find Monday items on board [boardId] where [condition]",
};

function expandWASlashCommand(text: string): string {
  const match = text.match(/\/[\w-]+/);
  if (!match) return text;
  const expansion = WA_SLASH_COMMANDS[match[0].toLowerCase()];
  if (!expansion) return text;
  // Replace the command token with the expansion, preserve anything the user typed after it
  const after = text.slice(match.index! + match[0].length).trim();
  return after ? `${expansion}\n${after}` : expansion;
}

function buildMentionHandler(agentId: string, oauthServiceUrl: string, oauthServiceKey: string): MentionHandler {
  return async ({ email, fromName, text, isGroup, groupName, isMentioned, fromMe, recentMessages, attachment, attachmentText, attachmentName, attachmentError }) => {
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

      // Expand slash commands — "boost /week" → full calendar prompt
      const resolvedText = expandWASlashCommand(text);
      if (resolvedText !== text) {
        console.log(JSON.stringify({ ...ctx, msg: "slash command expanded", from: text, to: resolvedText }));
      }

      // If the trigger matched but the attachment failed (too large, unsupported type,
      // download error), report it to the user instead of running the agent without media.
      if (attachmentError) {
        console.log(JSON.stringify({ ...ctx, msg: "responding with attachment error", attachmentError }));
        return `🤖 ${attachmentError}`;
      }

      const agentStartMs = Date.now();
      console.log(JSON.stringify({ ...ctx, msg: "trigger matched — running agent", textLength: resolvedText.length, text: resolvedText, msSinceHandlerStart: agentStartMs - tHandler, hasAttachment: !!attachment, attachmentMime: attachment?.mimeType }));

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
        // Strip "🤖 " prefix and "_(Ns)_" timing suffix from stored bot replies — the AI
        // sees these as part of the text and mimics the "🤖 " prefix in subsequent responses,
        // causing the server to add a second prefix and producing "🤖 🤖 " in the output.
        const rawText = m.from === "Assistant"
          ? m.text.replace(/^🤖 /, "").replace(/\n\n_\(\d+s\)_$/, "")
          : m.text;
        const content = m.from === "Assistant" ? rawText : `${m.from}: ${rawText}`;
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
        `- Only call tools when the user's message explicitly requires them. For casual chat, greetings, or questions answerable from general knowledge — respond directly, no tool calls.`,
        `- NEVER say "one sec", "let me check", "I'll do that", "creating now" without calling the tool immediately in this same response.`,
        `- When the user provides all info needed — execute immediately. Do NOT ask for confirmation.`,
        `- If a tool fails, say so honestly. Never claim success unless the tool returned success.`,
        `- Only ask a question if a required piece of info is genuinely missing. Ask at most ONE question per response.`,
        `- Default timezone: Israel (Asia/Jerusalem, UTC+3) unless the user specifies otherwise.`,
        `- Voice notes are automatically transcribed before reaching you. A message starting with "[Voice note]:" contains the exact transcript — treat it as normal text, never say you cannot hear or process audio.`,
        config.customPrompt || "",
      ].filter(Boolean).join("\n");

      const agentTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("agent timed out after 90s")), 90_000)
      );

      // If a document was extracted to text (docx/txt/etc.), prepend its content to the
      // user's message so the AI sees it as part of the request.
      const effectiveMessage = attachmentText
        ? `${resolvedText}\n\n[Attached document${attachmentName ? `: ${attachmentName}` : ""}]\n${attachmentText}`
        : resolvedText;

      const tChat0 = Date.now();
      const result = await Promise.race([
        chat(
          effectiveMessage,
          history,
          "tools",
          systemPrompt,
          email,   // gmailUser
          email,   // calendarUser
          { ...(config.model ?? { provider: "gemini" as const, modelId: "gemini-2.5-flash" }), noThinking: true },
          mondayToken ?? undefined,
          email,   // tasksUser
          undefined, // memoryUser
          attachment, // image / PDF attachment from WhatsApp
          undefined, // whatsappUser
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

// ── Contacts ──────────────────────────────────────────────────────────────────

app.post("/api/contacts/import", async (req, res) => {
  const email = getSessionEmail(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { vcf } = req.body as { vcf: string };
  if (!vcf?.trim()) { res.status(400).json({ error: "vcf required" }); return; }
  try {
    const parsed = parseVCards(vcf);
    if (!parsed.length) { res.status(400).json({ error: "No contacts found in vCard data" }); return; }
    const count = await importContacts(email, parsed);
    res.json({ ok: true, imported: count, contacts: parsed });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/contacts", async (req, res) => {
  const email = getSessionEmail(req);
  if (!email) { res.status(401).json({ error: "Unauthorized" }); return; }
  try {
    const contacts = await listContacts(email);
    res.json({ contacts });
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
  // Extract text from Word documents before further processing.
  // Reuses the same mammoth library the WhatsApp connector uses.
  let processedAttachment = attachment;
  if (attachment) {
    const isDocx = attachment.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      || attachment.mimeType === "application/msword"
      || /\.(docx|doc)$/i.test(attachment.name);
    if (isDocx) {
      try {
        const mammoth = await import("mammoth");
        const buf = Buffer.from(attachment.data, "base64");
        const { value } = await mammoth.extractRawText({ buffer: buf });
        processedAttachment = {
          data: Buffer.from(value.slice(0, 100_000)).toString("base64"),
          mimeType: "text/plain",
          name: attachment.name,
        };
      } catch { /* extraction failed — fall through, will be treated as unsupported binary */ }
    }
  }

  // PDFs and images are passed as binary to the multimodal LLM layer.
  // Everything else (text, JSON, CSV, docx-extracted-to-text, etc.) is decoded and inlined into the message.
  const isBinaryAttachment = !!processedAttachment && (processedAttachment.mimeType.startsWith("image/") || processedAttachment.mimeType === "application/pdf");
  const effectiveMessage = processedAttachment && !isBinaryAttachment
    ? buildMessageWithAttachment(message, processedAttachment)
    : message;
  const imageAttachment: ImageAttachment | undefined = isBinaryAttachment
    ? { data: processedAttachment!.data, mimeType: processedAttachment!.mimeType }
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
    let apolloApiKeyStream: string | undefined;
    if (sessionEmail && process.env.OAUTH_SERVICE_URL && process.env.OAUTH_SERVICE_KEY) {
      try {
        const s = await fetch(`${process.env.OAUTH_SERVICE_URL}/api/user-settings/${process.env.GOOGLE_CLOUD_PROJECT}/${encodeURIComponent(sessionEmail)}`, { headers: { "x-api-key": process.env.OAUTH_SERVICE_KEY } });
        if (s.ok) { const d = await s.json() as { apolloApiKey?: string }; apolloApiKeyStream = d.apolloApiKey; }
      } catch { /* non-fatal */ }
    }
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
            if (t) t.output = output.slice(0, 2000);
            send({ type: "tool_complete", tool: { name, output: output.slice(0, 2000) } });
          },
        },
        mondayTokenStream,
        tasksUserStream,
        sessionEmail,
        imageAttachment,
        waUserStream,
        apolloApiKeyStream,
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
    let apolloApiKey: string | undefined;
    if (sessionEmail && process.env.OAUTH_SERVICE_URL && process.env.OAUTH_SERVICE_KEY) {
      try {
        const s = await fetch(`${process.env.OAUTH_SERVICE_URL}/api/user-settings/${process.env.GOOGLE_CLOUD_PROJECT}/${encodeURIComponent(sessionEmail)}`, { headers: { "x-api-key": process.env.OAUTH_SERVICE_KEY } });
        if (s.ok) { const d = await s.json() as { apolloApiKey?: string }; apolloApiKey = d.apolloApiKey; }
      } catch { /* non-fatal */ }
    }
    const result = await chat(effectiveMessage.trim(), history, mode, systemPrompt, sessionEmail, sessionEmail, model, mondayToken, tasksUser, sessionEmail, imageAttachment, waUser, apolloApiKey);
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
  // If this agent has its own Google OAuth credentials, register them with the oauth-service
  // so users connect via the agent's own OAuth app (needed for restricted scopes).
  const ownClientId = process.env.GOOGLE_CLIENT_ID;
  const ownClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (ownClientId && ownClientSecret && oauthServiceUrl && oauthServiceKey && agentId) {
    fetch(`${oauthServiceUrl}/api/agent-oauth-creds/${agentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": oauthServiceKey },
      body: JSON.stringify({ clientId: ownClientId, clientSecret: ownClientSecret }),
    }).catch((err) => console.warn(`Failed to register agent OAuth credentials: ${err.message}`));
  }
  initAllSessions(agentId, oauthServiceUrl, oauthServiceKey, buildMentionHandler(agentId, oauthServiceUrl, oauthServiceKey),
    (email) => prewarmWASession(email, agentId, oauthServiceUrl, oauthServiceKey),
    (email) => prewarmWASession(email, agentId, oauthServiceUrl, oauthServiceKey));
});

// Flush processedMsgIds and pending Signal key saves to Firestore before Cloud Run kills us.
// Cloud Run sends SIGTERM then waits up to 10s before SIGKILL — flushAllSessions caps at 8s.
process.on("SIGTERM", async () => {
  console.log(JSON.stringify({ tag: "process", msg: "SIGTERM received — flushing WhatsApp sessions" }));
  await flushAllSessions();
  console.log(JSON.stringify({ tag: "process", msg: "flush complete — exiting" }));
  process.exit(0);
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
