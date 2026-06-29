const MONDAY_API = "https://api.monday.com/v2";
const MONDAY_API_VERSION = "2026-04";

async function gql(token: string, query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "API-Version": MONDAY_API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json() as { data?: any; errors?: any[] };
  if (body.errors?.length) {
    // Log full error detail to GCP so we can see exactly which field/line Monday rejects
    console.error(JSON.stringify({
      tag: "monday",
      msg: "GraphQL error",
      query: query.replace(/\s+/g, " ").trim(),
      variables,
      errors: body.errors,
    }));
    const detail = body.errors.map((e: any) => {
      const loc = e.locations?.map((l: any) => `line ${l.line} col ${l.column}`).join(", ");
      const path = e.path?.join(".");
      return [e.message, path && `path: ${path}`, loc && `at ${loc}`].filter(Boolean).join(" | ");
    }).join("; ");
    throw new Error(detail);
  }
  return body.data;
}

function json(v: any): string { return JSON.stringify(v, null, 2); }

const ITEM_FIELDS = `
  id name url state created_at updated_at
  group { id title }
  column_values { id text value column { type } }
`;

// ── Generic ───────────────────────────────────────────────────────────────────

export async function mondayGraphQL(token: string, query: string, variables?: Record<string, unknown>): Promise<string> {
  return json(await gql(token, query, variables));
}

// ── Boards ────────────────────────────────────────────────────────────────────

export async function mondayListBoards(token: string, limit = 50): Promise<string> {
  const data = await gql(token, `
    query($limit: Int!) {
      boards(limit: $limit, order_by: created_at) {
        id name description state
        items_count updated_at
        workspace { id name }
        groups { id title }
      }
    }`, { limit });
  return json(data.boards);
}

export async function mondayGetBoard(token: string, boardId: string): Promise<string> {
  const data = await gql(token, `
    query($boardId: ID!) {
      boards(ids: [$boardId]) {
        id name
        columns { id title type settings_str }
        groups { id title }
      }
    }`, { boardId });
  const board = data.boards?.[0];
  if (!board) return json("Board not found");
  // Flatten status/color/dropdown label options so the model only ever picks an existing label.
  board.columns = (board.columns ?? []).map((c: any) => {
    const col: any = { id: c.id, title: c.title, type: c.type };
    if (c.type === "status" || c.type === "color" || c.type === "dropdown") {
      const labels = parseColumnLabels(c.settings_str);
      // Only inline the full option list for reasonably-sized columns; very long ones (e.g. a
      // 150-entry caller dropdown) would bloat the prompt. The server-side normalizer still
      // validates against the real labels regardless of what we expose here.
      if (labels.length && labels.length <= 60) col.allowedLabels = labels;
      else if (labels.length) col.allowedLabelsCount = labels.length;
    }
    return col;
  });
  return json(board);
}

export async function mondayCreateBoard(token: string, boardName: string, boardKind: string = "public", workspaceId?: string, description?: string): Promise<string> {
  const data = await gql(token, `
    mutation($boardName: String!, $boardKind: BoardKind!, $workspaceId: ID, $description: String) {
      create_board(board_name: $boardName, board_kind: $boardKind, workspace_id: $workspaceId, description: $description) {
        id name board_kind workspace { id name }
      }
    }`, { boardName, boardKind, workspaceId, description });
  const b = data.create_board;
  return json({ id: b.id, name: b.name, boardKind: b.board_kind, workspace: b.workspace });
}

// ── Items ─────────────────────────────────────────────────────────────────────

export interface MondayFilterRule {
  columnId: string;
  compareValue: string[];
  operator?: string;
}

export async function mondayGetItems(
  token: string,
  boardId: string,
  opts: {
    limit?: number;
    cursor?: string;
    searchTerm?: string;
    filters?: MondayFilterRule[];
    filtersOperator?: "and" | "or";
    groupId?: string;
    columnIds?: string[];
    includeSubitems?: boolean;
  } = {},
): Promise<string> {
  const { limit = 50, cursor, searchTerm, filters = [], filtersOperator = "and", groupId, columnIds, includeSubitems = false } = opts;

  // Build query_params rules
  const rules: any[] = [];
  if (groupId) rules.push({ column_id: "group", compare_value: [groupId] });
  if (searchTerm) rules.push({ column_id: "name", compare_value: [searchTerm], operator: "contains_text" });
  for (const f of filters) {
    rules.push({ column_id: f.columnId, compare_value: f.compareValue, operator: f.operator ?? "any_of" });
  }

  const queryParams = rules.length ? { rules, operator: filtersOperator } : undefined;

  const subitemsField = includeSubitems ? "subitems { id name column_values { id text value } }" : "";
  const columnFilter = columnIds?.length ? `(ids: ${JSON.stringify(columnIds)})` : "";

  // Use cursor-based next_items_page for pagination
  if (cursor) {
    const data = await gql(token, `
      query($cursor: String!, $limit: Int!) {
        next_items_page(limit: $limit, cursor: $cursor) {
          cursor
          items { ${ITEM_FIELDS} ${subitemsField} }
        }
      }`, { cursor, limit });
    return json(data.next_items_page);
  }

  const data = await gql(token, `
    query($boardId: ID!, $limit: Int!, $queryParams: ItemsQuery) {
      boards(ids: [$boardId]) {
        items_page(limit: $limit, query_params: $queryParams) {
          cursor
          items { ${ITEM_FIELDS.replace("column_values { id text value type }", `column_values${columnFilter} { id text value type }`)} ${subitemsField} }
        }
      }
    }`, { boardId, limit, queryParams });
  return json(data.boards?.[0]?.items_page ?? { cursor: null, items: [] });
}

