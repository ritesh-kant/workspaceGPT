---
fileName: api-key-rotation.md
url: https://wiki.example.com/api-key-rotation
---

# API Key Rotation

To rotate an API key, generate a new key in the Settings > Credentials panel,
update every service that consumes it, then revoke the old key after
confirming the new one is live in production. Keys should be rotated every
90 days per the security policy. Never commit a raw key to source control —
use the secrets manager instead.
