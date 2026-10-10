import type { Random } from '../random.ts';
import { outsideMemberId } from '../store/group-lookup.ts';
import { emailLocal, type SeedContext } from './context.ts';
import { coursesFor, OUTSIDE_DOMAINS } from './courses.ts';
import {
  asGroup,
  asUser,
  groupSlug,
  sample,
  type GroupWriter,
  type MemberTargetSeed,
  type SchoolGroups,
  type SeededGroup,
  type SeedUser,
} from './groups.ts';
import { FIRST_NAMES, LAST_NAMES } from './names.ts';

export interface ScenarioInput {
  ctx: SeedContext;
  random: Random;
  writer: GroupWriter;
  schools: SchoolGroups[];
  admins: SeedUser[];
  districtStaff: SeedUser[];
}

/** Sections hold about 25 students. */
const SECTION_SIZE = 25;

/** A source of unique outside addresses, such as `ann.lee42@homemail.test`. */
function outsideAddresses(random: Random): () => MemberTargetSeed {
  const used = new Set<string>();
  return () => {
    for (;;) {
      const email = `${emailLocal(random.pick(FIRST_NAMES))}.${emailLocal(random.pick(LAST_NAMES))}${random.int(1, 99)}@${random.pick(OUTSIDE_DOMAINS)}`;
      if (used.has(email)) continue;
      used.add(email);
      return { id: outsideMemberId(email), email, type: 'USER' };
    }
  };
}

function seedSections({
  ctx,
  random,
  writer,
  schools,
  districtStaff,
}: ScenarioInput): void {
  const perStudent = ctx.spec.rates.sectionsPerStudent;
  if (perStudent === 0) return;
  const pick = random.fork('sections');
  for (const entry of schools) {
    const teachers = entry.staff.length > 0 ? entry.staff : districtStaff;
    for (const { grade, students } of entry.grades) {
      const count = Math.ceil((students.length * perStudent) / SECTION_SIZE);
      const courses = coursesFor(grade);
      const sections: SeededGroup[] = [];
      for (let k = 0; k < count; k++) {
        const course = courses[k % courses.length];
        const period = (Math.floor(k / courses.length) % 8) + 1;
        const teacher = pick.pick(teachers);
        const group = writer.create({
          local: `${groupSlug(course)}-p${period}-${groupSlug(teacher.family)}`,
          domain: ctx.spec.studentDomain,
          name: `${course} – Period ${period} (${teacher.family})`,
          description: `${course} at ${entry.school.name}`,
          kind: 'section',
        });
        writer.add(group, asUser(teacher), 'OWNER');
        sections.push(group);
      }
      const joins = Math.min(perStudent, count);
      for (const student of students)
        for (const section of sample(pick, sections, joins))
          writer.add(section, asUser(student));
    }
  }
}

function seedOutsideGroups(
  { ctx, random, writer, schools, admins }: ScenarioInput,
  outside: () => MemberTargetSeed,
): void {
  const pick = random.fork('parents');
  for (const entry of schools) {
    const group = writer.create({
      local: `${entry.base}-parents`,
      domain: ctx.spec.primaryDomain,
      name: `${entry.school.name} Parent Organization`,
      description: `Parents and staff of ${entry.school.name}`,
      kind: 'parents',
    });
    if (entry.owner) writer.add(group, asUser(entry.owner), 'OWNER');
    for (let n = pick.int(3, 12); n > 0; n--)
      writer.add(group, outside(), 'MEMBER', true);
  }
  const board = writer.create({
    local: 'board',
    domain: ctx.spec.primaryDomain,
    name: 'School Board',
    description: `The board of ${ctx.spec.districtName}`,
    kind: 'board',
  });
  writer.add(board, asUser(admins[0]), 'OWNER');
  for (let n = pick.int(5, 9); n > 0; n--)
    writer.add(board, outside(), 'MEMBER', true);
}

function seedChains({
  ctx,
  random,
  writer,
  schools,
  districtStaff,
}: ScenarioInput): void {
  const pick = random.fork('chains');
  const staff = [...districtStaff, ...schools.flatMap((entry) => entry.staff)];
  for (let chain = 1; chain <= ctx.spec.rates.deepGroupChains; chain++) {
    const levels = pick.int(8, 10);
    let parent: SeededGroup | null = null;
    for (let level = 1; level <= levels; level++) {
      const group = writer.create({
        local: `committee-${chain}-level-${level}`,
        domain: ctx.spec.primaryDomain,
        name: `District Committee ${chain} Level ${level}`,
        description: `Level ${level} of ${levels} in committee chain ${chain}`,
        kind: 'chain',
      });
      if (parent) writer.add(parent, asGroup(group));
      parent = group;
    }
    for (const user of sample(pick, staff, 3))
      writer.add(parent!, asUser(user));
  }
}

/** Empty sections make up `emptyGroups` of all groups: E = N × r / (1 − r). */
function seedEmptyGroups({
  ctx,
  random,
  writer,
  schools,
}: ScenarioInput): void {
  const rate = ctx.spec.rates.emptyGroups;
  const count = Math.round((writer.groups.length * rate) / (1 - rate));
  const pick = random.fork('empty');
  for (let n = 0; n < count; n++) {
    const entry = pick.pick(schools);
    const course = pick.pick(coursesFor(pick.pick(entry.school.grades)));
    const period = pick.int(1, 8);
    writer.create({
      local: `${groupSlug(course)}-p${period}-unassigned`,
      domain: ctx.spec.studentDomain,
      name: `${course} – Period ${period} (Unassigned)`,
      description: `An unscheduled section at ${entry.school.name}`,
      kind: 'empty',
    });
  }
}

/** Clubs and sections receive one outside guest each until the share is met. */
function seedOutsideGuests(
  { ctx, random, writer }: ScenarioInput,
  outside: () => MemberTargetSeed,
): void {
  const target = Math.round(
    writer.groups.length * ctx.spec.rates.externalMemberGroups,
  );
  const have = writer.groups.filter((group) => group.outside).length;
  const candidates = writer.groups.filter(
    (group) =>
      !group.outside && (group.kind === 'club' || group.kind === 'section'),
  );
  for (const group of sample(random.fork('guests'), candidates, target - have))
    writer.add(group, outside(), 'MEMBER', true);
}

function seedAliases({ ctx, random, writer }: ScenarioInput): void {
  const insert = ctx.db.prepare(
    'INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)',
  );
  const count = Math.round(writer.groups.length * ctx.spec.rates.groupAliases);
  for (const group of sample(random.fork('aliases'), writer.groups, count)) {
    const local = group.email.slice(0, group.email.indexOf('@'));
    insert.run(
      writer.address(`${local}-list`, ctx.spec.primaryDomain),
      group.id,
    );
  }
}

/** Seed the scenario families. Their order fixes every share computation. */
export function seedGroupScenarios(input: ScenarioInput): void {
  const outside = outsideAddresses(input.random.fork('outside'));
  seedSections(input);
  seedOutsideGroups(input, outside);
  seedChains(input);
  seedEmptyGroups(input);
  seedOutsideGuests(input, outside);
  seedAliases(input);
}
