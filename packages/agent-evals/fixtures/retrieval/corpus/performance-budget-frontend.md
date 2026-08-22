---
fileName: performance-budget-frontend.md
url: https://wiki.example.com/perf-budget
---

# Frontend Performance Budget

The main bundle must stay under 250KB gzipped and the largest contentful
paint under 2.5 seconds on a throttled 4G connection. CI fails the build if
either budget is exceeded, with an explicit override required to merge
anyway.
