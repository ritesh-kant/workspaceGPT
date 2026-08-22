---
fileName: local-dev-environment-setup.md
url: https://wiki.example.com/local-dev-setup
---

# Local Dev Environment Setup

Clone the monorepo, run the bootstrap script, and copy .env.example to .env.
The bootstrap script installs dependencies for every workspace and seeds a
local database with fixture data. Most services hot-reload on save; the
worker processes need a manual restart.
