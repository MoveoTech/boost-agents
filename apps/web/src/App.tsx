import { useState, useCallback, useEffect, useRef } from "react";
import ChatWindow from "./components/ChatWindow";
import InputBar from "./components/InputBar";
import LoginPage from "./components/LoginPage";
import AgentSidebar from "./components/AgentSidebar";
import ChatHistorySidebar from "./components/ChatHistorySidebar";
import { sendMessage, getConfig, whoami, getConnections, disconnectService, identityComplete, getUserSettings, saveUserSettings, listChats, createChat, loadChat, saveChat } from "./api/client";
import type { DisplayMessage, HistoryItem, AgentConfig, UserSettings, ChatSession } from "./types";

function loadLocalSettings(email: string): UserSettings {
  try { return JSON.parse(localStorage.getItem(`user_settings_${email}`) ?? "{}"); } catch { return {}; }
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings>({});
  const [mobileTab, setMobileTab] = useState<"history" | "chat" | "settings">("chat");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const currentChatIdRef = useRef<string | null>(null);

  currentChatIdRef.current = currentChatId;

  const checkSession = useCallback(() => {
    whoami().then(({ isAdmin: a, email, authenticated }) => {
      setAuthed(authenticated);
      if (authenticated) {
        setIsAdmin(a);
        if (email) setUserEmail(email);
        getConfig().then(setAgentConfig).catch(() => {});
        getConnections().then(({ gmail, calendar }) => { setGmailConnected(gmail); setCalendarConnected(calendar); }).catch(() => {});
        getUserSettings().then((s) => setUserSettings(s as UserSettings)).catch(() => {});
        listChats().then(setChatSessions).catch(() => {});
      }
    }).catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const identityToken = params.get("identity_token");
    if (identityToken) {
      window.history.replaceState({}, "", window.location.pathname);
      identityComplete(identityToken).then(() => checkSession()).catch(() => setAuthed(false));
      return;
    }
    if (params.get("google_connected") === "true") {
      window.history.replaceState({}, "", window.location.pathname);
      getConnections().then(({ gmail, calendar }) => { setGmailConnected(gmail); setCalendarConnected(calendar); }).catch(() => {});
    }
    checkSession();
  }, [checkSession]);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    setCurrentChatId(null);
    setMobileTab("chat");
  }, []);

  const handleSelectChat = useCallback(async (id: string) => {
    const data = await loadChat(id);
    if (!data) return;
    const msgs: DisplayMessage[] = (data.messages ?? []).map((m: any) => ({ ...m, pending: false }));
    setMessages(msgs);
    setCurrentChatId(id);
    setMobileTab("chat");
  }, []);

  const handleDeleteChat = useCallback((id: string) => {
    setChatSessions((prev) => prev.filter((s) => s.id !== id));
    if (currentChatIdRef.current === id) {
      setMessages([]);
      setCurrentChatId(null);
    }
  }, []);

  const handleUserSettingsChange = useCallback((s: UserSettings) => {
    setUserSettings(s);
    saveUserSettings(s as Record<string, unknown>).catch(() => {});
  }, []);

  const handleSend = useCallback(async (text: string) => {
    const userMsg: DisplayMessage = { id: crypto.randomUUID(), role: "user", text };
    const pendingMsg: DisplayMessage = { id: crypto.randomUUID(), role: "model", text: "", pending: true };
    setMessages((prev) => [...prev, userMsg, pendingMsg]);
    setLoading(true);

    // Create a new session on first message
    let chatId = currentChatIdRef.current;
    if (!chatId) {
      const title = text.slice(0, 50) + (text.length > 50 ? "…" : "");
      chatId = await createChat(title).catch(() => null);
      if (chatId) {
        setCurrentChatId(chatId);
        const newSession: ChatSession = { id: chatId, title, updatedAt: new Date().toISOString(), messageCount: 0 };
        setChatSessions((prev) => [newSession, ...prev]);
      }
    }

    const history: HistoryItem[] = messages
      .filter((m) => !m.pending)
      .map((m) => ({ role: m.role, parts: [{ text: m.text }] }));

    try {
      const model = userSettings.model ?? agentConfig?.model;
      const systemPrompt = userSettings.systemPrompt ?? agentConfig?.systemPrompt;
      const result = await sendMessage(text, history, "tools", systemPrompt, model);
      const botMsg: DisplayMessage = { id: crypto.randomUUID(), role: "model", text: result.reply, toolUses: result.toolUses };
      setMessages((prev) => prev.map((m) => m.pending ? botMsg : m));

      // Save to Firestore
      if (chatId) {
        const allMsgs = [...messages.filter((m) => !m.pending), userMsg, botMsg];
        await saveChat(chatId, allMsgs).catch(() => {});
        setChatSessions((prev) => prev.map((s) => s.id === chatId ? { ...s, updatedAt: new Date().toISOString(), messageCount: allMsgs.length } : s));
      }
    } catch (err) {
      setMessages((prev) => prev.map((m) => m.pending ? { ...m, text: `Error: ${(err as Error).message}`, pending: false } : m));
    } finally {
      setLoading(false);
    }
  }, [messages, agentConfig, userSettings]);

  if (authed === null) return null;
  if (!authed) return <LoginPage />;

  const title = agentConfig?.ui?.title ?? agentConfig?.name ?? "Boost Agent";
  const placeholder = agentConfig?.ui?.placeholder;
  const effectiveModel = userSettings.model ?? agentConfig?.model;
  const modelLabel = effectiveModel?.modelId
    ? effectiveModel.modelId.replace("gemini-", "Gemini ").replace("claude-", "Claude ").replace("gpt-", "GPT-").replace("-20251001", "")
    : "Gemini 2.5 Flash";

  return (
    <div className="app app-admin">
      <ChatHistorySidebar
        sessions={chatSessions}
        currentId={currentChatId}
        onSelect={handleSelectChat}
        onNew={handleNewChat}
        onDelete={handleDeleteChat}
        collapsed={historyCollapsed}
        onToggle={() => setHistoryCollapsed((v) => !v)}
        className={mobileTab !== "history" ? "mobile-hidden" : ""}
      />

      <div className={`chat-area${mobileTab !== "chat" ? " mobile-hidden" : ""}`}>
        <header className="header">
          <div className="header-title">
            <span className="header-icon">✦</span>
            <h1>{title}</h1>
          </div>
          <span className="model-badge">{modelLabel}</span>
        </header>
        <ChatWindow messages={messages} />
        <InputBar onSend={handleSend} disabled={loading} placeholder={placeholder} />
      </div>

      <AgentSidebar
        isAdmin={isAdmin}
        userEmail={userEmail}
        agentConfig={agentConfig}
        onSave={(c) => setAgentConfig(c)}
        userSettings={userSettings}
        onUserSettingsChange={handleUserSettingsChange}
        gmailConnected={gmailConnected}
        calendarConnected={calendarConnected}
        onGmailDisconnect={() => disconnectService("gmail").then(() => setGmailConnected(false))}
        onCalendarDisconnect={() => disconnectService("calendar").then(() => setCalendarConnected(false))}
        className={mobileTab !== "settings" ? "mobile-hidden" : ""}
      />

      <nav className="mobile-tab-bar">
        <button className={`mobile-tab-btn${mobileTab === "history" ? " active" : ""}`} onClick={() => setMobileTab("history")}>History</button>
        <button className={`mobile-tab-btn${mobileTab === "chat" ? " active" : ""}`} onClick={() => setMobileTab("chat")}>Chat</button>
        <button className={`mobile-tab-btn${mobileTab === "settings" ? " active" : ""}`} onClick={() => setMobileTab("settings")}>Settings</button>
      </nav>
    </div>
  );
}
