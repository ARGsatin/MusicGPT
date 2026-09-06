# MusicGPT

本地私有运行的 AI 音乐电台：连接网易云与 QQ 音乐，用收藏、歌单和播放行为生成结构化品味与全天计划，并让 AI DJ 陪你聊天、点歌和播报。

## 核心能力

- 网易云 + QQ 音乐双曲源；统一 `trackKey`，同一录音的跨平台版本可在播放失败时自动回退
- SQLite 事实库原子生成 `state/library.json` 与可人工调权的 `state/taste.md`
- 晨间探索、午后柔和、晚间回忆三时段全天计划；每段最多 10 首，播放队列是全天计划的滚动窗口
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
- 只有明确提出点歌、切歌、暂停等操作时才进入音乐控制；文字对话识别到歌名、场景或当前氛围点歌后会直接切歌，“氛围点歌”按钮只是快捷输入；单纯谈到“播放”“推荐”“歌”仍会继续聊天
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
- `DASHSCOPE_WORKSPACE_ID`：使用默认华北 2（北京）端点时必填，填写百炼业务空间 ID；服务端据此生成工作空间专属 WebRTC 地址
- `DASHSCOPE_REALTIME_BASE_URL`：完整 WebRTC SDP 地址覆盖项；使用新加坡地域或自定义代理时填写，并可替代 `DASHSCOPE_WORKSPACE_ID`
- `REALTIME_CONVERSATION_MODE`：默认 `unified`，启用统一文字/语音账本；现场协议异常时可临时设为 `legacy` 回退
- `AI_DJ_MEMORY_TURNS`：可选，模型近期上下文轮数，默认 `20`
- `AI_DJ_CHAT_MAX_TOKENS`：可选，普通聊天最大输出 token，默认 `800`

如果前端状态条显示 `AI FALLBACK`，说明服务端没有读到 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`；开放式聊天和点评会明确提示不可用，不会用本地套话冒充模型回复。若已配置但仍收到“没能生成可信的回复”，请在系统状态中查看错误，并检查 key、余额、网络或模型名。

DeepSeek V4 默认开启思考模式；MusicGPT 会在短对话、意图识别和自动 DJ 播报中显式关闭它，并在 JSON Output 偶发返回空内容时重试一次。可以运行 `npm run deepseek:check` 单独检查当前网络、密钥、模型名和 Chat Completions 请求。

Realtime 语音要求同时配置 `DASHSCOPE_API_KEY`，以及 `DASHSCOPE_WORKSPACE_ID` 或 `DASHSCOPE_REALTIME_BASE_URL` 其中之一。`GET /api/realtime/session` 只有在密钥和端点都完整时才返回 `enabled: true`，因此不会在配置不完整时提前申请麦克风权限。

### QQ 音乐、品味文件与 Routine

启动页面后打开“今日计划”，点击“扫码连接”即可使用 QQ 音乐 Node SDK 登录。实现固定使用 `@sansenjian/qq-music-api@2.4.0`；二维码会返回页面，登录 Cookie 只写入已忽略的 `state/qqmusic/`，不会出现在 API 响应或日志中。首次授权会同步“我喜欢”和自建歌单，随后在启动、每 6 小时或手动点击时幂等同步。固定版 SDK 当前没有近期播放接口，因此曲源状态会明确返回 `recentPlays: false` 和 `qq_recent_plays_unavailable` 警告，不会伪造近期播放证据。SDK 参考：[快速开始](https://sansenjian.github.io/qq-music-api/guide/quickstart.html)、[登录](https://sansenjian.github.io/qq-music-api/guide/authentication.html)。

`state/taste.md` 的 YAML 区可以设置人工规则，系统只重写 `musicgpt:auto` 标记区。权重范围是 `0.5–2.0`；语法错误时服务继续使用最后有效规则，并在页面显示警告：

```yaml
---
artistWeights:
  宇多田ヒカル: 1.6
tagWeights:
  style:dream pop: 1.3
blockedArtists: []
blockedTags:
  - style:metal
