import { useState, useCallback, useEffect } from "react";
import ChatWindow from "./components/ChatWindow";
import InputBar from "./components/InputBar";
import LoginPage from "./components/LoginPage";
import ConfigurePanel from "./components/ConfigurePanel";
import { sendMessage, getToken, getConfig, whoami } from "./api/client";
import type { DisplayMessage, HistoryItem, AgentConfig } from "./types";

type View = "builder" | "chat";

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
  const [isAdmin, setIsAdmin] = useState(false);
  const [view, setView] = useState<View>("builder");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(() => {
    const stored = localStorage.getItem("agent_config");
    try { return stored ? JSON.parse(stored) : null; } catch { return null; }
  });
  const [gmailUser, setGmailUser] = useState<string | null>(
    () => sessionStorage.getItem("gmail_user")
  );
  const [calendarUser, setCalendarUser] = useState<string | null>(
    () => sessionStorage.getItem("calendar_user")
  );

  useEffect(() => {
    if (!authed) return;
    getConfig().then((c) => setAgentConfig(c)).catch(() => {});
    whoami().then(({ isAdmin: a }) => {
      setIsAdmin(a);
      setView(a ? "builder" : "chat");
    }).catch(() => setView("chat"));
  }, [authed]);

  // Handle OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const email = params.get("google_email");
    const service = params.get("google_service");
    if (params.get("google_connected") === "true" && email && service) {
      if (service === "gmail") {
        sessionStorage.setItem("gmail_user", email);
        setGmailUser(email);
      } else if (service === "calendar") {
        sessionStorage.setItem("calendar_user", email);
        setCalendarUser(email);
      }
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const handleLogin = useCallback((adminFlag: boolean) => {
    setIsAdmin(adminFlag);
    setAuthed(true);
  }, []);

  const handleSend = useCallback(async (text: string) => {
    const userMsg: DisplayMessage = { id: crypto.randomUUID(), role: "user", text };
    const pendingMsg: DisplayMessage = { id: crypto.randomUUID(), role: "model", text: "", pending: true };
    setMessages((prev) => [...prev, userMsg, pendingMsg]);
    setLoading(true);

    const history: HistoryItem[] = messages
      .filter((m) => !m.pending)
      .map((m) => ({ role: m.role, parts: [{ text: m.text }] }));

    try {
      const result = await sendMessage(text, history, "tools", agentConfig?.systemPrompt, gmailUser ?? undefined, calendarUser ?? undefined);
      setMessages((prev) =>
        prev.map((m) => m.pending ? { ...m, text: result.reply, toolUses: result.toolUses, pending: false } : m)
      );
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) => m.pending ? { ...m, text: `Error: ${(err as Error).message}`, pending: false } : m)
      );
    } finally {
      setLoading(false);
    }
  }, [messages, agentConfig, gmailUser]);

  if (!authed) return <LoginPage onLogin={handleLogin} />;

  const title = agentConfig?.ui.title ?? "Boost Agent";
  const chatEnabled = agentConfig?.access?.chatEnabled ?? true;
  const gmailEnabled = agentConfig?.tools?.gmail ?? false;

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <span className="header-icon">✦</span>
          <h1>{title}</h1>
        </div>
        <div className="header-actions">
          {isAdmin ? (
            <>
              <button className={`view-tab ${view === "builder" ? "active" : ""}`} onClick={() => setView("builder")}>
                Builder
              </button>
              {chatEnabled && (
                <button className={`view-tab ${view === "chat" ? "active" : ""}`} onClick={() => setView("chat")}>
                  Chat
                </button>
              )}
            </>
          ) : (
            <span className="model-badge">Gemini 2.5 Flash</span>
          )}
        </div>
      </header>

      {view === "builder" ? (
        <ConfigurePanel
          onSave={(c) => setAgentConfig(c)}
          gmailUser={gmailUser}
          calendarUser={calendarUser}
          onGmailDisconnect={() => { sessionStorage.removeItem("gmail_user"); setGmailUser(null); }}
          onCalendarDisconnect={() => { sessionStorage.removeItem("calendar_user"); setCalendarUser(null); }}
        />
      ) : !chatEnabled ? (
        <div className="empty-state">
          <span className="empty-title">API Only</span>
          <span className="empty-sub">This agent is not available via chat. Use the API to interact with it.</span>
        </div>
      ) : (
        <>
          {gmailEnabled && gmailUser && (
            <div className="gmail-connected">
              Gmail: {gmailUser} &nbsp;
              <button onClick={() => { sessionStorage.removeItem("gmail_user"); setGmailUser(null); }}>
                Disconnect
              </button>
            </div>
          )}
          <ChatWindow messages={messages} />
          <InputBar
            onSend={handleSend}
            disabled={loading}
            placeholder={agentConfig?.ui.placeholder}
          />
        </>
      )}
    </div>
  );
}
