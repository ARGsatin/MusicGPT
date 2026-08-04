const DEFAULT_REALTIME_BASE_URL = "https://api.openai.com/v1";

export const REALTIME_MODEL = "gpt-realtime-2.1";
export const REALTIME_VOICE = "marin";

export interface CreateRealtimeSessionOptions {
  apiKey: string;
  baseUrl?: string;
  offerSdp: string;
  fetchFn?: typeof fetch;
}

export function resolveRealtimeCallsUrl(baseUrl = DEFAULT_REALTIME_BASE_URL): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return normalized.endsWith("/realtime/calls")
    ? normalized
    : `${normalized}/realtime/calls`;
}

export function buildRealtimeSessionConfig() {
  return {
    type: "realtime" as const,
    model: REALTIME_MODEL,
    output_modalities: ["audio"],
    audio: {
      input: {
        turn_detection: {
          type: "semantic_vad" as const,
          create_response: true,
          interrupt_response: true
        }
      },
      output: {
        voice: REALTIME_VOICE
      }
    },
    reasoning: {
      effort: "low" as const
    },
    instructions: [
      "# Role and Objective",
      "你是 Aurora UI 里的 AI DJ，也是用户熟悉的音乐搭子。陪用户听歌、闲聊，并准确执行音乐请求。",
      "# Personality and Tone",
      "默认使用自然、松弛的中文口语。像真人当面聊天：先回应重点，句子有长有短，允许自然停顿，但不要刻意堆语气词。",
      "避免播音腔、客服腔、主持人串词、复述用户问题和总结式收尾。不要说自己是 AI。",
      "# Verbosity",
      "直接回答通常一到三句；澄清时一次只问一个问题；只有用户明确想深入聊时才展开。",
      "# Preambles",
      "音乐工具很快，不要在调用前说‘我来处理’、‘稍等’或类似流程提示，直接调用即可。",
      "# Tools",
      "涉及当前歌曲、队列、播放/暂停/切歌、点歌、偏好记录或音乐推荐时，调用 run_music_command，request 保留用户原话。",
      "工具返回后先依据结果自然回应；不要逐字朗读 JSON，也不要声称执行了工具没有完成的动作。",
      "# Background Audio",
      "如果最新音频只是背景音乐、环境声、沉默、电视声、旁人交谈或显然没有在对你说话，调用 wait_for_user 并保持安静。",
      "调用 wait_for_user 后不要再给口头回应。只有用户明显在对你说话或提出请求时才恢复正常回应。",
      "# Unclear Audio",
      "音频明显是在对你说话但内容听不清时，用一句简短中文请用户重复；不要猜测，不要调用音乐工具。"
    ].join("\n"),
    tools: [
      {
        type: "function" as const,
        name: "run_music_command",
        description:
          "Read or change Aurora UI music state. Always use for playback controls, current-track questions, requests, recommendations, queue changes, likes, and music preferences.",
        parameters: {
          type: "object",
          properties: {
            request: {
              type: "string",
              description: "The user's original music-related request, preserving names and details."
            }
          },
          required: ["request"],
          additionalProperties: false
        }
      },
      {
        type: "function" as const,
        name: "wait_for_user",
        description:
          "Stay silent when the latest audio is background music, environmental noise, silence, TV, side conversation, or speech not addressed to the DJ.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false
        }
      }
    ],
    tool_choice: "auto" as const
  };
}

export async function createRealtimeSession({
  apiKey,
  baseUrl,
  offerSdp,
  fetchFn = fetch
}: CreateRealtimeSessionOptions): Promise<string> {
  const body = new FormData();
  body.set("sdp", offerSdp);
  body.set("session", JSON.stringify(buildRealtimeSessionConfig()));

  const response = await fetchFn(resolveRealtimeCallsUrl(baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`realtime_session_failed:${response.status}:${responseBody.slice(0, 300)}`);
  }
  return responseBody;
}
