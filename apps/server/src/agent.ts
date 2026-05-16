import type { Content } from "@google/generative-ai";
import { chatWithModel, chatWithModelStream, type ModelConfig, type ToolDecl, type StreamCallbacks } from "./llm";
import { fetchUrl, httpRequest } from "./tools";
import { gmailSend } from "./gmail";
import { slackSendMessage, slackListChannels, slackLookupUserByEmail } from "./slack";
import { calendarListEvents, calendarCreateEvent, calendarGetEvent, calendarCheckAvailability } from "./calendar";
import { getUserAccessToken } from "./google-auth";
import { agentConfig } from "./config";
import { buildMCPTools } from "./mcp";

// ── Tool declarations (provider-agnostic) ────────────────────────────────────

const ALL_TOOLS: Record<string, ToolDecl> = {
  fetch_url: {
    name: "fetch_url", description: "Fetch the content of a URL and return it as text.",
    parameters: { properties: { url: { type: "string", description: "Full URL (http:// or https://)" } }, required: ["url"] },
  },
  http_request: {
    name: "http_request", description: "Make an HTTP request with a custom method and optional JSON body.",
    parameters: {
      properties: {
        url:    { type: "string",  description: "Full URL" },
        method: { type: "string",  description: "HTTP method: GET, POST, PUT, PATCH, DELETE" },
        body:   { type: "object",  description: "JSON body (optional)" },
      },
      required: ["url", "method"],
    },
  },
  gmail_send: {
    name: "gmail_send", description: "Send an email via the user's connected Gmail account.",
    parameters: {
      properties: {
        to:      { type: "string", description: "Recipient email" },
        subject: { type: "string", description: "Email subject" },
        body:    { type: "string", description: "Email body (plain text)" },
      },
      required: ["to", "subject", "body"],
    },
  },
  calendar_list_events: {
    name: "calendar_list_events", description: "List upcoming events from the user's Google Calendar.",
    parameters: { properties: { maxResults: { type: "number", description: "Max events (default 10)" } }, required: [] },
  },
  calendar_create_event: {
    name: "calendar_create_event", description: "Create a new calendar event. Attendees receive invitations automatically.",
    parameters: {
      properties: {
        title:         { type: "string", description: "Event title" },
        startDateTime: { type: "string", description: "Start in ISO 8601 (e.g. 2026-05-15T10:00:00Z)" },
        endDateTime:   { type: "string", description: "End in ISO 8601" },
        description:   { type: "string", description: "Event description (optional)" },
        location:      { type: "string", description: "Location (optional)" },
        attendees:     { type: "array",  description: "Attendee emails (optional)", items: { type: "string" } },
      },
      required: ["title", "startDateTime", "endDateTime"],
    },
  },
  calendar_get_event: {
    name: "calendar_get_event", description: "Get details of a specific calendar event.",
    parameters: { properties: { eventId: { type: "string", description: "Calendar event ID" } }, required: ["eventId"] },
  },
  calendar_check_availability: {
    name: "calendar_check_availability", description: "Check free/busy availability for multiple people. Use before scheduling.",
    parameters: {
      properties: {
        emails:  { type: "array",  description: "Email addresses to check", items: { type: "string" } },
        timeMin: { type: "string", description: "Start of range in ISO 8601" },
        timeMax: { type: "string", description: "End of range in ISO 8601" },
      },
      required: ["emails", "timeMin", "timeMax"],
    },
  },
  slack_send_message: {
    name: "slack_send_message", description: "Send a message to a Slack channel.",
    parameters: {
      properties: {
        channel: { type: "string", description: "Channel name (e.g. #general) or channel ID" },
        message: { type: "string", description: "The message text to send" },
      },
      required: ["channel", "message"],
    },
  },
  slack_list_channels: {
    name: "slack_list_channels", description: "List Slack channels the bot has access to.",
    parameters: { properties: {}, required: [] },
  },
  slack_lookup_user: {
    name: "slack_lookup_user", description: "Look up a Slack user by their email address to get their user ID for mentioning them in messages. Use the returned ID in the format <@USERID> inside a message.",
    parameters: {
      properties: {
        email: { type: "string", description: "The user's email address" },
      },
      required: ["email"],
    },
  },
};

