import { useState, useEffect } from "react";
import { listAutomations, saveAutomation, removeAutomation, triggerAutomation, generateFlow } from "../api/client";
import type { Automation, AutomationStep } from "../types";
import FlowStepCard, { FLOW_TOOLS, type Connections } from "./FlowStepCard";

const SCHEDULE_OPTIONS = [
  { label: "Every hour",         cron: "0 * * * *" },
  { label: "Daily at 6am UTC",   cron: "0 6 * * *" },
  { label: "Daily at 9am UTC",   cron: "0 9 * * *" },
  { label: "Daily at 12pm UTC",  cron: "0 12 * * *" },
  { label: "Weekly Mon 9am UTC", cron: "0 9 * * 1" },
  { label: "Custom cron…",       cron: "custom" },
];

function scheduleLabel(cron: string) {
  return SCHEDULE_OPTIONS.find((o) => o.cron === cron)?.label ?? cron;
}

function newStep(): AutomationStep {
  return { id: crypto.randomUUID(), tool: "", instruction: "" };
}

function newFlow(): Automation {
  return {
    id: crypto.randomUUID(),
    name: "",
    schedule: "0 9 * * *",
    steps: [newStep()],
    enabled: true,
  };
}

interface FlowsPageProps {
  connections: Connections;
  isAdmin: boolean;
}

