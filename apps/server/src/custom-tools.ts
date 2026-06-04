import { lookup as dnsLookup } from "dns/promises";
import { isIP } from "net";
import type { ToolDecl, ToolParam } from "./llm";

// ── Types ─────────────────────────────────────────────────────────────────────
// Custom tools are data, not code: a definition is stored in Firestore (agent-wide)
// and dispatched at runtime through a generic HTTP executor. No redeploy needed.

export type CustomAuthType = "bearer" | "header" | "query" | "basic" | "none";

export interface CustomAuth {
  type: CustomAuthType;
  credRef: string;            // key into the user's customCredentials map
  headerName?: string;        // type "header" → e.g. "X-Api-Key"
  queryName?: string;         // type "query"  → e.g. "api_key"
  basicUserField?: "email";   // type "basic"  → username = caller's email, password = cred
}

export interface CustomOperation {
  name: string;               // unique tool name, e.g. "jira_list_issues"
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;               // may contain {placeholders}
  parameters: { properties: Record<string, ToolParam>; required: string[] };
}

export interface CustomToolDef {
  id: string;                 // slug, e.g. "jira"
  service: string;            // display name, e.g. "Jira"
  description: string;
  baseUrl: string;            // https only, public host
  auth: CustomAuth;
  operations: CustomOperation[];
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ── SSRF guard ─────────────────────────────────────────────────────────────────
// Any authenticated user can author a tool, so an attacker could point baseUrl at
// the cloud metadata server (169.254.169.254) to steal the service-account token,
// or at internal services. Reject non-https and any host that resolves to a
// private / loopback / link-local range. Checked at save AND at execute (DNS rebinding).

function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
    if (v.startsWith("fe80")) return true;                      // link-local
    if (v.startsWith("::ffff:")) return isBlockedIp(v.slice(7)); // IPv4-mapped
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 127) return true;                       // loopback
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;          // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;          // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                         // multicast / reserved
  return false;
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);

export async function assertSafeHost(rawUrl: string): Promise<void> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new Error(`Invalid URL: ${rawUrl}`); }
  if (url.protocol !== "https:") throw new Error("Only https:// URLs are allowed for custom tools.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error(`Host not allowed: ${host}`);
  }
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`Host not allowed: ${host}`);
    return;
  }
  const resolved = await dnsLookup(host, { all: true });
  for (const { address } of resolved) {
    if (isBlockedIp(address)) throw new Error(`Host ${host} resolves to a blocked address.`);
  }
}

// ── Definition validation ───────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9_]+$/;

export function validateToolDef(def: CustomToolDef): string | null {
  if (!def.id || !SLUG_RE.test(def.id)) return "id must be a slug (lowercase letters, digits, underscore).";
  if (!def.baseUrl) return "baseUrl is required.";
  if (!def.auth?.type) return "auth.type is required.";
  if (def.auth.type !== "none" && !def.auth.credRef) return "auth.credRef is required unless auth.type is 'none'.";
  if (def.auth.type === "header" && !def.auth.headerName) return "auth.headerName is required for header auth.";
  if (def.auth.type === "query" && !def.auth.queryName) return "auth.queryName is required for query auth.";
  if (!def.operations?.length) return "at least one operation is required.";
  for (const op of def.operations) {
    if (!op.name || !SLUG_RE.test(op.name)) return `operation name "${op.name}" must be a slug.`;
    if (!op.method) return `operation "${op.name}" needs a method.`;
    if (!op.path?.startsWith("/")) return `operation "${op.name}" path must start with "/".`;
  }
  return null;
}

// ── Definition → ToolDecl (what the LLM sees) ────────────────────────────────────

export function customDefsToToolDecls(defs: CustomToolDef[]): ToolDecl[] {
  const decls: ToolDecl[] = [];
  for (const def of defs) {
    for (const op of def.operations) {
      decls.push({
        name: op.name,
        description: `[${def.service}] ${op.description}`,
        parameters: op.parameters ?? { properties: {}, required: [] },
      });
    }
  }
  return decls;
}

export function findCustomOp(defs: CustomToolDef[], name: string): { def: CustomToolDef; op: CustomOperation } | null {
  for (const def of defs) {
    const op = def.operations.find((o) => o.name === name);
    if (op) return { def, op };
  }
  return null;
}

