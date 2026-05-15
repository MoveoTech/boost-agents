import type { AgentConfig } from "./config";

const GH_PAT = process.env.GH_PAT;
const GITHUB_REPO = process.env.GITHUB_REPO;
const CONFIG_PATH = "apps/server/src/config.ts";

function generateConfigFile(config: AgentConfig): string {
  return `export interface AgentConfig {
  name: string;
  systemPrompt: string;
  skills: { id: string; name: string; content: string; enabled: boolean }[];
  tools: {
    fetchUrl: boolean;
    httpRequest: boolean;
    googleSearch: boolean;
    gmail: boolean;
    googleCalendar: boolean;
  };
  access: {
    chatEnabled: boolean;
    apiEnabled: boolean;
  };
  ui: {
    title: string;
    placeholder: string;
  };
}

export const agentConfig: AgentConfig = ${JSON.stringify(config, null, 2)};
`;
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
