import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import path from "path";
import { chat } from "./agent";
import type { Content } from "@google/generative-ai";

const app = express();

const COOKIE_SECRET = process.env.COOKIE_SECRET ?? "dev-secret";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
const API_KEY = process.env.API_KEY;
const COOKIE_NAME = "session";
const IS_PROD = process.env.NODE_ENV === "production";

app.use(cors());
app.use(express.json());
app.use(cookieParser(COOKIE_SECRET));

// Serve web app static files if present (production single-service setup)
const staticDir = path.join(__dirname, "public");
app.use(express.static(staticDir));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/login", (req, res) => {
  const { password } = req.body as { password?: string };

  if (!ACCESS_PASSWORD || password !== ACCESS_PASSWORD) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  const token = jwt.sign({ ok: true }, COOKIE_SECRET, { expiresIn: "7d" });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// Auth middleware — cookie (browser) or x-api-key header (programmatic)
app.use((req, res, next) => {
  if (!ACCESS_PASSWORD && !API_KEY) return next();

  if (API_KEY && req.headers["x-api-key"] === API_KEY) return next();

  try {
    jwt.verify(req.cookies[COOKIE_NAME], COOKIE_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body as {
    message: string;
    history: Content[];
  };

  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  try {
    const result = await chat(message.trim(), history);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Agent error",
      details: (err as Error).message,
    });
  }
});

// Fallback: serve the SPA for any non-API route
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

const PORT = process.env.PORT ?? 8080;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
