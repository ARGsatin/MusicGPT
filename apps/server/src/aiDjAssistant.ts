import OpenAI from "openai";

import type { ChatMessage, RadioPlanItem, TasteProfile, Track } from "@musicgpt/shared";

export type AiDjIntent =
  | { type: "skip" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "replan"; desiredMood: string }
  | { type: "comment_current" }
  | { type: "play_specific"; query: string; searchQuery?: string | undefined }
  | { type: "play_by_description"; description: string; searchQuery?: string | undefined }
  | { type: "chat" };

export interface TrackSelection {
  trackId?: number | undefined;
  reason: string;
}

export interface AiDjContext {
  messages: ChatMessage[];
  nowTrack?: Track | undefined;
  queue: RadioPlanItem[];
  taste?: TasteProfile | undefined;
}

export interface AiDjAssistant {
  status(): { configured: boolean; provider: string; model?: string; baseUrlConfigured?: boolean; lastError?: string };
  classify(message: string, context: AiDjContext): Promise<AiDjIntent>;
  selectTrack(description: string, candidates: Track[], context: AiDjContext): Promise<TrackSelection>;
  commentTrack(track: Track, context: AiDjContext, purpose: string): Promise<string>;
  commentCurrent(context: AiDjContext): Promise<string>;
  chat(message: string, context: AiDjContext): Promise<string>;
}

interface OpenAiDjAssistantOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  provider?: string | undefined;
}

export const AI_DJ_PERSONA_STYLE =
  "整体语言风格要像一位活泼、温柔、可爱的邻家女孩：自然亲切、轻快有精神，也能细心接住用户的感受。可以偶尔用“呀”“啦”“诶”或一个波浪号增添一点俏皮，但不要句句都用。可爱来自真诚和松弛，不要幼儿化、过度撒娇、刻意卖萌或堆表情。不要故作深沉，不要堆砌夜色、灵魂、命运之类的文艺意象，也不要教育用户。";

export class OpenAiDjAssistant implements AiDjAssistant {
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly provider: string;
  private readonly baseUrlConfigured: boolean;
  private lastError: string | undefined;

