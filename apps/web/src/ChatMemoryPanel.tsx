import type { ChatMemory } from "@musicgpt/shared";

interface ChatMemoryPanelProps {
  memories: ChatMemory[];
  busyMemoryId: number | null;
  clearing: boolean;
  error: string | null;
  onForget: (memory: ChatMemory) => void;
  onClear: () => void;
}

const categoryLabels: Record<ChatMemory["category"], string> = {
  preference: "偏好",
  habit: "习惯",
  background: "背景",
  relationship: "关系"
};

export function ChatMemoryPanel({
  memories,
  busyMemoryId,
  clearing,
  error,
  onForget,
  onClear
}: ChatMemoryPanelProps) {
  return (
    <section className="chat-memory-panel" aria-label="她记得的关于你">
      <header>
        <div>
          <strong>她记得的关于你</strong>
          <span>长期记忆与聊天记录分开保存</span>
        </div>
        {memories.length > 0 ? (
          <button
            className="clear-memories-button"
            type="button"
            disabled={clearing || busyMemoryId !== null}
            onClick={onClear}
          >
            {clearing ? "清空中…" : "全部忘记"}
          </button>
        ) : null}
      </header>
      {memories.length === 0 ? (
        <p className="chat-memory-empty">还没有长期记忆。稳定的偏好和重要背景会慢慢出现在这里。</p>
      ) : (
        <ul>
          {memories.map((memory) => (
            <li key={memory.id}>
              <span className="memory-category">{categoryLabels[memory.category]}</span>
              <p>{memory.content}</p>
              <button
                type="button"
                disabled={clearing || busyMemoryId !== null}
                onClick={() => onForget(memory)}
                aria-label={`忘记：${memory.content}`}
              >
                {busyMemoryId === memory.id ? "…" : "忘记"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="chat-memory-error">{error}</p> : null}
    </section>
  );
}
