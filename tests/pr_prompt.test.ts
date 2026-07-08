import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildIssuePrompt, buildPrPrompt, buildReviewPrompt } from "../pr_prompt";
import { REVIEW_GATE_CACHE_MARKER } from "../review_gate_cache";

describe("PR prompt model", () => {
  test("renders PR prompts from gathered context without side effects", () => {
    const prompt = buildPrPrompt(
      {
        number: 183,
        title: "Agent-managed queue",
        body: "Queue integration for API and UI",
        author: { login: "octocat" },
        headRefName: "queue/api-ui",
        baseRefName: "main",
        additions: 42,
        deletions: 7,
        changedFiles: 3,
        reviewDecision: "CHANGES_REQUESTED",
      },
      {
        url: "https://github.example.test/org/repo/pull/183",
        diff_availability: { available: false, source: "gh pr diff", error: "too large" },
        merge_blockers: [
          { kind: "queue_validation_failed", status: "blocked", summary: "npm test failed for #201" },
        ],
        queue_context: {
          is_queue: true,
          strategy: "merge_commits",
          constituent_prs: [{ number: 201 }, { number: 202 }],
          merge_commits: [{ sha: "abc201" }],
          validation_evidence: [{ scope: "#201", status: "failed" }],
        },
        conflicts: { has_conflicts: true, conflicting_files: ["packages/api/src/index.ts"] },
        ci_status: {
          total_checks: 2,
          passed: 1,
          failed: 1,
          pending: 0,
          skipped: 0,
          failed_checks: [{ name: "npm test", conclusion: "failure", details_url: "https://ci.example.test/1" }],
        },
        review_comments: [
          { user: { login: "reviewer" }, body: "Please cover the queue case.", path: "src/queue.ts", line: 12 },
        ],
        comments: [{ user: { login: "maintainer" }, body: "Use the existing parser." }],
        files: [{ filename: "src/queue.ts", status: "modified", additions: 10, deletions: 2 }],
        commits: [{ sha: "abcdef123", commit: { message: "Merge PR #201\n\nbody" } }],
      },
      "Run npm test before pushing.",
      "feat: prior commit",
      "Source: `.merge-rules.yaml`",
    );

    assert.match(prompt, /^# PR #183: Agent-managed queue/);
    assert.match(prompt, /\*\*Author\*\*: octocat/);
    assert.match(prompt, /\*\*Files changed\*\*: 3/);
    assert.match(prompt, /\*\*Additions\*\*: \+42/);
    assert.match(prompt, /\*\*Deletions\*\*: -7/);
    assert.match(prompt, /## Diff Availability/);
    assert.match(prompt, /\*\*Constituent PRs\*\*: #201, #202/);
    assert.match(prompt, /RESOLVE MERGE CONFLICTS/);
    assert.match(prompt, /Sync with `main` using a merge commit/);
    assert.match(prompt, /Prefer merge commits over rebasing/);
    assert.match(prompt, /Merge through GitHub with a merge commit/);
    assert.match(prompt, /unset ambient `ZAI_API_KEY`/);
    assert.match(prompt, /Address ALL 1 code review comments/);
    assert.match(prompt, /Fix ALL 1 failing CI checks/);
    assert.match(prompt, /Run npm test before pushing\./);
    assert.match(prompt, /Source: `\.merge-rules\.yaml`/);
  });

  test("infers missing queue context before rendering PR prompts", () => {
    const prompt = buildPrPrompt(
      {
        number: 300,
        title: "Merge queue: PRs #201 and #202",
        author: { login: "octocat" },
        headRefName: "queue/missing-context",
        baseRefName: "main",
        reviewDecision: "APPROVED",
      },
      {
        comments: [
          {
            html_url: "comment:validation",
            body: "- #201 `npm test` -> failed",
          },
        ],
        review_comments: [],
        commits: [],
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        merge_blockers: [],
      },
      "",
      "",
      "",
    );

    assert.match(prompt, /## Merge Queue Context/);
    assert.match(prompt, /\*\*Constituent PRs\*\*: #201, #202/);
    assert.match(prompt, /\*\*Unresolved queue blockers\*\*: 1/);
    assert.match(prompt, /Queue constituent PR #201 has 1 failed or blocked validation evidence item\(s\)\./);
  });

  test("renders supplemental PR detail and comment blockers in PR prompts", () => {
    const prompt = buildPrPrompt(
      {
        number: 301,
        title: "Supplemental blockers",
        author: { login: "octocat" },
        headRefName: "feature/supplemental-blockers",
        baseRefName: "main",
        isDraft: true,
        mergeStateStatus: "BEHIND",
        labels: ["for-review", "do not merge"],
        reviewDecision: "APPROVED",
      },
      {
        comments: [
          {
            html_url: "comment:manual-gate",
            body: "merge-god: blocked waiting on release",
          },
        ],
        review_comments: [],
        conflicts: { has_conflicts: false, conflicting_files: [] },
        ci_status: { total_checks: 1, failed: 0, pending: 0, unknown: 0, passed: 1 },
        diff_availability: { available: true },
        merge_blockers: [],
      },
      "",
      "",
      "",
    );

    assert.match(prompt, /## Merge Blockers/);
    assert.match(prompt, /\*\*draft\*\* \(blocked\): GitHub reports this PR is still marked as draft\./);
    assert.match(prompt, /\*\*external_gate\*\* \(blocked\): Label 'do not merge' marks this PR as blocked for landing\./);
    assert.match(prompt, /\*\*external_gate\*\* \(blocked\): Manual merge gate is blocked: waiting on release\./);
    assert.match(prompt, /\*\*merge_state_blocked\*\* \(pending\): GitHub reports the PR merge state as BEHIND\./);
  });

  test("renders cached PR context aliases with shared domain normalization", () => {
    const prompt = buildPrPrompt(
      {
        pr_number: "185",
        name: "Cached queue replay",
        description: "Replay stored context",
        author: { username: "octocat" },
        sourceBranch: "queue/replay",
        base_branch: "develop",
        htmlUrl: "https://github.example.test/org/repo/pull/185",
        additions_count: "3",
        deletionsCount: "1",
        changed_files: "1",
        review_decision: "changes requested",
      },
      {
        permalink: "https://example.test/context-url/185",
        diffAvailability: { diffAvailable: "timeout", provider: "cached", message: "diff cache unavailable" },
        mergeBlockers: [
          {
            type: "external_gate",
            state: "ACTION REQUIRED",
            message: "Release approval is required.",
          },
        ],
        queueContext: {
          isQueue: "true",
          strategyLabel: "mergeCommits",
          constituentPrs: [{ prNumber: "205" }],
          mergeCommits: [{ oid: "abc205" }],
          validationEvidence: [{ pullRequest: "205", conclusion: "failed", cmd: "npm test" }],
        },
        mergeConflicts: {
          hasConflicts: "yes",
          conflictFile: "packages/api/src/replay.ts",
        },
        ciStatus: {
          totalChecks: 0,
          failedChecks: [{ name: "api", status: "FAILED", detailsUrl: "https://ci.example.test/api" }],
        },
        reviewComments: [{ user: { node: { login: "reviewer" } }, bodyText: "Please address replay state.", path: "src/replay.ts", original_line: 8 }],
        issueComments: [
          { user: { node: { login: "maintainer" } }, content: "Manual gate remains active." },
          { user: { node: { login: "merge-god[bot]" } }, body: `${REVIEW_GATE_CACHE_MARKER}\nGenerated cache should not enter prompt.` },
        ],
        files: [{ filename: "", path: " " }],
        changedFiles: [{ path: "src/replay.ts", changeType: "UPDATED", additionsCount: "3", deletionsCount: "1" }],
        commitNodes: [{ oid: "abc205", message: "Merge PR #205" }],
      },
      "",
      "",
      "",
    );

    assert.match(prompt, /^# PR #185: Cached queue replay/);
    assert.match(prompt, /\*\*Author\*\*: octocat/);
    assert.match(prompt, /\*\*Branch\*\*: queue\/replay → develop/);
    assert.match(prompt, /\*\*URL\*\*: https:\/\/example\.test\/context-url\/185/);
    assert.match(prompt, /\*\*Files changed\*\*: 1/);
    assert.match(prompt, /\*\*Additions\*\*: \+3/);
    assert.match(prompt, /\*\*Deletions\*\*: -1/);
    assert.match(prompt, /\*\*Source\*\*: cached/);
    assert.match(prompt, /\*\*Reason\*\*: diff cache unavailable/);
    assert.match(prompt, /\*\*external_gate\*\* \(blocked\): Release approval is required\./);
    assert.match(prompt, /\*\*Strategy\*\*: merge_commits/);
    assert.match(prompt, /\*\*Constituent PRs\*\*: #205/);
    assert.match(prompt, /\*\*Unresolved queue blockers\*\*: 0/);
    assert.match(prompt, /packages\/api\/src\/replay\.ts/);
    assert.match(prompt, /\*\*Total checks\*\*: 1/);
    assert.match(prompt, /\*\*Failed\*\*: ❌ 1/);
    assert.match(prompt, /\*\*api\*\*: FAILED/);
    assert.match(prompt, /Details: https:\/\/ci\.example\.test\/api/);
    assert.match(prompt, /⚠️ \*\*CHANGES_REQUESTED\*\*/);
    assert.match(prompt, /Address ALL 1 code review comments/);
    assert.match(prompt, /Fix ALL 1 failing CI checks/);
    assert.match(prompt, /\*\*Author\*\*: reviewer/);
    assert.match(prompt, /\*\*Author\*\*: maintainer/);
    assert.match(prompt, /\*\*File\*\*: `src\/replay\.ts` \(line 8\)/);
    assert.match(prompt, /Please address replay state\./);
    assert.match(prompt, /Manual gate remains active\./);
    assert.doesNotMatch(prompt, /Generated cache should not enter prompt/);
    assert.match(prompt, /`src\/replay\.ts` \(\+3\/-1\)/);
    assert.match(prompt, /`abc205` Merge PR #205/);
  });

  test("renders edge-shaped prompt comments, files, checks, and commits", () => {
    const prompt = buildPrPrompt(
      {
        number: 186,
        title: "Edge-shaped replay",
        author: { login: "octocat" },
        headRefName: "queue/edge",
        baseRefName: "main",
      },
      {
        ci_status: {
          totalChecks: 0,
          failedChecks: [
            {
              node: {
                name: "edge api",
                conclusion: "FAILURE",
                detailsUrl: "https://ci.example.test/edge-api",
              },
            },
          ],
        },
        review_comments: {
          edges: [
            {
              node: {
                user: { cursor: "reviewer", node: { login: "edge-reviewer" } },
                body: "Use the edge-safe accessor.",
                path: "src/edge.ts",
                line: 22,
              },
            },
          ],
        },
        comments: {
          nodes: [
            {
              user: { node: { username: "edge-maintainer" } },
              body: "Keep the prompt and evidence consistent.",
            },
          ],
        },
        files: {
          edges: [
            {
              node: {
                newPath: "src/edge.ts",
                changeType: "ADD",
                linesAdded: "12",
                linesDeleted: "0",
              },
            },
          ],
        },
        commits: {
          edges: [
            {
              node: {
                commit: {
                  cursor: "nested-commit",
                  node: {
                    oid: "edgecommit186",
                    messageHeadline: "Merge PR #186",
                  },
                },
              },
            },
          ],
        },
      },
      "",
      "",
      "",
    );

    assert.match(prompt, /\*\*Total checks\*\*: 1/);
    assert.match(prompt, /edge api/);
    assert.match(prompt, /Details: https:\/\/ci\.example\.test\/edge-api/);
    assert.match(prompt, /\*\*Author\*\*: edge-reviewer/);
    assert.match(prompt, /\*\*Author\*\*: edge-maintainer/);
    assert.match(prompt, /\*\*File\*\*: `src\/edge\.ts` \(line 22\)/);
    assert.match(prompt, /`src\/edge\.ts` \(\+12\/-0\)/);
    assert.match(prompt, /`edgecom` Merge PR #186/);
  });

  test("renders queue-only unresolved blockers in PR prompts", () => {
    const prompt = buildPrPrompt(
      {
        number: 187,
        title: "Cached queue blocker replay",
        author: { login: "octocat" },
        headRefName: "queue/blocker",
        baseRefName: "main",
      },
      {
        queueContext: {
          isQueue: true,
          strategy: "manual",
          constituentPrs: [{ prNumber: 207 }],
          unresolvedBlockers: [
            {
              category: "queue_validation",
              outcome: "failed",
              description: "Queue smoke validation failed.",
            },
          ],
        },
      },
      "",
      "",
      "",
    );

    assert.match(prompt, /## Merge Queue Context/);
    assert.match(prompt, /\*\*Unresolved queue blockers\*\*: 1/);
    assert.match(prompt, /### Queue Blockers/);
    assert.match(prompt, /\*\*queue_validation\*\* \(blocked\): Queue smoke validation failed\./);
  });

  test("does not repeat top-level blockers as queue blockers in PR prompts", () => {
    const repeatedBlocker = {
      kind: "external_gate",
      status: "blocked",
      summary: "Release approval is required.",
      evidence_refs: ["blocker:release"],
    };
    const prompt = buildPrPrompt(
      {
        number: 188,
        title: "Deduped queue blocker replay",
        author: { login: "octocat" },
        headRefName: "queue/deduped",
        baseRefName: "main",
      },
      {
        merge_blockers: [repeatedBlocker],
        queue_context: {
          is_queue: true,
          strategy: "manual",
          constituent_prs: [{ number: 208 }],
          unresolved_blockers: [
            repeatedBlocker,
            {
              kind: "ci_failed",
              status: "blocked",
              summary: "Queue validation failed.",
            },
          ],
        },
      },
      "",
      "",
      "",
    );

    assert.match(prompt, /## Merge Blockers/);
    assert.match(prompt, /\*\*external_gate\*\* \(blocked\): Release approval is required\./);
    assert.match(prompt, /\*\*Unresolved queue blockers\*\*: 1/);
    assert.match(prompt, /\*\*ci_failed\*\* \(blocked\): Queue validation failed\./);
    assert.equal(
      prompt.match(/\*\*external_gate\*\* \(blocked\): Release approval is required\./g)?.length,
      1,
    );
  });

  test("deduplicates queue-only blockers in PR prompts", () => {
    const prompt = buildPrPrompt(
      {
        number: 190,
        title: "Queue duplicate blocker prompt",
        author: { login: "octocat" },
        headRefName: "queue/duplicates",
        baseRefName: "main",
      },
      {
        queue_context: {
          is_queue: true,
          strategy: "manual",
          unresolved_blockers: [
            {
              kind: "queue_validation_failed",
              status: "blocked",
              summary: "Queue validation failed.",
            },
            {
              type: "queue-validation-failed",
              outcome: "failure",
              description: "Queue validation failed.",
            },
          ],
        },
      },
      "",
      "",
      "",
    );

    assert.match(prompt, /\*\*Unresolved queue blockers\*\*: 1/);
    assert.equal(
      prompt.match(/\*\*queue_validation_failed\*\* \(blocked\): Queue validation failed\./g)?.length,
      1,
    );
  });

  test("keeps dedicated gathered blockers out of PR prompt merge blocker sections", () => {
    const prompt = buildPrPrompt(
      {
        number: 189,
        title: "Dedicated blocker prompt",
        author: { login: "octocat" },
        headRefName: "feature/dedicated",
        baseRefName: "main",
        reviewDecision: "REVIEW_REQUIRED",
      },
      {
        merge_blockers: [
          {
            kind: "review_required",
            status: "blocked",
            summary: "GitHub requires review before this PR can merge.",
          },
          {
            kind: "ci_failed",
            status: "blocked",
            summary: "1 CI check(s) failed.",
          },
          {
            kind: "merge_conflicts",
            status: "blocked",
            summary: "Merge conflicts detected in 1 file(s).",
          },
          {
            kind: "external_gate",
            status: "blocked",
            summary: "Release approval is required.",
          },
        ],
        conflicts: {
          has_conflicts: true,
          conflicting_files: ["packages/api/src/routes.ts"],
        },
        ci_status: {
          total_checks: 1,
          failed: 1,
          pending: 0,
          passed: 0,
          failed_checks: [{ name: "api", conclusion: "FAILURE" }],
        },
      },
      "",
      "",
      "",
    );

    assert.match(prompt, /## Merge Blockers/);
    assert.match(prompt, /\*\*external_gate\*\* \(blocked\): Release approval is required\./);
    assert.doesNotMatch(prompt, /\*\*review_required\*\* \(blocked\): GitHub requires review before this PR can merge\./);
    assert.doesNotMatch(prompt, /\*\*ci_failed\*\* \(blocked\): 1 CI check\(s\) failed\./);
    assert.doesNotMatch(prompt, /\*\*merge_conflicts\*\* \(blocked\): Merge conflicts detected in 1 file\(s\)\./);
    assert.match(prompt, /## ⚠️ Merge Conflicts Detected/);
    assert.match(prompt, /## CI\/CD Status/);
    assert.match(prompt, /## Review Status/);
  });

  test("renders review prompts with bounded diffs and changed files", () => {
    const prompt = buildReviewPrompt(
      184,
      "Review target",
      "feature/review-target",
      "https://github.example.test/org/repo/pull/184",
      "a".repeat(100_010),
      [
        { newPath: "src/new.ts", changeType: "ADD", linesAdded: "5", linesDeleted: "0" },
        { oldPath: "src/old.ts", changeType: "DELETE", linesAdded: "0", linesDeleted: "4" },
      ],
      "Gate: review",
    );

    assert.match(prompt, /^# Code Review: PR #184 - Review target/);
    assert.match(prompt, /`src\/new\.ts` \(\+5\/-0\)/);
    assert.match(prompt, /`src\/old\.ts` \(\+0\/-4\)/);
    assert.match(prompt, /Gate: review/);
    assert.equal(prompt.includes("a".repeat(100_001)), false);
  });

  test("renders issue implementation prompts with explicit defaults", () => {
    const prompt = buildIssuePrompt({
      issueNumber: 42,
      title: "Implement queue telemetry",
      url: "https://github.example.test/org/repo/issues/42",
      body: "",
      branchName: "impl/issue-42",
      defaultBranch: "main",
      guidelines: "",
      commitExamples: "",
      mergeRules: "",
    });

    assert.match(prompt, /^# Issue Implementation Task/);
    assert.match(prompt, /\*\*Issue Number:\*\* #42/);
    assert.match(prompt, /No description provided/);
    assert.match(prompt, /No specific guidelines available/);
    assert.match(prompt, /No repo-local merge rules found/);
    assert.match(prompt, /No examples available/);
    assert.match(prompt, /gh pr create --fill --head impl\/issue-42 --base main/);
  });
});
