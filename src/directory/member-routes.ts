import { SCOPES } from '../auth/scopes.ts';
import type { Route } from '../http/types.ts';
import { directoryRoute } from '../route-helpers.ts';
import { getMember, listMembers } from './members.ts';

const MEMBERS = /^\/admin\/directory\/v1\/groups\/(?<groupKey>[^/]+)\/members$/;
const MEMBER =
  /^\/admin\/directory\/v1\/groups\/(?<groupKey>[^/]+)\/members\/(?<memberKey>[^/]+)$/;

/** The member routes. */
export function memberRoutes(): Route[] {
  return [
    directoryRoute(
      'directory.members.list',
      MEMBERS,
      SCOPES.member,
      listMembers,
    ),
    directoryRoute('directory.members.get', MEMBER, SCOPES.member, getMember),
  ];
}
