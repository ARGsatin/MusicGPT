import { useEffect } from "react";

import type { WsPayload } from "@musicgpt/shared";

export function useWsStream(handler: (payload: WsPayload) => void): void {
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws/stream`);
    socket.addEventListener("message", (event) => {
      try {
        handler(JSON.parse(event.data as string) as WsPayload);
      } catch {
        return;
      }
    });
    return () => socket.close();
  }, [handler]);
}
