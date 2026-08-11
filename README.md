# MusicGPT

本地私有运行的 AI 音乐电台：连接网易云音乐，用你的收藏与播放行为生成个人电台，并让 AI DJ 陪你聊天、点歌和播报。

## 核心能力

- 网易云历史偏好 + 本地收藏标签建模（艺人、氛围、风格、场景、时段、天气）
- 自动电台续播（10 首窗口按 5 首熟悉口味 + 5 首新风格交错规划）
- 网易云每日推荐、环境搜索与轮换风格组成的探索候选池
- 自由聊天：可以聊任何日常话题，开放式回复通过套话与近期重复检查后再显示
- 原生实时语音：`qwen3.5-omni-plus-realtime` 直接理解和生成音频，支持自然轮次、随时打断与语音点歌
- 长期人物记忆：自动提炼稳定偏好、习惯与背景，可在“她记得的我”中逐条或全部忘记
- PWA 播放器：播放控制、歌词窗口、聊天历史、人物记忆、偏好面板与推荐导入
- 本地持久化：SQLite 保存文字与有效语音转写、人物记忆、播放事件和口味画像；不保存原始音频

## 自由聊天与长期记忆

- 文字和有效语音共用同一份 `user` / `assistant` 历史与长期记忆；文字模型默认携带最近 20 轮对话，页面展示最近 100 条消息
- 简单闲聊保持轻盈，复杂问题可以自然展开；默认聊天输出上限由 `AI_DJ_CHAT_MAX_TOKENS=800` 控制
- 机器人可以主动追问、开玩笑或温和表达不同意见，遇到严肃话题会认真回应
- 只有明确提出点歌、切歌、暂停等操作时才进入音乐控制；单纯谈到“播放”“推荐”“歌”仍会继续聊天
- 回复完成后会异步提炼长期有用的信息，不阻塞文字和语音；最多保存 100 条，每轮最多选取 20 条相关记忆进入上下文
- 密码、API Key、支付信息和身份凭证永不进入长期记忆；聊天记录与长期记忆可分别清除

## 语音体验

- 模型固定为 `qwen3.5-omni-plus-realtime`，默认使用官方默认的 `Tina` 音色
- 浏览器通过 WebRTC 直接传输麦克风和模型音频，不经过“转文字 → Edge TTS → MP3”链路
- `server_vad` 使用 800ms 静音窗口判断说话轮次，并开启 Qwen 实时输入转写；用户开口时可打断 DJ，已收到的互动回复片段会标为“已打断”
- 点击“开启实时语音”后才申请麦克风权限；关闭页面或结束语音会立即停止麦克风轨道
- 语音中的点歌、切歌、队列、当前曲目和偏好问题统一调用 Music Command；`call_id` 幂等保证重试不会重复切歌或收藏
- 普通语音答案直接使用 Qwen 的输出转写显示并持久化，不再生成一份 DeepSeek 助手副本
- 实时会话已连接时，可选择“朗读文字回复”，也可手动朗读某条消息或最近 DJ 播报；这些 narration 不写入聊天历史
- 背景声和 `wait_for_user` 不进入历史；输入转写失败的轮次也不会落库
- DJ 说话或聆听用户时，音乐临时降到当前音量的 25%，结束后恢复

百炼 `DASHSCOPE_API_KEY` 只保存在服务端。浏览器把 SDP offer 发给 `/api/realtime/session`，服务端向百炼 WebRTC 接口完成握手并只返回 SDP answer，不会把 Key 交给前端。语音用量由阿里云百炼账户按量计费。

## 目录结构

```text
apps/
  server/   Fastify + SQLite + NCM + AI DJ + Realtime WebRTC 会话代理
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
- `DEEPSEEK_API_KEY`：推荐，用于 AI DJ 文字对话和意图理解；默认会使用 `https://api.deepseek.com` 和 `deepseek-v4-flash`
- `OPENAI_API_KEY`：可选，只用于 OpenAI 兼容的文字模型；如果同时配置 `OPENAI_API_KEY` 和 `DEEPSEEK_API_KEY`，文字 AI 优先使用 OpenAI
- `OPENAI_BASE_URL`：可选，只用于 OpenAI 兼容的文字模型请求
- `DASHSCOPE_API_KEY`：启用 `qwen3.5-omni-plus-realtime` 原生语音所必需，在阿里云百炼控制台创建
- `DASHSCOPE_WORKSPACE_ID`：可选但推荐，填写百炼业务空间 ID 后使用华北 2（北京）的工作空间专属域名；不填时使用 `dashscope.aliyuncs.com` 公共域名
- `DASHSCOPE_REALTIME_BASE_URL`：可选，用于覆盖完整的 WebRTC SDP 交换地址；通常保持为空
- `REALTIME_CONVERSATION_MODE`：默认 `unified`，启用统一文字/语音账本；现场协议异常时可临时设为 `legacy` 回退
- `AI_DJ_MEMORY_TURNS`：可选，模型近期上下文轮数，默认 `20`
- `AI_DJ_CHAT_MAX_TOKENS`：可选，普通聊天最大输出 token，默认 `800`

如果前端状态条显示 `AI FALLBACK`，说明服务端没有读到 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`；开放式聊天和点评会明确提示不可用，不会用本地套话冒充模型回复。若已配置但仍收到“没能生成可信的回复”，请在系统状态中查看错误，并检查 key、余额、网络或模型名。

DeepSeek V4 默认开启思考模式；MusicGPT 会在短对话、意图识别和自动 DJ 播报中显式关闭它，并在 JSON Output 偶发返回空内容时重试一次。可以运行 `npm run deepseek:check` 单独检查当前网络、密钥、模型名和 Chat Completions 请求。

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
- `POST /api/chat/stream`（NDJSON：文本增量与最终持久化结果）
- `GET /api/realtime/session`（检查原生语音是否已配置，不申请麦克风权限）
- `GET /api/realtime/context`（按统一账本刷新当前 Realtime 会话上下文）
- `POST /api/conversation/voice/turns` 与 `POST /api/conversation/voice/turns/:turnId/complete`（幂等保存有效语音轮次）
- `POST /api/music/commands`（幂等执行文字或语音音乐命令）
- `POST /api/realtime/session`（`application/sdp`：创建 `qwen3.5-omni-plus-realtime` WebRTC 会话）
- `GET /api/chat/history`
- `DELETE /api/chat/history`
- `GET /api/chat/memories`
- `DELETE /api/chat/memories/:memoryId`
- `DELETE /api/chat/memories`
- `GET /api/now`
- `POST /api/next`
- `POST /api/play-track`
- `GET /api/taste`
- `POST /api/feedback`
- `PUT /api/favorites/:trackId`（本地收藏/取消收藏，不写回网易云）
- `GET /api/system/status`
- `POST /api/import/ncm`
- `GET /api/environment`
- `POST /api/environment/location`
- `POST /api/recommendations/import`
- `GET /api/dj/settings`
- `POST /api/dj/settings`
- `GET /api/providers`（查看 `weather / calendar / upnp` 预留 provider 的启用状态）
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
