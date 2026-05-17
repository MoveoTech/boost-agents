const BASE = "https://tasks.googleapis.com/tasks/v1";

async function req(token: string, path: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Tasks API error: ${res.status}`);
  if (method === "DELETE") return null;
  return res.json();
}

export async function tasksListTasklists(token: string): Promise<string> {
  const data = await req(token, "/users/@me/lists?maxResults=20");
  return (data.items ?? []).map((l: any) => `${l.title} (id: ${l.id})`).join("\n") || "No task lists found";
}

export async function tasksListTasks(token: string, tasklistId = "@default", showCompleted = false): Promise<string> {
  const data = await req(token, `/lists/${tasklistId}/tasks?maxResults=50&showCompleted=${showCompleted}&showHidden=false`);
  const tasks = data.items ?? [];
  if (!tasks.length) return "No tasks found";
  return tasks.map((t: any) => {
    const status = t.status === "completed" ? "✓" : "○";
    const due = t.due ? ` (due: ${t.due.slice(0, 10)})` : "";
    const notes = t.notes ? ` — ${t.notes.slice(0, 80)}` : "";
    return `${status} ${t.title}${due}${notes} [id: ${t.id}]`;
  }).join("\n");
}

export async function tasksCreateTask(token: string, title: string, tasklistId = "@default", notes?: string, due?: string): Promise<string> {
  const body: any = { title, status: "needsAction" };
  if (notes) body.notes = notes;
  if (due) body.due = new Date(due).toISOString();
  const data = await req(token, `/lists/${tasklistId}/tasks`, "POST", body);
  return `Created task "${data.title}" (id: ${data.id})`;
}

export async function tasksCompleteTask(token: string, taskId: string, tasklistId = "@default"): Promise<string> {
  await req(token, `/lists/${tasklistId}/tasks/${taskId}`, "PATCH", { status: "completed" });
  return `Task marked as completed`;
}

export async function tasksUpdateTask(token: string, taskId: string, tasklistId = "@default", title?: string, notes?: string, due?: string): Promise<string> {
  const body: any = {};
  if (title) body.title = title;
  if (notes !== undefined) body.notes = notes;
  if (due) body.due = new Date(due).toISOString();
  await req(token, `/lists/${tasklistId}/tasks/${taskId}`, "PATCH", body);
  return `Task updated`;
}

export async function tasksDeleteTask(token: string, taskId: string, tasklistId = "@default"): Promise<string> {
  await req(token, `/lists/${tasklistId}/tasks/${taskId}`, "DELETE");
  return `Task deleted`;
}
