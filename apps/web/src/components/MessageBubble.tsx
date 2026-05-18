import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { DisplayMessage } from "../types";

interface Props {
  message: DisplayMessage;
  onFeedback?: (messageId: string, rating: 1 | -1) => void;
  onRetry?: () => void;
  onEditRetry?: () => void;
}

type ResponseType = "error" | "stuck" | "question" | "normal";

function detectResponseType(text: string): ResponseType {
  const lower = text.toLowerCase().trim();
  if (
    lower.startsWith("error:") ||
    lower.includes("i encountered an error") ||
    lower.includes("something went wrong") ||
    lower.includes("failed to connect") ||
    lower.includes("i'm unable to") ||
    lower.includes("i am unable to")
  ) return "error";
  if (
    lower.includes("tool call limit") ||
    lower.includes("[system note:") ||
    lower.includes("i was unable to complete") ||
    lower.includes("try a completely different approach")
  ) return "stuck";
  if (
    lower.includes("could you provide") ||
    lower.includes("could you clarify") ||
    lower.includes("can you tell me") ||
    lower.includes("what specific") ||
    lower.includes("more information") ||
    lower.includes("do you want me to") ||
    (lower.endsWith("?") && lower.length > 80)
  ) return "question";
  return "normal";
}

const TOOL_LABEL: Record<string, string> = {
  fetch_url: "Fetched URL",
  http_request: "HTTP Request",
  google_search: "Web Search",
  code_execution: "Ran Code",
  gmail_send: "Sent Email",
  calendar_list_events: "Listed Events",
  calendar_create_event: "Created Event",
  calendar_get_event: "Got Event",
  calendar_check_availability: "Checked Availability",
  slack_send_message: "Sent Slack Message",
  slack_list_channels: "Listed Channels",
  slack_lookup_user: "Looked Up User",
};

function toolLabel(name: string): string {
  if (TOOL_LABEL[name]) return TOOL_LABEL[name];
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return `MCP · ${parts[1]} · ${parts[2] ?? ""}`;
  }
  if (name.startsWith("custom__")) return `Custom · ${name.slice(8)}`;
  return name;
}

function MarkdownWithHighlighting({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        code({ node, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className ?? "");
          const inline = !match;
          if (inline) {
            return <code className={className} {...props}>{children}</code>;
          }
          return (
            <SyntaxHighlighter
              style={oneDark as any}
              language={match[1]}
              PreTag="div"
              customStyle={{ margin: "8px 0", borderRadius: "8px", fontSize: "13px" }}
            >
              {String(children).replace(/\n$/, "")}
            </SyntaxHighlighter>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export default function MessageBubble({ message, onFeedback, onRetry, onEditRetry }: Props) {
  const isUser = message.role === "user";
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [textCopied, setTextCopied] = useState(false);
  const responseType = !isUser && !message.pending && message.text ? detectResponseType(message.text) : "normal";

  const copyText = () => {
    navigator.clipboard.writeText(message.text).then(() => {
      setTextCopied(true);
      setTimeout(() => setTextCopied(false), 1500);
    });
  };

  const copyTool = (idx: number, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    });
  };

  return (
    <div className={`message ${isUser ? "user" : `assistant${responseType !== "normal" ? ` response-${responseType}` : ""}`}`}>
      <div className="bubble">
        {message.pending ? (
          <span className="typing-indicator">
            <span /><span /><span />
          </span>
        ) : (
          <>
            {message.attachment && (
              <div className="message-attachment">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
                </svg>
                {message.attachment.name}
              </div>
            )}

            {isUser ? (
              <p style={{ whiteSpace: "pre-wrap" }}>{message.text}</p>
            ) : (
              <MarkdownWithHighlighting content={message.text} />
            )}

            {!!message.toolUses?.length && (
              <div className="tool-uses">
                {message.toolUses.map((t, i) => (
                  <details key={i} className="tool-card tool-card-animated">
                    <summary>
                      <span className="tool-icon">⚡</span>
                      {toolLabel(t.name)}
                      {!t.output && <span className="tool-spinner" />}
                    </summary>
                    {t.input && (
                      <div className="tool-detail-wrap">
                        <pre className="tool-detail tool-input">{
                          (() => { try { return JSON.stringify(JSON.parse(t.input), null, 2); } catch { return t.input; } })()
                        }</pre>
                        <button className="tool-copy-btn" onClick={() => copyTool(i * 2, t.input!)}>
                          {copiedIdx === i * 2 ? "✓" : "Copy"}
                        </button>
                      </div>
                    )}
                    {t.output && (
                      <div className="tool-detail-wrap">
                        <pre className="tool-detail tool-output">
                          {t.output.length > 600 ? t.output.slice(0, 600) + "…" : t.output}
                        </pre>
                        <button className="tool-copy-btn" onClick={() => copyTool(i * 2 + 1, t.output!)}>
                          {copiedIdx === i * 2 + 1 ? "✓" : "Copy"}
                        </button>
                      </div>
                    )}
                  </details>
                ))}
              </div>
            )}

            {!isUser && !message.pending && message.text && (
              <div className="message-feedback">
                <button className="feedback-btn copy-btn" onClick={copyText} title="Copy response">
                  {textCopied ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                  )}
                </button>
                {onFeedback && (<>
                  <div className="feedback-divider" />
                  <button
                    className={`feedback-btn${message.feedback === 1 ? " active positive" : ""}`}
                    onClick={() => onFeedback(message.id, 1)}
                    title="Good response"
                  >👍</button>
                  <button
                    className={`feedback-btn${message.feedback === -1 ? " active negative" : ""}`}
                    onClick={() => onFeedback(message.id, -1)}
                    title="Bad response"
                  >👎</button>
                  <div className="feedback-divider" />
                </>)}
                {onRetry && (
                  <button className="feedback-btn retry-btn" onClick={onRetry} title="Retry this response">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M1 4v6h6M23 20v-6h-6"/>
                      <path d="M20.49 9A9 9 0 005.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 013.51 15"/>
                    </svg>
                    Retry
                  </button>
                )}
                {onEditRetry && (
                  <button className="feedback-btn retry-btn" onClick={onEditRetry} title="Edit and retry">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                    Edit
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
