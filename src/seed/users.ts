import { createRandom } from '../random.ts';
import {
  DAY_MS,
  emailLocal,
  weightedIndex,
  type SeedContext,
} from './context.ts';
import { GRADUATION_BASE_YEAR } from './layout.ts';
import { FIRST_NAMES, LAST_NAMES } from './names.ts';

export interface UserIndex {
  /** Student addresses per school index. */
  students: string[][];
  /** Staff addresses per school index. */
  staff: string[][];
  districtStaff: string[];
  adminEmail: string;
}

type StudentStyle = 'first.last' | 'initial-last-year' | 'student-id';

const ADMINS = [
  ['Admin', 'Account', 'admin'],
  ['Technology', 'Director', 'technology.director'],
  ['Help', 'Desk', 'helpdesk'],
] as const;

/** Insert administrators, staff, and students. The caller owns the transaction. */
export function seedUsers(ctx: SeedContext): UserIndex {
  const { spec, layout, seededAt, db } = ctx;
  const random = createRandom(`users/${spec.seed}`);
  const studentStyle = random.pick<StudentStyle>([
    'first.last',
    'initial-last-year',
    'student-id',
  ]);
  const insert = db.prepare(
    'INSERT INTO users (id, primary_email, given_name, family_name, full_name, org_unit_path, is_admin, suspended, suspension_reason, external_id, role, school, creation_time, last_login_time, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertAlias = db.prepare(
    'INSERT INTO user_aliases (alias, user_id) VALUES (?, ?)',
  );
  const ids = new Set<string>();
  const locals = new Map<string, Set<string>>();
  let ord = 0;

  const address = (domain: string, local: string): string => {
    let used = locals.get(domain);
    if (!used) locals.set(domain, (used = new Set()));
    let candidate = local;
    for (let n = 2; used.has(candidate); n++) candidate = `${local}${n}`;
    used.add(candidate);
    return `${candidate}@${domain}`;
  };
  const newId = (): string => {
    let id: string;
    do id = `1${random.string(20, '0123456789')}`;
    while (ids.has(id));
    ids.add(id);
    return id;
  };
  const lastLogin = (suspended: boolean): number | null =>
    suspended
      ? seededAt - random.int(60, 720) * DAY_MS
      : random.chance(0.9)
        ? seededAt - random.int(0, 14 * DAY_MS)
        : null;
  const add = (user: {
    email: string;
    given: string;
    family: string;
    ou: string;
    admin: boolean;
    suspended: boolean;
    externalId: string | null;
    role: 'student' | 'staff' | 'admin';
    school: number | null;
    createdDaysAgo: number;
  }): string => {
    const id = newId();
    insert.run(
      id,
      user.email,
      user.given,
      user.family,
      `${user.given} ${user.family}`,
      user.ou,
      user.admin ? 1 : 0,
      user.suspended ? 1 : 0,
      user.suspended ? 'ADMIN' : null,
      user.externalId,
      user.role,
      user.school,
      seededAt - user.createdDaysAgo * DAY_MS,
      lastLogin(user.suspended),
      ord++,
    );
    return id;
  };

  const students: string[][] = layout.schools.map(() => []);
  const staff: string[][] = layout.schools.map(() => []);
  const districtStaff: string[] = [];

  for (const [given, family, local] of ADMINS) {
    const email = address(spec.primaryDomain, local);
    add({
      email,
      given,
      family,
      ou: layout.districtStaffOu,
      admin: true,
      suspended: false,
      externalId: null,
      role: 'admin',
      school: null,
      createdDaysAgo: random.int(1000, 3000),
    });
    districtStaff.push(email);
  }

  const chooseSchool = weightedIndex(
    layout.schools.map((school) => school.weight),
    random.fork('school'),
  );
  const deepUserOu = () =>
    layout.deepUserOus.length > 0 && random.chance(0.02)
      ? random.pick(layout.deepUserOus)
      : null;

  for (let i = 0; i < spec.counts.staff; i++) {
    const given = random.pick(FIRST_NAMES);
    const family = random.pick(LAST_NAMES);
    const district = random.chance(0.08);
    const school = district ? null : layout.schools[chooseSchool()];
    const email = address(
      spec.primaryDomain,
      `${emailLocal(given)}.${emailLocal(family)}`,
    );
    const id = add({
      email,
      given,
      family,
      ou: deepUserOu() ?? school?.staffOu ?? layout.districtStaffOu,
      admin: false,
      suspended: random.chance(spec.rates.suspended),
      externalId: `E${100_000 + i}`,
      role: 'staff',
      school: school?.index ?? null,
      createdDaysAgo: random.int(30, 3650),
    });
    (school ? staff[school.index] : districtStaff).push(email);
    if (random.chance(0.05))
      insertAlias.run(
        address(
          spec.primaryDomain,
          `${emailLocal(given).slice(0, 1)}${emailLocal(family)}`,
        ),
        id,
      );
  }

  for (let i = 0; i < spec.counts.students; i++) {
    const given = random.pick(FIRST_NAMES);
    const family = random.pick(LAST_NAMES);
    const school = layout.schools[chooseSchool()];
    const grade = random.pick(school.grades);
    const externalId = String(200_000_000 + i);
    const year = String(GRADUATION_BASE_YEAR + 12 - grade).slice(2);
    const local =
      studentStyle === 'first.last'
        ? `${emailLocal(given)}.${emailLocal(family)}`
        : studentStyle === 'initial-last-year'
          ? `${emailLocal(given).slice(0, 1)}${emailLocal(family)}${year}`
          : externalId;
    const email = address(spec.studentDomain, local);
    add({
      email,
      given,
      family,
      ou: deepUserOu() ?? school.studentOus[grade],
      admin: false,
      suspended: random.chance(spec.rates.suspended),
      externalId,
      role: 'student',
      school: school.index,
      createdDaysAgo: random.int(30, (grade + 1) * 365),
    });
    students[school.index].push(email);
  }

  return {
    students,
    staff,
    districtStaff,
    adminEmail: `admin@${spec.primaryDomain}`,
  };
}
