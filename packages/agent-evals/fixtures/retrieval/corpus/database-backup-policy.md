---
fileName: database-backup-policy.md
url: https://wiki.example.com/db-backups
---

# Database Backup Policy

Production databases are snapshotted every six hours with a 30-day retention
window. Point-in-time recovery is available for the last 7 days via the
transaction log. Restores should be tested quarterly in the staging
environment to confirm the backups are actually usable.
