import type { Content } from "@google/generative-ai";
import { chatWithModel, chatWithModelStream, type ModelConfig, type ToolDecl, type StreamCallbacks, type ImageAttachment } from "./llm";
import { fetchUrl, httpRequest, readWebpage, searchImage } from "./tools";
import { gmailSend } from "./gmail";
import { slackSendMessage, slackListChannels, slackLookupUserByEmail } from "./slack";
import {
  mondayGraphQL, mondayListBoards, mondayGetBoard, mondayCreateBoard,
  mondayGetItems, mondayGetItem, mondayCreateItem, mondayUpdateItem,
  mondayDeleteItem, mondayArchiveItem, mondayMoveItemToGroup,
  mondayDuplicateItem, mondayCreateSubitem,
  mondayCreateGroup, mondayDeleteGroup, mondayCreateColumn,
  mondayGetUpdates, mondayCreateUpdate, mondayDeleteUpdate,
  mondayGetMe, mondayGetUsers,
} from "./monday";
import { tasksListTasklists, tasksListTasks, tasksCreateTask, tasksCompleteTask, tasksUpdateTask, tasksDeleteTask } from "./tasks";
import { calendarListEvents, calendarCreateEvent, calendarGetEvent, calendarCheckAvailability, calendarRsvp } from "./calendar";
import { memorySave, memoryRecall, memoryDelete } from "./memory";
import { sendMessage as waSendMessage, getStatus as waGetStatus } from "./whatsapp";
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
  calendar_rsvp: {
    name: "calendar_rsvp", description: "Accept, decline, or tentatively accept a Google Calendar event invitation. Use this — not Monday.com — for any meeting approval or RSVP.",
    parameters: {
      properties: {
        eventId:        { type: "string", description: "Calendar event ID (get it from calendar_list_events or calendar_get_event)" },
        responseStatus: { type: "string", description: "One of: accepted, declined, tentative" },
      },
      required: ["eventId", "responseStatus"],
    },
  },
  whatsapp_send_message: {
    name: "whatsapp_send_message",
    description: "Send a WhatsApp message to a phone number on behalf of the user. Only available when the user has connected WhatsApp.",
    parameters: {
      properties: {
        to:      { type: "string", description: "Recipient phone number with country code, e.g. +972501234567" },
        message: { type: "string", description: "The message text to send" },
      },
      required: ["to", "message"],
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
  // ── Monday.com ──────────────────────────────────────────────────────────────
  monday_graphql: {
    name: "monday_graphql",
    description: "Execute any GraphQL query or mutation against the Monday.com API. Use as an escape hatch when no specific tool covers your need.",
    parameters: {
      properties: {
        query:     { type: "string", description: "GraphQL query or mutation string" },
        variables: { type: "object", description: "Optional GraphQL variables" },
      },
      required: ["query"],
    },
  },
  monday_list_boards: {
    name: "monday_list_boards",
    description: "List all Monday.com boards the user has access to, including their IDs, groups, and item count. Always call this first to discover board IDs before other operations.",
    parameters: {
      properties: { limit: { type: "number", description: "Max boards to return (default 50)" } },
      required: [],
    },
  },
  monday_get_board: {
    name: "monday_get_board",
    description: "Get full schema of a Monday.com board: columns (id, title, type) and groups. Always call this before creating or updating items. Users refer to columns by title (e.g. 'working hours', 'work day') — match those titles to the column id field, then use the id in columnValues.",
    parameters: {
      properties: { boardId: { type: "string", description: "Board ID" } },
      required: ["boardId"],
    },
  },
  monday_create_board: {
    name: "monday_create_board",
    description: "Create a new Monday.com board.",
    parameters: {
      properties: {
        boardName:   { type: "string", description: "Board name" },
        boardKind:   { type: "string", description: "public | private | share (default: public)" },
        workspaceId: { type: "string", description: "Target workspace ID (optional)" },
        description: { type: "string", description: "Board description (optional)" },
      },
      required: ["boardName"],
    },
  },
  monday_get_items: {
    name: "monday_get_items",
    description: `Fetch items from a Monday.com board with filtering and pagination.

FILTER compareValue FORMAT BY COLUMN TYPE (critical — wrong format returns empty results):
- people: ["person-{userId}"] or ["team-{teamId}"] or ["assigned_to_me"] — NEVER use raw id like ["95152239"]
- status: [labelIndex] e.g. [0,1] with any_of, or label text string with contains_terms
- date: ["EXACT","YYYY-MM-DD"] with any_of, or "TODAY"/"THIS_WEEK" string with greater_than/lower_than
- text/long_text: ["exact value"] with any_of, or plain string with contains_text
- numbers: [100,200] with any_of, or single number with greater_than/lower_than
- name column: plain string with contains_text or not_contains_text
- checkbox: [] (empty array) with is_empty or is_not_empty
- last_updated: ["TODAY"] with compareAttribute:"UPDATED_AT"

OPERATOR RULES:
- any_of, not_any_of, between → compareValue must be an ARRAY
- is_empty, is_not_empty → compareValue must be EMPTY ARRAY []
- greater_than, lower_than, contains_text, not_contains_text → compareValue must be a SINGLE value (not array)`,
    parameters: {
      properties: {
        boardId:         { type: "string",  description: "Board ID" },
        limit:           { type: "number",  description: "Items per page (default 50, max 500)" },
        cursor:          { type: "string",  description: "Pagination cursor from previous response" },
        searchTerm:      { type: "string",  description: "Full-text search across all columns" },
        groupId:         { type: "string",  description: "Filter by group ID" },
        filters:         { type: "array",   description: "Column filter rules: [{columnId, compareValue, operator}]. See description for correct compareValue format per column type.", items: { type: "object" } },
        filtersOperator: { type: "string",  description: "and | or — how to combine filters (default: and)" },
        columnIds:       { type: "array",   description: "Only return values for these column IDs (improves performance)", items: { type: "string" } },
        includeSubitems: { type: "boolean", description: "Include sub-items (default false)" },
      },
      required: ["boardId"],
    },
  },
  monday_get_item: {
    name: "monday_get_item",
    description: "Get full details of a single Monday.com item: all column values, updates/comments, sub-items, and parent item.",
    parameters: {
      properties: { itemId: { type: "string", description: "Item ID" } },
      required: ["itemId"],
    },
  },
  monday_create_item: {
    name: "monday_create_item",
    description: `Create a new item on a Monday.com board.
IMPORTANT: You MUST call monday_get_board first to get the real column IDs — never guess them. Column IDs look like "date4", "numbers7", "status", etc.
Column value formats by type:
- date: {"date":"2025-05-24"}
- numbers/hour: 4  (plain number)
- status: {"label":"Done"}
- text/long_text: "value"
- dropdown: {"labels":["Option1"]}
- checkbox: {"checked":"true"}
- timeline: {"from":"2025-05-24","to":"2025-05-30"}
- person: {"personsAndTeams":[{"id":12345,"kind":"person"}]}
Only include columns that have actual values — omit the rest.
ALWAYS include the item ID from the result in your reply (e.g. "Created item ID 123456789") so it can be referenced in follow-up requests.`,
    parameters: {
      properties: {
        boardId:      { type: "string", description: "Board ID" },
        itemName:     { type: "string", description: "Item name" },
        groupId:      { type: "string", description: "Group ID to create item in (optional)" },
        columnValues: { type: "object", description: "Column values as { columnId: value } using real IDs from monday_get_board" },
      },
      required: ["boardId", "itemName"],
    },
  },
  monday_update_item: {
    name: "monday_update_item",
    description: `Update one or more column values of an existing Monday.com item.
IMPORTANT: Use real column IDs from monday_get_board — never guess. Same value formats as monday_create_item.`,
    parameters: {
      properties: {
        boardId:      { type: "string", description: "Board ID" },
        itemId:       { type: "string", description: "Item ID" },
        columnValues: { type: "object", description: "Columns to update as { columnId: value } using real IDs from monday_get_board" },
      },
      required: ["boardId", "itemId", "columnValues"],
    },
  },
  monday_delete_item: {
    name: "monday_delete_item",
    description: "Permanently delete a Monday.com item. Use monday_archive_item if you want to keep it recoverable.",
    parameters: {
      properties: { itemId: { type: "string", description: "Item ID" } },
      required: ["itemId"],
    },
  },
  monday_archive_item: {
    name: "monday_archive_item",
    description: "Archive a Monday.com item (hidden but recoverable, unlike delete).",
    parameters: {
      properties: { itemId: { type: "string", description: "Item ID" } },
      required: ["itemId"],
    },
  },
  monday_move_item_to_group: {
    name: "monday_move_item_to_group",
    description: "Move an item to a different group within the same board.",
    parameters: {
      properties: {
        itemId:  { type: "string", description: "Item ID" },
        groupId: { type: "string", description: "Target group ID" },
      },
      required: ["itemId", "groupId"],
    },
  },
  monday_duplicate_item: {
    name: "monday_duplicate_item",
    description: "Duplicate an existing Monday.com item. Always include the new item ID in your reply.",
    parameters: {
      properties: {
        boardId:     { type: "string",  description: "Board ID" },
        itemId:      { type: "string",  description: "Item ID to duplicate" },
        withUpdates: { type: "boolean", description: "Also copy updates/comments (default false)" },
      },
      required: ["boardId", "itemId"],
    },
  },
  monday_create_subitem: {
    name: "monday_create_subitem",
    description: "Create a sub-item under an existing Monday.com item. Always include the new subitem ID in your reply.",
    parameters: {
      properties: {
        parentItemId: { type: "string", description: "Parent item ID" },
        itemName:     { type: "string", description: "Sub-item name" },
        columnValues: { type: "object", description: "Column values (optional)" },
      },
      required: ["parentItemId", "itemName"],
    },
  },
  monday_create_group: {
    name: "monday_create_group",
    description: "Create a new group (section) in a Monday.com board.",
    parameters: {
      properties: {
        boardId:    { type: "string", description: "Board ID" },
        groupName:  { type: "string", description: "Group name" },
        groupColor: { type: "string", description: "Hex color (optional, e.g. #ff0000)" },
      },
      required: ["boardId", "groupName"],
    },
  },
  monday_delete_group: {
    name: "monday_delete_group",
    description: "Delete a group from a Monday.com board. All items in the group will be deleted.",
    parameters: {
      properties: {
        boardId: { type: "string", description: "Board ID" },
        groupId: { type: "string", description: "Group ID" },
      },
      required: ["boardId", "groupId"],
    },
  },
  monday_create_column: {
    name: "monday_create_column",
    description: "Add a new column to a Monday.com board. Column types: text | numbers | status | date | person | timeline | checkbox | dropdown | email | phone | url | long_text | color_picker | rating | world_clock | country | location | week | hour | item_id | auto_number | progress | dependency | connect_boards | formula | button | vote | time_tracking | file | tags | mirror | subitems",
    parameters: {
      properties: {
        boardId:     { type: "string", description: "Board ID" },
        columnTitle: { type: "string", description: "Column title" },
        columnType:  { type: "string", description: "Column type (see description)" },
        description: { type: "string", description: "Column description (optional)" },
      },
      required: ["boardId", "columnTitle", "columnType"],
    },
  },
  monday_get_updates: {
    name: "monday_get_updates",
    description: "Get updates (comments and replies) on a Monday.com item.",
    parameters: {
      properties: {
        itemId: { type: "string", description: "Item ID" },
        limit:  { type: "number", description: "Max updates to return (default 25)" },
      },
      required: ["itemId"],
    },
  },
  monday_create_update: {
    name: "monday_create_update",
    description: "Post an update (comment) on a Monday.com item.",
    parameters: {
      properties: {
        itemId: { type: "string", description: "Item ID" },
        body:   { type: "string", description: "Update text (supports basic HTML)" },
      },
      required: ["itemId", "body"],
    },
  },
  monday_delete_update: {
    name: "monday_delete_update",
    description: "Delete an update/comment from a Monday.com item.",
    parameters: {
      properties: { updateId: { type: "string", description: "Update ID" } },
      required: ["updateId"],
    },
  },
  monday_get_me: {
    name: "monday_get_me",
    description: "Get the current authenticated Monday.com user's profile and account info.",
    parameters: { properties: {}, required: [] },
  },
  monday_get_users: {
    name: "monday_get_users",
    description: "List Monday.com users. Optionally filter by name. Useful for finding user IDs for assigning items.",
    parameters: {
      properties: {
        limit: { type: "number", description: "Max users to return (default 50)" },
        name:  { type: "string", description: "Filter by name (optional)" },
      },
      required: [],
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

function buildBuiltinTools(gmailUser?: string, calendarUser?: string, mondayToken?: string, tasksUser?: string, memoryUser?: string, whatsappUser?: string): ToolDecl[] {
  const tools: ToolDecl[] = [];
  if (agentConfig.tools.fetchUrl)    tools.push(ALL_TOOLS.fetch_url);
  if (agentConfig.tools.httpRequest) tools.push(ALL_TOOLS.http_request);
  if (agentConfig.tools.jinaReader ?? true) tools.push(ALL_TOOLS.read_webpage, ALL_TOOLS.search_image);
  if (gmailUser)    tools.push(ALL_TOOLS.gmail_send);
  if (calendarUser) tools.push(ALL_TOOLS.calendar_list_events, ALL_TOOLS.calendar_create_event, ALL_TOOLS.calendar_get_event, ALL_TOOLS.calendar_check_availability, ALL_TOOLS.calendar_rsvp);
  if (whatsappUser && waGetStatus(whatsappUser) === "connected") tools.push(ALL_TOOLS.whatsapp_send_message);
  if (agentConfig.tools.slack && process.env.SLACK_BOT_TOKEN) tools.push(ALL_TOOLS.slack_send_message, ALL_TOOLS.slack_list_channels, ALL_TOOLS.slack_lookup_user);
  if (mondayToken)  tools.push(
    ALL_TOOLS.monday_list_boards, ALL_TOOLS.monday_get_board, ALL_TOOLS.monday_create_board,
    ALL_TOOLS.monday_get_items, ALL_TOOLS.monday_get_item,
    ALL_TOOLS.monday_create_item, ALL_TOOLS.monday_update_item,
    ALL_TOOLS.monday_delete_item, ALL_TOOLS.monday_archive_item,
    ALL_TOOLS.monday_move_item_to_group, ALL_TOOLS.monday_duplicate_item, ALL_TOOLS.monday_create_subitem,
    ALL_TOOLS.monday_create_group, ALL_TOOLS.monday_delete_group,
    ALL_TOOLS.monday_create_column,
    ALL_TOOLS.monday_get_updates, ALL_TOOLS.monday_create_update, ALL_TOOLS.monday_delete_update,
    ALL_TOOLS.monday_get_me, ALL_TOOLS.monday_get_users,
    ALL_TOOLS.monday_graphql,
  );
  if (tasksUser)    tools.push(ALL_TOOLS.tasks_list_tasklists, ALL_TOOLS.tasks_list_tasks, ALL_TOOLS.tasks_create_task, ALL_TOOLS.tasks_complete_task, ALL_TOOLS.tasks_update_task, ALL_TOOLS.tasks_delete_task);
  if ((agentConfig.tools.memory ?? true) && memoryUser) tools.push(ALL_TOOLS.memory_save, ALL_TOOLS.memory_recall, ALL_TOOLS.memory_delete);
  return tools;
}


// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeBuiltin(name: string, args: Record<string, unknown>, gmailUser?: string, calendarUser?: string, mondayToken?: string, tasksUser?: string, memoryUser?: string, whatsappUser?: string): Promise<string | null> {
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
    case "calendar_rsvp":
    case "calendar_check_availability": {
      if (!calendarUser) return "User has not connected Google Calendar. Ask them to connect first.";
      const token = await getUserAccessToken("calendar", calendarUser);
      if (!token) return "Could not retrieve Calendar access token. The user may need to reconnect.";
      if (name === "calendar_list_events")        return calendarListEvents(token, args.maxResults as number | undefined);
      if (name === "calendar_create_event")       return calendarCreateEvent(token, args.title as string, args.startDateTime as string, args.endDateTime as string, args.description as string | undefined, args.location as string | undefined, args.attendees as string[] | undefined);
      if (name === "calendar_check_availability") return calendarCheckAvailability(token, args.emails as string[], args.timeMin as string, args.timeMax as string);
      if (name === "calendar_rsvp")               return calendarRsvp(token, args.eventId as string, args.responseStatus as "accepted" | "declined" | "tentative");
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
    case "monday_list_boards":
    case "monday_get_board":
    case "monday_create_board":
    case "monday_get_items":
    case "monday_get_item":
    case "monday_create_item":
    case "monday_update_item":
    case "monday_delete_item":
    case "monday_archive_item":
    case "monday_move_item_to_group":
    case "monday_duplicate_item":
    case "monday_create_subitem":
    case "monday_create_group":
    case "monday_delete_group":
    case "monday_create_column":
    case "monday_get_updates":
    case "monday_create_update":
    case "monday_delete_update":
    case "monday_get_me":
    case "monday_get_users": {
      const token = mondayToken;
      if (!token) return "Monday is not connected. Ask the user to connect their Monday account.";
      if (name === "monday_graphql")          return mondayGraphQL(token, args.query as string, args.variables as Record<string, unknown> | undefined);
      if (name === "monday_list_boards")      return mondayListBoards(token, args.limit as number | undefined);
      if (name === "monday_get_board")        return mondayGetBoard(token, args.boardId as string);
      if (name === "monday_create_board")     return mondayCreateBoard(token, args.boardName as string, args.boardKind as string | undefined, args.workspaceId as string | undefined, args.description as string | undefined);
      if (name === "monday_get_items")        return mondayGetItems(token, args.boardId as string, {
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
        searchTerm: args.searchTerm as string | undefined,
        filters: args.filters as any,
        filtersOperator: args.filtersOperator as "and" | "or" | undefined,
        groupId: args.groupId as string | undefined,
        columnIds: args.columnIds as string[] | undefined,
        includeSubitems: args.includeSubitems as boolean | undefined,
      });
      if (name === "monday_get_item")         return mondayGetItem(token, args.itemId as string);
      if (name === "monday_create_item")      return mondayCreateItem(token, args.boardId as string, args.itemName as string, args.columnValues as Record<string, unknown> | undefined, args.groupId as string | undefined);
      if (name === "monday_update_item")      return mondayUpdateItem(token, args.boardId as string, args.itemId as string, args.columnValues as Record<string, unknown>);
      if (name === "monday_delete_item")      return mondayDeleteItem(token, args.itemId as string);
      if (name === "monday_archive_item")     return mondayArchiveItem(token, args.itemId as string);
      if (name === "monday_move_item_to_group") return mondayMoveItemToGroup(token, args.itemId as string, args.groupId as string);
      if (name === "monday_duplicate_item")   return mondayDuplicateItem(token, args.boardId as string, args.itemId as string, args.withUpdates as boolean | undefined);
      if (name === "monday_create_subitem")   return mondayCreateSubitem(token, args.parentItemId as string, args.itemName as string, args.columnValues as Record<string, unknown> | undefined);
      if (name === "monday_create_group")     return mondayCreateGroup(token, args.boardId as string, args.groupName as string, args.groupColor as string | undefined);
      if (name === "monday_delete_group")     return mondayDeleteGroup(token, args.boardId as string, args.groupId as string);
      if (name === "monday_create_column")    return mondayCreateColumn(token, args.boardId as string, args.columnTitle as string, args.columnType as string, args.description as string | undefined);
      if (name === "monday_get_updates")      return mondayGetUpdates(token, args.itemId as string, args.limit as number | undefined);
      if (name === "monday_create_update")    return mondayCreateUpdate(token, args.itemId as string, args.body as string);
      if (name === "monday_delete_update")    return mondayDeleteUpdate(token, args.updateId as string);
      if (name === "monday_get_me")           return mondayGetMe(token);
      return mondayGetUsers(token, args.limit as number | undefined, args.name as string | undefined);
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

    case "whatsapp_send_message":
      if (!whatsappUser) return "WhatsApp is not connected. Ask the user to connect WhatsApp first.";
      await waSendMessage(whatsappUser, args.to as string, args.message as string);
      return `WhatsApp message sent to ${args.to}`;

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
  whatsappUser?: string,
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

  const allTools = buildBuiltinTools(gmailUser, calendarUser, mondayToken, tasksUser, memoryUser, whatsappUser);
  const nativeSearch = agentConfig.tools.googleSearch;

  const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await executeBuiltin(name, args, gmailUser, calendarUser, mondayToken, tasksUser, memoryUser, whatsappUser);
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
  whatsappUser?: string,
): Promise<ChatResult> {
  return runChat(message, history, mode, systemPrompt, gmailUser, calendarUser, modelOverride, undefined, mondayToken, tasksUser, memoryUser, image, whatsappUser);
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
  whatsappUser?: string,
): Promise<ToolUse[]> {
  const result = await runChat(message, history, mode, systemPrompt, gmailUser, calendarUser, modelOverride, callbacks, mondayToken, tasksUser, memoryUser, image, whatsappUser);
  return result.toolUses;
}

export type { ImageAttachment };
