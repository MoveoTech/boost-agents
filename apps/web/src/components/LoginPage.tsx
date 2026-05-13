import { useState, type FormEvent } from "react";

interface Props {
  onLogin: () => void;
}

export default function LoginPage({ onLogin }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    setLoading(false);

    if (res.ok) {
      onLogin();
    } else {
      setError("Incorrect password");
      setPassword("");
    }
  };

  return (
    <div className="login-page">
      <form className="login-box" onSubmit={handleSubmit}>
        <span className="login-icon">✦</span>
        <h1>Boost Agent</h1>
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          autoFocus
        />
        {error && <p className="login-error">{error}</p>}
        <button type="submit" disabled={!password || loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
