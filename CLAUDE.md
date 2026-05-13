# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Turborepo monorepo template for deploying Gemini-powered AI agents to Google Cloud Run. Includes a ready-to-use Express server with tool use and a React chat UI. Push to `main` to auto-provision a GCP project and deploy both services.

## Structure

```
apps/
  server/          Express API + Gemini agent (port 8080)
    src/
      index.ts     HTTP server, /health + POST /api/chat
      agent.ts     Gemini chat loop with tool calling
      tools.ts     fetchUrl() implementation
  web/             React + Vite chat UI (nginx, port 8080)
    src/
      App.tsx      State management, sends messages to server
      api/         fetch wrapper (VITE_API_URL or Vite proxy)
      components/  ChatWindow, MessageBubble, InputBar
packages/
  shared-types/    Empty placeholder for cross-app types
```

## Dev Commands

**Server** (`apps/server/`):
```bash
npm run dev     # ts-node-dev with hot reload
npm run build   # tsc → dist/
npm run lint    # type-check only
```

**Web** (`apps/web/`):
```bash
npm run dev     # Vite dev server (proxies /api → localhost:8080)
npm run build   # tsc + vite build → dist/
```

**Root** (runs across all workspaces via Turbo):
```bash
npm run dev     # start both server and web simultaneously
npm run build
npm run lint
```

**Local setup**: set `GEMINI_API_KEY` in `apps/server/.env` (or export it). Node 20 supports `--env-file .env` if you add it to the dev script.

## Agent Architecture

`POST /api/chat` accepts `{ message, history }` where `history` is an array of `{ role, parts }` objects (Gemini's native `Content[]` format). The client is stateless — it passes the full conversation history on every call.

`agent.ts` runs a function-calling loop:
1. Send message to `gemini-2.0-flash` with three tools enabled
2. If the model calls `fetch_url`, execute it and send the result back
3. Repeat until the model produces a final text response
4. Extract code execution and Google Search metadata from the response

The three tools:
- **`fetch_url`** — custom function tool; server executes HTTP GET and returns text (truncated to 10 KB)
- **`code_execution`** — built-in; Gemini runs Python internally
- **`googleSearch`** — built-in; Gemini searches the web internally (`@ts-ignore` needed as it's not yet in SDK types)

## Deployment Architecture

Push to `main` triggers the pipeline. Two Cloud Run services are deployed per repo:
- `{repo-name}` — the server (receives `GEMINI_API_KEY` env var)
- `{repo-name}-web` — the web UI (built with `VITE_API_URL` pointing to the server's Cloud Run URL)

The server URL is captured from `deploy-cloudrun`'s `outputs.url` and passed as a Docker build arg to the web image, so the frontend is baked with the correct API endpoint at build time.

GCP project `boost-{repo-name}` is provisioned automatically on first deploy (billing linked to MoveoTech, hosted in the `Boost-Agents` folder).

**Required GitHub secret:** `GEMINI_API_KEY`
