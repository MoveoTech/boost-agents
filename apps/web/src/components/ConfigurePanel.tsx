import { useState, useEffect } from "react";
import { getConfig, saveConfig, getApiKey } from "../api/client";
import type { AgentConfig } from "../types";

const TOOLS: { key: keyof AgentConfig["tools"]; label: string; description: string; warning?: string }[] = [
  { key: "fetchUrl", label: "Web Fetch", description: "GET any URL and read its content" },
  { key: "httpRequest", label: "HTTP Request", description: "POST/PUT/PATCH to REST APIs with JSON body" },
  { key: "googleSearch", label: "Google Search", description: "Search the web via Gemini built-in", warning: "Cannot be combined with Web Fetch or HTTP Request" },
  { key: "codeExecution", label: "Code Execution", description: "Run Python code via Gemini built-in", warning: "Cannot be combined with Web Fetch or HTTP Request" },
];

type Tab = "settings" | "api";
type DeployStatus = "idle" | "deploying" | "done" | "error";

const BASE = import.meta.env.VITE_API_URL ?? window.location.origin;
const STORAGE_KEY = "agent_config";

interface Props {
  onSave: (config: AgentConfig) => void;
}

export default function ConfigurePanel({ onSave }: Props) {
  const [tab, setTab] = useState<Tab>("settings");
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [status, setStatus] = useState<DeployStatus>("idle");
  const [commitUrl, setCommitUrl] = useState("");
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try { setConfig(JSON.parse(stored)); } catch {}
    }
    getConfig().then((c) => {
      setConfig(c);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    }).catch(() => {});
    getApiKey().then(setApiKey).catch(() => {});
  }, []);

  if (!config) return <div className="configure-loading">Loading config...</div>;

  const update = (patch: Partial<AgentConfig>) =>
    setConfig((c) => c ? { ...c, ...patch } : c);

  const updateTool = (key: keyof AgentConfig["tools"], val: boolean) =>
    setConfig((c) => c ? { ...c, tools: { ...c.tools, [key]: val } } : c);

  const updateUi = (patch: Partial<AgentConfig["ui"]>) =>
    setConfig((c) => c ? { ...c, ui: { ...c.ui, ...patch } } : c);

  const handleDeploy = async () => {
    setStatus("deploying");
    setError("");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    onSave(config);
    try {
      const { commitUrl: url } = await saveConfig(config);
      setCommitUrl(url);
      setStatus("done");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const curlExample = `curl -X POST ${BASE}/api/chat \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -d '{"message": "Hello!", "history": []}'`;

  return (
    <div className="configure-panel">
      <div className="configure-tabs">
        <button
          className={`configure-tab ${tab === "settings" ? "active" : ""}`}
          onClick={() => setTab("settings")}
        >
          Settings
        </button>
        <button
          className={`configure-tab ${tab === "api" ? "active" : ""}`}
          onClick={() => setTab("api")}
        >
          API Access
        </button>
      </div>

      {tab === "settings" ? (
        <>
          <div className="configure-body">
            <section className="configure-section">
              <h2 className="configure-section-title">Agent Identity</h2>
              <label className="configure-label">
                Name
                <input
                  className="configure-input"
                  value={config.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </label>
              <label className="configure-label">
                System Prompt
                <textarea
                  className="configure-textarea"
                  rows={5}
                  value={config.systemPrompt}
                  onChange={(e) => update({ systemPrompt: e.target.value })}
                />
              </label>
            </section>

            <section className="configure-section">
              <h2 className="configure-section-title">Tools</h2>
              {TOOLS.map(({ key, label, description, warning }) => (
                <label key={key} className="configure-toggle-row">
                  <div>
                    <span className="configure-toggle-label">{label}</span>
                    <span className="configure-toggle-desc">{description}</span>
                    {warning && <span className="configure-toggle-warning">{warning}</span>}
                  </div>
                  <input
                    type="checkbox"
                    className="configure-checkbox"
                    checked={config.tools[key]}
                    onChange={(e) => updateTool(key, e.target.checked)}
                  />
                </label>
              ))}
            </section>

            <section className="configure-section">
              <h2 className="configure-section-title">UI Settings</h2>
              <label className="configure-label">
                Chat Title
                <input
                  className="configure-input"
                  value={config.ui.title}
                  onChange={(e) => updateUi({ title: e.target.value })}
                />
              </label>
              <label className="configure-label">
                Input Placeholder
                <input
                  className="configure-input"
                  value={config.ui.placeholder}
                  onChange={(e) => updateUi({ placeholder: e.target.value })}
                />
              </label>
            </section>
          </div>

          <div className="configure-footer">
            {status === "done" && (
              <a className="configure-commit-link" href={commitUrl} target="_blank" rel="noreferrer">
                Deployed — view commit
              </a>
            )}
            {status === "error" && <span className="configure-error">{error}</span>}
            {status === "deploying" && (
              <span className="configure-deploying">Deploying... (~3 min)</span>
            )}
            <button
              className="configure-deploy-btn"
              onClick={handleDeploy}
              disabled={status === "deploying"}
            >
              {status === "deploying" ? "Deploying..." : "Deploy Changes"}
            </button>
          </div>
        </>
      ) : (
        <div className="configure-body">
          <section className="configure-section">
            <h2 className="configure-section-title">Server URL</h2>
            <div className="api-row">
              <code className="api-value">{BASE}</code>
              <button className="api-copy-btn" onClick={() => handleCopy(BASE)}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </section>

          <section className="configure-section">
            <h2 className="configure-section-title">API Key</h2>
            {apiKey ? (
              <div className="api-row">
                <code className="api-value">{apiKey}</code>
                <button className="api-copy-btn" onClick={() => handleCopy(apiKey)}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            ) : (
              <p className="configure-toggle-desc">
                Set the <code>API_KEY</code> GitHub secret to enable API key access.
              </p>
            )}
          </section>

          <section className="configure-section">
            <h2 className="configure-section-title">Example Request</h2>
            <div className="api-code-block">
              <pre>{curlExample}</pre>
              <button className="api-copy-btn api-copy-code" onClick={() => handleCopy(curlExample)}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="configure-toggle-desc" style={{ marginTop: 8 }}>
              Pass the full conversation in <code>history</code> on every call — the server is stateless.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
