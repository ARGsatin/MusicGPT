import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LyricsOverlay } from "./components/LyricsOverlay";
import { TurntableStage } from "./components/TurntableStage";

const demoLyrics = {
  trackId: 7,
  pureMusic: false,
  lines: [
    { timeMs: 0, text: "第一句歌词" },
    { timeMs: 5000, text: "第二句歌词", translation: "second line" },
    { timeMs: 10000, text: "第三句歌词" }
  ]
};

function renderStage(lyrics: unknown) {
  return renderToStaticMarkup(
    <TurntableStage
      now={{
        track: { id: 7, title: "Lyric Song", artists: ["Artist"] },
        lyrics: lyrics as never,
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
}

describe("lyrics display", () => {
  it("shows the karaoke ribbon with an expand affordance when lyrics exist", () => {
    const html = renderStage(demoLyrics);

    expect(html).toContain("第一句歌词");
    expect(html).toContain('aria-label="展开全部歌词"');
  });

  it("falls back to an idle hint when no lyrics are available", () => {
    const html = renderStage(undefined);

    expect(html).toContain("等待歌词信号…");
    expect(html).not.toContain('aria-label="展开全部歌词"');
  });

  it("renders all lines in the overlay with the active line marked", () => {
    const html = renderToStaticMarkup(
      <LyricsOverlay
        activeIndex={1}
        artist="Artist"
        lyrics={demoLyrics}
        trackTitle="Lyric Song"
        onClose={() => undefined}
        onSeek={() => undefined}
      />
    );

    expect(html).toContain("第一句歌词");
    expect(html).toContain("第二句歌词");
    expect(html).toContain("第三句歌词");
    expect(html).toContain("second line");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Lyric Song");
    expect(html).toContain('aria-label="关闭歌词"');
  });
});
