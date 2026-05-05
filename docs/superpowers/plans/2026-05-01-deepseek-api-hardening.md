# DeepSeek API Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DeepSeek the first-class AI provider for GPT DJ and prevent silent fallback from hiding integration failures.

**Architecture:** Resolve AI provider in one place in `apps/server/src/config.ts`, pass the provider identity into `OpenAiDjAssistant`, expose provider/model/error through `/api/system/status`, and make chat responses say when they are local fallback. Tests lock the DeepSeek env mapping and the “OpenAI default model must not leak into DeepSeek” case.

**Tech Stack:** TypeScript, Fastify, React, OpenAI-compatible DeepSeek API, Vitest.

---

### Task 1: Provider Resolution

**Files:**
- Modify: `apps/server/src/config.ts`
- Test: `apps/server/test/config.test.ts`

- [x] **Step 1: Write failing tests**

Add tests that set `DEEPSEEK_API_KEY` and assert `config.aiProvider === "deepseek"`, `config.openAiBaseUrl === "https://api.deepseek.com"`, and `config.openAiModel === "deepseek-v4-flash"` even when `OPENAI_MODEL=gpt-4.1-mini` exists.

- [x] **Step 2: Implement provider resolution**

Add a single `resolveAiProvider()` function. Priority is `OPENAI_API_KEY` first, then `DEEPSEEK_API_KEY`, then local fallback.

- [x] **Step 3: Verify**

Run: `npm.cmd run typecheck`

Expected: TypeScript exits 0.

### Task 2: Runtime Diagnostics

**Files:**
- Modify: `apps/server/src/aiDjAssistant.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/orchestrator.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `apps/web/src/App.tsx`

- [x] **Step 1: Expose provider status**

Add `provider` to `AiDjAssistant.status()` and `aiDjProvider` to `SystemStatus`.

- [x] **Step 2: Avoid silent fallback**

When chat falls back because no key is configured or the provider call fails, include a short diagnostic notice in the assistant reply.

- [x] **Step 3: Verify**

Run: `npm.cmd run typecheck`

Expected: TypeScript exits 0.

### Task 3: Documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [x] **Step 1: Document DeepSeek env**

Add `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL=https://api.deepseek.com`, and `DEEPSEEK_MODEL=deepseek-v4-flash`.

- [x] **Step 2: Document diagnosis**

Explain `AI FALLBACK` vs “DeepSeek 调用失败” so the next failure points to config-read vs provider-call layers.
