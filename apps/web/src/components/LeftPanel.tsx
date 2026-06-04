import { useState, useEffect, useRef, useCallback } from "react";
import type { AgentConfig, Skill, UserSettings, CustomToolSummary } from "../types";
import {
  applyConfigLive, getApiKey, getProviders,
  subscribeWhatsAppQR, getWhatsAppConfig, saveWhatsAppConfig, importContacts, validateApiKey,
  getCustomTools,
  type WhatsAppConfig,
} from "../api/client";

const BASE = import.meta.env.VITE_API_URL ?? window.location.origin;

const MODELS = [
  { provider: "gemini" as const, modelId: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { provider: "gemini" as const, modelId: "gemini-2.5-pro",   label: "Gemini 2.5 Pro" },
  { provider: "gemini" as const, modelId: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { provider: "claude" as const, modelId: "claude-opus-4-7",           label: "Claude Opus 4.7" },
  { provider: "claude" as const, modelId: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6" },
  { provider: "claude" as const, modelId: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { provider: "openai" as const, modelId: "gpt-4o",      label: "GPT-4o" },
  { provider: "openai" as const, modelId: "gpt-4o-mini", label: "GPT-4o mini" },
  { provider: "openai" as const, modelId: "o1",          label: "o1" },
  { provider: "openai" as const, modelId: "o1-mini",     label: "o1 mini" },
];

export type PanelId = "brain" | "connectors" | "skills" | "access";

export interface LeftPanelProps {
  panel: PanelId;
  onClose: () => void;
  className?: string;
  userEmail: string | null;
  userSettings: UserSettings;
  onUserSettingsChange: (s: UserSettings) => void;
  agentConfig: AgentConfig | null;
  onAgentConfigChange: (c: AgentConfig) => void;
  gmailConnected: boolean;
  calendarConnected: boolean;
  mondayConnected: boolean;
  tasksConnected: boolean;
  whatsappConnected: boolean;
  whatsappStatus?: "connected" | "disconnected" | "connecting" | "qr";
  whatsappOwners?: string[];
  googleMapsConnected: boolean;
  connectionsLoading?: boolean;
  onGmailDisconnect: () => void;
  onCalendarDisconnect: () => void;
  onMondayDisconnect: () => void;
  onTasksDisconnect: () => void;
  onWhatsappConnected: () => void;
  onWhatsappDisconnect: () => void;
}

// ── Brain ─────────────────────────────────────────────────────────────────────

function BrainPanel({ userSettings, onChange, agentConfig }: {
  userSettings: UserSettings;
  onChange: (s: UserSettings) => void;
  agentConfig: AgentConfig | null;
}) {
  const [providers, setProviders] = useState({ gemini: true, claude: false, openai: false, slack: false });
  const [instructions, setInstructions] = useState(userSettings.systemPrompt ?? "");
  const [saved, setSaved] = useState(false);

  useEffect(() => { getProviders().then(setProviders).catch(() => {}); }, []);
  useEffect(() => { setInstructions(userSettings.systemPrompt ?? ""); }, [userSettings.systemPrompt]);

  const currentModel = userSettings.model ?? agentConfig?.model;

  const handleSave = () => {
    onChange({ ...userSettings, systemPrompt: instructions || undefined });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    setInstructions("");
    onChange({ ...userSettings, systemPrompt: undefined, model: undefined });
  };

  return (
    <div className="lp-content">
      <p className="lp-hint">Your personal model and instructions. Overrides the agent defaults just for you.</p>

      <div className="lp-field">
        <label className="lp-label">Model</label>
        <select
          className="configure-input"
          value={`${currentModel?.provider ?? "gemini"}:${currentModel?.modelId ?? "gemini-2.5-flash"}`}
          onChange={(e) => {
            const [provider, ...rest] = e.target.value.split(":") as [AgentConfig["model"]["provider"], ...string[]];
            onChange({ ...userSettings, model: { provider, modelId: rest.join(":") } });
          }}
        >
          {(["gemini", "claude", "openai"] as const).map((p) => (
            <optgroup key={p} label={p === "gemini" ? "Gemini" : p === "claude" ? "Claude" : "OpenAI"}>
              {MODELS.filter((m) => m.provider === p).map((m) => (
                <option key={m.modelId} value={`${m.provider}:${m.modelId}`} disabled={!providers[p]}>
                  {m.label}{!providers[p] ? " (no API key)" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="lp-field">
        <label className="lp-label">Instructions</label>
        <textarea
          className="configure-textarea sidebar-instructions"
          rows={11}
          placeholder={agentConfig?.systemPrompt ?? "Define how the agent should behave for you…"}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </div>

      <div className="lp-actions">
        {(userSettings.model || userSettings.systemPrompt) && (
          <button className="lp-ghost-btn" onClick={handleReset}>Reset to defaults</button>
        )}
        <button className="lp-save-btn" onClick={handleSave}>
          {saved ? "✓ Saved" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Custom tools (built conversationally; per-user credential) ─────────────────

function CustomToolCredentialRow({ tool, userSettings, onUserSettingsChange }: {
  tool: CustomToolSummary; userSettings: UserSettings; onUserSettingsChange: (s: UserSettings) => void;
}) {
  const [draft, setDraft] = useState("");
  const creds = userSettings.customCredentials ?? {};
  const connected = tool.auth.type === "none" || !!creds[tool.auth.credRef];

  const save = () => {
    if (!draft.trim()) return;
    onUserSettingsChange({ ...userSettings, customCredentials: { ...creds, [tool.auth.credRef]: draft.trim() } });
    setDraft("");
  };
  const disconnect = () => {
    // Empty string reads as "not connected" server-side (merge can't delete a key).
    onUserSettingsChange({ ...userSettings, customCredentials: { ...creds, [tool.auth.credRef]: "" } });
  };

  return (
    <>
      <div className="lp-conn-row lp-conn-row-wrap" style={{ marginTop: 4 }}>
        <span className="lp-conn-icon">🧩</span>
        <div className="lp-conn-body">
          <span className="lp-conn-name">{tool.service}</span>
          <span className="lp-conn-status">
            {connected
              ? <><span className="lp-dot">●</span>{"•".repeat(12)}</>
              : <span style={{ opacity: 0.5 }}>{tool.auth.credRef} required</span>}
          </span>
        </div>
        {connected && tool.auth.type !== "none" && (
          <button className="lp-disc-btn" onClick={disconnect}>Disconnect</button>
        )}
      </div>
      {!connected && (
        <div className="lp-key-input-row" style={{ flexWrap: "wrap", gap: 4 }}>
          <input type="password" className="configure-input"
            placeholder={`Paste ${tool.service} credential`}
            value={draft} onChange={(e) => setDraft(e.target.value)}
            style={{ flex: 1, fontSize: 12 }}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
          />
          <button className="lp-save-btn" style={{ fontSize: 12, padding: "4px 12px", whiteSpace: "nowrap" }}
            disabled={!draft.trim()} onClick={save}>Connect</button>
        </div>
      )}
    </>
  );
}

function CustomToolsConnections({ userSettings, onUserSettingsChange }: {
  userSettings: UserSettings; onUserSettingsChange: (s: UserSettings) => void;
}) {
  const [tools, setTools] = useState<CustomToolSummary[]>([]);
  // Poll so a tool the agent just built shows up without a manual page refresh.
  useEffect(() => {
    const load = () => getCustomTools().then(setTools).catch(() => {});
    load();
    const id = setInterval(load, 8000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, []);
  if (!tools.length) return null;
  return (
    <>
      <div className="lp-section-label" style={{ marginTop: 20 }}>Custom Tools</div>
      {tools.map((t) => (
        <CustomToolCredentialRow key={t.id} tool={t} userSettings={userSettings} onUserSettingsChange={onUserSettingsChange} />
      ))}
    </>
  );
}

// ── Connectors ────────────────────────────────────────────────────────────────

function ConnectorsPanel({
  userEmail, userSettings, onUserSettingsChange,
  gmailConnected, calendarConnected, mondayConnected, tasksConnected,
  whatsappConnected, whatsappStatus, whatsappOwners, googleMapsConnected, connectionsLoading,
  onGmailDisconnect, onCalendarDisconnect, onMondayDisconnect, onTasksDisconnect,
  onWhatsappConnected, onWhatsappDisconnect,
}: Omit<LeftPanelProps, "panel" | "onClose" | "agentConfig" | "onAgentConfigChange">) {
  const [showQR, setShowQR] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [waConfig, setWaConfig] = useState<WhatsAppConfig>({ replyTrigger: "mention", replyInGroups: true, replyInDMs: false });
  const [waConfigSaving, setWaConfigSaving] = useState(false);
  const [waConfigSaved, setWaConfigSaved] = useState(false);
  const [contactImportStatus, setContactImportStatus] = useState<string | null>(null);
  const [apolloDraft, setApolloDraft] = useState("");
  const [apolloEditing, setApolloEditing] = useState(false);
  const [apolloValidating, setApolloValidating] = useState(false);
  const [apolloKeyError, setApolloKeyError] = useState<string | null>(null);
  const [mapsDraft, setMapsDraft] = useState("");
  const [mapsEditing, setMapsEditing] = useState(false);
  const [mapsValidating, setMapsValidating] = useState(false);
  const [mapsKeyError, setMapsKeyError] = useState<string | null>(null);
  const [waSettingsOpen, setWaSettingsOpen] = useState(false);
  const contactFileRef = useRef<HTMLInputElement>(null);
  const closeQRRef = useRef<(() => void) | null>(null);
  const otherOwner = whatsappOwners?.find((o) => o !== userEmail) ?? null;
  const apolloConnected = !!userSettings.apolloApiKey;

  useEffect(() => {
    if (whatsappConnected) getWhatsAppConfig().then(setWaConfig).catch(() => {});
  }, [whatsappConnected]);

  const handleWhatsappConnect = useCallback(() => {
    setShowQR(true); setQrDataUrl(null); setQrError(null);
    const unsub = subscribeWhatsAppQR(
      (url) => setQrDataUrl(url),
      () => { setShowQR(false); onWhatsappConnected(); unsub(); getWhatsAppConfig().then(setWaConfig).catch(() => {}); },
      (msg) => setQrError(msg),
    );
    closeQRRef.current = unsub;
  }, [onWhatsappConnected]);

  const handleSaveWaConfig = useCallback(async () => {
    setWaConfigSaving(true);
    try { await saveWhatsAppConfig(waConfig); setWaConfigSaved(true); setTimeout(() => setWaConfigSaved(false), 2000); }
    finally { setWaConfigSaving(false); }
  }, [waConfig]);

  const handleContactFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setContactImportStatus("Importing…");
    try {
      const { imported } = await importContacts(await file.text());
      setContactImportStatus(`${imported} contact${imported !== 1 ? "s" : ""} imported`);
      setTimeout(() => setContactImportStatus(null), 4000);
    } catch (err) {
      setContactImportStatus(`Error: ${(err as Error).message}`);
      setTimeout(() => setContactImportStatus(null), 5000);
    }
    if (contactFileRef.current) contactFileRef.current.value = "";
  }, []);

  const oauthServices = [
    { label: "Gmail",           icon: "📧", service: "gmail"    as const, connected: gmailConnected,    onDisconnect: onGmailDisconnect },
    { label: "Google Calendar", icon: "📅", service: "calendar" as const, connected: calendarConnected, onDisconnect: onCalendarDisconnect },
    { label: "Google Tasks",    icon: "✅", service: "tasks"    as const, connected: tasksConnected,    onDisconnect: onTasksDisconnect },
    { label: "Monday.com",      icon: "📋", service: "monday"   as const, connected: mondayConnected,   onDisconnect: onMondayDisconnect },
  ];

  return (
    <div className="lp-content">
      {connectionsLoading ? (
        <div className="lp-loading">Loading…</div>
      ) : (<>

        <div className="lp-section-label">OAuth Services</div>

        {oauthServices.map(({ label, icon, service, connected, onDisconnect }) => {
          const href = service === "monday"
            ? `${BASE}/api/auth/monday/start?returnUrl=${encodeURIComponent(window.location.origin)}`
            : `${BASE}/api/auth/google/start?service=${service}&returnUrl=${encodeURIComponent(window.location.origin)}`;
          return (
            <div key={service} className="lp-conn-row">
              <span className="lp-conn-icon">{icon}</span>
              <div className="lp-conn-body">
                <span className="lp-conn-name">{label}</span>
                {connected && <span className="lp-conn-status"><span className="lp-dot">●</span>{userEmail?.split("@")[0] ?? "connected"}</span>}
              </div>
              {connected
                ? <button className="lp-disc-btn" onClick={onDisconnect}>Disconnect</button>
                : userEmail
                  ? <a className="lp-connect-btn" href={href}>Connect</a>
                  : <span style={{ fontSize: 11, opacity: 0.4 }}>Sign in first</span>}
            </div>
          );
        })}

        {/* WhatsApp */}
        <div className="lp-conn-row lp-conn-row-wrap">
          <span className="lp-conn-icon">💬</span>
          <div className="lp-conn-body">
            <span className="lp-conn-name">WhatsApp</span>
            <span className="lp-conn-status">
              {whatsappConnected
                ? <><span className="lp-dot">●</span>{userEmail?.split("@")[0] ?? "connected"}</>
                : whatsappStatus === "connecting" || whatsappStatus === "qr"
                  ? <span style={{ opacity: 0.7 }}>⟳ connecting…</span>
                  : otherOwner
                    ? <span style={{ opacity: 0.5, fontStyle: "italic" }}>in use by {otherOwner.split("@")[0]}</span>
                    : <button className="lp-connect-btn" onClick={handleWhatsappConnect}>Connect</button>}
            </span>
          </div>
          {whatsappConnected && (
            <button className="lp-conn-expand" onClick={() => setWaSettingsOpen((o) => !o)} title="Settings">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transition: "transform 0.2s", transform: waSettingsOpen ? "rotate(180deg)" : "none" }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
          )}
          {whatsappConnected && <button className="lp-disc-btn" onClick={onWhatsappDisconnect}>Disconnect</button>}
        </div>

        {whatsappConnected && waSettingsOpen && (
          <div className="lp-conn-sub">
            <div className="wa-config-row">
              <label className="wa-config-label">Reply when</label>
              <select className="configure-input" value={waConfig.replyTrigger}
                onChange={(e) => setWaConfig((c) => ({ ...c, replyTrigger: e.target.value as WhatsAppConfig["replyTrigger"] }))}>
                <option value="mention">@mentioned in a group</option>
                <option value="keyword">Message contains keyword</option>
                <option value="always">Any message (all chats)</option>
              </select>
            </div>
            {waConfig.replyTrigger === "keyword" && (
              <input className="configure-input" placeholder="Keyword (e.g. urgent, boost)"
                value={waConfig.keyword ?? ""} onChange={(e) => setWaConfig((c) => ({ ...c, keyword: e.target.value }))} />
            )}
            <div className="wa-config-row" style={{ gap: 12 }}>
              <label className="wa-config-label">Reply in</label>
              <label className="wa-checkbox-label"><input type="checkbox" checked={waConfig.replyInGroups} onChange={(e) => setWaConfig((c) => ({ ...c, replyInGroups: e.target.checked }))} /> Groups</label>
              <label className="wa-checkbox-label"><input type="checkbox" checked={waConfig.replyInDMs} onChange={(e) => setWaConfig((c) => ({ ...c, replyInDMs: e.target.checked }))} /> DMs</label>
            </div>
            <div className="wa-config-row" style={{ gap: 12 }}>
              <label className="wa-config-label">Sender</label>
              <label className="wa-checkbox-label"><input type="checkbox" checked={!!waConfig.ownerOnly} onChange={(e) => setWaConfig((c) => ({ ...c, ownerOnly: e.target.checked }))} /> Only my messages</label>
            </div>
            <div className="wa-config-row">
              <label className="wa-config-label">Model</label>
              <select className="configure-input"
                value={waConfig.model ? `${waConfig.model.provider}:${waConfig.model.modelId}` : ""}
                onChange={(e) => {
                  const val = e.target.value;
                  if (!val) { setWaConfig((c) => { const { model: _, ...rest } = c; return rest as typeof c; }); }
                  else { const [provider, modelId] = val.split(":") as ["gemini" | "claude" | "openai", string]; setWaConfig((c) => ({ ...c, model: { provider, modelId } })); }
                }}>
                <option value="">Gemini Flash (default)</option>
                <option value="gemini:gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="claude:claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                <option value="claude:claude-sonnet-4-6">Claude Sonnet 4.6</option>
              </select>
            </div>
            <textarea className="configure-textarea" rows={2} style={{ fontSize: 12 }}
              placeholder="Custom WhatsApp persona (optional)" value={waConfig.customPrompt ?? ""}
              onChange={(e) => setWaConfig((c) => ({ ...c, customPrompt: e.target.value }))} />
            <button className="lp-save-btn" onClick={handleSaveWaConfig} disabled={waConfigSaving} style={{ fontSize: 12, marginTop: 4 }}>
              {waConfigSaved ? "✓ Saved" : "Save WhatsApp settings"}
            </button>
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>Import iPhone contacts to send messages by name</div>
              <input ref={contactFileRef} type="file" accept=".vcf,text/vcard" style={{ display: "none" }} onChange={handleContactFile} />
              <button className="lp-ghost-btn" onClick={() => contactFileRef.current?.click()} style={{ fontSize: 12 }}>Import Contacts (.vcf)</button>
              {contactImportStatus && <div style={{ fontSize: 11, marginTop: 4, color: contactImportStatus.startsWith("Error") ? "#ef4444" : "#22c55e" }}>{contactImportStatus}</div>}
            </div>
          </div>
        )}

        <div className="lp-section-label" style={{ marginTop: 20 }}>API Keys</div>

        {/* Apollo.io */}
        <div className="lp-conn-row lp-conn-row-wrap">
          <span className="lp-conn-icon">🚀</span>
          <div className="lp-conn-body">
            <span className="lp-conn-name">Apollo.io</span>
            <span className="lp-conn-status">
              {apolloConnected
                ? <><span className="lp-dot">●</span>{"•".repeat(12)}</>
                : <span style={{ opacity: 0.5 }}>Not connected</span>}
            </span>
          </div>
          {apolloConnected && !apolloEditing && (
            <button className="api-copy-btn" style={{ fontSize: 11 }} onClick={() => { setApolloEditing(true); setApolloDraft(""); }}>Edit</button>
          )}
          {apolloConnected && !apolloEditing && (
            <button className="lp-disc-btn" onClick={() => {
              const { apolloApiKey: _, ...rest } = userSettings;
              onUserSettingsChange(rest as UserSettings);
            }}>Disconnect</button>
          )}
        </div>
        {(!apolloConnected || apolloEditing) && (
          <div className="lp-key-input-row" style={{ flexWrap: "wrap", gap: 4 }}>
            <input type="password" className="configure-input"
              placeholder={apolloEditing ? "New API key" : "Paste Apollo.io API key"}
              value={apolloDraft} onChange={(e) => { setApolloDraft(e.target.value); setApolloKeyError(null); }}
              style={{ flex: 1, fontSize: 12 }} autoFocus={apolloEditing}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setApolloDraft(""); setApolloEditing(false); setApolloKeyError(null); }
              }}
            />
            {apolloEditing && (
              <button className="automation-cancel-btn" style={{ fontSize: 12 }} onClick={() => { setApolloDraft(""); setApolloEditing(false); setApolloKeyError(null); }}>Cancel</button>
            )}
            <button className="lp-save-btn" style={{ fontSize: 12, padding: "4px 12px", whiteSpace: "nowrap" }}
              disabled={!apolloDraft.trim() || apolloValidating}
              onClick={async () => {
                setApolloValidating(true); setApolloKeyError(null);
                const result = await validateApiKey("apollo", apolloDraft.trim()).catch(() => ({ ok: false, error: "Network error" }));
                setApolloValidating(false);
                if (!result.ok) { setApolloKeyError(result.error ?? "Invalid key"); return; }
                onUserSettingsChange({ ...userSettings, apolloApiKey: apolloDraft.trim() });
                setApolloDraft(""); setApolloEditing(false);
              }}>
              {apolloValidating ? "Checking…" : apolloEditing ? "Save" : "Connect"}
            </button>
            {apolloKeyError && <span style={{ width: "100%", fontSize: 11, color: "var(--error, #e53e3e)" }}>{apolloKeyError}</span>}
          </div>
        )}

        {/* Google Maps */}
        <div className="lp-conn-row lp-conn-row-wrap" style={{ marginTop: 4 }}>
          <span className="lp-conn-icon">🗺️</span>
          <div className="lp-conn-body">
            <span className="lp-conn-name">Google Maps</span>
            <span className="lp-conn-status">
              {userSettings.googleMapsApiKey
                ? <><span className="lp-dot">●</span>{"•".repeat(12)}</>
                : googleMapsConnected
                  ? <><span className="lp-dot">●</span>server key</>
                  : <span style={{ opacity: 0.5 }}>Not connected</span>}
            </span>
          </div>
          {userSettings.googleMapsApiKey && !mapsEditing && (
            <button className="api-copy-btn" style={{ fontSize: 11 }} onClick={() => { setMapsEditing(true); setMapsDraft(""); }}>Edit</button>
          )}
          {userSettings.googleMapsApiKey && !mapsEditing && (
            <button className="lp-disc-btn" onClick={() => {
              const { googleMapsApiKey: _, ...rest } = userSettings;
              onUserSettingsChange(rest as UserSettings);
            }}>Disconnect</button>
          )}
        </div>
        {(mapsEditing || (!userSettings.googleMapsApiKey && !googleMapsConnected)) && (
          <div className="lp-key-input-row" style={{ flexWrap: "wrap", gap: 4 }}>
            <input type="password" className="configure-input"
              placeholder={mapsEditing ? "New API key" : "Paste Google Maps API key"}
              value={mapsDraft} onChange={(e) => { setMapsDraft(e.target.value); setMapsKeyError(null); }}
              style={{ flex: 1, fontSize: 12 }} autoFocus={mapsEditing}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setMapsDraft(""); setMapsEditing(false); setMapsKeyError(null); }
              }}
            />
            {mapsEditing && (
              <button className="automation-cancel-btn" style={{ fontSize: 12 }} onClick={() => { setMapsDraft(""); setMapsEditing(false); setMapsKeyError(null); }}>Cancel</button>
            )}
            <button className="lp-save-btn" style={{ fontSize: 12, padding: "4px 12px", whiteSpace: "nowrap" }}
              disabled={!mapsDraft.trim() || mapsValidating}
              onClick={async () => {
                setMapsValidating(true); setMapsKeyError(null);
                const result = await validateApiKey("google_maps", mapsDraft.trim()).catch(() => ({ ok: false, error: "Network error" }));
                setMapsValidating(false);
                if (!result.ok) { setMapsKeyError(result.error ?? "Invalid key"); return; }
                onUserSettingsChange({ ...userSettings, googleMapsApiKey: mapsDraft.trim() });
                setMapsDraft(""); setMapsEditing(false);
              }}>
              {mapsValidating ? "Checking…" : mapsEditing ? "Save" : "Connect"}
            </button>
            {mapsKeyError && <span style={{ width: "100%", fontSize: 11, color: "var(--error, #e53e3e)" }}>{mapsKeyError}</span>}
          </div>
        )}
        {!mapsEditing && !userSettings.googleMapsApiKey && googleMapsConnected && (
          <div style={{ fontSize: 11, color: "var(--muted)", padding: "3px 0 6px" }}>
            Server key configured.
            <button className="lp-ghost-btn" style={{ fontSize: 11, marginLeft: 8, padding: "2px 8px" }} onClick={() => setMapsEditing(true)}>Override</button>
          </div>
        )}

        <CustomToolsConnections userSettings={userSettings} onUserSettingsChange={onUserSettingsChange} />

      </>)}

      {/* WhatsApp QR Modal */}
      {showQR && (
        <div className="modal-overlay" onClick={() => { closeQRRef.current?.(); setShowQR(false); }}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 340, textAlign: "center" }}>
            <h3 style={{ marginBottom: 12, fontSize: 16 }}>Connect WhatsApp</h3>
            <p className="mcp-hint" style={{ marginBottom: 16 }}>
              Open WhatsApp → Linked Devices → Link a device → scan this QR code.
            </p>
            {qrError
              ? <div style={{ color: "#ef4444", marginBottom: 12 }}>{qrError}</div>
              : qrDataUrl
                ? <img src={qrDataUrl} alt="QR" style={{ width: 240, height: 240, borderRadius: 8, display: "block", margin: "0 auto 16px" }} />
                : <div className="skeleton" style={{ width: 240, height: 240, borderRadius: 8, margin: "0 auto 16px" }} />
            }
            <button className="automation-cancel-btn" onClick={() => { closeQRRef.current?.(); setShowQR(false); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Skills ────────────────────────────────────────────────────────────────────

function SkillsPanel({ agentConfig, onAgentConfigChange }: {
  agentConfig: AgentConfig | null;
  onAgentConfigChange: (c: AgentConfig) => void;
}) {
  const [list, setList] = useState<Skill[]>(agentConfig?.skills ?? []);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", content: "" });
  const [saved, setSaved] = useState(false);

  useEffect(() => { setList(agentConfig?.skills ?? []); }, [agentConfig]);

  const commit = (next: Skill[]) => {
    if (!agentConfig) return;
    const updated = { ...agentConfig, skills: next };
    onAgentConfigChange(updated);
    applyConfigLive({ skills: next }).catch(() => {});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const toggle = (id: string) => {
    const next = list.map((s) => s.id === id ? { ...s, enabled: !s.enabled } : s);
    setList(next); commit(next);
  };

  const startEdit = (s: Skill) => { setEditingId(s.id); setAdding(false); setDraft({ name: s.name, content: s.content }); };
  const cancelEdit = () => { setEditingId(null); setAdding(false); setDraft({ name: "", content: "" }); };

  const saveEdit = () => {
    if (!draft.name.trim()) return;
    const next = list.map((s) => s.id === editingId ? { ...s, ...draft } : s);
    setList(next); commit(next); cancelEdit();
  };

  const addSkill = () => {
    if (!draft.name.trim()) return;
    const next = [...list, { id: crypto.randomUUID(), ...draft, enabled: true }];
    setList(next); commit(next); cancelEdit();
  };

  const del = (id: string) => {
    const next = list.filter((s) => s.id !== id);
    setList(next); commit(next);
    if (editingId === id) cancelEdit();
  };

  return (
    <div className="lp-content">
      <p className="lp-hint">Skills add knowledge or instructions to the agent's context.</p>
      {saved && <div className="lp-saved-badge">✓ Saved</div>}

      {list.length === 0 && !adding && (
        <div className="lp-empty">No skills yet.</div>
      )}

      {list.map((s) => (
        <div key={s.id} className="lp-skill-row">
          {editingId === s.id ? (
            <div className="lp-skill-form">
              <input className="configure-input" placeholder="Name" value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} autoFocus />
              <textarea className="configure-textarea" rows={5} placeholder="Skill content…"
                value={draft.content} onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))} />
              <div className="lp-skill-form-actions">
                <button className="automation-cancel-btn" onClick={cancelEdit}>Cancel</button>
                <button className="lp-ghost-btn lp-danger" onClick={() => del(s.id)}>Delete</button>
                <button className="lp-save-btn" onClick={saveEdit}>Save</button>
              </div>
            </div>
          ) : (
            <div className="lp-skill-item">
              <label className="sidebar-toggle">
                <input type="checkbox" checked={s.enabled} onChange={() => toggle(s.id)} />
                <span className="sidebar-toggle-track" />
              </label>
              <div className="lp-skill-info" onClick={() => startEdit(s)}>
                <span className="lp-skill-name">{s.name}</span>
                <span className="lp-skill-preview">{s.content.slice(0, 70)}{s.content.length > 70 ? "…" : ""}</span>
              </div>
              <button className="api-copy-btn" onClick={() => startEdit(s)}>Edit</button>
            </div>
          )}
        </div>
      ))}

      {adding ? (
        <div className="lp-skill-form" style={{ marginTop: 8 }}>
          <input className="configure-input" placeholder="Skill name" value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} autoFocus />
          <textarea className="configure-textarea" rows={5}
            placeholder="Facts, instructions, or knowledge…"
            value={draft.content} onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))} />
          <div className="lp-skill-form-actions">
            <button className="automation-cancel-btn" onClick={cancelEdit}>Cancel</button>
            <button className="lp-save-btn" onClick={addSkill} disabled={!draft.name.trim()}>Add</button>
          </div>
        </div>
      ) : (
        <button className="lp-add-btn" onClick={() => { setAdding(true); setEditingId(null); setDraft({ name: "", content: "" }); }}>
          + Add Skill
        </button>
      )}
    </div>
  );
}

// ── Access ────────────────────────────────────────────────────────────────────

function AccessPanel({ userEmail }: { userEmail: string | null }) {
  const [apiKey, setApiKey] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => { getApiKey().then(setApiKey).catch(() => {}); }, []);

  const copy = (val: string, key: string) => {
    navigator.clipboard.writeText(val);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const baseUrl = BASE || window.location.origin;
  const curlBasic = `curl -X POST ${baseUrl}/api/chat \\\n  -H "Content-Type: application/json" \\\n  -H "x-api-key: ${apiKey || "YOUR_API_KEY"}" \\\n  -d '{"message": "Hello!", "history": []}'`;
  const curlWithUser = `curl -X POST ${baseUrl}/api/chat \\\n  -H "Content-Type: application/json" \\\n  -H "x-api-key: ${apiKey || "YOUR_API_KEY"}" \\\n  -d '{"message": "Send email…", "history": [], "userEmail": "${userEmail ?? "user@example.com"}"}'`;

  return (
    <div className="lp-content">
      <div className="lp-field">
        <label className="lp-label">Server URL</label>
        <div className="lp-copy-row">
          <code className="lp-copy-val">{baseUrl}</code>
          <button className="api-copy-btn" onClick={() => copy(baseUrl, "url")}>{copied === "url" ? "✓" : "Copy"}</button>
        </div>
      </div>

      {apiKey && (
        <div className="lp-field">
          <label className="lp-label">API Key</label>
          <div className="lp-copy-row">
            <code className="lp-copy-val">{"•".repeat(24)}</code>
            <button className="api-copy-btn" onClick={() => copy(apiKey, "key")}>{copied === "key" ? "✓" : "Copy"}</button>
          </div>
        </div>
      )}

      {userEmail && (
        <div className="lp-field">
          <label className="lp-label">Your email</label>
          <div className="lp-copy-row">
            <code className="lp-copy-val">{userEmail}</code>
            <button className="api-copy-btn" onClick={() => copy(userEmail, "email")}>{copied === "email" ? "✓" : "Copy"}</button>
          </div>
        </div>
      )}

      <div className="lp-field">
        <label className="lp-label">Basic request</label>
        <div className="api-code-block">
          <pre style={{ fontSize: 10, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{curlBasic}</pre>
          <button className="api-copy-btn api-copy-code" onClick={() => copy(curlBasic, "curl1")}>{copied === "curl1" ? "✓" : "Copy"}</button>
        </div>
      </div>

      <div className="lp-field">
        <label className="lp-label">With Gmail / Calendar access</label>
        <div className="api-code-block">
          <pre style={{ fontSize: 10, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{curlWithUser}</pre>
          <button className="api-copy-btn api-copy-code" onClick={() => copy(curlWithUser, "curl2")}>{copied === "curl2" ? "✓" : "Copy"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────

const PANEL_LABELS: Record<PanelId, string> = {
  brain: "Brain",
  connectors: "Connectors",
  skills: "Skills",
  access: "API Access",
};

export default function LeftPanel(props: LeftPanelProps) {
  const { panel, onClose, className, userEmail, userSettings, onUserSettingsChange, agentConfig, onAgentConfigChange,
    gmailConnected, calendarConnected, mondayConnected, tasksConnected,
    whatsappConnected, whatsappStatus, whatsappOwners, googleMapsConnected, connectionsLoading,
    onGmailDisconnect, onCalendarDisconnect, onMondayDisconnect, onTasksDisconnect,
    onWhatsappConnected, onWhatsappDisconnect } = props;

  return (
    <div className={`left-panel${className ? ` ${className}` : ""}`}>
      <div className="left-panel-header">
        <span className="left-panel-title">{PANEL_LABELS[panel]}</span>
        <button className="left-panel-close" onClick={onClose} title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div className="left-panel-body">
        {panel === "brain" && <BrainPanel userSettings={userSettings} onChange={onUserSettingsChange} agentConfig={agentConfig} />}
        {panel === "connectors" && (
          <ConnectorsPanel
            userEmail={userEmail} userSettings={userSettings} onUserSettingsChange={onUserSettingsChange}
            gmailConnected={gmailConnected} calendarConnected={calendarConnected} mondayConnected={mondayConnected}
            tasksConnected={tasksConnected} whatsappConnected={whatsappConnected} whatsappStatus={whatsappStatus}
            whatsappOwners={whatsappOwners} googleMapsConnected={googleMapsConnected} connectionsLoading={connectionsLoading}
            onGmailDisconnect={onGmailDisconnect} onCalendarDisconnect={onCalendarDisconnect}
            onMondayDisconnect={onMondayDisconnect} onTasksDisconnect={onTasksDisconnect}
            onWhatsappConnected={onWhatsappConnected} onWhatsappDisconnect={onWhatsappDisconnect}
          />
        )}
        {panel === "skills" && <SkillsPanel agentConfig={agentConfig} onAgentConfigChange={onAgentConfigChange} />}
        {panel === "access" && <AccessPanel userEmail={userEmail} />}
      </div>
    </div>
  );
}
