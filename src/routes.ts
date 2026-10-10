import { handleBatch } from './batch/batch.ts';
import { handleToken } from './auth/token.ts';
import { handleTokenInfo } from './auth/tokeninfo.ts';
import { SCOPES, WRITE_SCOPES } from './auth/scopes.ts';
import { getTelemetry, listTelemetry } from './chrome/telemetry.ts';
import { getCustomer } from './directory/customers.ts';
import { getDevice, listDevices } from './directory/devices.ts';
import { listDomains } from './directory/domains.ts';
import { getOrgUnit, listOrgUnits } from './directory/orgunits.ts';
import {
  deleteUser,
  insertUser,
  makeAdmin,
  undeleteUser,
  updateUser,
} from './directory/user-writes.ts';
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

const USER = /^\/admin\/directory\/v1\/users\/(?<userKey>[^/]+)$/;

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
    directoryRoute('directory.users.get', USER, SCOPES.user, getUser, false),
    writeRoute(
      'directory.users.insert',
      'POST',
      /^\/admin\/directory\/v1\/users$/,
      WRITE_SCOPES.user,
      insertUser,
    ),
    writeRoute(
      'directory.users.update',
      'PUT',
      USER,
      WRITE_SCOPES.user,
      updateUser,
    ),
    writeRoute(
      'directory.users.patch',
      'PATCH',
      USER,
      WRITE_SCOPES.user,
      updateUser,
    ),
    writeRoute(
      'directory.users.delete',
      'DELETE',
      USER,
      WRITE_SCOPES.user,
      deleteUser,
    ),
    writeRoute(
      'directory.users.undelete',
      'POST',
      /^\/admin\/directory\/v1\/users\/(?<userKey>[^/]+)\/undelete$/,
      WRITE_SCOPES.user,
      undeleteUser,
    ),
    writeRoute(
      'directory.users.makeAdmin',
      'POST',
      /^\/admin\/directory\/v1\/users\/(?<userKey>[^/]+)\/makeAdmin$/,
      WRITE_SCOPES.user,
      makeAdmin,
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
