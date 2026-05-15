import { useState, useEffect, useRef } from "react";
import SidebarSection from "./SidebarSection";
import SkillsModal from "./SkillsModal";
import { saveConfig, getApiKey, listAutomations, saveAutomation, removeAutomation, triggerAutomation, getProviders } from "../api/client";
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
  onGmailDisconnect: () => void;
  onCalendarDisconnect: () => void;
  className?: string;
}

export default function AgentSidebar({ isAdmin, userEmail, agentConfig, onSave, userSettings, onUserSettingsChange, gmailConnected, calendarConnected, onGmailDisconnect, onCalendarDisconnect, className }: Props) {
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
  const [providers, setProviders] = useState({ gemini: true, claude: false, openai: false });
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
  useEffect(() => { listAutomations().then(setAutomations).catch(() => {}); }, []);
  useEffect(() => { getApiKey().then(setApiKey).catch(() => {}); }, []);
  useEffect(() => { getProviders().then(setProviders).catch(() => {}); }, []);

  if (!config) return <div className="sidebar-loading">Loading…</div>;

  // Global config update (admin only — tool toggles, name, skills, etc.)
  const update = (patch: Partial<AgentConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    onSave(next);
  };

  // Personal update — saves to userSettings (server-side via Firestore), not global config
  const updatePersonal = (patch: { model?: AgentConfig["model"]; systemPrompt?: string }) => {
    const next = { ...config, ...patch };
    setConfig(next);
    const newSettings = { ...userSettings, ...patch };
    onUserSettingsChange(newSettings);
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
  const curlExample = `curl -X POST ${BASE}/api/chat \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{"message": "Hello!", "history": []}'`;

  return (
    <aside className={`agent-sidebar${className ? ` ${className}` : ""}`}>
      {/* Identity — editable for admins, display-only for users */}
      <div className="sidebar-identity">
        <div className="sidebar-avatar-wrap">
          <div
            className="sidebar-avatar"
            style={{ background: avatarUrl ? "transparent" : avatarColor(agentName) }}
            onClick={() => isAdmin && fileRef.current?.click()}
            title={isAdmin ? "Click to upload avatar" : undefined}
          >
            {avatarUrl
              ? <img src={avatarUrl} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : agentName[0]?.toUpperCase()}
          </div>
          {isAdmin && <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleAvatarUpload} />}
        </div>
        <div className="sidebar-identity-info">
          {isAdmin ? (
            <input
              className="sidebar-name-input"
              value={agentName}
              onChange={(e) => update({ name: e.target.value, ui: { ...config.ui, title: e.target.value } })}
              placeholder="Agent name"
            />
          ) : (
            <span className="sidebar-name-input" style={{ cursor: "default" }}>{agentName}</span>
          )}
          <span className="sidebar-model-tag">Gemini 2.5 Flash</span>
        </div>
      </div>

      {/* Logged-in user */}
      {userEmail && (
        <div className="sidebar-user-row">
          <span className="sidebar-user-avatar" style={{ background: avatarColor(userEmail) }}>
            {userEmail[0].toUpperCase()}
          </span>
          <span className="sidebar-user-email">{userEmail}</span>
        </div>
      )}

      {/* Automations — admin only */}
      {isAdmin && (
        <SidebarSection
          title="Automations"
          action={
            <button className="sidebar-add-btn" onClick={() => {
              setCustomCron(false);
              setNewAuto({ id: crypto.randomUUID(), name: "", schedule: "0 9 * * *", prompt: "", enabled: true, createdBy: userEmail ?? undefined });
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
                  {SCHEDULES.find((s) => s.cron === a.schedule)?.label ?? a.schedule}
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

      {/* Model — visible to everyone, saves to personal settings */}
      <SidebarSection title="Model">
        <select
          className="configure-input"
          value={`${config.model?.provider ?? "gemini"}:${config.model?.modelId ?? "gemini-2.5-flash"}`}
          onChange={(e) => {
            const [provider, ...rest] = e.target.value.split(":") as [AgentConfig["model"]["provider"], ...string[]];
            updatePersonal({ model: { provider, modelId: rest.join(":") } });
          }}
        >
          {(["gemini", "claude", "openai"] as const).map((p) => (
            <optgroup key={p} label={p === "gemini" ? "Gemini" : p === "claude" ? "Claude (Anthropic)" : "OpenAI"}>
              {MODELS.filter((m) => m.provider === p).map((m) => (
                <option key={m.modelId} value={`${m.provider}:${m.modelId}`} disabled={!providers[p]}>
                  {m.label}{!providers[p] ? " — API key not set" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {userSettings.model && (
          <button className="automation-cancel-btn" style={{ marginTop: 6, fontSize: 12 }}
            onClick={() => updatePersonal({ model: undefined })}>
            Reset to default
          </button>
        )}
      </SidebarSection>

      {/* Instructions — visible to everyone, saves to personal settings */}
      <SidebarSection title="Instructions">
        <textarea
          className="configure-textarea sidebar-instructions"
          rows={6}
          placeholder="Define your agent's behavior…"
          value={config.systemPrompt}
          onChange={(e) => updatePersonal({ systemPrompt: e.target.value })}
        />
        {userSettings.systemPrompt !== undefined && !isAdmin && (
          <button className="automation-cancel-btn" style={{ marginTop: 6, fontSize: 12 }}
            onClick={() => updatePersonal({ systemPrompt: undefined })}>
            Reset to default
          </button>
        )}
      </SidebarSection>

      {/* Tools — toggle admin-only, Google connect/disconnect for everyone */}
      <SidebarSection title={isAdmin ? "Tools" : "Connections"}>
        {TOOL_DEFS.map(({ key, label, icon, desc, service }) => {
          const connected = service === "gmail" ? gmailConnected : service === "calendar" ? calendarConnected : false;
          const onDisconnect = service === "gmail" ? onGmailDisconnect : service === "calendar" ? onCalendarDisconnect : null;
          if (!isAdmin && !service) return null;
          return (
            <div key={key} className="sidebar-tool-row">
              <div className="sidebar-tool-info">
                <span className="sidebar-tool-icon">{icon}</span>
                <div className="sidebar-tool-text">
                  <span className="sidebar-tool-name">{label}</span>
                  {service && (
                    <span className="sidebar-tool-connection">
                      {connected
                        ? <><span className="sidebar-tool-connected">●</span> {userEmail?.split("@")[0] ?? "connected"}</>
                        : <a className="sidebar-tool-connect-link" href={`${BASE}/api/auth/google/start?service=${service}&returnUrl=${encodeURIComponent(window.location.origin)}`}>Connect</a>
                      }
                      {connected && onDisconnect && (
                        <button className="sidebar-tool-disconnect" onClick={onDisconnect}>Disconnect</button>
                      )}
                    </span>
                  )}
                  {!service && <span className="sidebar-tool-desc">{desc}</span>}
                </div>
              </div>
              {isAdmin && (
                <label className="sidebar-toggle">
                  <input type="checkbox"
                    checked={service ? connected || config.tools[key] : config.tools[key]}
                    onChange={(e) => { if (!service || !connected) updateTool(key, e.target.checked); }}
                    readOnly={!!(service && connected)}
                  />
                  <span className="sidebar-toggle-track" />
                </label>
              )}
            </div>
          );
        })}
      </SidebarSection>

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
        <SidebarSection title="API Access" defaultOpen={false}>
          <SecretRow label="Server URL" value={BASE || window.location.origin} onCopy={copy} copied={copied} visible />
          {apiKey && <SecretRow label="API Key" value={apiKey} onCopy={copy} copied={copied} />}
          <div className="api-code-block" style={{ marginTop: 12 }}>
            <pre>{curlExample}</pre>
            <button className="api-copy-btn api-copy-code" onClick={() => copy(curlExample)}>{copied ? "✓" : "Copy"}</button>
          </div>
        </SidebarSection>
      )}

      {/* Footer — publish admin only */}
      {isAdmin && (
        <div className="sidebar-footer">
          {publishStatus === "done" && <span className="sidebar-publish-success">✓ Published</span>}
          {publishStatus === "error" && <span className="sidebar-publish-error">Publish failed</span>}
          <button className="sidebar-publish-btn" onClick={handlePublish} disabled={publishing}>
            {publishing ? "Publishing…" : "Publish Changes"}
          </button>
        </div>
      )}
    </aside>
  );
}
