import { useEffect, useRef } from "react";
import MessageBubble from "./MessageBubble";
import type { DisplayMessage } from "../types";

interface Props {
  messages: DisplayMessage[];
}

export default function ChatWindow({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <main className="chat-window">
      {messages.length === 0 && (
        <div className="empty-state">
          <p className="empty-title">How can I help?</p>
          <p className="empty-sub">I can search the web, run code, and fetch URLs.</p>
        </div>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </main>
  );
}
