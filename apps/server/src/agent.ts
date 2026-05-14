import {
  GoogleGenerativeAI,
  Content,
  Part,
  SchemaType,
  Tool,
  FunctionCall,
} from "@google/generative-ai";
import { fetchUrl, httpRequest } from "./tools";
import { gmailSend, gmailSearch, gmailRead } from "./gmail";
import { calendarListEvents, calendarCreateEvent, calendarGetEvent, calendarCheckAvailability } from "./calendar";
import { getUserAccessToken } from "./google-auth";
import { agentConfig } from "./config";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const FETCH_URL_DECL = {
  name: "fetch_url",
  description:
    "Fetch the content of a URL and return it as text. Use for reading web pages, documentation, or calling REST APIs.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      url: {
        type: SchemaType.STRING,
        description: "The full URL to fetch (must start with http:// or https://)",
      },
    },
    required: ["url"],
  },
};

const HTTP_REQUEST_DECL = {
  name: "http_request",
  description:
    "Make an HTTP request with a custom method and optional JSON body. Use for REST APIs that require POST, PUT, or PATCH with a JSON body.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      url: {
        type: SchemaType.STRING,
        description: "The full URL (must start with http:// or https://)",
      },
      method: {
        type: SchemaType.STRING,
        description: "HTTP method: GET, POST, PUT, PATCH, or DELETE",
      },
      body: {
        type: SchemaType.OBJECT,
        description: "JSON body to send with the request (optional)",
      },
    },
    required: ["url", "method"],
  },
};

const GMAIL_SEND_DECL = {
  name: "gmail_send",
  description: "Send an email via the user's connected Gmail account.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      to:      { type: SchemaType.STRING, description: "Recipient email address" },
      subject: { type: SchemaType.STRING, description: "Email subject" },
      body:    { type: SchemaType.STRING, description: "Email body (plain text)" },
    },
    required: ["to", "subject", "body"],
  },
};

const GMAIL_SEARCH_DECL = {
  name: "gmail_search",
  description: "Search the user's Gmail inbox. Supports Gmail search operators (from:, subject:, after:, etc.).",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      query:      { type: SchemaType.STRING, description: "Gmail search query" },
      maxResults: { type: SchemaType.NUMBER, description: "Max emails to return (default 10)" },
    },
    required: ["query"],
  },
};

const GMAIL_READ_DECL = {
  name: "gmail_read",
  description: "Read the full content of a specific email by its message ID.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      messageId: { type: SchemaType.STRING, description: "The Gmail message ID" },
    },
    required: ["messageId"],
  },
};

const CALENDAR_LIST_DECL = {
  name: "calendar_list_events",
  description: "List upcoming events from the user's Google Calendar.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      maxResults: { type: SchemaType.NUMBER, description: "Max events to return (default 10)" },
    },
    required: [],
  },
};

const CALENDAR_CREATE_DECL = {
  name: "calendar_create_event",
  description: "Create a new event in the user's Google Calendar. Invite attendees by including their emails — they will receive calendar invitations automatically.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      title:         { type: SchemaType.STRING, description: "Event title" },
      startDateTime: { type: SchemaType.STRING, description: "Start time in ISO 8601 format (e.g. 2026-05-15T10:00:00Z)" },
      endDateTime:   { type: SchemaType.STRING, description: "End time in ISO 8601 format" },
      description:   { type: SchemaType.STRING, description: "Event description (optional)" },
      location:      { type: SchemaType.STRING, description: "Event location (optional)" },
      attendees:     { type: SchemaType.ARRAY, description: "List of attendee email addresses (optional)", items: { type: SchemaType.STRING } },
    },
    required: ["title", "startDateTime", "endDateTime"],
  },
};

const CALENDAR_CHECK_DECL = {
  name: "calendar_check_availability",
  description: "Check free/busy availability for one or more people within a time range. Use this before creating a meeting to find the earliest open slot for all attendees.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      emails:  { type: SchemaType.ARRAY, description: "List of email addresses to check", items: { type: SchemaType.STRING } },
      timeMin: { type: SchemaType.STRING, description: "Start of the time range in ISO 8601 format" },
      timeMax: { type: SchemaType.STRING, description: "End of the time range in ISO 8601 format" },
    },
    required: ["emails", "timeMin", "timeMax"],
  },
};

const CALENDAR_GET_DECL = {
  name: "calendar_get_event",
  description: "Get details of a specific calendar event by its ID.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      eventId: { type: SchemaType.STRING, description: "The Google Calendar event ID" },
    },
    required: ["eventId"],
  },
};

