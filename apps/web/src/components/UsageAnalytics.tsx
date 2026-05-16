import { useEffect, useState } from "react";
import { getAnalytics } from "../api/client";
import type { AnalyticsData } from "../types";

interface Props {
  onClose: () => void;
}

export default function UsageAnalytics({ onClose }: Props) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getAnalytics().then(setData).catch(() => setError("Failed to load analytics"));
  }, []);

  const maxMessages = Math.max(...(data?.days.map((d) => d.messages) ?? [1]), 1);
  const maxTool = Math.max(...(data?.topTools.map((t) => t.count) ?? [1]), 1);
  const maxModel = Math.max(...(data?.models.map((m) => m.count) ?? [1]), 1);
  const satisfaction = data && (data.positiveFeedback + data.negativeFeedback) > 0
    ? Math.round((data.positiveFeedback / (data.positiveFeedback + data.negativeFeedback)) * 100)
    : null;

  return (
    <div className="analytics-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="analytics-modal">
        <div className="analytics-header">
          <span className="analytics-title">Usage Analytics</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="analytics-body">
          {error && <p style={{ color: "#dc2626", fontSize: 13 }}>{error}</p>}
          {!data && !error && <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading…</p>}
          {data && (
            <>
              <div className="analytics-kpis">
                <div className="analytics-kpi">
                  <div className="analytics-kpi-value">{data.totalMessages}</div>
                  <div className="analytics-kpi-label">Total Messages</div>
                </div>
                <div className="analytics-kpi">
                  <div className="analytics-kpi-value">
                    {data.days.length > 0
                      ? Math.round(data.days.reduce((s, d) => s + d.avgResponseMs, 0) / data.days.length / 100) / 10 + "s"
                      : "—"}
                  </div>
                  <div className="analytics-kpi-label">Avg Response</div>
                </div>
                <div className="analytics-kpi">
                  <div className="analytics-kpi-value">{satisfaction !== null ? `${satisfaction}%` : "—"}</div>
                  <div className="analytics-kpi-label">Satisfaction (👍)</div>
                </div>
              </div>

              {data.days.length > 0 && (
                <div>
                  <div className="analytics-section-title">Messages per Day</div>
                  <div className="analytics-day-chart">
                    {data.days.slice(-14).map((d) => (
                      <div key={d.date} className="analytics-day-bar-wrap" title={`${d.date}: ${d.messages} messages`}>
                        <div
                          className="analytics-day-bar"
                          style={{ height: `${Math.round((d.messages / maxMessages) * 72)}px` }}
                        />
                        <div className="analytics-day-label">{d.date.slice(5)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {data.topTools.length > 0 && (
                <div>
                  <div className="analytics-section-title">Top Tools</div>
                  {data.topTools.slice(0, 8).map((t) => (
                    <div key={t.name} className="analytics-bar-row">
                      <div className="analytics-bar-label" title={t.name}>{t.name}</div>
                      <div className="analytics-bar-track">
                        <div className="analytics-bar-fill" style={{ width: `${Math.round((t.count / maxTool) * 100)}%` }} />
                      </div>
                      <div className="analytics-bar-count">{t.count}</div>
                    </div>
                  ))}
                </div>
              )}

              {data.models.length > 0 && (
                <div>
                  <div className="analytics-section-title">Models Used</div>
                  {data.models.map((m) => (
                    <div key={m.name} className="analytics-bar-row">
                      <div className="analytics-bar-label" title={m.name}>{m.name}</div>
                      <div className="analytics-bar-track">
                        <div className="analytics-bar-fill" style={{ width: `${Math.round((m.count / maxModel) * 100)}%`, background: "var(--primary)" }} />
                      </div>
                      <div className="analytics-bar-count">{m.count}</div>
                    </div>
                  ))}
                </div>
              )}

              {data.totalMessages === 0 && (
                <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", padding: "20px 0" }}>
                  No data yet. Analytics reset on server restart.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
