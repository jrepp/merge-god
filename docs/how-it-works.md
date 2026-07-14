---
title: How it works
description: The gather → prompt → act pipeline that turns PR context into autonomous merges.
group: Guides
order: 12
---

merge-god's job is to give the agent **everything it needs** to land a PR, then
let it act. The pipeline is three stages.

## Reviewer updates

Merge God puts the requested action first when it needs help. Reviewer-facing
comments use this order:

1. **Problem** — the specific PR, file, or check that stopped progress.
2. **Required action** — one direct instruction that names the next owner and
   completion condition.
3. **Checks** — a short result table.
4. **Technical details** — optional evidence in a collapsed section.

PR comments never cite a machine-local path or opaque run reference as reviewer
evidence. Locally generated logs and reports must be attached to the PR or
published as a reviewer-accessible CI/forge artifact before the comment links
to them. Credentials, query parameters, home-directory paths, and email
addresses are removed from published reviewer text.

Internal state-machine names do not lead reviewer comments. The dashboard and
CLI use **merge group** for a set of PRs tested together, **step** for the current
operation, and **maintainer decision needed** when automation cannot choose the
intended behavior safely.

## 1. Gather

Before touching anything, `pr-loop.ts` builds a complete picture of each PR:

- **Metadata** — title, description, author, dates, branch names, stats
- **Discussion & reviews** — every comment and inline code-review thread (with
  file paths and line numbers)
- **Commit history** — the full set of commits in the PR
- **Changed files** — with per-file additions/deletions
- **Merge conflicts** — proactive detection against `origin/main`, including
  the exact files that conflict
- **CI/CD status** — every check (passed / failed / pending) with failure
  details and links
- **Review decision** — approved, changes requested, or pending
- **Diff availability** — the full diff when the forge provides it, or an
  explicit unavailable/truncated record when the diff is too large
- **Merge blockers** — review, CI, conflict, diff, and merge-state blockers
- **Queue lineage** — for aggregate queue PRs, constituent PRs, merge commits,
  and validation evidence

It also **syncs with `origin/main`** first, so the agent works against the
latest state.

## 2. Prompt

All of that is assembled into one comprehensive markdown prompt with a
**prioritized mission**:

1. Resolve merge conflicts (if any)
2. Address code reviews
3. Fix failing CI
4. Preserve queue lineage and validation evidence for aggregate merge queues
5. _(optional, for `for-review`)_ Improve quality, security, and best practices

The prompt also includes project contribution guidelines (or style learned from
commit history) and critical rules — e.g. focused commits, professional
messages, no branding noise.

> You can inspect a complete, real prompt in [prompt-example.md](./prompt-example.md).

## 3. Act

The prompt is published to the **merge-god coordination API**, then pi is
launched with the `merge-god` extension. The agent calls the `mg_context`
tool to pull the prompt, does the work with its file/shell tools, then reports
back with `mg_complete`. merge-god reads the result and advances:

## Two-pass review

PRs labeled `for-review` get an extra pass after the landing pass:

- **Pass 1** — get it mergeable (conflicts, reviews, CI).
- **Pass 2** — a focused code review for quality, security, performance, and
  best practices, producing targeted improvement commits.

This keeps landing fast while still giving important PRs a thorough review.

## Merge queues

Aggregate queue PRs need extra context because the final branch represents
multiple source PRs. merge-god records queue lineage, merge commits, validation
evidence, and unresolved blockers as structured context instead of relying only
on PR comments. See [Agent-managed merge queues](./merge-queues/) for the queue
domain model and current implementation boundary.

## Why an agent, not rules?

Merge conflicts, review feedback, and CI failures are open-ended. A rules-based
bot can only merge green PRs; an agent can actually resolve the blockers. By
front-loading exhaustive, structured context, merge-god keeps the agent's work
predictable and reviewable.
