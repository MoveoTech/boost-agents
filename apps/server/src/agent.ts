import type { Content } from "@google/generative-ai";
import { chatWithModel, type ModelConfig, type ToolDecl } from "./llm";
import { fetchUrl, httpRequest } from "./tools";
import { gmailSend, gmailSearch, gmailRead } from "./gmail";
import { calendarListEvents, calendarCreateEvent, calendarGetEvent, calendarCheckAvailability } from "./calendar";
import { getUserAccessToken } from "./google-auth";
import { agentConfig } from "./config";

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
  gmail_search: {
    name: "gmail_search", description: "Search the user's Gmail. Supports Gmail operators (from:, subject:, after:, etc.).",
    parameters: {
      properties: {
        query:      { type: "string", description: "Gmail search query" },
        maxResults: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  gmail_read: {
    name: "gmail_read", description: "Read the full content of a specific email by its message ID.",
    parameters: { properties: { messageId: { type: "string", description: "Gmail message ID" } }, required: ["messageId"] },
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

function buildTools(gmailUser?: string, calendarUser?: string, toolPreferences?: Record<string, boolean>): ToolDecl[] {
  const prefs = toolPreferences ?? {};
  const enabled = (key: keyof typeof agentConfig.tools) =>
    key in prefs ? prefs[key] : agentConfig.tools[key];
  const tools: ToolDecl[] = [];
  if (enabled("fetchUrl"))    tools.push(ALL_TOOLS.fetch_url);
  if (enabled("httpRequest")) tools.push(ALL_TOOLS.http_request);
  if (gmailUser    && enabled("gmail"))         tools.push(ALL_TOOLS.gmail_send, ALL_TOOLS.gmail_search, ALL_TOOLS.gmail_read);
  if (calendarUser && enabled("googleCalendar")) tools.push(ALL_TOOLS.calendar_list_events, ALL_TOOLS.calendar_create_event, ALL_TOOLS.calendar_get_event, ALL_TOOLS.calendar_check_availability);
  return tools;
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function execute(name: string, args: Record<string, unknown>, gmailUser?: string, calendarUser?: string): Promise<string> {
  switch (name) {
    case "fetch_url":
      return fetchUrl(args.url as string);

    case "http_request":
      return httpRequest(args.url as string, args.method as string, args.body);

    case "gmail_send":
    case "gmail_search":
    case "gmail_read": {
      if (!gmailUser) return "User has not connected Gmail. Ask them to connect first.";
      const token = await getUserAccessToken("gmail", gmailUser);
      if (!token) return "Could not retrieve Gmail access token. The user may need to reconnect.";
      if (name === "gmail_send")   return gmailSend(token, args.to as string, args.subject as string, args.body as string);
      if (name === "gmail_search") return gmailSearch(token, args.query as string, args.maxResults as number | undefined);
      return gmailRead(token, args.messageId as string);
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

    default:
      return "Tool not implemented";
  }
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

export async function chat(
  message: string,
  history: Content[],
  mode: "search" | "tools" = "tools",
  systemPrompt?: string,
  gmailUser?: string,
  calendarUser?: string,
  modelOverride?: ModelConfig,
  toolPreferences?: Record<string, boolean>,
  systemPromptAddition?: string,
): Promise<ChatResult> {
  const model: ModelConfig = modelOverride ?? agentConfig.model ?? { provider: "gemini", modelId: "gemini-2.5-flash" };
  const builtPrompt = buildSystemPrompt(systemPrompt, systemPromptAddition);

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

  const tools = buildTools(gmailUser, calendarUser, toolPreferences);
  return chatWithModel(
    model,
    builtPrompt,
    history,
    message,
    tools,
    (name, args) => execute(name, args, gmailUser, calendarUser)
  );
}
