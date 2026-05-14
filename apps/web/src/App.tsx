import { useState, useCallback, useEffect } from "react";
import ChatWindow from "./components/ChatWindow";
import InputBar from "./components/InputBar";
import LoginPage from "./components/LoginPage";
import ConfigurePanel from "./components/ConfigurePanel";
import ConnectGmail from "./components/ConnectGmail";
import { sendMessage, getToken, getConfig, whoami } from "./api/client";
import type { DisplayMessage, HistoryItem, AgentConfig, Mode } from "./types";

type View = "builder" | "chat";

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
  const [isAdmin, setIsAdmin] = useState(false);
  const [view, setView] = useState<View>("builder");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>("tools");
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(() => {
    const stored = localStorage.getItem("agent_config");
    try { return stored ? JSON.parse(stored) : null; } catch { return null; }
  });
  const [gmailUser, setGmailUser] = useState<string | null>(
    () => sessionStorage.getItem("gmail_user")
  );

  useEffect(() => {
    if (!authed) return;
    getConfig().then((c) => setAgentConfig(c)).catch(() => {});
    whoami().then(({ isAdmin: a }) => {
      setIsAdmin(a);
      // admins land on builder, regular users go straight to chat
      setView(a ? "builder" : "chat");
    }).catch(() => setView("chat"));
  }, [authed]);

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
      const result = await sendMessage(text, history, mode, agentConfig?.systemPrompt, gmailUser ?? undefined);
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
  }, [messages, mode, agentConfig, gmailUser]);

  if (!authed) return <LoginPage onLogin={handleLogin} />;

  const title = agentConfig?.ui.title ?? "Boost Agent";
  const chatEnabled = agentConfig?.access.chatEnabled ?? true;
  const gmailEnabled = agentConfig?.tools.gmail ?? false;

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <span className="header-icon">✦</span>
          <h1>{title}</h1>
        </div>
        <div className="header-actions">
          {isAdmin && (
            <>
              <button
                className={`view-tab ${view === "builder" ? "active" : ""}`}
                onClick={() => setView("builder")}
              >
                Builder
              </button>
              {chatEnabled && (
                <button
                  className={`view-tab ${view === "chat" ? "active" : ""}`}
                  onClick={() => setView("chat")}
                >
                  Chat
                </button>
              )}
            </>
          )}
          {!isAdmin && <span className="model-badge">Gemini 2.5 Flash</span>}
        </div>
      </header>

      {view === "builder" ? (
        <ConfigurePanel onSave={(c) => setAgentConfig(c)} />
      ) : !chatEnabled ? (
        <div className="empty-state">
          <span className="empty-title">API Only</span>
          <span className="empty-sub">This agent is not available via chat. Use the API to interact with it.</span>
        </div>
      ) : (
        <>
          {gmailEnabled && !gmailUser && (
            <ConnectGmail onConnected={(email) => setGmailUser(email)} />
          )}
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
            mode={mode}
            onModeChange={setMode}
          />
        </>
      )}
    </div>
  );
}
