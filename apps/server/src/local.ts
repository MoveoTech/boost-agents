// ── Local development mode ────────────────────────────────────────────────────
// Central switch for running the agent locally (off-GCP). Everything here is a no-op
// in production: IS_LOCAL is false whenever NODE_ENV === "production", which the deploy
// workflows always set. So prod behaves exactly as before.
//
// What local mode enables (all gated on IS_LOCAL):
//  - a dev identity (no OAuth login flow is possible locally) → unlocks session-gated
//    features: Gmail/Calendar/Tasks/memory/Apollo/custom tools/chat history.
//  - flow definitions stored in a local JSON file instead of Cloud Scheduler.
//  - Monday via the MONDAY_TOKEN env override (see google-auth.ts).
//
// Configure the dev identity with DEV_USER_EMAIL (falls back to the first ADMIN_EMAILS entry).

export const IS_LOCAL = process.env.NODE_ENV !== "production";

export function localDevEmail(): string | undefined {
  if (!IS_LOCAL) return undefined;
  const admins = (process.env.ADMIN_EMAILS ?? "").split(/[,;|\s]+/).map((e) => e.trim()).filter(Boolean);
  return process.env.DEV_USER_EMAIL ?? admins[0];
}
