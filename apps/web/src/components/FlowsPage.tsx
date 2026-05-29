import { useState, useEffect, useRef, useCallback } from "react";
import { listAutomations, saveAutomation, removeAutomation, runFlowDirect, generateFlow, runFlowSteps, suggestFlow } from "../api/client";
import type { Automation, AutomationStep, FlowStepResult } from "../types";
import FlowStepCard, { FLOW_TOOLS, type Connections } from "./FlowStepCard";

const BASE = import.meta.env.VITE_API_URL ?? "";

function webhookUrl(webhookId: string) {
  return `${BASE || window.location.origin}/api/webhooks/${webhookId}`;
}

function payloadToSchema(val: unknown): unknown {
  if (val === null) return "null";
  if (Array.isArray(val)) return val.length > 0 ? [payloadToSchema(val[0])] : ["unknown"];
  if (typeof val === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) result[k] = payloadToSchema(v);
    return result;
  }
  return typeof val;
}

function genSecret(): string {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

type StepTestStatus = "idle" | "running" | "success" | "error" | "stopped";
interface StepTestState {
  status: StepTestStatus;
  output?: string;
  error?: string;
  durationMs?: number;
  conditionFailed?: boolean;
}

// ── Templates ────────────────────────────────────────────────────────────────
interface FlowTemplate {
  id: string;
  icon: string;
  name: string;
  description: string;
  schedule: string;
  steps: Array<{ tool: string; instruction: string }>;
  requires: Array<keyof Connections>;
}

const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "tpl-tasks-whatsapp",
    icon: "📋",
    name: "Daily Task Summary",
    description: "Fetch tasks → AI summary → WhatsApp",
    schedule: "0 8 * * *",
    steps: [
      { tool: "google_tasks", instruction: "List all tasks due today and this week across all task lists" },
      { tool: "agent_prompt", instruction: "Summarize the tasks from step 1. Group by priority. Add 3 suggested actions for the day." },
      { tool: "whatsapp", instruction: "Send me a WhatsApp with the task summary from step 2" },
    ],
    requires: ["tasks", "whatsapp"],
  },
  {
    id: "tpl-gmail-digest",
    icon: "📧",
    name: "Email Digest",
    description: "Unread emails → AI summary",
    schedule: "0 8 * * 1-5",
    steps: [
      { tool: "gmail", instruction: "List all unread emails from the last 24 hours" },
      { tool: "agent_prompt", instruction: "Summarize the emails from step 1. Highlight urgent items and list action items." },
      { tool: "whatsapp", instruction: "Send me a WhatsApp digest of the email summary from step 2" },
    ],
    requires: ["gmail", "whatsapp"],
  },
  {
    id: "tpl-calendar-brief",
    icon: "📅",
    name: "Morning Briefing",
    description: "Today's calendar → WhatsApp briefing",
    schedule: "0 7 * * 1-5",
    steps: [
      { tool: "google_calendar", instruction: "List all events for today" },
      { tool: "agent_prompt", instruction: "Create a morning briefing from today's events. Note back-to-back meetings and preparation tips." },
      { tool: "whatsapp", instruction: "Send me the morning briefing from step 2 via WhatsApp" },
    ],
    requires: ["calendar", "whatsapp"],
  },
  {
    id: "tpl-monday-review",
    icon: "📊",
    name: "Weekly Project Review",
    description: "Monday.com items → AI review → Slack",
    schedule: "0 9 * * 1",
    steps: [
      { tool: "monday", instruction: "Get all items that are in progress or overdue across my boards" },
      { tool: "agent_prompt", instruction: "Analyze the project items from step 1. Identify blockers, overdue items, and next week priorities." },
      { tool: "slack", instruction: "Post the weekly project review summary from step 2 to the team Slack channel" },
    ],
    requires: ["monday", "slack"],
  },
  {
    id: "tpl-conditional-tasks",
    icon: "🔀",
    name: "Tasks (with condition)",
    description: "Only notify if tasks are due today",
    schedule: "0 9 * * *",
    steps: [
      { tool: "google_tasks", instruction: "List all tasks due today across all task lists" },
      { tool: "condition", instruction: "There is at least 1 task due today" },
      { tool: "agent_prompt", instruction: "Summarize today's tasks from step 1 and create a prioritized to-do list" },
      { tool: "whatsapp", instruction: "Send me a WhatsApp with today's task summary from step 3" },
    ],
    requires: ["tasks", "whatsapp"],
  },
];

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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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
    triggerType: "schedule",
    webhookId: crypto.randomUUID(),
    webhookSecret: genSecret(),
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
  const [createMode, setCreateMode] = useState<"template" | "manual" | "describe">("template");
  const [describeText, setDescribeText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customCron, setCustomCron] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runResults, setRunResults] = useState<Record<string, FlowStepResult[]>>({});
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [testRunStates, setTestRunStates] = useState<Record<string, StepTestState>>({});
  const [testRunning, setTestRunning] = useState(false);
  const [listenMode, setListenMode] = useState<"idle" | "listening" | "received">("idle");
  const [listenCountdown, setListenCountdown] = useState(60);
  const [secretVisible, setSecretVisible] = useState(false);
  const [copied, setCopied] = useState<"url" | "secret" | null>(null);
  const [schemaTooltipVisible, setSchemaTooltipVisible] = useState(false);
  const [flowSuggestion, setFlowSuggestion] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    listAutomations().then(setFlows).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!editing?.webhookPayloadSchema) { setFlowSuggestion(null); return; }
    setSuggesting(true);
    setFlowSuggestion(null);
    const connectedToolKeys = FLOW_TOOLS
      .filter((t) => !t.requires || connections[t.requires as keyof Connections])
      .map((t) => t.key);
    suggestFlow(editing.webhookPayloadSchema!, connectedToolKeys as string[])
      .then(setFlowSuggestion)
      .catch(() => {})
      .finally(() => setSuggesting(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.webhookPayloadSchema]);

  const openNew = () => {
    setEditing(newFlow());
    setCreateMode("template");
    setDescribeText("");
    setCustomCron(false);
    setError(null);
    setTestRunStates({});
    setView("builder");
  };

  const openEdit = (flow: Automation) => {
    // Backfill webhookId/secret for older flows that predate the webhook feature
    const patched: Automation = {
      ...flow,
      webhookId: flow.webhookId ?? crypto.randomUUID(),
      webhookSecret: flow.webhookSecret ?? genSecret(),
      triggerType: flow.triggerType ?? "schedule",
    };
    setEditing(patched);
    setCreateMode("manual");
    setCustomCron(!SCHEDULE_OPTIONS.some((o) => o.cron === flow.schedule && o.cron !== "custom"));
    setError(null);
    setTestRunStates({});
    setListenMode("idle");
    setSecretVisible(false);
    setView("builder");
  };

  const applyTemplate = (tpl: FlowTemplate) => {
    if (!editing) return;
    setEditing((prev) => prev ? {
      ...prev,
      name: prev.name || tpl.name,
      schedule: tpl.schedule,
      steps: tpl.steps.map((s) => ({ ...s, id: crypto.randomUUID() })),
    } : prev);
    setCreateMode("manual");
  };

  const handleCopy = useCallback((text: string, kind: "url" | "secret") => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    });
  }, []);

  const stopListen = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    setListenMode("idle");
    setListenCountdown(60);
  }, []);

  const handleListen = useCallback(() => {
    if (!editing?.webhookId) return;
    if (listenMode === "listening") { stopListen(); return; }

    const es = new EventSource(`${BASE}/api/webhooks/${editing.webhookId}/listen`);
    esRef.current = es;
    setListenMode("listening");
    setListenCountdown(60);

    let remaining = 60;
    countdownRef.current = setInterval(() => {
      remaining -= 1;
      setListenCountdown(remaining);
      if (remaining <= 0) stopListen();
    }, 1000);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { type: string; payload?: Record<string, unknown> };
        if (data.type === "payload" && data.payload) {
          stopListen();
          setListenMode("received");
          setEditing((prev) => prev ? { ...prev, webhookPayloadSchema: payloadToSchema(data.payload) as Record<string, unknown> } : prev);
        } else if (data.type === "timeout") {
          stopListen();
        }
      } catch {}
    };
    es.onerror = () => stopListen();
  }, [editing?.webhookId, listenMode, stopListen]);

  const handleSchemaUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        setEditing((prev) => prev ? { ...prev, webhookPayloadSchema: payloadToSchema(parsed) as Record<string, unknown> } : prev);
      } catch {
        setError("Invalid JSON file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const generateSteps = async (text: string) => {
    if (!editing) return;
    setGenerating(true);
    setError(null);
    try {
      const connectedToolKeys = FLOW_TOOLS
        .filter((t) => !t.requires || connections[t.requires as keyof Connections])
        .map((t) => t.key);
      const result = await generateFlow(text, connectedToolKeys as string[], editing.webhookPayloadSchema);
      const newSteps = result.steps.length ? result.steps : editing.steps;
      setEditing((prev) => prev ? {
        ...prev,
        name: prev.name || result.suggestedName,
        schedule: result.suggestedSchedule || prev.schedule,
        steps: [],
      } : prev);
      setCreateMode("manual");
      newSteps.forEach((step, i) => {
        setTimeout(() => {
          setEditing((prev) => prev ? { ...prev, steps: [...prev.steps, step] } : prev);
        }, (i + 1) * 160);
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerate = async () => {
    if (!describeText.trim()) { setError("Please describe the flow"); return; }
    await generateSteps(describeText);
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
    try {
      const { stepResults } = await runFlowDirect(id);
      setRunResults((prev) => ({ ...prev, [id]: stepResults }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunningId(null);
    }
  };

  const runStepsFrom = async (fromIndex: number) => {
    if (!editing?.steps.length) return;
    const prior = editing.steps
      .slice(0, fromIndex)
      .map((s) => {
        const st = testRunStates[s.id];
        if (!st || st.status === "idle") return null;
        return { id: s.id, tool: s.tool, output: st.output ?? "", error: st.error, durationMs: st.durationMs ?? 0, conditionFailed: st.conditionFailed } as FlowStepResult;
      })
      .filter(Boolean) as FlowStepResult[];

    const stepsToRun = editing.steps.slice(fromIndex);

    // Reset states for steps being (re)run
    setTestRunStates((prev) => {
      const next = { ...prev };
      stepsToRun.forEach((s) => { next[s.id] = { status: "idle" }; });
      return next;
    });
    setTestRunning(true);
    setError(null);
    try {
      for await (const event of runFlowSteps(stepsToRun, prior.length ? prior : undefined)) {
        if (event.type === "start") {
          setTestRunStates((prev) => ({ ...prev, [event.stepId]: { status: "running" } }));
        } else if (event.type === "done") {
          setTestRunStates((prev) => ({
            ...prev,
            [event.id]: {
              status: event.conditionFailed ? "stopped" : event.error ? "error" : "success",
              output: event.output,
              error: event.error,
              durationMs: event.durationMs,
              conditionFailed: event.conditionFailed,
            },
          }));
        } else if (event.type === "error") {
          setError(event.error);
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTestRunning(false);
    }
  };

  const handleTestRun = () => {
    if (!editing?.steps.length) return;
    const initial: Record<string, StepTestState> = {};
    editing.steps.forEach((s) => { initial[s.id] = { status: "idle" }; });
    setTestRunStates(initial);
    runStepsFrom(0);
  };

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId); else next.add(stepId);
      return next;
    });
  };

  const toggleHistory = (flowId: string) => {
    setExpandedHistory((prev) => {
      const next = new Set(prev);
      if (next.has(flowId)) next.delete(flowId); else next.add(flowId);
      return next;
    });
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

        {error && <div className="flows-error flows-error--list">{error}<button onClick={() => setError(null)}>✕</button></div>}

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
            {flows.map((flow) => {
              const lastRun = flow.runHistory?.[0];
              const histExpanded = expandedHistory.has(flow.id);
              return (
                <div key={flow.id} className="flow-card">
                  <div className="flow-card-top">
                    <div className="flow-card-info" onClick={() => isAdmin && openEdit(flow)}>
                      <span className="flow-card-name">{flow.name || "Unnamed"}</span>
                      <span className="flow-card-schedule">
                        {flow.triggerType === "webhook" ? "🔗 Webhook" : flow.triggerType === "both" ? `⚡ ${scheduleLabel(flow.schedule)} + Webhook` : scheduleLabel(flow.schedule)}
                      </span>
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

                  {/* Run history row */}
                  {lastRun && (
                    <div className="flow-history-bar" onClick={() => toggleHistory(flow.id)}>
                      <span className={`flow-history-dot flow-history-dot--${lastRun.status}`} />
                      <span className="flow-history-label">
                        Last run {timeAgo(lastRun.runAt)} · {lastRun.status === "success" ? "All steps passed" : lastRun.status === "partial" ? "Partial success" : "Failed"}
                      </span>
                      <span className="flow-history-toggle">{histExpanded ? "▲" : "▼"}</span>
                    </div>
                  )}

                  {histExpanded && lastRun && (
                    <div className="flow-history-detail">
                      {lastRun.steps.map((s, i) => {
                        const t = FLOW_TOOLS.find((ft) => ft.key === s.tool);
                        return (
                          <div key={s.id} className={`flow-history-step${s.error ? " flow-history-step--error" : s.conditionFailed ? " flow-history-step--stopped" : ""}`}>
                            <span className="flow-history-step-icon">
                              {s.conditionFailed ? "⏹" : s.error ? "✗" : "✓"}
                            </span>
                            <span className="flow-history-step-name">{t?.icon} Step {i + 1} · {t?.label ?? s.tool}</span>
                            <span className="flow-history-step-ms">{s.durationMs}ms</span>
                            {(s.error || s.conditionFailed) && (
                              <div className="flow-history-step-output">{s.error ?? s.output}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

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
                          {runningId === flow.id ? <span className="flows-spinner flows-spinner--sm" /> : "▶"}
                        </button>
                        <button className="flow-card-delete" onClick={() => handleDelete(flow.id)} title="Delete">✕</button>
                      </>
                    )}
                  </div>
                  {runResults[flow.id] && (
                    <div className="flow-run-results">
                      <span className="flow-run-results-label">Last run</span>
                      {runResults[flow.id].map((r, i) => {
                        const t = FLOW_TOOLS.find((ft) => ft.key === r.tool);
                        const expanded = expandedSteps.has(r.id);
                        return (
                          <div key={r.id} className={`flow-run-step${r.error ? " flow-run-step--error" : ""}`} onClick={() => toggleStep(r.id)}>
                            <span className="flow-run-step-status">{r.conditionFailed ? "⏹" : r.error ? "✕" : "✓"}</span>
                            <span className="flow-run-step-name">{t?.icon} Step {i + 1} · {t?.label ?? r.tool}</span>
                            <span className="flow-run-step-ms">{r.durationMs}ms</span>
                            <div className={`flow-run-step-output${expanded ? " flow-run-step-output--expanded" : ""}`}>
                              {r.error ?? r.output}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── Builder view ─────────────────────────────────────────────────────────────

  const testDone = Object.keys(testRunStates).length > 0 && !testRunning;
  const testAllPassed = testDone && editing?.steps.every((s) => {
    const st = testRunStates[s.id];
    return st?.status === "success" || st?.status === "stopped";
  });

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
        {/* Name + trigger + schedule + notify */}
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
            <label className="flows-label">Trigger</label>
            <div className="flows-trigger-tabs">
              {(["schedule", "webhook", "both"] as const).map((t) => (
                <button
                  key={t}
                  className={`flows-trigger-tab${(editing?.triggerType ?? "schedule") === t ? " active" : ""}`}
                  onClick={() => {
                    if (!editing) return;
                    setEditing({
                      ...editing,
                      triggerType: t,
                      webhookId: editing.webhookId ?? crypto.randomUUID(),
                      webhookSecret: editing.webhookSecret ?? genSecret(),
                    });
                  }}
                >
                  {t === "schedule" ? "📅 Schedule" : t === "webhook" ? "🔗 Webhook" : "⚡ Both"}
                </button>
              ))}
            </div>
          </div>
          {(editing?.triggerType === "schedule" || editing?.triggerType === "both" || !editing?.triggerType) && (
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
          )}
          <div className="flows-field flows-field--notify">
            <label className="flows-notify-label">
              <input
                type="checkbox"
                checked={editing?.notifyOnFailure ?? false}
                onChange={(e) => editing && setEditing({ ...editing, notifyOnFailure: e.target.checked })}
              />
              Notify me on failure (WhatsApp)
            </label>
          </div>
        </div>

        {/* Webhook config */}
        {editing && (editing.triggerType === "webhook" || editing.triggerType === "both") && (
          <div className="flows-webhook-config">
            <div className="flows-webhook-row">
              <label className="flows-webhook-label">Webhook URL</label>
              <div className="flows-webhook-copy-row">
                <input className="flows-webhook-url-input" readOnly value={webhookUrl(editing.webhookId!)} />
                <button
                  className={`flows-webhook-copy-btn${copied === "url" ? " copied" : ""}`}
                  onClick={() => handleCopy(webhookUrl(editing.webhookId!), "url")}
                >
                  {copied === "url" ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div className="flows-webhook-row">
              <label className="flows-webhook-label">Secret header <span className="flows-webhook-hint">(X-Webhook-Secret)</span></label>
              <div className="flows-webhook-copy-row">
                <input
                  className="flows-webhook-url-input flows-webhook-secret-input"
                  readOnly
                  type={secretVisible ? "text" : "password"}
                  value={editing.webhookSecret ?? ""}
                />
                <button className="flows-webhook-copy-btn" onClick={() => setSecretVisible((v) => !v)}>
                  {secretVisible ? "Hide" : "Show"}
                </button>
                <button
                  className={`flows-webhook-copy-btn${copied === "secret" ? " copied" : ""}`}
                  onClick={() => handleCopy(editing.webhookSecret ?? "", "secret")}
                >
                  {copied === "secret" ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div className="flows-webhook-row">
              <label className="flows-webhook-label">
                Payload schema
                <span className="flows-webhook-hint"> — upload a sample .json or catch a live request to teach the AI your data structure</span>
              </label>
              <div className="flows-webhook-schema-actions">
                <label className="flows-webhook-upload-btn">
                  📎 Upload .json
                  <input type="file" accept=".json,application/json" style={{ display: "none" }} onChange={handleSchemaUpload} />
                </label>
                {editing.webhookPayloadSchema && listenMode !== "listening" ? (
                  <>
                    <div
                      className="flows-webhook-caught-chip"
                      onMouseEnter={() => setSchemaTooltipVisible(true)}
                      onMouseLeave={() => setSchemaTooltipVisible(false)}
                    >
                      📦 Payload caught
                      {schemaTooltipVisible && (
                        <div className="flows-webhook-schema-tooltip">
                          <pre>{JSON.stringify(editing.webhookPayloadSchema, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                    <button
                      className="flows-webhook-clear-btn"
                      onClick={() => { setEditing({ ...editing, webhookPayloadSchema: undefined }); setListenMode("idle"); setFlowSuggestion(null); }}
                    >
                      ✕ Clear
                    </button>
                  </>
                ) : (
                  <button
                    className={`flows-webhook-listen-btn${listenMode === "listening" ? " listening" : ""}`}
                    onClick={handleListen}
                  >
                    {listenMode === "listening"
                      ? `⏳ Waiting… ${listenCountdown}s (click to cancel)`
                      : "📡 Catch live payload"}
                  </button>
                )}
              </div>

              {/* AI flow suggestion based on payload schema */}
              {(suggesting || flowSuggestion) && (
                <div className="flows-webhook-suggestion">
                  {suggesting ? (
                    <div className="flows-webhook-suggestion-loading">💡 Analyzing payload…</div>
                  ) : flowSuggestion ? (
                    <>
                      <div className="flows-webhook-suggestion-label">💡 Suggested flow</div>
                      <p className="flows-webhook-suggestion-text">{flowSuggestion}</p>
                      <button
                        className="flows-webhook-suggestion-btn"
                        disabled={generating}
                        onClick={() => generateSteps(flowSuggestion)}
                      >
                        {generating ? "Generating…" : "✨ Create this flow"}
                      </button>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Mode toggle */}
        <div className="flows-mode-toggle">
          <button
            className={`flows-mode-btn${createMode === "template" ? " active" : ""}`}
            onClick={() => setCreateMode("template")}
          >
            ⚡ Templates
          </button>
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
            ✨ Describe
          </button>
        </div>

        {/* Template picker */}
        {createMode === "template" && (
          <div className="flows-templates">
            <p className="flows-templates-hint">Pick a template to start, then customize each step.</p>
            <div className="flows-templates-grid">
              {FLOW_TEMPLATES.map((tpl) => {
                const available = tpl.requires.every((r) => connections[r]);
                return (
                  <button
                    key={tpl.id}
                    className={`flows-tpl-card${!available ? " flows-tpl-card--locked" : ""}`}
                    onClick={() => available && applyTemplate(tpl)}
                    title={!available ? `Requires: ${tpl.requires.join(", ")}` : undefined}
                  >
                    <span className="flows-tpl-icon">{tpl.icon}</span>
                    <span className="flows-tpl-name">{tpl.name}</span>
                    <span className="flows-tpl-desc">{tpl.description}</span>
                    {!available && <span className="flows-tpl-lock">🔒 Connect services first</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

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
                {(editing.triggerType === "schedule" || editing.triggerType === "both" || !editing.triggerType) && (
                  <span className="flows-trigger-schedule">{scheduleLabel(editing.schedule)}</span>
                )}
                {(editing.triggerType === "webhook" || editing.triggerType === "both") && (
                  <span className="flows-trigger-schedule">🔗 Webhook</span>
                )}
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

        {/* Test run panel */}
        {Object.keys(testRunStates).length > 0 && editing && (
          <div className="flow-test-panel">
            <div className="flow-test-panel-header">
              <span className="flow-test-panel-title">Test Run</span>
              {testDone && (
                <span className={`flow-test-panel-summary ${testAllPassed ? "flow-test-panel-summary--ok" : "flow-test-panel-summary--fail"}`}>
                  {testAllPassed ? "✓ All steps passed" : "✗ Some steps failed"}
                </span>
              )}
            </div>
            {editing.steps.map((step, i) => {
              const state = testRunStates[step.id] ?? { status: "idle" };
              const t = FLOW_TOOLS.find((ft) => ft.key === step.tool);
              const canRetry = state.status === "error" || (i > 0 && !testRunning);
              return (
                <div key={step.id} className={`flow-test-step flow-test-step--${state.status}`}>
                  <span className="flow-test-step-icon">
                    {state.status === "idle" && <span className="flow-test-dot" />}
                    {state.status === "running" && <span className="flow-test-spinner" />}
                    {state.status === "success" && "✓"}
                    {state.status === "stopped" && "⏹"}
                    {state.status === "error" && "✗"}
                  </span>
                  <span className="flow-test-step-name">{t?.icon} Step {i + 1} · {t?.label ?? step.tool}</span>
                  <span className="flow-test-step-right">
                    {state.durationMs !== undefined && (
                      <span className="flow-test-step-ms">{state.durationMs}ms</span>
                    )}
                    {canRetry && testDone && (
                      <button className="flow-test-retry-btn" onClick={() => runStepsFrom(i)} title="Retry from this step">
                        ↻ Retry from here
                      </button>
                    )}
                  </span>
                  {(state.status === "success" || state.status === "error" || state.status === "stopped") && (
                    <div className={`flow-test-step-output${state.error ? " flow-test-step-output--error" : state.conditionFailed ? " flow-test-step-output--stopped" : ""}`}>
                      {state.error ?? state.output}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flows-builder-footer">
          <button className="flows-cancel-btn" onClick={() => { setView("list"); setEditing(null); }}>
            Cancel
          </button>
          <button
            className="flows-test-btn"
            onClick={handleTestRun}
            disabled={testRunning || !editing?.steps.length}
            title="Test run — executes all steps now"
          >
            {testRunning ? <><span className="flows-spinner flows-spinner--sm" /> Running…</> : "▶ Test Run"}
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
