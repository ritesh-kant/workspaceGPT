---
fileName: deployment-pipeline.md
url: https://wiki.example.com/deployment-pipeline
---

# Deployment Pipeline

Every merge to main triggers a build, a full test suite run, and a canary
deploy to 5% of production traffic. If error rates stay flat for 15 minutes
the canary promotes automatically to 100%. Rollbacks are a single click in
the deploy dashboard and take under two minutes.
