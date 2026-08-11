# ADR 0001：共享会话内核，保留模态 Responder

- 状态：Accepted
- 日期：2026-08-04

## 背景

Aurora UI 原先由文字模型负责聊天历史和 DJ 文字回复，Qwen Realtime 独立负责实时听说及工具调用。这使文字与语音不能稳定引用共同前文，并可能出现 UI 展示的 DeepSeek 文本与用户实际听到的 Qwen 回复不一致。

## 决策

引入 Conversation Kernel 作为消息、轮次、上下文、长期记忆和更新事件的唯一协调者，同时保留两个 responder adapter：

- 文字轮次由 DeepSeek 或当前 OpenAI 兼容模型生成最终答案。
- 语音轮次由 Qwen Realtime 生成最终音频和同源输出转写。
- Music Command Module 只返回事实与执行结果，不额外生成助手消息。
- Narration 独立于会话轮次，结束后从统一账本 rebase。

## 原因

统一成单一模型主脑会牺牲 Qwen WebRTC 的低延迟音频、VAD 和打断能力，或牺牲现有文字模型在长文本与可配置 provider 上的优势。共享内核加不同 responder 能统一事实源与记忆，同时保留每种模态最合适的生成路径。

## 后果

- 同一轮最多保存一对 user/assistant，语音 UI 文本等于 Qwen 输出转写。
- 工具调用必须具有 `commandId` 幂等性。
- Realtime 协议需要把供应商 JSON 归一化为领域事件，并处理乱序、重复及转写回补。
- `REALTIME_CONVERSATION_MODE=legacy` 暂时保留现场回退；真实凭证稳定验收后再单独删除旧适配路径。
