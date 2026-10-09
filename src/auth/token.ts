import { randomBytes, verify } from 'node:crypto';
import type { Clock } from '../clock.ts';
import type { Domains } from '../domains.ts';
import type { ApiResponse, Call } from '../http/types.ts';
import type { Registry } from '../store/registry.ts';
import { findUser } from '../store/user-lookup.ts';
import { TOKEN_URI } from './scopes.ts';

const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const LIFETIME_SECONDS = 3599;
const TIMEFRAME =
  'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim.';

const oauthError = (
  status: number,
  error: string,
  description: string,
): ApiResponse => ({
  status,
  body: { error, error_description: description },
});

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

/** The JWT bearer grant with domain-wide delegation. */
export function handleToken(
  deps: { registry: Registry; domains: Domains; clock: Clock },
  call: Call,
): ApiResponse {
  const form = new URLSearchParams(call.request.body);
  const grantType = form.get('grant_type');
  if (grantType !== JWT_BEARER)
    return oauthError(
      400,
      'unsupported_grant_type',
      `Invalid grant_type: ${grantType ?? ''}`,
    );
  const parts = (form.get('assertion') ?? '').split('.');
  if (parts.length !== 3)
    return oauthError(400, 'invalid_grant', 'Bad Request');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decode(parts[0]);
    claims = decode(parts[1]);
  } catch {
    return oauthError(400, 'invalid_grant', 'Bad Request');
  }
  const account = deps.registry.serviceAccountByEmail(String(claims.iss ?? ''));
  if (!account)
    return oauthError(400, 'invalid_grant', 'Invalid grant: account not found');
  const signed =
    header.alg === 'RS256' &&
    verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      account.publicKey,
      Buffer.from(parts[2], 'base64url'),
    );
  if (!signed)
    return oauthError(400, 'invalid_grant', 'Invalid JWT Signature.');
  if (claims.aud !== TOKEN_URI)
    return oauthError(
      400,
      'invalid_grant',
      'Invalid JWT: Failed audience check.',
    );
  const now = deps.clock.now() / 1000;
  const { iat, exp } = claims;
  if (
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    exp - iat > 3600 ||
    exp < now ||
    iat > now + 300
  )
    return oauthError(400, 'invalid_grant', TIMEFRAME);
  const subject =
    typeof claims.sub === 'string' ? claims.sub.toLowerCase() : '';
  if (!subject)
    return oauthError(
      400,
      'invalid_request',
      'The mock requires a delegated subject in the sub claim.',
    );
  const customerId = deps.registry.domainForName(subject.split('@')[1] ?? '');
  const domain = customerId ? deps.domains.get(customerId) : undefined;
  if (!customerId || !domain || !findUser(domain.db, subject))
    return oauthError(400, 'invalid_grant', 'Invalid email or User ID');
  const requested = String(claims.scope ?? '')
    .split(' ')
    .filter(Boolean);
  if (requested.length === 0)
    return oauthError(
      400,
      'invalid_scope',
      'Empty or missing scope not allowed.',
    );
  const granted = call.overrides.grant(
    customerId,
    account.clientId,
    deps.registry.grant(customerId, account.clientId),
  );
  if (!granted || requested.some((scope) => !granted.includes(scope)))
    return oauthError(
      401,
      'unauthorized_client',
      'Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.',
    );
  const token = `ya29.mock.${randomBytes(32).toString('base64url')}`;
  deps.registry.saveToken({
    token,
    clientId: account.clientId,
    projectId: account.projectId,
    subject,
    customerId,
    scopes: requested,
    expiresAt: deps.clock.now() + LIFETIME_SECONDS * 1000,
  });
  return {
    status: 200,
    body: {
      access_token: token,
      expires_in: LIFETIME_SECONDS,
      token_type: 'Bearer',
    },
  };
}