export async function mondayGetItem(token: string, itemId: string): Promise<string> {
  const data = await gql(token, `
    query($itemId: ID!) {
      items(ids: [$itemId]) {
        id name url created_at updated_at
        board { id name }
        group { id title }
        column_values { id text value type }
        updates(limit: 5) { id body text_body created_at updated_at creator { id name } }
        subitems { id name column_values { id text value } }
        parent_item { id name }
      }
    }`, { itemId });
  return json(data.items?.[0] ?? "Item not found");
}

// Lightweight set of live (non-deleted/archived) item ids on a board — used to verify a
// remembered item still exists before treating its email as "already logged".
export async function mondayLiveItemIds(token: string, boardId: string, limit = 500): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const data: any = cursor
      ? await gql(token, `query($cursor: String!, $limit: Int!) { next_items_page(limit: $limit, cursor: $cursor) { cursor items { id } } }`, { cursor, limit })
      : await gql(token, `query($boardId: ID!, $limit: Int!) { boards(ids: [$boardId]) { items_page(limit: $limit) { cursor items { id } } } }`, { boardId, limit });
    const page: any = cursor ? data.next_items_page : data.boards?.[0]?.items_page;
    for (const it of page?.items ?? []) ids.add(String(it.id));
    cursor = page?.cursor ?? null;
  } while (cursor);
  return ids;
}

export async function mondayDeleteItem(token: string, itemId: string): Promise<string> {
  await gql(token, `mutation($itemId: ID!) { delete_item(item_id: $itemId) { id } }`, { itemId });
  return `Deleted item ${itemId}`;
}

export async function mondayArchiveItem(token: string, itemId: string): Promise<string> {
  await gql(token, `mutation($itemId: ID!) { archive_item(item_id: $itemId) { id } }`, { itemId });
  return `Archived item ${itemId}`;
}

export async function mondayMoveItemToGroup(token: string, itemId: string, groupId: string): Promise<string> {
  await gql(token, `
    mutation($itemId: ID!, $groupId: String!) {
      move_item_to_group(item_id: $itemId, group_id: $groupId) { id }
    }`, { itemId, groupId });
  return `Moved item ${itemId} to group ${groupId}`;
}

export async function mondayDuplicateItem(token: string, boardId: string, itemId: string, withUpdates = false): Promise<string> {
  const data = await gql(token, `
    mutation($boardId: ID!, $itemId: ID!, $withUpdates: Boolean) {
      duplicate_item(board_id: $boardId, item_id: $itemId, with_updates: $withUpdates) { id name }
    }`, { boardId, itemId, withUpdates });
  const item = data.duplicate_item;
  return `Duplicated item as "${item.name}" (id: ${item.id})`;
}

export async function mondayCreateSubitem(token: string, parentItemId: string, itemName: string, columnValues?: Record<string, unknown>): Promise<string> {
  const data = await gql(token, `
    mutation($parentItemId: ID!, $itemName: String!, $columnValues: JSON) {
      create_subitem(parent_item_id: $parentItemId, item_name: $itemName, column_values: $columnValues) {
        id name url parent_item { id }
      }
    }`, { parentItemId, itemName, columnValues: columnValues ? JSON.stringify(columnValues) : undefined });
  const item = data.create_subitem;
  return json({ id: item.id, name: item.name, url: item.url, parentItemId: item.parent_item.id });
}

