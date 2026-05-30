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
        columns { id title type }
        groups { id title }
      }
    }`, { boardId });
  return json(data.boards?.[0] ?? "Board not found");
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

export async function mondayCreateItem(token: string, boardId: string, itemName: string, columnValues?: Record<string, unknown>, groupId?: string): Promise<string> {
  // Create item with name only — Monday silently drops column_values on create if any
  // value fails validation. Setting columns separately via change_multiple_column_values
  // surfaces real errors instead of silently succeeding with empty columns.
  const data = await gql(token, `
    mutation($boardId: ID!, $itemName: String!, $groupId: String) {
      create_item(board_id: $boardId, item_name: $itemName, group_id: $groupId) { id name url }
    }`, { boardId, itemName, groupId });
  const item = data.create_item;
  if (columnValues && Object.keys(columnValues).length > 0) {
    await gql(token, `
      mutation($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
      }`, { boardId, itemId: item.id, columnValues: JSON.stringify(columnValues) });
  }
  return json({ id: item.id, name: item.name, url: item.url });
}

export async function mondayUpdateItem(token: string, boardId: string, itemId: string, columnValues: Record<string, unknown>): Promise<string> {
  await gql(token, `
    mutation($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
    }`, { boardId, itemId, columnValues: JSON.stringify(columnValues) });
  return `Updated item ${itemId}`;
}

// ── Groups ────────────────────────────────────────────────────────────────────

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
  const results: any[] = [];
  const queryParams = {
    rules: [{ column_id: "name", compare_value: [searchTerm], operator: "contains_text" }],
  };
  for (const boardId of boardIds) {
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
    if (results.length >= limit) break;
  }
  return json(results.slice(0, limit));
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
