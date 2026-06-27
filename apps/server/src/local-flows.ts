import { promises as fs } from "fs";
import path from "path";
import type { Automation } from "./automations";

// Local flow store for development: flow definitions live in a JSON file instead of Cloud Scheduler,
// so the whole flows feature (create/list/webhook-trigger) works off-GCP with no metadata server.
// Cron schedules do NOT fire locally (there's no scheduler) — webhook + manual runs work.
// Gated by IS_LOCAL at the call sites (automations.ts).

const FILE = path.join(__dirname, "..", ".local-flows.json");

async function readAll(): Promise<Automation[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as Automation[];
  } catch {
    return [];
  }
}

async function writeAll(list: Automation[]): Promise<void> {
  await fs.writeFile(FILE, JSON.stringify(list, null, 2));
}

export async function localList(): Promise<Automation[]> {
  return readAll();
}

export async function localGet(id: string): Promise<Automation | null> {
  return (await readAll()).find((a) => a.id === id) ?? null;
}

export async function localUpsert(automation: Automation): Promise<void> {
  const list = await readAll();
  const i = list.findIndex((a) => a.id === automation.id);
  if (i >= 0) list[i] = automation; else list.push(automation);
  await writeAll(list);
}

export async function localDelete(id: string): Promise<void> {
  await writeAll((await readAll()).filter((a) => a.id !== id));
}
