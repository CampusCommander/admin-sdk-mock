import type { ApiResponse, Call } from '../http/types.ts';
import { DAY_MS } from '../seed/context.ts';
import { domainOf, resolveCustomer, withEtag } from './common.ts';

export function getCustomer(call: Call): ApiResponse {
  const domain = domainOf(call);
  const customerId = resolveCustomer(call, call.params.customerKey);
  const { spec, record } = domain;
  return {
    status: 200,
    items: 1,
    body: withEtag({
      kind: 'admin#directory#customer',
      id: customerId,
      customerDomain: spec.primaryDomain,
      alternateEmail: `it-admin@${spec.slug}-backup.test`,
      customerCreationTime: new Date(
        record.seededAt - 3000 * DAY_MS,
      ).toISOString(),
      language: 'en',
      phoneNumber: '+15555550100',
      postalAddress: {
        contactName: 'Technology Department',
        organizationName: spec.districtName,
        addressLine1: '100 Main Street',
        addressLine2: 'Suite 200',
        locality: spec.districtName.split(' ')[0],
        region: 'IL',
        postalCode: '60601',
        countryCode: 'US',
      },
    }),
  };
}
