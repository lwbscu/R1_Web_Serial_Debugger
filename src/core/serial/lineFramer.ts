export interface FramedLine {
  line: string;
  warnings: string[];
}

export interface LineFramerOptions {
  maxBufferBytes?: number;
}

const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024;
const DEBUG_MARKER = /(?:RDBG_CFG|RDBG_CMD|RDBG|CDBG_BOOT|CDBG|CEVT),/g;

/** Incrementally turns arbitrary serial byte chunks into CR/LF-delimited lines. */
export class LineFramer {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly maxBufferBytes: number;
  private buffer = "";
  private pendingWarnings: string[] = [];

  constructor(options: LineFramerOptions = {}) {
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    if (!Number.isInteger(this.maxBufferBytes) || this.maxBufferBytes < 1) {
      throw new RangeError("maxBufferBytes must be a positive integer");
    }
  }

  push(chunk: Uint8Array): FramedLine[] {
    if (chunk.byteLength === 0) return [];
    const decoded = this.decoder.decode(chunk, { stream: true });
    if (decoded.includes("\uFFFD")) this.addWarning("invalid_utf8");
    this.buffer += decoded;
    this.enforceLimit();
    return [...this.drainCompleteLines(), ...this.drainDebugMarkerFrames()];
  }

  flush(): FramedLine[] {
    const tail = this.decoder.decode();
    if (tail.includes("\uFFFD")) this.addWarning("invalid_utf8");
    this.buffer += tail;
    this.enforceLimit();
    const lines = this.drainCompleteLines();
    if (this.buffer.length > 0) {
      lines.push(...this.splitCompletedLine(this.buffer));
      this.buffer = "";
    }
    return lines;
  }

  reset(): void {
    this.decoder.decode();
    this.buffer = "";
    this.pendingWarnings = [];
  }

  private drainCompleteLines(): FramedLine[] {
    const output: FramedLine[] = [];
    let start = 0;
    for (let index = 0; index < this.buffer.length; index += 1) {
      const char = this.buffer[index];
      if (char !== "\r" && char !== "\n") continue;
      output.push(...this.splitCompletedLine(this.buffer.slice(start, index)));
      if (char === "\r" && this.buffer[index + 1] === "\n") index += 1;
      start = index + 1;
    }
    this.buffer = this.buffer.slice(start);
    return output;
  }

  private splitCompletedLine(line: string): FramedLine[] {
    let clean = line;
    let matches = [...clean.matchAll(DEBUG_MARKER)];
    if (matches.length === 0) return [this.takeLine(clean)];
    const first = matches[0]!.index ?? 0;
    if (first > 0) {
      clean = clean.slice(first);
      this.addWarning("discarded_prefix");
      matches = [...clean.matchAll(DEBUG_MARKER)];
    }
    return matches.map((match, index) => {
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? clean.length;
      return this.takeLine(clean.slice(start, end));
    });
  }

  /** Recovers adjacent debug frames even when firmware omitted a line ending. */
  private drainDebugMarkerFrames(): FramedLine[] {
    const output: FramedLine[] = [];
    while (true) {
      const matches = [...this.buffer.matchAll(DEBUG_MARKER)];
      if (matches.length === 0) return output;
      const first = matches[0]!.index ?? 0;
      if (first > 0) {
        this.buffer = this.buffer.slice(first);
        this.addWarning("discarded_prefix");
        continue;
      }
      if (matches.length < 2) return output;
      const next = matches[1]!.index;
      if (next === undefined || next <= 0) return output;
      output.push(this.takeLine(this.buffer.slice(0, next)));
      this.buffer = this.buffer.slice(next);
    }
  }

  private enforceLimit(): void {
    const bytes = new TextEncoder().encode(this.buffer);
    if (bytes.byteLength <= this.maxBufferBytes) return;
    const retained = bytes.slice(bytes.byteLength - this.maxBufferBytes);
    this.buffer = new TextDecoder("utf-8", { fatal: false }).decode(retained);
    this.addWarning("buffer_overflow");
  }

  private addWarning(warning: string): void {
    if (!this.pendingWarnings.includes(warning)) this.pendingWarnings.push(warning);
  }

  private takeLine(line: string): FramedLine {
    const warnings = this.pendingWarnings;
    this.pendingWarnings = [];
    return { line: line.replace(/^\uFEFF/, "").replace(/\0/g, ""), warnings };
  }
}
