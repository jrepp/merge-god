import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  commitRecords,
  extractConflictFilesFromCommitMessage,
  mergeCommitConflictFilesFromRecord,
  modelQueueMergeCommits,
  queueMergeCommitCandidates,
  queueMergeCommitCandidatesFromComments,
} from "../queue_merge_commit_model";

describe("queue merge commit model", () => {
  test("uses paginated context commits before PR detail commit nodes", () => {
    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commits: {
            nodes: [{ oid: "detail201", message: "Merge PR #201" }],
          },
        },
        {
          commits: [{ sha: "context202", message: "Merge PR #202" }],
        },
      ),
      [{ sha: "context202", message: "Merge PR #202" }],
    );

    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commits: {
            nodes: [{ oid: "detail201", message: "Merge PR #201" }],
          },
        },
        { commits: [] },
      ),
      [{ oid: "detail201", message: "Merge PR #201" }],
    );
  });

  test("uses cached context commit collection aliases before PR detail commits", () => {
    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commits: {
            nodes: [{ oid: "detail201", message: "Merge PR #201" }],
          },
        },
        {
          commitNodes: [{ sha: "context202", message: "Merge PR #202" }],
        },
      ),
      [{ sha: "context202", message: "Merge PR #202" }],
    );
  });

  test("uses cached PR detail commit collection aliases as fallback", () => {
    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commits: [null, {}],
          commitNodes: [{ oid: "detail202", message: "Merge PR #202" }],
        },
        { commits: [] },
      ),
      [{ oid: "detail202", message: "Merge PR #202" }],
    );

    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commit_nodes: {
            edges: [
              { node: { oid: "detail203", message: "Merge PR #203" } },
              { node: null },
            ],
          },
        },
        { commitNodes: [null, {}] },
      ),
      [{ oid: "detail203", message: "Merge PR #203" }],
    );
  });

  test("uses GraphQL edge commit collections before PR detail fallbacks", () => {
    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commits: {
            nodes: [{ oid: "detail201", message: "Merge PR #201" }],
          },
        },
        {
          commits: {
            edges: [
              { node: { sha: "context202", message: "Merge PR #202" } },
              { node: null },
            ],
          },
        },
      ),
      [{ sha: "context202", message: "Merge PR #202" }],
    );

    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commits: {
            edges: [
              { node: { oid: "detail203", message: "Merge PR #203" } },
              { node: {} },
            ],
          },
        },
        { commits: [] },
      ),
      [{ oid: "detail203", message: "Merge PR #203" }],
    );
  });

  test("uses direct edge-array commit collections before PR detail fallbacks", () => {
    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commits: [
            { node: { oid: "detail201", message: "Merge PR #201" } },
          ],
        },
        {
          commits: [
            { cursor: "context", node: { sha: "context202", message: "Merge PR #202" } },
            { cursor: "empty", node: {} },
          ],
        },
      ),
      [{ sha: "context202", message: "Merge PR #202" }],
    );

    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commitNodes: [
            { cursor: "detail", node: { oid: "detail203", message: "Merge PR #203" } },
          ],
        },
        { commits: [] },
      ),
      [{ oid: "detail203", message: "Merge PR #203" }],
    );
  });

  test("normalizes direct edge arrays in commitRecords", () => {
    assert.deepEqual(
      commitRecords([
        { __typename: "CommitEdge", cursor: "context", node: { sha: "context202", message: "Merge PR #202" } },
        { cursor: "empty", node: {} },
        { node: null },
      ]),
      [{ sha: "context202", message: "Merge PR #202" }],
    );
  });

  test("falls back past empty connection nodes when choosing commit candidates", () => {
    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commits: {
            nodes: [
              null,
              { oid: "detail201", message: "Merge PR #201" },
            ],
          },
        },
        {
          commits: {
            nodes: [
              null,
              {},
            ],
          },
        },
      ),
      [{ oid: "detail201", message: "Merge PR #201" }],
    );

    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commits: {
            nodes: [
              null,
              { oid: "detail202", message: "Merge PR #202" },
            ],
          },
        },
        { commitNodes: { nodes: [null, {}] } },
      ),
      [{ oid: "detail202", message: "Merge PR #202" }],
    );
  });

  test("falls back past placeholder direct commit arrays when choosing commit candidates", () => {
    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commits: {
            nodes: [
              null,
              { oid: "detail203", message: "Merge PR #203" },
            ],
          },
        },
        {
          commits: [
            null,
            {},
          ],
        },
      ),
      [{ oid: "detail203", message: "Merge PR #203" }],
    );
  });

  test("uses visible PR merge-commit comment tables as candidates before PR detail commits", () => {
    const comments = [
      {
        html_url: "https://github.example.test/org/repo/pull/183#issuecomment-merge-commits",
        body: [
          "Added PRs #191, #192, and #193 to the queue with explicit merge commits.",
          "",
          "| PR | Merge commit | Notes |",
          "| --- | --- | --- |",
          "| #191 | [`740e4fc9`](https://github.example.test/org/repo/commit/740e4fc91b7612ecdbbe75fd207d952f8ad4757f) | Merged cleanly. |",
          "| #192 | [`ca4bee0e`](https://github.example.test/org/repo/commit/ca4bee0ef5c558e41877694cdc90e3f69848ba54) | Resolved fixture cleanup conflicts. |",
          "| #193 | `bf3e7964` | Preserved target-selection launch wiring. |",
        ].join("\n"),
      },
    ];

    assert.deepEqual(queueMergeCommitCandidatesFromComments(comments), [
      {
        sha: "740e4fc91b7612ecdbbe75fd207d952f8ad4757f",
        pr_number: 191,
        messageHeadline: "Merge PR #191",
        evidence_refs: [
          "https://github.example.test/org/repo/pull/183#issuecomment-merge-commits",
          "https://github.example.test/org/repo/commit/740e4fc91b7612ecdbbe75fd207d952f8ad4757f",
        ],
      },
      {
        sha: "ca4bee0ef5c558e41877694cdc90e3f69848ba54",
        pr_number: 192,
        messageHeadline: "Merge PR #192",
        evidence_refs: [
          "https://github.example.test/org/repo/pull/183#issuecomment-merge-commits",
          "https://github.example.test/org/repo/commit/ca4bee0ef5c558e41877694cdc90e3f69848ba54",
        ],
      },
      {
        sha: "bf3e7964",
        pr_number: 193,
        messageHeadline: "Merge PR #193",
        evidence_refs: ["https://github.example.test/org/repo/pull/183#issuecomment-merge-commits"],
      },
    ]);

    assert.deepEqual(
      queueMergeCommitCandidates(
        {
          commits: [{ oid: "detail201", message: "Merge PR #201" }],
        },
        {
          comments,
          commits: [],
        },
      ),
      queueMergeCommitCandidatesFromComments(comments),
    );
  });

  test("normalizes commit message and identifier shapes into merge queue commits", () => {
    assert.deepEqual(
      modelQueueMergeCommits([
        {
          oid: " oid201 ",
          message: "   ",
          messageHeadline: "Merge PR #201",
          messageBody: [
            "# Conflicts:",
            "#\tpackages/api/src/top.ts",
          ].join("\n"),
        },
        {
          sha: "   ",
          commit: {
            id: " nested202 ",
            messageHeadline: "Merge pull request #202",
            messageBody: [
              "Conflicts:",
              "\tpackages/ui/src/view.ts",
            ].join("\n"),
          },
        },
      ]),
      {
        merged_pr_numbers: [201, 202],
        merge_commits: [
          {
            sha: "oid201",
            pr_number: 201,
            subject: "Merge PR #201",
            conflict_files: ["packages/api/src/top.ts"],
            evidence_refs: ["commit:oid201"],
          },
          {
            sha: "nested202",
            pr_number: 202,
            subject: "Merge pull request #202",
            conflict_files: ["packages/ui/src/view.ts"],
            evidence_refs: ["commit:nested202"],
          },
        ],
      },
    );
  });

  test("normalizes direct edge-shaped commit records into merge queue commits", () => {
    assert.deepEqual(
      modelQueueMergeCommits([
        {
          __typename: "CommitEdge",
          cursor: "edge-221",
          node: {
            oid: "edge221",
            message: [
              "Merge PR #221",
              "",
              "Conflicts:",
              "\tpackages/api/src/edge.ts",
            ].join("\n"),
          },
        },
        {
          commit: {
            __typename: "Commit",
            cursor: "nested-222",
            node: {
              id: "nested222",
              messageHeadline: "Merge pull request #222",
              messageBody: [
                "Conflicts:",
                "\tpackages/ui/src/nested.ts",
              ].join("\n"),
            },
          },
        },
      ]),
      {
        merged_pr_numbers: [221, 222],
        merge_commits: [
          {
            sha: "edge221",
            pr_number: 221,
            subject: "Merge PR #221",
            conflict_files: ["packages/api/src/edge.ts"],
            evidence_refs: ["commit:edge221"],
          },
          {
            sha: "nested222",
            pr_number: 222,
            subject: "Merge pull request #222",
            conflict_files: ["packages/ui/src/nested.ts"],
            evidence_refs: ["commit:nested222"],
          },
        ],
      },
    );
  });

  test("preserves explicit merge commit evidence refs and conflict aliases", () => {
    assert.deepEqual(
      modelQueueMergeCommits([
        {
          oid: "oid201",
          message: [
            "Merge PR #201",
            "",
            "Conflicts:",
            "\tpackages/ui/src/message.ts",
          ].join("\n"),
          evidenceRefs: {
            nodes: ["commit:source-201", { ref: "pr:#201" }],
          },
          comment_ref: "comment:merge-201",
          source_refs: ["source:merge-201"],
          conflictFiles: {
            nodes: [" packages/api/src/node.ts ", { path: "apps/web/src/App.tsx" }],
          },
        },
        {
          sha: "sha202",
          commit: {
            messageHeadline: "Merge pull request #202",
            evidence_refs: {
              edges: [
                { node: "commit:nested-source-202" },
                { node: { value: "pr:#202" } },
              ],
            },
            commentRefs: ["comment:nested-202"],
            source_ref: "source:nested-202",
            conflictingFiles: {
              edges: [
                { node: { filename: "packages/workers/src/job.ts" } },
              ],
            },
          },
        },
      ]),
      {
        merged_pr_numbers: [201, 202],
        merge_commits: [
          {
            sha: "oid201",
            pr_number: 201,
            subject: "Merge PR #201",
            conflict_files: [
              "packages/api/src/node.ts",
              "apps/web/src/App.tsx",
              "packages/ui/src/message.ts",
            ],
            evidence_refs: [
              "comment:merge-201",
              "commit:source-201",
              "pr:#201",
              "source:merge-201",
              "commit:oid201",
            ],
          },
          {
            sha: "sha202",
            pr_number: 202,
            subject: "Merge pull request #202",
            conflict_files: ["packages/workers/src/job.ts"],
            evidence_refs: [
              "source:nested-202",
              "commit:nested-source-202",
              "pr:#202",
              "comment:nested-202",
              "commit:sha202",
            ],
          },
        ],
      },
    );

    assert.deepEqual(
      mergeCommitConflictFilesFromRecord({
        conflictFiles: {
          edges: [
            { node: "packages/api/src/edge.ts" },
            { node: { oldPath: "packages/ui/src/old.ts" } },
          ],
        },
      }),
      ["packages/api/src/edge.ts", "packages/ui/src/old.ts"],
    );
  });

  test("uses explicit commit evidence refs as merge commit identifiers", () => {
    assert.deepEqual(
      modelQueueMergeCommits([
        {
          message: "Merge PR #201",
          evidenceRefs: ["commit:evidence201", "pr:#201"],
        },
        {
          commit: {
            messageHeadline: "Merge pull request #202",
            evidence_refs: ["commit:nested202"],
          },
        },
      ]),
      {
        merged_pr_numbers: [201, 202],
        merge_commits: [
          {
            sha: "evidence201",
            pr_number: 201,
            subject: "Merge PR #201",
            conflict_files: [],
            evidence_refs: ["commit:evidence201", "pr:#201"],
          },
          {
            sha: "nested202",
            pr_number: 202,
            subject: "Merge pull request #202",
            conflict_files: [],
            evidence_refs: ["commit:nested202"],
          },
        ],
      },
    );
  });

  test("uses explicit PR refs and fields for merge commit lineage without merge subjects", () => {
    assert.deepEqual(
      modelQueueMergeCommits([
        {
          evidenceRefs: ["commit:evidence201", "pr:#201"],
        },
        {
          commit: {
            evidence_refs: ["commit:nested202", "merge-request:!202"],
          },
        },
        {
          evidenceRefs: ["commit:field203"],
          prNumber: "203",
        },
        {
          evidenceRefs: ["commit:mr204"],
          mrNumber: "204",
        },
        {
          commit: {
            evidenceRefs: ["commit:nestedmr205"],
            mr_iid: "205",
          },
        },
      ]),
      {
        merged_pr_numbers: [201, 202, 203, 204, 205],
        merge_commits: [
          {
            sha: "evidence201",
            pr_number: 201,
            subject: "",
            conflict_files: [],
            evidence_refs: ["commit:evidence201", "pr:#201"],
          },
          {
            sha: "nested202",
            pr_number: 202,
            subject: "",
            conflict_files: [],
            evidence_refs: ["commit:nested202", "merge-request:!202"],
          },
          {
            sha: "field203",
            pr_number: 203,
            subject: "",
            conflict_files: [],
            evidence_refs: ["commit:field203"],
          },
          {
            sha: "mr204",
            pr_number: 204,
            subject: "",
            conflict_files: [],
            evidence_refs: ["commit:mr204"],
          },
          {
            sha: "nestedmr205",
            pr_number: 205,
            subject: "",
            conflict_files: [],
            evidence_refs: ["commit:nestedmr205"],
          },
        ],
      },
    );
  });

  test("normalizes snake_case and subject commit message aliases", () => {
    assert.deepEqual(
      modelQueueMergeCommits([
        {
          sha: "snake201",
          message_headline: "Merge PR #201",
          message_body: [
            "# Conflicts:",
            "#\tpackages/api/src/snake.ts",
          ].join("\n"),
        },
        {
          sha: "commit202",
          commit_message: [
            "Merge PR #202",
            "",
            "Conflicts:",
            "\tpackages/ui/src/commit-message.ts",
          ].join("\n"),
        },
        {
          sha: "subject203",
          subject: "Merge pull request #203",
          body: [
            "Conflicts:",
            "\tpackages/workers/src/subject.ts",
          ].join("\n"),
        },
      ]),
      {
        merged_pr_numbers: [201, 202, 203],
        merge_commits: [
          {
            sha: "snake201",
            pr_number: 201,
            subject: "Merge PR #201",
            conflict_files: ["packages/api/src/snake.ts"],
            evidence_refs: ["commit:snake201"],
          },
          {
            sha: "commit202",
            pr_number: 202,
            subject: "Merge PR #202",
            conflict_files: ["packages/ui/src/commit-message.ts"],
            evidence_refs: ["commit:commit202"],
          },
          {
            sha: "subject203",
            pr_number: 203,
            subject: "Merge pull request #203",
            conflict_files: ["packages/workers/src/subject.ts"],
            evidence_refs: ["commit:subject203"],
          },
        ],
      },
    );
  });

  test("recognizes PR merge subjects without hash markers", () => {
    assert.deepEqual(
      modelQueueMergeCommits([
        {
          sha: "plain201",
          message: "Merge PR 201 from org/api",
        },
        {
          sha: "plain202",
          commit: {
            messageHeadline: "Merge pull request 202 from org/ui",
          },
        },
        {
          sha: "ordinary203",
          message: "Document pull request 203 handling",
        },
      ]),
      {
        merged_pr_numbers: [201, 202],
        merge_commits: [
          {
            sha: "plain201",
            pr_number: 201,
            subject: "Merge PR 201 from org/api",
            conflict_files: [],
            evidence_refs: ["commit:plain201"],
          },
          {
            sha: "plain202",
            pr_number: 202,
            subject: "Merge pull request 202 from org/ui",
            conflict_files: [],
            evidence_refs: ["commit:plain202"],
          },
        ],
      },
    );
  });

  test("recognizes squash subjects only when queue context permits them", () => {
    const commits = [
      { sha: "abc2010", commit: { message: "Add API bridge support (#201)" } },
      { sha: "abc2020", commit: { message: "Refresh UI shell (!202)" } },
    ];

    assert.deepEqual(modelQueueMergeCommits(commits), {
      merge_commits: [],
      merged_pr_numbers: [],
    });
    assert.deepEqual(modelQueueMergeCommits(commits, { allowSquashSubjects: true }), {
      merged_pr_numbers: [201, 202],
      merge_commits: [
        {
          sha: "abc2010",
          pr_number: 201,
          subject: "Add API bridge support (#201)",
          conflict_files: [],
          evidence_refs: ["commit:abc2010"],
        },
        {
          sha: "abc2020",
          pr_number: 202,
          subject: "Refresh UI shell (!202)",
          conflict_files: [],
          evidence_refs: ["commit:abc2020"],
        },
      ],
    });
  });

  test("recognizes GitLab merge request commit shapes", () => {
    assert.deepEqual(
      modelQueueMergeCommits([
        {
          sha: "gitlab201",
          message: "Merge MR !201",
        },
        {
          sha: "gitlab202",
          message: "Merge merge request !202",
        },
        {
          sha: "gitlab203",
          message: "Merge request !203 from group/project",
        },
        {
          sha: "gitlab204",
          message: [
            "Merge branch 'feature/api' into 'queue/main'",
            "",
            "API work",
            "",
            "See merge request org/repo!204",
          ].join("\n"),
        },
        {
          sha: "ordinary205",
          message: [
            "Document API release",
            "",
            "See merge request org/repo!205",
          ].join("\n"),
        },
      ]),
      {
        merged_pr_numbers: [201, 202, 203, 204],
        merge_commits: [
          {
            sha: "gitlab201",
            pr_number: 201,
            subject: "Merge MR !201",
            conflict_files: [],
            evidence_refs: ["commit:gitlab201"],
          },
          {
            sha: "gitlab202",
            pr_number: 202,
            subject: "Merge merge request !202",
            conflict_files: [],
            evidence_refs: ["commit:gitlab202"],
          },
          {
            sha: "gitlab203",
            pr_number: 203,
            subject: "Merge request !203 from group/project",
            conflict_files: [],
            evidence_refs: ["commit:gitlab203"],
          },
          {
            sha: "gitlab204",
            pr_number: 204,
            subject: "Merge branch 'feature/api' into 'queue/main'",
            conflict_files: [],
            evidence_refs: ["commit:gitlab204"],
          },
        ],
      },
    );
  });

  test("recognizes merged PR and MR commit subjects", () => {
    assert.deepEqual(
      modelQueueMergeCommits([
        {
          sha: "ado201",
          message: "Merged PR 201: API update",
        },
        {
          sha: "ado202",
          message: "Merged pull request 202: UI update",
        },
        {
          sha: "ado203",
          message: "Merged MR !203: GitLab update",
        },
        {
          sha: "ado204",
          message: "Merged merge request !204: GitLab update",
        },
        {
          sha: "ordinary205",
          message: "Merged feature branch for release 205",
        },
      ]),
      {
        merged_pr_numbers: [201, 202, 203, 204],
        merge_commits: [
          {
            sha: "ado201",
            pr_number: 201,
            subject: "Merged PR 201: API update",
            conflict_files: [],
            evidence_refs: ["commit:ado201"],
          },
          {
            sha: "ado202",
            pr_number: 202,
            subject: "Merged pull request 202: UI update",
            conflict_files: [],
            evidence_refs: ["commit:ado202"],
          },
          {
            sha: "ado203",
            pr_number: 203,
            subject: "Merged MR !203: GitLab update",
            conflict_files: [],
            evidence_refs: ["commit:ado203"],
          },
          {
            sha: "ado204",
            pr_number: 204,
            subject: "Merged merge request !204: GitLab update",
            conflict_files: [],
            evidence_refs: ["commit:ado204"],
          },
        ],
      },
    );
  });

  test("preserves base-branch merge commits without assigning constituent PRs", () => {
    assert.deepEqual(
      modelQueueMergeCommits(
        [
          {
            sha: "remote2026",
            commit: {
              message: [
                "Merge remote-tracking branch 'origin/release/2026.07' into queue/release",
                "",
                "# Conflicts:",
                "#\tpackages/ui/src/release.ts",
              ].join("\n"),
            },
          },
          {
            sha: "feature123",
            commit: {
              message: [
                "Merge branch 'feature/stale' into queue/release",
                "",
                "# Conflicts:",
                "#\tpackages/api/src/stale.ts",
              ].join("\n"),
            },
          },
        ],
        { baseBranch: "release/2026.07" },
      ),
      {
        merged_pr_numbers: [],
        merge_commits: [
          {
            sha: "remote2026",
            pr_number: null,
            subject: "Merge remote-tracking branch 'origin/release/2026.07' into queue/release",
            conflict_files: ["packages/ui/src/release.ts"],
            evidence_refs: ["commit:remote2026"],
          },
        ],
      },
    );
  });

  test("extracts conflict files from commented, indented, and bullet conflict blocks", () => {
    assert.deepEqual(
      extractConflictFilesFromCommitMessage([
        "Merge PR #201",
        "",
        "Conflicts:",
        "\tpackages/api/src/plain.ts",
        "    apps/web/src/plain.ts",
        "  - packages/ui/src/card.ts",
        "  - packages/ui/src/card.ts",
        "",
        "Resolved by keeping the queue head API shape.",
      ].join("\n")),
      [
        "packages/api/src/plain.ts",
        "apps/web/src/plain.ts",
        "packages/ui/src/card.ts",
      ],
    );

    assert.deepEqual(
      extractConflictFilesFromCommitMessage([
        "Merge PR #202",
        "",
        "# Conflicts:",
        "#\tpackages/workers/src/job.ts",
        "# Please enter a commit message to explain why this merge is necessary.",
      ].join("\n")),
      ["packages/workers/src/job.ts"],
    );
  });
});
