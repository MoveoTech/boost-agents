import { memorySave, memoryRecall } from "./memory";

const CONTACTS_KEY = "contacts";

interface ContactEntry { name: string; phone: string; }
type ContactMap = Record<string, ContactEntry>;

function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

function normalizePhone(raw: string): string {
  // Keep + prefix, strip spaces, dashes, parens, dots
  const stripped = raw.replace(/[\s\-\(\)\.]/g, "");
  return stripped.startsWith("+") ? stripped : stripped.replace(/^00/, "+");
}

export function parseVCards(vcfText: string): ContactEntry[] {
  const results: ContactEntry[] = [];
  // Split on END:VCARD to isolate each card block
  const blocks = vcfText.split(/END:VCARD/i);
  for (const block of blocks) {
    const startIdx = block.search(/BEGIN:VCARD/i);
    if (startIdx === -1) continue;
    const card = block.slice(startIdx);

    // Handle vCard line folding (lines starting with whitespace continue previous line)
    const unfolded = card.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");

    // Extract FN (full name)
    const fnMatch = unfolded.match(/^FN[^:]*:(.+)$/m);
    if (!fnMatch) continue;
    const name = fnMatch[1].trim().replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/g, " ").trim();
    if (!name) continue;

    // Collect all TEL lines
    const telMatches = [...unfolded.matchAll(/^(TEL[^:]*):(.+)$/gm)];
    if (!telMatches.length) continue;

    // Prefer CELL or MOBILE type; fall back to first
    const cellMatch = telMatches.find((m) => /CELL|MOBILE/i.test(m[1]));
    const raw = (cellMatch ?? telMatches[0])[2].trim();
    const phone = normalizePhone(raw);
    if (!phone || phone.replace(/\D/g, "").length < 7) continue;

    results.push({ name, phone });
  }
  return results;
}

async function loadContactMap(email: string): Promise<ContactMap> {
  const raw = await memoryRecall(email, CONTACTS_KEY);
  if (!raw || raw.startsWith("No memory") || raw.startsWith("Memory not configured")) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export async function importContacts(email: string, contacts: ContactEntry[]): Promise<number> {
  const map = await loadContactMap(email);
  for (const c of contacts) {
    map[normalizeName(c.name)] = c;
  }
  await memorySave(email, CONTACTS_KEY, JSON.stringify(map));
  return contacts.length;
}

export async function lookupContact(email: string, query: string): Promise<ContactEntry | null> {
  const map = await loadContactMap(email);
  const q = normalizeName(query.replace(/^@/, "")); // strip leading @
  if (!q) return null;

  // 1. Exact match
  if (map[q]) return map[q];

  // 2. Any key starts with query or query starts with key (first-name match)
  const keys = Object.keys(map);
  const prefix = keys.find((k) => k.startsWith(q) || q.startsWith(k));
  if (prefix) return map[prefix];

  // 3. Any key contains query
  const contains = keys.find((k) => k.includes(q));
  if (contains) return map[contains];

  return null;
}

export async function listContacts(email: string): Promise<ContactEntry[]> {
  const map = await loadContactMap(email);
  return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
}
