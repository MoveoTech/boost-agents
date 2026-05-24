import { useState, useEffect, useRef, useCallback } from "react";
import SidebarSection from "./SidebarSection";
import SkillsModal from "./SkillsModal";
import UsageAnalytics from "./UsageAnalytics";
import { saveConfig, applyConfigLive, getApiKey, listAutomations, saveAutomation, removeAutomation, triggerAutomation, getProviders, subscribeWhatsAppQR, getWhatsAppConfig, saveWhatsAppConfig, type WhatsAppConfig } from "../api/client";
import type { AgentConfig, Automation, Skill, UserSettings } from "../types";

const BASE = import.meta.env.VITE_API_URL ?? window.location.origin;

const MODELS = [
  { provider: "gemini", modelId: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { provider: "gemini", modelId: "gemini-2.5-pro",   label: "Gemini 2.5 Pro" },
  { provider: "gemini", modelId: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { provider: "claude", modelId: "claude-opus-4-7",           label: "Claude Opus 4.7" },
  { provider: "claude", modelId: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6" },
  { provider: "claude", modelId: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { provider: "openai", modelId: "gpt-4o",      label: "GPT-4o" },
  { provider: "openai", modelId: "gpt-4o-mini", label: "GPT-4o mini" },
  { provider: "openai", modelId: "o1",          label: "o1" },
  { provider: "openai", modelId: "o1-mini",     label: "o1 mini" },
] as const;

function SecretRow({ label, value, onCopy, copied, visible = false }: { label: string; value: string; onCopy: (v: string) => void; copied: boolean; visible?: boolean }) {
  const [show, setShow] = useState(false);
  const displayed = (visible || show) ? value : "•".repeat(Math.min(value.length, 24));
  return (
    <div className="sidebar-api-row">
      <span className="sidebar-api-label">{label}</span>
      <div className="sidebar-api-value-row">
        <code className="sidebar-api-value">{displayed}</code>
        {!visible && (
          <button className="api-copy-btn" onClick={() => setShow(v => !v)} style={{ marginRight: 4 }}>
            {show ? "Hide" : "Show"}
          </button>
        )}
        <button className="api-copy-btn" onClick={() => onCopy(value)}>{copied ? "✓" : "Copy"}</button>
      </div>
    </div>
  );
}

const TOOL_DEFS = [
  { key: "fetchUrl" as const, label: "Web Fetch", icon: "🌐", desc: "GET any URL" },
  { key: "httpRequest" as const, label: "HTTP Request", icon: "🔗", desc: "POST/PUT to REST APIs" },
  { key: "googleSearch" as const, label: "Google Search", icon: "🔍", desc: "Gemini built-in web search" },
  { key: "gmail" as const, label: "Gmail", icon: "📧", desc: "Send emails", service: "gmail" as const },
  { key: "googleCalendar" as const, label: "Google Calendar", icon: "📅", desc: "List, create calendar events", service: "calendar" as const },
  { key: "slack" as const, label: "Slack", icon: "💬", desc: "Send messages to channels — requires SLACK_BOT_TOKEN secret" },
  { key: "monday" as const, label: "Monday.com", icon: "📋", desc: "Read boards, create & update items", service: "monday" as const },
];

const SCHEDULES = [
  { label: "Every hour",         cron: "0 * * * *" },
  { label: "Daily at 6am UTC",   cron: "0 6 * * *" },
  { label: "Daily at 9am UTC",   cron: "0 9 * * *" },
  { label: "Weekly Mon 9am UTC", cron: "0 9 * * 1" },
  { label: "Custom…",            cron: "custom" },
];


function avatarColor(name: string) {
  const colors = ["#4f46e5","#0891b2","#059669","#d97706","#dc2626","#7c3aed","#db2777"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % colors.length;
  return colors[h];
}

interface Props {
  isAdmin: boolean;
  userEmail: string | null;
  agentConfig: AgentConfig | null;
  onSave: (config: AgentConfig) => void;
  userSettings: UserSettings;
  onUserSettingsChange: (s: UserSettings) => void;
  gmailConnected: boolean;
  calendarConnected: boolean;
  mondayConnected: boolean;
  tasksConnected: boolean;
  whatsappConnected: boolean;
  whatsappStatus?: "connected" | "disconnected" | "connecting" | "qr";
  whatsappOwners?: string[];
  onGmailDisconnect: () => void;
  onCalendarDisconnect: () => void;
  onMondayDisconnect: () => void;
  onTasksDisconnect: () => void;
  onWhatsappConnected: () => void;
  onWhatsappDisconnect: () => void;
  connectionsLoading?: boolean;
  className?: string;
  onFeedback?: (messageId: string, rating: 1 | -1) => void;
  isResponding?: boolean;
}

export default function AgentSidebar({ isAdmin, userEmail, agentConfig, onSave, userSettings, onUserSettingsChange, gmailConnected, calendarConnected, mondayConnected, tasksConnected, whatsappConnected, whatsappStatus, whatsappOwners, onGmailDisconnect, onCalendarDisconnect, onMondayDisconnect, onTasksDisconnect, onWhatsappConnected, onWhatsappDisconnect, connectionsLoading, className, isResponding }: Props) {
  const otherWhatsappOwner = whatsappOwners?.find((o) => o !== userEmail) ?? null;
  const merged = agentConfig ? {
    ...agentConfig,
    ...(userSettings.model ? { model: userSettings.model } : {}),
    ...(userSettings.systemPrompt !== undefined ? { systemPrompt: userSettings.systemPrompt } : {}),
  } : agentConfig;

  const [config, setConfig] = useState<AgentConfig | null>(merged);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [avatarUrl, setAvatarUrl] = useState(userSettings.avatar ?? "");
  const [publishing, setPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState<"idle" | "done" | "error">("idle");
  const [newAuto, setNewAuto] = useState<Automation | null>(null);
  const [customCron, setCustomCron] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [providers, setProviders] = useState({ gemini: true, claude: false, openai: false, slack: false });
  const [settingsTab, setSettingsTab] = useState<"personal" | "org">("personal");
  const [draftInstructions, setDraftInstructions] = useState<string | undefined>(userSettings.systemPrompt);
  const [showQR, setShowQR] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const closeQRRef = useRef<(() => void) | null>(null);
  const [waConfig, setWaConfig] = useState<WhatsAppConfig>({ replyTrigger: "mention", replyInGroups: true, replyInDMs: false });
  const [waConfigSaving, setWaConfigSaving] = useState(false);
  const [waConfigSaved, setWaConfigSaved] = useState(false);

  // Load config when already connected on mount
  useEffect(() => {
    if (whatsappConnected) {
      getWhatsAppConfig().then(setWaConfig).catch(() => {});
    }
  }, [whatsappConnected]);

  const handleSaveWaConfig = useCallback(async () => {
    setWaConfigSaving(true);
    try {
      await saveWhatsAppConfig(waConfig);
      setWaConfigSaved(true);
      setTimeout(() => setWaConfigSaved(false), 2000);
    } finally {
      setWaConfigSaving(false);
    }
  }, [waConfig]);

  const handleWhatsappConnect = useCallback(() => {
    setShowQR(true);
    setQrDataUrl(null);
    setQrError(null);
    const unsub = subscribeWhatsAppQR(
      (url) => setQrDataUrl(url),
      () => {
        setShowQR(false);
        onWhatsappConnected();
        unsub();
        getWhatsAppConfig().then(setWaConfig).catch(() => {});
      },
      (msg) => { setQrError(msg); },
    );
    closeQRRef.current = unsub;
  }, [onWhatsappConnected]);

  const handleQRClose = useCallback(() => {
    closeQRRef.current?.();
    setShowQR(false);
    setQrDataUrl(null);
    setQrError(null);
  }, []);
  const [personalSaved, setPersonalSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!agentConfig) return;
    setConfig({
      ...agentConfig,
      ...(userSettings.model ? { model: userSettings.model } : {}),
      ...(userSettings.systemPrompt !== undefined ? { systemPrompt: userSettings.systemPrompt } : {}),
    });
  }, [agentConfig]);
  useEffect(() => { if (userSettings.avatar) setAvatarUrl(userSettings.avatar); }, [userSettings.avatar]);
  // Sync instructions from server-loaded settings (async load arrives after mount)
  useEffect(() => { setDraftInstructions(userSettings.systemPrompt); }, [userSettings.systemPrompt]);
  useEffect(() => { listAutomations().then(setAutomations).catch(() => {}); }, []);
  useEffect(() => { getApiKey().then(setApiKey).catch(() => {}); }, []);
  useEffect(() => { getProviders().then(setProviders).catch(() => {}); }, []);

  if (!config) return (
    <aside className={`agent-sidebar${className ? ` ${className}` : ""}`}>
      <div style={{ padding: "20px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <div className="skeleton" style={{ width: 56, height: 56, borderRadius: 12, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 15, width: "60%", borderRadius: 4, marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 11, width: "80%", borderRadius: 4 }} />
          </div>
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i}>
            <div className="skeleton" style={{ height: 11, width: "40%", borderRadius: 4, marginBottom: 10 }} />
            <div className="skeleton" style={{ height: 36, borderRadius: 8 }} />
          </div>
        ))}
      </div>
    </aside>
  );

  // Global config update — applies immediately to the running server AND updates parent state
  const update = (patch: Partial<AgentConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    onSave(next);
    applyConfigLive(patch).catch(() => {});
  };

  const updateTool = (key: keyof AgentConfig["tools"], val: boolean) =>
    update({ tools: { ...config.tools, [key]: val } });

  const handlePublish = async () => {
    setPublishing(true);
    try {
      await saveConfig(config);
      setPublishStatus("done");
      setTimeout(() => setPublishStatus("idle"), 3000);
    } catch { setPublishStatus("error"); }
    finally { setPublishing(false); }
  };

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      setAvatarUrl(url);
      onUserSettingsChange({ ...userSettings, avatar: url } as UserSettings);
    };
    reader.readAsDataURL(file);
  };

  const handleSaveAutomation = async () => {
    if (!newAuto) return;
    await saveAutomation(newAuto);
    setAutomations((prev) => {
      const exists = prev.find((a) => a.id === newAuto.id);
      return exists ? prev.map((a) => a.id === newAuto.id ? newAuto : a) : [...prev, newAuto];
    });
    setNewAuto(null);
  };

  const handleDeleteAutomation = async (id: string) => {
    await removeAutomation(id);
    setAutomations((prev) => prev.filter((a) => a.id !== id));
  };

  const handleToggleAutomation = async (auto: Automation) => {
    const updated = { ...auto, enabled: !auto.enabled };
    await saveAutomation(updated);
    setAutomations((prev) => prev.map((a) => a.id === updated.id ? updated : a));
  };

  const handleRunNow = async (id: string) => {
    setRunningId(id);
    try { await triggerAutomation(id); }
    finally { setTimeout(() => setRunningId(null), 2000); }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const agentName = config.ui?.title ?? config.name ?? "Agent";
  const baseUrl = BASE || window.location.origin;
  const curlExample = `curl -X POST ${baseUrl}/api/chat \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{"message": "Hello!", "history": []}'`;
  const curlGmailExample = `curl -X POST ${baseUrl}/api/chat \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{"message": "Send an email...", "history": [], "userEmail": "user@example.com"}'`;

  const handleSavePersonal = () => {
    onUserSettingsChange({ ...userSettings, systemPrompt: draftInstructions });
    setPersonalSaved(true);
    setTimeout(() => setPersonalSaved(false), 2500);
  };

  const handleResetPersonal = () => {
    setDraftInstructions(undefined);
    onUserSettingsChange({ ...userSettings, model: undefined, systemPrompt: undefined });
  };

  // Stable connection service rows data — no sub-component to avoid remount-on-rerender
  const oauthServices = [
    { label: "Gmail",            icon: "📧", service: "gmail"     as const, connected: gmailConnected,    onDisconnect: onGmailDisconnect },
    { label: "Google Calendar",  icon: "📅", service: "calendar"  as const, connected: calendarConnected, onDisconnect: onCalendarDisconnect },
    { label: "Google Tasks",     icon: "✅", service: "tasks"     as const, connected: tasksConnected,    onDisconnect: onTasksDisconnect },
    { label: "Monday.com",       icon: "📋", service: "monday"    as const, connected: mondayConnected,   onDisconnect: onMondayDisconnect },
  ];

  return (
    <>
    <aside className={`agent-sidebar${className ? ` ${className}` : ""}`}>
      {/* Identity header — always visible */}
      <div className="sidebar-identity">
        <div className="sidebar-avatar-wrap">
          <div
            className={`sidebar-avatar${isResponding ? " avatar-responding" : ""}`}
            style={{ background: avatarUrl ? "transparent" : avatarColor(agentName) }}
            onClick={() => settingsTab === "org" && isAdmin && fileRef.current?.click()}
            title={settingsTab === "org" && isAdmin ? "Click to upload avatar" : undefined}
          >
            {avatarUrl
              ? <img src={avatarUrl} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : agentName[0]?.toUpperCase()}
          </div>
          {isAdmin && <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleAvatarUpload} />}
        </div>
        <div className="sidebar-identity-info">
          <span className="sidebar-name-input" style={{ cursor: "default" }}>{agentName}</span>
          {userEmail && <span className="sidebar-model-tag">{userEmail}</span>}
        </div>
      </div>

      {/* Tab switcher */}
      <div className="settings-tab-bar">
        <button
          className={`settings-tab-btn${settingsTab === "personal" ? " active" : ""}`}
          onClick={() => setSettingsTab("personal")}
        >
          My Settings
        </button>
        <button
          className={`settings-tab-btn${settingsTab === "org" ? " active" : ""}`}
          onClick={() => setSettingsTab("org")}
        >
          {isAdmin ? "Agent Settings" : "About this Agent"}
        </button>
      </div>

      {/* ── PERSONAL SETTINGS TAB ───────────────────────────────── */}
      {settingsTab === "personal" && (
        <>
          <SidebarSection title="My Model">
            <p className="mcp-hint" style={{ marginBottom: 8 }}>
              Override the agent's default model just for yourself.
            </p>
            <select
              className="configure-input"
              value={`${(userSettings.model ?? agentConfig?.model)?.provider ?? "gemini"}:${(userSettings.model ?? agentConfig?.model)?.modelId ?? "gemini-2.5-flash"}`}
              onChange={(e) => {
                const [provider, ...rest] = e.target.value.split(":") as [AgentConfig["model"]["provider"], ...string[]];
                onUserSettingsChange({ ...userSettings, model: { provider, modelId: rest.join(":") } });
              }}
            >
              {(["gemini", "claude", "openai"] as const).map((p) => (
                <optgroup key={p} label={p === "gemini" ? "Gemini" : p === "claude" ? "Claude" : "OpenAI"}>
                  {MODELS.filter((m) => m.provider === p).map((m) => (
                    <option key={m.modelId} value={`${m.provider}:${m.modelId}`} disabled={!providers[p]}>
                      {m.label}{!providers[p] ? " — API key not set" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </SidebarSection>

          <SidebarSection title="My Instructions">
            <p className="mcp-hint" style={{ marginBottom: 8 }}>
              Override the agent's default behavior just for yourself.
            </p>
            <textarea
              className="configure-textarea sidebar-instructions"
              rows={6}
              placeholder={agentConfig?.systemPrompt ?? "Define your personal behavior override…"}
              value={draftInstructions ?? userSettings.systemPrompt ?? ""}
              onChange={(e) => setDraftInstructions(e.target.value)}
            />
          </SidebarSection>

          <SidebarSection title="My Connections">
            {connectionsLoading ? (
              [1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="sidebar-tool-row" style={{ alignItems: "center" }}>
                  <div className="skeleton" style={{ width: 20, height: 20, borderRadius: 4, flexShrink: 0 }} />
                  <div style={{ flex: 1, marginLeft: 10 }}>
                    <div className="skeleton" style={{ height: 13, width: "55%", borderRadius: 4, marginBottom: 5 }} />
                    <div className="skeleton" style={{ height: 11, width: "35%", borderRadius: 4 }} />
                  </div>
                </div>
              ))
            ) : (<>
              {oauthServices.map(({ label, icon, service, connected, onDisconnect }) => {
                const href = service === "monday"
                  ? `${BASE}/api/auth/monday/start?returnUrl=${encodeURIComponent(window.location.origin)}`
                  : `${BASE}/api/auth/google/start?service=${service}&returnUrl=${encodeURIComponent(window.location.origin)}`;
                return (
                  <div key={service} className="sidebar-tool-row">
                    <div className="sidebar-tool-info">
                      <span className="sidebar-tool-icon">{icon}</span>
                      <div className="sidebar-tool-text">
                        <span className="sidebar-tool-name">{label}</span>
                        <span className="sidebar-tool-connection">
                          {connected
                            ? <><span className="sidebar-tool-connected">●</span> {userEmail?.split("@")[0] ?? "connected"}</>
                            : userEmail
                              ? <a className="sidebar-tool-connect-link" href={href}>Connect</a>
                              : <span className="sidebar-tool-connect-link" style={{ opacity: 0.4, cursor: "default" }} title="Sign in with Google first to connect services">Connect</span>}
                          {connected && <button className="sidebar-tool-disconnect" onClick={onDisconnect}>Disconnect</button>}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* WhatsApp — QR-based */}
              <div className="sidebar-tool-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 0 }}>
                <div className="sidebar-tool-info">
                  <span className="sidebar-tool-icon">💬</span>
                  <div className="sidebar-tool-text">
                    <span className="sidebar-tool-name">WhatsApp</span>
                    <span className="sidebar-tool-connection">
                      {whatsappConnected ? (
                        <><span className="sidebar-tool-connected">●</span> {userEmail?.split("@")[0] ?? "connected"}</>
                      ) : whatsappStatus === "connecting" || whatsappStatus === "qr" ? (
                        <span style={{ opacity: 0.7 }}>⟳ establishing connection…</span>
                      ) : otherWhatsappOwner ? (
                        <span style={{ opacity: 0.6, fontStyle: "italic" }}>Already connected to {otherWhatsappOwner}</span>
                      ) : (
                        <button className="sidebar-tool-connect-link" style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }} onClick={handleWhatsappConnect}>Connect</button>
                      )}
                      {whatsappConnected && <button className="sidebar-tool-disconnect" onClick={onWhatsappDisconnect}>Disconnect</button>}
                    </span>
                  </div>
                </div>

                {whatsappConnected && (
                  <div className="wa-config">
                    <div className="wa-config-row">
                      <label className="wa-config-label">Reply when</label>
                      <select
                        className="configure-input"
                        value={waConfig.replyTrigger}
                        onChange={(e) => setWaConfig((c) => ({ ...c, replyTrigger: e.target.value as WhatsAppConfig["replyTrigger"] }))}
                      >
                        <option value="mention">@mentioned in a group</option>
                        <option value="keyword">Message contains keyword</option>
                        <option value="always">Any message (all chats)</option>
                      </select>
                    </div>

                    {waConfig.replyTrigger === "keyword" && (
                      <input
                        className="configure-input"
                        placeholder="Keyword (e.g. urgent, boost, help)"
                        value={waConfig.keyword ?? ""}
                        onChange={(e) => setWaConfig((c) => ({ ...c, keyword: e.target.value }))}
                      />
                    )}

                    <div className="wa-config-row" style={{ gap: 12 }}>
                      <label className="wa-config-label">Reply in</label>
                      <label className="wa-checkbox-label">
                        <input type="checkbox" checked={waConfig.replyInGroups} onChange={(e) => setWaConfig((c) => ({ ...c, replyInGroups: e.target.checked }))} />
                        Groups
                      </label>
                      <label className="wa-checkbox-label">
                        <input type="checkbox" checked={waConfig.replyInDMs} onChange={(e) => setWaConfig((c) => ({ ...c, replyInDMs: e.target.checked }))} />
                        DMs
                      </label>
                    </div>

                    <div className="wa-config-row" style={{ gap: 12 }}>
                      <label className="wa-config-label">Sender</label>
                      <label className="wa-checkbox-label">
                        <input type="checkbox" checked={!!waConfig.ownerOnly} onChange={(e) => setWaConfig((c) => ({ ...c, ownerOnly: e.target.checked }))} />
                        Only reply to my own messages
                      </label>
                    </div>

                    <div className="wa-config-row">
                      <label className="wa-config-label">Model</label>
                      <select
                        className="configure-input"
                        value={waConfig.model ? `${waConfig.model.provider}:${waConfig.model.modelId}` : ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (!val) {
                            setWaConfig((c) => { const { model: _, ...rest } = c; return rest as typeof c; });
                          } else {
                            const [provider, modelId] = val.split(":") as ["gemini" | "claude" | "openai", string];
                            setWaConfig((c) => ({ ...c, model: { provider, modelId } }));
                          }
                        }}
                      >
                        <option value="">Gemini Flash (default — most reliable)</option>
                        <option value="gemini:gemini-2.5-flash">Gemini 2.5 Flash</option>
                        <option value="claude:claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                        <option value="claude:claude-sonnet-4-6">Claude Sonnet 4.6</option>
                      </select>
                    </div>

                    <textarea
                      className="configure-textarea"
                      rows={3}
                      placeholder="Custom persona for WhatsApp (optional). E.g. 'Keep replies under 2 sentences. Always be friendly.'"
                      value={waConfig.customPrompt ?? ""}
                      onChange={(e) => setWaConfig((c) => ({ ...c, customPrompt: e.target.value }))}
                      style={{ fontSize: 12 }}
                    />

                    <button
                      className="sidebar-save-btn"
                      onClick={handleSaveWaConfig}
                      disabled={waConfigSaving}
                      style={{ marginTop: 4, fontSize: 12 }}
                    >
                      {waConfigSaved ? "Saved ✓" : waConfigSaving ? "Saving…" : "Save settings"}
                    </button>
                  </div>
                )}
              </div>
            </>)}
          </SidebarSection>

          {/* Personal save footer */}
          <div className="sidebar-footer">
            {(userSettings.model || userSettings.systemPrompt) && (
              <button className="automation-cancel-btn" style={{ fontSize: 12 }} onClick={handleResetPersonal}>
                Reset to org defaults
              </button>
            )}
            <button
              className="sidebar-publish-btn"
              style={{ background: personalSaved ? "#16a34a" : undefined }}
              onClick={handleSavePersonal}
            >
              {personalSaved ? "✓ Saved" : "Save My Settings"}
            </button>
          </div>
        </>
      )}

      {/* ── AGENT SETTINGS TAB ──────────────────────────────────── */}
      {settingsTab === "org" && (
        <>
          {/* Automations — admin only */}
          {isAdmin && (
        <SidebarSection
          title="Automations"
          action={
            <button className="sidebar-add-btn" onClick={() => {
              setCustomCron(false);
              setNewAuto({ id: crypto.randomUUID(), name: "", schedule: "0 9 * * *", prompt: "", enabled: true, createdBy: userEmail ?? undefined, oneTime: false });
            }}>+ Add</button>
          }
        >
          {automations.length === 0 && !newAuto && (
            <p className="sidebar-empty">No automations yet. Add one to run tasks on a schedule.</p>
          )}
          {automations.map((a) => (
            <div key={a.id} className="sidebar-automation-row">
              <div className="sidebar-automation-info">
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="sidebar-automation-name">{a.name || "Unnamed"}</span>
                  {a.createdBy && (
                    <span className="sidebar-automation-owner" title={a.createdBy}>
                      {a.createdBy.split("@")[0]}
                    </span>
                  )}
                </div>
                <span className="sidebar-automation-schedule">
                  {a.oneTime ? "Runs once" : (SCHEDULES.find((s) => s.cron === a.schedule)?.label ?? a.schedule)}
                </span>
              </div>
              <div className="sidebar-automation-actions">
                <button
                  className="sidebar-run-btn"
                  onClick={() => handleRunNow(a.id)}
                  title="Run now"
                  disabled={runningId === a.id}
                >
                  {runningId === a.id ? "…" : "▶"}
                </button>
                <input type="checkbox" checked={a.enabled} onChange={() => handleToggleAutomation(a)}
                  className="configure-checkbox" title={a.enabled ? "Enabled" : "Paused"} />
                <button className="automation-delete-btn" onClick={() => handleDeleteAutomation(a.id)}>✕</button>
              </div>
            </div>
          ))}

          {newAuto && (
            <div className="sidebar-automation-form">
              <input className="configure-input" placeholder="Name" value={newAuto.name}
                onChange={(e) => setNewAuto({ ...newAuto, name: e.target.value })} />

              <label className="sidebar-onetime-toggle">
                <input type="checkbox" checked={!!newAuto.oneTime}
                  onChange={(e) => setNewAuto({ ...newAuto, oneTime: e.target.checked })} />
                <span>Run once</span>
              </label>

              {newAuto.oneTime ? (
                <input className="configure-input" type="datetime-local"
                  onChange={(e) => {
                    const d = new Date(e.target.value);
                    const cron = `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *`;
                    setNewAuto({ ...newAuto, schedule: cron });
                  }} />
              ) : (
                <>
                  <select className="configure-input" value={customCron ? "custom" : newAuto.schedule}
                    onChange={(e) => {
                      if (e.target.value === "custom") setCustomCron(true);
                      else { setCustomCron(false); setNewAuto({ ...newAuto, schedule: e.target.value }); }
                    }}>
                    {SCHEDULES.map((s) => <option key={s.cron} value={s.cron}>{s.label}</option>)}
                  </select>
                  {customCron && (
                    <input className="configure-input" placeholder="0 9 * * 1-5" value={newAuto.schedule}
                      onChange={(e) => setNewAuto({ ...newAuto, schedule: e.target.value })} />
                  )}
                </>
              )}
              <textarea className="configure-textarea" rows={3} placeholder="Describe what the agent should do…"
                value={newAuto.prompt} onChange={(e) => setNewAuto({ ...newAuto, prompt: e.target.value })} />
              <div className="sidebar-automation-form-actions">
                <button className="automation-cancel-btn" onClick={() => setNewAuto(null)}>Cancel</button>
                <button className="sidebar-save-btn" onClick={handleSaveAutomation}>Save</button>
              </div>
            </div>
          )}
        </SidebarSection>
      )}

          {/* Org default model — admin editable */}
          {isAdmin ? (
            <SidebarSection title="Default Model">
              <select
                className="configure-input"
                value={`${agentConfig?.model?.provider ?? "gemini"}:${agentConfig?.model?.modelId ?? "gemini-2.5-flash"}`}
                onChange={(e) => {
                  const [provider, ...rest] = e.target.value.split(":") as [AgentConfig["model"]["provider"], ...string[]];
                  update({ model: { provider, modelId: rest.join(":") } });
                }}
              >
                {(["gemini", "claude", "openai"] as const).map((p) => (
                  <optgroup key={p} label={p === "gemini" ? "Gemini" : p === "claude" ? "Claude" : "OpenAI"}>
                    {MODELS.filter((m) => m.provider === p).map((m) => (
                      <option key={m.modelId} value={`${m.provider}:${m.modelId}`} disabled={!providers[p]}>
                        {m.label}{!providers[p] ? " — API key not set" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </SidebarSection>
          ) : (
            <div style={{ padding: "12px 16px", fontSize: 13, color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>
              <strong style={{ color: "var(--text)" }}>{agentName}</strong> — {agentConfig?.model?.modelId ?? "Gemini 2.5 Flash"}
            </div>
          )}

          {/* Org default instructions + starter prompts — admin editable */}
          {isAdmin && (
            <SidebarSection title="Default Instructions">
              <textarea
                className="configure-textarea sidebar-instructions"
                rows={5}
                placeholder="Define the agent's default behavior for all users…"
                value={agentConfig?.systemPrompt ?? ""}
                onChange={(e) => update({ systemPrompt: e.target.value })}
              />
            </SidebarSection>
          )}

          {/* Tool toggles — admin only */}
          {isAdmin && (
            <SidebarSection title="Tools">
              {TOOL_DEFS.filter((t) => !t.service).map(({ key, label, icon, desc }) => {
                const isSlack = key === "slack";
                const slackConfigured = providers.slack;
                return (
                  <div key={key} className="sidebar-tool-row">
                    <div className="sidebar-tool-info">
                      <span className="sidebar-tool-icon">{icon}</span>
                      <div className="sidebar-tool-text">
                        <span className="sidebar-tool-name">{label}</span>
                        <span className="sidebar-tool-desc">
                          {isSlack && !slackConfigured
                            ? <span style={{ color: "#d97706" }}>⚠ SLACK_BOT_TOKEN not set</span>
                            : desc}
                        </span>
                      </div>
                    </div>
                    <label className="sidebar-toggle">
                      <input
                        type="checkbox"
                        checked={isSlack ? (slackConfigured && config.tools[key]) : config.tools[key]}
                        disabled={isSlack && !slackConfigured}
                        onChange={(e) => updateTool(key, e.target.checked)}
                      />
                      <span className="sidebar-toggle-track" />
                    </label>
                  </div>
                );
              })}
            </SidebarSection>
          )}

          {/* Skills — admin only */}
          {isAdmin && (
            <SidebarSection title="Skills" defaultOpen={false}>
              {(config.skills ?? []).filter(s => s.enabled).length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  {(config.skills ?? []).filter(s => s.enabled).map(s => (
                    <div key={s.id} className="sidebar-automation-row" style={{ marginBottom: 4 }}>
                      <span className="sidebar-automation-name">{s.name}</span>
                    </div>
                  ))}
                </div>
              )}
              <button className="sidebar-add-skill-btn" onClick={() => setShowSkills(true)}>
                {(config.skills ?? []).length > 0 ? "Manage Skills" : "+ Add skill"}
              </button>
            </SidebarSection>
          )}

          {showSkills && (
            <SkillsModal
              skills={config.skills ?? []}
              onSave={(skills: Skill[]) => { update({ skills }); setShowSkills(false); }}
              onClose={() => setShowSkills(false)}
            />
          )}

          {/* API Access — admin only */}
          {isAdmin && (
            <SidebarSection
              title="API Access"
              defaultOpen={false}
              action={
                <button className="sidebar-analytics-btn" onClick={() => setShowAnalytics(true)}>
                  📊 Analytics
                </button>
              }
            >
              <SecretRow label="Server URL" value={baseUrl} onCopy={copy} copied={copied} visible />
              {apiKey && <SecretRow label="API Key" value={apiKey} onCopy={copy} copied={copied} />}
              {userEmail && <SecretRow label="Your email" value={userEmail} onCopy={copy} copied={copied} visible />}
              <div className="api-code-block" style={{ marginTop: 12 }}>
                <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>Basic request</p>
                <pre>{curlExample}</pre>
                <button className="api-copy-btn api-copy-code" onClick={() => copy(curlExample)}>{copied ? "✓" : "Copy"}</button>
              </div>
              <div className="api-code-block" style={{ marginTop: 8 }}>
                <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>With Gmail/Calendar access</p>
                <pre>{curlGmailExample}</pre>
                <button className="api-copy-btn api-copy-code" onClick={() => copy(curlGmailExample)}>{copied ? "✓" : "Copy"}</button>
              </div>
            </SidebarSection>
          )}

          {showAnalytics && <UsageAnalytics onClose={() => setShowAnalytics(false)} />}

          {/* Org footer — Publish Changes (admin only) */}
          {isAdmin && (
            <div className="sidebar-footer">
              {publishStatus === "done" && <span className="sidebar-publish-success">✓ Published</span>}
              {publishStatus === "error" && <span className="sidebar-publish-error">Publish failed</span>}
              <button className="sidebar-publish-btn" onClick={handlePublish} disabled={publishing}>
                {publishing ? "Publishing…" : "Publish Changes"}
              </button>
            </div>
          )}
        </>
      )}
    </aside>

    {/* WhatsApp QR Modal */}
    {showQR && (
      <div className="modal-overlay" onClick={handleQRClose}>
        <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 340, textAlign: "center" }}>
          <h3 style={{ marginBottom: 12, fontSize: 16 }}>Connect WhatsApp</h3>
          <p className="mcp-hint" style={{ marginBottom: 16 }}>
            Open WhatsApp on your phone → Linked Devices → Link a device → scan this QR code.
          </p>
          {qrError ? (
            <div style={{ color: "var(--error, #ef4444)", marginBottom: 12 }}>{qrError}</div>
          ) : qrDataUrl ? (
            <img src={qrDataUrl} alt="WhatsApp QR code" style={{ width: 240, height: 240, borderRadius: 8, display: "block", margin: "0 auto 16px" }} />
          ) : (
            <div className="skeleton" style={{ width: 240, height: 240, borderRadius: 8, margin: "0 auto 16px" }} />
          )}
          <button className="automation-cancel-btn" onClick={handleQRClose}>Cancel</button>
        </div>
      </div>
    )}
    </>
  );
}
