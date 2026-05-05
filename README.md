# MusicGPT V1

本地私有运行的 AI 音乐电台，核心能力：

- 网易云历史偏好建模（收藏 + 播放行为）
- 自动电台续播（10 首窗口规划）
- AI DJ 轻播报（默认每 4 首一次）
- PWA 播放器 + 聊天控制 + 偏好面板

## 目录结构

```text
apps/
  server/   Fastify + SQLite + NCM + AI DJ + TTS
  web/      React + Vite PWA
packages/
  shared/   共享类型和 API 契约
```

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

至少需要填：

- `NCM_COOKIE`：你的网易云 Cookie（本地使用）
- `DEEPSEEK_API_KEY`：推荐，用于 GPT DJ 对话和意图理解；默认会使用 `https://api.deepseek.com` 和 `deepseek-v4-flash`
- `OPENAI_API_KEY`：可选，也可以使用 OpenAI 兼容配置；如果同时配置 `OPENAI_API_KEY` 和 `DEEPSEEK_API_KEY`，优先使用 `OPENAI_API_KEY`

如果前端状态条显示 `AI FALLBACK`，说明服务端没有读到 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`。如果聊天回复里出现 “DeepSeek 调用失败”，说明 key 已读到，但 DeepSeek 请求失败，需要检查 key、余额、网络或模型名。

3. 启动

```bash
npm run dev
```

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:8787`

## API 概览

- `POST /api/chat`
- `GET /api/now`
- `POST /api/next`
- `GET /api/taste`
- `POST /api/feedback`
- `GET /api/system/status`
- `POST /api/import/ncm`
- `GET /ws/stream`

## 测试

```bash
npm run test
```

## V1.5 预留

`weather / calendar / upnp` 已预留 provider 接口，默认关闭。
