import { useEffect, useRef, useMemo } from "react";
import MessageBubble from "./MessageBubble";
import type { DisplayMessage } from "../types";

const PROMPT_POOL = [
  "What can you help me with?",
  "Search the web for the latest AI news",
  "What's on my calendar today?",
  "Draft a short professional email",
  "Summarize a topic for me",
  "Help me brainstorm ideas",
  "Create a to-do list for my project",
  "Send a message to my team on Slack",
  "What are the key action items on my Monday board?",
  "Help me plan my week",
  "Write a quick update post",
  "Explain something in simple terms",
  "Find information about a topic",
  "Help me organize my thoughts",
  "What meetings do I have this week?",
  "Draft a reply to an email",
];

function pickRandom<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n);
}

interface Props {
  messages: DisplayMessage[];
  onPromptClick?: (prompt: string) => void;
  onFeedback?: (messageId: string, rating: 1 | -1) => void;
}

function AIOrb() {
  return (
    <div className="ai-orb" aria-hidden="true">
      <div className="ai-orb-ring ai-orb-ring-1" />
      <div className="ai-orb-ring ai-orb-ring-2" />
      <div className="ai-orb-ring ai-orb-ring-3" />
      <div className="ai-orb-core">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2a1 1 0 011 1v1.07A7.001 7.001 0 0118.93 10H20a1 1 0 010 2h-1.07A7.001 7.001 0 0113 17.93V19a1 1 0 01-2 0v-1.07A7.001 7.001 0 015.07 12H4a1 1 0 010-2h1.07A7.001 7.001 0 0111 4.07V3a1 1 0 011-1zm0 4a5 5 0 100 10A5 5 0 0012 6zm0 2a3 3 0 110 6 3 3 0 010-6z"/>
        </svg>
      </div>
    </div>
  );
}

export default function ChatWindow({ messages, onPromptClick, onFeedback }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const starterPrompts = useMemo(() => pickRandom(PROMPT_POOL, 4), []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <main className="chat-window">
      {messages.length === 0 && (
        <div className="empty-state">
          <AIOrb />
          <p className="empty-title">How can I help?</p>
          <p className="empty-sub">Ask me anything — I can search the web, run code, send emails, and more.</p>
          {starterPrompts.length > 0 && (
            <div className="starter-prompts">
              {starterPrompts.map((p, i) => (
                <button key={i} className="starter-chip" onClick={() => onPromptClick?.(p)}>
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} onFeedback={onFeedback} />
      ))}
      <div ref={bottomRef} />
    </main>
  );
}
