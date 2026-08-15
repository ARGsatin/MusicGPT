# MusicGPT Conversation Context

本文定义统一会话实现中的领域词，作为服务端、Web UI 和协议测试的共同约定。

## Conversation Turn

一个有效轮次由一个用户输入和最多一个助手答案组成，以 `turnId` 标识。文字轮次的最终答案来自文字模型；语音轮次的最终答案是 Qwen Realtime 的输出转写。`turnId + role` 在 SQLite 中唯一，因此浏览器重试不会产生第二条消息。

状态包括：

- `completed`：可以进入后续模型上下文和长期记忆。
- `interrupted`：保留已经收到的助手片段供用户查看，但不进入上下文或记忆。
- `failed`：保留诊断性占位，不进入上下文或记忆。

背景音乐、环境声以及 `wait_for_user` 不构成 Conversation Turn。

## Conversation Ledger

Conversation Ledger 是 SQLite 中的统一事实源。文字和有效语音的转写都写入 `chat_messages`；原始音频从不持久化。账本维护单调递增的 `conversationRevision`，用于 Realtime 上下文刷新和多页面同步。

清空聊天会同时删除消息、未消费的音乐确认和工具调用缓存，但不会删除长期记忆。长期记忆通过独立接口清除。

## Music Command

Music Command 是只负责读取或改变音乐状态的领域操作。它不生成或保存第二条聊天回复。Qwen 的 `call_id` 作为 `commandId`，服务端缓存结构化结果，重复或并发调用只执行一次。

文字对话识别到明确歌名、描述型或当前氛围点歌后直接播放；“氛围点歌”按钮只是同一对话入口的快捷输入。语音明确点歌和描述型推荐也可以直接播放；歧义搜索最多返回三个候选。确认使用两分钟有效、只能消费一次的 `confirmationToken + selectedTrackId`。

## Narration

Narration 是文字回复、手动朗读和 DJ 串场的语音呈现接口。它不是 Conversation Turn，不写聊天历史，也不参与长期记忆。Narration 完成或被打断后，Realtime 会话从 Conversation Ledger 重新构造上下文，避免朗读指令污染互动语音。

## Context Windows

- 文字 responder：最近 20 轮、相关长期记忆、播放状态、队列、口味、环境和近期反馈。
- Qwen Realtime：最近 12 条可用消息（约 4,000 字）、最多 20 条长期记忆（约 2,000 字）以及精简音乐状态（约 2,000 字）。
- 当前 Realtime `sessionId` 自己新增的语音消息不会重复注入。
- `interrupted` 和 `failed` 助手消息始终被过滤。
