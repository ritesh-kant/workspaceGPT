---
fileName: JIRA-ENG-5088
url: https://jira.example.com/browse/ENG-5088
---

# Memory leak in websocket connection pool

Long-running sessions grow unbounded RSS over a few days. Each reconnect creates a new pool entry but the old, dead socket's listeners are never removed, so they pile up and pin the closed connection's buffers in memory.
