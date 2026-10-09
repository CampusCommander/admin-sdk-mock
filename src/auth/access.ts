import {
  insufficientScopes,
  notAuthorized,
  unauthenticated,
} from '../http/errors.ts';
import type { Authenticator } from '../http/types.ts';
import type { Mock } from '../mock.ts';
import { findUser } from '../store/user-lookup.ts';

/** Check the bearer token, its scopes, and the subject's administrator rights. */
export function createAuthenticator(mock: Mock): Authenticator {
  return {
    authenticate(request, route) {
      const value = /^Bearer\s+(\S+)$/i.exec(
        request.headers.authorization ?? '',
      )?.[1];
      if (!value) return unauthenticated(route.api, 'missing');
      const token = mock.registry.token(value);
      if (!token || token.expiresAt <= mock.clock.now())
        return unauthenticated(route.api, 'invalid');
      const domain = mock.domains.get(token.customerId);
      if (!domain) return unauthenticated(route.api, 'invalid');
      if (!token.scopes.some((scope) => route.scopes.includes(scope)))
        return insufficientScopes(route.api);
      const user = findUser(domain.db, token.subject);
      const isAdmin = mock.overrides.isAdmin(
        token.customerId,
        token.subject,
        user?.is_admin === 1,
      );
      if (route.admin && !isAdmin) return notAuthorized(route.api);
      return {
        access: {
          token,
          customerId: token.customerId,
          subject: token.subject,
          isAdmin,
        },
        domain,
      };
    },
  };
}
