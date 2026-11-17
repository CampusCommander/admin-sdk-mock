import { putCustomValue } from '../directory/custom-values.ts';
import {
  ensureCustomTables,
  makeId,
  makeSchemaId,
} from '../directory/schemas.ts';
import { createRandom } from '../random.ts';
import { rows } from '../store/sqlite.ts';
import { DAY_MS, type SeedContext } from './context.ts';

/** The three categories and ten attributes of baseline default 13. */
const SCHEMAS = [
  {
    schemaName: 'StudentInfo',
    displayName: 'Student information',
    fields: [
      {
        fieldName: 'StudentID',
        displayName: 'Student ID',
        fieldType: 'STRING',
      },
      {
        fieldName: 'GradeLevel',
        displayName: 'Grade level',
        fieldType: 'INT64',
        numericIndexingSpec: { minValue: 0, maxValue: 12 },
      },
      {
        fieldName: 'GraduationYear',
        displayName: 'Graduation year',
        fieldType: 'INT64',
      },
      { fieldName: 'Homeroom', displayName: 'Homeroom', fieldType: 'STRING' },
      {
        fieldName: 'Programs',
        displayName: 'Programs',
        fieldType: 'STRING',
        multiValued: true,
      },
    ],
  },
  {
    schemaName: 'StaffInfo',
    displayName: 'Staff information',
    fields: [
      {
        fieldName: 'EmployeeID',
        displayName: 'Employee ID',
        fieldType: 'STRING',
      },
      { fieldName: 'Building', displayName: 'Building', fieldType: 'STRING' },
      { fieldName: 'HireDate', displayName: 'Hire date', fieldType: 'DATE' },
      {
        fieldName: 'Certifications',
        displayName: 'Certifications',
        fieldType: 'STRING',
        multiValued: true,
      },
    ],
  },
  {
    schemaName: 'DeviceProgram',
    displayName: 'Device program',
    fields: [
      {
        fieldName: 'TakeHomeApproved',
        displayName: 'Take-home approved',
        fieldType: 'BOOL',
      },
    ],
  },
] as const;

const PROGRAMS = ['Band', 'Choir', 'ELL', 'Robotics', 'Yearbook'];
const BUILDINGS = [
  'Lincoln Elementary',
  'Roosevelt Middle',
  'Central High',
  'District Office',
];
const CERTIFICATIONS = [
  'First aid',
  'Mathematics 5-9',
  'Special education',
  'Coaching',
];
const DEPARTMENTS = ['Mathematics', 'Science', 'English', 'Student Services'];
const TITLES = ['Teacher', 'Counselor', 'Principal', 'Aide'];

interface SeedUser {
  id: string;
  role: string;
  external_id: string | null;
}

/**
 * Write the scenario of baseline default 13: three categories, ten attributes, and values
 * on the students and the staff. It also seeds the archived flag, two-step verification,
 * and the organizations of the staff. The seed field turns it on.
 */
export function seedCustomScenario({ spec, seededAt, db }: SeedContext): void {
  ensureCustomTables(db);
  const random = createRandom(`custom-scenario/${spec.seed}`);
  const insertSchema = db.prepare(
    'INSERT INTO custom_schemas (schema_id, schema_name, display_name, revision, ord) VALUES (?, ?, ?, 1, ?)',
  );
  const insertField = db.prepare(
    'INSERT INTO custom_schema_fields (schema_id, field_id, field_name, display_name, field_type, multi_valued, indexed, read_access_type, numeric_min, numeric_max, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const schemaIds = new Map<string, string>();
  SCHEMAS.forEach((schema, index) => {
    const schemaId = makeSchemaId(
      spec.seed,
      `schema/${spec.customerId}/${schema.schemaName}`,
      (id) => [...schemaIds.values()].includes(id),
    );
    schemaIds.set(schema.schemaName, schemaId);
    insertSchema.run(schemaId, schema.schemaName, schema.displayName, index);
    const taken = new Set<string>();
    schema.fields.forEach((field, ordinal) => {
      const fieldId = makeId(
        spec.seed,
        `field/${spec.customerId}/${schema.schemaName}/${field.fieldName}`,
        (id) => taken.has(id),
      );
      taken.add(fieldId);
      insertField.run(
        schemaId,
        fieldId,
        field.fieldName,
        field.displayName,
        field.fieldType,
        'multiValued' in field && field.multiValued ? 1 : 0,
        1,
        'ALL_DOMAIN_USERS',
        'numericIndexingSpec' in field
          ? field.numericIndexingSpec.minValue
          : null,
        'numericIndexingSpec' in field
          ? field.numericIndexingSpec.maxValue
          : null,
        ordinal,
      );
    });
  });

  const insertExtra = db.prepare(
    'INSERT INTO user_profile_extra (user_id, archived, enrolled_in_2sv, organizations) VALUES (?, ?, ?, ?)',
  );
  const users = rows<SeedUser>(
    db.prepare('SELECT id, role, external_id FROM users ORDER BY ord').all(),
  );
  for (const user of users) {
    const isStudent = user.role === 'student';
    const isStaff = user.role === 'staff' || user.role === 'admin';
    const grade = random.int(0, 12);
    if (isStudent) {
      putCustomValue(
        db,
        user.id,
        'StudentInfo',
        'StudentID',
        user.external_id ?? user.id,
      );
      putCustomValue(db, user.id, 'StudentInfo', 'GradeLevel', grade);
      putCustomValue(
        db,
        user.id,
        'StudentInfo',
        'GraduationYear',
        2027 + (12 - grade),
      );
      putCustomValue(
        db,
        user.id,
        'StudentInfo',
        'Homeroom',
        `B${random.int(1, 40)}`,
      );
      const programs = PROGRAMS.filter(() => random.chance(0.15)).map(
        (program) => ({ value: program }),
      );
      if (programs.length > 0)
        putCustomValue(db, user.id, 'StudentInfo', 'Programs', programs);
    }
    if (isStaff) {
      putCustomValue(
        db,
        user.id,
        'StaffInfo',
        'EmployeeID',
        user.external_id ?? `E${user.id.slice(-6)}`,
      );
      putCustomValue(
        db,
        user.id,
        'StaffInfo',
        'Building',
        random.pick(BUILDINGS),
      );
      const hired = new Date(seededAt - random.int(90, 4000) * DAY_MS)
        .toISOString()
        .slice(0, 10);
      putCustomValue(db, user.id, 'StaffInfo', 'HireDate', hired);
      const certifications = CERTIFICATIONS.filter(() =>
        random.chance(0.2),
      ).map((certification) => ({ value: certification }));
      if (certifications.length > 0)
        putCustomValue(
          db,
          user.id,
          'StaffInfo',
          'Certifications',
          certifications,
        );
      putCustomValue(
        db,
        user.id,
        'DeviceProgram',
        'TakeHomeApproved',
        random.chance(0.5),
      );
      insertExtra.run(
        user.id,
        random.chance(0.01) ? 1 : 0,
        random.chance(0.6) ? 1 : 0,
        isStaff
          ? JSON.stringify([
              {
                name: spec.districtName,
                department: random.pick(DEPARTMENTS),
                title: random.pick(TITLES),
                primary: true,
              },
            ])
          : null,
      );
    } else {
      insertExtra.run(
        user.id,
        random.chance(0.01) ? 1 : 0,
        random.chance(0.6) ? 1 : 0,
        null,
      );
    }
  }
}
