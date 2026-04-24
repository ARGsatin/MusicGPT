import { EventEmitter } from "node:events";

import type { WsPayload } from "@musicgpt/shared";

interface SocketLike {
  send(message: string): void;
  close?(): void;
}

export class WsHub {
  private readonly sockets = new Set<SocketLike>();
  private readonly events = new EventEmitter();

  addSocket(socket: SocketLike): void {
    this.sockets.add(socket);
  }

  removeSocket(socket: SocketLike): void {
    this.sockets.delete(socket);
  }

  onBroadcast(handler: (payload: WsPayload) => void): void {
    this.events.on("broadcast", handler);
  }

  broadcast(payload: WsPayload): void {
    const serialized = JSON.stringify(payload);
    for (const socket of this.sockets) {
      try {
        socket.send(serialized);
      } catch {
        this.sockets.delete(socket);
      }
    }
    this.events.emit("broadcast", payload);
  }
}
