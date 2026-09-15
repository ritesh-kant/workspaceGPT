---
fileName: JIRA-ENG-4903
url: https://jira.example.com/browse/ENG-4903
---

# CSV import silently truncates rows over 10k

The bulk contacts importer caps at 10,000 rows with no warning or error — anything past that line is dropped without telling the uploader. Should either paginate the import or surface a clear truncation message.
