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
  mondayGetMe, mondayGetUsers, mondayResolveConnectedItem,
  mondaySearchItems, mondayGetMyItems,
} from "./monday";
import { tasksListTasklists, tasksListTasks, tasksCreateTask, tasksCompleteTask, tasksUpdateTask, tasksDeleteTask } from "./tasks";
import { calendarListEvents, calendarCreateEvent, calendarGetEvent, calendarCheckAvailability, calendarRsvp, calendarUpdateEvent, calendarDeleteEvent } from "./calendar";
import { memorySave, memoryRecall, memoryDelete } from "./memory";
import { lookupContact, listContacts as listContactsFn } from "./contacts";
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
        url:     { type: "string",  description: "Full URL" },
        method:  { type: "string",  description: "HTTP method: GET, POST, PUT, PATCH, DELETE" },
        body:    { type: "object",  description: "JSON body (optional)" },
        headers: { type: "object",  description: "Custom HTTP headers (optional, e.g. Authorization)" },
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
    name: "calendar_list_events", description: "List events from the user's Google Calendar. To get all events for a specific day, pass timeMin as the start of that day (00:00:00Z) and timeMax as the end (23:59:59Z). Always use timeMin/timeMax when the user asks about a specific day or date range.",
    parameters: { properties: { maxResults: { type: "number", description: "Max events to return (default 50)" }, timeMin: { type: "string", description: "Start of date range in ISO 8601 (e.g. 2026-06-02T00:00:00Z). Defaults to now." }, timeMax: { type: "string", description: "End of date range in ISO 8601 (e.g. 2026-06-02T23:59:59Z). Omit for open-ended." } }, required: [] },
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
    name: "calendar_get_event", description: "Get full details of a calendar event including description, attendees, and attachments (e.g. Gemini meeting summary docs).",
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
  calendar_update_event: {
    name: "calendar_update_event", description: "Update an existing calendar event. Can change title, time, location, description, or attendee list. All fields optional — only provided fields are updated.",
    parameters: {
      properties: {
        eventId:       { type: "string", description: "Calendar event ID (get from calendar_list_events or calendar_get_event)" },
        title:         { type: "string", description: "New event title" },
        startDateTime: { type: "string", description: "New start time in ISO 8601 (e.g. 2026-05-15T10:00:00Z)" },
        endDateTime:   { type: "string", description: "New end time in ISO 8601" },
        description:   { type: "string", description: "New description" },
        location:      { type: "string", description: "New location" },
        attendees:     { type: "array",  description: "Full attendee list (replaces existing). Include all attendees, not just new ones.", items: { type: "string" } },
      },
      required: ["eventId"],
    },
  },
  calendar_delete_event: {
    name: "calendar_delete_event", description: "Delete (cancel) a calendar event. Sends cancellation emails to all attendees.",
    parameters: {
      properties: {
        eventId: { type: "string", description: "Calendar event ID (get from calendar_list_events or calendar_get_event)" },
      },
      required: ["eventId"],
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
    description: "List all Monday.com boards the user has access to. Returns board IDs, names, workspaces, item counts, and all groups (sections) within each board. Groups represent sprints, stages, or categories. Call this first to discover board IDs and group IDs — e.g. to find the sprint board and its 'Current Sprint' group.",
    parameters: {
      properties: { limit: { type: "number", description: "Max boards to return (default 50)" } },
      required: [],
    },
  },
  monday_search_items: {
    name: "monday_search_items",
    description: "Search for items by name across one or more Monday.com boards. Use when the user asks to find a task or item without specifying a board. Call monday_list_boards first to get board IDs.",
    parameters: {
      properties: {
        boardIds:   { type: "array", items: { type: "string" }, description: "Board IDs to search across" },
        searchTerm: { type: "string", description: "Text to search in item names" },
        limit:      { type: "number", description: "Max results to return (default 25)" },
      },
      required: ["boardIds", "searchTerm"],
    },
  },
  monday_get_my_items: {
    name: "monday_get_my_items",
    description: `Get all items assigned to the current user across one or more boards. Use for requests like "what's assigned to me", "my tasks", "what's on my plate". Sprint workflow: call monday_list_boards first to find the sprint board ID, then call this to get assigned items in that board.
assigneeColumnId defaults to "people" (standard person column). If the board uses a different person column, call monday_get_board first to find the correct column ID.`,
    parameters: {
      properties: {
        boardIds:          { type: "array", items: { type: "string" }, description: "Board IDs to check" },
        assigneeColumnId:  { type: "string", description: "Person column ID (default: 'people')" },
        limit:             { type: "number", description: "Max items per board (default 50)" },
      },
      required: ["boardIds"],
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
REQUIRED SEQUENCE — never skip:
1. Call monday_list_boards to verify the board exists and get its real ID. NEVER guess or invent a boardId.
2. Call monday_get_board to get real column IDs — never guess them. Column IDs look like "date4", "numbers7", "status", etc.
3. Create the item. The response includes the real URL — always use it verbatim, never construct URLs manually.
Column value formats by type:
- date: {"date":"2025-05-24"}
- numbers/hour: 4  (plain number)
- status: {"label":"Done"}
- text/long_text: "value"
- dropdown: {"labels":["Option1"]}
- checkbox: {"checked":"true"}
- timeline: {"from":"2025-05-24","to":"2025-05-30"}
- person: {"personsAndTeams":[{"id":12345678,"kind":"person"}]}  ← id MUST be the numeric user ID, never an email. Call monday_get_users first to resolve a name/email to an id.
- board_relation (connected board): {"item_ids":[123456789]}  ← id MUST be the connected item's numeric ID. Call monday_resolve_connected_item first to resolve a name to an id.
Only include columns that have actual values — omit the rest.`,
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
    description: "Look up Monday.com users to get their numeric ID. Search by name (fuzzy) or exact emails. REQUIRED before setting a person column — personsAndTeams.id must be the numeric user ID, never an email or display name.",
    parameters: {
      properties: {
        name:   { type: "string", description: "Fuzzy search by name" },
        emails: { type: "array", items: { type: "string" }, description: "Exact email addresses to look up" },
        limit:  { type: "number", description: "Max users to return (default 50)" },
      },
      required: [],
    },
  },
  monday_resolve_connected_item: {
    name: "monday_resolve_connected_item",
    description: `Resolve a text name to an item ID for a connected board column (board_relation type).
When a user provides a name for a board_relation column (e.g. "Boost Project: Sheba Dev"), call this tool to find the matching item ID in the connected board.
Returns bestMatch, otherMatches, columnValue (ready-to-use), and a confidence level with a suggestion field.
IMPORTANT: always follow the suggestion field in the response:
- confidence "high" → proceed with bestMatch automatically
- confidence "medium" → show the user the bestMatch name and ask them to confirm before creating/updating
- confidence "low" → show all options and ask the user to pick one before proceeding
REQUIRED before setting any board_relation column — never guess or use the name as-is.
Column can be specified by its ID or title (case-insensitive).`,
    parameters: {
      properties: {
        boardId:    { type: "string", description: "ID of the board that contains the connected column" },
        columnId:   { type: "string", description: "ID or title of the connected board column (e.g. 'Boost Project' or 'connect_boards7')" },
        searchName: { type: "string", description: "Item name to search for in the connected board (e.g. 'Sheba Dev')" },
      },
      required: ["boardId", "columnId", "searchName"],
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
  contacts_lookup: {
    name: "contacts_lookup",
    description: "Look up a saved contact by name and return their phone number. Use this before whatsapp_send_message when the user refers to someone by name (e.g. '@nami', 'mom', 'John'). Strips leading @ automatically.",
    parameters: {
      properties: { name: { type: "string", description: "Contact name or @mention (e.g. 'nami', '@mom', 'John Cohen')" } },
      required: ["name"],
    },
  },
  contacts_list: {
    name: "contacts_list",
    description: "List all saved contacts (names and phone numbers). Use this to show the user their contact book or to find the right name before calling contacts_lookup.",
    parameters: { properties: {}, required: [] },
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
  apollo_people_search: {
    name: "apollo_people_search",
    description: "Search for people (prospects, leads) using Apollo.io. Filter by job title, company, industry, location, seniority, and more. Returns name, title, company, email, LinkedIn URL, and location.",
    parameters: {
      properties: {
        person_titles:                      { type: "array",  items: { type: "string" }, description: "Job titles to filter by (e.g. ['VP of Sales', 'Head of Marketing'])" },
        person_locations:                   { type: "array",  items: { type: "string" }, description: "Person locations (e.g. ['United States', 'New York, NY'])" },
        organization_locations:             { type: "array",  items: { type: "string" }, description: "Company HQ locations (e.g. ['Israel', 'San Francisco, CA'])" },
        organization_num_employees_ranges:  { type: "array",  items: { type: "string" }, description: "Employee count ranges (e.g. ['1,10', '11,50', '51,200', '201,500', '501,1000', '1001,5000', '5001,10000', '10001,'])" },
        q_organization_keyword_tags:        { type: "array",  items: { type: "string" }, description: "Industry/keyword tags for the company (e.g. ['saas', 'b2b', 'fintech'])" },
        person_seniorities:                 { type: "array",  items: { type: "string" }, description: "Seniority levels (e.g. ['vp', 'director', 'manager', 'c_suite', 'founder'])" },
        per_page:                           { type: "number", description: "Results per page (default 10, max 25)" },
        page:                               { type: "number", description: "Page number (default 1)" },
      },
      required: [],
    },
  },
  apollo_org_search: {
    name: "apollo_org_search",
    description: "Search for organizations/companies using Apollo.io. Filter by name keywords, industry, location, size, and more. Returns company name, website, industry, employee count, and location.",
    parameters: {
      properties: {
        q_organization_keyword_tags: { type: "array",  items: { type: "string" }, description: "Industry/keyword tags (e.g. ['saas', 'healthcare', 'fintech'])" },
        organization_locations:      { type: "array",  items: { type: "string" }, description: "HQ locations (e.g. ['United States', 'Tel Aviv'])" },
        organization_num_employees_ranges: { type: "array", items: { type: "string" }, description: "Employee count ranges (e.g. ['11,50', '51,200'])" },
        q_organization_name:         { type: "string", description: "Keyword search within organization names" },
        per_page:                    { type: "number", description: "Results per page (default 10, max 25)" },
        page:                        { type: "number", description: "Page number (default 1)" },
      },
      required: [],
    },
  },
  apollo_person_enrich: {
    name: "apollo_person_enrich",
    description: "Enrich / look up a specific person's full profile on Apollo.io. Returns detailed info including email, phone, LinkedIn, employment history, and more. Provide email and/or name+company.",
    parameters: {
      properties: {
        email:             { type: "string", description: "Person's email address (most reliable identifier)" },
        first_name:        { type: "string", description: "First name" },
        last_name:         { type: "string", description: "Last name" },
        organization_name: { type: "string", description: "Company name" },
        domain:            { type: "string", description: "Company domain (e.g. 'acme.com')" },
        linkedin_url:      { type: "string", description: "LinkedIn profile URL" },
      },
      required: [],
    },
  },
  apollo_org_enrich: {
    name: "apollo_org_enrich",
    description: "Enrich / look up a specific organization's full profile on Apollo.io. Returns company details, tech stack, funding info, industry, size, and more.",
    parameters: {
      properties: {
        domain: { type: "string", description: "Company domain (e.g. 'acme.com') — preferred identifier" },
        name:   { type: "string", description: "Company name (use if domain unknown)" },
      },
      required: [],
    },
  },
  apollo_contacts_search: {
    name: "apollo_contacts_search",
    description: "Search contacts already in your Apollo.io CRM (people you've saved/imported). Different from people_search which searches the full database. Returns contact name, email, title, company, stage.",
    parameters: {
      properties: {
        q_keywords:          { type: "string",  description: "Keyword search across contact name, email, company" },
        contact_stage_ids:   { type: "array",   items: { type: "string" }, description: "Filter by contact stage IDs" },
        per_page:            { type: "number",  description: "Results per page (default 10, max 25)" },
        page:                { type: "number",  description: "Page number (default 1)" },
      },
      required: [],
    },
  },
  apollo_create_contact: {
    name: "apollo_create_contact",
    description: "Create a new contact in your Apollo.io CRM. Use after finding a prospect via apollo_people_search or apollo_person_enrich.",
    parameters: {
      properties: {
        first_name:        { type: "string", description: "First name" },
        last_name:         { type: "string", description: "Last name" },
        title:             { type: "string", description: "Job title" },
        organization_name: { type: "string", description: "Company name" },
        email:             { type: "string", description: "Email address" },
        phone_number:      { type: "string", description: "Phone number" },
        website_url:       { type: "string", description: "Company website URL" },
        linkedin_url:      { type: "string", description: "LinkedIn profile URL" },
      },
      required: [],
    },
  },
  apollo_get_sequences: {
    name: "apollo_get_sequences",
    description: "List email sequences (outreach campaigns) in your Apollo.io account. Returns sequence names, IDs, status, and stats. Use to find which sequence to enroll contacts in.",
    parameters: {
      properties: {
        q_keywords: { type: "string", description: "Search by sequence name keyword" },
        per_page:   { type: "number", description: "Results per page (default 10)" },
      },
      required: [],
    },
  },
  apollo_add_to_sequence: {
    name: "apollo_add_to_sequence",
    description: "Add a contact to an Apollo.io email sequence (outreach campaign). The contact must already exist in your CRM. Use apollo_get_sequences to find sequence IDs.",
    parameters: {
      properties: {
        sequence_id:    { type: "string", description: "The ID of the sequence to enroll the contact in (from apollo_get_sequences)" },
        contact_id:     { type: "string", description: "Apollo contact ID (from apollo_create_contact or apollo_contacts_search)" },
        email_account_id: { type: "string", description: "Email account ID to send from (optional — Apollo will use default if not specified)" },
      },
      required: ["sequence_id", "contact_id"],
    },
  },
  apollo_get_news: {
    name: "apollo_get_news",
    description: "Get recent news articles about a company or topic from Apollo.io. Useful for account research before outreach.",
    parameters: {
      properties: {
        q_keywords:           { type: "string", description: "Keywords to search news for (e.g. 'product launch', 'funding')" },
        organization_domains: { type: "array",  items: { type: "string" }, description: "Company domains to get news for (e.g. ['stripe.com', 'openai.com'])" },
        per_page:             { type: "number", description: "Results per page (default 10)" },
      },
      required: [],
    },
  },
  apollo_update_contact: {
    name: "apollo_update_contact",
    description: "Update an existing contact in your Apollo.io CRM. Use to change stage, title, phone, labels, or any other field. Requires the contact ID (from apollo_contacts_search or apollo_create_contact).",
    parameters: {
      properties: {
        contact_id:        { type: "string", description: "Apollo contact ID to update" },
        first_name:        { type: "string", description: "First name" },
        last_name:         { type: "string", description: "Last name" },
        title:             { type: "string", description: "Job title" },
        organization_name: { type: "string", description: "Company name" },
        email:             { type: "string", description: "Email address" },
        direct_phone:      { type: "string", description: "Direct phone number" },
        mobile_phone:      { type: "string", description: "Mobile phone number" },
        contact_stage_id:  { type: "string", description: "CRM stage ID to move contact to" },
        label_names:       { type: "array", items: { type: "string" }, description: "Labels/tags to assign (e.g. ['hot lead', 'follow up'])" },
        present_raw_address: { type: "string", description: "Full address" },
      },
      required: ["contact_id"],
    },
  },
  apollo_org_job_postings: {
    name: "apollo_org_job_postings",
    description: "Get active job postings for a company on Apollo.io. Strong prospecting signal — companies hiring in relevant roles are growing and more likely to buy. Requires the Apollo organization ID (from apollo_org_search or apollo_org_enrich).",
    parameters: {
      properties: {
        organization_id: { type: "string", description: "Apollo organization ID (from apollo_org_search or apollo_org_enrich)" },
        page:            { type: "number", description: "Page number (default 1)" },
        per_page:        { type: "number", description: "Results per page (default 10)" },
      },
      required: ["organization_id"],
    },
  },
  apollo_get_email_accounts: {
    name: "apollo_get_email_accounts",
    description: "List the email accounts (inboxes) connected to your Apollo.io account. Use to find the email_account_id needed when adding a contact to a sequence with a specific sender inbox.",
    parameters: {
      properties: {},
      required: [],
    },
  },
};

function buildSystemPrompt(override?: string, addition?: string, hasMondayToken?: boolean, hasCalendar?: boolean): string {
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
    caps.push("- **Memory**: Use memory_save to remember important facts about the user (phone, preferences, context) for future conversations. Use memory_delete to remove outdated info. Memories are automatically loaded into every conversation — no need to call memory_recall manually.");
  }
  const capsBlock = caps.length
    ? `\n\n---\n\nYou have access to the following capabilities:\n${caps.join("\n")}`
    : "";

  const now = new Date();
  const dateBlock = `\n\n---\n\nCurrent date/time: ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })}`;

  const calendarBlock = hasCalendar ? `\n\n---\n\n## Google Calendar — grounding rules (MANDATORY)
