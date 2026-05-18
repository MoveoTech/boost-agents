const isProd = process.env.NODE_ENV === "production";

type Level = "info" | "warn" | "error" | "debug";

function log(level: Level, message: string, data?: Record<string, unknown>) {
  const entry = { severity: level.toUpperCase(), message, timestamp: new Date().toISOString(), ...data };
  if (isProd) {
    // Cloud Run / Cloud Logging picks up structured JSON from stdout
    console.log(JSON.stringify(entry));
  } else {
    const icon = { info: "ℹ", warn: "⚠", error: "✖", debug: "·" }[level];
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`${icon} [${entry.timestamp.slice(11, 19)}] ${message}`, data ?? "");
  }
}

export const logger = {
  info:  (msg: string, data?: Record<string, unknown>) => log("info",  msg, data),
  warn:  (msg: string, data?: Record<string, unknown>) => log("warn",  msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => { if (!isProd) log("debug", msg, data); },
};
