import type { Content } from "@google/generative-ai";
import { chatWithModel, chatWithModelStream, type ModelConfig, type ToolDecl, type StreamCallbacks, type ImageAttachment } from "./llm";
import { fetchUrl, httpRequest, readWebpage, searchImage } from "./tools";
import { gmailSend } from "./gmail";
import { slackSendMessage, slackListChannels, slackLookupUserByEmail } from "./slack";
import { mondayGraphQL, mondayCreateItem, mondayUpdateItem, mondayCreateUpdate } from "./monday";
import { tasksListTasklists, tasksListTasks, tasksCreateTask, tasksCompleteTask, tasksUpdateTask, tasksDeleteTask } from "./tasks";
import { calendarListEvents, calendarCreateEvent, calendarGetEvent, calendarCheckAvailability } from "./calendar";
import { memorySave, memoryRecall, memoryDelete } from "./memory";
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
  tasks_list_tasklists: {
    name: "tasks_list_tasklists", description: "List all Google Task lists the user has.",
    parameters: { properties: {}, required: [] },
  },
  tasks_list_tasks: {
    name: "tasks_list_tasks", description: "List tasks in a Google Tasks list.",
    parameters: {
      properties: {
        tasklistId:    { type: "string", description: "Task list ID (default: @default for primary list)" },
        showCompleted: { type: "boolean", description: "Include completed tasks (default false)" },
      },
      required: [],
    },
  },
  tasks_create_task: {
    name: "tasks_create_task", description: "Create a new task in Google Tasks.",
    parameters: {
      properties: {
        title:      { type: "string", description: "Task title" },
        tasklistId: { type: "string", description: "Task list ID (default: @default)" },
        notes:      { type: "string", description: "Additional notes (optional)" },
        due:        { type: "string", description: "Due date in ISO 8601 format (optional)" },
      },
      required: ["title"],
    },
  },
  tasks_complete_task: {
    name: "tasks_complete_task", description: "Mark a Google Task as completed.",
    parameters: {
      properties: {
        taskId:     { type: "string", description: "Task ID" },
        tasklistId: { type: "string", description: "Task list ID (default: @default)" },
      },
      required: ["taskId"],
    },
  },
  tasks_update_task: {
    name: "tasks_update_task", description: "Update a task's title, notes, or due date.",
    parameters: {
      properties: {
        taskId:     { type: "string", description: "Task ID" },
        tasklistId: { type: "string", description: "Task list ID (default: @default)" },
        title:      { type: "string", description: "New title (optional)" },
        notes:      { type: "string", description: "New notes (optional)" },
        due:        { type: "string", description: "New due date in ISO 8601 (optional)" },
      },
      required: ["taskId"],
    },
  },
  tasks_delete_task: {
    name: "tasks_delete_task", description: "Delete a task from Google Tasks.",
    parameters: {
      properties: {
        taskId:     { type: "string", description: "Task ID" },
        tasklistId: { type: "string", description: "Task list ID (default: @default)" },
      },
      required: ["taskId"],
    },
  },
  monday_graphql: {
    name: "monday_graphql",
    description: `Execute any GraphQL query or mutation against the Monday.com API. Use this for all read operations and any query not covered by the specific write tools. The Monday GraphQL API endpoint is https://api.monday.com/v2.

Common query patterns:
- List boards with owners: { boards(limit:50) { id name owners { id name email } } }
- Items with column values: { boards(ids:[$boardId]) { items_page(limit:50) { items { id name column_values { id text value } } } } }
- Filter items by column: use items_page with a query_params argument: { boards(ids:[$boardId]) { items_page(query_params: { rules: [{ column_id: "priority", compare_value: ["High"] }] }) { items { id name } } } }
- Current user info: { me { id name email } }
- Search items: { items_by_name(board_ids:[$boardId], limit:10, name:"search term") { id name } }`,
    parameters: {
      properties: {
        query:     { type: "string", description: "The GraphQL query or mutation string" },
        variables: { type: "object", description: "Optional GraphQL variables (use $var in query, pass values here)" },
      },
      required: ["query"],
    },
  },
  monday_create_item: {
    name: "monday_create_item", description: "Create a new item on a monday.com board.",
    parameters: {
      properties: {
        boardId:      { type: "string", description: "The board ID" },
        itemName:     { type: "string", description: "Name of the new item" },
        columnValues: { type: "object", description: "Optional column values as {columnId: value}" },
      },
      required: ["boardId", "itemName"],
    },
  },
  monday_update_item: {
    name: "monday_update_item", description: "Update column values of an existing monday.com item.",
    parameters: {
      properties: {
        boardId:      { type: "string", description: "The board ID" },
        itemId:       { type: "string", description: "The item ID" },
        columnValues: { type: "object", description: "Column values to update as {columnId: value}" },
      },
      required: ["boardId", "itemId", "columnValues"],
    },
  },
  monday_create_update: {
    name: "monday_create_update", description: "Post a text update/comment on a monday.com item.",
    parameters: {
      properties: {
        itemId: { type: "string", description: "The item ID" },
        body:   { type: "string", description: "The update text" },
      },
      required: ["itemId", "body"],
    },
  },
  monday_search_items: {
    name: "monday_search_items", description: "Search for items by name across monday.com boards.",
    parameters: {
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  read_webpage: {
    name: "read_webpage", description: "Fetch a URL and return its content as clean readable text/markdown. Use this to read articles, websites, and search result pages. Prefer this over fetch_url for any human-readable web content.",
    parameters: {
      properties: { url: { type: "string", description: "Full URL to read (http:// or https://)" } },
      required: ["url"],
    },
  },
  search_image: {
    name: "search_image", description: "Find and return an image for a given topic using Wikipedia. Returns a markdown image tag that renders inline. Use this whenever the user asks for a picture, photo, or image of something.",
    parameters: {
      properties: { query: { type: "string", description: "What to search for (e.g. 'white corn', 'Eiffel Tower')" } },
      required: ["query"],
    },
  },
  memory_save: {
    name: "memory_save", description: "Save a fact, preference, or piece of information about the user to remember in future conversations. Use a short descriptive key.",
    parameters: {
      properties: {
        key:   { type: "string", description: "Short key to identify this memory (e.g. 'preferred_language', 'role', 'company')" },
        value: { type: "string", description: "The value to remember" },
      },
      required: ["key", "value"],
    },
  },
  memory_recall: {
    name: "memory_recall", description: "Recall saved memories about the user. Omit key to list all memories.",
    parameters: {
      properties: { key: { type: "string", description: "Specific memory key to retrieve (optional — omit to get all)" } },
      required: [],
    },
  },
  memory_delete: {
    name: "memory_delete", description: "Delete a saved memory by key.",
    parameters: {
      properties: { key: { type: "string", description: "The memory key to delete" } },
      required: ["key"],
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

  const caps: string[] = [];
  if (agentConfig.tools.jinaReader ?? true) {
    caps.push("- **Read webpages & search**: Use read_webpage to fetch any URL as clean readable text. For web searches fetch `https://html.duckduckgo.com/html/?q=your+search+terms` (URL-encode spaces as +). Always search when asked — never say you cannot.");
    caps.push("- **Images**: Use search_image whenever the user asks for a picture, photo, or image of anything. It returns a markdown image that renders inline in the chat. Never say you cannot show images — always call search_image.");
  } else if (agentConfig.tools.fetchUrl) {
    caps.push("- **Web search**: Use fetch_url with `https://html.duckduckgo.com/html/?q=your+search+terms` to search the web. Always search when asked — never say you cannot.");
  }
  if (agentConfig.tools.httpRequest) {
    caps.push("- **Custom API calls**: Use http_request to call any REST API with GET, POST, PUT, PATCH, or DELETE and an optional JSON body.");
  }
  if (agentConfig.tools.memory ?? true) {
    caps.push("- **Memory**: Use memory_save to remember important facts about the user between conversations. Use memory_recall at the start of conversations to retrieve what you know. Use memory_delete to forget outdated info.");
  }
  const capsBlock = caps.length
    ? `\n\n---\n\nYou have access to the following capabilities:\n${caps.join("\n")}`
    : "";

  return `${base}${skillsBlock}${additionBlock}${capsBlock}`;
}

function buildBuiltinTools(gmailUser?: string, calendarUser?: string, mondayToken?: string, tasksUser?: string, memoryUser?: string): ToolDecl[] {
  const tools: ToolDecl[] = [];
  if (agentConfig.tools.fetchUrl)    tools.push(ALL_TOOLS.fetch_url);
  if (agentConfig.tools.httpRequest) tools.push(ALL_TOOLS.http_request);
  if (agentConfig.tools.jinaReader ?? true) tools.push(ALL_TOOLS.read_webpage, ALL_TOOLS.search_image);
  if (gmailUser)    tools.push(ALL_TOOLS.gmail_send);
  if (calendarUser) tools.push(ALL_TOOLS.calendar_list_events, ALL_TOOLS.calendar_create_event, ALL_TOOLS.calendar_get_event, ALL_TOOLS.calendar_check_availability);
  if (agentConfig.tools.slack && process.env.SLACK_BOT_TOKEN) tools.push(ALL_TOOLS.slack_send_message, ALL_TOOLS.slack_list_channels, ALL_TOOLS.slack_lookup_user);
  if (mondayToken)  tools.push(ALL_TOOLS.monday_graphql, ALL_TOOLS.monday_create_item, ALL_TOOLS.monday_update_item, ALL_TOOLS.monday_create_update);
  if (tasksUser)    tools.push(ALL_TOOLS.tasks_list_tasklists, ALL_TOOLS.tasks_list_tasks, ALL_TOOLS.tasks_create_task, ALL_TOOLS.tasks_complete_task, ALL_TOOLS.tasks_update_task, ALL_TOOLS.tasks_delete_task);
  if ((agentConfig.tools.memory ?? true) && memoryUser) tools.push(ALL_TOOLS.memory_save, ALL_TOOLS.memory_recall, ALL_TOOLS.memory_delete);
  return tools;
}


// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeBuiltin(name: string, args: Record<string, unknown>, gmailUser?: string, calendarUser?: string, mondayToken?: string, tasksUser?: string, memoryUser?: string): Promise<string | null> {
  switch (name) {
    case "fetch_url":
      return fetchUrl(args.url as string);

    case "read_webpage":
      return readWebpage(args.url as string);

    case "search_image":
      return searchImage(args.query as string);

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

    case "monday_graphql":
    case "monday_create_item":
    case "monday_update_item":
    case "monday_create_update": {
      const token = mondayToken;
      if (!token) return "Monday is not connected. Ask the user to connect their Monday account.";
      if (name === "monday_graphql")       return mondayGraphQL(token, args.query as string, args.variables as Record<string, unknown> | undefined);
      if (name === "monday_create_item")   return mondayCreateItem(token, args.boardId as string, args.itemName as string, args.columnValues as Record<string, string> | undefined);
      if (name === "monday_update_item")   return mondayUpdateItem(token, args.boardId as string, args.itemId as string, args.columnValues as Record<string, string>);
      return mondayCreateUpdate(token, args.itemId as string, args.body as string);
    }

    case "tasks_list_tasklists":
    case "tasks_list_tasks":
    case "tasks_create_task":
    case "tasks_complete_task":
    case "tasks_update_task":
    case "tasks_delete_task": {
      if (!tasksUser) return "User has not connected Google Tasks. Ask them to connect first.";
      const token = await getUserAccessToken("tasks", tasksUser);
      if (!token) return "Could not retrieve Google Tasks token. The user may need to reconnect.";
      if (name === "tasks_list_tasklists") return tasksListTasklists(token);
      if (name === "tasks_list_tasks")     return tasksListTasks(token, args.tasklistId as string | undefined, args.showCompleted as boolean | undefined);
      if (name === "tasks_create_task")    return tasksCreateTask(token, args.title as string, args.tasklistId as string | undefined, args.notes as string | undefined, args.due as string | undefined);
      if (name === "tasks_complete_task")  return tasksCompleteTask(token, args.taskId as string, args.tasklistId as string | undefined);
      if (name === "tasks_update_task")    return tasksUpdateTask(token, args.taskId as string, args.tasklistId as string | undefined, args.title as string | undefined, args.notes as string | undefined, args.due as string | undefined);
      return tasksDeleteTask(token, args.taskId as string, args.tasklistId as string | undefined);
    }

    case "memory_save":
      if (!memoryUser) return "Memory requires a logged-in user.";
      return memorySave(memoryUser, args.key as string, args.value as string);

    case "memory_recall":
      if (!memoryUser) return "Memory requires a logged-in user.";
      return memoryRecall(memoryUser, args.key as string | undefined);

    case "memory_delete":
      if (!memoryUser) return "Memory requires a logged-in user.";
      return memoryDelete(memoryUser, args.key as string);

    default:
      return null; // not a builtin tool
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

async function runChat(
  message: string,
  history: Content[],
  mode: "search" | "tools",
  systemPrompt?: string,
  gmailUser?: string,
  calendarUser?: string,
  modelOverride?: ModelConfig,
  streamCallbacks?: StreamCallbacks,
  mondayToken?: string,
  tasksUser?: string,
  memoryUser?: string,
  image?: ImageAttachment,
): Promise<ChatResult> {
  const model: ModelConfig = modelOverride ?? agentConfig.model ?? { provider: "gemini", modelId: "gemini-2.5-flash" };
  const builtPrompt = buildSystemPrompt(systemPrompt);

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

  const allTools = buildBuiltinTools(gmailUser, calendarUser, mondayToken, tasksUser, memoryUser);
  const nativeSearch = agentConfig.tools.googleSearch;

  const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await executeBuiltin(name, args, gmailUser, calendarUser, mondayToken, tasksUser, memoryUser);
    return result ?? "Tool not implemented";
  };

  if (streamCallbacks) {
    const toolUses = await chatWithModelStream(model, builtPrompt, history, message, allTools, executor, streamCallbacks, nativeSearch, image);
    return { reply: "", toolUses };
  }
  return chatWithModel(model, builtPrompt, history, message, allTools, executor, nativeSearch, image);
}

export async function chat(
  message: string,
  history: Content[],
  mode: "search" | "tools" = "tools",
  systemPrompt?: string,
  gmailUser?: string,
  calendarUser?: string,
  modelOverride?: ModelConfig,
  mondayToken?: string,
  tasksUser?: string,
  memoryUser?: string,
  image?: ImageAttachment,
): Promise<ChatResult> {
  return runChat(message, history, mode, systemPrompt, gmailUser, calendarUser, modelOverride, undefined, mondayToken, tasksUser, memoryUser, image);
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
  mondayToken?: string,
  tasksUser?: string,
  memoryUser?: string,
  image?: ImageAttachment,
): Promise<ToolUse[]> {
  const result = await runChat(message, history, mode, systemPrompt, gmailUser, calendarUser, modelOverride, callbacks, mondayToken, tasksUser, memoryUser, image);
  return result.toolUses;
}

export type { ImageAttachment };
