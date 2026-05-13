import { useState, useCallback } from "react";
import ChatWindow from "./components/ChatWindow";
import InputBar from "./components/InputBar";
import { sendMessage } from "./api/client";
import type { DisplayMessage, HistoryItem } from "./types";

export default function App() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <span className="header-icon">✦</span>
          <h1>Boost Agent</h1>
        </div>
        <span className="model-badge">Gemini 2.0 Flash</span>
      </header>
      <ChatWindow messages={messages} />
      <InputBar onSend={handleSend} disabled={loading} />
    </div>
  );
}
