---
fileName: JIRA-ENG-5203
url: https://jira.example.com/browse/ENG-5203
---

# Search autocomplete returns stale results after rename

Renaming a project doesn't invalidate the autocomplete cache, so search suggestions keep showing the old name for up to an hour after the rename.
