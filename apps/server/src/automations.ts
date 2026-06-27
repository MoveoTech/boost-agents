import { IS_LOCAL } from "./local";
import { localList, localGet, localUpsert, localDelete } from "./local-flows";

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "";
const REGION = "us-central1";
const AUTOMATION_SECRET = process.env.AUTOMATION_SECRET ?? "";

export interface AutomationStep {
  id: string;
  tool: string;
  instruction: string;
  httpUrl?: string;
  httpMethod?: string;
  httpAuthHeader?: string;
  httpAuthValue?: string;
}

export interface RunHistoryEntry {
  runAt: string;
  status: "success" | "partial" | "error";
  durationMs: number;
  steps: Array<{ id: string; tool: string; output: string; error?: string; durationMs: number; conditionFailed?: boolean }>;
}

export interface Automation {
  id: string;
  name: string;
  schedule: string;
  steps: AutomationStep[];
  enabled: boolean;
  createdBy?: string;
  oneTime?: boolean;
  runHistory?: RunHistoryEntry[];
  notifyOnFailure?: boolean;
  triggerType?: "schedule" | "webhook" | "both";
  webhookId?: string;
  webhookSecret?: string;
  webhookPayloadSchema?: Record<string, unknown>;
}

async function gcpToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  const { access_token } = await res.json() as { access_token: string };
  return access_token;
}

const SCHEDULER_BASE = `https://cloudscheduler.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/jobs`;

function jobId(automationId: string) {
  return `automation--${automationId}`;
}

function parseJob(job: Record<string, unknown>): Automation {
  const httpTarget = job.httpTarget as Record<string, string> | undefined;
  const bodyStr = httpTarget?.body ? Buffer.from(httpTarget.body, "base64").toString() : "{}";
  const body = JSON.parse(bodyStr) as { name?: string; steps?: AutomationStep[]; createdBy?: string; oneTime?: boolean; runHistory?: RunHistoryEntry[]; notifyOnFailure?: boolean; triggerType?: "schedule" | "webhook" | "both"; webhookId?: string; webhookSecret?: string; webhookPayloadSchema?: Record<string, unknown> };
  const name = job.name as string;
  return {
    id: name.split("/jobs/automation--")[1],
    name: body.name ?? "Unnamed",
    schedule: (job.schedule as string) ?? "",
    steps: body.steps ?? [],
    enabled: job.state !== "PAUSED" && job.state !== "DISABLED",
    createdBy: body.createdBy,
    oneTime: body.oneTime,
    runHistory: body.runHistory,
    notifyOnFailure: body.notifyOnFailure,
    triggerType: body.triggerType,
    webhookId: body.webhookId,
    webhookSecret: body.webhookSecret,
    webhookPayloadSchema: body.webhookPayloadSchema,
  };
}

