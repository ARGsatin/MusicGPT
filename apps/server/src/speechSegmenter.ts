interface SpeechTextSegmenterOptions {
  minSoftBreakChars?: number;
  maxChars?: number;
}

const STRONG_BREAKS = new Set(["。", "！", "？", "!", "?", "；", ";", "\n"]);
const SOFT_BREAKS = new Set(["，", ",", "：", ":"]);

export class SpeechTextSegmenter {
  private buffer = "";
  private readonly minSoftBreakChars: number;
  private readonly maxChars: number;

  constructor(options: SpeechTextSegmenterOptions = {}) {
    this.minSoftBreakChars = options.minSoftBreakChars ?? 12;
    this.maxChars = options.maxChars ?? 28;
  }

  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  finish(): string[] {
    return this.drain(true);
  }

  private drain(flush: boolean): string[] {
    const ready: string[] = [];
    while (this.buffer) {
      const characters = [...this.buffer];
      const strongBreak = characters.findIndex((character) => STRONG_BREAKS.has(character));
      if (strongBreak >= 0) {
        this.release(characters, strongBreak + 1, ready);
        continue;
      }

      const softBreak = characters.findIndex(
        (character, index) =>
          index + 1 >= this.minSoftBreakChars && SOFT_BREAKS.has(character)
      );
      if (softBreak >= 0) {
        this.release(characters, softBreak + 1, ready);
        continue;
      }

      if (characters.length >= this.maxChars) {
        const preferredBreak = findPreferredBreak(
          characters,
          this.minSoftBreakChars,
          this.maxChars
        );
        this.release(characters, preferredBreak, ready);
        continue;
      }

      if (flush) {
        this.release(characters, characters.length, ready);
      }
      break;
    }
    return ready;
  }

  private release(characters: string[], count: number, ready: string[]): void {
    const segment = characters.slice(0, count).join("").trim();
    this.buffer = characters.slice(count).join("");
    if (segment) {
      ready.push(segment);
    }
  }
}

function findPreferredBreak(
  characters: string[],
  minimum: number,
  maximum: number
): number {
  for (let index = Math.min(maximum, characters.length) - 1; index >= minimum; index -= 1) {
    if (SOFT_BREAKS.has(characters[index]!) || /\s/u.test(characters[index]!)) {
      return index + 1;
    }
  }
  return Math.min(maximum, characters.length);
}
