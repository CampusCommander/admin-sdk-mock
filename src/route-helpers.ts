import type { Route } from './http/types.ts';

const ADMIN = ['admin.googleapis.com'];

/** A Directory API read route on admin.googleapis.com. */
export function directoryRoute(
  id: string,
  pattern: RegExp,
  scopes: readonly string[],
  handler: Route['handler'],
  admin = true,
): Route {
  return {
    id,
    api: 'directory',
    hosts: ADMIN,
    methods: ['GET'],
    pattern,
    scopes,
    admin,
    handler,
  };
}

/** A Directory API write route on admin.googleapis.com. */
export function writeRoute(
  id: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  pattern: RegExp,
  scopes: readonly string[],
  handler: Route['handler'],
): Route {
  return {
    id,
    api: 'directory',
    hosts: ADMIN,
    methods: [method],
    pattern,
    scopes,
    admin: true,
    write: true,
    handler,
  };
}
