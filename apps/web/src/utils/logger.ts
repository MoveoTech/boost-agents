const BASE = import.meta.env.VITE_API_URL ?? "";

function sendToServer(level: string, message: string, data?: Record<string, unknown>) {
  try {
    navigator.sendBeacon(
      `${BASE}/api/log`,
      JSON.stringify({ level, message, source: "web", url: window.location.href, ...data }),
    );
  } catch {
    // sendBeacon not available — best effort only
  }
}

export const logger = {
  info: (msg: string, data?: Record<string, unknown>) => {
    console.info(`ℹ ${msg}`, data ?? "");
  },
  warn: (msg: string, data?: Record<string, unknown>) => {
    console.warn(`⚠ ${msg}`, data ?? "");
    sendToServer("warn", msg, data);
  },
  error: (msg: string, data?: Record<string, unknown>) => {
    console.error(`✖ ${msg}`, data ?? "");
    sendToServer("error", msg, data);
  },
};

export function installGlobalErrorHandlers() {
  window.onerror = (message, source, lineno, colno, error) => {
    sendToServer("error", String(message), {
      source: String(source ?? ""),
      lineno,
      colno,
      stack: error?.stack,
    });
  };

  window.onunhandledrejection = (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    sendToServer("error", `Unhandled promise rejection: ${message}`, {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };
}