// ── Persistence (via oauth-service Firestore) ────────────────────────────────────

function oauthEnv(): { url: string; key: string; agentId: string } | null {
  const url = process.env.OAUTH_SERVICE_URL;
  const key = process.env.OAUTH_SERVICE_KEY;
  const agentId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!url || !key || !agentId) return null;
  return { url, key, agentId };
}

export async function fetchCustomToolDefs(): Promise<CustomToolDef[]> {
  const env = oauthEnv();
  if (!env) return [];
  try {
    const r = await fetch(`${env.url}/api/custom-tools/${env.agentId}`, { headers: { "x-api-key": env.key } });
    if (!r.ok) return [];
    const list = await r.json() as CustomToolDef[];
    // Strip the version-history field that oauth-service stores alongside the def.
    return list.map(({ ...def }) => def);
  } catch { return []; }
}

export async function persistCustomToolDef(def: CustomToolDef): Promise<string> {
  const env = oauthEnv();
  if (!env) return "Custom tools storage is not configured on this agent.";
  const r = await fetch(`${env.url}/api/custom-tools/${env.agentId}/${def.id}`, {
    method: "PUT",
    headers: { "x-api-key": env.key, "Content-Type": "application/json" },
    body: JSON.stringify(def),
  });
  return r.ok ? "" : `Failed to save tool (HTTP ${r.status}).`;
}

export async function removeCustomToolDef(toolId: string): Promise<string> {
  const env = oauthEnv();
  if (!env) return "Custom tools storage is not configured on this agent.";
  const r = await fetch(`${env.url}/api/custom-tools/${env.agentId}/${toolId}`, {
    method: "DELETE",
    headers: { "x-api-key": env.key },
  });
  return r.ok ? "" : `Failed to delete tool (HTTP ${r.status}).`;
}

// ── Generic HTTP executor ────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

export async function executeCustomOp(
  def: CustomToolDef,
  op: CustomOperation,
  args: Record<string, unknown>,
  credValue: string | undefined,
  callerEmail: string | undefined,
): Promise<string> {
  if (def.auth.type !== "none" && !credValue) {
    return `${def.service} is not connected. Ask the user to add their ${def.service} credential in the Connectors panel (key: ${def.auth.credRef}).`;
  }

  // Substitute {placeholders} in the path; remaining args go to query (GET/DELETE) or body.
  const used = new Set<string>();
  const path = op.path.replace(PLACEHOLDER_RE, (_m, key: string) => {
    used.add(key);
    return encodeURIComponent(String(args[key] ?? ""));
  });

  const url = new URL(def.baseUrl.replace(/\/$/, "") + path);
  const headers: Record<string, string> = { "User-Agent": "boost-agent/1.0", Accept: "application/json" };

  // Auth injection — the credential value never enters LLM context.
  switch (def.auth.type) {
    case "bearer": headers["Authorization"] = `Bearer ${credValue}`; break;
    case "header": headers[def.auth.headerName!] = credValue!; break;
    case "query":  url.searchParams.set(def.auth.queryName!, credValue!); break;
    case "basic": {
      const user = def.auth.basicUserField === "email" ? (callerEmail ?? "") : "";
      headers["Authorization"] = "Basic " + Buffer.from(`${user}:${credValue}`).toString("base64");
      break;
    }
    case "none": break;
  }

  const remaining: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (used.has(k) || v === undefined) continue;
    remaining[k] = v;
  }

  const isBodyMethod = op.method === "POST" || op.method === "PUT" || op.method === "PATCH";
  let body: string | undefined;
  if (isBodyMethod) {
    if (Object.keys(remaining).length) { body = JSON.stringify(remaining); headers["Content-Type"] = "application/json"; }
  } else {
    for (const [k, v] of Object.entries(remaining)) {
      url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
  }

  try {
    await assertSafeHost(url.toString());
    const res = await fetch(url.toString(), { method: op.method, headers, body, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    const trimmed = text.length > 10_000 ? text.slice(0, 10_000) + "\n[truncated]" : text;
    if (!res.ok) return `${def.service} returned HTTP ${res.status}:\n${trimmed}`;
    return trimmed || `${op.name} succeeded (HTTP ${res.status}, empty body).`;
  } catch (err) {
    return `${def.service} request failed: ${(err as Error).message}`;
  }
}
