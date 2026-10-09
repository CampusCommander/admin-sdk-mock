import type { DatabaseSync } from 'node:sqlite';
import type { Random } from '../random.ts';
import type { Layout } from './layout.ts';
import type { ResolvedSpec } from './spec.ts';

export interface SeedContext {
  spec: ResolvedSpec;
  layout: Layout;
  seededAt: number;
  db: DatabaseSync;
}

export const DAY_MS = 86_400_000;
export const YEAR_MS = 365.25 * DAY_MS;
export const HEX = '0123456789abcdef';

export const iso = (ms: number): string => new Date(ms).toISOString();

/** Lower-case letters and digits only, for email local parts. */
export const emailLocal = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Return a function that picks an index with probability proportional to its weight. */
export function weightedIndex(
  weights: readonly number[],
  random: Random,
): () => number {
  const cumulative: number[] = [];
  let total = 0;
  for (const weight of weights) {
    total += weight;
    cumulative.push(total);
  }
  return () => {
    const roll = random.next() * total;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cumulative[middle] > roll) high = middle;
      else low = middle + 1;
    }
    return low;
  };
}
