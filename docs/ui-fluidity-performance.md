# UI fluidity performance report

Date: 2026-07-28
Branch: `codex/ui-ux-fluidity`

## Reproduction

The performance scenario loads the real Vite/React application with deterministic API fixtures:

- 300 conversation messages
- 200 synchronized lyric lines
- 10 queued tracks
- 2,075 DOM elements throughout both the before and after runs
- Chromium with 4× CPU throttling
- desktop viewport: 1440×900
- mobile viewport: 390×844

Each run measures five seconds of idle clock updates, twenty audio `timeupdate` events at 250ms
intervals, typing 40 characters at 16ms intervals, and opening the queue drawer. Measurements use
the Long Tasks API, animation-frame intervals, the React DevTools commit hook, and Chromium
performance metrics.

Two consecutive baseline runs reproduced the slowdown. The nominal five-second playback phase
took 15.5–21.8 seconds, typing 40 characters took 38.0–41.7 seconds, and opening the queue took
695–850ms to reach the next paint.

## Root cause

The page was a single 742-line `App` component. State with unrelated update rates shared the same
render root:

- the station clock updated every second;
- audio progress updated on every media `timeupdate`;
- every input character updated root state;
- each root update reconciled all accumulated conversation messages and all lyric rows.

The long-task duration was almost entirely JavaScript time, which ruled out the animated
background, backdrop filters, network traffic, and WebSocket events as the primary causes in the
reproduction. Large DOM size amplified the root-render problem, but the DOM itself did not need to
be removed to resolve the interaction latency.

## Changes

- Isolated the station clock, player, lyrics window, lyric row, message list, and weather particles
  into stable memoized render boundaries.
- Moved audio progress and playback UI state into the player component so media events do not
  update the application root.
- Kept playback pause state write-back and all existing network feedback behavior.
- Replaced the linear active-lyric scan with a binary search.
- Updated only the old and new active lyric rows when the lyric changes.
- Added `content-visibility: auto` to off-screen conversation rows; all messages remain in the DOM
  and scroll behavior is unchanged.
- Added a logarithmic-complexity regression test for long lyric documents and connected web tests
  to the root `npm test` command.
- Isolated AI provider configuration tests from inherited shell credentials so the full test suite
  is deterministic without changing runtime provider selection.

No dependencies were added, and no visual design or product content was removed.

## Results

Desktop Chromium, 4× CPU throttle, 1440×900:

| Scenario | Before | After | Change |
| --- | ---: | ---: | ---: |
| Idle long tasks / 5s | 4–5 | 0 | 100% fewer |
| Playback phase wall time | 15.5–21.8s | 5.29s | 66–76% faster |
| Playback long tasks | 23–28 | 0–3 | 87–100% fewer |
| Playback maximum long task | 805–835ms | 0–57ms | 93–100% lower |
| Playback maximum frame | 861–879ms | 79ms | about 91% lower |
| Typing 40 characters | 38.0–41.7s | 3.91s | about 90% faster |
| Typing frame P95 | 969–976ms | 79ms | about 92% lower |
| Typing maximum frame | 1,557–1,703ms | 91ms | about 94% lower |
| Queue next paint | 695–850ms | 60ms | 91–93% faster |

The final desktop run kept the measured key interaction and frame maxima below 100ms.

Mobile Chromium, 4× CPU throttle, 390×844:

| Scenario | Result |
| --- | ---: |
| Idle long tasks / 5s | 0 |
| Playback long tasks / 5s | 0 |
| Playback maximum frame | 61ms |
| Typing frame P95 | 36ms |
| Typing maximum frame | 67ms |
| Queue next paint | 32ms |

## Verification

- `npm test`: 51 tests passed across shared, server, and web workspaces.
- `npm run test -w @musicgpt/web`: 6 tests passed.
- `npm run typecheck`: passed for shared, server, and web workspaces.
- `npm run build`: passed for server and web; production bundle built successfully.
- A real local server + Vite browser pass verified both 1440×900 and 390×844 viewports:
  the root, player, conversation, input, and queue rendered; the input accepted text; the queue
  opened; no horizontal overflow, page exceptions, or Vite error overlay occurred.
- `/api/now`, `/api/taste`, `/api/chat/history`, `/api/environment`, `/api/dj/settings`, and
  `/api/system/status` all returned HTTP 200 through the Vite proxy.
- Browser resource errors were limited to Google Fonts and NetEase image/audio URLs blocked by
  the verification sandbox, plus the pre-existing missing `/favicon.ico`; no application API
  response failed.

## Remaining limitations

- Conversation history remains unbounded. `content-visibility` avoids most off-screen rendering
  work, but very long sessions can still grow memory usage. Pagination or virtualization would
  change scrolling/data-loading behavior and should be treated as a separate product decision.
- Full-screen filters and animated weather layers remain unchanged because profiling showed
  JavaScript reconciliation was the dominant cause. Very weak GPUs may still benefit from a
  separately measured reduced-motion or lower-compositing mode.
- Measurements used local Chrome with deterministic fixtures and 4× CPU throttling because a
  specific target device/browser was not supplied. Physical-device measurements may vary.
