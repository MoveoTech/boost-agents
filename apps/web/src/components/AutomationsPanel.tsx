import { useState, useEffect } from "react";
import { listAutomations, saveAutomation, removeAutomation } from "../api/client";
import type { Automation } from "../types";

const SCHEDULE_OPTIONS = [
  { label: "Every hour",            cron: "0 * * * *" },
  { label: "Daily at 6am UTC",      cron: "0 6 * * *" },
  { label: "Daily at 9am UTC",      cron: "0 9 * * *" },
  { label: "Weekly Mon 9am UTC",    cron: "0 9 * * 1" },
  { label: "Custom cron…",          cron: "custom" },
];

const EMPTY: Omit<Automation, "id"> = { name: "", schedule: "0 9 * * *", prompt: "", enabled: true };

export default function AutomationsPanel() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [customCron, setCustomCron] = useState(false);

  useEffect(() => {
    listAutomations().then(setAutomations).finally(() => setLoading(false));
  }, []);

  const openNew = () => {
    setCustomCron(false);
    setEditing({ ...EMPTY, id: crypto.randomUUID() });
  };

  const openEdit = (a: Automation) => {
    const isCustom = !SCHEDULE_OPTIONS.some((o) => o.cron === a.schedule && o.cron !== "custom");
    setCustomCron(isCustom);
    setEditing(a);
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await saveAutomation(editing);
      setAutomations((prev) => {
        const exists = prev.find((a) => a.id === editing.id);
        return exists ? prev.map((a) => a.id === editing.id ? editing : a) : [...prev, editing];
      });
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await removeAutomation(id);
    setAutomations((prev) => prev.filter((a) => a.id !== id));
    if (editing?.id === id) setEditing(null);
  };

  const handleToggle = async (automation: Automation) => {
    const updated = { ...automation, enabled: !automation.enabled };
    await saveAutomation(updated);
    setAutomations((prev) => prev.map((a) => a.id === updated.id ? updated : a));
  };

  const scheduleLabel = (cron: string) =>
    SCHEDULE_OPTIONS.find((o) => o.cron === cron)?.label ?? cron;

  if (loading) return <div className="configure-loading">Loading automations...</div>;

  return (
    <div className="automations-panel">
      <div className="automations-list">
        {automations.length === 0 && !editing && (
          <div className="automations-empty">
            No automations yet. Create one to run agent tasks on a schedule.
          </div>
        )}
        {automations.map((a) => (
          <div key={a.id} className={`automation-row ${editing?.id === a.id ? "active" : ""}`}>
            <div className="automation-row-info" onClick={() => openEdit(a)}>
              <span className="automation-name">{a.name || "Unnamed"}</span>
              <span className="automation-schedule">{scheduleLabel(a.schedule)}</span>
              <span className="automation-prompt-preview">{a.prompt.slice(0, 60)}{a.prompt.length > 60 ? "…" : ""}</span>
            </div>
            <div className="automation-row-actions">
              <input
                type="checkbox"
                className="configure-checkbox"
                checked={a.enabled}
                onChange={() => handleToggle(a)}
                title={a.enabled ? "Enabled" : "Paused"}
              />
              <button className="automation-delete-btn" onClick={() => handleDelete(a.id)}>✕</button>
            </div>
          </div>
        ))}

        <button className="automation-add-btn" onClick={openNew}>+ New Automation</button>
      </div>

      {editing && (
        <div className="automation-form">
          <h3 className="automation-form-title">{automations.find((a) => a.id === editing.id) ? "Edit" : "New"} Automation</h3>

          <label className="configure-label">
            Name
            <input className="configure-input" value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </label>

          <label className="configure-label">
            Schedule
            <select className="configure-input" value={customCron ? "custom" : editing.schedule}
              onChange={(e) => {
                if (e.target.value === "custom") { setCustomCron(true); }
                else { setCustomCron(false); setEditing({ ...editing, schedule: e.target.value }); }
              }}>
              {SCHEDULE_OPTIONS.map((o) => <option key={o.cron} value={o.cron}>{o.label}</option>)}
            </select>
          </label>

          {customCron && (
            <label className="configure-label">
              Cron expression
              <input className="configure-input" placeholder="0 9 * * 1-5"
                value={editing.schedule}
                onChange={(e) => setEditing({ ...editing, schedule: e.target.value })} />
            </label>
          )}

          <label className="configure-label">
            Prompt
            <textarea className="configure-textarea" rows={4}
              placeholder="Summarize my emails from the last 24 hours and send me the summary via email"
              value={editing.prompt}
              onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} />
          </label>

          <div className="automation-form-footer">
            <button className="automation-cancel-btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="configure-deploy-btn" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save Automation"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
