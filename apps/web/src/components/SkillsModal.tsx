import { useState } from "react";
import type { Skill } from "../types";

interface Props {
  skills: Skill[];
  onSave: (skills: Skill[]) => void;
  onClose: () => void;
}

export default function SkillsModal({ skills, onSave, onClose }: Props) {
  const [list, setList] = useState<Skill[]>(skills);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", content: "" });

  const handleAdd = () => {
    if (!draft.name.trim() || !draft.content.trim()) return;
    setList((prev) => [...prev, { id: crypto.randomUUID(), ...draft, enabled: true }]);
    setDraft({ name: "", content: "" });
    setAdding(false);
  };

  const handleEditStart = (s: Skill) => {
    setEditingId(s.id);
    setDraft({ name: s.name, content: s.content });
    setAdding(false);
  };

  const handleEditSave = () => {
    if (!draft.name.trim() || !draft.content.trim()) return;
    setList((prev) => prev.map((s) => s.id === editingId ? { ...s, ...draft } : s));
    setEditingId(null);
    setDraft({ name: "", content: "" });
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setDraft({ name: "", content: "" });
  };

  const handleToggle = (id: string) =>
    setList((prev) => prev.map((s) => s.id === id ? { ...s, enabled: !s.enabled } : s));

  const handleDelete = (id: string) => {
    setList((prev) => prev.filter((s) => s.id !== id));
    if (editingId === id) handleEditCancel();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Skills</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <p className="modal-desc">
          Skills are blocks of knowledge or instructions included in the agent's context when enabled.
        </p>

        <div className="modal-list">
          {list.length === 0 && !adding && (
            <p className="sidebar-empty">No skills yet.</p>
          )}
          {list.map((s) => (
            <div key={s.id}>
              <div className={`modal-skill-row${s.enabled ? "" : " disabled"}`}>
                <div className="modal-skill-info">
                  <span className="modal-skill-name">{s.name}</span>
                  <span className="modal-skill-preview">{s.content.slice(0, 80)}{s.content.length > 80 ? "…" : ""}</span>
                </div>
                <div className="modal-skill-actions">
                  <label className="sidebar-toggle">
                    <input type="checkbox" checked={s.enabled} onChange={() => handleToggle(s.id)} />
                    <span className="sidebar-toggle-track" />
                  </label>
                  <button
                    className="api-copy-btn"
                    style={{ fontSize: 11 }}
                    onClick={() => editingId === s.id ? handleEditCancel() : handleEditStart(s)}
                  >
                    {editingId === s.id ? "Cancel" : "Edit"}
                  </button>
                  <button className="automation-delete-btn" onClick={() => handleDelete(s.id)}>✕</button>
                </div>
              </div>

              {editingId === s.id && (
                <div className="modal-add-form" style={{ marginTop: 6 }}>
                  <input
                    className="configure-input"
                    placeholder="Skill name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    autoFocus
                  />
                  <textarea
                    className="configure-textarea"
                    rows={6}
                    placeholder="Skill content…"
                    value={draft.content}
                    onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  />
                  <div className="modal-add-form-actions">
                    <button className="automation-cancel-btn" onClick={handleEditCancel}>Cancel</button>
                    <button className="sidebar-save-btn" onClick={handleEditSave}>Save Changes</button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {adding && (
            <div className="modal-add-form">
              <input className="configure-input" placeholder="Skill name (e.g. Company Context)"
                value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
              <textarea className="configure-textarea" rows={5}
                placeholder="Paste the skill content — facts, instructions, or knowledge the agent should know…"
                value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
              <div className="modal-add-form-actions">
                <button className="automation-cancel-btn" onClick={() => { setAdding(false); setDraft({ name: "", content: "" }); }}>Cancel</button>
                <button className="sidebar-save-btn" onClick={handleAdd}>Add Skill</button>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {!adding && !editingId && (
            <button className="sidebar-add-btn" style={{ fontSize: 13, padding: "6px 12px" }} onClick={() => setAdding(true)}>
              + Add Skill
            </button>
          )}
          <button className="sidebar-publish-btn" style={{ marginLeft: "auto" }} onClick={() => onSave(list)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
