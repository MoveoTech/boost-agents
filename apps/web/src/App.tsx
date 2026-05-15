import { useState, useCallback, useEffect } from "react";
import ChatWindow from "./components/ChatWindow";
import InputBar from "./components/InputBar";
import LoginPage from "./components/LoginPage";
import AgentSidebar from "./components/AgentSidebar";
import { sendMessage, getConfig, whoami, fetchGoogleToken, identityComplete } from "./api/client";
import type { DisplayMessage, HistoryItem, AgentConfig, UserSettings } from "./types";

function loadUserSettings(email: string): UserSettings {
  try { return JSON.parse(localStorage.getItem(`user_settings_${email}`) ?? "{}"); } catch { return {}; }
}
function saveUserSettings(email: string, s: UserSettings) {
  localStorage.setItem(`user_settings_${email}`, JSON.stringify(s));
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null); // null = checking cookie
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
  const [gmailUser, setGmailUser] = useState<string | null>(() => localStorage.getItem("gmail_user"));
  const [calendarUser, setCalendarUser] = useState<string | null>(() => localStorage.getItem("calendar_user"));
  const [gmailToken, setGmailToken] = useState<string | null>(() => localStorage.getItem("gmail_token"));
  const [calendarToken, setCalendarToken] = useState<string | null>(() => localStorage.getItem("calendar_token"));

  const autoFetchTokens = useCallback((email: string) => {
    fetchGoogleToken(email, "gmail").then((t) => {
      if (t) { localStorage.setItem("gmail_token", t); localStorage.setItem("gmail_user", email); setGmailToken(t); setGmailUser(email); }
    }).catch(() => {});
    fetchGoogleToken(email, "calendar").then((t) => {
      if (t) { localStorage.setItem("calendar_token", t); localStorage.setItem("calendar_user", email); setCalendarToken(t); setCalendarUser(email); }
    }).catch(() => {});
  }, []);

  // On mount: handle any OAuth callbacks then check session cookie
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // Google identity login callback
    const identityToken = params.get("identity_token");
    if (identityToken) {
      window.history.replaceState({}, "", window.location.pathname);
      identityComplete(identityToken)
        .then(() => checkSession())
        .catch(() => setAuthed(false));
      return;
    }

    // Google service (Gmail/Calendar) connect callback
    const googleEmail = params.get("google_email");
    const googleService = params.get("google_service");
    if (params.get("google_connected") === "true" && googleEmail && googleService) {
      window.history.replaceState({}, "", window.location.pathname);
      if (googleService === "gmail") {
        localStorage.setItem("gmail_user", googleEmail);
        setGmailUser(googleEmail);
        fetchGoogleToken(googleEmail, "gmail").then((t) => { if (t) { localStorage.setItem("gmail_token", t); setGmailToken(t); } });
      } else if (googleService === "calendar") {
        localStorage.setItem("calendar_user", googleEmail);
        setCalendarUser(googleEmail);
        fetchGoogleToken(googleEmail, "calendar").then((t) => { if (t) { localStorage.setItem("calendar_token", t); setCalendarToken(t); } });
      }
    }

    checkSession();
  }, []);

  const checkSession = useCallback(() => {
    whoami().then(({ isAdmin: a, email, authenticated }) => {
      setAuthed(authenticated);
      if (authenticated) {
        setIsAdmin(a);
        if (email) {
          setUserEmail(email);
          setUserSettings(loadUserSettings(email));
          if (!localStorage.getItem("gmail_user") && !localStorage.getItem("calendar_user")) {
            autoFetchTokens(email);
          }
        }
        getConfig().then(setAgentConfig).catch(() => {});
      }
    }).catch(() => setAuthed(false));
  }, [autoFetchTokens]);

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
      const systemPrompt = userSettings.systemPrompt ?? agentConfig?.systemPrompt;
      const result = await sendMessage(text, history, "tools", systemPrompt, gmailToken ?? undefined, calendarToken ?? undefined, model);
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

  if (authed === null) return null; // checking cookie — render nothing briefly
  if (!authed) return <LoginPage />;

  const title = agentConfig?.ui?.title ?? agentConfig?.name ?? "Boost Agent";
  const placeholder = agentConfig?.ui?.placeholder;
  const effectiveModel = userSettings.model ?? agentConfig?.model;
  const modelLabel = effectiveModel?.modelId
    ? (effectiveModel.modelId.replace("gemini-", "Gemini ").replace("claude-", "Claude ").replace("gpt-", "GPT-").replace("-20251001", ""))
    : "Gemini 2.5 Flash";

  return (
    <div className="app app-admin">
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
        onUserSettingsChange={(s) => { setUserSettings(s); if (userEmail) saveUserSettings(userEmail, s); }}
        gmailUser={gmailUser}
        calendarUser={calendarUser}
        gmailToken={gmailToken}
        calendarToken={calendarToken}
        onGmailDisconnect={() => { localStorage.removeItem("gmail_user"); localStorage.removeItem("gmail_token"); setGmailUser(null); setGmailToken(null); }}
        onCalendarDisconnect={() => { localStorage.removeItem("calendar_user"); localStorage.removeItem("calendar_token"); setCalendarUser(null); setCalendarToken(null); }}
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
