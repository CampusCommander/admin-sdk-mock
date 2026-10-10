import { createRandom, type Random } from '../random.ts';
import {
  newGroupId,
  type Delivery,
  type MemberRole,
  type MemberType,
} from '../store/group-lookup.ts';
import { rows } from '../store/sqlite.ts';
import { DAY_MS, type SeedContext } from './context.ts';
import { CLUBS } from './courses.ts';
import { seedGroupScenarios } from './group-scenarios.ts';
import type { School } from './layout.ts';

export interface GroupSeedResult {
  groups: number;
  memberships: number;
}

/** One seeded user, as the group seed reads it back from the users table. */
export interface SeedUser {
  id: string;
  email: string;
  ou: string;
  role: 'student' | 'staff' | 'admin';
  school: number | null;
  family: string;
}

export type GroupKind =
  | 'staff'
  | 'grade'
  | 'students'
  | 'school'
  | 'club'
  | 'region'
  | 'district'
  | 'section'
  | 'parents'
  | 'board'
  | 'chain'
  | 'empty';

/** One seeded group and the facts that later families read. */
export interface SeededGroup {
  id: string;
  email: string;
  createdAt: number;
  kind: GroupKind;
  members: number;
  outside: boolean;
}

export interface MemberTargetSeed {
  id: string;
  email: string;
  type: MemberType;
}

export interface GradeGroups {
  group: SeededGroup;
  grade: number;
  students: SeedUser[];
}

export interface SchoolGroups {
  school: School;
  base: string;
  staff: SeedUser[];
  staffGroup: SeededGroup;
  /** The owner of the staff group, or null for a school without staff. */
  owner: SeedUser | null;
  grades: GradeGroups[];
  studentsGroup: SeededGroup;
  clubs: SeededGroup[];
}

const DELIVERY: readonly (readonly [Delivery, number])[] = [
  ['ALL_MAIL', 0.85],
  ['DIGEST', 0.07],
  ['DAILY', 0.04],
  ['NONE', 0.04],
];

/** Lower-case words joined by hyphens, for group email local parts. */
export const groupSlug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'group';

