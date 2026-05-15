import { useState, useCallback, useEffect } from "react";
import ChatWindow from "./components/ChatWindow";
import InputBar from "./components/InputBar";
import LoginPage from "./components/LoginPage";
import AgentSidebar from "./components/AgentSidebar";
import { sendMessage, getToken, getConfig, whoami, fetchGoogleToken, identityComplete } from "./api/client";
import type { DisplayMessage, HistoryItem, AgentConfig, UserSettings } from "./types";

function loadUserSettings(email: string): UserSettings {
  try { return JSON.parse(localStorage.getItem(`user_settings_${email}`) ?? "{}"); } catch { return {}; }
}
function saveUserSettings(email: string, s: UserSettings) {
  localStorage.setItem(`user_settings_${email}`, JSON.stringify(s));
}

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
  const [isAdmin, setIsAdmin] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings>({});
  const [mobileTab, setMobileTab] = useState<"chat" | "settings">("chat");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfig | null>(() => {
    const stored = localStorage.getItem("agent_config");
    try { return stored ? JSON.parse(stored) : null; } catch { return null; }
  });
  const [gmailUser, setGmailUser] = useState<string | null>(() => sessionStorage.getItem("gmail_user"));
  const [calendarUser, setCalendarUser] = useState<string | null>(() => sessionStorage.getItem("calendar_user"));
  const [gmailToken, setGmailToken] = useState<string | null>(() => sessionStorage.getItem("gmail_token"));
  const [calendarToken, setCalendarToken] = useState<string | null>(() => sessionStorage.getItem("calendar_token"));

  const autoFetchTokens = useCallback((email: string) => {
    fetchGoogleToken(email, "gmail").then((t) => {
      if (t) { sessionStorage.setItem("gmail_token", t); sessionStorage.setItem("gmail_user", email); setGmailToken(t); setGmailUser(email); }
    }).catch(() => {});
    fetchGoogleToken(email, "calendar").then((t) => {
      if (t) { sessionStorage.setItem("calendar_token", t); sessionStorage.setItem("calendar_user", email); setCalendarToken(t); setCalendarUser(email); }
    }).catch(() => {});
  }, []);

  // Handle Google identity callback (?identity_token=xxx)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const identityToken = params.get("identity_token");
    if (identityToken) {
      window.history.replaceState({}, "", window.location.pathname);
      identityComplete(identityToken).then(({ isAdmin: a, email }) => {
        setIsAdmin(a);
        setUserEmail(email);
        setUserSettings(loadUserSettings(email));
        setAuthed(true);
        autoFetchTokens(email);
      }).catch(() => {});
    }
  }, [autoFetchTokens]);

  // Handle Google service callback (?google_connected=true)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const email = params.get("google_email");
    const service = params.get("google_service");
    if (params.get("google_connected") === "true" && email && service) {
      if (service === "gmail") {
        sessionStorage.setItem("gmail_user", email);
        setGmailUser(email);
        fetchGoogleToken(email, "gmail").then((t) => { if (t) { sessionStorage.setItem("gmail_token", t); setGmailToken(t); } });
      } else if (service === "calendar") {
        sessionStorage.setItem("calendar_user", email);
        setCalendarUser(email);
        fetchGoogleToken(email, "calendar").then((t) => { if (t) { sessionStorage.setItem("calendar_token", t); setCalendarToken(t); } });
      }
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    getConfig().then((c) => setAgentConfig(c)).catch(() => {});
    whoami().then(({ isAdmin: a, email }) => {
      setIsAdmin(a);
      if (email) {
        setUserEmail(email);
        setUserSettings(loadUserSettings(email));
        if (!gmailUser && !calendarUser) autoFetchTokens(email);
      }
    }).catch(() => {});
  }, [authed]);

  const handleSend = useCallback(async (text: string) => {
    const userMsg: DisplayMessage = { id: crypto.randomUUID(), role: "user", text };
    const pendingMsg: DisplayMessage = { id: crypto.randomUUID(), role: "model", text: "", pending: true };
    setMessages((prev) => [...prev, userMsg, pendingMsg]);
    setLoading(true);

    const history: HistoryItem[] = messages
      .filter((m) => !m.pending)
      .map((m) => ({ role: m.role, parts: [{ text: m.text }] }));

    try {
      const model = userSettings.model ?? agentConfig?.model;
      const result = await sendMessage(text, history, "tools", agentConfig?.systemPrompt, gmailToken ?? undefined, calendarToken ?? undefined, model, userSettings.tools as Record<string, boolean> | undefined, userSettings.systemPromptAddition);
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
  }, [messages, agentConfig, gmailToken, calendarToken]);

  if (!authed) return <LoginPage onLogin={(adminFlag, email) => { setIsAdmin(adminFlag); if (email) setUserEmail(email); setAuthed(true); }} />;

  const title = agentConfig?.ui?.title ?? agentConfig?.name ?? "Boost Agent";
  const placeholder = agentConfig?.ui?.placeholder;

  return (
    <div className="app app-admin">
      <div className={`chat-area${mobileTab !== "chat" ? " mobile-hidden" : ""}`}>
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

      <AgentSidebar
        isAdmin={isAdmin}
        userEmail={userEmail}
        agentConfig={agentConfig}
        onSave={(c) => setAgentConfig(c)}
        userSettings={userSettings}
        onUserSettingsChange={(s) => { setUserSettings(s); if (userEmail) saveUserSettings(userEmail, s); }}
        gmailUser={gmailUser}
        calendarUser={calendarUser}
        gmailToken={gmailToken}
        calendarToken={calendarToken}
        onGmailDisconnect={() => { sessionStorage.removeItem("gmail_user"); sessionStorage.removeItem("gmail_token"); setGmailUser(null); setGmailToken(null); }}
        onCalendarDisconnect={() => { sessionStorage.removeItem("calendar_user"); sessionStorage.removeItem("calendar_token"); setCalendarUser(null); setCalendarToken(null); }}
        className={mobileTab !== "settings" ? "mobile-hidden" : ""}
      />

      <nav className="mobile-tab-bar">
        <button className={`mobile-tab-btn${mobileTab === "chat" ? " active" : ""}`} onClick={() => setMobileTab("chat")}>
          Chat
        </button>
        <button className={`mobile-tab-btn${mobileTab === "settings" ? " active" : ""}`} onClick={() => setMobileTab("settings")}>
          Settings
        </button>
      </nav>
    </div>
  );
}
