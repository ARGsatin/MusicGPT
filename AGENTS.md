# MusicGPT project instructions

## Purpose

MusicGPT is a local-first AI radio that combines NetEase Cloud Music playback, taste modeling, AI DJ chat, and browser-based realtime voice.

## Run and verify

- Use Node.js 20 or newer.
- Copy `.env.example` to `.env`; never commit real API keys or `NCM_COOKIE` values.
- `npm install` installs all workspaces.
- `npm run dev` starts the supervised NCM, server, and web stack on ports 3001, 8787, and 5173.
- Before handing off code, run `npm test`, `npm run typecheck`, and `npm run build`.

## Stack

- TypeScript npm workspaces
- Fastify + SQLite server
- React 19 + Vite PWA
- Vitest tests
- NeteaseCloudMusicApi and OpenAI-compatible AI providers

## Layout and conventions

- `apps/server`: API, orchestration, persistence, providers, and AI integrations.
- `apps/web`: player, chat, realtime voice, and PWA UI.
- `packages/shared`: cross-workspace types and API contracts; update consumers and tests together.
- `scripts`: supervised startup, readiness, NCM login, and repair helpers.
- Treat README as the user-facing setup/API authority; keep historical measurements in `docs/`.
- Inspect `git status` and all worktrees before editing; preserve unrelated or concurrent changes.
- `output/` and `.workbuddy/` are intentionally ignored local residue.

## Current state

- As of 2026-08-04, main uses `gpt-realtime-2.1` instead of the retired Edge TTS pipeline and includes DeepSeek V4 non-thinking compatibility plus JSON-response retry diagnostics.
- Local tests, typecheck, and production build pass. Realtime and DeepSeek remain pending live verification with real provider credentials before publishing.
