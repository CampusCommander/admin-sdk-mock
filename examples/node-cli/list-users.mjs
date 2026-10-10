import { admin } from '@googleapis/admin';
import { GoogleAuth } from 'google-auth-library';

const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const subject = process.env.ADMIN_SUBJECT;
if (!keyFile || !subject) {
  console.error(
    'Set GOOGLE_APPLICATION_CREDENTIALS to the key file and ADMIN_SUBJECT to the administrator email.',
  );
  process.exit(1);
}

const auth = new GoogleAuth({
  keyFile,
  scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
  clientOptions: { subject },
});
const directory = admin({ version: 'directory_v1', auth });
const { data } = await directory.users.list({
  customer: 'my_customer',
  maxResults: 5,
});
for (const user of data.users ?? []) console.log(user.primaryEmail);