function buildTools(mode: "search" | "tools", gmailUser?: string, calendarUser?: string): Tool[] {
  // Gemini cannot combine built-in tools and function declarations in one request
  if (mode === "search") {
    const tools: Tool[] = [];
    // @ts-ignore
    if (agentConfig.tools.googleSearch) tools.push({ googleSearch: {} });
    // @ts-ignore
    if (agentConfig.tools.codeExecution) tools.push({ codeExecution: {} });
    return tools;
  }

  const functionDeclarations = [];
  if (agentConfig.tools.fetchUrl) functionDeclarations.push(FETCH_URL_DECL);
  if (agentConfig.tools.httpRequest) functionDeclarations.push(HTTP_REQUEST_DECL);
  // Google tools are available immediately when user has connected — no redeploy needed
  if (gmailUser) functionDeclarations.push(GMAIL_SEND_DECL, GMAIL_SEARCH_DECL, GMAIL_READ_DECL);
  if (calendarUser) functionDeclarations.push(CALENDAR_LIST_DECL, CALENDAR_CREATE_DECL, CALENDAR_GET_DECL, CALENDAR_CHECK_DECL);
  return functionDeclarations.length > 0 ? [{ functionDeclarations }] : [];
}

export interface ToolUse {
  name: string;
  input?: string;
  output?: string;
}

export interface ChatResult {
  reply: string;
  toolUses: ToolUse[];
}

export async function chat(message: string, history: Content[], mode: "search" | "tools" = "tools", systemPrompt?: string, gmailUser?: string, calendarUser?: string): Promise<ChatResult> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: buildTools(mode, gmailUser, calendarUser),
    systemInstruction: systemPrompt ?? agentConfig.systemPrompt,
  });

  const session = model.startChat({ history });
  const toolUses: ToolUse[] = [];

  let result = await session.sendMessage(message);

  while (result.response.functionCalls()?.length) {
    const calls = result.response.functionCalls()!;

    const responses: Part[] = await Promise.all(
      calls.map(async (call: FunctionCall) => {
        let output = "Tool not implemented";

        if (call.name === "fetch_url") {
          const url = (call.args as { url: string }).url;
          output = await fetchUrl(url);
          toolUses.push({ name: "fetch_url", input: url, output: output.slice(0, 500) });
        } else if (call.name === "http_request") {
          const { url, method, body } = call.args as { url: string; method: string; body?: unknown };
          output = await httpRequest(url, method, body);
          toolUses.push({ name: "http_request", input: `${method} ${url}`, output: output.slice(0, 500) });
        } else if (call.name === "gmail_send" || call.name === "gmail_search" || call.name === "gmail_read") {
          if (!gmailUser) {
            output = "User has not connected their Gmail account. Ask them to connect Gmail first.";
          } else {
            const accessToken = await getUserAccessToken("gmail", gmailUser);
            if (!accessToken) {
              output = "Could not retrieve Gmail access token. The user may need to reconnect their Gmail account.";
            } else if (call.name === "gmail_send") {
              const { to, subject, body } = call.args as { to: string; subject: string; body: string };
              output = await gmailSend(accessToken, to, subject, body);
            } else if (call.name === "gmail_search") {
              const { query, maxResults } = call.args as { query: string; maxResults?: number };
              output = await gmailSearch(accessToken, query, maxResults);
            } else {
              const { messageId } = call.args as { messageId: string };
              output = await gmailRead(accessToken, messageId);
            }
          }
          toolUses.push({ name: call.name, input: JSON.stringify(call.args), output: output.slice(0, 500) });
        } else if (call.name === "calendar_list_events" || call.name === "calendar_create_event" || call.name === "calendar_get_event") {
          if (!calendarUser) {
            output = "User has not connected their Google Calendar. Ask them to connect Google Calendar first.";
          } else {
            const accessToken = await getUserAccessToken("calendar", calendarUser);
            if (!accessToken) {
              output = "Could not retrieve Google access token. The user may need to reconnect their account.";
            } else if (call.name === "calendar_list_events") {
              const { maxResults } = call.args as { maxResults?: number };
              output = await calendarListEvents(accessToken, maxResults);
            } else if (call.name === "calendar_create_event") {
              const { title, startDateTime, endDateTime, description, location, attendees } = call.args as { title: string; startDateTime: string; endDateTime: string; description?: string; location?: string; attendees?: string[] };
              output = await calendarCreateEvent(accessToken, title, startDateTime, endDateTime, description, location, attendees);
            } else if (call.name === "calendar_check_availability") {
              const { emails, timeMin, timeMax } = call.args as { emails: string[]; timeMin: string; timeMax: string };
              output = await calendarCheckAvailability(accessToken, emails, timeMin, timeMax);
            } else {
              const { eventId } = call.args as { eventId: string };
              output = await calendarGetEvent(accessToken, eventId);
            }
          }
          toolUses.push({ name: call.name, input: JSON.stringify(call.args), output: output.slice(0, 500) });
        }

        return {
          functionResponse: { name: call.name, response: { result: output } },
        } as Part;
      })
    );

    result = await session.sendMessage(responses);
  }

  return { reply: result.response.text(), toolUses };
}
