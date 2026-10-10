const ELEMENTARY = ['Homeroom', 'Reading', 'Math', 'Science', 'Art', 'Music'];
const MIDDLE = [
  'English',
  'Math',
  'Science',
  'Social Studies',
  'Spanish',
  'Band',
  'Health',
];
const HIGH: Readonly<Record<number, readonly string[]>> = {
  9: [
    'English 9',
    'Algebra I',
    'Biology',
    'World History',
    'Spanish I',
    'Health',
  ],
  10: [
    'English 10',
    'Geometry',
    'Chemistry',
    'US History',
    'Spanish II',
    'Art',
  ],
  11: [
    'English 11',
    'Algebra II',
    'Physics',
    'Government',
    'Spanish III',
    'Computer Science',
  ],
  12: [
    'English 12',
    'Precalculus',
    'Economics',
    'Statistics',
    'Psychology',
    'Senior Seminar',
  ],
};

/** The courses that sections of one grade teach. Grade 0 is kindergarten. */
export function coursesFor(grade: number): readonly string[] {
  if (grade <= 5)
    return ELEMENTARY.map((course) => `${course} ${grade === 0 ? 'K' : grade}`);
  if (grade <= 8) return MIDDLE.map((course) => `${course} ${grade}`);
  return HIGH[grade] ?? HIGH[12];
}

export const CLUBS: readonly string[] = [
  'Chess Club',
  'Robotics',
  'Drama',
  'Yearbook',
  'Debate',
  'Art Club',
  'Coding Club',
  'Garden Club',
  'Math Team',
  'Book Club',
  'Student Council',
  'Science Olympiad',
];

/** Mail domains outside every seeded customer, for outside members. */
export const OUTSIDE_DOMAINS: readonly string[] = [
  'homemail.test',
  'familymail.test',
  'inbox-mail.test',
  'webpost.test',
];
