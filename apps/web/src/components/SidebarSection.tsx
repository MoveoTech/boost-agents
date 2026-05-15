import { useState } from "react";

interface Props {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  action?: React.ReactNode;
}

export default function SidebarSection({ title, children, defaultOpen = true, action }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-header" onClick={() => setOpen((v) => !v)}>
        <span className={`sidebar-chevron ${open ? "open" : ""}`}>›</span>
        <span className="sidebar-section-title">{title}</span>
        {action && <span className="sidebar-section-action" onClick={(e) => e.stopPropagation()}>{action}</span>}
      </div>
      {open && <div className="sidebar-section-body">{children}</div>}
    </div>
  );
}
