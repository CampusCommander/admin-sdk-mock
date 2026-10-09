import type { Observation } from './compare.ts';

const P = 'https://www.googleapis.com/auth/admin.directory.';
export const PARITY_SCOPES = {
  customer: `${P}customer.readonly`,
  domain: `${P}domain.readonly`,
  orgunit: `${P}orgunit.readonly`,
  ungranted: `${P}group.readonly`,
};

export interface RequestInput {
  host: string;
  path: string;
  method?: string;
  query?: Record<string, string>;
  token?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** One side of the comparison: real Google or the mock. */
export interface Transport {
  token(scope: string): Promise<Observation>;
  request(input: RequestInput): Promise<Observation>;
}

const D = '/admin/directory/v1';
const ADMIN = 'admin.googleapis.com';

async function bearer(transport: Transport, scope: string): Promise<string> {
  const response = await transport.token(scope);
  const token = (response.body as { access_token?: string }).access_token;
  if (!token)
    throw new Error(
      `The token exchange for ${scope} answered ${response.status}.`,
    );
  return token;
}

export interface Probe {
  name: string;
  run(transport: Transport): Promise<Observation>;
}

export const PROBES: readonly Probe[] = [
  { name: 'token.granted', run: (t) => t.token(PARITY_SCOPES.orgunit) },
  { name: 'token.ungranted', run: (t) => t.token(PARITY_SCOPES.ungranted) },
  {
    name: 'tokeninfo',
    run: async (t) =>
      t.request({
        host: 'oauth2.googleapis.com',
        path: '/tokeninfo',
        method: 'POST',
        headers: {
          authorization: `Bearer ${await bearer(t, PARITY_SCOPES.orgunit)}`,
        },
      }),
  },
  {
    name: 'customers.get',
    run: async (t) =>
      t.request({
        host: ADMIN,
        path: `${D}/customers/my_customer`,
        token: await bearer(t, PARITY_SCOPES.customer),
      }),
  },
  {
    name: 'domains.list',
    run: async (t) =>
      t.request({
        host: ADMIN,
        path: `${D}/customer/my_customer/domains`,
        token: await bearer(t, PARITY_SCOPES.domain),
      }),
  },
  {
    name: 'domains.list.badFields',
    run: async (t) =>
      t.request({
        host: ADMIN,
        path: `${D}/customer/my_customer/domains`,
        query: { fields: 'bogusField' },
        token: await bearer(t, PARITY_SCOPES.domain),
      }),
  },
  {
    name: 'orgunits.list.allIncludingParent',
    run: async (t) =>
      t.request({
        host: ADMIN,
        path: `${D}/customer/my_customer/orgunits`,
        query: { type: 'all_including_parent' },
        token: await bearer(t, PARITY_SCOPES.orgunit),
      }),
  },
  {
    name: 'orgunits.list.children',
    run: async (t) =>
      t.request({
        host: ADMIN,
        path: `${D}/customer/my_customer/orgunits`,
        token: await bearer(t, PARITY_SCOPES.orgunit),
      }),
  },
  {
    name: 'orgunits.get.missing',
    run: async (t) =>
      t.request({
        host: ADMIN,
        path: `${D}/customer/my_customer/orgunits/Parity%20Missing%20Unit`,
        token: await bearer(t, PARITY_SCOPES.orgunit),
      }),
  },
  {
    name: 'orgunits.list.otherCustomer',
    run: async (t) =>
      t.request({
        host: ADMIN,
        path: `${D}/customer/C00000000/orgunits`,
        token: await bearer(t, PARITY_SCOPES.orgunit),
      }),
  },
  {
    name: 'orgunits.list.noToken',
    run: (t) =>
      t.request({ host: ADMIN, path: `${D}/customer/my_customer/orgunits` }),
  },
  {
    name: 'orgunits.list.badToken',
    run: (t) =>
      t.request({
        host: ADMIN,
        path: `${D}/customer/my_customer/orgunits`,
        token: 'ya29.parity-invalid-token',
      }),
  },
  {
    name: 'customers.get.wrongScope',
    run: async (t) =>
      t.request({
        host: ADMIN,
        path: `${D}/customers/my_customer`,
        token: await bearer(t, PARITY_SCOPES.orgunit),
      }),
  },
  {
    name: 'chromeosdevices.list.wrongScope',
    run: async (t) =>
      t.request({
        host: ADMIN,
        path: `${D}/customer/my_customer/devices/chromeos`,
        token: await bearer(t, PARITY_SCOPES.orgunit),
      }),
  },
  {
    name: 'users.list.wrongScope',
    run: async (t) =>
      t.request({
        host: ADMIN,
        path: `${D}/users`,
        query: { customer: 'my_customer' },
        token: await bearer(t, PARITY_SCOPES.orgunit),
      }),
  },
  {
    name: 'telemetry.list.wrongScope',
    run: async (t) =>
      t.request({
        host: 'chromemanagement.googleapis.com',
        path: '/v1/customers/my_customer/telemetry/devices',
        query: { readMask: 'deviceId' },
        token: await bearer(t, PARITY_SCOPES.orgunit),
      }),
  },
  {
    name: 'batch.orgunits',
    run: async (t) => {
      const token = await bearer(t, PARITY_SCOPES.orgunit);
      const list = await t.request({
        host: ADMIN,
        path: `${D}/customer/my_customer/orgunits`,
        query: { type: 'all' },
        token,
      });
      const unit = ((
        list.body as { organizationUnits?: { orgUnitPath: string }[] }
      ).organizationUnits ?? [])[0];
      const existing = unit
        ? unit.orgUnitPath.slice(1).split('/').map(encodeURIComponent).join('/')
        : 'Parity%20Missing%20Unit';
      const part = (id: string, path: string) =>
        `--parity\r\nContent-Type: application/http\r\nContent-ID: <${id}>\r\n\r\nGET ${D}/customer/my_customer/orgunits/${path}\r\n\r\n`;
      const response = await t.request({
        host: 'www.googleapis.com',
        path: '/batch/admin/directory_v1',
        method: 'POST',
        token,
        headers: { 'content-type': 'multipart/mixed; boundary=parity' },
        body: `${part('one', existing)}${part('two', 'Parity%20Missing%20Unit')}--parity--\r\n`,
      });
      const text = String(response.body);
      const PART =
        /Content-ID: <([^>]+)>(?:\r?\n[^\r\n]+)*\r?\n\r?\nHTTP\/1\.1 (\d{3})[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)\r?\n--/g;
      const parts = [...text.matchAll(PART)].map((match) => {
        let body: unknown = match[3];
        try {
          body = JSON.parse(match[3]);
        } catch {
          /* The part body is not JSON. */
        }
        return { contentId: match[1], status: Number(match[2]), body };
      });
      return { status: response.status, body: { parts } };
    },
  },
];
