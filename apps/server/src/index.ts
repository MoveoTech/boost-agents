import express from "express";
import cors from "cors";
import { chat } from "./agent";
import type { Content } from "@google/generative-ai";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
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

const PORT = process.env.PORT ?? 8080;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