export default function FlowsPage({ connections, isAdmin }: FlowsPageProps) {
  const [flows, setFlows] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"list" | "builder">("list");
  const [editing, setEditing] = useState<Automation | null>(null);
  const [createMode, setCreateMode] = useState<"manual" | "describe">("manual");
  const [describeText, setDescribeText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customCron, setCustomCron] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAutomations().then(setFlows).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const openNew = () => {
    setEditing(newFlow());
    setCreateMode("manual");
    setDescribeText("");
    setCustomCron(false);
    setError(null);
    setView("builder");
  };

  const openEdit = (flow: Automation) => {
    setEditing({ ...flow });
    setCreateMode("manual");
    setCustomCron(!SCHEDULE_OPTIONS.some((o) => o.cron === flow.schedule && o.cron !== "custom"));
    setError(null);
    setView("builder");
  };

  const handleGenerate = async () => {
    if (!describeText.trim() || !editing) return;
    setGenerating(true);
    setError(null);
    try {
      const connectedToolKeys = FLOW_TOOLS
        .filter((t) => !t.requires || connections[t.requires as keyof Connections])
        .map((t) => t.key);
      const result = await generateFlow(describeText, connectedToolKeys as string[]);
      setEditing((prev) => prev ? {
        ...prev,
        name: prev.name || result.suggestedName,
        schedule: result.suggestedSchedule || prev.schedule,
        steps: result.steps.length ? result.steps : prev.steps,
      } : prev);
      setCreateMode("manual");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { setError("Flow name is required"); return; }
    if (!editing.steps.length) { setError("At least one step is required"); return; }
    setSaving(true);
    setError(null);
    try {
      await saveAutomation(editing);
      setFlows((prev) => {
        const exists = prev.find((f) => f.id === editing.id);
        return exists ? prev.map((f) => f.id === editing.id ? editing : f) : [...prev, editing];
      });
      setView("list");
      setEditing(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await removeAutomation(id);
    setFlows((prev) => prev.filter((f) => f.id !== id));
    if (editing?.id === id) { setEditing(null); setView("list"); }
  };

  const handleToggle = async (flow: Automation) => {
    const updated = { ...flow, enabled: !flow.enabled };
    await saveAutomation(updated);
    setFlows((prev) => prev.map((f) => f.id === updated.id ? updated : f));
  };

  const handleRun = async (id: string) => {
    setRunningId(id);
    try { await triggerAutomation(id); } finally { setRunningId(null); }
  };

  const updateStep = (idx: number, step: AutomationStep) => {
    if (!editing) return;
    const steps = editing.steps.map((s, i) => i === idx ? step : s);
    setEditing({ ...editing, steps });
  };

  const addStep = () => {
    if (!editing) return;
    setEditing({ ...editing, steps: [...editing.steps, newStep()] });
  };

  const removeStep = (idx: number) => {
    if (!editing) return;
    setEditing({ ...editing, steps: editing.steps.filter((_, i) => i !== idx) });
  };

  // ── List view ────────────────────────────────────────────────────────────────

  if (view === "list") {
    return (
      <div className="flows-page">
        <div className="flows-header">
          <div className="flows-title">
            <span className="flows-title-icon">⚡</span>
            <h2>Flows</h2>
          </div>
          {isAdmin && (
            <button className="flows-new-btn" onClick={openNew}>+ New Flow</button>
          )}
        </div>

        {loading ? (
          <div className="flows-empty">Loading flows…</div>
        ) : flows.length === 0 ? (
          <div className="flows-empty">
            <div className="flows-empty-icon">⚡</div>
            <p>No flows yet.</p>
            <p className="flows-empty-sub">Create a flow to automate tasks on a schedule.</p>
            {isAdmin && (
              <button className="flows-new-btn" onClick={openNew}>Create your first flow</button>
            )}
          </div>
        ) : (
          <div className="flows-grid">
            {flows.map((flow) => (
              <div key={flow.id} className="flow-card">
                <div className="flow-card-top">
                  <div className="flow-card-info" onClick={() => isAdmin && openEdit(flow)}>
                    <span className="flow-card-name">{flow.name || "Unnamed"}</span>
                    <span className="flow-card-schedule">{scheduleLabel(flow.schedule)}</span>
                    <span className="flow-card-steps">{flow.steps.length} step{flow.steps.length !== 1 ? "s" : ""}</span>
                    <div className="flow-card-tools">
                      {flow.steps.slice(0, 4).map((s) => {
                        const t = FLOW_TOOLS.find((ft) => ft.key === s.tool);
                        return t ? <span key={s.id} className="flow-tool-pill">{t.icon} {t.label}</span> : null;
                      })}
                      {flow.steps.length > 4 && (
                        <span className="flow-tool-pill flow-tool-pill--more">+{flow.steps.length - 4}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flow-card-actions">
                  <label className="flow-card-toggle" title={flow.enabled ? "Enabled" : "Paused"}>
                    <input type="checkbox" checked={flow.enabled} onChange={() => isAdmin && handleToggle(flow)} disabled={!isAdmin} />
                    <span className="flow-toggle-track" />
                  </label>
                  {isAdmin && (
                    <>
                      <button
                        className="flow-card-run"
                        onClick={() => handleRun(flow.id)}
                        disabled={runningId === flow.id}
                        title="Run now"
                      >
                        {runningId === flow.id ? "…" : "▶"}
                      </button>
                      <button className="flow-card-delete" onClick={() => handleDelete(flow.id)} title="Delete">✕</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Builder view ─────────────────────────────────────────────────────────────

  return (
    <div className="flows-page flows-page--builder">
      <div className="flows-builder-header">
        <button className="flows-back-btn" onClick={() => { setView("list"); setEditing(null); }}>
          ← Back to Flows
        </button>
        <span className="flows-builder-title">
          {flows.find((f) => f.id === editing?.id) ? "Edit Flow" : "New Flow"}
        </span>
      </div>

      <div className="flows-builder">
        {/* Name + schedule */}
        <div className="flows-builder-meta">
          <div className="flows-field">
            <label className="flows-label">Flow name</label>
            <input
              className="flows-input"
              placeholder="e.g. Daily Task Summary"
              value={editing?.name ?? ""}
              onChange={(e) => editing && setEditing({ ...editing, name: e.target.value })}
            />
          </div>
          <div className="flows-field">
            <label className="flows-label">Schedule</label>
            <select
              className="flows-input"
              value={customCron ? "custom" : (editing?.schedule ?? "0 9 * * *")}
              onChange={(e) => {
                if (!editing) return;
                if (e.target.value === "custom") { setCustomCron(true); }
                else { setCustomCron(false); setEditing({ ...editing, schedule: e.target.value }); }
              }}
            >
              {SCHEDULE_OPTIONS.map((o) => <option key={o.cron} value={o.cron}>{o.label}</option>)}
            </select>
            {customCron && (
              <input
                className="flows-input flows-input--cron"
                placeholder="0 9 * * 1-5"
                value={editing?.schedule ?? ""}
                onChange={(e) => editing && setEditing({ ...editing, schedule: e.target.value })}
              />
            )}
          </div>
        </div>

        {/* Mode toggle */}
        <div className="flows-mode-toggle">
          <button
            className={`flows-mode-btn${createMode === "manual" ? " active" : ""}`}
            onClick={() => setCreateMode("manual")}
          >
            ✍ Build manually
          </button>
          <button
            className={`flows-mode-btn${createMode === "describe" ? " active" : ""}`}
            onClick={() => setCreateMode("describe")}
          >
            ✨ Describe your flow
          </button>
        </div>

        {/* Describe mode */}
        {createMode === "describe" && (
          <div className="flows-describe">
            <textarea
              className="flows-describe-input"
              placeholder="e.g. Every morning, summarise my Google Tasks and send myself a WhatsApp message with the tasks and 3 suggested action items"
              value={describeText}
              onChange={(e) => setDescribeText(e.target.value)}
              rows={4}
            />
            <button
              className="flows-generate-btn"
              onClick={handleGenerate}
              disabled={generating || !describeText.trim()}
            >
              {generating ? (
                <><span className="flows-spinner" /> Generating…</>
              ) : "✨ Generate Steps"}
            </button>
          </div>
        )}

        {/* Steps */}
        {createMode === "manual" && editing && (
          <div className="flows-steps">
            <div className="flows-trigger-block">
              <span className="flows-trigger-icon">⚡</span>
              <div>
                <span className="flows-trigger-label">Trigger</span>
                <span className="flows-trigger-schedule">{scheduleLabel(editing.schedule)}</span>
              </div>
            </div>

            {editing.steps.map((step, idx) => (
              <div key={step.id} className="flows-step-wrapper">
                <div className="flows-spine" />
                <FlowStepCard
                  step={step}
                  stepNumber={idx + 1}
                  onChange={(s) => updateStep(idx, s)}
                  onRemove={() => removeStep(idx)}
                  connections={connections}
                />
              </div>
            ))}

            <div className="flows-add-step-wrapper">
              <div className="flows-spine flows-spine--short" />
              <button className="flows-add-step-btn" onClick={addStep}>+ Add Step</button>
            </div>
          </div>
        )}

        {error && <div className="flows-error">{error}</div>}

        <div className="flows-builder-footer">
          <button className="flows-cancel-btn" onClick={() => { setView("list"); setEditing(null); }}>
            Cancel
          </button>
          <button
            className="flows-save-btn"
            onClick={handleSave}
            disabled={saving || !editing?.name.trim() || !editing?.steps.length}
          >
            {saving ? "Saving…" : "Save Flow"}
          </button>
        </div>
      </div>
    </div>
  );
}
