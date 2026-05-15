const SLACK_API = "https://slack.com/api";

async function slackCall(endpoint: string, token: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = body
    ? await fetch(`${SLACK_API}/${endpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    : await fetch(`${SLACK_API}/${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data;
}

export async function slackSendMessage(token: string, channel: string, text: string, threadTs?: string): Promise<string> {
  await slackCall("chat.postMessage", token, { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
  return `Message sent to ${channel}.`;
}

export async function slackListChannels(token: string): Promise<string> {
  const data = await slackCall(`conversations.list?limit=200&exclude_archived=true`, token) as {
    ok: boolean;
    channels?: { id: string; name: string; is_member: boolean }[];
  };
  const channels = data.channels ?? [];
  if (!channels.length) return "No channels found.";
  return channels.map((c) => `#${c.name} (id: ${c.id})${c.is_member ? "" : " — bot not in channel"}`).join("\n");
}
