import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  QUEUE_CONTEXT_SUMMARY_ROW_LIMIT,
  QUEUE_CONSTITUENT_STATUS_SUMMARY_DETAIL_LIMIT,
  queueConflictFileSummary,
  queueConstituentPrEvidenceRef,
  queueConstituentPrNumberSummary,
  queueConstituentPrSummary,
  queueConstituentStatusLabel,
  queueMergeCommitEvidenceRef,
  queueMergeCommitIdentifier,
  queueMergeCommitPrEvidenceRef,
  queueMergeCommitSummary,
  queueStrategyLabel,
} from "../queue_context_summary_model";

describe("queue context summary model", () => {
  test("exports a shared row limit for queue summary and fallback refs", () => {
    assert.equal(QUEUE_CONTEXT_SUMMARY_ROW_LIMIT, 8);
  });

  test("summarizes queue strategy and constituents with explicit defaults", () => {
    const constituents = [
      { number: 201, status: "queued", title: "API update", head_sha: "abcdef123456" },
      { number: 0, status: "", title: "", head_sha: "" },
    ];

    assert.equal(queueStrategyLabel("   "), "unknown");
    assert.equal(queueStrategyLabel("title PR list"), "title_pr_list");
    assert.equal(queueStrategyLabel("merge-commit"), "merge_commits");
    assert.equal(queueStrategyLabel("mergeCommits"), "merge_commits");
    assert.equal(queueStrategyLabel("commit history"), "merge_commits");
    assert.equal(queueStrategyLabel("MANUAL"), "manual");
    assert.equal(queueStrategyLabel("surprise"), "unknown");
    assert.equal(queueConstituentPrNumberSummary(constituents), "unknown, #201");
    assert.equal(
      queueConstituentPrSummary(constituents),
      "unknown (unknown); #201 (queued, API update, head abcdef12)",
    );
    assert.equal(queueConstituentPrNumberSummary([]), "unknown");
    assert.equal(queueConstituentPrSummary([]), "unknown");
  });

  test("normalizes constituent status display to known queue states", () => {
    assert.equal(queueConstituentStatusLabel("queued"), "queued");
    assert.equal(queueConstituentStatusLabel("merged into queue"), "merged_into_queue");
    assert.equal(queueConstituentStatusLabel("mergedIntoQueue"), "merged_into_queue");
    assert.equal(queueConstituentStatusLabel("SUCCESS"), "validated");
    assert.equal(queueConstituentStatusLabel("failed"), "blocked");
    assert.equal(queueConstituentStatusLabel("in-progress"), "queued");
    assert.equal(queueConstituentStatusLabel("surprise"), "unknown");
    assert.equal(queueConstituentStatusLabel("   "), "unknown");
    assert.equal(queueConstituentStatusLabel(123), "unknown");
  });

  test("does not echo malformed constituent statuses in summaries", () => {
    assert.equal(
      queueConstituentPrSummary([
        { number: 201, status: "success", title: "API update" },
        { number: 202, status: "surprise", title: "UI update" },
      ]),
      "#202 (unknown, UI update); #201 (validated, API update)",
    );
  });

  test("summarizes cached constituent head SHA aliases", () => {
    assert.equal(
      queueConstituentPrSummary([
        { number: 201, status: "queued", title: "API update", headSha: " abcdef123456 " },
        { number: 202, status: "queued", title: "UI update", head_oid: " 1234567890abcdef " },
        { number: 203, status: "queued", title: "Worker update", headOid: " fedcba987654 " },
        { number: 204, status: "queued", title: "Nested head", head: { oid: " 9876543210fedcba " } },
        { number: 205, status: "queued", title: "Nested head commit", headCommit: { sha: " 112233445566 " } },
      ]),
      [
        "#201 (queued, API update, head abcdef12)",
        "#202 (queued, UI update, head 12345678)",
        "#203 (queued, Worker update, head fedcba98)",
        "#204 (queued, Nested head, head 98765432)",
        "#205 (queued, Nested head commit, head 11223344)",
      ].join("; "),
    );
  });

  test("summarizes cached constituent title and status aliases", () => {
    assert.equal(
      queueConstituentPrSummary([
        { number: 201, state: "success", name: "API update" },
        { number: 202, queueStatus: "in-progress", summary: "UI update" },
        { number: 203, validationStatus: "failure", subject: "Worker update" },
        { number: 204, conclusion: "neutral", label: "Provider update" },
      ]),
      [
        "#203 (blocked, Worker update)",
        "#204 (unknown, Provider update)",
        "#201 (validated, API update)",
        "#202 (queued, UI update)",
      ].join("; "),
    );
  });

  test("prioritizes informative statuses even when summaries are not capped", () => {
    const constituents = [
      { number: 501, status: "queued" },
      { number: 502, status: "blocked" },
      { number: 503, status: "unknown" },
    ];

    assert.equal(queueConstituentPrNumberSummary(constituents), "#502, #503, #501");
    assert.equal(queueConstituentPrSummary(constituents), "#502 (blocked); #503 (unknown); #501 (queued)");
  });

  test("summarizes cached constituent PR number aliases", () => {
    const constituents = [
      { prNumber: 201, status: "queued", title: "API update", headSha: "abcdef123456" },
      { pr_number: 202, status: "validated", title: "UI update" },
      { pullNumber: 203, status: "blocked", title: "Worker update" },
      { mergeRequestNumber: 204, status: "mergedIntoQueue", title: "GitLab update" },
      { prNumber: "205", status: "queued", title: "String number" },
      { iid: "206", status: "queued", title: "GitLab IID" },
      { web_url: "https://gitlab.example.test/org/repo/-/merge_requests/207", status: "queued", title: "GitLab URL" },
      { mrNumber: "208", status: "queued", title: "MR number" },
      { mr_iid: "209", status: "queued", title: "MR IID" },
    ];

    assert.equal(queueConstituentPrNumberSummary(constituents), "#203, #202, #204, #201, #205, #206, #207, #208, 1 more");
    assert.equal(
      queueConstituentPrSummary(constituents),
      [
        "#203 (blocked, Worker update)",
        "#202 (validated, UI update)",
        "#204 (merged_into_queue, GitLab update)",
        "#201 (queued, API update, head abcdef12)",
        "#205 (queued, String number)",
        "#206 (queued, GitLab IID)",
        "#207 (queued, GitLab URL)",
        "#208 (queued, MR number)",
        "1 more",
      ].join("; "),
    );
    assert.equal(queueConstituentPrEvidenceRef({ iid: "206" }), "pr:#206");
    assert.equal(queueConstituentPrEvidenceRef({ mrIid: "209" }), "pr:#209");
    assert.equal(queueConstituentPrEvidenceRef({ title: "missing number" }), "");
  });

  test("summarizes cached constituent PR numbers from link maps", () => {
    assert.equal(
      queueConstituentPrNumberSummary([
        {
          status: "queued",
          links: { html: { href: "https://github.example.test/org/repo/pull/208" } },
        },
        {
          status: "queued",
          _links: { web: "https://gitlab.example.test/org/repo/-/merge_requests/209" },
        },
        {
          status: "queued",
          links: [{ href: "https://github.example.test/org/repo/pull/210" }],
        },
        {
          status: "queued",
          _links: { merge_requests: [{ webUrl: "https://gitlab.example.test/org/repo/-/merge_requests/211" }] },
        },
      ]),
      "#208, #209, #210, #211",
    );
    assert.equal(
      queueConstituentPrEvidenceRef({
        links: { self: { url: "https://api.github.example.test/repos/org/repo/pulls/212" } },
      }),
      "pr:#212",
    );
  });

  test("summarizes cached constituent PR numbers from evidence refs", () => {
    assert.equal(
      queueConstituentPrNumberSummary([
        { status: "queued", evidenceRefs: [" validation:ignore ", "pr:#213"] },
        { status: "queued", evidence_refs: ["merge-request:!214"] },
        { status: "queued", comment_ref: "pr:#216" },
        { status: "queued", source_refs: ["validation:ignore", "merge-request:!217"] },
      ]),
      "#213, #214, #216, #217",
    );
    assert.equal(queueConstituentPrEvidenceRef({ evidenceRefs: ["pr:#215"] }), "pr:#215");
    assert.equal(queueConstituentPrEvidenceRef({ commentRef: "pr:#218" }), "pr:#218");
  });

  test("summarizes direct edge-shaped constituent PR records", () => {
    const constituent = {
      __typename: "ConstituentEdge",
      cursor: "constituent-221",
      node: {
        prNumber: "221",
        state: "success",
        title: "Edge API update",
        head: {
          cursor: "head-221",
          node: { oid: "edgehead221abcdef" },
        },
      },
    };

    assert.equal(queueConstituentPrNumberSummary([constituent]), "#221");
    assert.equal(queueConstituentPrSummary([constituent]), "#221 (validated, Edge API update, head edgehead)");
    assert.equal(queueConstituentPrEvidenceRef(constituent), "pr:#221");
  });

  test("caps constituent summaries without hiding the omitted count", () => {
    const constituents = Array.from({ length: 10 }, (_, index) => ({
      number: index + 1,
      status: "queued",
    }));

    assert.equal(queueConstituentPrNumberSummary(constituents, 3), "#1, #2, #3, 7 more");
    assert.equal(queueConstituentPrSummary(constituents, 2), "#1 (queued); #2 (queued); 8 more");
  });

  test("fits verbose constituent status summaries without hiding the omitted count", () => {
    const constituents = [
      { number: 178, status: "queued" },
      { number: 179, status: "queued" },
      { number: 180, status: "queued" },
      { number: 182, status: "queued" },
      {
        number: 185,
        status: "merged_into_queue",
        title: "Connector/settings refresh plus chat orchestration trace stack integration.",
        head_sha: "c56e49c5abcdef",
      },
      {
        number: 189,
        status: "merged_into_queue",
        title: "Carbon card-step orchestration state rendering integration.",
        head_sha: "eafba5d0abcdef",
      },
      {
        number: 190,
        status: "merged_into_queue",
        title: "Orchestration state naming promotion integration.",
        head_sha: "082a9bb4abcdef",
      },
      { number: 191, status: "merged_into_queue" },
      { number: 192, status: "queued" },
      { number: 193, status: "queued" },
      { number: 194, status: "queued" },
      { number: 197, status: "queued" },
      { number: 198, status: "queued" },
    ];

    const summary = queueConstituentPrSummary(constituents);

    assert.ok(summary.length <= QUEUE_CONSTITUENT_STATUS_SUMMARY_DETAIL_LIMIT);
    assert.match(summary, /#185 \(merged_into_queue, Connector\/settings refresh plus chat orch\.\.\., head c56e49c5\)/);
    assert.match(summary, /; 5 more$/);
  });

  test("prioritizes informative statuses when capped constituent summaries omit rows", () => {
    const constituents = [
      { number: 178, status: "queued" },
      { number: 179, status: "queued" },
      { number: 180, status: "queued" },
      { number: 182, status: "queued" },
      { number: 185, status: "merged_into_queue" },
      { number: 189, status: "merged_into_queue" },
      { number: 190, status: "merged_into_queue" },
      { number: 191, status: "merged_into_queue" },
      { number: 192, status: "merged_into_queue" },
      { number: 193, status: "merged_into_queue" },
      { number: 194, status: "merged_into_queue" },
      { number: 197, status: "queued" },
      { number: 198, status: "queued" },
    ];

    assert.equal(
      queueConstituentPrNumberSummary(constituents),
      "#185, #189, #190, #191, #192, #193, #194, #178, 5 more",
    );
    assert.equal(
      queueConstituentPrSummary(constituents),
      [
        "#185 (merged_into_queue)",
        "#189 (merged_into_queue)",
        "#190 (merged_into_queue)",
        "#191 (merged_into_queue)",
        "#192 (merged_into_queue)",
        "#193 (merged_into_queue)",
        "#194 (merged_into_queue)",
        "#178 (queued)",
        "5 more",
      ].join("; "),
    );
  });

  test("keeps blocked and unknown constituent PR numbers visible when capped", () => {
    const constituents = [
      { number: 501, status: "queued" },
      { number: 502, status: "queued" },
      { number: 503, status: "queued" },
      { number: 504, status: "queued" },
      { number: 505, status: "queued" },
      { number: 506, status: "queued" },
      { number: 507, status: "queued" },
      { number: 508, status: "queued" },
      { number: 509, status: "blocked" },
      { number: 510, status: "unknown" },
    ];

    assert.equal(queueConstituentPrNumberSummary(constituents, 5), "#509, #510, #501, #502, #503, 5 more");
    assert.equal(
      queueConstituentPrSummary(constituents, 5),
      "#509 (blocked); #510 (unknown); #501 (queued); #502 (queued); #503 (queued); 5 more",
    );
  });

  test("summarizes merge commits with safe unknown defaults", () => {
    assert.equal(
      queueMergeCommitSummary([
        { sha: " abcdef123456 ", pr_number: 201 },
        { sha: "   ", pr_number: -1 },
      ]),
      "abcdef12 (#201), unknown",
    );
    assert.equal(queueMergeCommitSummary([]), "none");
  });

  test("summarizes cached merge commit identifier aliases", () => {
    assert.equal(queueMergeCommitIdentifier({ oid: " oid201 ", pr_number: 201 }), "oid201");
    assert.equal(queueMergeCommitIdentifier({ sha: "   ", id: " id202 " }), "id202");
    assert.equal(queueMergeCommitIdentifier({ commit: { oid: " nested203 " } }), "nested203");
    assert.equal(queueMergeCommitIdentifier({ sha: "   " }), "");
    assert.equal(queueMergeCommitEvidenceRef({ oid: " oid201 " }), "commit:oid201");
    assert.equal(queueMergeCommitEvidenceRef({ sha: "   " }), "");
    assert.equal(queueMergeCommitPrEvidenceRef({ oid: " oid201 ", pr_number: 201 }), "pr:#201");
    assert.equal(queueMergeCommitPrEvidenceRef({ sha: "   " }), "");

    assert.equal(
      queueMergeCommitSummary([
        { oid: " oid201 ", pr_number: 201 },
        { id: " id202 ", pr_number: 202 },
        { commit: { oid: " nested203 " }, pr_number: 203 },
      ]),
      "oid201 (#201), id202 (#202), nested20 (#203)",
    );
  });

  test("summarizes cached merge commit PR number aliases", () => {
    assert.equal(
      queueMergeCommitSummary([
        { oid: " oid201 ", prNumber: 201 },
        { id: " id202 ", pullNumber: 202 },
        { commit: { oid: " nested203 " }, mergeRequestNumber: 203 },
        { oid: "oid204", prNumber: "204" },
        { oid: "oid205", merge_request_iid: "205" },
        { oid: "oid206", commit: { pr_number: "206" } },
        { oid: "oid207", commit: { mergeRequestNumber: 207 } },
        { oid: "oid208", commit: { pullRequestIid: "208" } },
        { oid: "oid209", mrNumber: "209" },
        { oid: "oid210", commit: { mr_iid: "210" } },
      ]),
      "oid201 (#201), id202 (#202), nested20 (#203), oid204 (#204), oid205 (#205), oid206 (#206), oid207 (#207), oid208 (#208), 2 more",
    );
    assert.equal(queueMergeCommitPrEvidenceRef({ oid: "oid206", commit: { pr_number: "206" } }), "pr:#206");
    assert.equal(queueMergeCommitPrEvidenceRef({ oid: "oid210", commit: { mr_iid: "210" } }), "pr:#210");
  });

  test("summarizes cached merge commit PR numbers from messages and URLs", () => {
    assert.equal(
      queueMergeCommitSummary([
        { sha: "abc201000000", subject: "Merge pull request #201 from org/api" },
        { sha: "def202000000", message: "Merge merge request !202 from group/ui\n\nSee merge request !202" },
        { sha: "ghi203000000", commit: { messageHeadline: "Merge PR #203 from org/worker" } },
        { sha: "jkl204000000", web_url: "https://gitlab.example.test/org/repo/-/merge_requests/204" },
        { sha: "mno205000000", pullRequestUrl: "https://github.example.test/org/repo/pull/205" },
        { sha: "nop206000000", commit: { mergeRequestUrl: "https://gitlab.example.test/org/repo/-/merge_requests/206" } },
        { sha: "qrs207000000", commit: { pull_request_url: "https://github.example.test/org/repo/pull/207" } },
        {
          sha: "pqr208000000",
          message: [
            "Merge branch 'feature/api' into 'queue/main'",
            "",
            "See merge request org/repo!208",
          ].join("\n"),
        },
        {
          sha: "stu209000000",
          message: "Document API release\n\nSee merge request org/repo!209",
        },
      ]),
      [
        "abc20100 (#201)",
        "def20200 (#202)",
        "ghi20300 (#203)",
        "jkl20400 (#204)",
        "mno20500 (#205)",
        "nop20600 (#206)",
        "qrs20700 (#207)",
        "pqr20800 (#208)",
        "1 more",
      ].join(", "),
    );
    assert.equal(
      queueMergeCommitPrEvidenceRef({
        sha: "abc201000000",
        subject: "Merge pull request #201 from org/api",
      }),
      "pr:#201",
    );
    assert.equal(
      queueMergeCommitPrEvidenceRef({
        sha: "jkl204000000",
        web_url: "https://gitlab.example.test/org/repo/-/merge_requests/204",
      }),
      "pr:#204",
    );
    assert.equal(
      queueMergeCommitPrEvidenceRef({
        sha: "nop206000000",
        commit: { mergeRequestUrl: "https://gitlab.example.test/org/repo/-/merge_requests/206" },
      }),
      "pr:#206",
    );
    assert.equal(
      queueMergeCommitPrEvidenceRef({
        sha: "qrs207000000",
        commit: { pull_request_url: "https://github.example.test/org/repo/pull/207" },
      }),
      "pr:#207",
    );
    assert.equal(
      queueMergeCommitPrEvidenceRef({
        sha: "pqr208000000",
        message: [
          "Merge branch 'feature/api' into 'queue/main'",
          "",
          "See merge request org/repo!208",
        ].join("\n"),
      }),
      "pr:#208",
    );
    assert.equal(
      queueMergeCommitPrEvidenceRef({
        sha: "stu209000000",
        message: "Document API release\n\nSee merge request org/repo!209",
      }),
      "",
    );
  });

  test("summarizes cached GitLab trailer PR numbers split across headline and body aliases", () => {
    assert.equal(
      queueMergeCommitSummary([
        {
          sha: "top210000000",
          subject: "Merge branch 'feature/api' into 'queue/main'",
          body: "See merge request org/repo!210",
        },
        {
          sha: "nested211000000",
          commit: {
            messageHeadline: "Merge branch 'feature/ui' into 'queue/main'",
            messageBody: "See merge request org/repo!211",
          },
        },
        {
          sha: "ordinary212000000",
          subject: "Document release",
          body: "See merge request org/repo!212",
        },
      ]),
      "top21000 (#210), nested21 (#211), ordinary",
    );
    assert.equal(
      queueMergeCommitPrEvidenceRef({
        sha: "nested211000000",
        commit: {
          messageHeadline: "Merge branch 'feature/ui' into 'queue/main'",
          messageBody: "See merge request org/repo!211",
        },
      }),
      "pr:#211",
    );
  });

  test("summarizes cached GitLab noun-style merge request subjects", () => {
    assert.equal(
      queueMergeCommitSummary([
        { sha: "gitlab214000000", subject: "Merge request !214 from group/project" },
        { sha: "ordinary215000000", subject: "Merge request handling for release 215" },
      ]),
      "gitlab21 (#214), ordinary",
    );
    assert.equal(
      queueMergeCommitPrEvidenceRef({
        sha: "gitlab214000000",
        subject: "Merge request !214 from group/project",
      }),
      "pr:#214",
    );
  });

  test("summarizes cached merged PR and MR subjects", () => {
    assert.equal(
      queueMergeCommitSummary([
        { sha: "ado201000000", subject: "Merged PR 201: API update" },
        { sha: "ado202000000", subject: "Merged pull request 202: UI update" },
        { sha: "ado203000000", subject: "Merged MR !203: GitLab update" },
        { sha: "ordinary204000000", subject: "Merged feature branch for release 204" },
      ]),
      "ado20100 (#201), ado20200 (#202), ado20300 (#203), ordinary",
    );
    assert.equal(
      queueMergeCommitPrEvidenceRef({
        sha: "ado204000000",
        subject: "Merged merge request !204: GitLab update",
      }),
      "pr:#204",
    );
  });

  test("summarizes cached merge commit PR numbers from link maps", () => {
    assert.equal(
      queueMergeCommitSummary([
        {
          sha: "link212000000",
          links: { html: { href: "https://github.example.test/org/repo/pull/212" } },
        },
        {
          sha: "nested213000000",
          commit: {
            _links: { web: "https://gitlab.example.test/org/repo/-/merge_requests/213" },
          },
        },
      ]),
      "link2120 (#212), nested21 (#213)",
    );
    assert.equal(
      queueMergeCommitPrEvidenceRef({
        sha: "api214000000",
        _links: { self: { url: "https://api.github.example.test/repos/org/repo/pulls/214" } },
      }),
      "pr:#214",
    );
  });

  test("summarizes cached merge commit identifiers and PR numbers from evidence refs", () => {
    assert.equal(
      queueMergeCommitSummary([
        { evidenceRefs: ["commit:evidence216", "pr:#216"] },
        { commit: { evidence_refs: ["commit:nested217", "merge-request:!217"] } },
        { comment_ref: "commit:comment218", source_ref: "pr:#218" },
        { commit: { commentRefs: ["commit:nested219"], sourceRefs: ["merge-request:!219"] } },
      ]),
      "evidence (#216), nested21 (#217), comment2 (#218), nested21 (#219)",
    );
    assert.equal(queueMergeCommitEvidenceRef({ evidenceRefs: ["commit:evidence216"] }), "commit:evidence216");
    assert.equal(queueMergeCommitPrEvidenceRef({ evidenceRefs: ["pr:#216"] }), "pr:#216");
    assert.equal(queueMergeCommitEvidenceRef({ commentRef: "commit:comment218" }), "commit:comment218");
    assert.equal(queueMergeCommitPrEvidenceRef({ sourceRefs: ["merge-request:!219"] }), "pr:#219");
  });

  test("summarizes direct edge-shaped merge commit records", () => {
    const commit = {
      __typename: "CommitEdge",
      cursor: "commit-221",
      node: {
        oid: "edge221abcdef",
        message: [
          "Merge PR #221",
          "",
          "Conflicts:",
          "\tpackages/api/src/edge.ts",
        ].join("\n"),
      },
    };
    const nestedCommit = {
      commit: {
        __typename: "Commit",
        cursor: "nested-222",
        node: {
          id: "nested222abcdef",
          messageHeadline: "Merge pull request #222",
        },
      },
    };

    assert.equal(queueMergeCommitSummary([commit, nestedCommit]), "edge221a (#221), nested22 (#222)");
    assert.equal(queueMergeCommitIdentifier(commit), "edge221abcdef");
    assert.equal(queueMergeCommitEvidenceRef(commit), "commit:edge221abcdef");
    assert.equal(queueMergeCommitPrEvidenceRef(commit), "pr:#221");
    assert.deepEqual(queueConflictFileSummary([commit]), {
      count: 1,
      detail: "packages/api/src/edge.ts",
    });
  });

  test("deduplicates and caps conflict file summaries", () => {
    assert.deepEqual(
      queueConflictFileSummary([
        { conflict_files: [" packages/api/src/app.ts ", "", "apps/web/src/App.tsx"] },
        { conflict_files: ["packages/api/src/app.ts", "packages/workers/src/job.ts"] },
      ], 2),
      {
        count: 3,
        detail: "apps/web/src/App.tsx, packages/api/src/app.ts, 1 more",
      },
    );
    assert.deepEqual(queueConflictFileSummary([]), { count: 0, detail: "none" });
  });

  test("summarizes cached merge commit conflict file aliases", () => {
    assert.deepEqual(
      queueConflictFileSummary([
        { conflictFiles: [" packages/api/src/app.ts ", "apps/web/src/App.tsx"] },
        { conflicting_files: ["apps/web/src/App.tsx", "packages/workers/src/job.ts"] },
        { conflictingFiles: [" packages/api/src/app.ts ", ""] },
        { conflictFile: "packages/ui/src/button.ts" },
        { conflicting_file: " packages/workers/src/job.ts " },
        { commit: { conflictFiles: ["packages/api/src/app.ts", "packages/config/src/nested.ts"] } },
        { commit: { conflicting_file: " packages/ui/src/nested.ts " } },
      ]),
      {
        count: 6,
        detail: "apps/web/src/App.tsx, packages/api/src/app.ts, packages/config/src/nested.ts, packages/ui/src/button.ts, packages/ui/src/nested.ts, packages/workers/src/job.ts",
      },
    );
  });

  test("summarizes connection-shaped merge commit conflict file aliases", () => {
    assert.deepEqual(
      queueConflictFileSummary([
        {
          conflictFiles: {
            nodes: [" packages/api/src/node.ts ", { path: "apps/web/src/App.tsx" }],
          },
        },
        {
          conflictingFiles: {
            edges: [
              { node: "apps/web/src/App.tsx" },
              { node: { filename: "packages/workers/src/job.ts" } },
            ],
          },
        },
        {
          commit: {
            conflictFiles: {
              edges: [
                { node: { newPath: "packages/config/src/nested.ts" } },
              ],
            },
          },
        },
      ]),
      {
        count: 4,
        detail: "apps/web/src/App.tsx, packages/api/src/node.ts, packages/config/src/nested.ts, packages/workers/src/job.ts",
      },
    );
  });

  test("summarizes cached merge commit conflict files from message aliases", () => {
    assert.deepEqual(
      queueConflictFileSummary([
        {
          sha: "message201",
          message: [
            "Merge PR #201",
            "",
            "# Conflicts:",
            "#\tpackages/api/src/message.ts",
            "    apps/web/src/message.ts",
            "",
            "Resolved by keeping the queue head API shape.",
          ].join("\n"),
        },
        {
          sha: "nested202",
          commit: {
            messageHeadline: "Merge PR #202",
            messageBody: [
              "Conflicts:",
              "  - packages/ui/src/card.ts",
            ].join("\n"),
          },
        },
        {
          sha: "alias203",
          conflictFile: "packages/workers/src/job.ts",
          message_body: [
            "Conflicts:",
            "\tpackages/workers/src/job.ts",
            "\tpackages/cli/src/run.ts",
          ].join("\n"),
        },
      ]),
      {
        count: 5,
        detail: "apps/web/src/message.ts, packages/api/src/message.ts, packages/cli/src/run.ts, packages/ui/src/card.ts, packages/workers/src/job.ts",
      },
    );
  });
});