function buildSystemPrompt(override?: string, addition?: string): string {
  const base = override ?? agentConfig.systemPrompt;
  const enabledSkills = agentConfig.skills?.filter((s) => s.enabled) ?? [];
  const skillsBlock = enabledSkills.length
    ? `\n\n---\n\n${enabledSkills.map((s) => `## ${s.name}\n${s.content}`).join("\n\n")}`
    : "";
  const additionBlock = addition?.trim() ? `\n\n---\n\n${addition.trim()}` : "";
  return `${base}${skillsBlock}${additionBlock}`;
}

function buildBuiltinTools(gmailUser?: string, calendarUser?: string): ToolDecl[] {
  const tools: ToolDecl[] = [];
  if (agentConfig.tools.fetchUrl)    tools.push(ALL_TOOLS.fetch_url);
  if (agentConfig.tools.httpRequest) tools.push(ALL_TOOLS.http_request);
  if (gmailUser)    tools.push(ALL_TOOLS.gmail_send);
  if (calendarUser) tools.push(ALL_TOOLS.calendar_list_events, ALL_TOOLS.calendar_create_event, ALL_TOOLS.calendar_get_event, ALL_TOOLS.calendar_check_availability);
  if (agentConfig.tools.slack && process.env.SLACK_BOT_TOKEN) tools.push(ALL_TOOLS.slack_send_message, ALL_TOOLS.slack_list_channels, ALL_TOOLS.slack_lookup_user);
  return tools;
}

