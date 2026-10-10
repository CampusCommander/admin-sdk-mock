import type { ApiResponse, Call } from '../http/types.ts';
import { createRandom } from '../random.ts';
import { addressInUse, domainKind } from '../store/addresses.ts';
import { newGroupId, type GroupRow } from '../store/group-lookup.ts';
import { saveBeforeImage, saveBeforeImagesWhere } from '../store/lag.ts';
import { row, transaction } from '../store/sqlite.ts';
import {
  domainOf,
  duplicate,
  invalidArgument,
  jsonBody,
  searchDelayMs,
  stringField,
} from './common.ts';
import { visibleGroup } from './group-common.ts';
import { groupDetails, groupResource } from './groups.ts';

const EMAIL = /^[^@\s]+@[^@\s]+$/;
/** Google documents a 4,096-character description limit. */
export const MAX_DESCRIPTION = 4096;

/** Read an address on one of the customer's own domains. Alias domains do not count. */
export function groupAddress(
  call: Call,
  value: unknown,
  field: string,
): string {
  if (typeof value !== 'string' || !EMAIL.test(value.trim()))
    throw invalidArgument(call, `Invalid Input: ${field}`);
  const email = value.trim().toLowerCase();
  if (domainKind(domainOf(call).db, email) !== 'own')
    throw invalidArgument(call, `Invalid Input: ${field}`);
  return email;
}

/** Render a group after a write, from the live tables. */
export function writtenGroup(call: Call, id: string): Record<string, unknown> {
  const domain = domainOf(call);
  const group = row<GroupRow>(
    domain.db.prepare('SELECT * FROM groups WHERE id = ?').get(id),
  )!;
  const details = groupDetails(domain.db, [id]);
  return groupResource(
    group,
    details.aliases.get(id) ?? [],
    details.counts.get(id) ?? 0,
  );
}

const localPart = (email: string) => email.slice(0, email.indexOf('@'));

/** `groups.insert`. Ruling: `name` defaults to the local part of the email. */
export function insertGroup(call: Call): ApiResponse {
  const domain = domainOf(call);
  const body = jsonBody(call);
  const email = groupAddress(call, body.email, 'email');
  const name = stringField(call, body, 'name') || localPart(email);
  const description =
    stringField(call, body, 'description', MAX_DESCRIPTION) ?? '';
  if (addressInUse(domain.db, email)) throw duplicate();
  const taken = domain.db.prepare('SELECT 1 FROM groups WHERE id = ?');
  const id = newGroupId(
    createRandom(`group/${domain.spec.seed}/${email}/${call.now}`),
    (candidate) => taken.get(candidate) !== undefined,
  );
  transaction(domain.db, () => {
    saveBeforeImage(domain.db, 'groups', id, call.now, searchDelayMs(call));
    domain.db
      .prepare(
        'INSERT INTO groups (id, email, name, description, admin_created, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      )
      .run(id, email, name, description, call.now);
  });
  return { status: 200, body: writtenGroup(call, id) };
}

/** `groups.update` and `groups.patch`. Both change only the fields present in the body. */
export function updateGroup(call: Call): ApiResponse {
  const domain = domainOf(call);
  const group = visibleGroup(call, call.params.groupKey);
  const body = jsonBody(call);
  const sets: string[] = [];
  const params: string[] = [];
  const name = stringField(call, body, 'name');
  if (name !== undefined) {
    sets.push('name = ?');
    params.push(name || localPart(group.email));
  }
  const description = stringField(call, body, 'description', MAX_DESCRIPTION);
  if (description !== undefined) {
    sets.push('description = ?');
    params.push(description ?? '');
  }
  let rename: string | undefined;
  if (body.email !== undefined && body.email !== null) {
    const email = groupAddress(call, body.email, 'email');
    if (email !== group.email) {
      if (addressInUse(domain.db, email, { groupId: group.id }))
        throw duplicate();
      rename = email;
    }
  }
  if (sets.length > 0 || rename) {
    const delay = searchDelayMs(call);
    transaction(domain.db, () => {
      saveBeforeImage(domain.db, 'groups', group.id, call.now, delay);
      if (sets.length > 0)
        domain.db
          .prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`)
          .run(...params, group.id);
      if (!rename) return;
      // Ruling: the old address stays as an alias, as a user rename keeps it.
      saveBeforeImage(domain.db, 'group_aliases', rename, call.now, delay);
      saveBeforeImage(domain.db, 'group_aliases', group.email, call.now, delay);
      domain.db
        .prepare('DELETE FROM group_aliases WHERE alias = ? AND group_id = ?')
        .run(rename, group.id);
      domain.db
        .prepare('UPDATE groups SET email = ? WHERE id = ?')
        .run(rename, group.id);
      domain.db
        .prepare('INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)')
        .run(group.email, group.id);
      const asMember = "email = ? AND member_id = ? AND type = 'GROUP'";
      saveBeforeImagesWhere(
        domain.db,
        'group_members',
        asMember,
        [group.email, group.id],
        call.now,
        delay,
      );
      domain.db
        .prepare(`UPDATE group_members SET email = ? WHERE ${asMember}`)
        .run(rename, group.email, group.id);
    });
  }
  return { status: 200, body: writtenGroup(call, group.id) };
}

/** `groups.delete`. Removes the group, its aliases, its members, and its membership in other groups. */
export function deleteGroup(call: Call): ApiResponse {
  const domain = domainOf(call);
  const group = visibleGroup(call, call.params.groupKey);
  const delay = searchDelayMs(call);
  const asMember = "email = ? AND member_id = ? AND type = 'GROUP'";
  let removed = 0;
  transaction(domain.db, () => {
    saveBeforeImage(domain.db, 'groups', group.id, call.now, delay);
    saveBeforeImagesWhere(
      domain.db,
      'group_aliases',
      'group_id = ?',
      [group.id],
      call.now,
      delay,
    );
    saveBeforeImagesWhere(
      domain.db,
      'group_members',
      'group_id = ?',
      [group.id],
      call.now,
      delay,
    );
    saveBeforeImagesWhere(
      domain.db,
      'group_members',
      asMember,
      [group.email, group.id],
      call.now,
      delay,
    );
    domain.db
      .prepare('DELETE FROM group_aliases WHERE group_id = ?')
      .run(group.id);
    removed += Number(
      domain.db
        .prepare('DELETE FROM group_members WHERE group_id = ?')
        .run(group.id).changes,
    );
    removed += Number(
      domain.db
        .prepare(`DELETE FROM group_members WHERE ${asMember}`)
        .run(group.email, group.id).changes,
    );
    domain.db.prepare('DELETE FROM groups WHERE id = ?').run(group.id);
  });
  return { status: 204, scanned: removed };
}
