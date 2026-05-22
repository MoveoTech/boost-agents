// WhatsApp session manager using Baileys (ESM — imported dynamically)
// Credentials persisted in Firestore via oauth-service.

// Suppress libsignal-protocol's verbose console.log output — it dumps full Signal
// session objects including private keys in plaintext, which is a security issue
// when logs are shipped to GCP Cloud Logging.
const _origConsoleLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const first = String(args[0] ?? "");
  if (
    first.startsWith("Closing session") ||
    first.startsWith("Closing open session") ||
    first.startsWith("Session error:") ||
    first.startsWith("No session for") ||
    first.startsWith("Failed to decrypt message")
  ) return;
  _origConsoleLog(...args);
};

// Eagerly start loading Baileys when this module is first imported.
// The ESM dynamic import of @whiskeysockets/baileys (a large native module) blocks
// the Node.js event loop for 3-5 minutes on a cold Cloud Run instance. Starting it
// at module load time means it's done by the time connectSession is called.
const _baileysPreload = Promise.all([
  import("@whiskeysockets/baileys"),
  import("@hapi/boom"),
]).then(() => getWaVersion()).catch(() => {}); // also pre-cache WA version

type SessionStatus = "connecting" | "qr" | "connected" | "disconnected";

interface Session {
  socket: any;
  status: SessionStatus;
  qr?: string;
  qrListeners: Array<(qr: string) => void>;
  connectedListeners: Array<() => void>;
  reconnectAttempt: number;
  connectedAt?: number;
  onEveryConnect?: () => void;
}

// email → session
const sessions = new Map<string, Session>();
// email → auth state (for external purge access)
const authRegistry = new Map<string, { purgeContactKeys: (frag: string) => number; deleteAllCreds: () => Promise<void>; freezeCredsSave: () => void }>();
// persistent reconnect attempt counter — survives session object recreation so backoff grows correctly
const reconnectAttempts = new Map<string, number>();
// consecutive crypto error counter — reset on successful connect
const cryptoRetryCount = new Map<string, number>();
// Latest message timestamp per conversation. Used to skip sending stale replies when
// a newer message arrived in the same conversation while we were still processing.
const latestMsgTsPerJid = new Map<string, number>();

// Cache the WhatsApp protocol version globally — fetchLatestBaileysVersion() makes a
// slow HTTPS request to WhatsApp servers that can hang for 3+ minutes in Cloud Run.
let cachedWaVersion: [number, number, number] | null = null;
const WA_VERSION_FALLBACK: [number, number, number] = [2, 3000, 1035194821];