function buildCustomTools(): ToolDecl[] {
  return (agentConfig.customTools ?? [])
    .filter((t) => t.enabled)
    .map((t) => ({
      name: `custom__${t.id}`,
      description: t.description,
      parameters: {
        properties: Object.fromEntries(t.params.map((p) => [p.name, { type: "string" as const, description: p.description }])),
        required: t.params.filter((p) => p.required).map((p) => p.name),
      },
    }));
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeBuiltin(name: string, args: Record<string, unknown>, gmailUser?: string, calendarUser?: string): Promise<string | null> {
  switch (name) {
    case "fetch_url":
      return fetchUrl(args.url as string);

    case "http_request":
      return httpRequest(args.url as string, args.method as string, args.body);

    case "gmail_send": {
      if (!gmailUser) return "User has not connected Gmail. Ask them to connect first.";
      const token = await getUserAccessToken("gmail", gmailUser);
      if (!token) return "Could not retrieve Gmail access token. The user may need to reconnect.";
      return gmailSend(token, args.to as string, args.subject as string, args.body as string);
    }

    case "calendar_list_events":
    case "calendar_create_event":
    case "calendar_get_event":
    case "calendar_check_availability": {
      if (!calendarUser) return "User has not connected Google Calendar. Ask them to connect first.";
      const token = await getUserAccessToken("calendar", calendarUser);
      if (!token) return "Could not retrieve Calendar access token. The user may need to reconnect.";
      if (name === "calendar_list_events")       return calendarListEvents(token, args.maxResults as number | undefined);
      if (name === "calendar_create_event")      return calendarCreateEvent(token, args.title as string, args.startDateTime as string, args.endDateTime as string, args.description as string | undefined, args.location as string | undefined, args.attendees as string[] | undefined);
      if (name === "calendar_check_availability") return calendarCheckAvailability(token, args.emails as string[], args.timeMin as string, args.timeMax as string);
      return calendarGetEvent(token, args.eventId as string);
    }

    case "slack_send_message":
    case "slack_list_channels":
    case "slack_lookup_user": {
      const slackToken = process.env.SLACK_BOT_TOKEN;
      if (!slackToken) return "Slack is not configured. Ask the admin to add SLACK_BOT_TOKEN.";
      if (name === "slack_send_message") return slackSendMessage(slackToken, args.channel as string, args.message as string);
      if (name === "slack_lookup_user") return slackLookupUserByEmail(slackToken, args.email as string);
      return slackListChannels(slackToken);
    }

    default:
      return null; // not a builtin tool
  }
}

async function executeCustom(name: string, args: Record<string, unknown>): Promise<string | null> {
  if (!name.startsWith("custom__")) return null;
  const toolId = name.slice("custom__".length);
  const def = (agentConfig.customTools ?? []).find((t) => t.id === toolId);
  if (!def) return `Custom tool "${name}" not found`;

  const url = def.url.replace(/\{\{(\w+)\}\}/g, (_, k) => encodeURIComponent(String(args[k] ?? "")));
  let body: string | undefined;
  if (def.bodyTemplate) {
    body = def.bodyTemplate.replace(/\{\{(\w+)\}\}/g, (_, k) => JSON.stringify(args[k] ?? ""));
  }
  return httpRequest(url, def.method, body ? JSON.parse(body) : undefined);
}

// ── Public interface ─────────────────────────────────────────────────────────

export interface ToolUse {
  name: string;
  input?: string;
  output?: string;
}

export interface ChatResult {
  reply: string;
  toolUses: ToolUse[];
}

async function runChat(
  message: string,
  history: Content[],
  mode: "search" | "tools",
  systemPrompt?: string,
  gmailUser?: string,
  calendarUser?: string,
  modelOverride?: ModelConfig,
  streamCallbacks?: StreamCallbacks,
): Promise<ChatResult> {
  const model: ModelConfig = modelOverride ?? agentConfig.model ?? { provider: "gemini", modelId: "gemini-2.5-flash" };
  const builtPrompt = buildSystemPrompt(systemPrompt);

  // Search mode: use Gemini built-in Google Search (no function tools)
  if (mode === "search" && agentConfig.tools.googleSearch) {
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const m = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      // @ts-ignore
      tools: [{ googleSearch: {} }],
      systemInstruction: builtPrompt,
    });
    const session = m.startChat({ history });
    const result = await session.sendMessage(message);
    return { reply: result.response.text(), toolUses: [] };
  }

  const builtinTools = buildBuiltinTools(gmailUser, calendarUser);
  const customTools = buildCustomTools();

  // Connect MCP servers for this request
  const mcpServers = agentConfig.mcpServers ?? {};
  const hasMCP = Object.keys(mcpServers).length > 0;
  const mcpToolSet = hasMCP ? await buildMCPTools(mcpServers) : null;

  const allTools = [...builtinTools, ...customTools, ...(mcpToolSet?.tools ?? [])];

  const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const builtin = await executeBuiltin(name, args, gmailUser, calendarUser);
    if (builtin !== null) return builtin;

    const custom = await executeCustom(name, args);
    if (custom !== null) return custom;

    if (mcpToolSet && name.startsWith("mcp__")) {
      return mcpToolSet.execute(name, args);
    }

    return "Tool not implemented";
  };

  try {
    if (streamCallbacks) {
      const toolUses = await chatWithModelStream(model, builtPrompt, history, message, allTools, executor, streamCallbacks);
      return { reply: "", toolUses }; // reply accumulated via onToken
    }
    return chatWithModel(model, builtPrompt, history, message, allTools, executor);
  } finally {
    await mcpToolSet?.close();
  }
}

export async function chat(
  message: string,
  history: Content[],
  mode: "search" | "tools" = "tools",
  systemPrompt?: string,
  gmailUser?: string,
  calendarUser?: string,
  modelOverride?: ModelConfig,
): Promise<ChatResult> {
  return runChat(message, history, mode, systemPrompt, gmailUser, calendarUser, modelOverride);
}

export async function chatStream(
  message: string,
  history: Content[],
  mode: "search" | "tools" = "tools",
  systemPrompt?: string,
  gmailUser?: string,
  calendarUser?: string,
  modelOverride?: ModelConfig,
  callbacks?: StreamCallbacks,
): Promise<ToolUse[]> {
  const result = await runChat(message, history, mode, systemPrompt, gmailUser, calendarUser, modelOverride, callbacks);
  return result.toolUses;
}
