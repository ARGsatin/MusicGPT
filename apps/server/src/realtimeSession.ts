export const REALTIME_MODEL = "qwen3.5-omni-plus-realtime";
export const REALTIME_VOICE = "Tina";

export interface CreateRealtimeSessionOptions {
  apiKey: string;
  baseUrl?: string;
  workspaceId?: string;
  offerSdp: string;
  fetchFn?: typeof fetch;
}

export function resolveRealtimeSessionUrl(
  baseUrl?: string,
  workspaceId?: string
): string {
  const normalizedWorkspaceId = workspaceId?.trim();
  if (normalizedWorkspaceId && !/^[a-zA-Z0-9-]+$/.test(normalizedWorkspaceId)) {
    throw new Error("invalid_dashscope_workspace_id");
  }
  const resolvedBaseUrl = baseUrl?.trim() || (normalizedWorkspaceId
    ? `https://${normalizedWorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime`
    : undefined);
  if (!resolvedBaseUrl) {
    throw new Error("dashscope_realtime_endpoint_not_configured");
  }
  const url = new URL(resolvedBaseUrl);
  url.searchParams.set("model", REALTIME_MODEL);
  return url.toString();
}

export function isRealtimeSessionConfigured(
  apiKey?: string,
  baseUrl?: string,
  workspaceId?: string
): boolean {
  return Boolean(apiKey?.trim() && (baseUrl?.trim() || workspaceId?.trim()));
}

export function buildRealtimeSessionConfig(
  contextInstructions?: string,
  mode: "unified" | "legacy" = "unified"
) {
  const sharedContext = contextInstructions?.trim();
  return {
    modalities: ["text", "audio"],
    voice: REALTIME_VOICE,
    input_audio_format: "pcm" as const,
    output_audio_format: "pcm" as const,
    ...(mode === "unified"
      ? { input_audio_transcription: { model: "qwen3-asr-flash-realtime" } }
      : {}),
    turn_detection: {
      type: mode === "unified" ? "server_vad" as const : "semantic_vad" as const,
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 800,
      create_response: true,
      interrupt_response: true
    },
    enable_search: false,
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
      "任何涉及当前歌曲、队列、播放/暂停/切歌/重播、收藏、点歌、偏好、环境选歌或音乐推荐的内容都必须调用 run_music_command，request 保留用户原话。",
      "工具返回后先依据结果自然回应；不要逐字朗读 JSON，也不要声称执行了工具没有完成的动作。",
      "# Background Audio",
      "如果最新音频只是背景音乐、环境声、沉默、电视声、旁人交谈或显然没有在对你说话，调用 wait_for_user 并保持安静。",
      "调用 wait_for_user 后不要再给口头回应。只有用户明显在对你说话或提出请求时才恢复正常回应。",
      "# Unclear Audio",
      "音频明显是在对你说话但内容听不清时，用一句简短中文请用户重复；不要猜测，不要调用音乐工具。",
      ...(sharedContext ? ["# Shared Conversation Context", sharedContext] : [])
    ].join("\n"),
    tools: [
      {
        type: "function" as const,
        function: {
          name: "run_music_command",
          description:
            "Read or change Aurora UI music state. Always use for playback controls, current-track questions, requests, recommendations, queue changes, likes, and music preferences.",
          parameters: {
            type: "object",
            properties: {
              request: {
                type: "string",
                description: "The user's original music-related request, preserving names and details."
              },
              confirmationToken: {
                type: "string",
                description: "A confirmation token returned by an earlier ambiguous music search."
              },
              selectedTrackId: {
                type: "number",
                description: "The selected track ID when confirming an earlier ambiguous search."
              }
            },
            required: ["request"]
          }
        }
      },
      {
        type: "function" as const,
        function: {
          name: "wait_for_user",
          description:
            "Stay silent when the latest audio is background music, environmental noise, silence, TV, side conversation, or speech not addressed to the DJ.",
          parameters: {
            type: "object",
            properties: {},
            required: []
          }
        }
      }
    ]
  };
}

export async function createRealtimeSession({
  apiKey,
  baseUrl,
  workspaceId,
  offerSdp,
  fetchFn = fetch
}: CreateRealtimeSessionOptions): Promise<string> {
  const response = await fetchFn(resolveRealtimeSessionUrl(baseUrl, workspaceId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/sdp"
    },
    body: offerSdp
  });
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`dashscope_realtime_session_failed:${response.status}:${responseBody.slice(0, 300)}`);
  }
  return responseBody;
}
