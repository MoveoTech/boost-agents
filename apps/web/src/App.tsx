import { useState, useCallback, useEffect } from "react";
import ChatWindow from "./components/ChatWindow";
import InputBar from "./components/InputBar";
import LoginPage from "./components/LoginPage";
import ConfigurePanel from "./components/ConfigurePanel";
import { sendMessage, getToken, getConfig, whoami } from "./api/client";
import type { DisplayMessage, HistoryItem, AgentConfig } from "./types";

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
  const [isAdmin, setIsAdmin] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [uiConfig, setUiConfig] = useState<AgentConfig["ui"] | null>(null);

  useEffect(() => {
    if (!authed) return;
    getConfig().then((c) => setUiConfig(c.ui)).catch(() => {});
    whoami().then(({ isAdmin: a }) => setIsAdmin(a)).catch(() => {});
  }, [authed]);

  const handleLogin = useCallback(async (adminFlag: boolean) => {
    setIsAdmin(adminFlag);
    setAuthed(true);
  }, []);

  const handleSend = useCallback(
    async (text: string) => {
      const userMsg: DisplayMessage = { id: crypto.randomUUID(), role: "user", text };
      const pendingMsg: DisplayMessage = {
        id: crypto.randomUUID(),
        role: "model",
        text: "",
        pending: true,
      };

      setMessages((prev) => [...prev, userMsg, pendingMsg]);
      setLoading(true);

      const history: HistoryItem[] = messages
        .filter((m) => !m.pending)
        .map((m) => ({ role: m.role, parts: [{ text: m.text }] }));

      try {
        const result = await sendMessage(text, history);
        setMessages((prev) =>
          prev.map((m) =>
            m.pending
              ? { ...m, text: result.reply, toolUses: result.toolUses, pending: false }
              : m
          )
        );
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) =>
            m.pending
              ? { ...m, text: `Error: ${(err as Error).message}`, pending: false }
              : m
          )
        );
      } finally {
        setLoading(false);
      }
    },
    [messages]
  );

  if (!authed) return <LoginPage onLogin={handleLogin} />;

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <span className="header-icon">✦</span>
          <h1>{uiConfig?.title ?? "Boost Agent"}</h1>
        </div>
        <div className="header-actions">
          <span className="model-badge">Gemini 2.5 Flash</span>
          {isAdmin && (
            <button
              className={`configure-btn ${configuring ? "active" : ""}`}
              onClick={() => setConfiguring((v) => !v)}
              title="Configure agent"
            >
              ⚙
            </button>
          )}
        </div>
      </header>
      {configuring ? (
        <ConfigurePanel />
      ) : (
        <>
          <ChatWindow messages={messages} />
          <InputBar
            onSend={handleSend}
            disabled={loading}
            placeholder={uiConfig?.placeholder}
          />
        </>
      )}
    </div>
  );
}
