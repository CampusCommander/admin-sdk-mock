import { handleBatch } from './batch/batch.ts';
import { handleToken } from './auth/token.ts';
import { handleTokenInfo } from './auth/tokeninfo.ts';
import { SCOPES, WRITE_SCOPES } from './auth/scopes.ts';
import { getTelemetry, listTelemetry } from './chrome/telemetry.ts';
import { getCustomer } from './directory/customers.ts';
import { getCommand, issueCommand } from './directory/commands.ts';
import {
  batchChangeStatus,
  moveDevicesToOu,
  updateDevice,
} from './directory/device-writes.ts';
import { getDevice, listDevices } from './directory/devices.ts';
import { listDomains } from './directory/domains.ts';
import {
  deleteOrgUnit,
  insertOrgUnit,
  updateOrgUnit,
} from './directory/orgunit-writes.ts';
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
import { directoryRoute, writeRoute } from './route-helpers.ts';
import { groupRoutes } from './directory/group-routes.ts';
import { memberRoutes } from './directory/member-routes.ts';
import type { Mock } from './mock.ts';

const OAUTH = ['oauth2.googleapis.com'];
const DEVICE =
  /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/devices\/chromeos\/(?<deviceId>[^/]+)$/;

const USER = /^\/admin\/directory\/v1\/users\/(?<userKey>[^/]+)$/;
const ORGUNIT =
  /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/orgunits\/(?<orgUnitPath>.+)$/;

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
      ORGUNIT,
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
      DEVICE,
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
    writeRoute(
      'directory.orgunits.insert',
      'POST',
      /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/orgunits$/,
      WRITE_SCOPES.orgunit,
      insertOrgUnit,
    ),
    writeRoute(
      'directory.orgunits.update',
      'PUT',
      ORGUNIT,
      WRITE_SCOPES.orgunit,
      updateOrgUnit,
    ),
    writeRoute(
      'directory.orgunits.patch',
      'PATCH',
      ORGUNIT,
      WRITE_SCOPES.orgunit,
      updateOrgUnit,
    ),
    writeRoute(
      'directory.orgunits.delete',
      'DELETE',
      ORGUNIT,
      WRITE_SCOPES.orgunit,
      deleteOrgUnit,
    ),
    writeRoute(
      'directory.chromeosdevices.update',
      'PUT',
      DEVICE,
      WRITE_SCOPES.device,
      updateDevice,
    ),
    writeRoute(
      'directory.chromeosdevices.patch',
      'PATCH',
      DEVICE,
      WRITE_SCOPES.device,
      updateDevice,
    ),
    writeRoute(
      'directory.chromeosdevices.moveDevicesToOu',
      'POST',
      /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/devices\/chromeos\/moveDevicesToOu$/,
      WRITE_SCOPES.device,
      moveDevicesToOu,
    ),
    writeRoute(
      'directory.chromeos.batchChangeStatus',
      'POST',
      /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/devices\/chromeos(?::|%3[Aa])batchChangeStatus$/,
      WRITE_SCOPES.device,
      batchChangeStatus,
    ),
    writeRoute(
      'directory.chromeos.issueCommand',
      'POST',
      /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/devices\/chromeos\/(?<deviceId>[^/:]+?)(?::|%3[Aa])issueCommand$/,
      WRITE_SCOPES.device,
      issueCommand,
    ),
    directoryRoute(
      'directory.chromeos.commands.get',
      /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/devices\/chromeos\/(?<deviceId>[^/]+)\/commands\/(?<commandId>[^/]+)$/,
      SCOPES.device,
      getCommand,
    ),
    ...groupRoutes(),
    ...memberRoutes(),
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
