import { handleToken } from './auth/token.ts';
import { handleTokenInfo } from './auth/tokeninfo.ts';
import { SCOPES } from './auth/scopes.ts';
import { getCustomer } from './directory/customers.ts';
import { listDomains } from './directory/domains.ts';
import { getOrgUnit, listOrgUnits } from './directory/orgunits.ts';
import type { Route } from './http/types.ts';
import type { Mock } from './mock.ts';

const OAUTH = ['oauth2.googleapis.com'];
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

/** Every Google route. Later tasks add their routes here. */
export function buildRoutes(mock: Mock): Route[] {
  return [
    {
      id: 'oauth.token',
      api: 'oauth',
      hosts: OAUTH,
      methods: ['POST'],
      pattern: /^\/token$/,
      scopes: [],
      admin: false,
      handler: (call) => handleToken(mock, call),
    },
    {
      id: 'oauth.tokeninfo',
      api: 'oauth',
      hosts: OAUTH,
      methods: ['GET', 'POST'],
      pattern: /^\/tokeninfo$/,
      scopes: [],
      admin: false,
      handler: (call) => handleTokenInfo(mock, call),
    },
    directoryRoute(
      'directory.customers.get',
      /^\/admin\/directory\/v1\/customers\/(?<customerKey>[^/]+)$/,
      SCOPES.customer,
      getCustomer,
    ),
    directoryRoute(
      'directory.domains.list',
      /^\/admin\/directory\/v1\/customer\/(?<customer>[^/]+)\/domains$/,
      SCOPES.domain,
      listDomains,
    ),
    directoryRoute(
      'directory.orgunits.list',
      /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/orgunits$/,
      SCOPES.orgunit,
      listOrgUnits,
    ),
    directoryRoute(
      'directory.orgunits.get',
      /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/orgunits\/(?<orgUnitPath>.+)$/,
      SCOPES.orgunit,
      getOrgUnit,
    ),
  ];
}
