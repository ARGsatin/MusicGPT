import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatStreamFeedbackNotice } from "./ChatStreamFeedbackNotice";

describe("chat stream feedback", () => {
  it("shows a stopped reply as recoverable without calling it an error", () => {
    const html = renderToStaticMarkup(
      <ChatStreamFeedbackNotice
        feedback={{ kind: "stopped", retryMessage: "来点爵士", hadPartialReply: true }}
        onContinue={() => undefined}
        onRetry={() => undefined}
      />
    );

    expect(html).toContain("已停止");
    expect(html).toContain("已保留收到的回复");
    expect(html).toContain("继续聊天");
    expect(html).not.toContain("出错");
    expect(html).not.toContain(">重试<");
  });

  it("labels a network interruption as an error with retry and continue actions", () => {
    const html = renderToStaticMarkup(
      <ChatStreamFeedbackNotice
        feedback={{ kind: "error", retryMessage: "来点爵士", hadPartialReply: true }}
        onContinue={() => undefined}
        onRetry={() => undefined}
      />
    );

    expect(html).toContain("出错");
    expect(html).toContain("连接中断");
    expect(html).toContain(">重试<");
    expect(html).toContain("继续聊天");
    expect(html).not.toContain("已停止");
  });
});
