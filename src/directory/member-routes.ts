import { SCOPES, WRITE_SCOPES } from '../auth/scopes.ts';
import type { Route } from '../http/types.ts';
import { directoryRoute, writeRoute } from '../route-helpers.ts';
import { deleteMember, insertMember, updateMember } from './member-writes.ts';
import { hasMember } from './has-member.ts';
import { getMember, listMembers } from './members.ts';

const MEMBERS = /^\/admin\/directory\/v1\/groups\/(?<groupKey>[^/]+)\/members$/;
const MEMBER =
  /^\/admin\/directory\/v1\/groups\/(?<groupKey>[^/]+)\/members\/(?<memberKey>[^/]+)$/;
const HAS_MEMBER =
  /^\/admin\/directory\/v1\/groups\/(?<groupKey>[^/]+)\/hasMember\/(?<memberKey>[^/]+)$/;

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
    directoryRoute(
      'directory.members.hasMember',
      HAS_MEMBER,
      SCOPES.member,
      hasMember,
    ),
    writeRoute(
      'directory.members.insert',
      'POST',
      MEMBERS,
      WRITE_SCOPES.member,
      insertMember,
    ),
    writeRoute(
      'directory.members.update',
      'PUT',
      MEMBER,
      WRITE_SCOPES.member,
      updateMember,
    ),
    writeRoute(
      'directory.members.patch',
      'PATCH',
      MEMBER,
      WRITE_SCOPES.member,
      updateMember,
    ),
    writeRoute(
      'directory.members.delete',
      'DELETE',
      MEMBER,
      WRITE_SCOPES.member,
      deleteMember,
    ),
  ];
}