- NEVER say you created, updated, or deleted a calendar event unless the tool response contains an event ID. If the tool returns an error, tell the user exactly what failed — do not say the operation succeeded.
- When creating an event the user will automatically be added as an attendee — you do not need to add their own email to the attendees list.
- After any mutation (create/update/delete), confirm by quoting the event title and ID from the tool response.` : "";

  const mondayBlock = hasMondayToken ? `\n\n---\n\n## Monday.com — grounding rules (MANDATORY)
- NEVER guess, invent, or recall board IDs, group IDs, item IDs, or account URLs. All IDs must come from tool responses.
- NEVER construct Monday URLs manually. Item/board URLs are returned directly by the tools — always use the \`url\` field verbatim.
- NEVER report success for a mutation unless the tool returned a result with no error. If the tool returns "Tool error: …", tell the user exactly what failed — do not say the operation succeeded.
- Before ANY mutation (create, update, delete, move): call monday_get_me first to confirm which account you're operating in. Tell the user: "I'll do this in your [account name] Monday account." If the user specifies a different account than the one returned by monday_get_me, stop and tell them you're connected to a different account — do not proceed.
- Before creating or modifying items: call monday_list_boards to verify the target board exists and get its real ID.
- Before reading or writing column values: call monday_get_board to get real column IDs.
- If a requested board or item is not found in tool results, tell the user it does not exist — do not proceed.` : "";

  return `${base}${skillsBlock}${additionBlock}${capsBlock}${dateBlock}${calendarBlock}${mondayBlock}`;
}


