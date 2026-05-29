import { useState, useCallback, useEffect, useRef } from "react";
import ChatWindow from "./components/ChatWindow";
import InputBar from "./components/InputBar";
import LoginPage from "./components/LoginPage";
import AgentSidebar from "./components/AgentSidebar";
import ChatHistorySidebar from "./components/ChatHistorySidebar";
import WelcomeAnimation from "./components/WelcomeAnimation";
import CreateAgentPage from "./components/CreateAgentPage";
import SuperAdminPage from "./components/SuperAdminPage";
import FlowsPage from "./components/FlowsPage";
import {
  streamMessage, getConfig, whoami, getConnections, disconnectService,
  identityComplete, getUserSettings, saveUserSettings,
  listChats, createChat, loadChat, saveChat, submitFeedback,
  disconnectWhatsApp,
} from "./api/client";
import type { DisplayMessage, HistoryItem, AgentConfig, UserSettings, ChatSession, ToolUse } from "./types";

function getStoredDarkMode(): boolean {
  try { return localStorage.getItem("darkMode") === "true"; } catch { return false; }
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [canCreateAgents, setCanCreateAgents] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings>({});
  const [mobileTab, setMobileTab] = useState<"history" | "chat" | "settings" | "flows">("chat");
  const [activeView, setActiveView] = useState<"chat" | "flows">("chat");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(null);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [mondayConnected, setMondayConnected] = useState(false);
  const [tasksConnected, setTasksConnected] = useState(false);
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [whatsappStatus, setWhatsappStatus] = useState<"connected" | "disconnected" | "connecting" | "qr">("disconnected");
  const [whatsappOwners, setWhatsappOwners] = useState<string[]>([]);
  const [googleMapsConnected, setGoogleMapsConnected] = useState(false);

  // Poll status while in transient states so the UI updates without manual refresh.
  useEffect(() => {
    if (whatsappStatus !== "connecting" && whatsappStatus !== "qr") return;
    const id = setInterval(() => {
      getConnections().then(({ whatsapp, whatsappStatus: s, googleMaps }) => { setWhatsappConnected(whatsapp); setWhatsappStatus(s); setGoogleMapsConnected(googleMaps); }).catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [whatsappStatus]);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [darkMode, setDarkMode] = useState(getStoredDarkMode);
  const [showWelcome, setShowWelcome] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<{ data: string; mimeType: string; name: string } | null>(null);
  const currentChatIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastUserMessageRef = useRef<string>("");
  const [prefillInput, setPrefillInput] = useState<{ text: string; ts: number } | null>(null);

  currentChatIdRef.current = currentChatId;

  // Apply dark mode class to document
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
    try { localStorage.setItem("darkMode", darkMode ? "true" : "false"); } catch {}
  }, [darkMode]);

  const checkSession = useCallback(() => {
    whoami().then(({ isAdmin: a, email, authenticated, canCreateAgents: cca }) => {
      setAuthed(authenticated);
      setCanCreateAgents(cca);
      if (authenticated) {
        setIsAdmin(a);
        if (email) setUserEmail(email);
        getConfig().then(setAgentConfig).catch(() => {});
        getConnections()
          .then(({ gmail, calendar, monday, tasks, whatsapp, whatsappStatus, whatsappOwners, googleMaps }) => { setGmailConnected(gmail); setCalendarConnected(calendar); setMondayConnected(monday); setTasksConnected(tasks); setWhatsappConnected(whatsapp); setWhatsappStatus(whatsappStatus); setWhatsappOwners(whatsappOwners); setGoogleMapsConnected(googleMaps); })
          .catch(() => {})
          .finally(() => setConnectionsLoading(false));
        getUserSettings().then((s) => setUserSettings(s as UserSettings)).catch(() => {});
        listChats()
          .then(setChatSessions)
          .catch(() => {})
          .finally(() => setHistoryLoading(false));
      }
    }).catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const identityToken = params.get("identity_token");
    if (identityToken) {
      window.history.replaceState({}, "", window.location.pathname);
      identityComplete(identityToken)
        .then(() => { setShowWelcome(true); return checkSession(); })
        .catch(() => setAuthed(false));
      return;
    }
    if (params.get("google_connected") === "true" || params.get("monday_connected") === "true") {
      window.history.replaceState({}, "", window.location.pathname);
      getConnections().then(({ gmail, calendar, monday, tasks, whatsapp, whatsappStatus, whatsappOwners }) => { setGmailConnected(gmail); setCalendarConnected(calendar); setMondayConnected(monday); setTasksConnected(tasks); setWhatsappConnected(whatsapp); setWhatsappStatus(whatsappStatus); setWhatsappOwners(whatsappOwners); }).catch(() => {});
    }
    checkSession();
  }, [checkSession]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Cmd+K → new chat
      if (mod && e.key === "k") { e.preventDefault(); handleNewChat(); }
      // Cmd+/ → focus input
      if (mod && e.key === "/") { e.preventDefault(); inputRef.current?.focus(); }
      // Escape → blur input / close mobile sidebar
      if (e.key === "Escape") {
        if (document.activeElement === inputRef.current) inputRef.current?.blur();
        else setMobileTab("chat");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogout = useCallback(async () => {
    await fetch(`${import.meta.env.VITE_API_URL ?? ""}/api/logout`, { method: "POST" });
    window.location.reload();
  }, []);

  const handleNewChat = useCallback(() => {
    setMessages([]);
    setCurrentChatId(null);
    setPendingAttachment(null);
    setMobileTab("chat");
    setTimeout(() => inputRef.current?.focus(), 50);
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
    if (currentChatIdRef.current === id) { setMessages([]); setCurrentChatId(null); }
  }, []);

  const handleUserSettingsChange = useCallback((s: UserSettings) => {
    setUserSettings(s);
    saveUserSettings(s as Record<string, unknown>).catch(() => {});
  }, []);

  const handleFeedback = useCallback((messageId: string, rating: 1 | -1) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === messageId);
      const agentResponse = prev[idx]?.text;
      const userMessage = idx > 0 ? [...prev].slice(0, idx).reverse().find((m) => m.role === "user")?.text : undefined;
      submitFeedback(messageId, rating, { userMessage, agentResponse }).catch(() => {});
      return prev.map((m) => m.id === messageId ? { ...m, feedback: rating } : m);
    });
  }, []);

  const handleExport = useCallback(() => {
    const text = messages
      .filter((m) => !m.pending)
      .map((m) => `${m.role === "user" ? "You" : "Agent"}: ${m.text}`)
      .join("\n\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [messages]);

  const handleSend = useCallback(async (text: string, attachment?: { data: string; mimeType: string; name: string }) => {
    const att = attachment ?? pendingAttachment ?? undefined;
    setPendingAttachment(null);
    lastUserMessageRef.current = text;

    const userMsg: DisplayMessage = {
      id: crypto.randomUUID(), role: "user", text,
      ...(att ? { attachment: { name: att.name, mimeType: att.mimeType } } : {}),
    };
    const botMsgId = crypto.randomUUID();
    const pendingMsg: DisplayMessage = { id: botMsgId, role: "model", text: "", pending: true };
    setMessages((prev) => [...prev, userMsg, pendingMsg]);
    setLoading(true);
    setIsResponding(true);

    // Create chat session on first message
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

    const model = userSettings.model ?? agentConfig?.model;
    const systemPrompt = userSettings.systemPrompt ?? agentConfig?.systemPrompt;

    const collectedToolUses: ToolUse[] = [];
    let hasFirstToken = false;
    let finalText = "";

    try {
      const stream = streamMessage(text, history, "tools", systemPrompt, model, att);
      for await (const event of stream) {
        if (event.type === "token") {
          if (!hasFirstToken) {
            hasFirstToken = true;
            setMessages((prev) => prev.map((m) =>
              m.id === botMsgId ? { ...m, pending: false, text: event.content } : m
            ));
          } else {
            setMessages((prev) => prev.map((m) =>
              m.id === botMsgId ? { ...m, text: m.text + event.content } : m
            ));
          }
          finalText += event.content;
        } else if (event.type === "tool_start") {
          collectedToolUses.push({ name: event.tool.name, input: event.tool.input });
          setMessages((prev) => prev.map((m) =>
            m.id === botMsgId ? { ...m, pending: false, toolUses: [...collectedToolUses] } : m
          ));
        } else if (event.type === "tool_complete") {
          const t = collectedToolUses.find((x) => x.name === event.tool.name && !x.output);
          if (t) t.output = event.tool.output;
          setMessages((prev) => prev.map((m) =>
            m.id === botMsgId ? { ...m, toolUses: [...collectedToolUses] } : m
          ));
        } else if (event.type === "done") {
          setMessages((prev) => prev.map((m) =>
            m.id === botMsgId ? { ...m, pending: false, toolUses: event.toolUses } : m
          ));
        } else if (event.type === "error") {
          setMessages((prev) => prev.map((m) =>
            m.id === botMsgId ? { ...m, pending: false, text: `Error: ${event.message}` } : m
          ));
        }
      }

      // Save to Firestore after stream ends
      if (chatId) {
        setMessages((prev) => {
          const allMsgs = prev.filter((m) => !m.pending);
          saveChat(chatId!, allMsgs).catch(() => {});
          setChatSessions((s) => s.map((ses) =>
            ses.id === chatId ? { ...ses, updatedAt: new Date().toISOString(), messageCount: allMsgs.length } : ses
          ));
          return prev;
        });
      }
    } catch (err) {
      setMessages((prev) => prev.map((m) =>
        m.id === botMsgId ? { ...m, pending: false, text: `Error: ${(err as Error).message}` } : m
      ));
    } finally {
      setLoading(false);
      setIsResponding(false);
    }
  }, [messages, agentConfig, userSettings, pendingAttachment]);

  const handleRetry = useCallback(() => {
    if (lastUserMessageRef.current) handleSend(lastUserMessageRef.current);
  }, [handleSend]);

  const handleEditRetry = useCallback(() => {
    if (lastUserMessageRef.current) {
      setPrefillInput({ text: lastUserMessageRef.current, ts: Date.now() });
      setMobileTab("chat");
    }
  }, []);

  if (authed === null) return null;
  if (!authed) return <LoginPage />;

  const title = agentConfig?.ui?.title ?? agentConfig?.name ?? "Boost Agent";
  const placeholder = agentConfig?.ui?.placeholder;
  const starterPrompts = agentConfig?.ui?.starterPrompts ?? [];
  const effectiveModel = userSettings.model ?? agentConfig?.model;
  const modelLabel = effectiveModel?.modelId
    ? effectiveModel.modelId.replace("gemini-", "Gemini ").replace("claude-", "Claude ").replace("gpt-", "GPT-").replace("-20251001", "")
    : "Gemini 2.5 Flash";

  if (canCreateAgents && authed) {
    if (window.location.pathname === "/superadmin") return <SuperAdminPage email={userEmail} />;
    return <CreateAgentPage email={userEmail} />;
  }

  return (
    <>
    {showWelcome && (
      <WelcomeAnimation
        agentName={title}
        onDone={() => setShowWelcome(false)}
      />
    )}
    <div className="app app-admin">
      {/* Nav rail — chat vs flows */}
      <div className="app-nav-rail">
        <button
          className={`nav-rail-btn${activeView === "chat" ? " active" : ""}`}
          onClick={() => { setActiveView("chat"); setMobileTab("chat"); }}
          title="Chat"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
          </svg>
        </button>
        <button
          className={`nav-rail-btn${activeView === "flows" ? " active" : ""}`}
          onClick={() => { setActiveView("flows"); setMobileTab("flows"); }}
          title="Flows"
        >
          ⚡
        </button>
      </div>

      {activeView === "flows" ? (
        <FlowsPage
          connections={{
            gmail: gmailConnected,
            calendar: calendarConnected,
            monday: mondayConnected,
            tasks: tasksConnected,
            whatsapp: whatsappConnected,
            googleMaps: googleMapsConnected,
            apollo: !!(userSettings as any).apolloApiKey,
          }}
          isAdmin={isAdmin}
        />
      ) : (
        <>
      <ChatHistorySidebar
        sessions={chatSessions}
        loading={historyLoading}
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
            <span className={`header-icon${isResponding ? " responding" : ""}`}>✦</span>
            <h1>{title}</h1>
            <span className="version-badge">v2</span>
          </div>
          <div className="header-actions">
            <span className="model-badge">{modelLabel}</span>
            <button
              className="header-icon-btn"
              onClick={handleLogout}
              title={`Signed in as ${userEmail ?? ""} — click to sign out`}
              style={{ fontSize: 11, width: "auto", padding: "0 8px", gap: 4, display: "flex", alignItems: "center" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
              </svg>
              {userEmail?.split("@")[0]}
            </button>
            {messages.length > 0 && (
              <button className="header-icon-btn" onClick={handleExport} title="Export chat (⌘K=new, ⌘/=focus)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                </svg>
              </button>
            )}
            <button
              className="header-icon-btn"
              onClick={() => setDarkMode((v) => !v)}
              title={darkMode ? "Light mode" : "Dark mode"}
            >
              {darkMode ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" strokeWidth="2" fill="none"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
                </svg>
              )}
            </button>
          </div>
        </header>

        <ChatWindow
          messages={messages}
          onPromptClick={(p) => handleSend(p)}
          onRetry={handleRetry}
          onEditRetry={handleEditRetry}
        />

        <InputBar
          ref={inputRef}
          onSend={handleSend}
          disabled={loading}
          placeholder={placeholder}
          attachment={pendingAttachment}
          onAttachmentChange={setPendingAttachment}
          skills={agentConfig?.skills ?? []}
          currentProvider={(userSettings.model ?? agentConfig?.model)?.provider ?? "gemini"}
          onNewChat={handleNewChat}
          prefillInput={prefillInput}
        />
      </div>

      <AgentSidebar
        isAdmin={isAdmin}
        userEmail={userEmail}
        agentConfig={agentConfig}
        connectionsLoading={connectionsLoading}
        onSave={(c) => setAgentConfig(c)}
        userSettings={userSettings}
        onUserSettingsChange={handleUserSettingsChange}
        gmailConnected={gmailConnected}
        calendarConnected={calendarConnected}
        mondayConnected={mondayConnected}
        onGmailDisconnect={() => disconnectService("gmail").then(() => setGmailConnected(false))}
        onCalendarDisconnect={() => disconnectService("calendar").then(() => setCalendarConnected(false))}
        onMondayDisconnect={() => disconnectService("monday").then(() => setMondayConnected(false))}
        tasksConnected={tasksConnected}
        onTasksDisconnect={() => disconnectService("tasks").then(() => setTasksConnected(false))}
        whatsappConnected={whatsappConnected}
        whatsappStatus={whatsappStatus}
        whatsappOwners={whatsappOwners}
        onWhatsappConnected={() => { setWhatsappConnected(true); setWhatsappStatus("connected"); }}
        onWhatsappDisconnect={() => disconnectWhatsApp().then(() => { setWhatsappConnected(false); setWhatsappStatus("disconnected"); })}
        className={mobileTab !== "settings" ? "mobile-hidden" : ""}
        onFeedback={handleFeedback}
        isResponding={isResponding}
      />

        </>
      )}

      <nav className="mobile-tab-bar">
        <button className={`mobile-tab-btn${mobileTab === "history" ? " active" : ""}`} onClick={() => { setMobileTab("history"); setActiveView("chat"); }}>History</button>
        <button className={`mobile-tab-btn${mobileTab === "chat" ? " active" : ""}`} onClick={() => { setMobileTab("chat"); setActiveView("chat"); }}>Chat</button>
        <button className={`mobile-tab-btn${mobileTab === "settings" ? " active" : ""}`} onClick={() => { setMobileTab("settings"); setActiveView("chat"); }}>Settings</button>
        <button className={`mobile-tab-btn${mobileTab === "flows" ? " active" : ""}`} onClick={() => { setMobileTab("flows"); setActiveView("flows"); }}>⚡ Flows</button>
      </nav>
    </div>
    </>
  );
}
