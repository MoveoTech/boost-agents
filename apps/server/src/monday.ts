const MONDAY_API = "https://api.monday.com/v2";
const MONDAY_API_VERSION = "2025-10";

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
  const json = await res.json() as { data?: any; errors?: any[] };
  if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join("; "));
  return json.data;
}

function json(v: any): string { return JSON.stringify(v, null, 2); }

const ITEM_FIELDS = `
  id name url state created_at updated_at
  group { id title }
  column_values { id text value type }
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
  return `Created board "${b.name}" (id: ${b.id})`;
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
  if (searchTerm) rules.push({ column_id: "__any__", compare_value: [searchTerm], operator: "contains_terms" });
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
  return `Created subitem "${item.name}" (id: ${item.id}) under parent item ${item.parent_item.id}`;
}

export async function mondayCreateItem(token: string, boardId: string, itemName: string, columnValues?: Record<string, unknown>, groupId?: string): Promise<string> {
  const data = await gql(token, `
    mutation($boardId: ID!, $itemName: String!, $columnValues: JSON, $groupId: String) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues, group_id: $groupId) { id name }
    }`, { boardId, itemName, columnValues: columnValues ? JSON.stringify(columnValues) : undefined, groupId });
  return `Created item "${data.create_item.name}" (id: ${data.create_item.id})`;
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

// ── Users ─────────────────────────────────────────────────────────────────────

export async function mondayGetMe(token: string): Promise<string> {
  const data = await gql(token, `
    { me { id name email title phone mobile_phone time_zone_identifier account { id name } } }`);
  return json(data.me);
}

export async function mondayGetUsers(token: string, limit = 50, name?: string): Promise<string> {
  const data = await gql(token, `
    query($limit: Int!, $name: String) {
      users(limit: $limit, name: $name) {
        id name email title phone mobile_phone
        teams { id name }
      }
    }`, { limit, name });
  return json(data.users);
}
