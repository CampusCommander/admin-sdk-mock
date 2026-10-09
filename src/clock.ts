/** Time source. Tests replace it with a fake clock. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Global time compression. `scale` divides every window, penalty, and delay. */
export interface Timing {
  scale: number;
  delays: boolean;
}

export class TimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimingError';
  }
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    ms <= 0
      ? Promise.resolve()
      : new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface FakeClock extends Clock {
  advance(ms: number): Promise<void>;
  pending(): number;
}

export function fakeClock(start = Date.UTC(2026, 9, 9, 12)): FakeClock {
  let time = start;
  const timers: { at: number; resolve: () => void }[] = [];
  return {
    now: () => time,
    sleep(ms) {
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        timers.push({ at: time + ms, resolve });
      });
    },
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        time = next.at;
        next.resolve();
        await new Promise((resolve) => setImmediate(resolve));
      }
      time = target;
    },
    pending: () => timers.length,
  };
}

export const MAX_SCALE = 100_000;

/** Read the time scale and the delay switch from environment strings. */
export function parseTiming(
  scale: string | undefined,
  delays: string | undefined,
): Timing {
  const parsedScale = scale === undefined || scale === '' ? 1 : Number(scale);
  if (
    !Number.isFinite(parsedScale) ||
    parsedScale < 1 ||
    parsedScale > MAX_SCALE
  )
    throw new TimingError(`The time scale must be from 1 to ${MAX_SCALE}.`);
  const value = (delays ?? 'on').toLowerCase();
  if (!['on', 'off', 'true', 'false', '1', '0'].includes(value))
    throw new TimingError('The delay switch must be on or off.');
  return {
    scale: parsedScale,
    delays: ['on', 'true', '1'].includes(value),
  };
}
