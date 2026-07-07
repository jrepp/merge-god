import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { CommandRunner, CommandTuple } from "../command_runner";
import { gatherPrContextFromSource } from "../pr_context_gatherer";
import { GhCliPullRequestContextSource, type BranchRefs, type DiffResult, type PullRequestContextSource } from "../pr_context_source";

class FakeCommandRunner implements CommandRunner {
  calls: string[][] = [];
  constructor(private readonly responses: CommandTuple[]) {}

  async run(cmd: string[]): Promise<CommandTuple> {
    this.calls.push(cmd);
    const next = this.responses.shift();
    assert.ok(next, `unexpected command: ${cmd.join(" ")}`);
    return next;
  }
}

class FakeSource implements PullRequestContextSource {
  async getDetails(): Promise<Record<string, unknown>> {
    return {
      number: 183,
      title: "Merge queue: PRs 178, 179",
      reviewDecision: "REVIEW_REQUIRED",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [],
    };
  }

  async getComments(): Promise<Record<string, unknown>[]> {
    return [{ html_url: "https://example.test/comment", body: "- `npm run typecheck` -> passed." }];
  }

  async getReviewComments(): Promise<Record<string, unknown>[]> {
    return [];
  }

  async getCommits(): Promise<Record<string, unknown>[]> {
    return [
      {
        sha: "abc1234",
        commit: { message: "Merge PR #178\n\n# Conflicts:\n#\tapps/chat/src/ChatApp.tsx" },
      },
    ];
  }

  async getFiles(): Promise<Record<string, unknown>[]> {
    return [{ filename: "apps/chat/src/ChatApp.tsx", additions: 10, deletions: 2 }];
  }

  async getDiff(): Promise<DiffResult> {
    return {
      diff: "",
      availability: {
        available: false,
        source: "gh-pr-diff",
        size: 0,
        truncated: true,
        error: "diff exceeded maximum lines",
      },
    };
  }

  async checkMergeConflicts(_prNumber: number, _refs: BranchRefs): Promise<Record<string, unknown>> {
    return { has_conflicts: false, conflicting_files: [], conflict_count: 0 };
  }
}

class GateSource implements PullRequestContextSource {
  async getDetails(): Promise<Record<string, unknown>> {
    return {
      number: 184,
      title: "Merge queue: PRs #181 and #182",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      labels: [{ name: "for-landing" }, { name: "waiting-on-security" }],
      statusCheckRollup: {
        nodes: [{ name: "build", conclusion: "SUCCESS", status: "COMPLETED" }],
      },
    };
  }

  async getComments(): Promise<Record<string, unknown>[]> {
    return [
      {
        html_url: "https://example.test/pull/184#issuecomment-manual-gate",
        created_at: "2026-07-01T10:00:00Z",
        body: "merge-god: blocked - release owner signoff pending",
      },
    ];
  }

  async getReviewComments(): Promise<Record<string, unknown>[]> {
    return [
      {
        html_url: "https://example.test/pull/184#discussion_r1",
        created_at: "2026-07-01T10:05:00Z",
        body: "- #181 `npm run api` -> passed",
      },
    ];
  }

  async getCommits(): Promise<Record<string, unknown>[]> {
    return [];
  }

  async getFiles(): Promise<Record<string, unknown>[]> {
    return [{ filename: "packages/api/src/release.ts", additions: 3, deletions: 1 }];
  }

  async getDiff(): Promise<DiffResult> {
    return {
      diff: "diff --git a/packages/api/src/release.ts b/packages/api/src/release.ts\n+ok\n",
      availability: {
        available: true,
        source: "gh-pr-diff",
        size: 76,
        truncated: false,
        error: null,
      },
    };
  }

  async checkMergeConflicts(): Promise<Record<string, unknown>> {
    return { has_conflicts: false, conflicting_files: [], conflict_count: 0 };
  }
}

