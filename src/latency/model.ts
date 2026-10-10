import type { Api } from '../http/types.ts';
import type { Random } from '../random.ts';
import type { LatencySettings } from '../settings.ts';

export interface DelayInput {
  api: Api;
  /** A write uses the write base and the per-device cost. */
  write?: boolean;
  bytes: number;
  items: number;
  scanned: number;
  inFlight: number;
  parts: number;
}

/** z for the 99th percentile of a standard normal distribution. */
const Z99 = 2.326;

/** The modeled response time in unscaled milliseconds. */
export function computeDelayMs(
  input: DelayInput,
  settings: LatencySettings,
  random: Random,
): number {
  const sigma =
    Math.log(settings.roundTripP99Ms / settings.roundTripMedianMs) / Z99;
  const roundTrip = Math.min(
    settings.roundTripMedianMs * Math.exp(sigma * random.normal()),
    settings.roundTripP99Ms * 2,
  );
  const transfer = (input.bytes / settings.bytesPerSecond) * 1000;
  const compute =
    input.api === 'batch'
      ? settings.baseMs +
        Math.ceil(input.parts / settings.batchParallelism) *
          settings.batchPartMs
      : input.api === 'oauth'
        ? 30
        : input.write
          ? settings.writeBaseMs +
            settings.perDeviceWriteMs * input.items +
            (settings.scanPer10kRowsMs * input.scanned) / 10_000
          : settings.baseMs +
            settings.perItemMs * input.items +
            (settings.scanPer10kRowsMs * input.scanned) / 10_000;
  const base = Math.min(roundTrip + transfer + compute, settings.capMs);
  const load =
    1 +
    (Math.max(0, input.inFlight - settings.loadThreshold) *
      settings.loadPercentPerRequest) /
      100;
  return base * load;
}
