// WhatsApp session manager using Baileys (ESM — imported dynamically)
// Credentials persisted in Firestore via oauth-service.

type SessionStatus = "connecting" | "qr" | "connected" | "disconnected";

interface Session {
  socket: any;
  status: SessionStatus;
  qr?: string;
  qrListeners: Array<(qr: string) => void>;
  connectedListeners: Array<() => void>;
  reconnectAttempt: number;
}

// email → session
const sessions = new Map<string, Session>();


// ── Structured logger ─────────────────────────────────────────────────────────

function waLog(level: "info" | "warn" | "error", email: string, msg: string, extra?: object) {
  const entry = { level, tag: "whatsapp", user: email, msg, ...extra };
  if (level === "error") console.error(JSON.stringify(entry));
  else if (level === "warn") console.warn(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ── Firestore credential helpers ──────────────────────────────────────────────
// Use Baileys' own BufferJSON format so keys from libsignal round-trip correctly.
// Baileys uses { type:"Buffer", data:[...] } — never use a custom format here.

async function getBufferJSON() {
  const { BufferJSON } = await import("@whiskeysockets/baileys");
  return BufferJSON;
}

async function serialize(obj: any): Promise<string> {
  const { replacer } = await getBufferJSON();
  return JSON.stringify(obj, replacer);
}

async function deserialize(str: string): Promise<any> {
  const { reviver } = await getBufferJSON();
  return JSON.parse(str, (key, value) => {
    // Backwards-compat: handle old _type format saved before BufferJSON migration
    if (value && value._type === "Buffer" && Array.isArray(value.data)) {
      return Buffer.from(value.data);
    }
    return reviver(key, value);
  });
}

async function loadCreds(agentId: string, email: string, oauthUrl: string, oauthKey: string): Promise<{ creds: string; keys: string } | null> {
  try {
    const res = await fetch(`${oauthUrl}/api/whatsapp/${agentId}/${encodeURIComponent(email)}`, {
      headers: { "x-api-key": oauthKey },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data?.creds ? data : null;
  } catch (err) {
    waLog("error", email, "failed to load credentials from Firestore", { error: (err as Error).message });
    return null;
  }
}

async function saveCredsToFirestore(agentId: string, email: string, oauthUrl: string, oauthKey: string, data: { creds: string; keys: string }): Promise<void> {
  try {
    const res = await fetch(`${oauthUrl}/api/whatsapp/${agentId}/${encodeURIComponent(email)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-api-key": oauthKey },
      body: JSON.stringify(data),
    });
    if (!res.ok) waLog("warn", email, "credential save returned non-ok", { status: res.status });
  } catch (err) {
    waLog("error", email, "failed to save credentials to Firestore", { error: (err as Error).message });
  }
}

async function deleteCreds(agentId: string, email: string, oauthUrl: string, oauthKey: string): Promise<void> {
  try {
    await fetch(`${oauthUrl}/api/whatsapp/${agentId}/${encodeURIComponent(email)}`, {
      method: "DELETE",
      headers: { "x-api-key": oauthKey },
    });
  } catch (err) {
    waLog("warn", email, "failed to delete credentials from Firestore", { error: (err as Error).message });
  }
}

// ── Firestore-backed Baileys auth state ───────────────────────────────────────

async function makeAuthState(agentId: string, email: string, oauthUrl: string, oauthKey: string) {
  const { initAuthCreds } = await import("@whiskeysockets/baileys");
  const saved = await loadCreds(agentId, email, oauthUrl, oauthKey);

  if (saved?.creds) {
    waLog("info", email, "loaded existing credentials from Firestore");
  } else {
    waLog("info", email, "no saved credentials — generating fresh auth state");
  }

  // Use Baileys' BufferJSON for correct round-tripping of Curve25519 keys
  const creds: any = saved?.creds ? await deserialize(saved.creds) : initAuthCreds();
  const keyMap: Record<string, any> = saved?.keys ? await deserialize(saved.keys) : {};

  const persist = async () => {
    await saveCredsToFirestore(agentId, email, oauthUrl, oauthKey, {
      creds: await serialize(creds),
      keys: await serialize(keyMap),
    });
    waLog("info", email, "credentials persisted to Firestore", { keyCount: Object.keys(keyMap).length });
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const { reviver } = await getBufferJSON();
          const result: Record<string, any> = {};
          for (const id of ids) {
            const val = keyMap[`${type}-${id}`];
            if (val !== undefined) {
              // Deep-clone through JSON to restore any Buffer objects
              result[id] = JSON.parse(JSON.stringify(val, (await getBufferJSON()).replacer), reviver);
            }
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
    // Called on every creds.update event — mutates in place (matches Baileys' own pattern)
    onCredsUpdate: async (update: any) => {
      Object.assign(creds, update);
      await persist();
    },
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
  replyInDMs: true,
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
  const existing = sessions.get(email);
  if (existing) {
    if (existing.status === "connected") {
      waLog("info", email, "already connected — skipping duplicate connect");
      onConnected?.();
      return;
    }
    waLog("info", email, `session already ${existing.status} — attaching new listeners`);
    if (onQR) existing.qrListeners.push(onQR);
    if (onConnected) existing.connectedListeners.push(onConnected);
    if (existing.status === "qr" && existing.qr && onQR) onQR(existing.qr);
    return;
  }

  const session: Session = {
    socket: null,
    status: "connecting",
    qrListeners: onQR ? [onQR] : [],
    connectedListeners: onConnected ? [onConnected] : [],
    reconnectAttempt: 0,
  };
  sessions.set(email, session);
  waLog("info", email, "starting new Baileys session");

  try {
    const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = await import("@whiskeysockets/baileys");
    const { Boom } = await import("@hapi/boom");
    const fetched = await fetchLatestBaileysVersion();
    const version = fetched.version;
    waLog("info", email, "Baileys loaded", { version: version.join(".") });

    const auth = await makeAuthState(agentId, email, oauthUrl, oauthKey);

    waLog("info", email, "creating WASocket");
    const sock = makeWASocket({
      version,
      auth: auth.state,
      printQRInTerminal: false,
      browser: ["Boost Agent", "Chrome", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
      maxMsgRetryCount: 1,       // limit retry requests sent to senders on decrypt failure
      retryRequestDelayMs: 5000, // space out retries so the phone doesn't get spammed
      logger: {
        level: "warn",
        trace: (..._args: any[]) => {},
        debug: (..._args: any[]) => {},
        info:  (..._args: any[]) => {},
        warn:  (...args: any[]) => waLog("warn", email, "baileys-warn", { detail: args[0] }),
        error: (...args: any[]) => {
          waLog("error", email, "baileys-error", { detail: args[0] });
        },
        child: () => ({ trace: ()=>{}, debug: ()=>{}, info: ()=>{}, warn: ()=>{}, error: ()=>{}, fatal: ()=>{}, child: (): any => ({}) }),
        fatal: (...args: any[]) => waLog("error", email, "baileys-fatal", { detail: args[0] }),
      } as any,
    });

    session.socket = sock;
    waLog("info", email, "WASocket created — waiting for connection events");

    // Object.assign mutates creds in place — matches Baileys' useMultiFileAuthState pattern exactly
    sock.ev.on("creds.update", async (update: any) => {
      waLog("info", email, "credentials updated by Baileys — persisting");
      await auth.onCredsUpdate(update);
    });

    sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr, isNewLogin } = update;
      waLog("info", email, "connection.update", { connection: connection ?? "—", hasQR: !!qr, isNewLogin: !!isNewLogin });

      if (qr) {
        session.status = "qr";
        session.qr = qr;
        waLog("info", email, "QR code generated — sending to client");
        session.qrListeners.forEach((fn) => fn(qr));
      }

      if (connection === "open") {
        session.status = "connected";
        session.qr = undefined;
        session.reconnectAttempt = 0;
        waLog("info", email, "connected successfully", { jid: sock.user?.id });
        session.connectedListeners.forEach((fn) => fn());
        session.qrListeners = [];
        session.connectedListeners = [];
      }

      if (connection === "close") {
        const err = lastDisconnect?.error as InstanceType<typeof Boom> | undefined;
        const code = err?.output?.statusCode;
        const reason = err?.message ?? "unknown";
        const loggedOut = code === DisconnectReason.loggedOut;
        // Also treat 515 (restart required) and 408 (connection replaced) as recoverable
        const isCryptoError = reason?.includes("argument must be of type") || reason?.includes("Received an instance of");

        waLog(loggedOut ? "info" : "warn", email, "connection closed", {
          code, reason, loggedOut, isCryptoError, reconnectAttempt: session.reconnectAttempt,
        });

        // Preserve pending QR/connected listeners before deleting the session so
        // a 515 restart-required reconnect can still notify the SSE stream.
        const pendingQRListeners = [...session.qrListeners];
        const pendingConnectedListeners = [...session.connectedListeners];
        sessions.delete(email);

        if (loggedOut) {
          waLog("info", email, "user logged out from phone — clearing stored credentials");
          await deleteCreds(agentId, email, oauthUrl, oauthKey);
        } else if (isCryptoError) {
          // Saved credentials are corrupt — wipe them so next connect uses fresh QR
          waLog("warn", email, "crypto error on connect — wiping stored credentials, user must re-scan QR");
          await deleteCreds(agentId, email, oauthUrl, oauthKey);
        } else {
          const attempt = session.reconnectAttempt + 1;
          const backoff = Math.min(5000 * attempt, 60_000);
          waLog("info", email, `reconnecting in ${backoff / 1000}s (attempt ${attempt})`);
          const carryQR = pendingQRListeners.length ? (qr: string) => pendingQRListeners.forEach((fn) => fn(qr)) : undefined;
          const carryConnected = pendingConnectedListeners.length ? () => pendingConnectedListeners.forEach((fn) => fn()) : undefined;
          setTimeout(() => {
            connectSession(email, agentId, oauthUrl, oauthKey, mentionHandler, carryQR, carryConnected).catch((e) =>
              waLog("error", email, "reconnect failed", { error: e.message })
            );
          }, backoff);
        }
      }
    });

    // Track IDs of messages sent by this bot instance so we can skip them
    // when they echo back as fromMe messages, preventing reply loops.
    const sentByBot = new Set<string>();

    sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
      waLog("info", email, "messages.upsert fired", { type, count: messages?.length ?? 0 });
      if (type !== "notify") return;
      const myJid = sock.user?.id?.replace(/:.*@/, "@");

      for (const msg of messages) {
        if (msg.key.fromMe) {
          if (sentByBot.has(msg.key.id ?? "")) {
            sentByBot.delete(msg.key.id ?? "");
            continue; // bot's own reply echoed back — skip to prevent loop
          }
          // Message sent from user's phone (same account, different device) — process it
        }

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          "";

        if (!text) {
          const msgTypes = Object.keys(msg.message ?? {}).join(",");
          waLog("info", email, "skipping message with no text", { msgTypes, remoteJid: msg.key.remoteJid });
          continue;
        }

        const mentionedJids: string[] =
          msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];

        const isMentioned = !!(myJid && mentionedJids.some((j: string) =>
          j.replace(/:.*@/, "@") === myJid
        ));

        const from: string = msg.key.remoteJid ?? "";
        const isGroup = from.endsWith("@g.us");
        let groupName: string | undefined;
        const fromName = msg.pushName ?? from.split("@")[0];

        if (isGroup) {
          try {
            const meta = await sock.groupMetadata(from);
            groupName = meta.subject;
          } catch { /* no metadata */ }
        }

        waLog("info", email, "incoming message", {
          from,
          fromName,
          isGroup,
          groupName: groupName ?? null,
          isMentioned,
          myJid,
          mentionedJids,
          textLength: text.length,
        });

        try {
          const reply = await mentionHandler({ email, from, fromName, text, isGroup, groupName, isMentioned });
          if (reply) {
            waLog("info", email, "sending reply", { to: from, replyLength: reply.length });
            const sendTimeout = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("sendMessage timed out after 20s")), 20_000)
            );
            const sent: any = await Promise.race([sock.sendMessage(from, { text: reply }, { quoted: msg }), sendTimeout]);
            if (sent?.key?.id) sentByBot.add(sent.key.id);
            waLog("info", email, "reply sent successfully");
          } else {
            waLog("info", email, "handler returned null — no reply sent (trigger/filter did not match)");
          }
        } catch (err) {
          waLog("error", email, "message handler threw an error", { error: (err as Error).message, stack: (err as Error).stack });
        }
      }
    });

  } catch (err) {
    sessions.delete(email);
    waLog("error", email, "fatal error during session setup", {
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    throw err;
  }
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
  if (!session || session.status !== "connected") {
    waLog("warn", email, "sendMessage called but session not connected", { status: session?.status ?? "no session" });
    throw new Error("WhatsApp not connected for this user");
  }
  const jid = to.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
  waLog("info", email, "sending outbound message", { to: jid });
  await session.socket.sendMessage(jid, { text });
}

export async function disconnectSession(email: string, agentId: string, oauthUrl: string, oauthKey: string): Promise<void> {
  waLog("info", email, "disconnecting session by user request");
  const session = sessions.get(email);
  if (session?.socket) {
    try { await session.socket.logout(); } catch { /* ignore */ }
  }
  sessions.delete(email);
  await deleteCreds(agentId, email, oauthUrl, oauthKey);
  waLog("info", email, "session disconnected and credentials cleared");
}

export async function initAllSessions(
  agentId: string,
  oauthUrl: string,
  oauthKey: string,
  mentionHandler: MentionHandler,
): Promise<void> {
  if (!agentId || !oauthUrl || !oauthKey) {
    console.log(JSON.stringify({ tag: "whatsapp", msg: "initAllSessions skipped — missing config", agentId: !!agentId, oauthUrl: !!oauthUrl, oauthKey: !!oauthKey }));
    return;
  }
  try {
    const res = await fetch(`${oauthUrl}/api/whatsapp/${agentId}`, {
      headers: { "x-api-key": oauthKey },
    });
    if (!res.ok) {
      console.warn(JSON.stringify({ tag: "whatsapp", msg: "initAllSessions — oauth-service returned non-ok", status: res.status }));
      return;
    }
    const { users } = await res.json() as { users: string[] };
    console.log(JSON.stringify({ tag: "whatsapp", msg: `startup: restoring ${users.length} session(s)`, users }));
    for (const email of users) {
      connectSession(email, agentId, oauthUrl, oauthKey, mentionHandler).catch((err) =>
        waLog("error", email, "startup restore failed", { error: (err as Error).message })
      );
    }
  } catch (err) {
    console.warn(JSON.stringify({ tag: "whatsapp", msg: "initAllSessions failed (non-fatal)", error: (err as Error).message }));
  }
}