/** Pick `count` distinct items in random order. */
export function sample<T>(
  random: Random,
  items: readonly T[],
  count: number,
): T[] {
  const pool = [...items];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = random.int(i, pool.length - 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export const asUser = (user: SeedUser): MemberTargetSeed => ({
  id: user.id,
  email: user.email,
  type: 'USER',
});

export const asGroup = (group: SeededGroup): MemberTargetSeed => ({
  id: group.id,
  email: group.email,
  type: 'GROUP',
});

/** Insert groups and memberships, and keep every address and ID unique. */
function groupWriter(ctx: SeedContext, random: Random) {
  const { db, seededAt, spec } = ctx;
  const taken = new Set<string>(
    rows<{ address: string }>(
      db
        .prepare(
          'SELECT primary_email AS address FROM users UNION ALL SELECT alias FROM user_aliases',
        )
        .all(),
    ).map((entry) => entry.address),
  );
  const ids = new Set<string>();
  const groups: SeededGroup[] = [];
  let memberships = 0;
  const insertGroup = db.prepare(
    'INSERT INTO groups (id, email, name, description, admin_created, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertMember = db.prepare(
    'INSERT INTO group_members (group_id, member_id, email, type, role, delivery, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const timing = random.fork('times');
  const delivery = random.fork('delivery');

  /** Reserve a unique address. A taken local part gains `-2`, `-3`, and so on. */
  const address = (local: string, domain: string): string => {
    let candidate = `${local}@${domain}`;
    for (let n = 2; taken.has(candidate); n++)
      candidate = `${local}-${n}@${domain}`;
    taken.add(candidate);
    return candidate;
  };

  const create = (input: {
    local: string;
    domain: string;
    name: string;
    description: string;
    kind: GroupKind;
    adminCreated?: boolean;
  }): SeededGroup => {
    const email = address(input.local, input.domain);
    const id = newGroupId(
      createRandom(`group/${spec.seed}/${email}`),
      (candidate) => ids.has(candidate),
    );
    ids.add(id);
    const createdAt = seededAt - timing.int(30, 3000) * DAY_MS;
    insertGroup.run(
      id,
      email,
      input.name,
      input.description,
      input.adminCreated === false ? 0 : 1,
      createdAt,
    );
    const group: SeededGroup = {
      id,
      email,
      createdAt,
      kind: input.kind,
      members: 0,
      outside: false,
    };
    groups.push(group);
    return group;
  };

  /** Add one direct member. Membership times fall within 20 days of the group's creation. */
  const add = (
    group: SeededGroup,
    target: MemberTargetSeed,
    role: MemberRole = 'MEMBER',
    outside = false,
  ): void => {
    insertMember.run(
      group.id,
      target.id,
      target.email,
      target.type,
      role,
      delivery.weighted(DELIVERY),
      group.createdAt + timing.int(0, 20) * DAY_MS,
    );
    group.members++;
    if (outside) group.outside = true;
    memberships++;
  };

  return { groups, address, create, add, memberships: () => memberships };
}

export type GroupWriter = ReturnType<typeof groupWriter>;

/** The student OU that holds `ou`, or null when `ou` sits outside every student OU. */
function gradeOu(
  ou: string,
  grades: ReadonlyMap<string, unknown>,
): string | null {
  for (
    let path = ou;
    path.length > 1;
    path = path.slice(0, path.lastIndexOf('/')) || '/'
  )
    if (grades.has(path)) return path;
  return null;
}

/** Insert every seeded group. Runs after users. The caller owns the transaction. */
export function seedGroups(ctx: SeedContext): GroupSeedResult {
  const { spec, layout, db } = ctx;
  const random = createRandom(`groups/${spec.seed}`);
  const writer = groupWriter(ctx, random.fork('writer'));
  const users = rows<SeedUser>(
    db
      .prepare(
        'SELECT id, primary_email AS email, org_unit_path AS ou, role, school, family_name AS family FROM users ORDER BY ord',
      )
      .all(),
  );

  const grades = new Map<string, true>();
  for (const school of layout.schools)
    for (const grade of school.grades)
      grades.set(school.studentOus[grade], true);
  const studentsByOu = new Map<string, SeedUser[]>();
  const staffBySchool: SeedUser[][] = layout.schools.map(() => []);
  const districtStaff: SeedUser[] = [];
  const admins: SeedUser[] = [];
  for (const user of users) {
    if (user.role === 'student') {
      const ou = gradeOu(user.ou, grades);
      if (ou) studentsByOu.set(ou, [...(studentsByOu.get(ou) ?? []), user]);
    } else if (user.role === 'admin') {
      admins.push(user);
      districtStaff.push(user);
    } else if (user.school === null) districtStaff.push(user);
    else staffBySchool[user.school].push(user);
  }

  const schools: SchoolGroups[] = layout.schools.map((school) => {
    const pick = random.fork(`school/${school.index}`);
    const base = groupSlug(school.name);
    const staff = staffBySchool[school.index];
    const staffGroup = writer.create({
      local: `${base}-staff`,
      domain: spec.primaryDomain,
      name: `${school.name} Staff`,
      description: `All staff at ${school.name}`,
      kind: 'staff',
    });
    const owner = staff.length > 0 ? pick.int(0, staff.length - 1) : -1;
    const managers = new Set<number>();
    const managerCount = Math.min(pick.int(1, 2), staff.length - 1);
    while (managers.size < managerCount) {
      const n = pick.int(0, staff.length - 1);
      if (n !== owner) managers.add(n);
    }
    staff.forEach((user, n) =>
      writer.add(
        staffGroup,
        asUser(user),
        n === owner ? 'OWNER' : managers.has(n) ? 'MANAGER' : 'MEMBER',
      ),
    );

    const gradeGroups: GradeGroups[] = [];
    for (const grade of school.grades) {
      const ou = school.studentOus[grade];
      const students = studentsByOu.get(ou) ?? [];
      if (students.length === 0) continue;
      const leaf = ou.slice(ou.lastIndexOf('/') + 1);
      const group = writer.create({
        local: `${base}-${groupSlug(leaf)}`,
        domain: spec.studentDomain,
        name: `${school.name} ${leaf}`,
        description: `Students in ${leaf} at ${school.name}`,
        kind: 'grade',
      });
      for (const student of students) writer.add(group, asUser(student));
      gradeGroups.push({ group, grade, students });
    }

    const studentsGroup = writer.create({
      local: `${base}-students`,
      domain: spec.studentDomain,
      name: `${school.name} Students`,
      description: `All students at ${school.name}`,
      kind: 'students',
    });
    for (const { group } of gradeGroups)
      writer.add(studentsGroup, asGroup(group));
    const everyone = writer.create({
      local: `${base}-all`,
      domain: spec.primaryDomain,
      name: `${school.name} Everyone`,
      description: `Staff and students at ${school.name}`,
      kind: 'school',
    });
    writer.add(everyone, asGroup(staffGroup));
    writer.add(everyone, asGroup(studentsGroup));

    const schoolStudents = gradeGroups.flatMap((entry) => entry.students);
    const clubs: SeededGroup[] = [];
    for (let n = pick.int(1, 3); n > 0; n--) {
      const club = pick.pick(CLUBS);
      const group = writer.create({
        local: `${groupSlug(club)}-${base}`,
        domain: spec.studentDomain,
        name: `${school.name} ${club}`,
        description: `${club} at ${school.name}`,
        kind: 'club',
        adminCreated: false,
      });
      sample(pick, staff, pick.int(1, 4)).forEach((user, k) =>
        writer.add(
          group,
          asUser(user),
          k === 0 ? 'OWNER' : k === 1 ? 'MANAGER' : 'MEMBER',
        ),
      );
      for (const student of sample(pick, schoolStudents, pick.int(8, 30)))
        writer.add(group, asUser(student));
      clubs.push(group);
    }
    return {
      school,
      base,
      staff,
      staffGroup,
      owner: owner >= 0 ? staff[owner] : null,
      grades: gradeGroups,
      studentsGroup,
      clubs,
    };
  });

  const primary = spec.primaryDomain;
  const allStaff = writer.create({
    local: 'all-staff',
    domain: primary,
    name: 'All Staff',
    description: `Every staff member of ${spec.districtName}`,
    kind: 'district',
  });
  for (const user of districtStaff) writer.add(allStaff, asUser(user));
  const regions = new Map<string, SeededGroup>();
  for (const entry of schools) {
    const region = entry.school.region;
    if (region === null) {
      writer.add(allStaff, asGroup(entry.staffGroup));
      continue;
    }
    let group = regions.get(region);
    if (!group) {
      group = writer.create({
        local: `${groupSlug(region)}-staff`,
        domain: primary,
        name: `${region} Staff`,
        description: `Staff of the schools in ${region}`,
        kind: 'region',
      });
      regions.set(region, group);
      writer.add(allStaff, asGroup(group));
    }
    writer.add(group, asGroup(entry.staffGroup));
  }
  const allStudents = writer.create({
    local: 'all-students',
    domain: primary,
    name: 'All Students',
    description: `Every student of ${spec.districtName}`,
    kind: 'district',
  });
  for (const entry of schools)
    writer.add(allStudents, asGroup(entry.studentsGroup));
  const everyone = writer.create({
    local: 'everyone',
    domain: primary,
    name: 'Everyone',
    description: `Every user of ${spec.districtName}`,
    kind: 'district',
  });
  writer.add(everyone, { id: spec.customerId, email: '', type: 'CUSTOMER' });
  const tech = writer.create({
    local: 'tech-team',
    domain: primary,
    name: 'Technology Team',
    description: 'District technology administrators',
    kind: 'district',
  });
  admins.forEach((user, n) =>
    writer.add(tech, asUser(user), n === 0 ? 'OWNER' : 'MEMBER'),
  );
  const principals = writer.create({
    local: 'principals',
    domain: primary,
    name: 'Principals',
    description: 'The lead of each school',
    kind: 'district',
  });
  for (const entry of schools)
    if (entry.owner) writer.add(principals, asUser(entry.owner));

  seedGroupScenarios({
    ctx,
    random: random.fork('scenarios'),
    writer,
    schools,
    admins,
    districtStaff,
  });

  return { groups: writer.groups.length, memberships: writer.memberships() };
}
