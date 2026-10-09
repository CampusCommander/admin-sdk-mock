import { handleBatch } from './batch/batch.ts';
import { handleToken } from './auth/token.ts';
import { handleTokenInfo } from './auth/tokeninfo.ts';
import { SCOPES } from './auth/scopes.ts';
import { getTelemetry, listTelemetry } from './chrome/telemetry.ts';
import { getCustomer } from './directory/customers.ts';
import { getDevice, listDevices } from './directory/devices.ts';
import { listDomains } from './directory/domains.ts';
import { getOrgUnit, listOrgUnits } from './directory/orgunits.ts';
import { getUser, listUsers } from './directory/users.ts';
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
    directoryRoute(
      'directory.chromeosdevices.list',
      /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/devices\/chromeos$/,
      SCOPES.device,
      listDevices,
    ),
    directoryRoute(
      'directory.chromeosdevices.get',
      /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/devices\/chromeos\/(?<deviceId>[^/]+)$/,
      SCOPES.device,
      getDevice,
    ),
    directoryRoute(
      'directory.users.list',
      /^\/admin\/directory\/v1\/users$/,
      SCOPES.user,
      listUsers,
      false,
    ),
    directoryRoute(
      'directory.users.get',
      /^\/admin\/directory\/v1\/users\/(?<userKey>[^/]+)$/,
      SCOPES.user,
      getUser,
      false,
    ),
    {
      id: 'chrome.telemetry.devices.list',
      api: 'chrome',
      hosts: ['chromemanagement.googleapis.com'],
      methods: ['GET'],
      pattern: /^\/v1\/customers\/(?<customer>[^/]+)\/telemetry\/devices$/,
      scopes: SCOPES.telemetry,
      admin: true,
      handler: listTelemetry,
    },
    {
      id: 'chrome.telemetry.devices.get',
      api: 'chrome',
      hosts: ['chromemanagement.googleapis.com'],
      methods: ['GET'],
      pattern:
        /^\/v1\/customers\/(?<customer>[^/]+)\/telemetry\/devices\/(?<deviceId>[^/]+)$/,
      scopes: SCOPES.telemetry,
      admin: true,
      handler: getTelemetry,
    },
    {
      id: 'batch.directory',
      api: 'batch',
      hosts: ['www.googleapis.com', 'admin.googleapis.com'],
      methods: ['POST'],
      pattern: /^\/batch(?:\/admin\/directory_v1)?$/,
      scopes: [],
      admin: false,
      handler: handleBatch,
    },
  ];
}
