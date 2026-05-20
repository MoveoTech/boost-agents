// WhatsApp session manager using Baileys (ESM — imported dynamically)
// Credentials persisted in Firestore via oauth-service.

type SessionStatus = "connecting" | "qr" | "connected" | "disconnected";

interface Session {
  socket: any;
  status: SessionStatus;
  qr?: string;
  qrListeners: Array<(qr: string) => void>;
  connectedListeners: Array<() => void>;
}

// email → session
const sessions = new Map<string, Session>();

// ── Firestore credential helpers ──────────────────────────────────────────────

function serialize(obj: any): string {
  return JSON.stringify(obj, (_k, v) => {
    if (v instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(v))) {
      return { _type: "Buffer", data: Array.from(v as Uint8Array) };
    }
    return v;
  });
}

function deserialize(str: string): any {
  return JSON.parse(str, (_k, v) => {
    if (v && v._type === "Buffer" && Array.isArray(v.data)) {
      return Buffer.from(v.data);
    }
    return v;
  });
}

async function loadCreds(agentId: string, email: string, oauthUrl: string, oauthKey: string): Promise<{ creds: string; keys: string } | null> {
  const res = await fetch(`${oauthUrl}/api/whatsapp/${agentId}/${encodeURIComponent(email)}`, {
    headers: { "x-api-key": oauthKey },
  });
  if (!res.ok) return null;
  return res.json() as any;
}

