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
  status(): { configured: boolean; model?: string; baseUrlConfigured?: boolean; lastError?: string };
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
}

export class OpenAiDjAssistant implements AiDjAssistant {
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly baseUrlConfigured: boolean;
  private lastError: string | undefined;

  constructor(options: OpenAiDjAssistantOptions) {
    this.model = options.model;
    this.baseUrlConfigured = Boolean(options.baseUrl);
    if (options.apiKey) {
      this.client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseUrl
      });
    }
  }

  status(): { configured: boolean; model?: string; baseUrlConfigured?: boolean; lastError?: string } {
    const status = {
      configured: Boolean(this.client),
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
      return "现在还没有正在播放的歌。先让唱针落下去，我们再认真聊它的灵魂。";
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
            content:
              "你是 GPT DJ。用中文评论指定歌曲，80-450字，可长可短，像真正听过之后随手说出来但有专业含量。必须根据歌曲标题、艺人、专辑、moodTag、用户意图和最近对话改变分析角度；可以聊编曲、声音质感、情绪结构、节奏密度、旋律气味或适合的场景。避免套话，尤其不要反复使用“情绪压低再慢慢放出来”“有热气只是克制”“半盏灯的房间”等固定句式。语气幽默深沉，不营销，不机械。"
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
            content:
              "你是 MusicGPT 的 GPT DJ，不是客服机器人。中文回复，要像一个有耳朵、有脾气、有审美的电台 DJ：幽默、深沉、会接话，但不要端着。你可以聊音乐、帮用户把模糊感受翻译成点歌方向、解释当前播放。不要复读固定开场白；不要说“我在，你可以描述一个场景”这类模板句；不要假装已经执行未执行的播放动作。"
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
  {
    const artist = track.artists.join(" / ") || "这位音乐人";
    const title = `《${track.title}》`;
    const variants = [
      `${title}可以。${artist}把气口留得很舒服，不抢你，只把当前气氛往前推半步。`,
      `${title}挺贴。它的质感不厚重，但有抓手，适合现在这种想听歌、不想被歌教育的时刻。`,
      `${title}我会留它。${artist}这里最妙的是分寸感，情绪到了，但没有把话说满。`
    ];
    return variants[stableIndex(`${track.id}:${track.title}`, variants.length)]!;
  }
  const artist = track.artists.join(" / ") || "这位音乐人";
  const title = `《${track.title}》`;
  switch (track.moodTag) {
    case "focus":
      return `${title}像一盏只照键盘的台灯，${artist}把声音切得很干净：节奏不来抢戏，低频像地板下稳定运行的服务器。它适合让注意力往里收，不负责替你热血，只负责让脑子别散架。`;
    case "energy":
      return `${title}的推进感更像夜航起飞，${artist}把鼓点和旋律抛得很亮，副歌一出来就有那种“算了，先把速度拉满”的冲动。它不装深沉，深沉是听完之后你发现自己走路变快了。`;
    case "night":
      return `${title}有夜色，但不是一块黑布。${artist}让旋律留着边缘光，声音像从远处的窗口漏出来，适合在城市快睡着时听。它的妙处不是悲伤，而是懂得把话说到七分，剩下三分交给你发呆。`;
    case "calm":
      return `${title}的呼吸很稳，${artist}没有急着把情绪推到你脸上，而是把空间慢慢擦亮。它像一杯不烫手的茶，入口平，回味里有一点小小的弯路。`;
    case "warm":
      return `${title}带着一点体温，${artist}的处理不靠大开大合取胜，更像把毛衣搭在椅背上那种可靠的温柔。它不负责拯救世界，但很会把房间里的尖角磨圆。`;
    case "nostalgia":
      return `${title}的怀旧感不是旧照片滤镜，而是某个旋律拐弯处突然碰到以前的自己。${artist}让声音带着时间的毛边，听起来像从抽屉里翻出一张还没褪色的票根。`;
    default:
      return `${title}有自己的重心，${artist}没有把所有情绪摊开给你看，而是留了几处可以钻进去的缝。它适合认真听，也适合假装只是路过，结果被某个细节轻轻拽住。`;
  }
}

export function fallbackChatReply(message: string, context: AiDjContext): string {
  {
    const current = context.nowTrack
      ? `现在垫着《${context.nowTrack!.title}》`
      : "现在唱针还没落稳";
    const variants = [
      `${current}。你继续说，我按你的语气往歌里找。`,
      "懂，我先不急着点歌。这个听感可以再冷一点，也可以更松一点。",
      `${current}。别写论文，我们就按耳朵走。`
    ];
    return variants[/冷|cold/i.test(message) ? 1 : stableIndex(message, variants.length)]!;
  }
  const current = context.nowTrack
    ? `现在垫底的是《${context.nowTrack!.title}》 - ${context.nowTrack!.artists.join(" / ") || "未知艺人"}`
    : "现在唱针还悬在半空";
  const variants = [
    `${current}。我目前还在本地 DJ 模式，脑子里没有云端模型那块湿润的灰质；但你可以继续甩给我一个画面，我会先用曲库和播放记录给你掏一首不太敷衍的。`,
    `这句我接住了。不过先坦白：OpenAI API 还没通，我现在像一台没插天线的小电台，只能靠本地规则和你的曲库嗅觉工作。给我“时间、天气、情绪、节奏”里任意两个，我会更准。`,
    `${current}。如果你想让我真正像 DJ 一样闲聊、吐槽、顺着你的话拐弯，需要把 OpenAI key 接上；没接之前，我能点歌和粗评，但灵魂含量会偏罐头。`,
    `我听懂你的方向了，但现在我是离线脑袋：会翻曲库，会排队，会点评，可自由聊天容易像便利店广播。你给我一个更具体的场景，我先用本地模式试着把灯光调准。`,
    `这话题可以往下挖。只是此刻 AI 模型没在线，我的回答会比较克制，像低电量合成器。要不你直接说“想要冷一点/热一点/更电子/更人声”，我先把歌切到接近的位置。`
  ];
  return variants[stableIndex(message, variants.length)]!;
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