// Parse a status/dropdown column's settings_str into its list of selectable label texts.
// Monday returns labels in several shapes depending on column/version:
//   - object map:   { "0": "בוצע", "1": "מבוטל" }
//   - array of obj: [ { id, label: "בוצע" }, ... ]  (this board)
//   - array of obj: [ { id, name: "..." }, ... ]
//   - array of str: [ "בוצע", ... ]
// Empty/whitespace labels (placeholder slots) are dropped.
export function parseColumnLabels(settingsStr: string | null | undefined): string[] {
  try {
    const raw = JSON.parse(settingsStr ?? "{}").labels;
    let out: unknown[] = [];
    if (Array.isArray(raw)) out = raw.map((l: any) => (typeof l === "string" ? l : l?.label ?? l?.name));
    else if (raw && typeof raw === "object") out = Object.values(raw);
    return out.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  } catch { return []; }
}

// Board column schema cache (id → {type, labels}). Short TTL — boards rarely change mid-run.
interface ColMeta { type: string; labels: string[]; title: string; }
const boardColsCache = new Map<string, { cols: Record<string, ColMeta>; ts: number }>();

async function getBoardCols(token: string, boardId: string): Promise<Record<string, ColMeta>> {
  const hit = boardColsCache.get(boardId);
  if (hit && Date.now() - hit.ts < 60_000) return hit.cols;
  const data = await gql(token, `
    query($boardId: ID!) {
      boards(ids: [$boardId]) { columns { id title type settings_str } }
    }`, { boardId });
  const cols: Record<string, ColMeta> = {};
  for (const c of data.boards?.[0]?.columns ?? []) {
    cols[c.id] = { type: c.type, labels: parseColumnLabels(c.settings_str), title: c.title ?? "" };
  }
  boardColsCache.set(boardId, { cols, ts: Date.now() });
  return cols;
}

// Map a key the agent supplied (which may be a real column id OR a human column title like
// "דחיפות") to the real column id. Returns the input unchanged if nothing matches.
function resolveColumnId(key: string, cols: Record<string, ColMeta>): string {
  if (cols[key]) return key;                                    // already a real id
  const k = key.trim().toLowerCase();
  for (const [id, meta] of Object.entries(cols)) {
    if ((meta.title ?? "").trim().toLowerCase() === k) return id;
  }
  return key;
}

// Resolve a list of emails/names to Monday user ids. Emails are matched exactly (case-insensitive);
// remaining plain names are matched against the account's user list by substring.
async function resolveUserIds(token: string, candidates: string[]): Promise<number[]> {
  const emails = candidates.filter((c) => c.includes("@"));
  const names = candidates.filter((c) => !c.includes("@"));
  const ids = new Set<number>();
  if (emails.length) {
    const data = await gql(token, `query($emails: [String]) { users(emails: $emails) { id email } }`, { emails }).catch(() => null);
    for (const u of data?.users ?? []) if (u?.id) ids.add(Number(u.id));
  }
  if (names.length) {
    const data = await gql(token, `query { users(limit: 500) { id name } }`).catch(() => null);
    for (const n of names) {
      const nN = n.trim().toLowerCase();
      const hit = (data?.users ?? []).find((u: any) => (u.name ?? "").toLowerCase().includes(nN));
      if (hit?.id) ids.add(Number(hit.id));
    }
  }
  return [...ids];
}

// LLMs sometimes pass columnValues (or a nested value) as a JSON STRING instead of an object.
// Object.entries() on a string yields char indices ("0","1",…), corrupting every column. Coerce
// any string that looks like JSON back into an object/value before use.
export function coerceColumns(v: unknown): Record<string, unknown> {
  let cur: unknown = v;
  for (let i = 0; i < 3 && typeof cur === "string"; i++) {
    const s = cur.trim();
    if (!(s.startsWith("{") || s.startsWith("["))) break;
    try { cur = JSON.parse(s); } catch { break; }
  }
  return cur && typeof cur === "object" && !Array.isArray(cur) ? cur as Record<string, unknown> : {};
}

