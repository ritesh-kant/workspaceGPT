# Desktop work homepage

The desktop Work empty state is a viewport-sized overview, with a remembered
Board / Inbox preference. VS Code retains its sidebar layout. Tickets reuse
the existing tracker provider and autonomous ticket-start flow, including
the default-folder guard. An exact ticket source URL in session history
enables Continue; ticket numbers alone never match sessions across projects.

Board shows up to three tickets, two PRs, and one mention. Available height
reduces the row budget; short or narrow windows use category tabs. Inbox
prioritizes requested changes, review requests, unread mentions, and tickets.
View all opens a separate paginated dialog. The composer stays compact until
focused, where Chat / Work and the existing model/permission controls appear.
The composer stays expanded throughout pointer/menu interactions and while a
draft, attachments, or Full access confirmation is present. Pointer clicks on
macOS do not always focus buttons; losing text-field focus must not hide controls
before their click runs. Leaving an empty composer collapses it again.
Soft cards give tickets a subtle theme-derived tint, rounded corners, shadow,
and hover highlight. PRs and mentions sit on quiet raised surfaces. Reduced
motion disables ticket lift. PR views use a quiet selected background. The
board, Knowledge status, folder controls, and composer share one centered
1180px maximum column, including the desktop skin's gutter overrides. Source dots mean green for connected,
amber for not connected or refreshing, and red for a connected source needing
refresh attention; tooltips and accessible labels explain each state. Refresh
text keeps its full width. A single contextual tip appears only when measured
spare space allows it, without expanding or scrolling the overview.

## Connections

Jira and Azure DevOps are mutually exclusive. Enabling either disables the
other without deleting its saved configuration or credentials. Existing
settings with both enabled normalize to Azure DevOps, matching the host's
existing registry precedence. Confluence can accompany either tracker.

First use preserves all three section headings with static placeholders and
Connect to enable labels. A tracker chooser presents Jira **or** Azure DevOps;
Confluence is independent. A disconnected source, a connected source with no
activity, a pending query, and a failed refresh are separate states.

Azure DevOps PRs come from the connected project's active PR API, filtered
by creator/reviewer identity. Jira users can read their GitHub PRs through
an existing GitHub CLI sign-in (`gh auth login`). Jira itself supplies no
PR API. Bitbucket, GitLab, and GitHub Enterprise-specific setup flows are
not included in this change. Opening PRs and mentions uses the existing
host HTTP(S)-only external-link handler. Review with agent starts a work
session requesting a review brief; it does not submit a review.

## Activity lifecycle

A small accent dot means the item's revision differs from its last viewed
revision. Reading clears the dot. These fingerprints, identifiers, and the
layout preference stay on-device; no activity content or credentials are
sent to analytics or added to settings.

Read mentions remain in position during the current Home visit. They leave
the summary on the next visit, remain available under Include read mentions,
and return when their revision changes or the user marks them unread.
Own approved PRs remain visible while open. Submitted reviews leave To review;
merged/closed PRs leave both lists on refresh. Approval describes reviewer
votes, not CI/policy success or guaranteed merge readiness.

Sections refresh independently on entry, explicit refresh, window focus after
two minutes, and every five minutes while Home is visible. Failed refreshes
preserve usable results and report staleness. Tracker switches discard old
responses and invalidate incompatible ticket caches. Confluence reconnects
receive a new read-state namespace so accounts on one site don't share read
mention state.

## Coverage and verification

Mentions are a bounded recent-activity view, not a complete notification inbox:
Jira/ADO scan comments on the 30 most recently updated tickets in the connected
project over 30 days, with up to 100 comments per ticket and four concurrent
requests. Mention detection uses account IDs, never display-name text.
Confluence searches current-user mentions in the connected space over 30 days,
up to 50 results. Its page results identify content mentioning the user; they
do not identify who originally inserted a mention. The UI labels those as
pages mentioning you. Full lists explain query coverage. Providers report
truncation and partial failures instead of claiming an exhaustive result.

PR lists are bounded at 100 per Azure DevOps query and 50 per GitHub query.
Activity content remains in webview memory; only read fingerprints persist.
Requests time out and refuse auth-bearing redirects. No live corporate
accounts are used by the automated tests.

Run `pnpm --filter @workspace-gpt/agent-evals home-units` for provider identity,
review state, read persistence, account switching, safe links, partial failure,
and first-use regression checks. Browser checks also cover small viewport
layouts, Board / Inbox, pagination, and read-mention behavior against fixtures.
