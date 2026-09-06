import type { ChatMemory } from "@musicgpt/shared";

import type { AiDjAssistant } from "./aiDjAssistant.js";
import { StateRepository } from "./stateRepository.js";

const MAX_MEMORIES = 100;
const MAX_CONTEXT_MEMORIES = 20;
const MAX_CONTEXT_CHARACTERS = 2_000;
const MIN_RELEVANCE_SCORE = 2;

type MemoryExtractor = NonNullable<AiDjAssistant["extractMemories"]>;

export class ChatMemoryService {
  private pending = Promise.resolve();
  private revision = 0;

  constructor(
    private readonly repo: StateRepository,
    private readonly extractor: MemoryExtractor | undefined,
    private readonly onUpdated: (memories: ChatMemory[]) => void = () => undefined
  ) {}

  list(): ChatMemory[] {
    return this.repo.getChatMemories(MAX_MEMORIES);
  }

  relevantTo(message: string): ChatMemory[] {
    const memories = this.list();
    const queryTokens = tokenize(message);
    const ranked = memories
      .map((memory, index) => ({
        memory,
        relevance: relevanceScore(queryTokens, tokenize(memory.content)),
        index
      }))
      .filter((entry) => entry.relevance >= MIN_RELEVANCE_SCORE)
      .sort((left, right) => right.relevance - left.relevance || left.index - right.index);
    const selected: ChatMemory[] = [];
    let characters = 0;
    for (const entry of ranked) {
      if (selected.length >= MAX_CONTEXT_MEMORIES) {
        break;
      }
      if (characters + entry.memory.content.length > MAX_CONTEXT_CHARACTERS) {
        continue;
      }
      selected.push(entry.memory);
      characters += entry.memory.content.length;
    }
    return selected;
  }

  enqueueCapture(userMessage: string, assistantReply: string): void {
    if (!this.extractor) {
      return;
    }
    const revision = this.revision;
    this.pending = this.pending
      .then(async () => {
        const existing = this.list();
        const update = await this.extractor!(userMessage, assistantReply, existing);
        if (revision !== this.revision) {
          return;
        }
        const deleteIds = [
          ...update.deleteIds,
          ...update.upserts.flatMap((memory) => memory.supersedesIds ?? [])
        ];
        let changed = this.repo.deleteChatMemories(deleteIds) > 0;
        for (const memory of update.upserts) {
          if (
            containsForbiddenSecret(memory.content) ||
            (containsSensitivePersonalInfo(memory.content) &&
              !isExplicitMemoryRequest(userMessage))
          ) {
            continue;
          }
          this.repo.upsertChatMemory({
            category: memory.category,
            content: memory.content,
            normalizedKey: memory.normalizedKey
          });
          changed = true;
        }
        if (!changed) {
          return;
        }
        this.repo.pruneChatMemories(MAX_MEMORIES);
        this.onUpdated(this.list());
      })
      .catch(() => undefined);
  }

  delete(id: number): boolean {
    const deleted = this.repo.deleteChatMemory(id);
    if (deleted) {
      this.revision += 1;
      this.onUpdated(this.list());
    }
    return deleted;
  }

  clear(): void {
    this.revision += 1;
    this.repo.clearChatMemories();
    this.onUpdated([]);
  }

  async waitForIdle(): Promise<void> {
    await this.pending;
  }
}

function tokenize(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu)) {
    const token = match[0];
    tokens.add(token);
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      const characters = [...token];
      for (let index = 0; index < characters.length - 1; index += 1) {
        tokens.add(`${characters[index]}${characters[index + 1]}`);
      }
    }
  }
  return tokens;
}

function relevanceScore(left: Set<string>, right: Set<string>): number {
  let score = 0;
  for (const token of left) {
    if (right.has(token)) {
      score += token.length;
    }
  }
  return score;
}

function containsForbiddenSecret(content: string): boolean {
  return /api[\s_-]*key|access[\s_-]*token|session[\s_-]*token|private[\s_-]*key|client[\s_-]*secret|cookie|password|密码|验证码|登录凭证|支付密码|支付宝账号|微信支付账号|银行(?:账户|账号)|银行卡|信用卡|卡号|收款码|\bcvv\b|身份证|护照号|精确住址|家庭住址/iu.test(
    content
  );
}

function containsSensitivePersonalInfo(content: string): boolean {
  return /确诊|疾病|病史|用药|过敏|抑郁|焦虑症|怀孕|性取向|宗教信仰|政治立场|收入|工资|负债|债务/iu.test(
    content
  );
}

function isExplicitMemoryRequest(message: string): boolean {
  return /请记住|帮我记住|记住这|记一下|记下来|别忘了|以后要记得|保存这条/iu.test(message);
}
