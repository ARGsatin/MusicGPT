import { useEffect } from "react";

import type { WsPayload } from "@musicgpt/shared";

export const WS_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = WS_RECONNECT_DELAYS_MS[Math.min(Math.max(0, attempt), WS_RECONNECT_DELAYS_MS.length - 1)]!;
  return Math.round(base * (0.8 + random() * 0.4));
}

export function shouldRestoreOnOpen(openedBefore: boolean, reconnectAttempted: boolean): boolean {
  return openedBefore || reconnectAttempted;
}

export function useWsStream(
  handler: (payload: WsPayload) => void,
  onReconnected?: () => void
): void {
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/ws/stream`;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let openedBefore = false;
    let reconnectAttempted = false;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(url);
      socket.addEventListener("open", () => {
        const restore = shouldRestoreOnOpen(openedBefore, reconnectAttempted);
        openedBefore = true;
        reconnectAttempted = false;
        reconnectAttempt = 0;
        if (restore) onReconnected?.();
      });
      socket.addEventListener("message", (event) => {
        try {
          handler(JSON.parse(event.data as string) as WsPayload);
        } catch {
          return;
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        reconnectAttempted = true;
        const delay = reconnectDelayMs(reconnectAttempt);
        reconnectAttempt = Math.min(reconnectAttempt + 1, WS_RECONNECT_DELAYS_MS.length - 1);
        reconnectTimer = window.setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [handler, onReconnected]);
}