async function getWaVersion(): Promise<[number, number, number]> {
  if (cachedWaVersion) return cachedWaVersion;
  try {
    const { fetchLatestBaileysVersion } = await import("@whiskeysockets/baileys");
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000)),
    ]);
    cachedWaVersion = result.version;
    console.log(JSON.stringify({ tag: "whatsapp", msg: "WA version fetched", version: cachedWaVersion!.join(".") }));
  } catch {
    cachedWaVersion = WA_VERSION_FALLBACK;
    console.log(JSON.stringify({ tag: "whatsapp", msg: "WA version fetch failed — using fallback", version: cachedWaVersion.join(".") }));
  }
  return cachedWaVersion;
}


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
  // Retry transient failures up to 3 times. 404 means creds genuinely don't exist (return null).
  // Network errors / 5xx are transient — throw so the caller doesn't overwrite real credentials
  // with a fresh set on a momentary blip.
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${oauthUrl}/api/whatsapp/${agentId}/${encodeURIComponent(email)}`, {
        headers: { "x-api-key": oauthKey },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        lastErr = new Error(`oauth-service ${res.status}`);
      } else {
        const data = await res.json() as any;
        return data?.creds ? data : null;
      }
    } catch (err) {
      lastErr = err as Error;
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  waLog("error", email, "loadCreds failed after 3 attempts — refusing to wipe credentials", { error: lastErr?.message });
  throw lastErr ?? new Error("loadCreds failed");
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

  let credsSaveEnabled = true;

  const persist = async () => {
    if (!credsSaveEnabled) return;
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
    // Purge all session keys for a specific contact JID fragment (e.g. "48460183113911")
    // Called when Bad MAC / MessageCounterError is detected to force fresh session establishment
    purgeContactKeys: (jidFragment: string): number => {
      const toDelete = Object.keys(keyMap).filter((k) => k.includes(jidFragment));
      toDelete.forEach((k) => delete keyMap[k]);
      if (toDelete.length > 0) persist().catch(() => {});
      return toDelete.length;
    },
    // Stop any further saves from this socket instance immediately — call on disconnect
    // to prevent the old socket's in-flight saves from corrupting the next session's creds.
    freezeCredsSave: () => { credsSaveEnabled = false; },
    // Wipe all credentials from Firestore and prevent further saves — called when the noise
    // session is irreparably corrupt after N retries.
    deleteAllCreds: async () => {
      credsSaveEnabled = false;
      await deleteCreds(agentId, email, oauthUrl, oauthKey);
    },
  };
}

// ── Core connect function ─────────────────────────────────────────────────────

export interface WhatsAppConfig {
  replyTrigger: "mention" | "keyword" | "always";
  keyword?: string;
  replyInGroups: boolean;
  replyInDMs: boolean;
  ownerOnly?: boolean;
  customPrompt?: string;
  model?: { provider: "gemini" | "claude" | "openai"; modelId: string };
}

export const DEFAULT_WA_CONFIG: WhatsAppConfig = {
  replyTrigger: "mention",
  replyInGroups: true,
  replyInDMs: true,
};

// Recent message buffer — keeps last 30 messages per JID for conversation context
const recentMsgBuffer = new Map<string, Array<{ from: string; text: string; ts: number }>>();
const RECENT_MSG_LIMIT = 30;

export function getRecentMessages(jid: string): Array<{ from: string; text: string; ts: number }> {
  // Return a snapshot (copy) so callers can't be affected by buffer mutations during async work.
  return [...(recentMsgBuffer.get(jid) ?? [])];
}

function storeRecentMessage(jid: string, from: string, text: string, ts: number) {
  const buf = recentMsgBuffer.get(jid) ?? [];
  buf.push({ from, text, ts });
  if (buf.length > RECENT_MSG_LIMIT) buf.shift();
  recentMsgBuffer.set(jid, buf);
}

// Image or PDF attached to an incoming WhatsApp message — passed to multimodal AI
export interface WhatsAppAttachment {
  data: string;     // base64
  mimeType: string; // e.g. "image/jpeg", "application/pdf"
}

// Handler receives full message context; returns reply text or null (= no reply)
export type MessageHandler = (params: {
  email: string;
  from: string;
  fromName: string;
  text: string;
  isGroup: boolean;
  groupName?: string;
  isMentioned: boolean;
  fromMe: boolean;
  recentMessages: Array<{ from: string; text: string; ts: number }>;
  attachment?: WhatsAppAttachment;   // binary attachment for vision (image / PDF)
  attachmentText?: string;            // extracted text from docx / txt / csv etc.
  attachmentName?: string;            // original filename if available
  attachmentError?: string;
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
  onEveryConnect?: () => void,
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
    if (onEveryConnect) existing.onEveryConnect = onEveryConnect;
    if (existing.status === "qr" && existing.qr && onQR) onQR(existing.qr);
    return;
  }

  const session: Session = {
    socket: null,
    status: "connecting",
    qrListeners: onQR ? [onQR] : [],
    connectedListeners: onConnected ? [onConnected] : [],
    reconnectAttempt: 0,
    onEveryConnect,
  };
  sessions.set(email, session);
  waLog("info", email, "starting new Baileys session");

  try {
    await _baileysPreload; // ensure preload is complete before proceeding
    const { default: makeWASocket, DisconnectReason } = await import("@whiskeysockets/baileys");
    const { Boom } = await import("@hapi/boom");
    const version = await getWaVersion();
    waLog("info", email, "Baileys loaded", { version: version.join(".") });

    // Early creds check: if no saved credentials AND no UI listener for QR, bail out.
    // This prevents an "abandoned" session from spinning up a QR loop nobody will scan,
    // which would otherwise hog the event loop with crypto work and slow other users' sessions.
    let savedCreds: { creds: string; keys: string } | null;
    try {
      savedCreds = await loadCreds(agentId, email, oauthUrl, oauthKey);
    } catch (err) {
      waLog("warn", email, "deferring session — could not load credentials", { error: (err as Error).message });
      sessions.delete(email);
      return;
    }
    if (!savedCreds && !onQR) {
      waLog("info", email, "no saved credentials and no QR listener — session disconnected, user must reconnect via UI");
      sessions.delete(email);
      return;
    }

    const auth = await makeAuthState(agentId, email, oauthUrl, oauthKey);
    authRegistry.set(email, { purgeContactKeys: auth.purgeContactKeys, deleteAllCreds: auth.deleteAllCreds, freezeCredsSave: auth.freezeCredsSave });

    waLog("info", email, "creating WASocket");
    const sock = makeWASocket({
      version,
      auth: auth.state,
      printQRInTerminal: false,
      browser: ["Chrome", "Chrome", "120.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
      keepAliveIntervalMs: 20_000,    // ping WhatsApp every 20s to prevent 408 connection-lost drops
      defaultQueryTimeoutMs: 120_000, // give WhatsApp 2min to respond to fetchProps on init (default 60s too tight)
      maxMsgRetryCount: 5,            // allow up to 5 retries to re-establish Signal session with sender
      retryRequestDelayMs: 2000, // 2s between retries — fast enough to recover within ~10s
      logger: {
        level: "warn",
        trace: (..._args: any[]) => {},
        debug: (..._args: any[]) => {},
        info:  (..._args: any[]) => {},
        warn:  (...args: any[]) => waLog("warn", email, "baileys-warn", { detail: args[0] }),
        error: (...args: any[]) => {
          const detail = args[0] ?? {};
          // fetchProps / executeInitQueries timing out is a known Baileys background
          // query that WhatsApp sometimes doesn't answer. It doesn't affect messaging.
          const stack: string = detail?.err?.data?.stack ?? detail?.trace ?? "";
          // Suppress Baileys-internal background timeouts — any "Timed Out" that only has
          // Baileys frames (no /app/src/ frame) is a non-actionable background operation.
          if (stack.includes("fetchProps") || stack.includes("executeInitQueries")) return;
          if (stack.includes("Timed Out") && !stack.includes("/app/src/")) return;
          waLog("error", email, "baileys-error", { detail });
          // Auto-purge corrupted Signal session keys when decryption fails.
          // Baileys calls logger.error({ key, err }, 'message') on decrypt failure.
          // We purge at any point (connecting or connected) — corrupted keys are
          // useless regardless of phase, and purging them lets Baileys re-establish
          // a fresh Signal session with the peer on the next retry.
          const errMsg: string = detail?.err?.message ?? detail?.message ?? (typeof detail === "string" ? detail : "");
          const errName: string = detail?.err?.name ?? "";
          const isDecryptError = errMsg.includes("Bad MAC") || errMsg.includes("MessageCounterError") || errMsg.includes("Key used already") || errName === "SessionError";
          if (!isDecryptError) return;

          // Skip auto-purge for outgoing message copies (fromMe: true).
          // These are sender-sync copies delivered to the linked device — a decrypt failure
          // here means the sender session hasn't been established, not that our receiver keys
          // are corrupt. Purging receiver keys for this JID would break incoming messages.
          if (detail?.key?.fromMe) {
            waLog("warn", email, "decrypt error on outgoing copy — skipping purge", { remoteJid: detail?.key?.remoteJid, errName });
            return;
          }

          const participant: string = detail?.key?.participant ?? detail?.key?.remoteJid ?? "";
          if (participant) {
            const jidFragment = participant.split(":")[0].split("@")[0];
            const purged = auth.purgeContactKeys(jidFragment);
            waLog("warn", email, "auto-purge triggered", { participant, purgedKeys: purged, errMsg });
          } else {
            const purged = auth.purgeContactKeys("session-");
            waLog("warn", email, "auto-purge (no participant) — purged all session keys", { purgedKeys: purged, errMsg });
          }
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
        session.connectedAt = Date.now();
        reconnectAttempts.delete(email); // reset persistent backoff counter on successful connect
        cryptoRetryCount.delete(email);  // reset crypto retry counter
        waLog("info", email, "connected successfully", { jid: sock.user?.id });
        session.connectedListeners.forEach((fn) => fn());
        session.qrListeners = [];
        session.connectedListeners = [];
        session.onEveryConnect?.(); // prewarm caches on every connect, including reconnects
      }

      if (connection === "close") {
        // Immediately stop the old socket from saving credentials — prevents race-condition
        // corruption where in-flight saves overwrite fresh credentials on the new session.
        auth.freezeCredsSave();

        const err = lastDisconnect?.error as InstanceType<typeof Boom> | undefined;
        const code = err?.output?.statusCode;
        const reason = err?.message ?? "unknown";
        const loggedOut = code === DisconnectReason.loggedOut;
        // Also treat 515 (restart required) and 408 (connection replaced) as recoverable
        const isCryptoError = reason?.includes("argument must be of type") || reason?.includes("Received an instance of") || reason?.includes("Unsupported state or unable to authenticate data");

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
        } else if (reason?.includes("QR refs attempts ended") || reason?.includes("QR timeout")) {
          // QR was generated but nobody scanned it — stop reconnecting to avoid an
          // infinite QR loop. User must reconnect explicitly via the settings UI.
          waLog("info", email, "QR scan timed out — stopping reconnect loop, user must reconnect via settings");
        } else {
          const attempt = (reconnectAttempts.get(email) ?? 0) + 1;
          reconnectAttempts.set(email, attempt);
          // After 10 failed attempts, give up — the session is degraded and continuing to
          // retry hogs the Node.js event loop with crypto work, slowing OTHER users' sessions.
          if (attempt > 10) {
            waLog("warn", email, `giving up reconnect after ${attempt - 1} attempts — session degraded, user must reconnect via settings`);
            reconnectAttempts.delete(email);
            return;
          }
          const backoff = Math.min(5000 * attempt, 60_000);
          waLog("info", email, `reconnecting in ${backoff / 1000}s (attempt ${attempt})`);
          const carryQR = pendingQRListeners.length ? (qr: string) => pendingQRListeners.forEach((fn) => fn(qr)) : undefined;
          const carryConnected = pendingConnectedListeners.length ? () => pendingConnectedListeners.forEach((fn) => fn()) : undefined;
          const carryEveryConnect = session.onEveryConnect;
          setTimeout(() => {
            connectSession(email, agentId, oauthUrl, oauthKey, mentionHandler, carryQR, carryConnected, carryEveryConnect).catch((e) =>
              waLog("error", email, "reconnect failed", { error: e.message })
            );
          }, backoff);
        }
      }
    });

    // Track IDs of messages sent by this bot instance to prevent reply loops.
    const sentByBot = new Set<string>();
    // Track processed message IDs to prevent duplicate processing when WhatsApp
    // delivers the same message under multiple JID formats (e.g. @s.whatsapp.net + @lid).
    const processedMsgIds = new Set<string>();

    sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
      waLog("info", email, "messages.upsert fired", { type, count: messages?.length ?? 0 });
      // Process both "notify" (real-time) and "append" (retry/late delivery). Baileys
      // routes some legitimate fresh messages as "append" after reconnects or Signal
      // session re-establishments. Genuinely stale messages are filtered downstream by
      // the timestamp checks (ageMsec > 5min + msgTs < connectedAt - 5s).
      if (type !== "notify" && type !== "append") return;
      const myJid = sock.user?.id?.replace(/:.*@/, "@");

      for (const msg of messages) {
        // Deduplicate: same message can arrive from multiple JID formats simultaneously.
        // We only mark as processed AFTER confirming text exists — if decryption fails
        // (empty message), don't block future retries once the Signal session establishes.
        const msgId = msg.key.id ?? "";
        if (msgId && processedMsgIds.has(msgId)) {
          waLog("info", email, "skipping duplicate message", { id: msgId });
          continue;
        }

        // Skip any message older than 60 seconds.
        // Use Number() to coerce protobuf Long objects — casting as number gives NaN,
        // which makes the age check always pass (NaN > 60_000 = false).
        const msgTs = Number(msg.messageTimestamp ?? 0) * 1000;
        if (!msgTs || isNaN(msgTs)) {
          // No parseable timestamp — skip, can't determine if fresh or historical.
          waLog("info", email, "skipping message with no timestamp", { id: msgId });
          continue;
        }
        const ageMsec = Date.now() - msgTs;
        // 5min absolute cap — filters truly old messages regardless of session state.
        if (ageMsec > 5 * 60_000) {
          waLog("info", email, "skipping stale message", { sentMsAgo: ageMsec });
          continue;
        }
        // Also skip messages sent BEFORE this session connected. After a server restart
        // or reconnect, WhatsApp redelivers recent messages as type:"notify" — without
        // this gate the agent would reply to messages the user sent before we were online.
        const connectedAt = session.connectedAt ?? 0;
        if (connectedAt && msgTs < connectedAt - 5_000) {
          waLog("info", email, "skipping pre-connect message", { sentMsAgo: ageMsec, msBeforeConnect: connectedAt - msgTs });
          continue;
        }

        if (msg.key.fromMe) {
          if (sentByBot.has(msgId)) {
            sentByBot.delete(msgId);
            continue; // bot's own reply echoed back — skip to prevent loop
          }
          // Message sent from user's phone (same account, different device) — process it
        }

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.documentMessage?.caption ||
          "";

        // Defensive: if a fromMe message starts with our bot prefix, it's the bot's own
        // reply echoing back. sentByBot tracks msgIds but msgIds sometimes differ between
        // the sent message and the echo. Skip on prefix match to prevent self-processing loops.
        if (msg.key.fromMe && text.startsWith("🤖")) {
          waLog("info", email, "skipping bot's own reply echo", { textPreview: text.slice(0, 40) });
          continue;
        }

        if (!text) {
          // Don't mark as processed — allow WhatsApp's retry to succeed once session establishes
          const msgTypes = Object.keys(msg.message ?? {}).join(",");
          waLog("info", email, "skipping message with no text", { msgTypes, remoteJid: msg.key.remoteJid });
          continue;
        }

        // Text confirmed — mark processed now to prevent duplicate handling.
        // Cap at 5000 entries and evict oldest 1000 to prevent unbounded growth.
        if (msgId) {
          processedMsgIds.add(msgId);
          if (processedMsgIds.size > 5000) {
            const evict = [...processedMsgIds].slice(0, 1000);
            evict.forEach((id) => processedMsgIds.delete(id));
          }
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

        // Store in buffer BEFORE logging so the current message is included in context
        const storageTs = msgTs || Date.now();
        storeRecentMessage(from, fromName, text, storageTs);
        const recentMessages = getRecentMessages(from);

        // Track this as the latest message in the conversation. If a newer message arrives
        // (in a separate concurrent handler) during this one's processing, we'll skip sending
        // this reply since it's been superseded by the newer message.
        const prevLatest = latestMsgTsPerJid.get(from) ?? 0;
        if (msgTs > prevLatest) latestMsgTsPerJid.set(from, msgTs);

        waLog("info", email, "incoming message", {
          from,
          fromName,
          isGroup,
          groupName: groupName ?? null,
          isMentioned,
          myJid,
          text,
          mentionedJids,
          textLength: text.length,
        });

        // Detect and download attached image or document. Capped at 10MB.
        // Looks at both direct attachments AND attachments inside the message the user
        // is replying to (quoted message) — so "boost analyze this" as a reply works.
        let attachment: WhatsAppAttachment | undefined;
        let attachmentText: string | undefined;
        let attachmentName: string | undefined;
        let attachmentError: string | undefined;
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const imageMsg = msg.message?.imageMessage ?? quoted?.imageMessage;
        const docMsg = msg.message?.documentMessage ?? quoted?.documentMessage;
        const mediaMsg = imageMsg || docMsg;
        const isQuoted = !msg.message?.imageMessage && !msg.message?.documentMessage && !!mediaMsg;
        if (mediaMsg) {
          const fileLength = Number(mediaMsg.fileLength ?? 0);
          const MAX_BYTES = 10 * 1024 * 1024;
          const mimetype = (mediaMsg.mimetype || (imageMsg ? "image/jpeg" : "application/octet-stream")) as string;
          attachmentName = (docMsg as { fileName?: string } | undefined)?.fileName;
          // Supported document types: PDF (native), docx (extract text), doc (extract text),
          // plain text / csv / markdown / json / html (read as text).
          const isPdf = mimetype === "application/pdf";
          const isDocx = mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          const isDoc = mimetype === "application/msword";
          const isTextish = mimetype.startsWith("text/") || mimetype === "application/json" || mimetype === "application/xml";
          const supportedDoc = isPdf || isDocx || isDoc || isTextish;

          if (fileLength > MAX_BYTES) {
            attachmentError = `File too large (${Math.round(fileLength / 1024 / 1024)}MB). Max is 10MB.`;
            waLog("info", email, "attachment too large", { fileLength, mimetype, quoted: isQuoted });
          } else if (docMsg && !supportedDoc) {
            attachmentError = `File type ${mimetype} is not supported. Try PDF, Word, or a plain-text file.`;
            waLog("info", email, "unsupported document type", { mimetype, quoted: isQuoted });
          } else {
            try {
              const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
              // For quoted media we synthesize a tiny pseudo-message so downloadMediaMessage
              // resolves the media keys against the quoted payload, not the wrapper message.
              const target = isQuoted
                ? { key: msg.key, message: quoted } as typeof msg
                : msg;
              // Hard timeout — downloadMediaMessage can hang indefinitely for quoted media
              // when key resolution fails. Without this, the entire handler stalls.
              const downloadTimeoutMs = 30_000;
              const buffer = await Promise.race([
                downloadMediaMessage(target, "buffer", {}) as Promise<Buffer>,
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`attachment download timed out after ${downloadTimeoutMs / 1000}s`)), downloadTimeoutMs)
                ),
              ]);

              if (imageMsg || isPdf) {
                // Pass binary to multimodal AI directly.
                attachment = { data: buffer.toString("base64"), mimeType: mimetype };
              } else if (isDocx || isDoc) {
                // Extract text from Word docs via mammoth. Wrap in timeout to avoid hangs
                // on malformed docs.
                const mammoth = await import("mammoth");
                const result = await Promise.race([
                  mammoth.extractRawText({ buffer }),
                  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("docx extraction timed out")), 15_000)),
                ]);
                attachmentText = result.value;
              } else if (isTextish) {
                // Plain text — decode as UTF-8.
                attachmentText = buffer.toString("utf-8");
              }
              // Cap extracted text at ~100k chars (~25k tokens) to avoid context blowup.
              if (attachmentText && attachmentText.length > 100_000) {
                attachmentText = attachmentText.slice(0, 100_000) + "\n\n[...truncated]";
              }
              waLog("info", email, "attachment downloaded", { mimetype, sizeBytes: buffer.length, quoted: isQuoted, asText: !!attachmentText, textLen: attachmentText?.length });
            } catch (err) {
              attachmentError = "Couldn't download or parse the attachment. Please try sending it again.";
              waLog("warn", email, "attachment download failed", { error: (err as Error).message, mimetype, quoted: isQuoted });
            }
          }
        }

        try {
          const t0 = Date.now();
          // Detect "own message" robustly: msg.key.fromMe is unreliable in groups because
          // the participant field uses the account's LID (anonymized) rather than its phone
          // JID, and Baileys doesn't always match them. Fallback to comparing the participant
          // (and remoteJid for DMs) against the bot's own phone-number and LID.
          const userObj = sock.user as { id?: string; lid?: string } | undefined;
          const myPhoneKey = userObj?.id?.split(":")[0].split("@")[0] ?? "";
          const myLidKey = userObj?.lid?.split(":")[0].split("@")[0] ?? "";
          const participant = (msg.key.participant ?? msg.key.remoteJid ?? "") as string;
          const participantKey = participant.split(":")[0].split("@")[0];
          const fromMe = !!msg.key.fromMe ||
            (!!myPhoneKey && participantKey === myPhoneKey) ||
            (!!myLidKey && participantKey === myLidKey);
          if (!msg.key.fromMe && fromMe) {
            waLog("info", email, "identified own message via participant match", { participantKey, myPhoneKey, myLidKey });
          }
          const reply = await mentionHandler({ email, from, fromName, text, isGroup, groupName, isMentioned, fromMe, recentMessages, attachment, attachmentText, attachmentName, attachmentError });
          waLog("info", email, "timing: handler total", { ms: Date.now() - t0 });
          if (reply) {
            // If a newer message has arrived in this conversation while we were processing,
            // skip this stale reply — only the latest message gets answered.
            const latestNow = latestMsgTsPerJid.get(from) ?? 0;
            if (msgTs < latestNow) {
              waLog("info", email, "skipping stale reply — newer message arrived during processing", { msgTs, latest: latestNow, ageMs: latestNow - msgTs });
            } else if (sessions.get(email)?.status !== "connected") {
              waLog("warn", email, "session no longer connected — dropping reply", { to: from });
            } else {
              waLog("info", email, "sending reply", { to: from, replyLength: reply.length });
              const isLid = from.endsWith("@lid");
              const timeoutMs = (isGroup || isLid) ? 60_000 : 20_000;
              const sendTimeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`sendMessage timed out after ${timeoutMs / 1000}s`)), timeoutMs)
              );
              const currentSock = sessions.get(email)?.socket ?? sock;
              const sent: any = await Promise.race([currentSock.sendMessage(from, { text: reply }, { quoted: msg }), sendTimeout]);
              if (sent?.key?.id) {
                sentByBot.add(sent.key.id);
                // Auto-expire after 30s — echo-back arrives within ms; stale IDs block future replies
                setTimeout(() => sentByBot.delete(sent.key.id), 30_000);
              }
              storeRecentMessage(from, "Assistant", reply, Date.now());
              waLog("info", email, "reply sent successfully");
            }
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

// Called from global unhandledRejection handler when a native crypto error fires
// during session setup. Closes the socket so connection.update schedules a reconnect
// with the SAME credentials — the phone still has the linked device, so credentials
// are valid on WhatsApp's server. Never wipes credentials here; only a 401 logout
// from WhatsApp should cause a credential wipe.
export function purgeConnectingSessionKeys(): void {
  for (const [email, session] of sessions.entries()) {
    if (session.status === "connecting") {
      const attempt = (cryptoRetryCount.get(email) ?? 0) + 1;
      cryptoRetryCount.set(email, attempt);
      sessions.delete(email); // prevent duplicate calls on rapid re-fire
      waLog("warn", email, `native crypto error during connect (attempt ${attempt}) — closing socket, will retry with existing credentials`);
      try { session.socket?.end?.(); } catch {}
    }
  }
}

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
  onSessionConnected?: (email: string) => void,
  onSessionEveryConnect?: (email: string) => void,
): Promise<void> {
  if (!agentId || !oauthUrl || !oauthKey) {
    console.log(JSON.stringify({ tag: "whatsapp", msg: "initAllSessions skipped — missing config", agentId: !!agentId, oauthUrl: !!oauthUrl, oauthKey: !!oauthKey }));
    return;
  }
  // Retry up to 5 times with exponential backoff — the oauth-service may be cold-starting
  for (let attempt = 1; attempt <= 5; attempt++) {
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
        const onConnected = onSessionConnected ? () => onSessionConnected(email) : undefined;
        const onEveryConnect = onSessionEveryConnect ? () => onSessionEveryConnect(email) : undefined;
        connectSession(email, agentId, oauthUrl, oauthKey, mentionHandler, undefined, onConnected, onEveryConnect).catch((err) =>
          waLog("error", email, "startup restore failed", { error: (err as Error).message })
        );
      }
      return;
    } catch (err) {
      const delay = attempt * 5_000;
      console.warn(JSON.stringify({ tag: "whatsapp", msg: `initAllSessions attempt ${attempt} failed — retrying in ${delay / 1000}s`, error: (err as Error).message }));
      if (attempt < 5) await new Promise((r) => setTimeout(r, delay));
    }
  }
  console.warn(JSON.stringify({ tag: "whatsapp", msg: "initAllSessions gave up after 5 attempts" }));
}
