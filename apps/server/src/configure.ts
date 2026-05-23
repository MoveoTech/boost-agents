import type { AgentConfig } from "./config";

const GH_PAT = process.env.GH_PAT;
const GITHUB_REPO = process.env.GITHUB_REPO;
const CONFIG_PATH = "apps/server/src/config.ts";

export function generateConfigFile(config: AgentConfig): string {
  return `export interface Skill { id: string; name: string; content: string; enabled: boolean }
export interface MCPServerConfig { command?: string; args?: string[]; env?: Record<string, string>; url?: string }
export interface CustomTool { id: string; name: string; description: string; url: string; method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"; headers?: Record<string,string>; bodyTemplate?: string; params: Array<{name:string;description:string;required:boolean}>; enabled: boolean }

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  model: { provider: "gemini" | "claude" | "openai"; modelId: string };
  skills: Skill[];
  tools: {
    fetchUrl: boolean;
    httpRequest: boolean;
    googleSearch: boolean;
    gmail: boolean;
    googleCalendar: boolean;
    slack: boolean;
    jinaReader?: boolean;
    monday?: boolean;
    googleTasks?: boolean;
    memory?: boolean;
  };
  access: {
    chatEnabled: boolean;
    apiEnabled: boolean;
  };
  ui: {
    title: string;
    placeholder: string;
    starterPrompts?: string[];
  };
  mcpServers?: Record<string, MCPServerConfig>;
  customTools?: CustomTool[];
}

export const agentConfig: AgentConfig = ${JSON.stringify(config, null, 2)};
`;
}

export async function readConfigFromRepo(repo: string, ghPat: string): Promise<{ config: AgentConfig; sha: string }> {
  const headers = { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${CONFIG_PATH}`, { headers });
  if (!res.ok) throw new Error(`Failed to read config from ${repo}: ${res.status}`);
  const { content, sha } = await res.json() as { content: string; sha: string };
  const raw = Buffer.from(content, "base64").toString("utf8");
  const match = raw.match(/export const agentConfig[^=]*=\s*(\{[\s\S]*?\});\s*$/m);
  if (!match) throw new Error("Could not parse config.ts");
  return { config: JSON.parse(match[1]) as AgentConfig, sha };
}

export async function commitConfigToRepo(repo: string, config: AgentConfig, ghPat: string): Promise<string> {
  const headers = { Authorization: `Bearer ${ghPat}`, "Content-Type": "application/json", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${CONFIG_PATH}`, { headers });
  if (!getRes.ok) throw new Error(`Failed to read ${repo}/config.ts: ${getRes.status}`);
  const { sha } = await getRes.json() as { sha: string };
  const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${CONFIG_PATH}`, {
    method: "PUT", headers,
    body: JSON.stringify({ message: "chore: update agent config via superadmin panel", content: Buffer.from(generateConfigFile(config)).toString("base64"), sha }),
  });
  if (!putRes.ok) {
    const err = await putRes.json() as { message?: string };
    throw new Error(err.message ?? `GitHub commit failed: ${putRes.status}`);
  }
  return ((await putRes.json()) as { commit: { html_url: string } }).commit.html_url;
}

export async function commitConfig(config: AgentConfig): Promise<string> {
  if (!GH_PAT || !GITHUB_REPO) {
    throw new Error("GH_PAT and GITHUB_REPO env vars are required for config updates");
  }

  const headers = {
    Authorization: `Bearer ${GH_PAT}`,
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const getRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${CONFIG_PATH}`,
    { headers }
  );
  if (!getRes.ok) throw new Error(`Failed to read config from GitHub: ${getRes.status}`);
  const { sha } = await getRes.json() as { sha: string };

  const content = Buffer.from(generateConfigFile(config)).toString("base64");

  const putRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${CONFIG_PATH}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: "chore: update agent config via builder UI",
        content,
        sha,
      }),
    }
  );

  if (!putRes.ok) {
    const err = await putRes.json() as { message?: string };
    throw new Error(err.message ?? `GitHub commit failed: ${putRes.status}`);
  }

  const result = await putRes.json() as { commit: { html_url: string } };
  return result.commit.html_url;
}
