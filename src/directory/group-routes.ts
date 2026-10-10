import { SCOPES } from '../auth/scopes.ts';
import type { Route } from '../http/types.ts';
import { directoryRoute } from '../route-helpers.ts';
import { getGroup, listGroups } from './groups.ts';

const GROUPS = /^\/admin\/directory\/v1\/groups$/;
const GROUP = /^\/admin\/directory\/v1\/groups\/(?<groupKey>[^/]+)$/;

/** The group and group alias routes. */
export function groupRoutes(): Route[] {
  return [
    directoryRoute('directory.groups.list', GROUPS, SCOPES.group, listGroups),
    directoryRoute('directory.groups.get', GROUP, SCOPES.group, getGroup),
  ];
}