// ── Hooks ─────────────────────────────────────────────────────────────────────

export interface AgentHooks {
  /** Called before each tool execution. Return modified args or void to use original. */
  onBeforeTool?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown> | void>;
  /** Called after each tool execution. Return modified result or void to use original. */
  onAfterTool?: (name: string, args: Record<string, unknown>, result: string) => Promise<string | void>;
}

// ── Subagent / coordinator architecture ───────────────────────────────────────

interface AgentContext {
  gmailUser?: string;
  calendarUser?: string;
  mondayToken?: string;
  tasksUser?: string;
  memoryUser?: string;
  whatsappUser?: string;
  apolloApiKey?: string;
}

const COORDINATOR_TOOL: ToolDecl = {
  name: "delegate_to_subagent",
  description: `Delegate a task to a specialized subagent. The subagent executes autonomously and returns a result string. Available subagents:
- research: web search, reading URLs, fetching images, custom HTTP/API calls
- calendar: Google Calendar — list, create, update, delete events; check availability; RSVP
- tasks: Google Tasks — list, create, complete, update, delete tasks
- communication: Gmail, Slack, WhatsApp — send messages
- monday: Monday.com — boards, items, groups, columns, updates
- memory: user memory (save/recall) and contact lookup
- crm: Apollo.io — prospect search, contact management, email sequences`,
  parameters: {
    properties: {
      subagent: { type: "string", description: "Subagent name: research | calendar | tasks | communication | monday | memory | crm" },
      task:     { type: "string", description: "Complete task description with all context the subagent needs to act independently" },
    },
    required: ["subagent", "task"],
  },
};

