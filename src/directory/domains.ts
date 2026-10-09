import type { ApiResponse, Call } from '../http/types.ts';
import { rows } from '../store/sqlite.ts';
import { domainOf, resolveCustomer, withEtag } from './common.ts';

interface DomainRow {
  domain_name: string;
  is_primary: number;
  verified: number;
  creation_time: number;
  alias_of: string | null;
}

export function listDomains(call: Call): ApiResponse {
  const domain = domainOf(call);
  resolveCustomer(call, call.params.customer);
  const all = rows<DomainRow>(
    domain.db
      .prepare('SELECT * FROM domains ORDER BY is_primary DESC, creation_time')
      .all(),
  );
  const domains = all
    .filter((entry) => entry.alias_of === null)
    .map((entry) => {
      const aliases = all
        .filter((alias) => alias.alias_of === entry.domain_name)
        .map((alias) =>
          withEtag({
            kind: 'admin#directory#domainAlias',
            domainAliasName: alias.domain_name,
            parentDomainName: entry.domain_name,
            verified: alias.verified === 1,
            creationTime: String(alias.creation_time),
          }),
        );
      return withEtag({
        kind: 'admin#directory#domain',
        domainName: entry.domain_name,
        isPrimary: entry.is_primary === 1,
        verified: entry.verified === 1,
        creationTime: String(entry.creation_time),
        ...(aliases.length > 0 ? { domainAliases: aliases } : {}),
      });
    });
  return {
    status: 200,
    items: domains.length,
    body: withEtag({ kind: 'admin#directory#domains', domains }),
  };
}
