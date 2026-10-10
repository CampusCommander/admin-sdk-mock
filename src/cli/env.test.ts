import assert from 'node:assert/strict';
import test from 'node:test';
import { formatEnvironment } from './env.ts';

const vars = {
  HTTPS_PROXY: 'http://127.0.0.1:3128',
  SSL_CERT_FILE: "/tmp/it's/ca.pem",
};

test('formats the client environment for each target', () => {
  assert.equal(
    formatEnvironment(vars, 'sh'),
    "export HTTPS_PROXY='http://127.0.0.1:3128'\nexport SSL_CERT_FILE='/tmp/it'\\''s/ca.pem'\n",
  );
  assert.equal(
    formatEnvironment(vars, 'dotenv'),
    'HTTPS_PROXY=http://127.0.0.1:3128\nSSL_CERT_FILE="/tmp/it\'s/ca.pem"\n',
  );
  assert.deepEqual(JSON.parse(formatEnvironment(vars, 'json')), vars);
  assert.equal(
    formatEnvironment(vars, 'github'),
    "HTTPS_PROXY=http://127.0.0.1:3128\nSSL_CERT_FILE=/tmp/it's/ca.pem\n",
  );
});

test('quotes dotenv values that need it and rejects a newline for GitHub', () => {
  assert.equal(
    formatEnvironment(
      {
        A: 'a b',
        B: 'say "hi"',
        C: 'x#y',
        D: '$HOME',
        E: 'C:\\path',
        F: 'C:\\my path',
      },
      'dotenv',
    ),
    'A="a b"\nB="say \\"hi\\""\nC="x#y"\nD="$HOME"\nE=C:\\path\nF="C:\\\\my path"\n',
  );
  assert.throws(
    () => formatEnvironment({ A: 'one\ntwo' }, 'github'),
    /GITHUB_ENV cannot hold a value with a newline: A\./,
  );
});
