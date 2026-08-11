import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TurntableStage } from "./components/TurntableStage";

describe("favorite controls", () => {
  it("loads track audio through the fresh server redirect", () => {
    const html = renderToStaticMarkup(
      <TurntableStage
        now={{
          track: {
            id: 8,
            title: "Fresh Link",
            artists: ["Artist"],
            songUrl: "https://expired.example/8.mp3"
          },
          queue: [],
          paused: false
        }}
        onFeedback={async () => undefined}
        onFavorite={async () => undefined}
        onPlaybackStateChange={() => undefined}
        onRequestNext={async () => undefined}
        onTrackEnded={async () => undefined}
        speechActive={false}
      />
    );

    expect(html).toContain('src="/api/tracks/8/audio"');
    expect(html).not.toContain("expired.example");
  });

  it("renders the current local favorite state as an accessible toggle", () => {
    const html = renderToStaticMarkup(
      <TurntableStage
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

  it("renders the turntable play toggle and seek slider accessibly", () => {
    const html = renderToStaticMarkup(
      <TurntableStage
        now={{
          track: { id: 8, title: "Platter Song", artists: ["Artist"] },
          queue: [],
          paused: false,
          isFavorite: false
        }}
        onFeedback={async () => undefined}
        onFavorite={async () => undefined}
        onPlaybackStateChange={() => undefined}
        onRequestNext={async () => undefined}
        onTrackEnded={async () => undefined}
        speechActive={false}
      />
    );

    expect(html).toContain('aria-label="Play or pause"');
    expect(html).toContain('aria-label="Seek current track"');
    expect(html).toContain('aria-label="收藏当前歌曲"');
  });
});
