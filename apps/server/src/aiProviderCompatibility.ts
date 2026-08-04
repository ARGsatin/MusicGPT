export interface DeepSeekThinkingControl {
  thinking: {
    type: "disabled";
  };
}

export function withAiProviderCompatibility<T extends object>(
  provider: string,
  request: T
): T | (T & DeepSeekThinkingControl) {
  if (provider !== "deepseek") {
    return request;
  }

  return {
    ...request,
    thinking: { type: "disabled" }
  };
}
