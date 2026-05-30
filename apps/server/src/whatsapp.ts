// WhatsApp session manager using Baileys (ESM — imported dynamically)
// Credentials persisted in Firestore via oauth-service.

// Suppress libsignal-protocol's verbose console.log output — it dumps full Signal
// session objects including private keys in plaintext, which is a security issue
// when logs are shipped to GCP Cloud Logging.
const _origConsoleLog = console.log.bind(console);
const _origConsoleError = console.error.bind(console);
const _suppressLibsignalOutput = (...args: unknown[]) => {
  const first = String(args[0] ?? "");
  return (
    first.startsWith("Closing session") ||
    first.startsWith("Closing open session") ||
    first.startsWith("Session error:") ||
    first.startsWith("No session for") ||
    first.startsWith("Failed to decrypt message")
  );
};
console.log = (...args: unknown[]) => {
  if (_suppressLibsignalOutput(...args)) return;
  _origConsoleLog(...args);
};
console.error = (...args: unknown[]) => {
  if (_suppressLibsignalOutput(...args)) return;
  _origConsoleError(...args);
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
const authRegistry = new Map<string, { purgeContactKeys: (frag: string) => number; deleteAllCreds: () => Promise<void>; flushAndFreeze: () => Promise<void>; addProcessedId: (id: string) => void }>();
// persistent reconnect attempt counter — survives session object recreation so backoff grows correctly
const reconnectAttempts = new Map<string, number>();
// consecutive crypto error counter — reset on successful connect
const cryptoRetryCount = new Map<string, number>();
// tracks how many times we've seen loggedOut (401) for an email — retry once before deleting creds
const loggedOutRetries = new Map<string, number>();
// decrypt error rate limiter: email → { count, windowStart }
// if count exceeds threshold within window, we force-close the socket to break the error loop
const decryptErrorRate = new Map<string, { count: number; windowStart: number }>();
// per-contact consecutive decrypt failures: `${email}::${jidFragment}` → count
// reset on successful decryption from that contact; triggers resetKeys() at threshold
const contactDecryptFailures = new Map<string, number>();
// contacts that had keys purged recently: `${email}::${jidFragment}` → purge timestamp
// used to trigger immediate resetKeys() on first "No session record" after a purge
const recentlyPurgedContacts = new Map<string, number>();
// last time resetKeys() was triggered due to "purged=0 + PreKeyError" — prevents tight loop
// when WhatsApp replays queued messages encrypted with stale PreKeys after a key reset
const lastZeroPurgeReset = new Map<string, number>();
// email → Set of processed msgIds. Module-level so dedup survives reconnects within the same
// Cloud Run instance. WhatsApp re-delivers messages that weren't ACK'd before a disconnect;
// without this, a fast reconnect (< 5s) creates a fresh per-session Set that allows reprocessing
// the same message → double reply.
const processedMsgIdsByEmail = new Map<string, Set<string>>();

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

// Watchdog: detect zombie connections where the socket reports "connected" but the
// underlying WebSocket is actually closed (silent TCP drop). Runs every 90s.
// Forces end() on the dead socket so connection.update triggers a fresh reconnect.
setInterval(() => {
  for (const [email, session] of sessions) {
    if (session.status !== "connected") continue;
    const wsState = (session.socket?.ws as { readyState?: number } | undefined)?.readyState;
    if (wsState === undefined) continue;
    if (wsState !== 1 /* WebSocket.OPEN */) {
      waLog("warn", email, "watchdog: zombie socket detected — forcing reconnect", { wsReadyState: wsState });
      try { session.socket?.end?.(new Error("watchdog-reset")); } catch {}
    }
  }
}, 90_000);

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

async function loadCreds(agentId: string, email: string, oauthUrl: string, oauthKey: string): Promise<{ creds: string; keys: string; processedIds?: string } | null> {
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

async function saveCredsToFirestore(agentId: string, email: string, oauthUrl: string, oauthKey: string, data: { creds: string; keys: string; processedIds?: string }): Promise<void> {
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
  // Persisted processed message IDs — survives deploys so WhatsApp retry re-deliveries
  // (which arrive with a fresh timestamp) don't cause double-replies after a redeploy.
  // Keep last 1000 IDs (each ~20 chars → ~20KB max). Pruned on every save.
  const persistedMsgIds = new Set<string>(
    saved?.processedIds ? (JSON.parse(saved.processedIds) as string[]) : []
  );

  let credsSaveEnabled = true;
  let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const doSave = async () => {
    if (!credsSaveEnabled) return;
    // Prune to last 1000 IDs before saving
    const idsToSave = [...persistedMsgIds].slice(-1000);
    await saveCredsToFirestore(agentId, email, oauthUrl, oauthKey, {
      creds: await serialize(creds),
      keys: await serialize(keyMap),
      processedIds: JSON.stringify(idsToSave),
    });
    waLog("info", email, "credentials persisted to Firestore", { keyCount: Object.keys(keyMap).length, processedIdCount: idsToSave.length });
  };

  // Immediate save — used for account credential changes (creds.update).
  const persistNow = async () => {
    if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
    await doSave();
  };

  // Debounced save — used for Signal key changes (keys.set fires on every ratchet advance).
  // Signal session keys can tolerate being ~30s stale on crash — Baileys retries decryption
  // automatically (maxMsgRetryCount: 3). Account creds (creds.update) still save immediately.
  const persist = () => {
    if (!credsSaveEnabled) return;
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => {
      saveDebounceTimer = null;
      doSave().catch(() => {});
    }, 30_000);
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
          persist(); // debounced — batches rapid key updates from group participants
        },
      },
    },
    // Called on every creds.update event — save immediately (these are account credentials)
    onCredsUpdate: async (update: any) => {
      Object.assign(creds, update);
      await persistNow();
    },
    // Purge all session keys for a specific contact JID fragment (e.g. "48460183113911")
    // Called when Bad MAC / MessageCounterError is detected to force fresh session establishment
    purgeContactKeys: (jidFragment: string): number => {
      const toDelete = Object.keys(keyMap).filter((k) => k.includes(jidFragment));
      toDelete.forEach((k) => delete keyMap[k]);
      if (toDelete.length > 0) persist();
      return toDelete.length;
    },
    // Flush any pending debounced key save, then stop further saves. Call on disconnect:
    // first flush so the new session starts with up-to-date Signal keys, then freeze so
    // the old socket's in-flight saves can't race-corrupt the new session's creds.
    flushAndFreeze: async () => {
      if (saveDebounceTimer) {
        clearTimeout(saveDebounceTimer);
        saveDebounceTimer = null;
        if (credsSaveEnabled) await doSave().catch(() => {});
      }
      credsSaveEnabled = false;
    },
    // Wipe all credentials from Firestore and prevent further saves — called when the noise
    // session is irreparably corrupt after N retries.
    deleteAllCreds: async () => {
      credsSaveEnabled = false;
      await deleteCreds(agentId, email, oauthUrl, oauthKey);
    },
    // Wipe only Signal session keys from Firestore, preserving account credentials (creds)
    // and app-state-sync keys. Used on crypto errors during reconnect: the linked device
    // pairing is still valid on the phone, but the local Signal ratchet state is stale.
    // IMPORTANT: app-state-sync-* keys must NOT be wiped — WhatsApp uses them to verify
    // the linked device's identity. Wiping them causes a 401 loggedOut on next connect.
    resetKeys: async () => {
      if (saveDebounceTimer) { clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
      for (const k of Object.keys(keyMap)) {
        // Keep app-state-sync (prevents 401 loggedOut) and pre-keys (needed for new session establishment).
        // Only wipe session state — the actual stale Signal ratchet state per contact.
        if (!k.startsWith("app-state-sync-") && !k.startsWith("pre-key") && !k.startsWith("signed-pre-key")) delete keyMap[k];
      }
      const idsToSave = [...persistedMsgIds].slice(-1000);
      await saveCredsToFirestore(agentId, email, oauthUrl, oauthKey, {
        creds: await serialize(creds),
        keys: await serialize(keyMap),
        processedIds: JSON.stringify(idsToSave),
      });
    },
    // Expose persisted IDs set so connectSession can seed the in-memory dedup Set
    persistedMsgIds,
    // Add a message ID to the persisted set and debounce-save to Firestore
    addProcessedId: (id: string) => {
      persistedMsgIds.add(id);
      persist();
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
  replyTrigger: "keyword",
  replyInGroups: true,
  replyInDMs: true,
  ownerOnly: true,
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
      waLog("warn", email, "could not load credentials (transient) — retrying in 30s", { error: (err as Error).message });
      sessions.delete(email);
      const carryEveryConnect2 = onEveryConnect;
      setTimeout(() => {
        connectSession(email, agentId, oauthUrl, oauthKey, mentionHandler, undefined, undefined, carryEveryConnect2).catch(() => {});
      }, 30_000);
      return;
    }
    if (!savedCreds && !onQR) {
      waLog("info", email, "no saved credentials and no QR listener — session disconnected, user must reconnect via UI");
      sessions.delete(email);
      return;
    }

    const auth = await makeAuthState(agentId, email, oauthUrl, oauthKey);
    authRegistry.set(email, { purgeContactKeys: auth.purgeContactKeys, deleteAllCreds: auth.deleteAllCreds, flushAndFreeze: auth.flushAndFreeze, addProcessedId: auth.addProcessedId });

    // Per-socket message store — Baileys calls getMessage when it needs to retry-decrypt
    // a failed message (Signal retries are very common). Returning undefined makes every
    // retry fail, which feeds the Bad MAC / SessionError cycle. Storing the last 300
    // messages gives Baileys enough material to re-establish sessions without using disk.
    const socketMsgStore = new Map<string, any>();
    const SOCKET_MSG_STORE_MAX = 300;
    // 90s lookback: covers crypto-retry delay (~20s) + deploy startup (~26s) + buffer, so
    // messages sent while the bot was reconnecting are not silently dropped.
    // Re-deliveries with fresh timestamps (Bad MAC retry receipts) are deduped by the
    // persisted processedMsgIds set, so the lookback no longer risks answering old messages.
    const sessionCreatedAt = Date.now() - 90_000;

    // Per-socket group metadata cache — groupMetadata() makes a network request and
    // WhatsApp rate-limits it. Cache for 5 minutes to avoid hitting that limit.
    const groupMetaCache = new Map<string, { subject: string; ts: number }>();
    const GROUP_META_TTL_MS = 5 * 60_000;

    waLog("info", email, "creating WASocket");
    const sock = makeWASocket({
      version,
      auth: auth.state,
      printQRInTerminal: false,
      browser: ["Ubuntu", "Chrome", "22.04.4"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      // Return stored messages so Baileys can retry-decrypt Signal failures instead of giving up
      getMessage: async (key) => socketMsgStore.get(key.id ?? "") ?? undefined,
      // Wire our group metadata cache into Baileys so it uses it internally (retry logic,
      // participant lookups during decrypt) instead of making cold network requests.
      cachedGroupMetadata: async (jid: string) => {
        const cached = groupMetaCache.get(jid);
        if (cached && Date.now() - cached.ts < GROUP_META_TTL_MS) return { subject: cached.subject } as any;
        return undefined;
      },
      // Never process history messages — we only want real-time messages
      shouldSyncHistoryMessage: () => false,
      keepAliveIntervalMs: 20_000,    // ping WhatsApp every 20s to prevent 408 connection-lost drops
      defaultQueryTimeoutMs: 120_000, // give WhatsApp 2min to respond to fetchProps on init (default 60s too tight)
      maxMsgRetryCount: 3,            // Allow up to 3 retries per message so Baileys can request sender key redistribution
                                      // after reconnect. Without retries, group messages fail to decrypt permanently until
                                      // the sender naturally sends a new message with a fresh key distribution.
                                      // The original MessageCounterError flood was a Noise protocol issue, not Signal retries.
      retryRequestDelayMs: 3000,
      logger: {
        level: "warn",
        trace: (..._args: any[]) => {},
        debug: (..._args: any[]) => {},
        info:  (...args: any[]) => {
          // Log retry receipts — these are the silent signal that a message failed to decrypt.
          // Without this, decrypt failures produce only a creds.update flood with no explanation.
          if (args[1] === "sent retry receipt") waLog("warn", email, "wa-decrypt-retry", typeof args[0] === "object" ? args[0] : {});
        },
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
          const isDecryptError = errMsg.includes("Bad MAC") || errMsg.includes("MessageCounterError") || errMsg.includes("Key used already") || errName === "SessionError" || errName === "PreKeyError";
          if (!isDecryptError) return;

          // "No session record" / "No matching sessions found" = no Signal session for this contact.
          // Expected after fresh QR scan (old pending messages), but also happens after a key purge
          // wipes the session — WhatsApp keeps retrying but can't re-establish without a new
          // PreKey exchange. Count per-contact: after 5 consecutive failures, resetKeys() + reconnect.
          // Threshold is 5 (not 3) to tolerate post-QR-scan replays of a few old messages per contact.
          if (errMsg.includes("No session record") || errMsg.includes("No matching sessions found")) {
            const noSessParticipant: string = detail?.key?.participant ?? detail?.key?.remoteJid ?? "";
            if (noSessParticipant) {
              // @lid messages are WhatsApp-internal linked-device protocol. We never have sessions
              // for them and never need to — they're not real contacts. Counting these toward
              // resetKeys() wipes prekeys for all real contacts on every reconnect burst.
              if (noSessParticipant.endsWith("@lid")) return;
              const jidFragment = noSessParticipant.split(":")[0].split("@")[0];
              const contactKey = `${email}::${jidFragment}`;
              const purgeTs = recentlyPurgedContacts.get(contactKey);
              if (purgeTs && Date.now() - purgeTs < 300_000) {
                // Post-purge no-session: session was wiped and WhatsApp can't re-establish it.
                // Reset keys — don't close, closing just creates another reconnect burst with the same errors.
                recentlyPurgedContacts.delete(contactKey);
                contactDecryptFailures.delete(contactKey);
                waLog("warn", email, "no-session after key purge — resetting Signal keys (staying connected)", { participant: noSessParticipant });
                auth.resetKeys().catch(() => {});
              } else {
                // Unknown contact no-session: could be post-QR-scan replay, but more likely stale
                // Signal keys after reconnect. 3 = one full message retry cycle (maxMsgRetryCount).
                const failCount = (contactDecryptFailures.get(contactKey) ?? 0) + 1;
                contactDecryptFailures.set(contactKey, failCount);
                if (failCount >= 3) {
                  contactDecryptFailures.delete(contactKey);
                  waLog("warn", email, "persistent no-session failures for contact — resetting Signal keys (staying connected)", { participant: noSessParticipant, failCount });
                  auth.resetKeys().catch(() => {});
                }
              }
            }
            return;
          }

          // PreKeyError on outgoing copies (fromMe=true, remoteJid=someone else) is expected
          // on fresh connect and resolves without intervention — skip purge.
          // But self-messages (Boaz → own chat, remoteJid matches owner key) must purge
          // so the Signal session re-establishes and the bot can decrypt them.
          if (detail?.key?.fromMe && errName === "PreKeyError") {
            const remoteJid: string = detail?.key?.remoteJid ?? "";
            const remoteKey = remoteJid.split(":")[0].split("@")[0];
            const isSelfMessage = remoteKey.length > 0 && ownerKeys.has(remoteKey);
            if (!isSelfMessage) {
              waLog("warn", email, "decrypt error on outgoing copy — skipping purge (PreKeyError expected on fresh connect)", { remoteJid });
              return;
            }
            // Falls through to purge — self-message needs session reset
          }

          const participant: string = detail?.key?.participant ?? detail?.key?.remoteJid ?? "";
          if (participant) {
            // @lid = WA internal linked-device protocol messages. Pre-key failures here are
            // backlog replay from old sessions — we never need to decrypt these. Calling
            // resetKeys() or purgeContactKeys() for @lid breaks Signal state for ALL real
            // contacts and causes a self-perpetuating Invalid-PreKey-ID cycle on every reconnect.
            if (participant.endsWith("@lid")) return;
            const jidFragment = participant.split(":")[0].split("@")[0];
            const purged = auth.purgeContactKeys(jidFragment);
            waLog("warn", email, "auto-purge triggered", { participant, purgedKeys: purged, errMsg });
            if (purged === 0 && errName === "PreKeyError") {
              // No local session keys exist for this contact (e.g. fresh QR scan wiped them).
              // Purging nothing can't help — the PreKey is simply gone. Reset all Signal
              // keys so WhatsApp negotiates a fresh PreKey exchange on next message.
              // Cooldown: 5 minutes between resets — prevents a tight loop when WhatsApp
              // replays queued stale messages encrypted with old PreKeys after each reset.
              const lastReset = lastZeroPurgeReset.get(email) ?? 0;
              if (Date.now() - lastReset > 300_000) {
                lastZeroPurgeReset.set(email, Date.now());
                waLog("warn", email, "PreKeyError with no local keys — resetting Signal keys for fresh PreKey exchange (staying connected)", { participant });
                auth.resetKeys().catch(() => {});
              } else {
                waLog("warn", email, "PreKeyError with no local keys — skipping reset (cooldown active)", { participant, msSinceLastReset: Date.now() - lastReset });
              }
              return;
            }
            const contactKey = `${email}::${jidFragment}`;
            recentlyPurgedContacts.set(contactKey, Date.now());
            const failCount = (contactDecryptFailures.get(contactKey) ?? 0) + 1;
            contactDecryptFailures.set(contactKey, failCount);
            if (failCount >= 3) {
              contactDecryptFailures.delete(contactKey);
              waLog("warn", email, "persistent decrypt failures for contact — resetting Signal keys (staying connected)", { participant, failCount });
              auth.resetKeys().catch(() => {});
            }
          } else {
            const purged = auth.purgeContactKeys("session-");
            waLog("warn", email, "auto-purge (no participant) — purged all session keys", { purgedKeys: purged, errMsg });
          }

          // Rate-limit check: if decrypt errors flood (>10 in 15s), WhatsApp is re-delivering
          // undecryptable history messages after a reconnect. Purging alone won't stop it —
          // force-close the socket so the reconnect gets a clean slate and WhatsApp stops replaying.
          const now = Date.now();
          const rate = decryptErrorRate.get(email) ?? { count: 0, windowStart: now };
          if (now - rate.windowStart > 15_000) {
            rate.count = 1;
            rate.windowStart = now;
          } else {
            rate.count += 1;
          }
          decryptErrorRate.set(email, rate);
          if (rate.count > 10) {
            decryptErrorRate.delete(email);
            waLog("warn", email, "decrypt error flood detected — resetting session keys (staying connected)", { errorCount: rate.count });
            // Reset session keys (preserving prekeys) so WhatsApp can complete the retry/PreKey
            // exchange without interruption. Previously we closed the socket here, but that
            // re-delivered the backlog on every reconnect, creating an infinite retry loop.
            // With prekeys preserved, staying connected lets the retry cycle (retryCount 0→1→2→PreKey)
            // complete — the sender's final retry sends a PreKeyMessage we can decrypt.
            auth.resetKeys().catch(() => {});
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
        loggedOutRetries.delete(email);  // reset 401-retry counter
        decryptErrorRate.delete(email);  // reset decrypt flood counter
        lastZeroPurgeReset.delete(email); // reset PreKeyError cooldown (stale cooldown blocks needed resets)
        // Clear per-contact state so backlogged messages on reconnect don't immediately re-trigger closes.
        for (const k of contactDecryptFailures.keys()) { if (k.startsWith(email + "::")) contactDecryptFailures.delete(k); }
        for (const k of recentlyPurgedContacts.keys()) { if (k.startsWith(email + "::")) recentlyPurgedContacts.delete(k); }
        seedOwnerKeys(); // populate ownerKeys from sock.user (phone + LID)
        waLog("info", email, "connected successfully", { jid: sock.user?.id, ownerKeys: [...ownerKeys] });
        session.connectedListeners.forEach((fn) => fn());
        session.qrListeners = [];
        session.connectedListeners = [];
        session.onEveryConnect?.(); // prewarm caches on every connect, including reconnects
      }

      if (connection === "close") {
        // Flush any pending debounced key save, then freeze. Flush first so the next session
        // loads up-to-date Signal keys; freeze after so old socket can't corrupt new session.
        await auth.flushAndFreeze();

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
          const loggedOutAttempt = (loggedOutRetries.get(email) ?? 0) + 1;
          const carryEveryConnect = session.onEveryConnect;
          if (loggedOutAttempt === 1) {
            // First 401 — could be transient (phone restart, WhatsApp server blip, brief network drop).
            // Try reconnecting once before wiping credentials. If it's a genuine logout, the next
            // connect attempt will also get 401 and creds will be deleted then.
            loggedOutRetries.set(email, loggedOutAttempt);
            waLog("warn", email, "connection closed with loggedOut (401) — retrying once before clearing credentials");
            setTimeout(() => {
              connectSession(email, agentId, oauthUrl, oauthKey, mentionHandler, undefined, undefined, carryEveryConnect).catch((e) =>
                waLog("error", email, "reconnect after loggedOut failed", { error: e.message })
              );
            }, 5_000);
          } else {
            loggedOutRetries.delete(email);
            waLog("info", email, "user logged out from phone — clearing stored credentials");
            await deleteCreds(agentId, email, oauthUrl, oauthKey);
          }
        } else if (isCryptoError) {
          // Noise protocol error during WebSocket handshake. "Unsupported state or unable
          // to authenticate data" is often transient — WA force-closes the stream (code 500)
          // and its noise session state resets; our noise key is still valid. Fast retries
          // handle transient cases; slow retries (3 min) handle extended WA outages.
          // Only delete creds after 10 failures (~16 min total), which indicates genuine
          // Noise key corruption rather than a transient server-side reset.
          const cryptoAttempt = cryptoRetryCount.get(email) ?? 0;
          const carryEveryConnect = session.onEveryConnect;
          // Never delete credentials on crypto errors — Noise handshake failures are
          // caused by transient networking or WA server issues, not by corrupt credentials.
          // The phone's linked device pairing is still valid. Keep retrying indefinitely:
          // fast for the first 5 attempts, then slow (3 min). The user can always manually
          // disconnect and re-scan if they genuinely need to re-pair.
          const delay = cryptoAttempt < 5
            ? Math.min(10_000 * (cryptoAttempt + 1), 60_000)
            : 3 * 60_000;
          waLog("warn", email, `crypto error (attempt ${cryptoAttempt}) — reconnecting in ${delay / 1000}s`);
          setTimeout(() => {
            connectSession(email, agentId, oauthUrl, oauthKey, mentionHandler, undefined, undefined, carryEveryConnect).catch((e) =>
              waLog("error", email, "reconnect after crypto error failed", { error: e.message })
            );
          }, delay);
        } else if (reason?.includes("QR refs attempts ended") || reason?.includes("QR timeout")) {
          // QR was generated but nobody scanned it — stop reconnecting to avoid an
          // infinite QR loop. User must reconnect explicitly via the settings UI.
          waLog("info", email, "QR scan timed out — stopping reconnect loop, user must reconnect via settings");
        } else {
          const attempt = (reconnectAttempts.get(email) ?? 0) + 1;
          reconnectAttempts.set(email, attempt);
          // First 10 attempts: fast exponential backoff (5s → 60s).
          // After that: retry every 30s — 5 min was too slow; 3 failed slow retries = 15+ min dead.
          const backoff = attempt <= 10 ? Math.min(5000 * attempt, 60_000) : 30_000;
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
    // Track processed message IDs to prevent duplicate processing. Module-level map
    // so dedup survives reconnects — WhatsApp re-delivers unACK'd messages on reconnect,
    // and a fresh per-session Set would allow reprocessing → double reply.
    // Also seeded from Firestore-persisted IDs so a fresh deploy doesn't reprocess
    // messages that WhatsApp re-delivers with a fresh timestamp after a retry receipt.
    if (!processedMsgIdsByEmail.has(email)) processedMsgIdsByEmail.set(email, new Set<string>());
    const processedMsgIds = processedMsgIdsByEmail.get(email)!;
    for (const id of auth.persistedMsgIds) processedMsgIds.add(id);

    // All known participant key fragments that belong to the account owner.
    // Seeded from sock.user (phone + LID) at connect time, then updated whenever
    // we observe rawFromMe=true on a group message — that message's participant is
    // definitively the owner, so we can learn their LID even if sock.user.lid was
    // empty after a reconnect.
    const ownerKeys = new Set<string>();
    const seedOwnerKeys = () => {
      const u = sock.user as { id?: string; lid?: string } | undefined;
      const ph = u?.id?.split(":")[0].split("@")[0];
      const sockLid = u?.lid?.split(":")[0].split("@")[0];
      // Baileys doesn't always populate sock.user.lid — read directly from creds as fallback.
      // creds.me.lid is stored in Firestore from the original QR scan and is reliable.
      const credsLid = (auth.state.creds.me as any)?.lid?.split(":")[0].split("@")[0];
      if (ph) ownerKeys.add(ph);
      if (sockLid) ownerKeys.add(sockLid);
      if (credsLid) ownerKeys.add(credsLid);
    };

    // WhatsApp syncs contact data (including LID mappings) shortly after connect.
    // Use this to learn the owner's LID when sock.user.lid was empty at connect time.
    sock.ev.on("contacts.upsert", (contacts: any[]) => {
      const ph = (sock.user as any)?.id?.split(":")[0].split("@")[0];
      if (!ph) return;
      for (const contact of contacts) {
        const contactPhone = (contact.id as string | undefined)?.split(":")[0].split("@")[0];
        if (contactPhone === ph && contact.lid) {
          const lid = (contact.lid as string).split(":")[0].split("@")[0];
          if (lid && !ownerKeys.has(lid)) {
            ownerKeys.add(lid);
            waLog("info", email, "learned owner LID from contact sync", { lid, ownerKeys: [...ownerKeys] });
          }
        }
      }
    });

    // Serialize per-JID: only one agent call runs at a time per conversation.
    // When a second message arrives while the first is processing, it is stored as
    // "pending" (latest wins). After the current run finishes, the pending message
    // is picked up immediately. This prevents concurrent Gemini calls for the same
    // JID from competing for resources and both timing out.
    interface PendingMsgState {
      msg: any; from: string; fromName: string; text: string;
      isGroup: boolean; groupName?: string; isMentioned: boolean;
      recentMessages: Array<{ from: string; text: string; ts: number }>;
      attachment?: WhatsAppAttachment; attachmentText?: string;
      attachmentName?: string; attachmentError?: string;
    }
    const processingJids = new Set<string>();
    const pendingByJid = new Map<string, PendingMsgState>();

    const dispatchMsg = async (initial: PendingMsgState): Promise<void> => {
      let state: PendingMsgState | null = initial;
      while (state) {
        const { msg, from, fromName, text, isGroup, groupName, isMentioned, recentMessages, attachment, attachmentText, attachmentName, attachmentError } = state;
        state = null;
        try {
          const t0 = Date.now();
          const rawFromMe = !!msg.key.fromMe;
          const participant = (msg.key.participant ?? msg.key.remoteJid ?? "") as string;
          const participantKey = participant.split(":")[0].split("@")[0];
          // In groups, rawFromMe=true definitively identifies the participant as the owner.
          // Learn their key so subsequent messages with rawFromMe=false are still detected.
          if (rawFromMe && isGroup && participantKey && !ownerKeys.has(participantKey)) {
            ownerKeys.add(participantKey);
            waLog("info", email, "learned owner key from group message", { participantKey, ownerKeys: [...ownerKeys] });
          }
          const fromMe = rawFromMe || ownerKeys.has(participantKey);
          waLog("info", email, "fromMe detection", { rawFromMe, fromMe, participantKey, ownerKeys: [...ownerKeys] });
          if (!rawFromMe && fromMe) {
            waLog("info", email, "identified own message via owner key match", { participantKey });
          }
          const reply = await mentionHandler({ email, from, fromName, text, isGroup, groupName, isMentioned, fromMe, recentMessages, attachment, attachmentText, attachmentName, attachmentError });
          waLog("info", email, "timing: handler total", { ms: Date.now() - t0 });
          if (reply) {
            if (sessions.get(email)?.status !== "connected") {
              waLog("warn", email, "session no longer connected — dropping reply", { to: from });
            } else {
              waLog("info", email, "sending reply", { to: from, replyLength: reply.length });
              const isLid = from.endsWith("@lid");
              const timeoutMs = (isGroup || isLid) ? 30_000 : 20_000;
              const sendTimeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`sendMessage timed out after ${timeoutMs / 1000}s`)), timeoutMs)
              );
              const currentSock = sessions.get(email)?.socket ?? sock;
              const sent: any = await Promise.race([currentSock.sendMessage(from, { text: reply }, { quoted: msg }), sendTimeout]);
              if (sent?.key?.id) {
                sentByBot.add(sent.key.id);
                setTimeout(() => sentByBot.delete(sent.key.id), 30_000);
              }
              storeRecentMessage(from, "Assistant", reply, Date.now());
              waLog("info", email, "reply sent successfully");
            }
          } else {
            waLog("info", email, "handler returned null — no reply sent (trigger/filter did not match)");
          }
        } catch (err) {
          const errMsg = (err as Error).message ?? "";
          waLog("error", email, "message handler threw an error", { error: errMsg, stack: (err as Error).stack });
          if (errMsg.includes("sendMessage timed out")) {
            waLog("warn", email, "sendMessage frozen — closing socket to trigger reconnect");
            try { sessions.get(email)?.socket?.end?.(); } catch {}
          }
        }
        const next = pendingByJid.get(from);
        if (next) {
          pendingByJid.delete(from);
          waLog("info", email, "processing deferred message", { from });
          state = next;
        } else {
          processingJids.delete(from);
        }
      }
    };

    sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
      waLog("info", email, "messages.upsert fired", { type, count: messages?.length ?? 0 });
      // Process both "notify" (real-time) and "append" (retry/late delivery). Baileys
      // routes some legitimate fresh messages as "append" after reconnects or Signal
      // session re-establishments. Genuinely stale messages are filtered downstream by
      // the timestamp checks (ageMsec > 5min + msgTs < connectedAt - 5s).
      if (type !== "notify" && type !== "append") return;
      const myJid = sock.user?.id?.replace(/:.*@/, "@");

      for (const msg of messages) {
        // Store in getMessage cache regardless of whether we process this message.
        // Baileys needs this for retry-decryption of Signal failures from any sender.
        if (msg.key.id && msg.message) {
          socketMsgStore.set(msg.key.id, msg);
          if (socketMsgStore.size > SOCKET_MSG_STORE_MAX) {
            const evict = [...socketMsgStore.keys()].slice(0, 50);
            evict.forEach((k) => socketMsgStore.delete(k));
          }
        }

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
        // Skip messages sent before this session was created. sessionCreatedAt is set
        // before the socket is even created, so it's always non-zero — unlike connectedAt
        // which could be 0 if messages.upsert fires before connection.update:"open".
        if (msgTs < sessionCreatedAt - 5_000) {
          waLog("info", email, "skipping pre-session message", { sentMsAgo: ageMsec, msBeforeSession: sessionCreatedAt - msgTs });
          continue;
        }

        if (msg.key.fromMe) {
          if (sentByBot.has(msgId)) {
            sentByBot.delete(msgId);
            continue; // bot's own reply echoed back — skip to prevent loop
          }
          // Message sent from user's phone (same account, different device) — process it
        }

        let text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.documentMessage?.caption ||
          msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
          "";

        // Transcribe voice notes via Gemini so keyword/mention filters can match spoken words.
        if (!text && msg.message?.audioMessage?.ptt) {
          try {
            const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
            const silentLogger = { level: "silent", trace: ()=>{}, debug: ()=>{}, info: ()=>{}, warn: ()=>{}, error: ()=>{}, fatal: ()=>{}, child: (): any => ({}) } as any;
            const audioBuffer = await Promise.race([
              downloadMediaMessage(msg, "buffer", {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }) as Promise<Buffer>,
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("voice download timed out")), 30_000)),
            ]);
            const { GoogleGenerativeAI } = await import("@google/generative-ai");
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
            const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await geminiModel.generateContent([
              { inlineData: { mimeType: "audio/ogg; codecs=opus", data: audioBuffer.toString("base64") } },
              { text: "Transcribe this voice message exactly. Return only the transcript, no commentary." },
            ]);
            const transcript = result.response.text().trim();
            if (transcript) {
              text = `[Voice note]: ${transcript}`;
              waLog("info", email, "voice note transcribed", { chars: transcript.length });
            }
          } catch (err) {
            waLog("warn", email, "voice note transcription failed", { error: (err as Error).message });
          }
        }

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

        // Successful decryption — reset per-contact failure counter.
        const senderFrag = (msg.key.participant ?? msg.key.remoteJid ?? "").split(":")[0].split("@")[0];
        if (senderFrag) contactDecryptFailures.delete(`${email}::${senderFrag}`);

        // Text confirmed — mark processed now to prevent duplicate handling.
        // Also persist to Firestore so a redeploy doesn't reprocess retry-redelivered messages.
        // Cap at 5000 entries and evict oldest 1000 to prevent unbounded growth.
        if (msgId) {
          processedMsgIds.add(msgId);
          auth.addProcessedId(msgId);
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
          const cached = groupMetaCache.get(from);
          if (cached && Date.now() - cached.ts < GROUP_META_TTL_MS) {
            groupName = cached.subject;
          } else {
            try {
              const meta = await sock.groupMetadata(from);
              groupName = meta.subject;
              groupMetaCache.set(from, { subject: groupName, ts: Date.now() });
            } catch { /* no metadata */ }
          }
        }

        // Store in buffer BEFORE logging so the current message is included in context
        const storageTs = msgTs || Date.now();
        storeRecentMessage(from, fromName, text, storageTs);
        const recentMessages = getRecentMessages(from);

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
        // Handle documentWithCaptionMessage — newer WhatsApp versions wrap documents inside this
        // container instead of using a bare documentMessage, both in direct messages and quoted replies.
        const directDocMsg = msg.message?.documentMessage
          ?? msg.message?.documentWithCaptionMessage?.message?.documentMessage;
        const quotedDocMsg = quoted?.documentMessage
          ?? quoted?.documentWithCaptionMessage?.message?.documentMessage;
        const imageMsg = msg.message?.imageMessage ?? quoted?.imageMessage;
        const docMsg = directDocMsg ?? quotedDocMsg;
        const mediaMsg = imageMsg || docMsg;
        const isQuoted = !msg.message?.imageMessage && !directDocMsg && !!mediaMsg;
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
              // Build the correct download target.
              // For quoted media, reuploadRequest needs the ORIGINAL message's key (not the
              // reply key) so WhatsApp knows which media to re-upload when the CDN URL expires.
              // Priority: (1) original message from our in-memory store (has fully correct key +
              // fresh content), (2) reconstruct from contextInfo.stanzaId.
              let target: typeof msg;
              if (isQuoted) {
                const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
                const stanzaId = ctxInfo?.stanzaId;
                const storedOriginal = stanzaId ? socketMsgStore.get(stanzaId) : undefined;
                if (storedOriginal) {
                  target = storedOriginal;
                } else {
                  target = {
                    key: {
                      id: stanzaId ?? msg.key.id,
                      remoteJid: ctxInfo?.remoteJid ?? msg.key.remoteJid,
                      participant: ctxInfo?.participant ?? undefined,
                      fromMe: false,
                    },
                    message: quoted,
                  } as typeof msg;
                }
              } else {
                target = msg;
              }
              const downloadTimeoutMs = 30_000;
              const buffer = await Promise.race([
                downloadMediaMessage(target, "buffer", {}, { logger: { level: "silent", trace: ()=>{}, debug: ()=>{}, info: ()=>{}, warn: ()=>{}, error: ()=>{}, fatal: ()=>{}, child: (): any => ({}) } as any, reuploadRequest: sock.updateMediaMessage }) as Promise<Buffer>,
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

        const msgState: PendingMsgState = { msg, from, fromName, text, isGroup, groupName, isMentioned, recentMessages, attachment, attachmentText, attachmentName, attachmentError };
        if (processingJids.has(from)) {
          const existing = pendingByJid.get(from);
          // Preserve owner messages: don't replace a fromMe pending with a non-fromMe message.
          // In ownerOnly groups, a busy group can otherwise evict the owner's queued reply.
          if (existing && existing.msg.key.fromMe && !msg.key.fromMe) {
            waLog("info", email, "dropping non-owner pending — owner message already queued", { from });
          } else {
            waLog("info", email, "deferring message — JID already processing", { from });
            pendingByJid.set(from, msgState);
          }
        } else {
          processingJids.add(from);
          dispatchMsg(msgState).catch(err => {
            waLog("error", email, "dispatchMsg unhandled error", { error: (err as Error).message });
            processingJids.delete(from);
            pendingByJid.delete(from);
          });
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

      // Noise protocol error — do NOT touch Firestore here. Baileys may have partially
      // modified creds.noiseKey mid-handshake before this error fired; calling resetKeys()
      // would re-save those corrupt creds and lock the failure in. Just close the socket so
      // connection.update schedules a retry with whatever Firestore already has.
      waLog("warn", email, `native crypto error during connect (attempt ${attempt}) — closing socket, will retry`);
      try { session.socket?.end?.(new Error("Unsupported state or unable to authenticate data")); } catch {}
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
  const digits = to.replace(/[^0-9]/g, "");
  const candidateJid = digits + "@s.whatsapp.net";
  // Resolve canonical JID — prevents channel_not_found on unregistered formats
  let jid = candidateJid;
  try {
    const [result] = await session.socket.onWhatsApp(digits);
    if (!result?.exists) throw new Error(`${to} is not on WhatsApp`);
    jid = result.jid;
  } catch (lookupErr) {
    // onWhatsApp itself failed — fall back to candidate and let sendMessage throw
    waLog("warn", email, "onWhatsApp lookup failed, falling back", { candidateJid });
  }
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
