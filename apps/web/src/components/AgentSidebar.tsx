import { useState, useEffect, useRef } from "react";
import SidebarSection from "./SidebarSection";
import { saveConfig, getApiKey, listAutomations, saveAutomation, removeAutomation, triggerAutomation } from "../api/client";
import type { AgentConfig, Automation } from "../types";

const BASE = import.meta.env.VITE_API_URL ?? window.location.origin;
const STORAGE_KEY = "agent_config";
const AVATAR_KEY = "agent_avatar";

const TOOL_DEFS = [
  { key: "fetchUrl" as const, label: "Web Fetch", icon: "🌐", desc: "GET any URL" },
  { key: "httpRequest" as const, label: "HTTP Request", icon: "🔗", desc: "POST/PUT to REST APIs" },
  { key: "googleSearch" as const, label: "Google Search", icon: "🔍", desc: "Gemini built-in web search" },
  { key: "codeExecution" as const, label: "Code Execution", icon: "🐍", desc: "Run Python (Gemini built-in)" },
  { key: "gmail" as const, label: "Gmail", icon: "📧", desc: "Send, search, read emails", service: "gmail" as const },
  { key: "googleCalendar" as const, label: "Google Calendar", icon: "📅", desc: "List, create calendar events", service: "calendar" as const },
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
  agentConfig: AgentConfig | null;
  onSave: (config: AgentConfig) => void;
  gmailUser: string | null;
  calendarUser: string | null;
  onGmailDisconnect: () => void;
  onCalendarDisconnect: () => void;
}

export default function AgentSidebar({ agentConfig, onSave, gmailUser, calendarUser, onGmailDisconnect, onCalendarDisconnect }: Props) {
  const [config, setConfig] = useState<AgentConfig | null>(agentConfig);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [avatarUrl, setAvatarUrl] = useState(() => localStorage.getItem(AVATAR_KEY) ?? "");
  const [publishing, setPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState<"idle" | "done" | "error">("idle");
  const [newAuto, setNewAuto] = useState<Automation | null>(null);
  const [customCron, setCustomCron] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setConfig(agentConfig); }, [agentConfig]);
  useEffect(() => { listAutomations().then(setAutomations).catch(() => {}); }, []);
  useEffect(() => { getApiKey().then(setApiKey).catch(() => {}); }, []);

  if (!config) return <div className="sidebar-loading">Loading…</div>;

  const update = (patch: Partial<AgentConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    onSave(next);
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
      localStorage.setItem(AVATAR_KEY, url);
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
    <aside className="agent-sidebar">
      {/* Identity */}
      <div className="sidebar-identity">
        <div className="sidebar-avatar-wrap">
          <div
            className="sidebar-avatar"
            style={{ background: avatarUrl ? "transparent" : avatarColor(agentName) }}
            onClick={() => fileRef.current?.click()}
            title="Click to upload avatar"
          >
            {avatarUrl
              ? <img src={avatarUrl} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : agentName[0]?.toUpperCase()}
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleAvatarUpload} />
        </div>
        <div className="sidebar-identity-info">
          <input
            className="sidebar-name-input"
            value={agentName}
            onChange={(e) => update({ name: e.target.value, ui: { ...config.ui, title: e.target.value } })}
            placeholder="Agent name"
          />
          <span className="sidebar-model-tag">Gemini 2.5 Flash</span>
        </div>
      </div>

      {/* Automations */}
      <SidebarSection
        title="Automations"
        action={
          <button className="sidebar-add-btn" onClick={() => {
            setCustomCron(false);
            setNewAuto({ id: crypto.randomUUID(), name: "", schedule: "0 9 * * *", prompt: "", enabled: true });
          }}>+ Add</button>
        }
      >
        {automations.length === 0 && !newAuto && (
          <p className="sidebar-empty">No automations yet. Add one to run tasks on a schedule.</p>
        )}
        {automations.map((a) => (
          <div key={a.id} className="sidebar-automation-row">
            <div className="sidebar-automation-info">
              <span className="sidebar-automation-name">{a.name || "Unnamed"}</span>
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

      {/* Instructions */}
      <SidebarSection title="Instructions">
        <textarea
          className="configure-textarea sidebar-instructions"
          rows={6}
          placeholder="Define your agent's operating framework. Who is it? What can it do?"
          value={config.systemPrompt}
          onChange={(e) => update({ systemPrompt: e.target.value })}
        />
      </SidebarSection>

      {/* Tools */}
      <SidebarSection title="Tools">
        {TOOL_DEFS.map(({ key, label, icon, desc, service }) => {
          const connected = service === "gmail" ? gmailUser : service === "calendar" ? calendarUser : null;
          const onDisconnect = service === "gmail" ? onGmailDisconnect : service === "calendar" ? onCalendarDisconnect : null;
          return (
            <div key={key} className="sidebar-tool-row">
              <div className="sidebar-tool-info">
                <span className="sidebar-tool-icon">{icon}</span>
                <div className="sidebar-tool-text">
                  <span className="sidebar-tool-name">{label}</span>
                  {service && (
                    <span className="sidebar-tool-connection">
                      {connected
                        ? <><span className="sidebar-tool-connected">●</span> {connected.split("@")[0]}</>
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
              <label className="sidebar-toggle">
                <input type="checkbox" checked={config.tools[key]} onChange={(e) => updateTool(key, e.target.checked)} />
                <span className="sidebar-toggle-track" />
              </label>
            </div>
          );
        })}
      </SidebarSection>

      {/* Skills */}
      <SidebarSection title="Skills" defaultOpen={false}>
        <button className="sidebar-add-skill-btn">+ Add skill</button>
      </SidebarSection>

      {/* API Access */}
      <SidebarSection title="API Access" defaultOpen={false}>
        <div className="sidebar-api-row">
          <span className="sidebar-api-label">Server URL</span>
          <div className="sidebar-api-value-row">
            <code className="sidebar-api-value">{BASE}</code>
            <button className="api-copy-btn" onClick={() => copy(BASE)}>{copied ? "✓" : "Copy"}</button>
          </div>
        </div>
        {apiKey && (
          <div className="sidebar-api-row">
            <span className="sidebar-api-label">API Key</span>
            <div className="sidebar-api-value-row">
              <code className="sidebar-api-value">{apiKey}</code>
              <button className="api-copy-btn" onClick={() => copy(apiKey)}>{copied ? "✓" : "Copy"}</button>
            </div>
          </div>
        )}
        <div className="api-code-block" style={{ marginTop: 10 }}>
          <pre>{curlExample}</pre>
          <button className="api-copy-btn api-copy-code" onClick={() => copy(curlExample)}>{copied ? "✓" : "Copy"}</button>
        </div>
      </SidebarSection>

      {/* Footer */}
      <div className="sidebar-footer">
        {publishStatus === "done" && <span className="sidebar-publish-success">✓ Published</span>}
        {publishStatus === "error" && <span className="sidebar-publish-error">Publish failed</span>}
        <button className="sidebar-publish-btn" onClick={handlePublish} disabled={publishing}>
          {publishing ? "Publishing…" : "Publish Changes"}
        </button>
      </div>
    </aside>
  );
}
