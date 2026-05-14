import { useState, useRef, type KeyboardEvent } from "react";
import type { Mode } from "../types";

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
}

export default function InputBar({ onSend, disabled, placeholder, mode, onModeChange }: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  };

  return (
    <div className="input-bar">
      <div className="input-bar-inner">
        <div className="mode-toggle">
          <button
            className={`mode-btn ${mode === "tools" ? "active" : ""}`}
            onClick={() => onModeChange("tools")}
            type="button"
            title="Use custom HTTP tools"
          >
            Tools
          </button>
          <button
            className={`mode-btn ${mode === "search" ? "active" : ""}`}
            onClick={() => onModeChange("search")}
            type="button"
            title="Use Google Search"
          >
            Search
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={placeholder ?? "Message the agent… (Enter to send, Shift+Enter for newline)"}
          disabled={disabled}
          rows={1}
        />
        <button
          className="send-btn"
          onClick={submit}
          disabled={!value.trim() || disabled}
          aria-label="Send"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
