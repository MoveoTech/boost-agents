const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? "";
const REGION = "us-central1";
const AUTOMATION_SECRET = process.env.AUTOMATION_SECRET ?? "";

export interface Automation {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdBy?: string;
  oneTime?: boolean;
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
  const body = JSON.parse(bodyStr) as { name?: string; prompt?: string; createdBy?: string; oneTime?: boolean };
  const name = job.name as string;
  return {
    id: name.split("/jobs/automation--")[1],
    name: body.name ?? "Unnamed",
    schedule: (job.schedule as string) ?? "",
    prompt: body.prompt ?? "",
    enabled: job.state !== "PAUSED" && job.state !== "DISABLED",
    createdBy: body.createdBy,
    oneTime: body.oneTime,
  };
}

export async function listAutomations(): Promise<Automation[]> {
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
  const token = await gcpToken();
  const fullName = `projects/${PROJECT}/locations/${REGION}/jobs/${jobId(automation.id)}`;

  const job = {
    name: fullName,
    description: automation.name,
    schedule: automation.schedule,
    timeZone: "UTC",
    httpTarget: {
      uri: `${agentUrl}/api/run-automation`,
      httpMethod: "POST",
      body: Buffer.from(JSON.stringify({ id: automation.id, name: automation.name, prompt: automation.prompt, createdBy: automation.createdBy, oneTime: automation.oneTime })).toString("base64"),
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
  const token = await gcpToken();
  const fullName = `projects/${PROJECT}/locations/${REGION}/jobs/${jobId(automationId)}`;
  const res = await fetch(`https://cloudscheduler.googleapis.com/v1/${fullName}:run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to trigger job: ${res.status}`);
}

export async function deleteAutomation(automationId: string): Promise<void> {
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
export async function resyncAutomationSecrets(): Promise<void> {
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
