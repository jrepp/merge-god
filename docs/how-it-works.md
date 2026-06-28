---
title: How it works
description: The gather → prompt → act pipeline that turns PR context into autonomous merges.
group: Guides
order: 12
---

merge-god's job is to give the agent **everything it needs** to land a PR, then
let it act. The pipeline is three stages.

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
- **Full diff** — the complete code change

It also **syncs with `origin/main`** first, so the agent works against the
latest state.

## 2. Prompt

All of that is assembled into one comprehensive markdown prompt with a
**prioritized mission**:

1. Resolve merge conflicts (if any)
2. Address code reviews
3. Fix failing CI
4. _(optional, for `for-review`)_ Improve quality, security, and best practices

The prompt also includes project contribution guidelines (or style learned from
commit history) and critical rules — e.g. focused commits, professional
messages, no branding noise.

> You can inspect a complete, real prompt in [prompt-example.md](./prompt-example.md).

## 3. Act

The prompt is published to the **merge-god coordination API**, then pi is
launched with the `merge-god` extension. The agent calls the `merge_god_context`
tool to pull the prompt, does the work with its file/shell tools, then reports
back with `merge_god_complete`. merge-god reads the result and advances:

## Two-pass review

PRs labeled `for-review` get an extra pass after the landing pass:

- **Pass 1** — get it mergeable (conflicts, reviews, CI).
- **Pass 2** — a focused code review for quality, security, performance, and
  best practices, producing targeted improvement commits.

This keeps landing fast while still giving important PRs a thorough review.

## Why an agent, not rules?

Merge conflicts, review feedback, and CI failures are open-ended. A rules-based
bot can only merge green PRs; an agent can actually resolve the blockers. By
front-loading exhaustive, structured context, merge-god keeps the agent's work
predictable and reviewable.
