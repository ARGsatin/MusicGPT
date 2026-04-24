import OpenAI from "openai";

import type { DjScript, RadioPlanItem, TasteProfile, Track } from "@musicgpt/shared";

const DJ_BANNED_WORDS = ["违法", "低俗", "辱骂"];
const DJ_MAX_LENGTH = 90;

interface GenerateInput {
  profile: TasteProfile;
  nowTrack: Track;
  upcoming: RadioPlanItem[];
}

export class DjBrain {
  private readonly client?: OpenAI;

  constructor(apiKey?: string) {
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  async generate(input: GenerateInput): Promise<DjScript> {
    const fallbackText = this.fallbackScript(input);
    const text = this.client
      ? await this.generateWithOpenAI(input).catch(() => fallbackText)
      : fallbackText;
    const sanitized = sanitizeDjText(text);
    const trackIds = [input.nowTrack.id, ...input.upcoming.slice(0, 2).map((item) => item.track.id)];

    return {
      id: `dj_${Date.now()}`,
      text: sanitized,
      reason: "根据当前曲目与接下来两首歌自动生成",
      trackIds,
      createdAt: new Date().toISOString()
    };
  }

  private async generateWithOpenAI(input: GenerateInput): Promise<string> {
    if (!this.client) {
      return this.fallbackScript(input);
    }
    const prompt = [
      "你是私人AI电台DJ，回复简短中文播报。",
      `用户偏好摘要: ${input.profile.summary}`,
      `当前歌曲: ${input.nowTrack.title} - ${input.nowTrack.artists.join(", ")}`,
      `下一首候选: ${input.upcoming
        .slice(0, 2)
        .map((item) => `${item.track.title}-${item.track.artists.join("/")}`)
        .join("; ")}`,
      "要求：80字以内，口吻自然，不使用营销腔。"
    ].join("\n");

    const response = await this.client.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature: 0.7
    });

    return response.output_text || this.fallbackScript(input);
  }

  private fallbackScript(input: GenerateInput): string {
    const artist = input.nowTrack.artists[0] ?? "这位歌手";
    const next = input.upcoming[0]?.track.title ?? "下一首";
    return `现在是 ${artist} 的《${input.nowTrack.title}》，等会接《${next}》，整体会更贴合你这个时段的听感。`;
  }
}

export function sanitizeDjText(text: string): string {
  let normalized = text.replace(/\s+/g, " ").trim();
  for (const word of DJ_BANNED_WORDS) {
    normalized = normalized.replaceAll(word, "");
  }
  if (normalized.length > DJ_MAX_LENGTH) {
    normalized = normalized.slice(0, DJ_MAX_LENGTH);
  }
  if (!normalized) {
    normalized = "这段时间我会继续按你的节奏来安排下一首。";
  }
  return normalized;
}
