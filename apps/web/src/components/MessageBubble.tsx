import ReactMarkdown from "react-markdown";
import type { DisplayMessage } from "../types";

interface Props {
  message: DisplayMessage;
}

const TOOL_LABEL: Record<string, string> = {
  fetch_url: "Fetched URL",
  google_search: "Web Search",
  code_execution: "Ran Code",
};

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";

  return (
    <div className={`message ${isUser ? "user" : "assistant"}`}>
      <div className="bubble">
        {message.pending ? (
          <span className="typing-indicator">
            <span />
            <span />
            <span />
          </span>
        ) : (
          <>
            {isUser ? (
              <p>{message.text}</p>
            ) : (
              <ReactMarkdown>{message.text}</ReactMarkdown>
            )}

            {!!message.toolUses?.length && (
              <div className="tool-uses">
                {message.toolUses.map((t, i) => (
                  <details key={i} className="tool-card">
                    <summary>
                      <span className="tool-icon">⚡</span>
                      {TOOL_LABEL[t.name] ?? t.name}
                    </summary>
                    {t.input && (
                      <pre className="tool-detail tool-input">{t.input}</pre>
                    )}
                    {t.output && (
                      <pre className="tool-detail tool-output">
                        {t.output.length > 600
                          ? t.output.slice(0, 600) + "…"
                          : t.output}
                      </pre>
                    )}
                  </details>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