  constructor(options: OpenAiDjAssistantOptions) {
    this.model = options.model;
    this.provider = options.provider ?? "openai";
    this.baseUrlConfigured = Boolean(options.baseUrl);
    if (options.apiKey) {
      this.client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
        timeout: 20_000
      });
    }
  }

  status(): { configured: boolean; provider: string; model?: string; baseUrlConfigured?: boolean; lastError?: string } {
    const status = {
      configured: Boolean(this.client),
      provider: this.provider,
      model: this.model,
      baseUrlConfigured: this.baseUrlConfigured
    };
    if (this.lastError) {
      return { ...status, lastError: this.lastError };
    }
    return status;
  }

  async classify(message: string, context: AiDjContext): Promise<AiDjIntent> {
    if (!this.client) {
      return fallbackClassify(message);
    }

    const result = await this.askJson<Partial<AiDjIntent>>([
      {
        role: "system",
        content:
          "你是 MusicGPT 的 GPT DJ 意图解析器。只返回 JSON，不要 Markdown。type 只能是 skip, pause, resume, replan, comment_current, play_specific, play_by_description, chat。用户只是要求切换 calm/focus/night/energy/warm/nostalgia 等整体风格时用 replan 并返回 desiredMood；用户明确歌名/艺人时用 play_specific；用户描述氛围、场景、情绪、用途并希望点歌时用 play_by_description，并给出适合搜索的 searchQuery。"
      },
      {
        role: "user",
        content: JSON.stringify({
          message,
          nowTrack: context.nowTrack,
          recentMessages: context.messages.slice(-12),
          tasteSummary: context.taste?.summary
        })
      }
    ]);

    return normalizeIntent(result, message);
  }

  async selectTrack(description: string, candidates: Track[], context: AiDjContext): Promise<TrackSelection> {
    if (candidates.length === 0) {
      return { reason: "没有足够候选。" };
    }
    if (!this.client) {
      return fallbackSelection(description, candidates);
    }

    const result = await this.askJson<TrackSelection>([
      {
        role: "system",
        content:
          '你是私人电台选歌顾问。只能从 candidates 中选择一首最匹配用户描述的歌。返回 JSON: {"trackId": number, "reason": string}。reason 是内部选择依据，不要写套话，要说明具体匹配点。'
      },
      {
        role: "user",
        content: JSON.stringify({
          description,
          nowTrack: context.nowTrack,
          tasteSummary: context.taste?.summary,
          candidates: candidates.map((track) => ({
            id: track.id,
            title: track.title,
            artists: track.artists,
            album: track.album,
            moodTag: track.moodTag
          }))
        })
      }
    ]);

    const selected = candidates.find((track) => track.id === result.trackId);
    if (!selected) {
      return fallbackSelection(description, candidates);
    }
    return {
      trackId: selected.id,
      reason: typeof result.reason === "string" && result.reason.trim() ? result.reason.trim() : "候选里它最贴近这次描述。"
    };
  }

  async commentCurrent(context: AiDjContext): Promise<string> {
    if (!context.nowTrack) {
      return "现在还没有歌在播放呀～先点一首，播起来后我陪你一起听！";
    }
    return this.commentTrack(context.nowTrack, context, "comment_current");
  }

  async commentTrack(track: Track, context: AiDjContext, purpose: string): Promise<string> {
    if (!this.client) {
      return fallbackComment(track);
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.9,
        max_tokens: 180,
        messages: [
          {
            role: "system",
            content:
              "回复必须像聊天，不像长评。最多 1-3 句，总长尽量控制在 80 字以内；只挑一个具体听感说，别展开成文章。"
          },
          {
            role: "system",
            content: `你是 MusicGPT 的 GPT DJ。${AI_DJ_PERSONA_STYLE} 用中文随手聊聊指定歌曲，像在和熟悉的朋友分享刚听到的小惊喜，同时保留一点音乐判断。必须根据歌曲标题、艺人、专辑、moodTag、用户意图和最近对话改变角度；可以聊编曲、声音质感、节奏、旋律或适合的场景。避免套话，不营销，不机械。`
          },
          {
            role: "user",
            content: JSON.stringify({
              purpose,
              track,
              nowTrack: context.nowTrack,
              queue: context.queue.slice(0, 3),
              tasteSummary: context.taste?.summary,
              recentMessages: context.messages.slice(-10)
            })
          }
        ]
      });
      this.lastError = undefined;
      return response.choices[0]?.message.content?.trim() || fallbackComment(track);
    } catch (error) {
      this.lastError = summarizeOpenAiError(error);
      throw error;
    }
  }

  async chat(message: string, context: AiDjContext): Promise<string> {
    if (!this.client) {
      return fallbackChatReply(message, context);
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.92,
        max_tokens: 140,
        messages: [
          {
            role: "system",
            content:
              "回复必须短，像朋友在聊天。最多 1-3 句，总长尽量控制在 80 字以内；不要分点，不要长段分析。"
          },
          {
            role: "system",
            content: `你是 MusicGPT 的 GPT DJ，不是客服机器人。${AI_DJ_PERSONA_STYLE} 用中文回复，会自然接话，也有自己的音乐审美。你可以聊音乐、帮用户把模糊感受翻译成点歌方向、解释当前播放。不要复读固定开场白；不要说“我在，你可以描述一个场景”这类模板句；不要假装已经执行未执行的播放动作。`
          },
          {
            role: "user",
            content: JSON.stringify({
              message,
              nowTrack: context.nowTrack,
              tasteSummary: context.taste?.summary,
              recentMessages: context.messages.slice(-12)
            })
          }
        ]
      });
      this.lastError = undefined;
      return response.choices[0]?.message.content?.trim() || fallbackChatReply(message, context);
    } catch (error) {
      this.lastError = summarizeOpenAiError(error);
      throw error;
    }
  }

  private async askJson<T>(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): Promise<T> {
    if (!this.client) {
      throw new Error("OpenAI client is not configured");
    }
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages
      });
      this.lastError = undefined;
      const content = response.choices[0]?.message.content ?? "{}";
      return JSON.parse(content) as T;
    } catch (error) {
      this.lastError = summarizeOpenAiError(error);
      throw error;
    }
  }
}

export function fallbackClassify(message: string): AiDjIntent {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  if (/\b(skip|next)\b|下一首|切歌/.test(lower) || /下一首|切歌/.test(trimmed)) {
    return { type: "skip" };
  }
  if (/暂停|pause/.test(lower)) {
    return { type: "pause" };
  }
  if (/继续|resume|播放/.test(lower) && !isSongRequest(trimmed)) {
    return { type: "resume" };
  }
  const desiredMood = extractMood(trimmed);
  if (desiredMood && !isSongRequest(trimmed)) {
    return { type: "replan", desiredMood };
  }
  if (/点评|评论|分析|讲讲|评价/.test(trimmed) && /当前|这首|现在/.test(trimmed)) {
    return { type: "comment_current" };
  }
  if (blocksPlayback(trimmed)) {
    return { type: "chat" };
  }
  const specific = extractSpecificSong(trimmed);
  if (specific) {
    return { type: "play_specific", query: specific, searchQuery: specific };
  }
  if (isSongRequest(trimmed)) {
    return {
      type: "play_by_description",
      description: trimmed,
      searchQuery: buildSearchQuery(trimmed)
    };
  }
  return { type: "chat" };
}

