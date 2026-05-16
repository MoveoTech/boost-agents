import { useState } from "react";
import type { ChatSession } from "../types";
import { deleteChat } from "../api/client";

interface Props {
  sessions: ChatSession[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function ChatHistorySidebar({ sessions, currentId, onSelect, onNew, onDelete, collapsed, onToggle, className }: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteChat(id);
    onDelete(id);
  };

  return (
    <div className={`chat-history-sidebar${collapsed ? " collapsed" : ""}${className ? ` ${className}` : ""}`}>
      <div className="chat-history-header">
        {!collapsed && (
          <button className="chat-history-new-btn" onClick={onNew}>
            + New chat
          </button>
        )}
        <button className="chat-history-toggle-btn" onClick={onToggle} title={collapsed ? "Show history" : "Hide history"}>
          {collapsed ? "›" : "‹"}
        </button>
      </div>

      {!collapsed && (
        <div className="chat-history-list">
          {sessions.length === 0 && (
            <p className="chat-history-empty">No past chats yet</p>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`chat-history-item${s.id === currentId ? " active" : ""}`}
              onClick={() => onSelect(s.id)}
              onMouseEnter={() => setHoverId(s.id)}
              onMouseLeave={() => setHoverId(null)}
            >
              <div className="chat-history-item-title">{s.title}</div>
              <div className="chat-history-item-meta">
                <span>{timeAgo(s.updatedAt)}</span>
                {hoverId === s.id && (
                  <button
                    className="chat-history-delete-btn"
                    onClick={(e) => handleDelete(e, s.id)}
                    title="Delete"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
