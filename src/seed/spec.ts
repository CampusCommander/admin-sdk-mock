import { createRandom } from '../random.ts';
import { PLACE_NAMES } from './names.ts';

export type Tier = 'small' | 'medium' | 'large' | 'xlarge';
export type LayoutFamily = 'role-first' | 'school-first';

export interface Counts {
  schools: number;
  students: number;
  staff: number;
  devices: number;
}

export interface Rates {
  disabled: number;
  deprovisioned: number;
  misplaced: number;
  unassigned: number;
  expired: number;
  suspended: number;
  deepBranches: number;
}

export interface SeedSpec {
  tier: Tier;
  seed: string;
  name?: string;
  layout?: LayoutFamily;
  counts?: Partial<Counts>;
  rates?: Partial<Rates>;
}

export interface ResolvedSpec {
  tier: Tier;
  seed: string;
  districtName: string;
  slug: string;
  customerId: string;
  primaryDomain: string;
  studentDomain: string;
  aliasDomain: string;
  layout: LayoutFamily;
  counts: Counts;
  rates: Rates;
}

export const TIERS: Readonly<Record<Tier, Counts>> = {
  small: { schools: 1, students: 500, staff: 60, devices: 600 },
  medium: { schools: 12, students: 6_000, staff: 700, devices: 7_000 },
  large: { schools: 60, students: 50_000, staff: 6_000, devices: 60_000 },
  xlarge: { schools: 640, students: 320_000, staff: 45_000, devices: 400_000 },
};

export const DEFAULT_RATES: Readonly<Rates> = {
  disabled: 0.02,
  deprovisioned: 0.05,
  misplaced: 0.02,
  unassigned: 0.15,
  expired: 0.15,
  suspended: 0.04,
  deepBranches: 3,
};

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecError';
  }
}

const FIELDS = ['tier', 'seed', 'name', 'layout', 'counts', 'rates'];
const SEED_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COUNT_LIMIT = 2_000_000;
const SCHOOL_LIMIT = 2_000;

function numbers(
  value: unknown,
  label: string,
  keys: readonly string[],
  valid: (number: number, key: string) => boolean,
): Record<string, number> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new SpecError(`${label} must be an object.`);
  const out: Record<string, number> = {};
  for (const [key, number] of Object.entries(value)) {
    if (!keys.includes(key))
      throw new SpecError(`Unknown ${label} field: ${key}.`);
    if (
      typeof number !== 'number' ||
      !Number.isFinite(number) ||
      !valid(number, key)
    )
      throw new SpecError(`${label}.${key} is outside its allowed range.`);
    out[key] = number;
  }
  return out;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'district';
}

/** Validate a seed specification and derive every identity value from it. */
export function resolveSpec(input: unknown): ResolvedSpec {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new SpecError('The seed specification must be an object.');
  const spec = input as Record<string, unknown>;
  for (const key of Object.keys(spec))
    if (!FIELDS.includes(key))
      throw new SpecError(`Unknown seed specification field: ${key}.`);
  const tier = spec.tier;
  if (typeof tier !== 'string' || !Object.hasOwn(TIERS, tier))
    throw new SpecError('tier must be small, medium, large, or xlarge.');
  const seed = spec.seed;
  if (typeof seed !== 'string' || !SEED_PATTERN.test(seed))
    throw new SpecError(
      'seed must be 1 to 64 letters, digits, hyphens, or underscores.',
    );
  const name = spec.name;
  if (
    name !== undefined &&
    (typeof name !== 'string' || name.trim() === '' || name.length > 60)
  )
    throw new SpecError('name must be 1 to 60 characters.');
  const layoutInput = spec.layout;
  if (
    layoutInput !== undefined &&
    layoutInput !== 'role-first' &&
    layoutInput !== 'school-first'
  )
    throw new SpecError('layout must be role-first or school-first.');

  const counts = {
    ...TIERS[tier as Tier],
    ...numbers(
      spec.counts,
      'counts',
      ['schools', 'students', 'staff', 'devices'],
      (number) =>
        Number.isInteger(number) && number >= 1 && number <= COUNT_LIMIT,
    ),
  } as Counts;
  if (counts.schools > SCHOOL_LIMIT)
    throw new SpecError(`counts.schools must be ${SCHOOL_LIMIT} or less.`);
  const rates = {
    ...DEFAULT_RATES,
    ...numbers(
      spec.rates,
      'rates',
      Object.keys(DEFAULT_RATES),
      (number, key) =>
        key === 'deepBranches'
          ? Number.isInteger(number) && number >= 0 && number <= 20
          : number >= 0 && number <= 1,
    ),
  } as Rates;
  if (rates.disabled + rates.deprovisioned > 1)
    throw new SpecError(
      'rates.disabled plus rates.deprovisioned must be 1 or less.',
    );

  const random = createRandom(`spec/${seed}`);
  const districtName =
    (name as string | undefined)?.trim() ??
    `${random.fork('place').pick(PLACE_NAMES)} ${random
      .fork('suffix')
      .pick([
        'School District',
        'Unified School District',
        'Public Schools',
        'Community Schools',
      ])}`;
  const slug = slugify(districtName);
  const primaryDomain = `${slug}.test`;
  return {
    tier: tier as Tier,
    seed,
    districtName,
    slug,
    customerId: `C0${random.fork('customer').string(7)}`,
    primaryDomain,
    studentDomain: random.fork('student-domain').chance(0.5)
      ? `students.${slug}.test`
      : primaryDomain,
    aliasDomain: `${slug}-k12.test`,
    layout:
      (layoutInput as LayoutFamily | undefined) ??
      random.fork('layout').pick<LayoutFamily>(['role-first', 'school-first']),
    counts,
    rates,
  };
}
