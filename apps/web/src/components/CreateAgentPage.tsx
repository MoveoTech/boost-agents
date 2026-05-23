import { useState, useEffect, useRef } from "react";
import { whoami, createAgent, getAgentStatus } from "../api/client";

type PageState = "loading" | "unauthed" | "form" | "creating" | "deploying" | "success" | "error";

const MODELS = [
  { label: "Gemini 2.5 Flash (default)", value: "gemini|gemini-2.5-flash" },
  { label: "Gemini 2.5 Pro", value: "gemini|gemini-2.5-pro" },
  { label: "Claude Sonnet 4.6", value: "claude|claude-sonnet-4-6" },
  { label: "GPT-4o", value: "openai|gpt-4o" },
];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
}

export default function CreateAgentPage() {
  const [pageState, setPageState] = useState<PageState>("loading");
  const [isAdmin, setIsAdmin] = useState(false);

  // Form fields
  const [agentName, setAgentName] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [adminEmails, setAdminEmails] = useState("");
  const [oauthEmails, setOauthEmails] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState("gemini|gemini-2.5-flash");

  // Section collapse state
  const [showAccess, setShowAccess] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [showPersonality, setShowPersonality] = useState(false);

  // Result state
  const [repoName, setRepoName] = useState("");
  const [deployStatus, setDeployStatus] = useState<"pending" | "in_progress" | "success" | "failed">("pending");
  const [runUrl, setRunUrl] = useState<string | undefined>();
  const [errorMsg, setErrorMsg] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    whoami().then(({ authenticated, isAdmin: a }) => {
      setIsAdmin(a);
      setPageState(authenticated && a ? "form" : authenticated ? "unauthed" : "unauthed");
    });
  }, []);

  // Poll deploy status
  useEffect(() => {
    if (pageState !== "deploying" || !repoName) return;
    const poll = async () => {
      const { status, runUrl: url } = await getAgentStatus(repoName);
      setDeployStatus(status);
      if (url) setRunUrl(url);
      if (status === "success" || status === "failed") {
        setPageState("success");
        if (pollRef.current) clearInterval(pollRef.current);
      }
    };
    poll(); // immediate first check
    pollRef.current = setInterval(poll, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pageState, repoName]);

  const handleSubmit = async () => {
    if (!agentName.trim() || !geminiKey.trim()) return;
    setPageState("creating");
    setErrorMsg("");
    try {
      const [modelProvider, modelId] = model.split("|");
      const { repoName: rn } = await createAgent({
        agentName: agentName.trim(),
        geminiApiKey: geminiKey.trim(),
        adminEmails: adminEmails.trim() || undefined,
        oauthEmails: oauthEmails.trim() || undefined,
        anthropicApiKey: anthropicKey.trim() || undefined,
        openaiApiKey: openaiKey.trim() || undefined,
      });
      setRepoName(rn);
      setDeployStatus("pending");
      setPageState("deploying");
      void modelProvider; void modelId; // system prompt & model applied via config after deploy
    } catch (e) {
      setErrorMsg((e as Error).message ?? "Something went wrong");
      setPageState("error");
    }
  };

  const slug = slugify(agentName);

  if (pageState === "loading") {
    return (
      <div className="cap-shell">
        <div className="cap-spinner" />
      </div>
    );
  }

  if (pageState === "unauthed") {
    return (
      <div className="cap-shell">
        <div className="cap-card">
          <div className="cap-logo">boost</div>
          <p style={{ color: "var(--muted)", textAlign: "center", marginTop: 8 }}>
            {isAdmin ? "Sign in to create agents." : "Admin access required to create agents."}
          </p>
          <a href="/" className="cap-btn cap-btn-secondary" style={{ display: "block", textAlign: "center", marginTop: 16, textDecoration: "none" }}>
            Back to agent
          </a>
        </div>
      </div>
    );
  }

  if (pageState === "creating" || pageState === "deploying" || pageState === "success") {
    const steps = [
      { label: "Repository created", done: true },
      { label: "Secrets configured", done: true },
      { label: "Deploy triggered", done: true },
      {
        label: deployStatus === "success" ? "Deployed successfully" : deployStatus === "failed" ? "Deploy failed" : "Building & deploying…",
        done: deployStatus === "success",
        failed: deployStatus === "failed",
        spinning: pageState === "deploying" && deployStatus !== "success" && deployStatus !== "failed",
      },
    ];
    const creating = pageState === "creating";
    const done = pageState === "success" && deployStatus === "success";
    const failed = deployStatus === "failed";

    return (
      <div className="cap-shell">
        <div className="cap-card">
          <div className="cap-logo">boost</div>
          <h2 className="cap-title" style={{ marginTop: 16 }}>
            {creating ? "Creating agent…" : done ? "Agent is live!" : failed ? "Deploy failed" : `Deploying ${repoName}…`}
          </h2>

          {creating ? (
            <div style={{ display: "flex", justifyContent: "center", margin: "24px 0" }}>
              <div className="cap-spinner" />
            </div>
          ) : (
            <ul className="cap-steps">
              {steps.map((s, i) => (
                <li key={i} className={`cap-step ${s.done ? "done" : s.failed ? "failed" : s.spinning ? "spinning" : ""}`}>
                  <span className="cap-step-icon">
                    {s.done ? "✓" : s.failed ? "✗" : s.spinning ? <span className="cap-spinner-sm" /> : "○"}
                  </span>
                  {s.label}
                </li>
              ))}
            </ul>
          )}

          {!creating && !done && !failed && (
            <p className="cap-hint">First deploy takes ~8 minutes. You can close this tab — the deploy will continue.</p>
          )}

          {(done || failed) && (
            <div className="cap-success-links">
              {done && <p className="cap-success-note">Find your agent URL in the deploy Actions summary below.</p>}
              {failed && <p className="cap-error-note">The deploy failed. Check the Actions log for details.</p>}
              <a href={`https://github.com/MoveoTech/${repoName}/actions`} target="_blank" rel="noopener" className="cap-link-row">
                <span>GitHub Actions</span>
                <span className="cap-link-arrow">↗</span>
              </a>
              <a href={`https://github.com/MoveoTech/${repoName}`} target="_blank" rel="noopener" className="cap-link-row">
                <span>GitHub repository</span>
                <span className="cap-link-arrow">↗</span>
              </a>
              <a href={`https://console.cloud.google.com/run?project=boost-${repoName}-v7`} target="_blank" rel="noopener" className="cap-link-row">
                <span>GCP Cloud Run console</span>
                <span className="cap-link-arrow">↗</span>
              </a>
              {runUrl && (
                <a href={runUrl} target="_blank" rel="noopener" className="cap-link-row">
                  <span>Deploy run details</span>
                  <span className="cap-link-arrow">↗</span>
                </a>
              )}
              <a href="/create-agent" className="cap-btn cap-btn-secondary" style={{ display: "block", textAlign: "center", marginTop: 16, textDecoration: "none" }}>
                Create another agent
              </a>
            </div>
          )}

          {!creating && !done && !failed && (
            <div className="cap-success-links" style={{ marginTop: 8 }}>
              <a href={`https://github.com/MoveoTech/${repoName}/actions`} target="_blank" rel="noopener" className="cap-link-row">
                <span>Watch deploy progress</span>
                <span className="cap-link-arrow">↗</span>
              </a>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (pageState === "error") {
    return (
      <div className="cap-shell">
        <div className="cap-card">
          <div className="cap-logo">boost</div>
          <h2 className="cap-title" style={{ marginTop: 16, color: "#dc2626" }}>Failed to create agent</h2>
          <p className="cap-hint" style={{ color: "#dc2626", background: "#fef2f2", borderRadius: 8, padding: "10px 14px", marginTop: 12 }}>{errorMsg}</p>
          <button className="cap-btn cap-btn-secondary" style={{ marginTop: 16, width: "100%" }} onClick={() => setPageState("form")}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Form state
  return (
    <div className="cap-shell">
      <div className="cap-card">
        <div className="cap-logo">boost</div>
        <h2 className="cap-title">Create a new agent</h2>
        <p className="cap-subtitle">Set up a new Boost agent. It will be deployed automatically.</p>

        {/* Required */}
        <div className="cap-section">
          <div className="cap-field">
            <label className="cap-label">Agent name <span className="cap-required">*</span></label>
            <input
              className="cap-input"
              placeholder="e.g. acme-hr"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              autoFocus
            />
            {agentName && <div className="cap-hint">Repo will be created as <strong>MoveoTech/{slug}</strong></div>}
          </div>
          <div className="cap-field">
            <label className="cap-label">Gemini API key <span className="cap-required">*</span></label>
            <input
              className="cap-input"
              type="password"
              placeholder="AIza…"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
            />
            <div className="cap-hint">Get one at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com</a></div>
          </div>
        </div>

        {/* Optional: Personality */}
        <button className="cap-section-toggle" onClick={() => setShowPersonality(!showPersonality)}>
          <span>Personality</span>
          <span className="cap-chevron">{showPersonality ? "▲" : "▼"}</span>
        </button>
        {showPersonality && (
          <div className="cap-section">
            <div className="cap-field">
              <label className="cap-label">System prompt</label>
              <textarea
                className="cap-input cap-textarea"
                placeholder="You are a helpful AI assistant for Acme Corp…"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={4}
              />
              <div className="cap-hint">Can be changed anytime in the agent's Settings → Configure.</div>
            </div>
            <div className="cap-field">
              <label className="cap-label">Default model</label>
              <select className="cap-input" value={model} onChange={(e) => setModel(e.target.value)}>
                {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>
        )}

        {/* Optional: Access */}
        <button className="cap-section-toggle" onClick={() => setShowAccess(!showAccess)}>
          <span>Access</span>
          <span className="cap-chevron">{showAccess ? "▲" : "▼"}</span>
        </button>
        {showAccess && (
          <div className="cap-section">
            <div className="cap-field">
              <label className="cap-label">Admin emails</label>
              <input
                className="cap-input"
                placeholder="alice@acme.com, bob@acme.com"
                value={adminEmails}
                onChange={(e) => setAdminEmails(e.target.value)}
              />
              <div className="cap-hint">Comma-separated. These users see the configuration sidebar.</div>
            </div>
            <div className="cap-field">
              <label className="cap-label">OAuth test user emails</label>
              <input
                className="cap-input"
                placeholder="alice@acme.com"
                value={oauthEmails}
                onChange={(e) => setOauthEmails(e.target.value)}
              />
              <div className="cap-hint">Required for Gmail and Calendar access. Comma-separated.</div>
            </div>
          </div>
        )}

        {/* Optional: Additional models */}
        <button className="cap-section-toggle" onClick={() => setShowModels(!showModels)}>
          <span>Additional AI models</span>
          <span className="cap-chevron">{showModels ? "▲" : "▼"}</span>
        </button>
        {showModels && (
          <div className="cap-section">
            <div className="cap-field">
              <label className="cap-label">Anthropic API key</label>
              <input
                className="cap-input"
                type="password"
                placeholder="sk-ant-…"
                value={anthropicKey}
                onChange={(e) => setAnthropicKey(e.target.value)}
              />
              <div className="cap-hint">Required for Claude models.</div>
            </div>
            <div className="cap-field">
              <label className="cap-label">OpenAI API key</label>
              <input
                className="cap-input"
                type="password"
                placeholder="sk-…"
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
              />
              <div className="cap-hint">Required for GPT and o-series models.</div>
            </div>
          </div>
        )}

        {/* Tools/Skills note */}
        <div className="cap-tools-note">
          Tools, skills and automations can be configured in the agent UI after creation.
        </div>

        <button
          className="cap-btn cap-btn-primary"
          disabled={!agentName.trim() || !geminiKey.trim()}
          onClick={handleSubmit}
        >
          Create agent
        </button>

        <a href="/" className="cap-back-link">← Back to agent</a>
      </div>
    </div>
  );
}