describe("gatherPrContextFromSource", () => {
  test("composes source data with merge queue model and blockers", async () => {
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const [details, context] = await gatherPrContextFromSource(
      new FakeSource(),
      183,
      "queue",
      "main",
      "https://example.test/pull/183",
      (event, data) => logs.push({ event, data }),
    );

    assert.equal(details["title"], "Merge queue: PRs 178, 179");
    assert.equal(context["url"], "https://example.test/pull/183");
    assert.equal((context["diff_availability"] as Record<string, unknown>)["available"], false);
    assert.deepEqual(
      (context["merge_blockers"] as Array<Record<string, unknown>>).map((blocker) => blocker["kind"]),
      ["review_required", "merge_state_blocked", "ci_missing", "diff_unavailable"],
    );
    const queue = context["queue_context"] as Record<string, unknown>;
    assert.equal(queue["is_queue"], true);
    assert.deepEqual(
      (queue["constituent_prs"] as Array<Record<string, unknown>>).map((pr) => [pr["number"], pr["status"]]),
      [
        [178, "merged_into_queue"],
        [179, "queued"],
      ],
    );
    const completeLog = logs.find((entry) => entry.event === "gather_pr_context" && entry.data["action"] === "complete");
    assert.ok(completeLog);
    assert.deepEqual(completeLog.data["context_summary"], {
      comments: 1,
      review_comments: 0,
      commits: 1,
      files: 1,
      has_conflicts: false,
      ci_checks: 0,
      ci_failed: 0,
      diff_size: 0,
      diff_available: false,
      merge_blockers: 4,
      is_queue: true,
    });
  });

  test("propagates label and manual gate blockers through gathered context", async () => {
    const [_details, context] = await gatherPrContextFromSource(
      new GateSource(),
      184,
      "queue",
      "main",
      "https://example.test/pull/184",
    );

    const blockers = context["merge_blockers"] as Array<Record<string, unknown>>;
    assert.deepEqual(
      blockers.map((blocker) => [blocker["kind"], blocker["status"], blocker["evidence_refs"]]),
      [
        ["external_gate", "blocked", ["github:label:waiting-on-security"]],
        ["external_gate", "blocked", ["https://example.test/pull/184#issuecomment-manual-gate"]],
      ],
    );
    assert.match(String(blockers[0]!["summary"]), /waiting-on-security/);
    assert.match(String(blockers[1]!["summary"]), /release owner signoff pending/);

    const queue = context["queue_context"] as Record<string, unknown>;
    assert.equal(queue["is_queue"], true);
    assert.deepEqual(
      (queue["unresolved_blockers"] as Array<Record<string, unknown>>).map((blocker) => blocker["evidence_refs"]),
      [
        ["github:label:waiting-on-security"],
        ["https://example.test/pull/184#issuecomment-manual-gate"],
      ],
    );
  });
});

describe("GhCliPullRequestContextSource", () => {
  test("fetches PR details without GitHub.com-only reviewers field", async () => {
    const runner = new FakeCommandRunner([
      [0, JSON.stringify({ number: 183, title: "Test PR" }), ""],
    ]);
    const source = new GhCliPullRequestContextSource(runner);

    const details = await source.getDetails(183);

    assert.equal(details["number"], 183);
    const jsonFields = runner.calls[0]![5]!;
    assert.match(jsonFields, /reviewDecision/);
    assert.doesNotMatch(jsonFields, /(^|,)reviewers(,|$)/);
  });

  test("flattens paginated gh api arrays without slurp jq combination", async () => {
    const runner = new FakeCommandRunner([
      [0, "{\"body\":\"first\"}\n{\"body\":\"second\"}\n", ""],
    ]);
    const source = new GhCliPullRequestContextSource(runner);

    const comments = await source.getComments(183);

    assert.deepEqual(comments.map((comment) => comment["body"]), ["first", "second"]);
    const command = runner.calls[0]!;
    assert.equal(command.includes("--paginate"), true);
    assert.equal(command.includes("--slurp"), false);
    assert.deepEqual(command.slice(-2), ["--jq", ".[]"]);
  });

  test("falls back to local git diff when gh diff is too large", async () => {
    const runner = new FakeCommandRunner([
      [1, "", "PullRequest.diff too_large"],
      [0, "", ""],
      [0, "diff --git a/file b/file\n+ok\n", ""],
    ]);
    const source = new GhCliPullRequestContextSource(runner);

    const result = await source.getDiff(183, { head_branch: "feature/test", base_branch: "main" });

    assert.equal(result.availability.source, "local-git-diff");
    assert.equal(result.availability.available, true);
    assert.match(result.diff, /\+ok/);
    assert.deepEqual(
      runner.calls.map((cmd) => cmd.slice(0, 3)),
      [
        ["gh", "pr", "diff"],
        ["git", "fetch", "origin"],
        ["git", "diff", "--no-ext-diff"],
      ],
    );
  });
});
