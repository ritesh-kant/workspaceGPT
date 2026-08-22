---
fileName: password-reset-flow-v2.md
url: https://wiki.example.com/password-reset-v2
---

# Password Reset Flow (current)

Current flow: user requests a reset, receives a one-time 15-minute link,
sets a new password, and every other session is invalidated. Requests are
throttled to 3 per hour per account to prevent abuse.
