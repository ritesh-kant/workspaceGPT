---
fileName: feature-flag-guidelines.md
url: https://wiki.example.com/feature-flags
---

# Feature Flag Guidelines

Every new feature ships behind a flag defaulted to off. Flags should be
removed within one release cycle of reaching 100% rollout — a codebase
survey found flags left in for over a year account for a third of dead code.
Use the naming convention team-feature-shortdesc.
