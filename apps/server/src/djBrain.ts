import OpenAI from "openai";

import type { DjScript, DjSettings, RadioPlanItem, TasteProfile, Track } from "@musicgpt/shared";
import {
  generateAcceptedOpenEndedReply,
  type OpenEndedReplyRejection
} from "./openEndedReply.js";
import { withAiProviderCompatibility } from "./aiProviderCompatibility.js";

const DJ_BANNED_WORDS = ["违法", "低俗", "辱骂"];
const DJ_MAX_LENGTH = 90;

interface GenerateInput {
  profile: TasteProfile;
  nowTrack: Track;
  upcoming: RadioPlanItem[];
  settings?: DjSettings;
}

interface DjBrainOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  client?: OpenAI | undefined;
}

export class DjBrain {
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly provider: string;
  private readonly recentScripts: string[] = [];

  constructor(options: DjBrainOptions | string = {}) {
    const resolved: DjBrainOptions = typeof options === "string" ? { apiKey: options } : options;
    this.model = resolved.model ?? "gpt-4.1-mini";
    this.provider = resolved.provider ?? "openai";
    if (resolved.client) {
      this.client = resolved.client;
    } else if (resolved.apiKey) {
      this.client = new OpenAI({
        apiKey: resolved.apiKey,
        baseURL: resolved.baseUrl,
        timeout: 20_000
      });
    }
  }

  async generate(input: GenerateInput): Promise<DjScript | undefined> {
    if (!this.client) {
      return undefined;
    }
    let text: string;
    try {
      text = await generateAcceptedOpenEndedReply(
        (rejection) => this.generateWithOpenAI(input, rejection),
        { kind: "dj", recentReplies: this.recentScripts.slice(-20) }
      );
    } catch {
      return undefined;
    }
    const sanitized = sanitizeDjText(text);
    if (!sanitized) {
      return undefined;
    }
    const trackIds = [input.nowTrack.id, ...input.upcoming.slice(0, 2).map((item) => item.track.id)];
    this.recentScripts.push(sanitized);
    if (this.recentScripts.length > 20) {
      this.recentScripts.shift();
    }

    return {
      id: `dj_${Date.now()}`,
      text: sanitized,
      reason: "根据当前曲目与接下来两首歌自动生成",
      trackIds,
      createdAt: new Date().toISOString()
    };
  }

  private async generateWithOpenAI(
    input: GenerateInput,
    rejection?: OpenEndedReplyRejection
  ): Promise<string> {
    if (!this.client) {
      return "";
    }
    const prompt = [
      "你是与用户长期相处的私人电台 DJ，在两首歌之间像真人一样随口说一两句。文字会被直接朗读：使用自然口语和长短不一的句子，不要主播腔、客服腔、书面通知或完整总结。直接说明当前曲目与下一首的衔接依据，不先夸歌，不使用固定口癖或抽象气氛话。",
      `DJ语气: ${toneInstruction(input.settings?.tone)}`,
      `用户偏好摘要: ${input.profile.summary}`,
      `当前歌曲: ${input.nowTrack.title} - ${input.nowTrack.artists.join(", ")}`,
      `下一首候选: ${input.upcoming
        .slice(0, 2)
        .map((item) => `${item.track.title}-${item.track.artists.join("/")}`)
        .join("; ")}`,
      "要求：80字以内，不使用营销腔，不刻意添加语气词；不得使用“分寸感”“情绪刚刚好”“重点到了”“扑得太满”等空泛评价。",
      ...(rejection
        ? [
            `上一版被拒绝，原因：${rejection.issues.join(", ")}。`,
            `上一版：${rejection.draft}`,
            "彻底换掉句式重写一次，不解释重写过程。"
          ]
        : [])
    ].join("\n");

    const response = await this.client.chat.completions.create(
      withAiProviderCompatibility(this.provider, {
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 150
      })
    );

    return response.choices[0]?.message.content?.trim() ?? "";
  }
}

function toneInstruction(tone: DjSettings["tone"] | undefined): string {
  if (tone === "lively") {
    return "活泼、轻快、有精神，但不要油腻或喊口号";
  }
  if (tone === "professional") {
    return "克制、清楚、像专业电台主持";
  }
  return "自然、温和、低打扰";
}

export function sanitizeDjText(text: string): string {
  let normalized = text.replace(/\s+/g, " ").trim();
  for (const word of DJ_BANNED_WORDS) {
    normalized = normalized.replaceAll(word, "");
  }
  if (normalized.length > DJ_MAX_LENGTH) {
    normalized = normalized.slice(0, DJ_MAX_LENGTH);
  }
  return normalized;
}
