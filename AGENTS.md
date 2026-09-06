# MusicGPT project instructions

## Purpose

MusicGPT is a local-first AI radio that combines NetEase Cloud Music playback, taste modeling, AI DJ chat, and browser-based realtime voice.

## Run and verify

- Use Node.js 20 or newer.
- Copy `.env.example` to `.env`; never commit real API keys or `NCM_COOKIE` values.
- `npm install` installs all workspaces.
- `npm run dev` starts the supervised NCM, server, and web stack on ports 3001, 8787, and 5173.
- Before handing off code, run `npm test`, `npm run typecheck`, and `npm run build`.
- On Windows sandbox, `vite build` may abort while clearing `apps/web/dist` (safe-delete trash error). Fix: delete `apps/web/dist` first, then rebuild.

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

- As of 2026-08-25, `main` includes the Aurora UI, recommendation-quality repair, and MusicGPT v2 (multi-source catalog, QQ adapter/playback fallback, structured taste/routine projections, and the compact three-period daily plan).
- `main` is the integration and editing lane. The clean `aurora-ui` and `codex/musicgpt-v2` branches/worktrees are fully contained in `main`; treat them as cleanup candidates, not as sources of newer code.
- Main uses Alibaba Cloud `qwen3.5-omni-plus-realtime` WebRTC instead of the retired Edge TTS/OpenAI Realtime pipelines, with DeepSeek V4 non-thinking compatibility and JSON-response retry diagnostics.
- Local merge state does not prove deployment. Before claiming a feature is live, verify the running process root and the visible API/UI seam; no MusicGPT service was listening on ports 3001, 8787, or 5173 during the 2026-08-25 knowledge closeout.
