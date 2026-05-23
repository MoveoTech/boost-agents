import { useState, useEffect, useCallback } from "react";
import {
  listAgents, getAgentConnections, getAgentConfig, updateAgentConfig, deleteAgent, getAgentStatus,
  type AgentRecord, type AgentConnections,
} from "../api/client";
import type { AgentConfig } from "../types";

const SUPER_ADMIN = "boazt@moveoboost.com";

const TOOL_LABELS: Record<string, string> = {
  fetchUrl: "Web Fetch", httpRequest: "HTTP Request", googleSearch: "Google Search",
  gmail: "Gmail", googleCalendar: "Calendar", googleTasks: "Tasks",
  monday: "Monday.com", slack: "Slack", memory: "Memory",
};

// ── Delete Modal ──────────────────────────────────────────────────────────────

function DeleteModal({ agent, onClose, onDeleted }: {
  agent: AgentRecord;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "deleting" | "done" | "error">("idle");
  const [errors, setErrors] = useState<string[]>([]);

  const handleDelete = async () => {
    if (confirm !== agent.repoName) return;
    setStatus("deleting");
    const result = await deleteAgent(agent.repoName);
    if (result.ok) {
      setStatus("done");
      setTimeout(onDeleted, 1200);
    } else {
      setErrors(result.errors ?? ["Unknown error"]);
      setStatus("error");
    }
  };

  return (
    <div className="sa-modal-backdrop" onClick={onClose}>
      <div className="sa-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="sa-modal-title">Delete agent</h3>
        {status === "idle" && (
          <>
            <p className="sa-modal-body">
              This will permanently <strong>delete the GitHub repo</strong> and <strong>wipe all Firestore data</strong> (tokens, chats, WhatsApp session, memories, feedback).
            </p>
            <p className="sa-modal-body" style={{ color: "var(--muted)", fontSize: 13 }}>
              The GCP project <code>boost-{agent.repoName}-v7</code> must be deleted manually via the GCP Console.
            </p>
            <label className="sa-label">Type <strong>{agent.repoName}</strong> to confirm</label>
            <input
              className="sa-input" autoFocus
              value={confirm} onChange={(e) => setConfirm(e.target.value)}
              placeholder={agent.repoName}
            />
            <div className="sa-modal-actions">
              <button className="sa-btn sa-btn-ghost" onClick={onClose}>Cancel</button>
              <button className="sa-btn sa-btn-danger" disabled={confirm !== agent.repoName} onClick={handleDelete}>
                Delete permanently
              </button>
            </div>
          </>
        )}
        {status === "deleting" && (
          <div className="sa-modal-wait">
            <div className="cap-spinner" />
            <p>Deleting repo and wiping Firestore data…</p>
          </div>
        )}
        {status === "done" && (
          <div className="sa-modal-wait">
            <span style={{ fontSize: 32 }}>✓</span>
            <p style={{ color: "#16a34a" }}>Agent deleted.</p>
          </div>
        )}
        {status === "error" && (
          <>
            <p className="sa-error">Some steps failed:</p>
            {errors.map((e, i) => <p key={i} className="sa-error" style={{ fontSize: 13 }}>{e}</p>)}
            <div className="sa-modal-actions">
              <button className="sa-btn sa-btn-ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Config Modal ──────────────────────────────────────────────────────────────

function ConfigModal({ agent, onClose }: { agent: AgentRecord; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "deploying" | "done" | "error">("idle");
  const [deployRunId, setDeployRunId] = useState<number | undefined>();
  const [deployStatus, setDeployStatus] = useState<"pending" | "in_progress" | "success" | "failed">("pending");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    getAgentConfig(agent.repoName).then((c) => {
      if (c) setConfig(c); else setLoadError("Failed to load config from GitHub.");
      setLoading(false);
    });
  }, [agent.repoName]);

  // Poll deploy status after config save
  useEffect(() => {
    if (status !== "deploying" || !deployRunId) return;
    const poll = async () => {
      const { status: s } = await getAgentStatus(agent.repoName);
      setDeployStatus(s);
      if (s === "success") setStatus("done");
      else if (s === "failed") { setSaveError("Deploy failed. Try again or re-deploy from GitHub."); setStatus("error"); }
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => clearInterval(id);
  }, [status, deployRunId, agent.repoName]);

  const handleSave = async () => {
    if (!config) return;
    const confirmMsg = `Save config and redeploy ${agent.repoName}? This will take ~8 minutes.`;
    if (!window.confirm(confirmMsg)) return;
    setStatus("saving");
    setSaveError("");
    const result = await updateAgentConfig(agent.repoName, config);
    if (!result.ok) { setSaveError(result.error ?? "Save failed"); setStatus("error"); return; }
    setDeployRunId(result.runId);
    setDeployStatus("pending");
    setStatus("deploying");
  };

  const setTool = (key: string, val: boolean) =>
    setConfig((c) => c ? { ...c, tools: { ...c.tools, [key]: val } } : c);

  return (
    <div className="sa-modal-backdrop" onClick={status === "idle" || status === "error" ? onClose : undefined}>
      <div className="sa-modal sa-modal-wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="sa-modal-title">Edit config — {agent.repoName}</h3>

        {loading && <div className="sa-modal-wait"><div className="cap-spinner" /></div>}
        {loadError && <p className="sa-error">{loadError}</p>}

        {!loading && config && (status === "idle" || status === "error") && (
          <>
            <div className="sa-field">
              <label className="sa-label">Agent name</label>
              <input className="sa-input" value={config.name} onChange={(e) => setConfig((c) => c ? { ...c, name: e.target.value } : c)} />
            </div>
            <div className="sa-field">
              <label className="sa-label">System prompt</label>
              <textarea className="sa-input sa-textarea" rows={5} value={config.systemPrompt}
                onChange={(e) => setConfig((c) => c ? { ...c, systemPrompt: e.target.value } : c)} />
            </div>
            <div className="sa-field">
              <label className="sa-label">Tools</label>
              <div className="sa-tools-grid">
                {Object.entries(TOOL_LABELS).map(([key, label]) => (
                  <label key={key} className="sa-tool-toggle">
                    <input type="checkbox" checked={!!(config.tools as any)[key]}
                      onChange={(e) => setTool(key, e.target.checked)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            {saveError && <p className="sa-error">{saveError}</p>}
            <div className="sa-modal-actions">
              <button className="sa-btn sa-btn-ghost" onClick={onClose}>Cancel</button>
              <button className="sa-btn sa-btn-primary" onClick={handleSave}>Save & redeploy</button>
            </div>
          </>
        )}

        {(status === "saving" || status === "deploying") && (
          <div className="sa-modal-wait">
            <div className="cap-spinner" />
            <p>{status === "saving" ? "Committing config to GitHub…" : `Deploying ${agent.repoName}… (~8 min)`}</p>
            {status === "deploying" && (
              <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>
                Status: {deployStatus === "pending" ? "queued" : deployStatus === "in_progress" ? "building…" : deployStatus}
              </p>
            )}
          </div>
        )}

        {status === "done" && (
          <div className="sa-modal-wait">
            <span style={{ fontSize: 36 }}>✓</span>
            <p style={{ color: "#16a34a", fontWeight: 600 }}>Config saved and deployed.</p>
            <button className="sa-btn sa-btn-ghost" style={{ marginTop: 16 }} onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Agent Card ────────────────────────────────────────────────────────────────

function AgentCard({ agent, onDelete, onEdit }: {
  agent: AgentRecord;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const [connections, setConnections] = useState<AgentConnections | null>(null);
  const [expanded, setExpanded] = useState(false);

  const loadConnections = useCallback(async () => {
    if (connections) return;
    const c = await getAgentConnections(agent.repoName);
    setConnections(c);
  }, [agent.repoName, connections]);

  const toggle = () => {
    setExpanded((v) => !v);
    if (!connections) loadConnections();
  };

  const isDeleted = agent.status === "deleted";
  const gcpProject = `boost-${agent.repoName}-v7`;

  return (
    <div className={`sa-card ${isDeleted ? "sa-card-deleted" : ""}`}>
      <div className="sa-card-header" onClick={toggle}>
        <div className="sa-card-title">
          <span className="sa-agent-name">{agent.repoName}</span>
          <span className={`sa-badge ${isDeleted ? "sa-badge-deleted" : "sa-badge-active"}`}>
            {isDeleted ? "deleted" : "active"}
          </span>
        </div>
        <div className="sa-card-meta">
          <span>{agent.createdBy || "—"}</span>
          <span>{new Date(agent.createdAt).toLocaleDateString()}</span>
          <span className="sa-chevron">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && (
        <div className="sa-card-body">
          {agent.adminEmails && (
            <p className="sa-detail"><strong>Admins:</strong> {agent.adminEmails}</p>
          )}
          <div className="sa-links-row">
            <a href={`https://github.com/MoveoTech/${agent.repoName}`} target="_blank" rel="noopener" className="sa-link">GitHub ↗</a>
            <a href={`https://github.com/MoveoTech/${agent.repoName}/actions`} target="_blank" rel="noopener" className="sa-link">Actions ↗</a>
            <a href={`https://console.cloud.google.com/run?project=${gcpProject}`} target="_blank" rel="noopener" className="sa-link">GCP ↗</a>
          </div>

          <div className="sa-connections">
            <p className="sa-section-label">Connected services</p>
            {!connections && <span className="sa-loading-dots">Loading…</span>}
            {connections && (
              <div className="sa-service-grid">
                {(["gmail", "calendar", "tasks", "monday"] as const).map((svc) => (
                  <div key={svc} className="sa-service-item">
                    <span className={`sa-dot ${connections[svc].length > 0 ? "sa-dot-on" : "sa-dot-off"}`} />
                    <span className="sa-service-name">{svc}</span>
                    {connections[svc].length > 0 && (
                      <span className="sa-service-users">{connections[svc].join(", ")}</span>
                    )}
                  </div>
                ))}
                <div className="sa-service-item">
                  <span className={`sa-dot ${connections.whatsapp.length > 0 ? "sa-dot-on" : "sa-dot-off"}`} />
                  <span className="sa-service-name">whatsapp</span>
                  {connections.whatsapp.length > 0 && (
                    <span className="sa-service-users">{connections.whatsapp.join(", ")}</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {!isDeleted && (
            <div className="sa-card-actions">
              <button className="sa-btn sa-btn-secondary" onClick={onEdit}>Edit config & redeploy</button>
              <button className="sa-btn sa-btn-danger-outline" onClick={onDelete}>Delete agent</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SuperAdminPage({ email }: { email: string | null }) {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeleted, setShowDeleted] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentRecord | null>(null);
  const [editTarget, setEditTarget] = useState<AgentRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setAgents(await listAgents());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (email !== SUPER_ADMIN) {
    return (
      <div className="cap-shell">
        <div className="cap-card" style={{ textAlign: "center" }}>
          <div className="cap-logo">boost</div>
          <p style={{ color: "var(--muted)", marginTop: 12 }}>Access restricted.</p>
        </div>
      </div>
    );
  }

  const visible = agents.filter((a) => showDeleted || a.status === "active");

  return (
    <div className="sa-shell">
      <div className="sa-header">
        <div className="sa-header-left">
          <div className="cap-logo" style={{ fontSize: 18 }}>boost</div>
          <h1 className="sa-title">Super Admin</h1>
        </div>
        <div className="sa-header-right">
          <label className="sa-toggle-label">
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
            Show deleted
          </label>
          <a href="/" className="sa-link" style={{ marginLeft: 16 }}>← Create Agent</a>
        </div>
      </div>

      <div className="sa-content">
        {loading && <div style={{ display: "flex", justifyContent: "center", padding: 40 }}><div className="cap-spinner" /></div>}
        {!loading && visible.length === 0 && (
          <p style={{ color: "var(--muted)", textAlign: "center", padding: 40 }}>No agents yet.</p>
        )}
        {!loading && visible.map((agent) => (
          <AgentCard
            key={agent.repoName}
            agent={agent}
            onDelete={() => setDeleteTarget(agent)}
            onEdit={() => setEditTarget(agent)}
          />
        ))}
      </div>

      {deleteTarget && (
        <DeleteModal
          agent={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => { setDeleteTarget(null); load(); }}
        />
      )}
      {editTarget && (
        <ConfigModal agent={editTarget} onClose={() => setEditTarget(null)} />
      )}
    </div>
  );
}
