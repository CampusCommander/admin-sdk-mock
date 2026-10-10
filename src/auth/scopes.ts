const P = 'https://www.googleapis.com/auth/';

export const TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** Scopes that each resource accepts, from the discovery documents. */
export const SCOPES = {
  customer: [
    `${P}admin.directory.customer`,
    `${P}admin.directory.customer.readonly`,
  ],
  domain: [`${P}admin.directory.domain`, `${P}admin.directory.domain.readonly`],
  orgunit: [
    `${P}admin.directory.orgunit`,
    `${P}admin.directory.orgunit.readonly`,
  ],
  device: [
    `${P}admin.directory.device.chromeos`,
    `${P}admin.directory.device.chromeos.readonly`,
  ],
  user: [
    `${P}admin.directory.user`,
    `${P}admin.directory.user.readonly`,
    `${P}cloud-platform`,
  ],
  group: [`${P}admin.directory.group`, `${P}admin.directory.group.readonly`],
  member: [
    `${P}admin.directory.group`,
    `${P}admin.directory.group.readonly`,
    `${P}admin.directory.group.member`,
    `${P}admin.directory.group.member.readonly`,
  ],
  telemetry: [`${P}chrome.management.telemetry.readonly`],
} as const;

/** The read-only scopes of milestones 1 and 3. */
export const READ_SCOPES: readonly string[] = [
  `${P}admin.directory.customer.readonly`,
  `${P}admin.directory.domain.readonly`,
  `${P}admin.directory.orgunit.readonly`,
  `${P}admin.directory.device.chromeos.readonly`,
  `${P}admin.directory.user.readonly`,
  `${P}admin.directory.group.readonly`,
  `${P}chrome.management.telemetry.readonly`,
];

/** The read-write scope of each resource that milestone 2 writes. */
export const WRITE_SCOPES = {
  device: [`${P}admin.directory.device.chromeos`],
  user: [`${P}admin.directory.user`],
  orgunit: [`${P}admin.directory.orgunit`],
  group: [`${P}admin.directory.group`],
  member: [`${P}admin.directory.group`, `${P}admin.directory.group.member`],
} as const;

/** The read scopes plus the milestone 2 and milestone 3 write scopes. */
export const READ_WRITE_SCOPES: readonly string[] = [
  ...READ_SCOPES,
  ...WRITE_SCOPES.device,
  ...WRITE_SCOPES.user,
  ...WRITE_SCOPES.orgunit,
  ...WRITE_SCOPES.group,
];
