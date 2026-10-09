export interface QuotaRules {
  perMinute: number;
  ceiling: number;
  heavyRatio: number;
  overMinutesToFlag: number;
  heavyMinutesToFlag: number;
  flagMinutes: number;
}

export type MinuteClass = 'over' | 'heavy';

export interface BucketSnapshot {
  windowStart: number;
  count: number;
  limit: number;
  flagged: boolean;
  flaggedUntil: number | null;
  overMinutes: number;
  heavyMinutes: number;
  history: { start: number; class: MinuteClass }[];
}

/** One per-minute quota with the owner's overage and flag rules. */
export class QuotaBucket {
  readonly rules: QuotaRules;
  readonly minuteMs: number;
  #windowStart = Number.NaN;
  #count = 0;
  #history: { start: number; class: MinuteClass }[] = [];
  #flaggedUntil: number | null = null;

  constructor(rules: QuotaRules, minuteMs: number) {
    this.rules = rules;
    this.minuteMs = minuteMs;
  }

  #roll(now: number): void {
    const start = Math.floor(now / this.minuteMs) * this.minuteMs;
    if (start === this.#windowStart) return;
    if (this.#count > 0) this.#close(this.#windowStart);
    this.#windowStart = start;
    this.#count = 0;
    if (this.#flaggedUntil !== null && now >= this.#flaggedUntil)
      this.#flaggedUntil = null;
  }

  #close(windowStart: number): void {
    const { perMinute, heavyRatio } = this.rules;
    const kind: MinuteClass | null =
      this.#count > perMinute * heavyRatio
        ? 'heavy'
        : this.#count > perMinute
          ? 'over'
          : null;
    if (kind) this.#history.push({ start: windowStart, class: kind });
    const horizon = windowStart - 59 * this.minuteMs;
    this.#history = this.#history.filter((entry) => entry.start >= horizon);
    if (this.#flaggedUntil !== null) return;
    const heavy = this.#history.filter(
      (entry) => entry.class === 'heavy',
    ).length;
    if (
      this.#history.length >= this.rules.overMinutesToFlag ||
      heavy >= this.rules.heavyMinutesToFlag
    )
      this.#flaggedUntil =
        windowStart + this.minuteMs + this.rules.flagMinutes * this.minuteMs;
  }

  #flagged(now: number): boolean {
    return this.#flaggedUntil !== null && now < this.#flaggedUntil;
  }

  #limit(now: number): number {
    return this.#flagged(now)
      ? this.rules.perMinute
      : Math.floor(this.rules.perMinute * this.rules.ceiling);
  }

  admit(now: number): boolean {
    this.#roll(now);
    if (this.#count >= this.#limit(now)) return false;
    this.#count++;
    return true;
  }

  retryAfterMs(now: number): number {
    this.#roll(now);
    return this.#windowStart + this.minuteMs - now;
  }

  snapshot(now: number): BucketSnapshot {
    this.#roll(now);
    return {
      windowStart: this.#windowStart,
      count: this.#count,
      limit: this.#limit(now),
      flagged: this.#flagged(now),
      flaggedUntil: this.#flagged(now) ? this.#flaggedUntil : null,
      overMinutes: this.#history.length,
      heavyMinutes: this.#history.filter((entry) => entry.class === 'heavy')
        .length,
      history: [...this.#history],
    };
  }
}
