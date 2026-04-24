import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ttsSave } from "edge-tts";

import type { DjScript } from "@musicgpt/shared";

type SaveFn = (text: string, filePath: string, options?: { voice?: string }) => Promise<void>;

export class TtsPipeline {
  constructor(
    private readonly cacheDir: string,
    private readonly voice: string,
    private readonly saveFn: SaveFn = ttsSave
  ) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  async synthesize(script: DjScript): Promise<DjScript> {
    const key = crypto.createHash("sha1").update(`${this.voice}:${script.text}`).digest("hex");
    const filename = `${key}.mp3`;
    const targetPath = path.resolve(this.cacheDir, filename);

    if (!fs.existsSync(targetPath)) {
      try {
        await this.saveFn(script.text, targetPath, { voice: this.voice });
      } catch {
        return script;
      }
    }

    return {
      ...script,
      audioUrl: `/tts-cache/${filename}`
    };
  }
}
