import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QueueRail } from "./components/ChatPanel";

describe("queue controls", () => {
  it("renders each queued song as an accessible play button", () => {
    const html = renderToStaticMarkup(
      <QueueRail
        loadingTrackId={null}
        onPlayTrack={() => undefined}
        queue={[
          {
            track: { id: 42, title: "Queue Song", artists: ["Queue Artist"] },
            score: 0.9,
            reason: "Queued for later",
            source: "library",
            bucket: "familiar"
          }
        ]}
      />
    );

    expect(html).toContain("<button");
    expect(html).toContain('aria-label="立即播放 Queue Song"');
    expect(html).toContain("Queue Artist");
  });
});