const COORDINATOR_INSTRUCTIONS = `You are a coordinator agent. Delegate ALL data access and external actions to specialized subagents via delegate_to_subagent.
Rules:
- You cannot call external APIs or read live data yourself — always delegate.
- Include full context in the task description so the subagent can act independently.
- For tasks spanning multiple domains, call subagents sequentially.
- Synthesize subagent results into a clear, direct response for the user.
- If a subagent returns an error, report it exactly — do not claim success.
- Only respond without delegating for questions answerable from conversation context alone (e.g. simple math, definitions, already-known facts).`;

function buildSubagentTools(subagent: string, ctx: AgentContext): ToolDecl[] {
  switch (subagent) {
    case "research":
      return [
        ...(agentConfig.tools.jinaReader ?? true ? [ALL_TOOLS.read_webpage, ALL_TOOLS.search_image] : []),
        ...(agentConfig.tools.fetchUrl ? [ALL_TOOLS.fetch_url] : []),
        ...(agentConfig.tools.httpRequest ? [ALL_TOOLS.http_request] : []),
      ];
    case "calendar":
      if (!ctx.calendarUser) return [];
      return [
        ALL_TOOLS.calendar_list_events, ALL_TOOLS.calendar_create_event, ALL_TOOLS.calendar_get_event,
        ALL_TOOLS.calendar_check_availability, ALL_TOOLS.calendar_rsvp,
        ALL_TOOLS.calendar_update_event, ALL_TOOLS.calendar_delete_event,
      ];
    case "tasks":
      if (!ctx.tasksUser) return [];
      return [
        ALL_TOOLS.tasks_list_tasklists, ALL_TOOLS.tasks_list_tasks, ALL_TOOLS.tasks_create_task,
        ALL_TOOLS.tasks_complete_task, ALL_TOOLS.tasks_update_task, ALL_TOOLS.tasks_delete_task,
      ];
    case "communication":
      return [
        ...(ctx.gmailUser ? [ALL_TOOLS.gmail_send] : []),
        ...(agentConfig.tools.slack && process.env.SLACK_BOT_TOKEN
          ? [ALL_TOOLS.slack_send_message, ALL_TOOLS.slack_list_channels, ALL_TOOLS.slack_lookup_user]
          : []),
        ...(ctx.whatsappUser && waGetStatus(ctx.whatsappUser) === "connected"
          ? [ALL_TOOLS.whatsapp_send_message]
          : []),
      ];
    case "monday":
      if (!ctx.mondayToken) return [];
      return [
        ALL_TOOLS.monday_list_boards, ALL_TOOLS.monday_get_board, ALL_TOOLS.monday_create_board,
        ALL_TOOLS.monday_get_items, ALL_TOOLS.monday_get_item,
        ALL_TOOLS.monday_create_item, ALL_TOOLS.monday_update_item,
        ALL_TOOLS.monday_delete_item, ALL_TOOLS.monday_archive_item,
        ALL_TOOLS.monday_move_item_to_group, ALL_TOOLS.monday_duplicate_item, ALL_TOOLS.monday_create_subitem,
        ALL_TOOLS.monday_create_group, ALL_TOOLS.monday_delete_group, ALL_TOOLS.monday_create_column,
        ALL_TOOLS.monday_get_updates, ALL_TOOLS.monday_create_update, ALL_TOOLS.monday_delete_update,
        ALL_TOOLS.monday_get_me, ALL_TOOLS.monday_get_users,
        ALL_TOOLS.monday_resolve_connected_item, ALL_TOOLS.monday_search_items, ALL_TOOLS.monday_get_my_items,
        ALL_TOOLS.monday_graphql,
      ];
    case "memory":
      return [
        ...((agentConfig.tools.memory ?? true) && ctx.memoryUser
          ? [ALL_TOOLS.memory_save, ALL_TOOLS.memory_recall, ALL_TOOLS.memory_delete]
          : []),
        ...(ctx.memoryUser ? [ALL_TOOLS.contacts_lookup, ALL_TOOLS.contacts_list] : []),
      ];
    case "crm":
      if (!ctx.apolloApiKey) return [];
      return [
        ALL_TOOLS.apollo_people_search, ALL_TOOLS.apollo_org_search,
        ALL_TOOLS.apollo_person_enrich, ALL_TOOLS.apollo_org_enrich,
        ALL_TOOLS.apollo_contacts_search, ALL_TOOLS.apollo_create_contact, ALL_TOOLS.apollo_update_contact,
        ALL_TOOLS.apollo_get_sequences, ALL_TOOLS.apollo_add_to_sequence, ALL_TOOLS.apollo_get_email_accounts,
        ALL_TOOLS.apollo_get_news, ALL_TOOLS.apollo_org_job_postings,
      ];
    default:
      return [];
  }
}

