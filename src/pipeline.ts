import type { ApiResponse, Call } from './http/types.ts';

export type Admission =
  { ok: true; release(): void } | { ok: false; response: ApiResponse };

/** The three stages around a handler. Faults, quota, and latency fill them in. */
export interface Pipeline {
  before(call: Call): Promise<ApiResponse | 'reset' | undefined>;
  admit(call: Call): Admission;
  delay(call: Call, response: ApiResponse): Promise<void>;
}

export function openPipeline(): Pipeline {
  return {
    before: async () => undefined,
    admit: () => ({ ok: true, release() {} }),
    delay: async () => {},
  };
}
