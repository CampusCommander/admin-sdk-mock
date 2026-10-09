import { sign } from 'node:crypto';

/** Sign a JWT bearer assertion the way google-auth-library does. */
export function signAssertion(
  account: {
    client_email: string;
    private_key: string;
    private_key_id: string;
  },
  claims: Record<string, unknown>,
  now = Date.now(),
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: account.private_key_id };
  const seconds = Math.floor(now / 1000);
  const body = {
    iss: account.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: seconds,
    exp: seconds + 3600,
    ...claims,
  };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode(header)}.${encode(body)}`;
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), account.private_key).toString('base64url')}`;
}

export function tokenRequestBody(assertion: string): string {
  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString();
}
