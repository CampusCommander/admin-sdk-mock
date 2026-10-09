import { createRandom, type Random } from '../random.ts';
import { SCHOOL_NAMESAKES } from './names.ts';
import type { ResolvedSpec } from './spec.ts';

export type OuKind = 'root' | 'container' | 'users' | 'devices';
export type DeviceCategory = 'one-to-one' | 'cart' | 'staff' | 'kiosk';
export const DEVICE_CATEGORIES: readonly DeviceCategory[] = [
  'one-to-one',
  'cart',
  'staff',
  'kiosk',
];
export type SchoolLevel = 'elementary' | 'middle' | 'high' | 'k8';

export interface OrgUnitNode {
  orgUnitId: string;
  name: string;
  path: string;
  parentId: string | null;
  parentPath: string | null;
  depth: number;
  description: string;
  kind: OuKind;
}

export interface School {
  index: number;
  name: string;
  level: SchoolLevel;
  grades: number[];
  region: string | null;
  weight: number;
  studentOus: Record<number, string>;
  staffOu: string;
  deviceOus: Record<DeviceCategory, string>;
}

export interface Layout {
  root: OrgUnitNode;
  units: OrgUnitNode[];
  schools: School[];
  districtStaffOu: string;
  districtDeviceOu: string;
  deepUserOus: string[];
  deepDeviceOus: string[];
}

export const MAX_DEPTH = 35;
export const MAX_UNITS = 40_000;
/** The class of 2027 is in grade 12 during the 2026-27 school year. */
export const GRADUATION_BASE_YEAR = 2027;

const GRADES: Record<SchoolLevel, number[]> = {
  elementary: [0, 1, 2, 3, 4, 5],
  middle: [6, 7, 8],
  high: [9, 10, 11, 12],
  k8: [0, 1, 2, 3, 4, 5, 6, 7, 8],
};

const LEVEL_WORDS: Record<SchoolLevel, string[]> = {
  elementary: ['Elementary', 'Elementary School', 'Primary'],
  middle: ['Middle', 'Middle School', 'Junior High'],
  high: ['High', 'High School', 'Academy'],
  k8: ['K-8', 'School', 'Academy'],
};

/** A stable OU ID derived from the seed and the path. */
export function ouId(seed: string, path: string): string {
  return `id:0${createRandom(`ou/${seed}/${path}`).string(13)}`;
}

const childPath = (parent: string, name: string) =>
  parent === '/' ? `/${name}` : `${parent}/${name}`;

function makeSchools(spec: ResolvedSpec, random: Random): School[] {
  const used = new Set<string>();
  const schools: School[] = [];
  for (let index = 0; index < spec.counts.schools; index++) {
    const level = random.weighted<SchoolLevel>([
      ['elementary', 0.6],
      ['middle', 0.2],
      ['high', 0.15],
      ['k8', 0.05],
    ]);
    const base = `${random.pick(SCHOOL_NAMESAKES)} ${random.pick(LEVEL_WORDS[level])}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base} ${n}`;
    used.add(name);
    schools.push({
      index,
      name,
      level,
      grades: GRADES[level],
      region: null,
      weight: (0.5 + random.next()) * (level === 'high' ? 1.6 : 1),
      studentOus: {},
      staffOu: '',
      deviceOus: { 'one-to-one': '', cart: '', staff: '', kiosk: '' },
    });
  }
  return schools;
}

