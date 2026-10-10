import type { ApiResponse, Call } from '../http/types.ts';
import { addressInUse } from '../store/addresses.ts';
import type { GroupRow } from '../store/group-lookup.ts';
import { saveBeforeImage } from '../store/lag.ts';
import { row, rows, transaction } from '../store/sqlite.ts';
import {
  domainOf,
  duplicate,
  jsonBody,
  listedTable,
  notFound,
  searchDelayMs,
  withEtag,
} from './common.ts';
import { visibleGroup } from './group-common.ts';
import { groupAddress } from './group-writes.ts';

function aliasResource(
  group: GroupRow,
  alias: string,
): Record<string, unknown> {
  return withEtag({
    kind: 'admin#directory#alias',
    id: group.id,
    primaryEmail: group.email,
    alias,
  });
}

/** `groups.aliases.list`. The list lags writes by the search delay. */
export function listGroupAliases(call: Call): ApiResponse {
  const domain = domainOf(call);
  const group = visibleGroup(call, call.params.groupKey);
  const table = listedTable(call, 'group_aliases');
  const aliases = rows<{ alias: string }>(
    domain.db
      .prepare(`SELECT alias FROM ${table} WHERE group_id = ? ORDER BY alias`)
      .all(group.id),
  ).map((entry) => entry.alias);
  return {
    status: 200,
    items: aliases.length,
    body: withEtag({
      kind: 'admin#directory#aliases',
      ...(aliases.length > 0
        ? { aliases: aliases.map((alias) => aliasResource(group, alias)) }
        : {}),
    }),
  };
}

export function insertGroupAlias(call: Call): ApiResponse {
  const domain = domainOf(call);
  const group = visibleGroup(call, call.params.groupKey);
  const alias = groupAddress(call, jsonBody(call).alias, 'alias');
  if (addressInUse(domain.db, alias)) throw duplicate();
  transaction(domain.db, () => {
    saveBeforeImage(
      domain.db,
      'group_aliases',
      alias,
      call.now,
      searchDelayMs(call),
    );
    domain.db
      .prepare('INSERT INTO group_aliases (alias, group_id) VALUES (?, ?)')
      .run(alias, group.id);
  });
  return { status: 200, body: aliasResource(group, alias) };
}

export function deleteGroupAlias(call: Call): ApiResponse {
  const domain = domainOf(call);
  const group = visibleGroup(call, call.params.groupKey);
  const alias = call.params.alias.toLowerCase();
  const held = row(
    domain.db
      .prepare('SELECT 1 FROM group_aliases WHERE alias = ? AND group_id = ?')
      .get(alias, group.id),
  );
  if (!held) throw notFound('alias');
  transaction(domain.db, () => {
    saveBeforeImage(
      domain.db,
      'group_aliases',
      alias,
      call.now,
      searchDelayMs(call),
    );
    domain.db.prepare('DELETE FROM group_aliases WHERE alias = ?').run(alias);
  });
  return { status: 204 };
}