// Coerce loosely-typed LLM column values into the exact shapes Monday's API requires,
// and DROP values the board can't accept (e.g. a status label that doesn't exist) so the
// whole mutation doesn't fail. Returns the safe values plus a note of what was dropped.
async function normalizeColumnValues(
  token: string, boardId: string, columnValuesRaw: Record<string, unknown>,
): Promise<{ values: Record<string, unknown>; dropped: string[] }> {
  const columnValues = coerceColumns(columnValuesRaw);
  const cols = await getBoardCols(token, boardId);
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [rawKey, vRaw] of Object.entries(columnValues)) {
    const id = resolveColumnId(rawKey, cols);  // accept a real id OR a column title
    const meta = cols[id];
    const v: any = vRaw;
    if (!meta) { out[id] = v; continue; } // unknown column id — pass through, let API judge
    switch (meta.type) {
      case "email": {
        const addr = typeof v === "string" ? v : (v?.email ?? v?.text ?? "");
        if (addr) out[id] = { email: addr, text: typeof v === "object" && v?.text ? v.text : addr };
        break;
      }
      case "people": {
        // A people column needs NUMERIC user ids. The agent often passes an email (sometimes even
        // as the "id" inside personsAndTeams). Collect every identifier from whatever shape it
        // sent, keep numeric ids, and resolve emails/names → real user ids via the API.
        const numericIds: number[] = [];
        const candidates: string[] = [];
        const collect = (x: any): void => {
          if (x == null) return;
          if (typeof x === "number") { numericIds.push(x); return; }
          if (typeof x === "string") { if (/^\d+$/.test(x.trim())) numericIds.push(Number(x)); else if (x.trim()) candidates.push(x.trim()); return; }
          if (Array.isArray(x)) { x.forEach(collect); return; }
          if (typeof x === "object") {
            if (Array.isArray(x.personsAndTeams)) { x.personsAndTeams.forEach((p: any) => collect(p?.id)); return; }
            collect(x.id ?? x.email ?? x.name);
          }
        };
        collect(v);
        const resolved = candidates.length ? await resolveUserIds(token, candidates) : [];
        const allIds = [...new Set([...numericIds, ...resolved])];
        if (allIds.length) out[id] = { personsAndTeams: allIds.map((uid) => ({ id: uid, kind: "person" })) };
        else if (candidates.length) dropped.push(`${id}: no Monday user matched ${candidates.join(", ")}`);
        break;
      }
      case "status":
      case "color": {
        const label = typeof v === "string" ? v : v?.label;
        if (label == null) break;
        const match = meta.labels.find((l) => l === label)
          ?? meta.labels.find((l) => l.trim().toLowerCase() === String(label).trim().toLowerCase());
        if (match) out[id] = { label: match };
        else dropped.push(`${id}="${label}" (allowed: ${meta.labels.join(", ") || "none"})`);
        break;
      }
      case "dropdown": {
        // Dropdown accepts { labels: ["existing option"] }; only keep options that exist.
        const wanted = Array.isArray(v?.labels) ? v.labels : [typeof v === "string" ? v : v?.label].filter(Boolean);
        const matched = wanted
          .map((w: any) => meta.labels.find((l) => l === w) ?? meta.labels.find((l) => l.trim().toLowerCase() === String(w).trim().toLowerCase()))
          .filter(Boolean);
        if (matched.length) out[id] = { labels: matched };
        else if (wanted.length) dropped.push(`${id}="${wanted.join(",")}" (allowed: ${meta.labels.join(", ") || "none"})`);
        break;
      }
      case "date": {
        if (typeof v === "string") { const d = v.match(/\d{4}-\d{2}-\d{2}/)?.[0]; if (d) out[id] = { date: d }; else dropped.push(`${id}="${v}"`); }
        else if (v?.date) out[id] = { date: v.date };
        break;
      }
      case "text":
      case "long-text": {
        // Text columns need a plain string. The agent sometimes sends a date as { date: ... } or
        // a value as { text: ... } — flatten those to the string the column expects.
        const s = typeof v === "string" ? v
          : v?.date ?? v?.text ?? v?.label ?? (v != null ? JSON.stringify(v) : "");
        if (String(s).trim()) out[id] = String(s);
        break;
      }
      default:
        out[id] = typeof v === "object" ? v : String(v);
    }
  }
  return { values: out, dropped };
}

// Write column values RESILIENTLY. change_multiple_column_values is all-or-nothing — one bad
// column rejects the whole batch and leaves the item empty. So we try the batch first; if it
// fails, we retry each column individually so the good ones still persist, and report exactly
// which set and which failed (the truth, not the agent's intent).
async function applyColumns(token: string, boardId: string, itemId: string, values: Record<string, unknown>): Promise<{ set: string[]; failed: string[] }> {
  const keys = Object.keys(values);
  if (!keys.length) return { set: [], failed: [] };
  try {
    await gql(token, `
      mutation($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
      }`, { boardId, itemId, columnValues: JSON.stringify(values) });
    return { set: keys, failed: [] };
  } catch {
    const set: string[] = []; const failed: string[] = [];
    for (const k of keys) {
      try {
        await gql(token, `
          mutation($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
            change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
          }`, { boardId, itemId, columnValues: JSON.stringify({ [k]: values[k] }) });
        set.push(k);
      } catch (e) { failed.push(`${k}: ${(e as Error).message.slice(0, 120)}`); }
    }
    return { set, failed };
  }
}

