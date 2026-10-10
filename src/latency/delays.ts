import type { Clock, Timing } from '../clock.ts';
import type { ApiResponse, Call } from '../http/types.ts';
import type { Limits } from '../quota/limits.ts';
import type { Random } from '../random.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { computeDelayMs } from './model.ts';

export interface Delays {
  delay(call: Call, response: ApiResponse): Promise<void>;
}

export function createDelays(deps: {
  clock: Clock;
  timing: Timing;
  random: Random;
  limits: Limits;
}): Delays {
  return {
    async delay(call, response) {
      if (!deps.timing.delays || call.batchPart) return;
      const settings =
        call.domain?.record.settings.latency ?? DEFAULT_SETTINGS.latency;
      const ms = computeDelayMs(
        {
          api: call.route.api,
          bytes: Buffer.byteLength(response.raw ?? ''),
          items: response.items ?? 0,
          scanned: response.scanned ?? 0,
          inFlight: call.access
            ? deps.limits.inFlight(call.access.customerId)
            : 0,
          parts: call.route.api === 'batch' ? (response.items ?? 0) : 0,
          write: call.route.write === true,
        },
        settings,
        deps.random,
      );
      await deps.clock.sleep(ms / deps.timing.scale);
    },
  };
}
