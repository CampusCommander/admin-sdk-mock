/** A deterministic random stream. The same seed always yields the same sequence. */
export interface Random {
  readonly seed: string;
  /** A number in [0, 1). */
  next(): number;
  /** A whole number in [min, max], inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  chance(probability: number): boolean;
  /** A standard normal draw. */
  normal(): number;
  string(length: number, alphabet?: string): string;
  uuid(): string;
  /** An independent stream that depends only on this seed and the label. */
  fork(label: string): Random;
}

const LOWER_ALNUM = '0123456789abcdefghijklmnopqrstuvwxyz';
const HEX = '0123456789abcdef';

function cyrb128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function createRandom(seed: string): Random {
  const next = sfc32(...cyrb128(seed));
  const random: Random = {
    seed,
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(items) {
      if (items.length === 0)
        throw new RangeError('pick() needs at least one item.');
      return items[Math.floor(next() * items.length)];
    },
    weighted(entries) {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [value, weight] of entries) {
        roll -= weight;
        if (roll < 0) return value;
      }
      for (let i = entries.length - 1; i >= 0; i--)
        if (entries[i][1] > 0) return entries[i][0];
      throw new RangeError('weighted() needs a positive weight.');
    },
    chance(probability) {
      return next() < probability;
    },
    normal() {
      const u = 1 - next();
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    string(length, alphabet = LOWER_ALNUM) {
      let out = '';
      for (let i = 0; i < length; i++)
        out += alphabet[Math.floor(next() * alphabet.length)];
      return out;
    },
    uuid() {
      const h = random.string(32, HEX);
      const variant = '89ab'[Math.floor(next() * 4)];
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
    },
    fork(label) {
      return createRandom(`${seed}/${label}`);
    },
  };
  return random;
}