async function runSubagent(
  subagentName: string,
  task: string,
  ctx: AgentContext,
  model: ModelConfig,
  hooks?: AgentHooks,
): Promise<string> {
  const tools = buildSubagentTools(subagentName, ctx);
  if (!tools.length) {
    return `Subagent "${subagentName}" has no available tools — the required service may not be connected.`;
  }
  const systemPrompt = `You are a specialized ${subagentName} agent. Complete the delegated task using your tools. Return a concise, structured result for the coordinator to use in its final reply.`;
  const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const t0 = Date.now();
    console.log(JSON.stringify({ tag: "subagent", subagent: subagentName, msg: "tool call", name, argsKeys: Object.keys(args) }));
    try {
      const modifiedArgs = (await hooks?.onBeforeTool?.(name, args)) ?? args;
      const result = await executeBuiltin(name, modifiedArgs, ctx.gmailUser, ctx.calendarUser, ctx.mondayToken, ctx.tasksUser, ctx.memoryUser, ctx.whatsappUser, ctx.apolloApiKey);
      const output = result ?? "Tool not implemented";
      const modifiedResult = (await hooks?.onAfterTool?.(name, modifiedArgs, output)) ?? output;
      console.log(JSON.stringify({ tag: "subagent", subagent: subagentName, msg: "tool done", name, ms: Date.now() - t0 }));
      return modifiedResult;
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      console.error(JSON.stringify({ tag: "subagent", subagent: subagentName, msg: "tool error", name, ms: Date.now() - t0, error: errMsg }));
      return `Tool error: ${errMsg}`;
    }
  };
  const result = await chatWithModel(model, systemPrompt, [], task, tools, executor, false);
  return result.reply;
}


// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeBuiltin(name: string, args: Record<string, unknown>, gmailUser?: string, calendarUser?: string, mondayToken?: string, tasksUser?: string, memoryUser?: string, whatsappUser?: string, apolloApiKey?: string): Promise<string | null> {
  switch (name) {
    case "fetch_url":
      return fetchUrl(args.url as string);

    case "read_webpage":
      return readWebpage(args.url as string);

    case "search_image":
      return searchImage(args.query as string);

    case "http_request":
      return httpRequest(args.url as string, args.method as string, args.body, args.headers as Record<string, string> | undefined);

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
    case "calendar_check_availability":
    case "calendar_update_event":
    case "calendar_delete_event": {
      if (!calendarUser) return "User has not connected Google Calendar. Ask them to connect first.";
      const token = await getUserAccessToken("calendar", calendarUser);
      if (!token) return "Could not retrieve Calendar access token. The user may need to reconnect.";
      if (name === "calendar_list_events")        return calendarListEvents(token, args.maxResults as number | undefined, args.timeMin as string | undefined, args.timeMax as string | undefined);
      if (name === "calendar_create_event") {
        const extraAttendees = (args.attendees as string[] | undefined) ?? [];
        const allAttendees = [calendarUser, ...extraAttendees.filter((e) => e !== calendarUser)];
        return calendarCreateEvent(token, args.title as string, args.startDateTime as string, args.endDateTime as string, args.description as string | undefined, args.location as string | undefined, allAttendees);
      }
      if (name === "calendar_check_availability") return calendarCheckAvailability(token, args.emails as string[], args.timeMin as string, args.timeMax as string);
      if (name === "calendar_rsvp")               return calendarRsvp(token, args.eventId as string, args.responseStatus as "accepted" | "declined" | "tentative");
      if (name === "calendar_update_event")       return calendarUpdateEvent(token, args.eventId as string, { title: args.title as string | undefined, startDateTime: args.startDateTime as string | undefined, endDateTime: args.endDateTime as string | undefined, description: args.description as string | undefined, location: args.location as string | undefined, attendees: args.attendees as string[] | undefined });
      if (name === "calendar_delete_event")       return calendarDeleteEvent(token, args.eventId as string);
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
    case "monday_get_users":
    case "monday_resolve_connected_item":
    case "monday_search_items":
    case "monday_get_my_items": {
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
      if (name === "monday_get_me")                   return mondayGetMe(token);
      if (name === "monday_resolve_connected_item")   return mondayResolveConnectedItem(token, args.boardId as string, args.columnId as string, args.searchName as string);
      if (name === "monday_search_items")             return mondaySearchItems(token, args.boardIds as string[], args.searchTerm as string, args.limit as number | undefined);
      if (name === "monday_get_my_items")             return mondayGetMyItems(token, args.boardIds as string[], args.assigneeColumnId as string | undefined, args.limit as number | undefined);
      return mondayGetUsers(token, args.limit as number | undefined, args.name as string | undefined, args.emails as string[] | undefined);
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

    case "contacts_lookup": {
      if (!memoryUser) return "Contacts require a logged-in user.";
      const contact = await lookupContact(memoryUser, args.name as string);
      if (!contact) return `No contact found for "${args.name}". The user may need to import their contacts first.`;
      return `Found: ${contact.name} — ${contact.phone}`;
    }

    case "contacts_list": {
      if (!memoryUser) return "Contacts require a logged-in user.";
      const all = await listContactsFn(memoryUser);
      if (!all.length) return "No contacts saved. Ask the user to import their contacts (.vcf from iPhone) first.";
      return all.map((c) => `• ${c.name}: ${c.phone}`).join("\n");
    }

    case "apollo_people_search":
    case "apollo_org_search":
    case "apollo_person_enrich":
    case "apollo_org_enrich":
    case "apollo_contacts_search":
    case "apollo_create_contact":
    case "apollo_update_contact":
    case "apollo_get_sequences":
    case "apollo_add_to_sequence":
    case "apollo_org_job_postings":
    case "apollo_get_email_accounts":
    case "apollo_get_news": {
      if (!apolloApiKey) return "Apollo.io is not connected. Ask the user to add their Apollo API key in the Connectors panel.";
      const ah = { "x-api-key": apolloApiKey, "Content-Type": "application/json", "Cache-Control": "no-cache" };
      const AB = "https://api.apollo.io/api/v1";
      try {
        if (name === "apollo_people_search") {
          const { per_page = 10, page = 1, ...rest } = args as Record<string, unknown>;
          const r = await fetch(`${AB}/mixed_people/api_search`, { method: "POST", headers: ah, body: JSON.stringify({ page, per_page, ...rest }) });
          const data = await r.json() as { people?: Record<string, unknown>[]; error?: string };
          if (data.error) return `Apollo error: ${data.error}`;
          const people = (data.people ?? []).slice(0, 25).map((p: Record<string, unknown>) => ({
            name: p.name, title: p.title, company: p.organization_name,
            email: p.email, linkedin: p.linkedin_url,
            location: [p.city, p.state, p.country].filter(Boolean).join(", "),
          }));
          return `Found ${people.length} people:\n${JSON.stringify(people, null, 2)}`;
        }
        if (name === "apollo_org_search") {
          const { per_page = 10, page = 1, ...rest } = args as Record<string, unknown>;
          const r = await fetch(`${AB}/mixed_companies/search`, { method: "POST", headers: ah, body: JSON.stringify({ page, per_page, ...rest }) });
          const data = await r.json() as { organizations?: Record<string, unknown>[]; error?: string };
          if (data.error) return `Apollo error: ${data.error}`;
          const orgs = (data.organizations ?? []).slice(0, 25).map((o: Record<string, unknown>) => ({
            name: o.name, website: o.website_url, industry: o.industry,
            employees: o.estimated_num_employees,
            location: [o.city, o.country].filter(Boolean).join(", "),
          }));
          return `Found ${orgs.length} organizations:\n${JSON.stringify(orgs, null, 2)}`;
        }
        if (name === "apollo_person_enrich") {
          const r = await fetch(`${AB}/people/match`, { method: "POST", headers: ah, body: JSON.stringify({ reveal_personal_emails: true, ...args }) });
          const data = await r.json() as { person?: Record<string, unknown>; error?: string };
          if (data.error) return `Apollo error: ${data.error}`;
          return JSON.stringify(data.person ?? data, null, 2);
        }
        if (name === "apollo_org_enrich") {
          const r = await fetch(`${AB}/organizations/enrich`, { method: "POST", headers: ah, body: JSON.stringify(args) });
          const data = await r.json() as { organization?: Record<string, unknown>; error?: string };
          if (data.error) return `Apollo error: ${data.error}`;
          return JSON.stringify(data.organization ?? data, null, 2);
        }
        if (name === "apollo_contacts_search") {
          const { per_page = 10, page = 1, ...rest } = args as Record<string, unknown>;
          const r = await fetch(`${AB}/contacts/search`, { method: "POST", headers: ah, body: JSON.stringify({ page, per_page, ...rest }) });
          const data = await r.json() as { contacts?: Record<string, unknown>[]; error?: string };
          if (data.error) return `Apollo error: ${data.error}`;
          const contacts = (data.contacts ?? []).slice(0, 25).map((c: Record<string, unknown>) => ({
            id: c.id, name: c.name, title: c.title, company: c.organization_name,
            email: c.email, stage: c.contact_stage_id, linkedin: c.linkedin_url,
          }));
          return `Found ${contacts.length} CRM contacts:\n${JSON.stringify(contacts, null, 2)}`;
        }
        if (name === "apollo_create_contact") {
          const r = await fetch(`${AB}/contacts`, { method: "POST", headers: ah, body: JSON.stringify(args) });
          const data = await r.json() as { contact?: Record<string, unknown>; error?: string };
          if (data.error) return `Apollo error: ${data.error}`;
          const c = data.contact ?? {};
          return `Contact created. ID: ${c.id}, Name: ${c.name}, Email: ${c.email}`;
        }
        if (name === "apollo_get_sequences") {
          const { per_page = 10, ...rest } = args as Record<string, unknown>;
          const params = new URLSearchParams({ per_page: String(per_page), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])) });
          const r = await fetch(`${AB}/emailer_campaigns?${params}`, { headers: ah });
          const data = await r.json() as { emailer_campaigns?: Record<string, unknown>[]; error?: string };
          if (data.error) return `Apollo error: ${data.error}`;
          const seqs = (data.emailer_campaigns ?? []).map((s: Record<string, unknown>) => ({ id: s.id, name: s.name, status: s.status, contacts: s.num_steps }));
          return `Found ${seqs.length} sequences:\n${JSON.stringify(seqs, null, 2)}`;
        }
        if (name === "apollo_add_to_sequence") {
          const { sequence_id, contact_id, email_account_id } = args as { sequence_id: string; contact_id: string; email_account_id?: string };
          const body: Record<string, unknown> = { contact_ids: [contact_id] };
          if (email_account_id) body.emailer_campaign_email_list_id = email_account_id;
          const r = await fetch(`${AB}/emailer_campaigns/${sequence_id}/add_contact_ids`, { method: "POST", headers: ah, body: JSON.stringify(body) });
          const data = await r.json() as { contacts?: unknown[]; error?: string };
          if (data.error) return `Apollo error: ${data.error}`;
          return `Contact added to sequence. ${data.contacts?.length ?? 0} contact(s) enrolled.`;
        }
        if (name === "apollo_get_news") {
          const { per_page = 10, ...rest } = args as Record<string, unknown>;
          const params = new URLSearchParams({ per_page: String(per_page), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? (v as string[]).join(",") : String(v)])) });
          const r = await fetch(`${AB}/news?${params}`, { headers: ah });
          const data = await r.json() as { news?: Record<string, unknown>[]; error?: string };
          if (data.error) return `Apollo error: ${data.error}`;
          const articles = (data.news ?? []).slice(0, 10).map((n: Record<string, unknown>) => ({ title: n.title, date: n.published_at, source: n.source, url: n.url, summary: n.summary }));
          return `Found ${articles.length} news articles:\n${JSON.stringify(articles, null, 2)}`;
        }
        if (name === "apollo_update_contact") {
          const { contact_id, ...fields } = args as Record<string, unknown>;
          const r = await fetch(`${AB}/contacts/${contact_id}`, { method: "PATCH", headers: ah, body: JSON.stringify(fields) });
          const data = await r.json() as { contact?: Record<string, unknown>; error?: string };
          if (data.error) return `Apollo error: ${data.error}`;
          const c = data.contact ?? {};
          return `Contact updated. ID: ${c.id}, Name: ${c.name}, Stage: ${c.contact_stage_id ?? "unchanged"}`;
        }
        if (name === "apollo_org_job_postings") {
          const { organization_id, page = 1, per_page = 10 } = args as { organization_id: string; page?: number; per_page?: number };
          const params = new URLSearchParams({ page: String(page), per_page: String(per_page) });
          const r = await fetch(`${AB}/organizations/${organization_id}/job_postings?${params}`, { headers: ah });
          const data = await r.json() as { job_postings?: Record<string, unknown>[]; error?: string };
          if (data.error) return `Apollo error: ${data.error}`;
          const jobs = (data.job_postings ?? []).slice(0, 20).map((j: Record<string, unknown>) => ({
            title: j.title, department: j.department, location: j.location,
            posted_at: j.posted_at, url: j.url,
          }));
          return `Found ${jobs.length} job postings:\n${JSON.stringify(jobs, null, 2)}`;
        }
        // apollo_get_email_accounts
        const r = await fetch(`${AB}/email_accounts`, { headers: ah });
        const data = await r.json() as { email_accounts?: Record<string, unknown>[]; error?: string };
        if (data.error) return `Apollo error: ${data.error}`;
        const accounts = (data.email_accounts ?? []).map((a: Record<string, unknown>) => ({ id: a.id, email: a.email, name: a.name, active: a.active }));
        return `Found ${accounts.length} email accounts:\n${JSON.stringify(accounts, null, 2)}`;
      } catch (err) {
        return `Apollo request failed: ${(err as Error).message}`;
      }
    }

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
  mode: "search" | "tools" | "no_tools",
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
  apolloApiKey?: string,
  hooks?: AgentHooks,
): Promise<ChatResult> {
  const model: ModelConfig = modelOverride ?? agentConfig.model ?? { provider: "gemini", modelId: "gemini-2.5-flash" };
  const ctx: AgentContext = { gmailUser, calendarUser, mondayToken, tasksUser, memoryUser, whatsappUser, apolloApiKey };

  let memoriesBlock = "";
  if (memoryUser) {
    try {
      const recalled = await memoryRecall(memoryUser);
      if (recalled && !recalled.startsWith("No memor")) {
        memoriesBlock = `\n\n---\n\n## What I know about this user\n${recalled}`;
      }
    } catch { /* non-fatal */ }
  }

  if (mode === "search" && agentConfig.tools.googleSearch) {
    const builtPrompt = buildSystemPrompt(systemPrompt, undefined, !!mondayToken, !!calendarUser) + memoriesBlock;
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

  if (mode === "no_tools") {
    const builtPrompt = buildSystemPrompt(systemPrompt, undefined, !!mondayToken, !!calendarUser) + memoriesBlock;
    return chatWithModel(model, builtPrompt, history, message, [], async () => "Tool not available", false, image);
  }

  // Coordinator mode: route requests to specialized subagents
  const agentPersonality = buildSystemPrompt(systemPrompt, undefined, !!mondayToken, !!calendarUser);
  const coordinatorPrompt = `${COORDINATOR_INSTRUCTIONS}\n\n---\n\n${agentPersonality}${memoriesBlock}`;

  const coordinatorExecutor = async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (name !== "delegate_to_subagent") return "Unknown coordinator tool";
    const subagentName = args.subagent as string;
    const task = args.task as string;
    console.log(JSON.stringify({ tag: "coordinator", msg: "delegate", subagent: subagentName }));
    return runSubagent(subagentName, task, ctx, model, hooks);
  };

  if (streamCallbacks) {
    const toolUses = await chatWithModelStream(model, coordinatorPrompt, history, message, [COORDINATOR_TOOL], coordinatorExecutor, streamCallbacks, false, image);
    return { reply: "", toolUses };
  }
  return chatWithModel(model, coordinatorPrompt, history, message, [COORDINATOR_TOOL], coordinatorExecutor, false, image);
}

export async function chat(
  message: string,
  history: Content[],
  mode: "search" | "tools" | "no_tools" = "tools",
  systemPrompt?: string,
  gmailUser?: string,
  calendarUser?: string,
  modelOverride?: ModelConfig,
  mondayToken?: string,
  tasksUser?: string,
  memoryUser?: string,
  image?: ImageAttachment,
  whatsappUser?: string,
  apolloApiKey?: string,
  hooks?: AgentHooks,
): Promise<ChatResult> {
  return runChat(message, history, mode, systemPrompt, gmailUser, calendarUser, modelOverride, undefined, mondayToken, tasksUser, memoryUser, image, whatsappUser, apolloApiKey, hooks);
}

export async function chatStream(
  message: string,
  history: Content[],
  mode: "search" | "tools" | "no_tools" = "tools",
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
  apolloApiKey?: string,
  hooks?: AgentHooks,
): Promise<ToolUse[]> {
  const result = await runChat(message, history, mode, systemPrompt, gmailUser, calendarUser, modelOverride, callbacks, mondayToken, tasksUser, memoryUser, image, whatsappUser, apolloApiKey, hooks);
  return result.toolUses;
}

export type { ImageAttachment };