/** Build the OU tree, the school list, and the OU assignments for one domain. */
export function buildLayout(spec: ResolvedSpec): Layout {
  const random = createRandom(`layout/${spec.seed}`);
  const labels = {
    students: random.pick(['Students', 'Learners', 'Student Accounts']),
    staff: random.pick(['Staff', 'Employees', 'Faculty and Staff']),
    devices: random.pick(['Devices', 'Chromebooks', 'Chrome Devices']),
    gradeStyle: random.pick<'grade' | 'class-of'>(['grade', 'class-of']),
    categories: {
      'one-to-one': random.pick(['1:1', 'One to One', 'Student Devices']),
      cart: random.pick(['Carts', 'Cart Devices', 'Shared Carts']),
      staff: random.pick(['Staff Devices', 'Teacher Devices']),
      kiosk: random.pick(['Kiosk', 'Testing Kiosks', 'Signage']),
    } satisfies Record<DeviceCategory, string>,
    region: random.pick(['Network', 'Region', 'Zone']),
  };
  const gradeLabel = (grade: number) =>
    labels.gradeStyle === 'grade'
      ? grade === 0
        ? 'Kindergarten'
        : `Grade ${grade}`
      : `Class of ${GRADUATION_BASE_YEAR + 12 - grade}`;

  const root: OrgUnitNode = {
    orgUnitId: ouId(spec.seed, '/'),
    name: spec.districtName,
    path: '/',
    parentId: null,
    parentPath: null,
    depth: 0,
    description: '',
    kind: 'root',
  };
  const units: OrgUnitNode[] = [];
  const byPath = new Map<string, OrgUnitNode>([['/', root]]);
  const add = (
    parent: OrgUnitNode,
    name: string,
    kind: OuKind,
  ): OrgUnitNode => {
    let unique = name;
    for (let n = 2; byPath.has(childPath(parent.path, unique)); n++)
      unique = `${name} ${n}`;
    if (parent.depth + 1 > MAX_DEPTH)
      throw new RangeError(`OU depth exceeds ${MAX_DEPTH}.`);
    if (units.length + 1 > MAX_UNITS)
      throw new RangeError(`OU count exceeds ${MAX_UNITS}.`);
    const path = childPath(parent.path, unique);
    const node: OrgUnitNode = {
      orgUnitId: ouId(spec.seed, path),
      name: unique,
      path,
      parentId: parent.orgUnitId,
      parentPath: parent.path,
      depth: parent.depth + 1,
      description: '',
      kind,
    };
    units.push(node);
    byPath.set(path, node);
    return node;
  };
  const ensure = (
    parent: OrgUnitNode,
    name: string,
    kind: OuKind,
  ): OrgUnitNode =>
    byPath.get(childPath(parent.path, name)) ?? add(parent, name, kind);

  const schools = makeSchools(spec, random.fork('schools'));
  const regionCount =
    spec.tier === 'xlarge' || spec.counts.schools >= 200
      ? Math.min(20, Math.max(2, Math.round(spec.counts.schools / 40)))
      : 0;
  for (const school of schools)
    school.region = regionCount
      ? `${labels.region} ${(school.index % regionCount) + 1}`
      : null;
  const under = (parent: OrgUnitNode, school: School) =>
    school.region ? ensure(parent, school.region, 'container') : parent;

  let districtStaffOu: string;
  let districtDeviceOu: string;
  if (spec.layout === 'role-first') {
    const students = add(root, labels.students, 'container');
    const staff = add(root, labels.staff, 'container');
    const devices = add(root, labels.devices, 'container');
    for (const school of schools) {
      const studentSchool = add(
        under(students, school),
        school.name,
        'container',
      );
      for (const grade of school.grades)
        school.studentOus[grade] = add(
          studentSchool,
          gradeLabel(grade),
          'users',
        ).path;
      school.staffOu = add(under(staff, school), school.name, 'users').path;
      const deviceSchool = add(
        under(devices, school),
        school.name,
        'container',
      );
      for (const category of DEVICE_CATEGORIES)
        school.deviceOus[category] = add(
          deviceSchool,
          labels.categories[category],
          'devices',
        ).path;
    }
    districtStaffOu = add(staff, 'District Office', 'users').path;
    districtDeviceOu = add(devices, 'District Office', 'devices').path;
  } else {
    for (const school of schools) {
      const schoolNode = add(under(root, school), school.name, 'container');
      const students = add(schoolNode, labels.students, 'container');
      for (const grade of school.grades)
        school.studentOus[grade] = add(
          students,
          gradeLabel(grade),
          'users',
        ).path;
      school.staffOu = add(schoolNode, labels.staff, 'users').path;
      const devices = add(schoolNode, labels.devices, 'container');
      for (const category of DEVICE_CATEGORIES)
        school.deviceOus[category] = add(
          devices,
          labels.categories[category],
          'devices',
        ).path;
    }
    const district = add(root, 'District Office', 'container');
    districtStaffOu = add(district, labels.staff, 'users').path;
    districtDeviceOu = add(district, labels.devices, 'devices').path;
  }

  const deep = random.fork('deep');
  const deepUserOus: string[] = [];
  const deepDeviceOus: string[] = [];
  for (let branch = 0; branch < spec.rates.deepBranches; branch++) {
    const kind: OuKind = branch % 2 === 0 ? 'devices' : 'users';
    const parents = new Set(units.map((unit) => unit.parentId));
    const leaves = units.filter(
      (unit) => unit.kind === kind && !parents.has(unit.orgUnitId),
    );
    if (leaves.length === 0) continue;
    let node = deep.pick(leaves);
    const target = deep.int(8, 12);
    while (node.depth < target)
      node = add(
        node,
        deep.pick([
          `Room ${deep.int(100, 399)}`,
          `Cart ${deep.int(1, 40)}`,
          'Pilot',
          'Testing',
          `Shelf ${deep.int(1, 9)}`,
          `Group ${deep.int(1, 20)}`,
        ]),
        kind,
      );
    (kind === 'devices' ? deepDeviceOus : deepUserOus).push(node.path);
  }

  return {
    root,
    units,
    schools,
    districtStaffOu,
    districtDeviceOu,
    deepUserOus,
    deepDeviceOus,
  };
}
