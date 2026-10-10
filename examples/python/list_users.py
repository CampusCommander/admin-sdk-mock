import os
import sys

from google.oauth2 import service_account
from googleapiclient.discovery import build

key_file = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
subject = os.environ.get("ADMIN_SUBJECT")
if not key_file or not subject:
    sys.exit(
        "Set GOOGLE_APPLICATION_CREDENTIALS to the key file and ADMIN_SUBJECT to the administrator email."
    )

credentials = service_account.Credentials.from_service_account_file(
    key_file,
    scopes=["https://www.googleapis.com/auth/admin.directory.user.readonly"],
    subject=subject,
)
directory = build(
    "admin", "directory_v1", credentials=credentials, static_discovery=True
)
result = directory.users().list(customer="my_customer", maxResults=5).execute()
for user in result.get("users", []):
    print(user["primaryEmail"])
