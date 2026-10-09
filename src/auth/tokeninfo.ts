import type { Clock } from '../clock.ts';
import type { ApiResponse, Call } from '../http/types.ts';
import type { Registry } from '../store/registry.ts';

/** Report the scopes and lifetime of an access token. */
export function handleTokenInfo(
  deps: { registry: Registry; clock: Clock },
  call: Call,
): ApiResponse {
  const { request } = call;
  const bearer = /^Bearer\s+(\S+)$/i.exec(
    request.headers.authorization ?? '',
  )?.[1];
  const value =
    request.query.get('access_token') ??
    new URLSearchParams(request.body).get('access_token') ??
    bearer;
  const token = value ? deps.registry.token(value) : undefined;
  const now = deps.clock.now();
  if (!token || token.expiresAt <= now)
    return {
      status: 400,
      body: { error: 'invalid_token', error_description: 'Invalid Value' },
    };
  return {
    status: 200,
    body: {
      azp: token.clientId,
      aud: token.clientId,
      scope: token.scopes.join(' '),
      exp: String(Math.floor(token.expiresAt / 1000)),
      expires_in: String(Math.floor((token.expiresAt - now) / 1000)),
      access_type: 'online',
    },
  };
}