export async function listAutomations(): Promise<Automation[]> {
  if (IS_LOCAL) return localList();
  const token = await gcpToken();
  const res = await fetch(SCHEDULER_BASE, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json() as { jobs?: Record<string, unknown>[] };
  return (data.jobs ?? [])
    .filter((j) => (j.name as string).includes("/jobs/automation--"))
    .map(parseJob);
}

export async function upsertAutomation(automation: Automation, agentUrl: string): Promise<void> {
  if (IS_LOCAL) { await localUpsert(automation); return; }
  const token = await gcpToken();
  const fullName = `projects/${PROJECT}/locations/${REGION}/jobs/${jobId(automation.id)}`;

  // Webhook-only flows use a never-firing schedule — they're triggered by HTTP, not cron
  const effectiveSchedule = automation.triggerType === "webhook" ? "0 0 1 1 *" : automation.schedule;

  const job = {
    name: fullName,
    description: automation.name,
    schedule: effectiveSchedule,
    timeZone: "UTC",
    httpTarget: {
      uri: `${agentUrl}/api/run-automation`,
      httpMethod: "POST",
      body: Buffer.from(JSON.stringify({ id: automation.id, name: automation.name, steps: automation.steps, createdBy: automation.createdBy, oneTime: automation.oneTime, runHistory: automation.runHistory, notifyOnFailure: automation.notifyOnFailure, triggerType: automation.triggerType, webhookId: automation.webhookId, webhookSecret: automation.webhookSecret, webhookPayloadSchema: automation.webhookPayloadSchema })).toString("base64"),
      headers: {
        "Content-Type": "application/json",
        "x-automation-secret": AUTOMATION_SECRET,
      },
    },
  };

  // Try create, fall back to patch if already exists
  const createRes = await fetch(SCHEDULER_BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(job),
  });

  if (createRes.status === 409) {
    await fetch(`https://cloudscheduler.googleapis.com/v1/${fullName}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(job),
    });
  }

  // Set enabled/paused state
  const action = automation.enabled ? "enable" : "pause";
  await fetch(`https://cloudscheduler.googleapis.com/v1/${fullName}:${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function runAutomationNow(automationId: string): Promise<void> {
  if (IS_LOCAL) {
    // No scheduler locally — POST the flow to our own /api/run-automation, same as the scheduler would.
    const a = await localGet(automationId);
    if (!a) throw new Error("Flow not found");
    const port = process.env.PORT ?? 8080;
    const res = await fetch(`http://localhost:${port}/api/run-automation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-automation-secret": AUTOMATION_SECRET },
      body: JSON.stringify({ id: a.id, name: a.name, steps: a.steps, createdBy: a.createdBy, oneTime: a.oneTime, notifyOnFailure: a.notifyOnFailure }),
    });
    if (!res.ok) throw new Error(`Failed to run flow locally: ${res.status}`);
    return;
  }
  const token = await gcpToken();
  const fullName = `projects/${PROJECT}/locations/${REGION}/jobs/${jobId(automationId)}`;
  const res = await fetch(`https://cloudscheduler.googleapis.com/v1/${fullName}:run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to trigger job: ${res.status}`);
}

export async function getAutomation(automationId: string): Promise<Automation | null> {
  if (IS_LOCAL) return localGet(automationId);
  const token = await gcpToken();
  const fullName = `projects/${PROJECT}/locations/${REGION}/jobs/${jobId(automationId)}`;
  const res = await fetch(`https://cloudscheduler.googleapis.com/v1/${fullName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return parseJob(await res.json() as Record<string, unknown>);
}

export async function deleteAutomation(automationId: string): Promise<void> {
  if (IS_LOCAL) { await localDelete(automationId); return; }
  const token = await gcpToken();
  const fullName = `projects/${PROJECT}/locations/${REGION}/jobs/${jobId(automationId)}`;
  await fetch(`https://cloudscheduler.googleapis.com/v1/${fullName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// On every deploy the AUTOMATION_SECRET may differ from what was baked into
// existing scheduler jobs. Patch all jobs to use the current secret so they
// don't fail with 401. Derives the agent URL from the existing jobs themselves.
// Patches only the body field of an existing job — lighter than full upsert (no enable/pause calls)
export async function patchAutomationBody(automationId: string, patch: Partial<Record<string, unknown>>): Promise<void> {
  const token = await gcpToken();
  const fullName = `projects/${PROJECT}/locations/${REGION}/jobs/${jobId(automationId)}`;
  const getRes = await fetch(`https://cloudscheduler.googleapis.com/v1/${fullName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!getRes.ok) return;
  const job = await getRes.json() as Record<string, unknown>;
  const httpTarget = job.httpTarget as Record<string, string>;
  const bodyStr = httpTarget.body ? Buffer.from(httpTarget.body, "base64").toString() : "{}";
  const merged = { ...JSON.parse(bodyStr), ...patch };
  await fetch(`https://cloudscheduler.googleapis.com/v1/${fullName}?updateMask=httpTarget`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: fullName,
      httpTarget: { ...httpTarget, body: Buffer.from(JSON.stringify(merged)).toString("base64") },
    }),
  });
}

export async function resyncAutomationSecrets(): Promise<void> {
  if (IS_LOCAL) return; // no scheduler jobs locally
  if (!PROJECT || !AUTOMATION_SECRET) return;
  try {
    const token = await gcpToken();
    const res = await fetch(SCHEDULER_BASE, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json() as { jobs?: Record<string, unknown>[] };
    const jobs = (data.jobs ?? []).filter((j) => (j.name as string).includes("/jobs/automation--"));
    if (!jobs.length) return;

    let patched = 0;
    for (const job of jobs) {
      const httpTarget = job.httpTarget as Record<string, unknown> | undefined;
      const uri = httpTarget?.uri as string | undefined;
      if (!uri) continue;
      const agentUrl = uri.replace(/\/api\/run-automation$/, "");
      const automation = parseJob(job as Record<string, unknown>);
      await upsertAutomation(automation, agentUrl);
      patched++;
    }
    console.log(`[automations] resynced ${patched} scheduler job(s) with current secret`);
  } catch (err) {
    console.warn("[automations] resync failed (non-fatal):", (err as Error).message);
  }
}
