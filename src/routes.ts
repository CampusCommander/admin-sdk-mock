import { handleToken } from './auth/token.ts';
import { handleTokenInfo } from './auth/tokeninfo.ts';
import type { Route } from './http/types.ts';
import type { Mock } from './mock.ts';

const OAUTH = ['oauth2.googleapis.com'];

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
  ];
}
