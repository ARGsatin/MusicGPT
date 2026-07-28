# MusicGPT V1

本地私有运行的 AI 音乐电台，核心能力：

- 网易云历史偏好建模（收藏 + 播放行为）
- 自动电台续播（10 首窗口规划）
- AI DJ 流式对话 + 小晓女声（文字边生成边显示；语音按短句紧跟播放；每 4 首一次轻播报）
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

Windows 用户可以直接双击仓库根目录的 `一键启动.cmd`。脚本会在首次启动时安装依赖，按顺序验证网易云 API、登录 Cookie、后端和前端；缺少 NCM 服务时会自动补拉，Cookie 明确失效时会自动打开二维码登录，页面就绪后再打开浏览器。

也可以按以下步骤手动启动：

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
- 网易云 API：`http://127.0.0.1:3001`

`npm run dev` 默认走完整的受监督启动链。只有在明确不需要网易云能力的前后端开发场景中，才使用 `npm run dev:app`。

## API 概览

- `POST /api/chat`
- `POST /api/chat/stream`（NDJSON：文本增量、短句语音与最终持久化结果）
- `POST /api/chat/:messageId/speech`
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
