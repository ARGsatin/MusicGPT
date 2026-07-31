import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlayerStack } from "./App";

describe("favorite controls", () => {
  it("renders the current local favorite state as an accessible toggle", () => {
    const html = renderToStaticMarkup(
      <PlayerStack
        now={{
          track: { id: 7, title: "Favorite Song", artists: ["Artist"] },
          queue: [],
          paused: false,
          isFavorite: true
        }}
        onFeedback={async () => undefined}
        onFavorite={async () => undefined}
        onPlaybackStateChange={() => undefined}
        onRequestNext={async () => undefined}
        onTrackEnded={async () => undefined}
        speechActive={false}
      />
    );

    expect(html).toContain('aria-label="取消收藏"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("♥");
  });
});
