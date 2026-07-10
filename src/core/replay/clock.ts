import type {
  ReplayClockSnapshot,
  ReplayRecord,
  ReplayState,
  ReplayTimerDriver,
} from "./types";

const browserTimer: ReplayTimerDriver = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

export interface ReplayClockOptions {
  speed?: number;
  timer?: ReplayTimerDriver;
  onRecord(record: ReplayRecord, index: number): void;
  onStateChange?(snapshot: ReplayClockSnapshot): void;
}

export class ReplayClock {
  private index = 0;
  private state: ReplayState = "idle";
  private speed: number;
  private handle: unknown;
  private scheduledAtMs = 0;
  private scheduledDelayMs = 0;
  private readonly timer: ReplayTimerDriver;

  constructor(
    private readonly records: readonly ReplayRecord[],
    private readonly options: ReplayClockOptions,
  ) {
    this.speed = options.speed ?? 1;
    this.assertSpeed(this.speed);
    this.timer = options.timer ?? browserTimer;
  }

  get snapshot(): ReplayClockSnapshot {
    return { state: this.state, index: this.index, length: this.records.length, speed: this.speed };
  }

  play(): void {
    if (this.state === "playing") return;
    if (this.index >= this.records.length) this.index = 0;
    if (this.records.length === 0) {
      this.setState("finished");
      return;
    }
    this.setState("playing");
    this.schedule(0);
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.cancelTimer();
    this.setState("paused");
  }

  stop(): void {
    this.cancelTimer();
    this.index = 0;
    this.setState("idle");
  }

  step(): ReplayRecord | undefined {
    if (this.state === "playing") this.pause();
    const record = this.records[this.index];
    if (!record) {
      this.setState("finished");
      return undefined;
    }
    const emittedIndex = this.index;
    this.index += 1;
    this.options.onRecord(record, emittedIndex);
    this.setState(this.index >= this.records.length ? "finished" : "paused");
    return record;
  }

  seek(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > this.records.length) {
      throw new Error(`Replay index out of range: ${index}`);
    }
    const wasPlaying = this.state === "playing";
    this.cancelTimer();
    this.index = index;
    this.setState(index >= this.records.length ? "finished" : wasPlaying ? "playing" : "paused");
    if (wasPlaying && index < this.records.length) this.schedule(0);
  }

  setSpeed(speed: number): void {
    this.assertSpeed(speed);
    if (speed === this.speed) return;
    if (this.state === "playing" && this.handle !== undefined) {
      const elapsed = Math.max(0, this.timer.now() - this.scheduledAtMs);
      const remainingSourceMs = Math.max(0, (this.scheduledDelayMs - elapsed) * this.speed);
      this.speed = speed;
      this.cancelTimer();
      this.schedule(remainingSourceMs / speed);
    } else {
      this.speed = speed;
      this.emitState();
    }
  }

  private schedule(delayMs: number): void {
    this.scheduledAtMs = this.timer.now();
    this.scheduledDelayMs = Math.max(0, delayMs);
    this.handle = this.timer.setTimeout(() => {
      this.handle = undefined;
      this.emitNext();
    }, this.scheduledDelayMs);
  }

  private emitNext(): void {
    if (this.state !== "playing") return;
    const record = this.records[this.index];
    if (!record) {
      this.setState("finished");
      return;
    }
    const emittedIndex = this.index;
    this.index += 1;
    this.options.onRecord(record, emittedIndex);
    if (this.index >= this.records.length) {
      this.setState("finished");
      return;
    }
    const nextRecord = this.records[this.index];
    if (!nextRecord) {
      this.setState("finished");
      return;
    }
    const sourceDelay = Math.max(0, nextRecord.offsetMs - record.offsetMs);
    this.schedule(sourceDelay / this.speed);
  }

  private cancelTimer(): void {
    if (this.handle !== undefined) this.timer.clearTimeout(this.handle);
    this.handle = undefined;
  }

  private setState(state: ReplayState): void {
    this.state = state;
    this.emitState();
  }

  private emitState(): void {
    this.options.onStateChange?.(this.snapshot);
  }

  private assertSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("Replay speed must be positive");
  }
}
