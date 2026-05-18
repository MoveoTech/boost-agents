import { useState, useRef, forwardRef, useEffect, type KeyboardEvent } from "react";
import type { Skill } from "../types";

interface Attachment {
  data: string;
  mimeType: string;
  name: string;
}

interface SlashCommand {
  name: string;
  icon: string;
  desc: string;
  category: string;
  prefix?: string;          // text inserted into textarea on select
  action?: "new";           // client-side action
  providers?: Array<"gemini" | "claude" | "openai">;  // if set, only shown for these models
  skillContent?: string;    // for skill commands — injected into message
}

const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "image",     icon: "🖼️",  desc: "Find an image of...",           category: "Tools",   prefix: "Find an image of: " },
  { name: "search",    icon: "🔍",  desc: "Search the web for...",          category: "Tools",   prefix: "Search the web for: " },
  { name: "think",     icon: "🧠",  desc: "Reason step by step",            category: "Tools",   prefix: "Think through this step by step:\n\n", providers: ["gemini", "claude"] },
  { name: "summarize", icon: "📝",  desc: "Summarize content or this chat", category: "Writing", prefix: "Summarize the following:\n\n" },
  { name: "improve",   icon: "✨",  desc: "Improve writing quality",         category: "Writing", prefix: "Improve the following text:\n\n" },
  { name: "translate", icon: "🌍",  desc: "Translate to another language",  category: "Writing", prefix: "Translate to [language]: " },
  { name: "explain",   icon: "💡",  desc: "Explain in simple terms",        category: "Writing", prefix: "Explain this in simple terms:\n\n" },
  { name: "bullets",   icon: "📋",  desc: "Format as bullet points",        category: "Writing", prefix: "Convert to concise bullet points:\n\n" },
  { name: "code",      icon: "💻",  desc: "Write or review code",           category: "Dev",     prefix: "Write code for: " },
  { name: "debug",     icon: "🐛",  desc: "Debug this code",                category: "Dev",     prefix: "Debug the following code and explain the issue:\n\n" },
  { name: "new",       icon: "➕",  desc: "Start a new chat",               category: "Chat",    action: "new" },
];

interface Props {
  onSend: (text: string, attachment?: Attachment) => void;
  disabled?: boolean;
  placeholder?: string;
  attachment?: Attachment | null;
  onAttachmentChange?: (a: Attachment | null) => void;
  skills?: Skill[];
  currentProvider?: "gemini" | "claude" | "openai";
  onNewChat?: () => void;
  prefillInput?: { text: string; ts: number } | null;
}

declare global {
  interface Window { SpeechRecognition: any; webkitSpeechRecognition: any; }
}

