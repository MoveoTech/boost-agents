import { useState, useRef, forwardRef, type KeyboardEvent } from "react";

interface Attachment {
  data: string;
  mimeType: string;
  name: string;
}

interface Props {
  onSend: (text: string, attachment?: Attachment) => void;
  disabled?: boolean;
  placeholder?: string;
  attachment?: Attachment | null;
  onAttachmentChange?: (a: Attachment | null) => void;
}

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

const InputBar = forwardRef<HTMLTextAreaElement, Props>(
  ({ onSend, disabled, placeholder, attachment, onAttachmentChange }, ref) => {
    const [value, setValue] = useState("");
    const [isListening, setIsListening] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const recognitionRef = useRef<any>(null);

    const submit = () => {
      const text = value.trim();
      if ((!text && !attachment) || disabled) return;
      onSend(text || "Attached file:", attachment ?? undefined);
      setValue("");
      if (ref && "current" in ref && ref.current) ref.current.style.height = "auto";
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    };

    const handleInput = () => {
      const el = ref && "current" in ref ? ref.current : null;
      if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
    };

    const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // result is data:mimeType;base64,xxxx — extract base64 part
        const base64 = result.split(",")[1] ?? result;
        onAttachmentChange?.({ data: base64, mimeType: file.type, name: file.name });
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    };

    const toggleVoice = () => {
      const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      if (!SR) { alert("Your browser doesn't support voice input."); return; }

      if (isListening) {
        recognitionRef.current?.stop();
        setIsListening(false);
        return;
      }

      const recognition = new SR();
      recognition.lang = "en-US";
      recognition.interimResults = false;
      recognition.onresult = (e: any) => {
        const transcript = e.results[0][0].transcript;
        setValue((v) => v + (v ? " " : "") + transcript);
      };
      recognition.onend = () => setIsListening(false);
      recognition.onerror = () => setIsListening(false);
      recognition.start();
      recognitionRef.current = recognition;
      setIsListening(true);
    };

    return (
      <div className="input-bar">
        {attachment && (
          <div className="attachment-preview">
            <span className="attachment-name">{attachment.name}</span>
            <button className="attachment-remove" onClick={() => onAttachmentChange?.(null)} aria-label="Remove attachment">✕</button>
          </div>
        )}
        <div className="input-bar-row">
          <button
            className="input-icon-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            title="Attach file or image"
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf,.txt,.md,.csv,.json"
            style={{ display: "none" }}
            onChange={handleFile}
          />

          <textarea
            ref={ref}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={placeholder ?? "Message the agent… (Enter to send, Shift+Enter for newline)"}
            disabled={disabled}
            rows={1}
          />

          <button
            className={`input-icon-btn${isListening ? " listening" : ""}`}
            onClick={toggleVoice}
            disabled={disabled}
            title={isListening ? "Stop listening" : "Voice input"}
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
              <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/>
            </svg>
          </button>

          <button
            className="send-btn"
            onClick={submit}
            disabled={(!value.trim() && !attachment) || disabled}
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
);

InputBar.displayName = "InputBar";
export default InputBar;
