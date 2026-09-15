---
fileName: JIRA-ENG-4821
url: https://jira.example.com/browse/ENG-4821
---

# OAuth token refresh race condition

Two concurrent requests near token expiry both trigger a refresh, and the second refresh invalidates the first, logging the user out mid-session. Needs a single-flight lock around the refresh call.
