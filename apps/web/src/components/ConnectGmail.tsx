const BASE = import.meta.env.VITE_API_URL ?? "";

interface Props {
  onConnected: (email: string) => void;
}

export default function ConnectGmail({ onConnected }: Props) {
  // Check if we just returned from OAuth
  const params = new URLSearchParams(window.location.search);
  const connectedEmail = params.get("gmail_email");
  const justConnected = params.get("gmail_connected") === "true";

  if (justConnected && connectedEmail) {
    sessionStorage.setItem("gmail_user", connectedEmail);
    window.history.replaceState({}, "", window.location.pathname);
    onConnected(connectedEmail);
    return null;
  }

  return (
    <div className="connect-gmail-banner">
      <span className="connect-gmail-text">
        Connect your Gmail to enable email tools
      </span>
      <a className="connect-gmail-btn" href={`${BASE}/api/auth/google/start`}>
        Connect Gmail
      </a>
    </div>
  );
}