const InputBar = forwardRef<HTMLTextAreaElement, Props>(
  ({ onSend, disabled, placeholder, attachment, onAttachmentChange, skills = [], currentProvider = "gemini", onNewChat, prefillInput }, ref) => {
    const [value, setValue] = useState("");
    const [isListening, setIsListening] = useState(false);
    const [paletteIdx, setPaletteIdx] = useState(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const recognitionRef = useRef<any>(null);
    const paletteRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (!prefillInput?.text) return;
      setValue(prefillInput.text);
      setTimeout(() => {
        const el = ref && "current" in ref ? ref.current : null;
        if (el) { el.focus(); el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
      }, 10);
    }, [prefillInput?.ts]); // eslint-disable-line react-hooks/exhaustive-deps

    // Build full command list = builtins (filtered by provider) + skill commands
    const skillCommands: SlashCommand[] = skills.map((s) => ({
      name: s.name.toLowerCase().replace(/\s+/g, "-"),
      icon: "📚",
      desc: s.enabled ? `Skill: ${s.name}` : `Skill: ${s.name} (disabled)`,
      category: "Skills",
      prefix: "",
      skillContent: s.content,
    }));

    const allCommands: SlashCommand[] = [
      ...BUILTIN_COMMANDS.filter((c) => !c.providers || c.providers.includes(currentProvider)),
      ...skillCommands,
    ];

    // Detect /command pattern at start of input
    const slashMatch = value.match(/^\/(\S*)/);
    const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
    const showPalette = slashQuery !== null && !disabled;
    const filtered = showPalette
      ? allCommands.filter((c) => c.name.startsWith(slashQuery))
      : [];

    // Reset palette selection when filter changes
    useEffect(() => { setPaletteIdx(0); }, [slashQuery]);

    const applyCommand = (cmd: SlashCommand) => {
      if (cmd.action === "new") {
        setValue("");
        onNewChat?.();
        return;
      }
      // Extract any text the user typed after the command name (e.g. "/image cats" → "cats")
      const afterCommand = value.replace(/^\/\S*\s*/, "");

      if (cmd.skillContent !== undefined) {
        // Skill command: prepend skill content as context, disabled skills injected inline
        const skill = skills.find((s) => s.name.toLowerCase().replace(/\s+/g, "-") === cmd.name);
        if (skill && !skill.enabled) {
          setValue(`[Context: ${skill.name}]\n${skill.content}\n\n---\n\n${afterCommand}`);
        } else {
          setValue(`[Using skill: ${skill?.name ?? cmd.name}]\n\n${afterCommand}`);
        }
      } else if (cmd.prefix) {
        setValue(cmd.prefix + afterCommand);
      }

      // Focus textarea
      if (ref && "current" in ref && ref.current) {
        ref.current.focus();
        setTimeout(() => {
          const el = ref.current;
          if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
        }, 0);
      }
    };

    const submit = () => {
      const text = value.trim();
      if ((!text && !attachment) || disabled) return;
      onSend(text || "Attached file:", attachment ?? undefined);
      setValue("");
      if (ref && "current" in ref && ref.current) ref.current.style.height = "auto";
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showPalette && filtered.length > 0) {
        if (e.key === "ArrowDown") { e.preventDefault(); setPaletteIdx((i) => (i + 1) % filtered.length); return; }
        if (e.key === "ArrowUp")   { e.preventDefault(); setPaletteIdx((i) => (i - 1 + filtered.length) % filtered.length); return; }
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); applyCommand(filtered[paletteIdx]); return; }
        if (e.key === "Escape") { setValue(""); return; }
        if (e.key === "Tab") { e.preventDefault(); applyCommand(filtered[paletteIdx]); return; }
      }
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
        const base64 = result.split(",")[1] ?? result;
        onAttachmentChange?.({ data: base64, mimeType: file.type, name: file.name });
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    };

    const toggleVoice = () => {
      const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      if (!SR) { alert("Your browser doesn't support voice input."); return; }
      if (isListening) { recognitionRef.current?.stop(); setIsListening(false); return; }
      const recognition = new SR();
      recognition.lang = "en-US";
      recognition.interimResults = false;
      recognition.onresult = (e: any) => { const t = e.results[0][0].transcript; setValue((v) => v + (v ? " " : "") + t); };
      recognition.onend = () => setIsListening(false);
      recognition.onerror = () => setIsListening(false);
      recognition.start();
      recognitionRef.current = recognition;
      setIsListening(true);
    };

    // Group filtered commands by category
    const grouped: Record<string, SlashCommand[]> = {};
    for (const cmd of filtered) {
      (grouped[cmd.category] ??= []).push(cmd);
    }
    let flatIdx = 0;

    return (
      <div className="input-bar" style={{ position: "relative" }}>
        {/* Slash command palette */}
        {showPalette && filtered.length > 0 && (
          <div className="slash-palette" ref={paletteRef}>
            {Object.entries(grouped).map(([category, cmds]) => (
              <div key={category}>
                <div className="slash-category">{category}</div>
                {cmds.map((cmd) => {
                  const idx = flatIdx++;
                  const active = idx === paletteIdx;
                  return (
                    <button
                      key={cmd.name}
                      className={`slash-item${active ? " active" : ""}`}
                      onMouseDown={(e) => { e.preventDefault(); applyCommand(cmd); }}
                      onMouseEnter={() => setPaletteIdx(idx)}
                    >
                      <span className="slash-icon">{cmd.icon}</span>
                      <span className="slash-name">/{cmd.name}</span>
                      <span className="slash-desc">{cmd.desc}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {attachment && (
          <div className="attachment-preview">
            <span className="attachment-name">{attachment.name}</span>
            <button className="attachment-remove" onClick={() => onAttachmentChange?.(null)} aria-label="Remove attachment">✕</button>
          </div>
        )}

        <div className="input-bar-row">
          <button className="input-icon-btn" onClick={() => fileInputRef.current?.click()} disabled={disabled} title="Attach file or image" type="button">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>
          <input ref={fileInputRef} type="file" accept="image/*,.pdf,.txt,.md,.csv,.json" style={{ display: "none" }} onChange={handleFile} />

          <textarea
            ref={ref}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={placeholder ?? "Message… (/ for commands, Enter to send)"}
            disabled={disabled}
            rows={1}
          />

          <button className={`input-icon-btn${isListening ? " listening" : ""}`} onClick={toggleVoice} disabled={disabled} title={isListening ? "Stop listening" : "Voice input"} type="button">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
              <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/>
            </svg>
          </button>

          <button className="send-btn" onClick={submit} disabled={(!value.trim() && !attachment) || disabled} aria-label="Send">
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