// Guarantee an item is assigned to a person, independent of whether the agent remembered to set
// the people column. Finds the board's people column, resolves the email to a Monday user id, and
// writes it. Returns a short status (no-op if there's no people column or the email isn't a user).
export async function mondayEnsureAssignee(token: string, boardId: string, itemId: string, email: string): Promise<string> {
  const cols = await getBoardCols(token, boardId);
  const peopleColId = Object.keys(cols).find((id) => {
    const t = cols[id].type;
    return t === "people" || t === "multiple-person" || id.startsWith("multiple_person") || id.startsWith("person");
  });
  if (!peopleColId) return "no people column on board";
  const ids = await resolveUserIds(token, [email]);
  if (!ids.length) return `no Monday user for ${email}`;
  const value = { [peopleColId]: { personsAndTeams: ids.map((uid) => ({ id: uid, kind: "person" })) } };
  try {
    await gql(token, `
      mutation($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
      }`, { boardId, itemId, columnValues: JSON.stringify(value) });
    return `assigned user ${ids.join(",")} to ${peopleColId} on item ${itemId}`;
  } catch (e) { return `assign failed: ${(e as Error).message.slice(0, 140)}`; }
}

export async function mondayCreateItem(token: string, boardId: string, itemName: string, columnValuesRaw?: Record<string, unknown>, groupId?: string): Promise<string> {
  // Create item with name only first, then set columns best-effort — never throw once the item
  // exists (a throw would make the caller retry create and orphan a duplicate).
  const columnValues = columnValuesRaw ? coerceColumns(columnValuesRaw) : undefined;  // handle stringified JSON
  const data = await gql(token, `
    mutation($boardId: ID!, $itemName: String!, $groupId: String) {
      create_item(board_id: $boardId, item_name: $itemName, group_id: $groupId) { id name url }
    }`, { boardId, itemName, groupId });
  const item = data.create_item;
  const notes: string[] = [];
  let setKeys: string[] = [];
  console.log(JSON.stringify({ tag: "monday", msg: "create_item columns", itemId: item.id, incomingKeys: columnValues ? Object.keys(columnValues) : [] }));
  if (columnValues && Object.keys(columnValues).length > 0) {
    const { values, dropped } = await normalizeColumnValues(token, boardId, columnValues);
    const { set, failed } = await applyColumns(token, boardId, item.id, values);
    setKeys = set;
    console.log(JSON.stringify({ tag: "monday", msg: "create_item result", itemId: item.id, set, failed, dropped }));
    if (dropped.length) notes.push(`skipped invalid: ${dropped.join("; ")}`);
    if (failed.length) notes.push(`failed: ${failed.join("; ")}`);
  }
  // Report ONLY columns that actually persisted, so the agent can't claim it set fields it didn't.
  return json({ id: item.id, name: item.name, url: item.url, columnsSet: setKeys, note: notes.length ? notes.join(" | ") : undefined });
}

export async function mondayUpdateItem(token: string, boardId: string, itemId: string, columnValues: Record<string, unknown>): Promise<string> {
  const { values, dropped } = await normalizeColumnValues(token, boardId, columnValues);
  const { set, failed } = await applyColumns(token, boardId, itemId, values);
  console.log(JSON.stringify({ tag: "monday", msg: "update_item result", itemId, set, failed, dropped }));
  const notes = [
    set.length ? `set: ${set.join(", ")}` : "",
    dropped.length ? `skipped invalid: ${dropped.join("; ")}` : "",
    failed.length ? `failed: ${failed.join("; ")}` : "",
  ].filter(Boolean);
  return `Updated item ${itemId}${notes.length ? ` (${notes.join(" | ")})` : ""}`;
}

// ── Groups ────────────────────────────────────────────────────────────────────

