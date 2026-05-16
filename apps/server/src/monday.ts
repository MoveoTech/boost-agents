const MONDAY_API = "https://api.monday.com/v2";

async function query(token: string, gql: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: gql, variables }),
  });
  const json = await res.json() as { data?: any; errors?: any[] };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

export async function mondayListBoards(token: string): Promise<string> {
  const data = await query(token, `{ boards(limit: 20) { id name state } }`);
  return data.boards.map((b: any) => `${b.name} (id: ${b.id}, state: ${b.state})`).join("\n");
}

export async function mondayGetItems(token: string, boardId: string, limit = 20): Promise<string> {
  const data = await query(token, `
    query($boardId: ID!, $limit: Int!) {
      boards(ids: [$boardId]) {
        name
        items_page(limit: $limit) {
          items { id name state column_values { id text } }
        }
      }
    }`, { boardId, limit });
  const board = data.boards[0];
  if (!board) return "Board not found";
  const items = board.items_page.items.map((item: any) => {
    const cols = item.column_values.filter((c: any) => c.text).map((c: any) => `${c.id}: ${c.text}`).join(", ");
    return `- ${item.name} (id: ${item.id})${cols ? ` [${cols}]` : ""}`;
  }).join("\n");
  return `Board: ${board.name}\n${items || "No items"}`;
}

export async function mondayCreateItem(token: string, boardId: string, itemName: string, columnValues?: Record<string, string>): Promise<string> {
  const data = await query(token, `
    mutation($boardId: ID!, $itemName: String!, $columnValues: JSON) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id name }
    }`, { boardId, itemName, columnValues: columnValues ? JSON.stringify(columnValues) : undefined });
  return `Created item "${data.create_item.name}" (id: ${data.create_item.id})`;
}

export async function mondayUpdateItem(token: string, boardId: string, itemId: string, columnValues: Record<string, string>): Promise<string> {
  await query(token, `
    mutation($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
    }`, { boardId, itemId, columnValues: JSON.stringify(columnValues) });
  return `Updated item ${itemId}`;
}

export async function mondayCreateUpdate(token: string, itemId: string, body: string): Promise<string> {
  const data = await query(token, `
    mutation($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`, { itemId, body });
  return `Posted update (id: ${data.create_update.id})`;
}

export async function mondaySearchItems(token: string, query_str: string, limit = 10): Promise<string> {
  const data = await query(token, `
    query($query: String!, $limit: Int!) {
      items_by_multiple_column_values(limit: $limit, board_ids: [], column_id: "name", column_value: $query) {
        id name board { id name }
      }
    }`, { query: query_str, limit });
  if (!data.items_by_multiple_column_values?.length) return "No items found";
  return data.items_by_multiple_column_values
    .map((i: any) => `- ${i.name} (id: ${i.id}, board: ${i.board.name})`).join("\n");
}
