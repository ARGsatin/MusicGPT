# MusicGPT

本地私有运行的 AI 音乐电台：连接网易云音乐，用你的收藏与播放行为生成个人电台，并让 AI DJ 陪你聊天、点歌和播报。

## 核心能力

- 网易云历史偏好建模（收藏 + 播放行为）
- 自动电台续播（10 首窗口规划）
- AI DJ 流式对话：文字边生成边显示，点歌结果、歌曲点评和普通闲聊均支持
- 邻家少女语音：聊天短句紧跟播放，定时 DJ 播报默认每 4 首触发一次
- PWA 播放器：播放控制、歌词窗口、聊天历史、偏好面板与推荐导入
- 本地持久化：SQLite 保存聊天、播放事件、口味画像和语音元数据

## 语音体验

- 默认音色：`zh-CN-XiaoxiaoNeural`
- 默认参数：语速 `+6%`、音调 `+2Hz`、音量 `+0%`
- 中文和英文都使用同一个小晓音色，避免中英混读时声线突然变化
- 自动朗读默认开启，可在页面中关闭；设备偏好保存在浏览器 `localStorage`
- 每条 AI 消息都可手动播放、暂停或重播；最近一次 DJ 播报也可重播
- 聊天语音优先于定时 DJ 播报，手动点击会立即切换到所选消息
- 朗读时音乐临时降到当前音量的 25%；原本静音时不会自行出声，结束或中断后恢复
- 浏览器阻止自动播放时保留文字回复并提示手动播放，不使用静音音频绕过限制

语音由现有 Edge TTS 管线生成，不需要额外的 Azure Speech 密钥。聊天文字会先返回，TTS 失败不会覆盖或撤销文字回复。MP3 默认缓存 30 天、最多保留 500 个文件；缓存键包含文本、音色、语速、音调和音量。

## 目录结构

```text
apps/
  server/   Fastify + SQLite + NCM + AI DJ + TTS
  web/      React + Vite PWA
packages/
  shared/   共享类型和 API 契约
```

## 快速开始

需要 Node.js 20 或更高版本。

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
- `TTS_VOICE`：可选，默认 `zh-CN-XiaoxiaoNeural`

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

- `POST /api/chat`（兼容的非流式聊天接口）
- `POST /api/chat/stream`（NDJSON：文本增量、短句语音与最终持久化结果）
- `POST /api/chat/:messageId/speech`（为已保存的 assistant 消息生成或复用语音）
- `GET /api/chat/history`
- `DELETE /api/chat/history`
- `GET /api/now`
- `POST /api/next`
- `POST /api/play-track`
- `GET /api/taste`
- `POST /api/feedback`
- `GET /api/system/status`
- `POST /api/import/ncm`
- `GET /api/environment`
- `POST /api/environment/location`
- `POST /api/recommendations/import`
- `GET /api/dj/settings`
- `POST /api/dj/settings`
- `GET /ws/stream`

## 开发校验

```bash
npm run test
npm run typecheck
npm run build
```

## 常见问题

### `Required port(s) already in use`

启动器需要前端 `5173`、后端 `8787` 和网易云 API `3001`。先确认占用端口的程序：

```powershell
netstat -ano | Select-String -Pattern ':5173\s|:8787\s|:3001\s'
```

确认 PID 是遗留的 MusicGPT/Node 进程后，可停止该进程再重新运行启动器：

```powershell
Stop-Process -Id <PID>
```

不要停止尚未确认用途的系统或其他应用进程。

## V1.5 预留

`weather / calendar / upnp` 已预留 provider 接口，默认关闭。
