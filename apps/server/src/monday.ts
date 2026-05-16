const MONDAY_API = "https://api.monday.com/v2";

async function gqlRequest(token: string, gql: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: gql, variables }),
  });
  const json = await res.json() as { data?: any; errors?: any[] };
  if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join("; "));
  return json.data;
}

// Generic GraphQL — lets the agent write any query/mutation it needs
export async function mondayGraphQL(token: string, gql: string, variables?: Record<string, unknown>): Promise<string> {
  const data = await gqlRequest(token, gql, variables);
  return JSON.stringify(data, null, 2);
}

export async function mondayCreateItem(token: string, boardId: string, itemName: string, columnValues?: Record<string, string>): Promise<string> {
  const data = await gqlRequest(token, `
    mutation($boardId: ID!, $itemName: String!, $columnValues: JSON) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id name }
    }`, { boardId, itemName, columnValues: columnValues ? JSON.stringify(columnValues) : undefined });
  return `Created item "${data.create_item.name}" (id: ${data.create_item.id})`;
}

export async function mondayUpdateItem(token: string, boardId: string, itemId: string, columnValues: Record<string, string>): Promise<string> {
  await gqlRequest(token, `
    mutation($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
    }`, { boardId, itemId, columnValues: JSON.stringify(columnValues) });
  return `Updated item ${itemId}`;
}

export async function mondayCreateUpdate(token: string, itemId: string, body: string): Promise<string> {
  const data = await gqlRequest(token, `
    mutation($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`, { itemId, body });
  return `Posted update (id: ${data.create_update.id})`;
}
