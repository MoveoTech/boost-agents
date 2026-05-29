import type { AutomationStep } from "../types";

export const FLOW_TOOLS = [
  { key: "agent_prompt",    label: "AI Model",        icon: "🤖", requires: null },
  { key: "condition",       label: "Condition",       icon: "🔀", requires: null },
  { key: "google_tasks",    label: "Google Tasks",    icon: "📋", requires: "tasks" as const },
  { key: "whatsapp",        label: "WhatsApp",        icon: "💬", requires: "whatsapp" as const },
  { key: "gmail",           label: "Gmail",           icon: "📧", requires: "gmail" as const },
  { key: "google_calendar", label: "Google Calendar", icon: "📅", requires: "calendar" as const },
  { key: "slack",           label: "Slack",           icon: "💬", requires: "slack" as const },
  { key: "monday",          label: "Monday.com",      icon: "📊", requires: "monday" as const },
  { key: "google_maps",     label: "Google Maps",     icon: "🗺️",  requires: "googleMaps" as const },
  { key: "apollo",          label: "Apollo.io",       icon: "🚀", requires: "apollo" as const },
  { key: "http_request",    label: "HTTP Request",    icon: "🔗", requires: null },
  { key: "web_fetch",       label: "Web Fetch",       icon: "🌐", requires: null },
  { key: "google_search",   label: "Google Search",   icon: "🔍", requires: null },
] as const;

const TOOL_PLACEHOLDERS: Record<string, string> = {
  agent_prompt: "e.g. Summarize the tasks from step 1, group them by priority, and suggest 3 action items",
  condition: "e.g. There is at least 1 task due today",
  google_tasks: "e.g. List all tasks due today from my 'Work' task list",
  whatsapp: "e.g. Send me a WhatsApp message with a summary of the results above and 3 action items",
  gmail: "e.g. Send an email to me summarising the results above",
  google_calendar: "e.g. List all events for today and highlight any conflicts",
  slack: "e.g. Post a summary to the #updates Slack channel",
  monday: "e.g. Create a new item in the 'Backlog' board with the details from above",
  google_maps: "e.g. Find coffee shops near Tel Aviv city center, or get directions from Jerusalem to Tel Aviv",
  apollo: "e.g. Find VPs of Sales at B2B SaaS companies with 50-200 employees in the US",
  http_request: "e.g. Send the collected data as JSON to this endpoint",
  web_fetch: "e.g. Fetch the content from this URL and extract key information",
  google_search: "e.g. Search for the latest news about this topic and summarise it",
};

export type Connections = {
  gmail: boolean;
  calendar: boolean;
  monday: boolean;
  tasks: boolean;
  whatsapp: boolean;
  slack?: boolean;
  googleMaps?: boolean;
  apollo?: boolean;
};

interface FlowStepCardProps {
  step: AutomationStep;
  stepNumber: number;
  onChange: (step: AutomationStep) => void;
  onRemove: () => void;
  connections: Connections;
}

export default function FlowStepCard({ step, stepNumber, onChange, onRemove, connections }: FlowStepCardProps) {
  const available = FLOW_TOOLS.filter((t) => {
    if (!t.requires) return true;
    return connections[t.requires as keyof Connections];
  });
  const selected = FLOW_TOOLS.find((t) => t.key === step.tool);

  return (
    <div className="flow-step-card">
      <div className="flow-step-header">
        <span className="flow-step-number">{stepNumber}</span>

        <div className="flow-step-tool-selector">
          {selected && <span className="flow-step-tool-icon">{selected.icon}</span>}
          <select
            className="flow-tool-select"
            value={step.tool}
            onChange={(e) => onChange({ ...step, tool: e.target.value })}
          >
            <option value="">Select a tool…</option>
            {available.map((t) => (
              <option key={t.key} value={t.key}>{t.icon} {t.label}</option>
            ))}
          </select>
        </div>

        <button className="flow-step-remove" onClick={onRemove} title="Remove step">✕</button>
      </div>

      {step.tool === "http_request" && (
        <>
          <div className="flow-step-http-row">
            <select
              className="flow-http-method"
              value={step.httpMethod ?? "POST"}
              onChange={(e) => onChange({ ...step, httpMethod: e.target.value })}
            >
              <option>POST</option>
              <option>GET</option>
              <option>PUT</option>
              <option>PATCH</option>
            </select>
            <input
              className="flow-http-url"
              placeholder="https://your-server.com/api/webhook"
              value={step.httpUrl ?? ""}
              onChange={(e) => onChange({ ...step, httpUrl: e.target.value })}
            />
          </div>
          <div className="flow-step-http-auth-row">
            <input
              className="flow-http-auth-header"
              placeholder="Auth header (e.g. Authorization)"
              value={step.httpAuthHeader ?? ""}
              onChange={(e) => onChange({ ...step, httpAuthHeader: e.target.value || undefined })}
            />
            <input
              type="password"
              className="flow-http-auth-value"
              placeholder="Value (e.g. Bearer token123)"
              value={step.httpAuthValue ?? ""}
              onChange={(e) => onChange({ ...step, httpAuthValue: e.target.value || undefined })}
            />
          </div>
        </>
      )}

      <textarea
        className="flow-step-instruction"
        placeholder={TOOL_PLACEHOLDERS[step.tool] ?? "Describe what this step should do…"}
        value={step.instruction}
        onChange={(e) => onChange({ ...step, instruction: e.target.value })}
        rows={3}
      />
    </div>
  );
}
