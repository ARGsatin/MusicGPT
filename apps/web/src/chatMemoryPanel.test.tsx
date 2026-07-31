import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatMemoryPanel } from "./ChatMemoryPanel";

describe("chat memory panel", () => {
  it("renders inspectable memories with separate forget controls", () => {
    const html = renderToStaticMarkup(
      <ChatMemoryPanel
        memories={[
          {
            id: 7,
            category: "preference",
            content: "用户喜欢雨天听轻爵士",
            createdAt: "2026-07-30T08:00:00.000Z",
            updatedAt: "2026-07-30T08:00:00.000Z"
          }
        ]}
        busyMemoryId={null}
        clearing={false}
        error={null}
        onForget={() => undefined}
        onClear={() => undefined}
      />
    );

    expect(html).toContain("她记得的关于你");
    expect(html).toContain("长期记忆与聊天记录分开保存");
    expect(html).toContain("用户喜欢雨天听轻爵士");
    expect(html).toContain("全部忘记");
    expect(html).toContain(">忘记<");
  });
});