// Attach a file (base64) to a Monday item by posting an update and uploading the file to it.
// Uses Monday's multipart /v2/file endpoint. Returns the asset id on success.
export async function mondayAttachFileToItem(
  token: string, itemId: string, base64: string, filename: string, mimeType: string, note?: string,
): Promise<string> {
  // 1. Create an update to carry the file (add_file_to_update needs an update id).
  const upd = await gql(token, `
    mutation($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
    { itemId, body: note ?? `קובץ מצורף: ${filename}` });
  const updateId = upd.create_update.id;

  // 2. Multipart upload to the file endpoint — Monday's documented form uses variables[file]=@file.
  const query = `mutation($file: File!) { add_file_to_update(update_id: ${updateId}, file: $file) { id url } }`;
  const form = new FormData();
  form.append("query", query);
  form.append("variables[file]", new Blob([Buffer.from(base64, "base64")], { type: mimeType }), filename);

  const res = await fetch("https://api.monday.com/v2/file", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "API-Version": MONDAY_API_VERSION },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json() as { data?: any; errors?: any[] };
  if (body.errors?.length) throw new Error(body.errors.map((e: any) => e.message).join("; "));
  const asset = body.data?.add_file_to_update;
  return `Attached "${filename}" to item ${itemId} (asset id: ${asset?.id}, update id: ${updateId})`;
}

export async function mondayCreateGroup(token: string, boardId: string, groupName: string, groupColor?: string): Promise<string> {
  const data = await gql(token, `
    mutation($boardId: ID!, $groupName: String!, $groupColor: String) {
      create_group(board_id: $boardId, group_name: $groupName, group_color: $groupColor) { id title }
    }`, { boardId, groupName, groupColor });
  const g = data.create_group;
  return `Created group "${g.title}" (id: ${g.id})`;
}

export async function mondayDeleteGroup(token: string, boardId: string, groupId: string): Promise<string> {
  const data = await gql(token, `
    mutation($boardId: ID!, $groupId: String!) {
      delete_group(board_id: $boardId, group_id: $groupId) { id deleted }
    }`, { boardId, groupId });
  return data.delete_group?.deleted ? `Deleted group ${groupId}` : `Group ${groupId} could not be deleted`;
}

// ── Columns ───────────────────────────────────────────────────────────────────

export async function mondayCreateColumn(token: string, boardId: string, columnTitle: string, columnType: string, description?: string): Promise<string> {
  const data = await gql(token, `
    mutation($boardId: ID!, $columnTitle: String!, $columnType: ColumnType!, $description: String) {
      create_column(board_id: $boardId, title: $columnTitle, column_type: $columnType, description: $description) {
        id title type
      }
    }`, { boardId, columnTitle, columnType, description });
  const c = data.create_column;
  return `Created column "${c.title}" of type ${c.type} (id: ${c.id})`;
}

// ── Updates / Comments ────────────────────────────────────────────────────────

export async function mondayGetUpdates(token: string, itemId: string, limit = 25): Promise<string> {
  const data = await gql(token, `
    query($itemId: ID!, $limit: Int!) {
      items(ids: [$itemId]) {
        updates(limit: $limit) {
          id body text_body created_at updated_at item_id
          creator { id name }
          replies { id body creator { id name } }
        }
      }
    }`, { itemId, limit });
  return json(data.items?.[0]?.updates ?? []);
}

export async function mondayCreateUpdate(token: string, itemId: string, body: string): Promise<string> {
  const data = await gql(token, `
    mutation($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`, { itemId, body });
  return `Posted update (id: ${data.create_update.id})`;
}

export async function mondayDeleteUpdate(token: string, updateId: string): Promise<string> {
  await gql(token, `mutation($updateId: ID!) { delete_update(id: $updateId) { id } }`, { updateId });
  return `Deleted update ${updateId}`;
}

// ── Connected Board Resolver ──────────────────────────────────────────────────

export async function mondayResolveConnectedItem(
  token: string,
  boardId: string,
  columnId: string,
  searchName: string,
): Promise<string> {
  const boardData = await gql(token, `
    query($boardId: ID!) {
      boards(ids: [$boardId]) {
        columns { id title type settings_str }
      }
    }`, { boardId });

  const columns: any[] = boardData.boards?.[0]?.columns ?? [];
  const col = columns.find((c: any) =>
    c.id === columnId || c.title.toLowerCase() === columnId.toLowerCase()
  );
  if (!col) return `Column "${columnId}" not found on board ${boardId}.`;
  if (col.type !== "board_relation") return `Column "${col.title}" is type "${col.type}", not a connected board column (board_relation).`;

  let settings: any = {};
  try { settings = JSON.parse(col.settings_str ?? "{}"); } catch {}
  // Monday uses "boardIds" (array) or "boardId" (scalar); fall back to "linked_board_ids".
  let rawIds: unknown[];
  if (Array.isArray(settings.boardIds) && settings.boardIds.length) rawIds = settings.boardIds;
  else if (settings.boardId != null) rawIds = [settings.boardId];
  else rawIds = settings.linked_board_ids ?? [];
  const connectedBoardIds: string[] = (rawIds as any[]).map(String).filter(id => id && id !== "undefined");
  if (!connectedBoardIds.length) return `Column "${col.title}" has no connected boards configured. Raw settings: ${JSON.stringify(settings)}`;

  const allMatches: Array<{ id: string; name: string; boardId: string; boardName: string; score: number }> = [];

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const searchNorm = normalize(searchName);
  const searchLower = searchName.toLowerCase();

  // items_page with column_id:"name" + contains_text is the correct way to search
  // items by name — no wildcard column_id exists in Monday API 2026-04.
  for (const cbId of connectedBoardIds) {
    const queryParams = {
      rules: [{ column_id: "name", compare_value: [searchName], operator: "contains_text" }],
    };
    const searchData = await gql(token, `
      query($boardId: ID!, $queryParams: ItemsQuery) {
        boards(ids: [$boardId]) {
          name
          items_page(limit: 20, query_params: $queryParams) {
            items { id name }
          }
        }
      }`, { boardId: cbId, queryParams });

    const board = searchData.boards?.[0];
    if (!board) continue;
    const items: any[] = board.items_page?.items ?? [];
    for (const item of items) {
      const nameLower = (item.name as string).toLowerCase();
      const nameNorm = normalize(item.name);
      const score = nameLower === searchLower ? 100
        : nameNorm === searchNorm ? 95
        : nameLower.startsWith(searchLower) ? 80
        : nameNorm.startsWith(searchNorm) ? 75
        : nameLower.includes(searchLower) ? 60
        : nameNorm.includes(searchNorm) ? 55 : 40;
      allMatches.push({ id: item.id, name: item.name, boardId: cbId, boardName: board.name, score });
    }
  }

  if (!allMatches.length) {
    return `No items matching "${searchName}" found in connected boards (searched board IDs: ${connectedBoardIds.join(", ")}) for column "${col.title}". Try a shorter or different search term.`;
  }

  allMatches.sort((a, b) => b.score - a.score);

  // Verify the top candidates actually exist — items_page can return stale/ghost IDs.
  const candidateIds = allMatches.slice(0, 5).map(m => m.id);
  const verifyData = await gql(token, `
    query($ids: [ID!]!) { items(ids: $ids) { id name } }`, { ids: candidateIds });
  const liveIds = new Set<string>((verifyData.items ?? []).map((i: any) => String(i.id)));
  const verified = allMatches.filter(m => liveIds.has(String(m.id)));

  if (!verified.length) {
    return `Found ${allMatches.length} candidate(s) for "${searchName}" but none could be verified as existing items. Candidates: ${allMatches.map(m => `${m.name} (id: ${m.id})`).join(", ")}. Ask the user to provide the exact item name or ID.`;
  }

  const top = verified[0];
  const second = verified[1];

  // Confidence: high = clear winner (score≥80, gap≥20 over 2nd or only one result)
  //             medium = plausible but ambiguous (score≥60 or close competitors)
  //             low = weak match, must verify
  const gap = second ? top.score - second.score : 999;
  const confidence: "high" | "medium" | "low" =
    top.score >= 80 && gap >= 20 ? "high" :
    top.score >= 60 ? "medium" : "low";

  const suggestion =
    confidence === "high"
      ? "High confidence — proceed with bestMatch."
      : confidence === "medium"
      ? "Medium confidence — show the user bestMatch name and otherMatches and ask them to confirm before creating the item."
      : "Low confidence — show all options to the user and ask them to pick one before proceeding.";

  return json({
    columnTitle: col.title,
    columnId: col.id,
    confidence,
    suggestion,
    bestMatch: { id: top.id, name: top.name, boardId: top.boardId, boardName: top.boardName },
    otherMatches: verified.slice(1, 5).map(m => ({ id: m.id, name: m.name, boardId: m.boardId, boardName: m.boardName })),
    columnValue: { item_ids: [Number(top.id)] },
  });
}

// ── Cross-board search & My Items ─────────────────────────────────────────────

export async function mondaySearchItems(
  token: string,
  boardIds: string[],
  searchTerm: string,
  limit = 25,
): Promise<string> {
  // Match in CODE, not via Monday's query_params name filter — that filter is unreliable for
  // long/Hebrew names (one differing char → zero results). We page through the board's items
  // and score each by substring + word-overlap against the search term, so an exact name always
  // matches and partial terms ("מזגן בית הלוחם") still surface the right call.
  const norm = (s: string) => s.toLowerCase().replace(/[\s\-_,./]+/g, " ").trim();
  const termN = norm(searchTerm);
  const termWords = termN.split(" ").filter((w) => w.length >= 2);

  const scored: Array<{ item: any; score: number }> = [];
  for (const boardId of boardIds) {
    let cursor: string | null = null;
    let pages = 0;
    do {
      const data: any = cursor
        ? await gql(token, `query($cursor: String!, $limit: Int!) { next_items_page(limit: $limit, cursor: $cursor) { cursor items { ${ITEM_FIELDS} } } }`, { cursor, limit: 250 })
        : await gql(token, `query($boardId: ID!, $limit: Int!) { boards(ids: [$boardId]) { id name items_page(limit: $limit) { cursor items { ${ITEM_FIELDS} } } } }`, { boardId, limit: 250 });
      const board = cursor ? null : data.boards?.[0];
      const page: any = cursor ? data.next_items_page : board?.items_page;
      const boardName = board?.name;
      const bId = board?.id ?? boardId;
      for (const item of page?.items ?? []) {
        const nameN = norm(item.name ?? "");
        let score = 0;
        if (nameN === termN) score = 1000;                          // exact name
        else if (termN && nameN.includes(termN)) score = 500;       // full term is a substring
        else if (termN && termN.includes(nameN) && nameN.length > 1) score = 400;
        const hits = termWords.filter((w) => nameN.includes(w)).length;
        score += hits * 50;                                          // per matching word
        if (score > 0) scored.push({ item: { ...item, boardId: bId, boardName }, score });
      }
      cursor = page?.cursor ?? null;
      pages++;
    } while (cursor && pages < 8);                                  // up to ~2000 items/board
  }
  scored.sort((a, b) => b.score - a.score);
  return json(scored.slice(0, limit).map((s) => s.item));
}

export async function mondayGetMyItems(
  token: string,
  boardIds: string[],
  assigneeColumnId = "people",
  limit = 50,
): Promise<string> {
  const meData = await gql(token, `{ me { id name } }`);
  const myId = meData.me?.id;
  if (!myId) return "Could not retrieve current user ID.";

  const queryParams = {
    rules: [{ column_id: assigneeColumnId, compare_value: [`person-${myId}`], operator: "any_of" }],
  };
  const results: any[] = [];
  for (const boardId of boardIds) {
    try {
      const data = await gql(token, `
        query($boardId: ID!, $limit: Int!, $queryParams: ItemsQuery) {
          boards(ids: [$boardId]) {
            id name
            items_page(limit: $limit, query_params: $queryParams) {
              items { ${ITEM_FIELDS} }
            }
          }
        }`, { boardId, limit, queryParams });
      const board = data.boards?.[0];
      if (!board) continue;
      for (const item of (board.items_page?.items ?? [])) {
        results.push({ ...item, boardId: board.id, boardName: board.name });
      }
    } catch { /* board may lack the person column — skip */ }
  }
  return json({ assignedToId: myId, assignedToName: meData.me?.name, items: results });
}

// ── Users ─────────────────────────────────────────────────────────────────────

export async function mondayGetMe(token: string): Promise<string> {
  const data = await gql(token, `
    { me { id name email title time_zone_identifier account { id name slug } } }`);
  return json(data.me);
}

export async function mondayGetUsers(token: string, limit = 50, name?: string, emails?: string[]): Promise<string> {
  const hasEmails = emails && emails.length > 0;
  const hasName = name && name.length > 0;

  // Build query with only the arguments that are actually provided —
  // passing undefined/null for list variables causes Monday API errors.
  let query: string;
  let variables: Record<string, unknown>;

  if (hasEmails) {
    query = `query($emails: [String]) { users(emails: $emails) { id name email } }`;
    variables = { emails };
  } else if (hasName) {
    query = `query($limit: Int, $name: String) { users(limit: $limit, name: $name) { id name email } }`;
    variables = { limit, name };
  } else {
    query = `query($limit: Int) { users(limit: $limit) { id name email } }`;
    variables = { limit };
  }

  const data = await gql(token, query, variables);
  return json(data.users);
}

// ── Demo helpers (admin task-logging loop) ────────────────────────────────────

// Assign a person to an item's people column. Wraps the nested change_multiple_column_values
// payload so the agent doesn't have to hand-build the {personsAndTeams:[{id,kind}]} JSON.
export async function mondayAssignPerson(token: string, boardId: string, itemId: string, personColumnId: string, userId: number): Promise<string> {
  const columnValues = { [personColumnId]: { personsAndTeams: [{ id: userId, kind: "person" }] } };
  await gql(token, `
    mutation($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
    }`, { boardId, itemId, columnValues: JSON.stringify(columnValues) });
  return `Assigned user ${userId} to item ${itemId}`;
}

// List active items on a board that have received no update since `sinceISO`.
// Powers the weekly "these calls weren't updated this week" group reminder.
export async function mondayListStaleItems(token: string, boardId: string, sinceISO: string): Promise<string> {
  const data = await gql(token, `
    query($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
          items {
            id name state
            updates(limit: 1) { created_at }
          }
        }
      }
    }`, { boardId });
  const since = new Date(sinceISO).getTime();
  const items: Array<{ id: string; name: string; state: string; updates: Array<{ created_at: string }> }> =
    data.boards?.[0]?.items_page?.items ?? [];
  const stale = items
    .filter((it) => it.state !== "archived" && it.state !== "deleted")
    .filter((it) => {
      const last = it.updates?.[0]?.created_at;
      return !last || new Date(last).getTime() < since;
    })
    .map((it) => ({ id: it.id, name: it.name }));
  return json(stale);
}