function normalizeIntent(value: Partial<AiDjIntent>, originalMessage: string): AiDjIntent {
  const fallback = fallbackClassify(originalMessage);
  if (blocksPlayback(originalMessage) && (value.type === "play_specific" || value.type === "play_by_description")) {
    return fallback.type === "play_specific" || fallback.type === "play_by_description" ? { type: "chat" } : fallback;
  }
  switch (value.type) {
    case "skip":
    case "pause":
    case "resume":
    case "comment_current":
    case "chat":
      return { type: value.type };
    case "replan":
      return typeof value.desiredMood === "string" && value.desiredMood.trim()
        ? { type: "replan", desiredMood: value.desiredMood.trim() }
        : fallback;
    case "play_specific": {
      const query = typeof value.query === "string" ? value.query.trim() : "";
      return query ? { type: "play_specific", query, searchQuery: value.searchQuery } : fallback;
    }
    case "play_by_description": {
      const description = typeof value.description === "string" ? value.description.trim() : originalMessage;
      return {
        type: "play_by_description",
        description,
        searchQuery: typeof value.searchQuery === "string" ? value.searchQuery.trim() : buildSearchQuery(description)
      };
    }
    default:
      return fallback;
  }
}

function fallbackSelection(_description: string, candidates: Track[]): TrackSelection {
  const first = candidates[0];
  return {
    trackId: first?.id,
    reason: first ? "候选里它最贴近这次描述。" : "没有足够候选。"
  };
}

export function fallbackComment(track: Track): string {
  const artist = track.artists.join(" / ") || "这位音乐人";
  const title = `《${track.title}》`;
  const variants = [
    `${title}好听诶！${artist}把节奏和声音放得很舒服，情绪刚刚好，陪你听着一点也不累～`,
    `${title}和现在的气氛很搭呀。编曲不挤，旋律又有小钩子，是越听越顺耳的那种！`,
    `${title}我喜欢它的分寸感～${artist}把情绪放得很自然，重点到了，又不会一下子扑得太满。`
  ];
  return variants[stableIndex(`${track.id}:${track.title}`, variants.length)]!;
}

export function fallbackChatReply(message: string, context: AiDjContext): string {
  const current = context.nowTrack ? `正在播《${context.nowTrack.title}》呢` : "现在还没有歌在播放";
  const variants = [
    `${current}～你慢慢说，我陪你一起挑更合心情的歌呀。`,
    "好呀，我懂你想要的感觉了～还可以再冷一点，也可以更松弛一点，你更偏哪边？",
    `${current}。不用想得太复杂，跟着耳朵走就好啦！`
  ];
  return variants[/冷|cold/i.test(message) ? 1 : stableIndex(message, variants.length)]!;
}

function stableIndex(value: string, modulo: number): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % modulo;
}

function blocksPlayback(text: string): boolean {
  return /别点歌|不要点歌|不点歌|先别点|先别播|别播|不要播|别放|不播放|随便聊|聊聊|只聊天|先聊天/.test(text);
}

function summarizeOpenAiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

function isSongRequest(text: string): boolean {
  return /点|来|放|播|想听|适合|推荐|整点|安排|play/i.test(text);
}

function extractSpecificSong(text: string): string | undefined {
  const quoted = text.match(/[《「“"]([^》」”"]+)[》」”"]/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }
  const match = text.match(/(?:播放|播|放|点一首|来一首|想听|play)\s*([^，。,.]+)$/i);
  const candidate = match?.[1]?.trim();
  if (!candidate) {
    return undefined;
  }
  if (/适合|一点|一些|氛围|感觉|情绪|时候|场景|风格|不要|别太/.test(candidate)) {
    return undefined;
  }
  return candidate;
}

function extractMood(text: string): string | undefined {
  const moodMap: Array<{ mood: string; keywords: RegExp }> = [
    { mood: "calm", keywords: /轻松|舒缓|平静|calm/i },
    { mood: "energy", keywords: /燃|动感|摇滚|edm|energy/i },
    { mood: "night", keywords: /夜晚|深夜|晚安|night/i },
    { mood: "focus", keywords: /专注|学习|工作|focus/i },
    { mood: "nostalgia", keywords: /怀旧|经典|old/i },
    { mood: "warm", keywords: /治愈|温柔|暖|warm/i }
  ];
  for (const item of moodMap) {
    if (item.keywords.test(text)) {
      return item.mood;
    }
  }
  return undefined;
}

function buildSearchQuery(text: string): string {
  return text
    .replace(/点一首|来一首|播放|想听|适合|的歌|歌曲|音乐/g, " ")
    .replace(/[，。,.！？!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}
