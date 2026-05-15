import { useState, useCallback, useEffect } from "react";
import ChatWindow from "./components/ChatWindow";
import InputBar from "./components/InputBar";
import LoginPage from "./components/LoginPage";
import AgentSidebar from "./components/AgentSidebar";
import { sendMessage, getToken, getConfig, whoami } from "./api/client";
import type { DisplayMessage, HistoryItem, AgentConfig } from "./types";

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
  const [isAdmin, setIsAdmin] = useState(false);
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
    whoami().then(({ isAdmin: a }) => setIsAdmin(a)).catch(() => {});
  }, [authed]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const email = params.get("google_email");
    const service = params.get("google_service");
    if (params.get("google_connected") === "true" && email && service) {
      if (service === "gmail") { sessionStorage.setItem("gmail_user", email); setGmailUser(email); }
      else if (service === "calendar") { sessionStorage.setItem("calendar_user", email); setCalendarUser(email); }
      window.history.replaceState({}, "", window.location.pathname);
    }
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
  }, [messages, agentConfig, gmailUser, calendarUser]);

  if (!authed) return <LoginPage onLogin={(adminFlag) => { setIsAdmin(adminFlag); setAuthed(true); }} />;

  const title = agentConfig?.ui?.title ?? agentConfig?.name ?? "Boost Agent";
  const placeholder = agentConfig?.ui?.placeholder;

  return (
    <div className={`app ${isAdmin ? "app-admin" : ""}`}>
      {/* Chat area */}
      <div className="chat-area">
        <header className="header">
          <div className="header-title">
            <span className="header-icon">✦</span>
            <h1>{title}</h1>
          </div>
          <span className="model-badge">Gemini 2.5 Flash</span>
        </header>
        <ChatWindow messages={messages} />
        <InputBar onSend={handleSend} disabled={loading} placeholder={placeholder} />
      </div>

      {/* Sidebar — admin only */}
      {isAdmin && (
        <AgentSidebar
          agentConfig={agentConfig}
          onSave={(c) => setAgentConfig(c)}
          gmailUser={gmailUser}
          calendarUser={calendarUser}
          onGmailDisconnect={() => { sessionStorage.removeItem("gmail_user"); setGmailUser(null); }}
          onCalendarDisconnect={() => { sessionStorage.removeItem("calendar_user"); setCalendarUser(null); }}
        />
      )}
    </div>
  );
}
