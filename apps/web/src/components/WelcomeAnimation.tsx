import { useEffect, useState } from "react";

interface Props {
  agentName: string;
  onDone: () => void;
}

export default function WelcomeAnimation({ agentName, onDone }: Props) {
  const [phase, setPhase] = useState<"enter" | "show" | "exit">("enter");

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("show"),   50);
    const t2 = setTimeout(() => setPhase("exit"),  2600);
    const t3 = setTimeout(() => onDone(),           3200);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [onDone]);

  return (
    <div className={`welcome-overlay welcome-${phase}`} onClick={() => { setPhase("exit"); setTimeout(onDone, 600); }}>
      <div className="welcome-bg" />

      {/* Floating particles */}
      {[...Array(12)].map((_, i) => (
        <div key={i} className="welcome-particle" style={{
          left: `${8 + i * 8}%`,
          animationDelay: `${i * 0.15}s`,
          animationDuration: `${2.5 + (i % 4) * 0.4}s`,
          width: `${4 + (i % 3) * 3}px`,
          height: `${4 + (i % 3) * 3}px`,
          opacity: 0.15 + (i % 5) * 0.07,
        }} />
      ))}

      <div className="welcome-content">
        {/* Logo mark */}
        <div className="welcome-logo">
          <div className="welcome-logo-ring welcome-logo-ring-1" />
          <div className="welcome-logo-ring welcome-logo-ring-2" />
          <div className="welcome-logo-ring welcome-logo-ring-3" />
          <div className="welcome-logo-core">✦</div>
        </div>

        {/* Brand */}
        <div className="welcome-brand">BOOST LABS</div>

        {/* Divider line */}
        <div className="welcome-divider" />

        {/* Agent intro */}
        <div className="welcome-agent-label">You are now connected to</div>
        <div className="welcome-agent-name">{agentName}</div>

        {/* Progress dots */}
        <div className="welcome-dots">
          <span /><span /><span />
        </div>
      </div>
    </div>
  );
}
