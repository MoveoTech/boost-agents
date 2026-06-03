# REPO_PLACEHOLDER — Setup Guide

## What was created
- **GitHub repo**: [github.com/MoveoTech/REPO_PLACEHOLDER](https://github.com/MoveoTech/REPO_PLACEHOLDER)
- **GCP project**: PROJECT_PLACEHOLDER
- **Cloud Run**: auto-deploys on every push to `main`

## Clone the repo
```
git clone https://github.com/MoveoTech/REPO_PLACEHOLDER.git
cd REPO_PLACEHOLDER
```

## Customize behavior (no code needed)
Edit `apps/server/src/config.ts` — change the system prompt, enable tools, set skills.
Push to `main` → auto-deploys your version.

## Secrets
[Manage in GitHub](https://github.com/MoveoTech/REPO_PLACEHOLDER/settings/secrets/actions)

| Secret | Purpose |
|--------|---------|
| `GEMINI_API_KEY` | Main AI model — required |
| `ADMIN_EMAILS` | Who sees the config sidebar |
| `ANTHROPIC_API_KEY` | Claude models — optional |
| `OPENAI_API_KEY` | GPT/o-series models — optional |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail & Calendar OAuth |
| `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` | Slack integration |

Org secrets (`OAUTH_SERVICE_URL`, `OAUTH_SERVICE_KEY`, `GH_PAT`) are inherited automatically — do not change them.

## Write custom server code
This repo builds from its own code. The full server is in `apps/server/src/`:
- `config.ts` — agent personality, tools, skills (start here)
- `agent.ts` — AI agent loop and tool definitions
- `index.ts` — HTTP routes and webhook handlers

Push to `main` → your code deploys.

## First-time setup checklist
- [ ] Deploy completes → open agent URL from [Actions summary](https://github.com/MoveoTech/REPO_PLACEHOLDER/actions)
- [ ] Sign in with an admin email
- [ ] Set system prompt + enable tools → **Publish**
- [ ] Gmail/Calendar users — add at [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent?project=boost-agents-496211) → Test users
- [ ] WhatsApp — Settings → Connect WhatsApp → scan QR
- [ ] Slack — see the [setup guide](https://github.com/MoveoTech/boost-agents/blob/main/docs/agent-setup.html)

## Useful links
- [GitHub Actions](https://github.com/MoveoTech/REPO_PLACEHOLDER/actions) — deploy logs
- [GCP Cloud Run](https://console.cloud.google.com/run?project=PROJECT_PLACEHOLDER) — service
- [GCP Secret Manager](https://console.cloud.google.com/security/secret-manager?project=PROJECT_PLACEHOLDER) — auto-generated secrets
- [Full setup guide](https://github.com/MoveoTech/boost-agents/blob/main/docs/agent-setup.html)
