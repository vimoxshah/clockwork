/**
 * Injectable clock (fake-clock harness, stack #16). All time flows through
 * here so the scheduler fixture suite can time-travel across DST deterministically.
 */
export interface Clock {
  now(): number; // epoch ms
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FakeClock implements Clock {
  private t: number;
  constructor(startEpochMs: number) {
    this.t = startEpochMs;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  setTo(ms: number): void {
    this.t = ms;
  }
}