---
```

`state/routine.json` 支持 weekly 与日期 override。本版不提供编辑器，只在页面展示解析状态和路径：

```json
{
  "version": 1,
  "timezone": "Asia/Shanghai",
  "weekly": {
    "monday": [
      { "start": "09:00", "end": "12:00", "activity": "工作", "expectedTags": ["focus"], "energy": "medium", "musicAllowed": true }
    ]
  },
  "overrides": {}
}
```

当天逐小时天气来自 [Open-Meteo Forecast API](https://open-meteo.com/en/docs)。未配置定位或天气请求失败时，全天计划仍使用时段、routine 与本地品味生成。

“今日计划”每天生成三个最多 10 首的主题时段：06:00–12:00 是“晨间探索”（目标 40% 真正未听过的录音），12:00–18:00 是“午后柔和”（目标 70% 柔和歌曲并优先 2 首古典/器乐），18:00–24:00 是“晚间回忆”（目标 80% 有长期播放或收藏证据的歌曲）。主题候选不足时会回退到合格的熟悉口味，不会为凑比例放入低质量歌曲；跨网易云与 QQ 的同一录音共享播放、收藏和跳过历史。

“今日计划”中的“一键播放当前时段”会立即切换播放器：06:00–24:00 播放当前主题时段，00:00–06:00 播放当天接下来的晨间计划；已播放歌曲会跳过，后续队列只取自所选时段且最多 10 首。页面展示全天计划中的全部歌曲和预计播放分钟数。

3. 启动

```bash
npm run dev
```

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:8787`
- 网易云 API：`http://127.0.0.1:3001`

`npm run dev` 默认走完整的受监督启动链。只有在明确不需要网易云能力的前后端开发场景中，才使用 `npm run dev:app`。

受监督入口会解析 Git 当前注册的 `main` 工作树并从该目录启动，避免合并后仍误用旧的 `musicgpt-v2` 工作树。部署、就绪检查、私有 `.env`/`state` 保留方式和回滚步骤见 [从 `main` 启动与回滚](docs/deployment-main.md)。

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
- `POST /api/taste/signals`（确认、降低、屏蔽、删除或重置自动音乐画像信号）
- `POST /api/feedback`
- `POST /api/listening/outcomes`（幂等提交完成、跳过、放弃或播放错误及有效听播时长）
- `POST /api/learning/undo`（在学习回执有效期内反向撤销本次学习）
- `PUT /api/favorites/:trackId`（本地收藏/取消收藏，不写回网易云）
- `GET /api/system/status`
- `POST /api/import/ncm`
- `GET /api/music-sources`
- `POST /api/music-sources/qq/auth/qr`
- `GET /api/music-sources/qq/auth/qr/:sessionId`
- `DELETE /api/music-sources/qq/auth`
- `POST /api/music-sources/:source/sync`
- `GET /api/library/export`
- `GET /api/daily-plan`
- `POST /api/daily-plan/regenerate`
- `POST /api/daily-plan/play`（切换到当前或紧邻的下一计划时段并立即播放）
- `GET /api/environment`
- `POST /api/environment/location`
- `POST /api/recommendations/import`
- `GET /api/dj/settings`
- `POST /api/dj/settings`
- `GET /api/providers`（查看 `weather / calendar / upnp` 预留 provider 的启用状态）
- `GET /ws/stream`

## 可教的 DJ 与智能策略

文字聊天与 Qwen Realtime 语音共用同一个 `MusicCommand` 规划和执行接口。低置信度或多版本歧义会先返回澄清，不产生播放、收藏或画像副作用；复合命令按步骤返回执行结果。推荐统一由 `ListeningPolicy` 排序，并在当前播放、日计划与音乐画像中暴露真实决策证据和学习回执。

首次升级默认以 `shadow` 模式运行：用户仍听到原排序，新策略只记录排名、理由和护栏结果。满足样本与安全门槛后才会进入 `adaptive`；异常时自动退回 `shadow`。可用 `INTELLIGENCE_POLICY_MODE=legacy|shadow|adaptive` 强制覆盖，留空则读取 SQLite 中的持久模式。`GET /api/system/status` 的 `intelligencePolicy` 字段会显示当前模式、版本、影子样本量与回退原因。

离线智能评测固定覆盖 150 条轨迹，不会调用付费模型：

```bash
npm run eval:intelligence
```

发布前如明确允许产生 DeepSeek 调用成本，再运行 `node scripts/evaluate-intelligence.mjs --live --write-cache --require-pass`。它固定发起 25 次规划任务；供应商返回无效 JSON 时，单个任务可能按既有兼容策略发生有限重试，因此不要把“25 条样例”当成严格的计费请求上限。每个最终规划随后分别进入全新的文字/语音 `MusicCommand` 固定运行时，不连接或污染正在使用的服务与 SQLite。门槛为高风险样例成功率至少 92%、错误动作率为 0，且两个通道必须一致。缓存绑定 provider、model、语料哈希、评测器版本与通道集合，只保存样例 ID 和脱敏判定，不保存输入、模型回复、聊天、密钥或错误原文。

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
