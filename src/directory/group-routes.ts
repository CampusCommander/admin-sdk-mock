import { SCOPES, WRITE_SCOPES } from '../auth/scopes.ts';
import type { Route } from '../http/types.ts';
import { directoryRoute, writeRoute } from '../route-helpers.ts';
import { deleteGroup, insertGroup, updateGroup } from './group-writes.ts';
import { getGroup, listGroups } from './groups.ts';

const GROUPS = /^\/admin\/directory\/v1\/groups$/;
const GROUP = /^\/admin\/directory\/v1\/groups\/(?<groupKey>[^/]+)$/;

/** The group and group alias routes. */
export function groupRoutes(): Route[] {
  return [
    directoryRoute('directory.groups.list', GROUPS, SCOPES.group, listGroups),
    directoryRoute('directory.groups.get', GROUP, SCOPES.group, getGroup),
    writeRoute(
      'directory.groups.insert',
      'POST',
      GROUPS,
      WRITE_SCOPES.group,
      insertGroup,
    ),
    writeRoute(
      'directory.groups.update',
      'PUT',
      GROUP,
      WRITE_SCOPES.group,
      updateGroup,
    ),
    writeRoute(
      'directory.groups.patch',
      'PATCH',
      GROUP,
      WRITE_SCOPES.group,
      updateGroup,
    ),
    writeRoute(
      'directory.groups.delete',
      'DELETE',
      GROUP,
      WRITE_SCOPES.group,
      deleteGroup,
    ),
  ];
}