async function saveCreds(agentId: string, email: string, oauthUrl: string, oauthKey: string, data: { creds: string; keys: string }): Promise<void> {
  await fetch(`${oauthUrl}/api/whatsapp/${agentId}/${encodeURIComponent(email)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-api-key": oauthKey },
    body: JSON.stringify(data),
  });
}

async function deleteCreds(agentId: string, email: string, oauthUrl: string, oauthKey: string): Promise<void> {
  await fetch(`${oauthUrl}/api/whatsapp/${agentId}/${encodeURIComponent(email)}`, {
    method: "DELETE",
    headers: { "x-api-key": oauthKey },
  });
}

// ── Firestore-backed Baileys auth state ───────────────────────────────────────

async function makeAuthState(agentId: string, email: string, oauthUrl: string, oauthKey: string) {
  const { initAuthCreds } = await import("@whiskeysockets/baileys");
  const saved = await loadCreds(agentId, email, oauthUrl, oauthKey);

  let creds: any = saved?.creds ? deserialize(saved.creds) : initAuthCreds();
  const keyMap: Record<string, any> = saved?.keys ? deserialize(saved.keys) : {};

  const persist = async () => {
    await saveCreds(agentId, email, oauthUrl, oauthKey, {
      creds: serialize(creds),
      keys: serialize(keyMap),
    });
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const result: Record<string, any> = {};
          for (const id of ids) {
            const val = keyMap[`${type}-${id}`];
            if (val !== undefined) result[id] = JSON.parse(serialize(val), (_k, v) => {
              if (v && v._type === "Buffer" && Array.isArray(v.data)) return Buffer.from(v.data);
              return v;
            });
          }
          return result;
        },
        set: async (data: Record<string, Record<string, any>>) => {
          for (const [category, values] of Object.entries(data)) {
            for (const [id, val] of Object.entries(values ?? {})) {
              if (val != null) keyMap[`${category}-${id}`] = val;
              else delete keyMap[`${category}-${id}`];
            }
          }
          await persist();
        },
      },
    },
    saveCreds: async () => {
      await persist();
    },
    updateCreds: (newCreds: any) => { creds = newCreds; },
  };
}

// ── Core connect function ─────────────────────────────────────────────────────

export interface WhatsAppConfig {
  replyTrigger: "mention" | "keyword" | "always";
  keyword?: string;
  replyInGroups: boolean;
  replyInDMs: boolean;
  customPrompt?: string;
}

export const DEFAULT_WA_CONFIG: WhatsAppConfig = {
  replyTrigger: "mention",
  replyInGroups: true,
  replyInDMs: false,
};

// Handler receives full message context; returns reply text or null (= no reply)
export type MessageHandler = (params: {
  email: string;
  from: string;
  fromName: string;
  text: string;
  isGroup: boolean;
  groupName?: string;
  isMentioned: boolean;
}) => Promise<string | null>;

// Keep old name as alias for index.ts compatibility during migration
export type MentionHandler = MessageHandler;

export async function connectSession(
  email: string,
  agentId: string,
  oauthUrl: string,
  oauthKey: string,
  mentionHandler: MentionHandler,
  onQR?: (qr: string) => void,
  onConnected?: () => void,
): Promise<void> {
  // If already connected or connecting, just register new listeners
  const existing = sessions.get(email);
  if (existing) {
    if (existing.status === "connected") { onConnected?.(); return; }
    if (onQR) existing.qrListeners.push(onQR);
    if (onConnected) existing.connectedListeners.push(onConnected);
    if (existing.status === "qr" && existing.qr && onQR) onQR(existing.qr);
    return;
  }

  const session: Session = { socket: null, status: "connecting", qrListeners: onQR ? [onQR] : [], connectedListeners: onConnected ? [onConnected] : [] };
  sessions.set(email, session);

  const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = await import("@whiskeysockets/baileys");
  const { Boom } = await import("@hapi/boom");
  const { version } = await fetchLatestBaileysVersion();
  const auth = await makeAuthState(agentId, email, oauthUrl, oauthKey);

  const sock = makeWASocket({
    version,
    auth: auth.state,
    printQRInTerminal: false,
    browser: ["Boost Agent", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => undefined,
  });

  session.socket = sock;

  sock.ev.on("creds.update", async (update: any) => {
    auth.updateCreds({ ...auth.state.creds, ...update });
    await auth.saveCreds();
  });

  sock.ev.on("connection.update", async (update: any) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.status = "qr";
      session.qr = qr;
      session.qrListeners.forEach((fn) => fn(qr));
    }

    if (connection === "open") {
      session.status = "connected";
      session.qr = undefined;
      session.connectedListeners.forEach((fn) => fn());
      session.qrListeners = [];
      session.connectedListeners = [];
      console.log(`[whatsapp] ${email} connected`);
    }

    if (connection === "close") {
      const code = (lastDisconnect?.error as InstanceType<typeof Boom>)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log(`[whatsapp] ${email} logged out — clearing session`);
        sessions.delete(email);
        await deleteCreds(agentId, email, oauthUrl, oauthKey).catch(() => {});
      } else {
        console.log(`[whatsapp] ${email} disconnected (code ${code}) — reconnecting`);
        sessions.delete(email);
        // Back off slightly then reconnect
        setTimeout(() => {
          connectSession(email, agentId, oauthUrl, oauthKey, mentionHandler).catch(() => {});
        }, 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
    if (type !== "notify") return;
    const myJid = sock.user?.id?.replace(/:.*@/, "@");

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "";

      if (!text) continue;

      const mentionedJids: string[] =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];

      const isMentioned = !!(myJid && mentionedJids.some((j: string) =>
        j.replace(/:.*@/, "@") === myJid
      ));

      const from: string = msg.key.remoteJid ?? "";
      const isGroup = from.endsWith("@g.us");
      let groupName: string | undefined;
      let fromName = msg.pushName ?? from.split("@")[0];

      if (isGroup) {
        try {
          const meta = await sock.groupMetadata(from);
          groupName = meta.subject;
        } catch { /* no metadata */ }
      }

      try {
        const reply = await mentionHandler({ email, from, fromName, text, isGroup, groupName, isMentioned });
        if (reply) {
          await sock.sendMessage(from, { text: reply }, { quoted: msg });
        }
      } catch (err) {
        console.error(`[whatsapp] message handler error for ${email}:`, err);
      }
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getStatus(email: string): SessionStatus {
  return sessions.get(email)?.status ?? "disconnected";
}

export function getConnectedEmails(): string[] {
  return Array.from(sessions.entries())
    .filter(([, s]) => s.status === "connected")
    .map(([email]) => email);
}

export async function sendMessage(email: string, to: string, text: string): Promise<void> {
  const session = sessions.get(email);
  if (!session || session.status !== "connected") throw new Error("WhatsApp not connected for this user");
  // Normalise phone number → JID
  const jid = to.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
  await session.socket.sendMessage(jid, { text });
}

export async function disconnectSession(email: string, agentId: string, oauthUrl: string, oauthKey: string): Promise<void> {
  const session = sessions.get(email);
  if (session?.socket) {
    try { await session.socket.logout(); } catch { /* ignore */ }
  }
  sessions.delete(email);
  await deleteCreds(agentId, email, oauthUrl, oauthKey).catch(() => {});
}

// Called on server startup — silently reconnects all stored sessions
export async function initAllSessions(
  agentId: string,
  oauthUrl: string,
  oauthKey: string,
  mentionHandler: MentionHandler,
): Promise<void> {
  if (!agentId || !oauthUrl || !oauthKey) return;
  try {
    const res = await fetch(`${oauthUrl}/api/whatsapp/${agentId}`, {
      headers: { "x-api-key": oauthKey },
    });
    if (!res.ok) return;
    const { users } = await res.json() as { users: string[] };
    for (const email of users) {
      connectSession(email, agentId, oauthUrl, oauthKey, mentionHandler).catch((err) => {
        console.warn(`[whatsapp] failed to restore session for ${email}:`, err.message);
      });
    }
    if (users.length) console.log(`[whatsapp] restoring ${users.length} session(s)`);
  } catch (err) {
    console.warn("[whatsapp] initAllSessions failed (non-fatal):", (err as Error).message);
  }
}
