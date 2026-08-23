import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

  it("uses the source-qualified track key when a QQ queue item is played", () => {
    const onPlayTrack = vi.fn();
    const renderQueueRail = (QueueRail as unknown as {
      type: (props: ComponentProps<typeof QueueRail>) => ReactElement;
    }).type;
    const tree = renderQueueRail({
      loadingTrackId: null,
      onPlayTrack,
      queue: [{
          track: {
            id: "003abc",
            trackKey: "qq:003abc",
            source: "qq",
            sourceId: "003abc",
            title: "QQ Queue Song",
            artists: ["QQ Artist"]
          },
          score: 0.9,
          reason: "QQ source",
          source: "library",
          bucket: "familiar"
      }]
    });
    const button = findElementByType(tree, "button");

    expect(button).toBeDefined();
    (button!.props as { onClick: () => void }).onClick();
    expect(onPlayTrack).toHaveBeenCalledOnce();
    expect(onPlayTrack).toHaveBeenCalledWith("qq:003abc");
  });
});

function findElementByType(node: ReactNode, type: string): ReactElement | undefined {
  if (!isValidElement(node)) return undefined;
  if (node.type === type) return node;
  const children = Children.toArray((node.props as { children?: ReactNode }).children);
  for (const child of children) {
    const match = findElementByType(child, type);
    if (match) return match;
  }
  return undefined;
}
