# North Star — what we are building and why

> Read this before adding any feature. If a proposed feature doesn't serve the
> position below, it's scope creep — however cool it is.
>
> Decided 2026-08-15. Details: [CODING-AGENT-ROADMAP.md](CODING-AGENT-ROADMAP.md)
> (capabilities + strategy), [PHASES.md](PHASES.md) (sequencing),
> [REMOTE-MODE-SAAS-DESIGN.md](REMOTE-MODE-SAAS-DESIGN.md) (privacy/billing backbone).

## The one-liner

> **The coding agent that knows your whole org — and can prove it never stores
> your data.**

## The strategic frame

We can't out-Cursor Cursor — their moat is custom low-latency models and
capital. We can't out-Claude-Code Claude Code — its moat is being the lab's own
harness with frontier-model access. Competing feature-for-feature is a losing
race. But we have **three things neither offers together**, and two of them are
already built:

1. **Org-knowledge grounding.** Our agent can read the ADO ticket and the
   Confluence design page *mid-task*, not just the repo.
   **"Implement D2C-1234 → ticket → design doc → code → PR"** is a demo
   neither competitor can do out of the box. Cursor and Claude Code start from
   the repo and a prompt; we start from the org's actual context.
2. **Provable privacy.** Local mode is fully offline — no account, nothing
   leaves the machine. Remote mode stores nothing readable — client-side
   encryption means we physically cannot read customer code or documents.
   **Cursor's privacy mode is a policy; ours is architecture.** This is what
   wins regulated/enterprise teams.
3. **The deploy loop.** `release-core` (config-sync, hotfix → tag → release)
   means the agent participates in *shipping*, not just editing. No competitor
   touches this.

Each piece alone is copyable. The bundle is the positioning.

## Who it's for

Enterprise/regulated teams whose knowledge lives in Confluence/ADO and whose
security teams veto tools that hold code server-side.

## Explicit non-goals (v1–v2)

- **Tab completion** — requires a custom FIM model served at <100 ms; that is
  Cursor's actual moat, and a bad version is worse than none.
- **Custom/trained models** — we route to the best frontier models server-side
  instead.
- **An IDE fork** — stay an extension: zero switching cost, and forks
  (Antigravity etc. via Open VSX) are our distribution channel, not our
  competitor.

## The two modes (product identities, not settings)

- **Local = free tier and trust anchor.** Fully offline, sacred: no network
  dependency, no account, no telemetry — ever.
- **Remote = the business.** Managed models + managed encrypted index, one
  subscription key, zero readable content at rest on our side.
