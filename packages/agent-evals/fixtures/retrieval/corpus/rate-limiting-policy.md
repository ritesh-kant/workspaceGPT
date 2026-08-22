---
fileName: rate-limiting-policy.md
url: https://wiki.example.com/rate-limiting
---

# Rate Limiting Policy

The public API allows 100 requests per minute per API key, with a burst
allowance of 20. Exceeding the limit returns HTTP 429 with a Retry-After
header. Enterprise plans can request a higher limit through account
management.
