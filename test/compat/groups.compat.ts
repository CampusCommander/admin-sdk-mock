import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';
import { READ_WRITE_SCOPES } from '../../src/auth/scopes.ts';
import { batchBody, batchStatuses } from '../../src/testing/batch.ts';

const key = JSON.parse(
  readFileSync(process.env.MOCK_GROUP_SA_FILE!, 'utf8'),
) as {
  client_email: string;
  private_key: string;
};
const expected = JSON.parse(process.env.MOCK_GROUP_EXPECT!) as {
  primaryDomain: string;
  groups: number;
  grade: string;
  gradeMembers: number;
  student: string;
  studentsGroup: string;
  alias: { alias: string; email: string };
  staff: string;
};
const auth = new JWT({
  email: key.client_email,
  key: key.private_key,
  subject: process.env.MOCK_GROUP_SUBJECT,
  scopes: [...READ_WRITE_SCOPES],
});
const directory = admin({ version: 'directory_v1', auth });
const notFound = (error: { response?: { status?: number } }) =>
  error.response?.status === 404;

test('groups.list pages every group, and groups.get answers by alias', async () => {
  let total = 0;
  let pageToken: string | undefined;
  do {
    const page = await directory.groups.list({
      customer: 'my_customer',
      maxResults: 200,
      pageToken,
    });
    total += page.data.groups?.length ?? 0;
    pageToken = page.data.nextPageToken ?? undefined;
  } while (pageToken);
  assert.equal(total, expected.groups);
  const byAlias = await directory.groups.get({
    groupKey: expected.alias.alias,
  });
  assert.equal(byAlias.data.email, expected.alias.email);
  const forStudent = await directory.groups.list({ userKey: expected.student });
  assert.ok(
    forStudent.data.groups!.some((group) => group.email === expected.grade),
  );
});

test('members.list, derived members, members.get, and hasMember work through the Google client', async () => {
  const direct = await directory.members.list({
    groupKey: expected.grade,
    maxResults: 200,
  });
  assert.equal(direct.data.members!.length, expected.gradeMembers);
  const derived = await directory.members.list({
    groupKey: expected.studentsGroup,
    includeDerivedMembership: true,
    maxResults: 200,
  });
  assert.ok(
    derived.data.members!.some((member) => member.email === expected.student),
  );
  const member = await directory.members.get({
    groupKey: expected.grade,
    memberKey: expected.student,
  });
  assert.equal(member.data.type, 'USER');
  assert.equal(member.data.delivery_settings !== undefined, true);
  const has = await directory.members.hasMember({
    groupKey: expected.grade,
    memberKey: expected.student,
  });
  assert.equal(has.data.isMember, true);
});

test('group, alias, and member writes work through the Google client', async () => {
  const email = `compat-team@${expected.primaryDomain}`;
  const created = await directory.groups.insert({
    requestBody: { email, name: 'Compat Team' },
  });
  assert.equal(created.data.directMembersCount, '0');
  const patched = await directory.groups.patch({
    groupKey: email,
    requestBody: { description: 'Patched' },
  });
  assert.equal(patched.data.description, 'Patched');
  const updated = await directory.groups.update({
    groupKey: email,
    requestBody: { name: 'Compat' },
  });
  assert.equal(updated.data.name, 'Compat');
  const alias = `compat-alias@${expected.primaryDomain}`;
  await directory.groups.aliases.insert({
    groupKey: email,
    requestBody: { alias },
  });
  assert.equal(
    (await directory.groups.get({ groupKey: alias })).data.email,
    email,
  );
  await directory.groups.aliases.delete({ groupKey: email, alias });
  const added = await directory.members.insert({
    groupKey: email,
    requestBody: { email: expected.staff, role: 'MANAGER' },
  });
  assert.equal(added.data.role, 'MANAGER');
  const promoted = await directory.members.patch({
    groupKey: email,
    memberKey: expected.staff,
    requestBody: { role: 'OWNER' },
  });
  assert.equal(promoted.data.role, 'OWNER');
  const quiet = await directory.members.update({
    groupKey: email,
    memberKey: expected.staff,
    requestBody: { delivery_settings: 'NONE' },
  });
  assert.equal(quiet.data.delivery_settings, 'NONE');
  await directory.members.delete({
    groupKey: email,
    memberKey: expected.staff,
  });
  await assert.rejects(
    directory.members.get({ groupKey: email, memberKey: expected.staff }),
    notFound,
  );
  const removed = await directory.groups.delete({ groupKey: email });
  assert.equal(removed.status, 204);
  await assert.rejects(directory.groups.get({ groupKey: email }), notFound);
});

test('group and member parts inside a batch answer one by one', async () => {
  const email = `batch-team@${expected.primaryDomain}`;
  await directory.groups.insert({ requestBody: { email } });
  const D = '/admin/directory/v1';
  const response = await auth.request<string>({
    url: 'https://www.googleapis.com/batch/admin/directory_v1',
    method: 'POST',
    headers: { 'content-type': 'multipart/mixed; boundary=compat' },
    data: batchBody(
      [
        { id: 'get', method: 'GET', path: `${D}/groups/${expected.grade}` },
        {
          id: 'members',
          method: 'GET',
          path: `${D}/groups/${expected.grade}/members`,
        },
        {
          id: 'has',
          method: 'GET',
          path: `${D}/groups/${expected.grade}/hasMember/${expected.student}`,
        },
        {
          id: 'add',
          method: 'POST',
          path: `${D}/groups/${email}/members`,
          body: { email: expected.staff },
        },
        {
          id: 'cycle',
          method: 'POST',
          path: `${D}/groups/${email}/members`,
          body: { email },
        },
        {
          id: 'patch',
          method: 'PATCH',
          path: `${D}/groups/${email}`,
          body: { description: 'Batch' },
        },
        {
          id: 'missing',
          method: 'GET',
          path: `${D}/groups/missing@${expected.primaryDomain}`,
        },
      ],
      'compat',
    ),
    responseType: 'text',
  });
  assert.deepEqual(
    [...batchStatuses(response.data)],
    [
      ['get', 200],
      ['members', 200],
      ['has', 200],
      ['add', 200],
      ['cycle', 400],
      ['patch', 200],
      ['missing', 404],
    ],
  );
});
