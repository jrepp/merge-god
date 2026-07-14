import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  extractMergedConstituentNumbers,
  extractConstituentHints,
  hasQueueVocabulary,
  isExplicitQueueLikeTitle,
  orderedConstituentEvidenceRefs,
  parseMergedPrNumbersFromQueueProse,
  parsePrNumbersFromQueueTitle,
} from "../queue_membership_model";
import { REVIEW_GATE_CACHE_MARKER } from "../review_gate_cache";

describe("queue membership model", () => {
  test("recognizes explicit queue titles and queue vocabulary", () => {
    assert.equal(isExplicitQueueLikeTitle("Manual queue for PRs #10 and #11"), true);
    assert.equal(isExplicitQueueLikeTitle("Merge train MRs !10 and !11"), true);
    assert.equal(isExplicitQueueLikeTitle("MR train !10 and !11"), true);
    assert.equal(isExplicitQueueLikeTitle("Release train #42"), false);
    assert.equal(isExplicitQueueLikeTitle("Feature queue cleanup"), false);
    assert.equal(hasQueueVocabulary("Feature queue cleanup"), true);
    assert.equal(hasQueueVocabulary("Release train planning"), false);
    assert.equal(hasQueueVocabulary("Single PR bug fix"), false);
  });

  test("parses deduped bounded PR ranges and lists from queue titles", () => {
    assert.deepEqual(
      parsePrNumbersFromQueueTitle("Merge queue PRs #101 through #103, #103 and #105"),
      [101, 102, 103, 105],
    );
    assert.deepEqual(
      parsePrNumbersFromQueueTitle("Merge MRs !201 through !203, !203 and !205"),
      [201, 202, 203, 205],
    );
    assert.deepEqual(
      parsePrNumbersFromQueueTitle("Merge requests !301, !302 and !304"),
      [301, 302, 304],
    );
    assert.deepEqual(
      parsePrNumbersFromQueueTitle("Merge pull requests #401, #402 and #404"),
      [401, 402, 404],
    );
    assert.deepEqual(
      parsePrNumbersFromQueueTitle("Pull requests queue #501 through #503"),
      [501, 502, 503],
    );
    assert.deepEqual(
      parsePrNumbersFromQueueTitle("Merge train MRs !601 through !603"),
      [601, 602, 603],
    );
    assert.deepEqual(
      parsePrNumbersFromQueueTitle("Merge train: !701, !702 and !704"),
      [701, 702, 704],
    );
    assert.deepEqual(parsePrNumbersFromQueueTitle("Merge queue #1 through #1000"), [1, 1000]);
    assert.deepEqual(parsePrNumbersFromQueueTitle("Regular implementation #42"), []);
  });

  test("parses long real-world queue title lists without dropping the tail", () => {
    assert.deepEqual(
      parsePrNumbersFromQueueTitle(
        "RC1 Merge queue: PRs 178, 179, 180, 182, 185, 189, 190, 191, 192, 193, 194, 197, 198",
      ),
      [178, 179, 180, 182, 185, 189, 190, 191, 192, 193, 194, 197, 198],
    );
  });

  test("parses queue-targeted merge-forward prose without treating ordinary refs as merged", () => {
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Consolidation update after merging #189 and #194 into this queue branch."),
      [189, 194],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Merged PRs #191, #192, and #193 to the queue head."),
      [191, 192, 193],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Merged PRs 189, 194, and 197 into this queue branch."),
      [189, 194, 197],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Landed MRs 201/202/203 onto the merge queue head."),
      [201, 202, 203],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Merged PRs 189 and 194 into this queue branch; follow-up PR #197 remains queued."),
      [189, 194],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Merged #201 into the queue branch and referenced #202 as still pending."),
      [201],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("After reviewing PR #188, merged PRs 189 and 194 into this queue branch."),
      [189, 194],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Merged PRs 189 and 194 after resolving #188 into this queue branch."),
      [189, 194],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Merged #189 and #194 after resolving #188 into this queue branch."),
      [189, 194],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Merged into the queue branch: PRs 301 and 302."),
      [301, 302],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Merged into the queue branch; PR #302 remains pending."),
      [],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Kept PR #183/#194 queue head as the best implementation baseline."),
      [],
    );
    assert.deepEqual(
      parseMergedPrNumbersFromQueueProse("Merged #201 into feature branch and referenced #202 in notes."),
      [],
    );
  });

  test("extracts merged constituent evidence refs from queue prose comments", () => {
    const merged = extractMergedConstituentNumbers(
      { body: "Merged PR #201 onto the queue head." },
      [
        {
          html_url: "https://example.test/org/repo/pull/300#issuecomment-215622762",
          body: "Consolidation update after merging PRs 202 and 203 into this queue branch.",
        },
        {
          html_url: "https://example.test/org/repo/pull/300#issuecomment-215622763",
          body: "Kept PR #204 queue head as the baseline.",
        },
      ],
    );

    assert.deepEqual([...merged.entries()], [
      [201, ["github:pr-body"]],
      [202, ["https://example.test/org/repo/pull/300#issuecomment-215622762"]],
      [203, ["https://example.test/org/repo/pull/300#issuecomment-215622762"]],
    ]);
  });

  test("extracts constituent hints from PR bodies, comments, review comments, and tables", () => {
    const hints = extractConstituentHints(
      {
        body: [
          "| PR | Title | Head |",
          "| --- | --- | --- |",
          "| [#201](https://example.test/org/repo/pull/201) | API work | abcdef1 |",
          "| [#205](https://api.example.test/repos/org/repo/pulls/205) | API URL work | abcdef5 |",
          "| [!207](https://gitlab.example.test/org/repo/-/merge_requests/207) | GitLab MR work | abcdef7 |",
          "| !209 | GitLab plain MR work | abcdef9 |",
          "| Pull Request: #211 | Long PR work | abcdefb |",
          "| [Table link label](https://example.test/org/repo/pull/213) | Explicit table title | abcdefd |",
          "| [Only table label](https://gitlab.example.test/org/repo/-/merge_requests/214) | | abcdefe |",
          "- #202 - UI work head: `abcdef2`",
          "- MR !210 - Release MR head: abcdefa",
          "- Merge Request: !212 - Long MR head: abcdefc",
          "- [Body link label](https://example.test/org/repo/pull/215)",
        ].join("\n"),
      },
      [
        {
          html_url: "https://example.test/org/repo/pull/300#issuecomment-1",
          body: "https://example.test/org/repo/pull/203 Background task",
        },
        {
          html_url: "https://example.test/org/repo/pull/300#issuecomment-2",
          body: "https://api.example.test/repos/org/repo/pulls/206 API background task",
        },
        {
          html_url: "https://example.test/org/repo/pull/300#issuecomment-3",
          body: "https://gitlab.example.test/org/repo/-/merge_requests/208 MR background task",
        },
        {
          html_url: "https://example.test/org/repo/pull/300#issuecomment-4",
          body: "[Comment link label](https://example.test/org/repo/pull/216)",
        },
      ],
      [
        {
          url: "https://example.test/org/repo/pull/300#discussion_r1",
          body: "PR #204: Worker cleanup",
        },
      ],
    );

    assert.deepEqual([...hints.keys()], [201, 205, 207, 209, 211, 213, 214, 202, 210, 212, 215, 203, 206, 208, 216, 204]);
    assert.deepEqual(hints.get(201), {
      number: 201,
      title: "API work",
      url: "https://example.test/org/repo/pull/201",
      head_sha: "abcdef1",
      evidence_refs: ["pr:#201", "github:pr-body"],
    });
    assert.deepEqual(hints.get(202), {
      number: 202,
      title: "UI work",
      url: null,
      head_sha: "abcdef2",
      evidence_refs: ["pr:#202", "github:pr-body"],
    });
    assert.deepEqual(hints.get(203), {
      number: 203,
      title: "Background task",
      url: "https://example.test/org/repo/pull/203",
      head_sha: null,
      evidence_refs: ["pr:#203", "https://example.test/org/repo/pull/300#issuecomment-1"],
    });
    assert.deepEqual(hints.get(204), {
      number: 204,
      title: "Worker cleanup",
      url: null,
      head_sha: null,
      evidence_refs: ["pr:#204", "https://example.test/org/repo/pull/300#discussion_r1"],
    });
    assert.deepEqual(hints.get(205), {
      number: 205,
      title: "API URL work",
      url: "https://api.example.test/repos/org/repo/pulls/205",
      head_sha: "abcdef5",
      evidence_refs: ["pr:#205", "github:pr-body"],
    });
    assert.deepEqual(hints.get(206), {
      number: 206,
      title: "API background task",
      url: "https://api.example.test/repos/org/repo/pulls/206",
      head_sha: null,
      evidence_refs: ["pr:#206", "https://example.test/org/repo/pull/300#issuecomment-2"],
    });
    assert.deepEqual(hints.get(207), {
      number: 207,
      title: "GitLab MR work",
      url: "https://gitlab.example.test/org/repo/-/merge_requests/207",
      head_sha: "abcdef7",
      evidence_refs: ["pr:#207", "github:pr-body"],
    });
    assert.deepEqual(hints.get(208), {
      number: 208,
      title: "MR background task",
      url: "https://gitlab.example.test/org/repo/-/merge_requests/208",
      head_sha: null,
      evidence_refs: ["pr:#208", "https://example.test/org/repo/pull/300#issuecomment-3"],
    });
    assert.deepEqual(hints.get(209), {
      number: 209,
      title: "GitLab plain MR work",
      url: null,
      head_sha: "abcdef9",
      evidence_refs: ["pr:#209", "github:pr-body"],
    });
    assert.deepEqual(hints.get(210), {
      number: 210,
      title: "Release MR",
      url: null,
      head_sha: "abcdefa",
      evidence_refs: ["pr:#210", "github:pr-body"],
    });
    assert.deepEqual(hints.get(211), {
      number: 211,
      title: "Long PR work",
      url: null,
      head_sha: "abcdefb",
      evidence_refs: ["pr:#211", "github:pr-body"],
    });
    assert.deepEqual(hints.get(212), {
      number: 212,
      title: "Long MR",
      url: null,
      head_sha: "abcdefc",
      evidence_refs: ["pr:#212", "github:pr-body"],
    });
    assert.deepEqual(hints.get(213), {
      number: 213,
      title: "Explicit table title",
      url: "https://example.test/org/repo/pull/213",
      head_sha: "abcdefd",
      evidence_refs: ["pr:#213", "github:pr-body"],
    });
    assert.deepEqual(hints.get(214), {
      number: 214,
      title: "Only table label",
      url: "https://gitlab.example.test/org/repo/-/merge_requests/214",
      head_sha: "abcdefe",
      evidence_refs: ["pr:#214", "github:pr-body"],
    });
    assert.deepEqual(hints.get(215), {
      number: 215,
      title: "Body link label",
      url: "https://example.test/org/repo/pull/215",
      head_sha: null,
      evidence_refs: ["pr:#215", "github:pr-body"],
    });
    assert.deepEqual(hints.get(216), {
      number: 216,
      title: "Comment link label",
      url: "https://example.test/org/repo/pull/216",
      head_sha: null,
      evidence_refs: ["pr:#216", "https://example.test/org/repo/pull/300#issuecomment-4"],
    });
  });

  test("extracts repo-qualified PR and MR shorthand without closing references", () => {
    const hints = extractConstituentHints(
      {
        body: [
          "- example-org/example-repo#217 - API queue lane head: abcdef1",
          "| PR | Title | Head |",
          "| --- | --- | --- |",
          "| group/subgroup/repo!218 | GitLab queue lane | abcdef2 |",
          "Closes example-org/example-repo#999",
        ].join("\n"),
      },
      [
        {
          html_url: "https://example.test/org/repo/pull/300#issuecomment-shorthand",
          body: "example-org/example-repo#219 Worker lane",
        },
      ],
    );

    assert.deepEqual([...hints.keys()], [217, 218, 219]);
    assert.deepEqual(hints.get(217), {
      number: 217,
      title: "API queue lane",
      url: null,
      head_sha: "abcdef1",
      evidence_refs: ["pr:#217", "github:pr-body"],
    });
    assert.deepEqual(hints.get(218), {
      number: 218,
      title: "GitLab queue lane",
      url: null,
      head_sha: "abcdef2",
      evidence_refs: ["pr:#218", "github:pr-body"],
    });
    assert.deepEqual(hints.get(219), {
      number: 219,
      title: "Worker lane",
      url: null,
      head_sha: null,
      evidence_refs: ["pr:#219", "https://example.test/org/repo/pull/300#issuecomment-shorthand"],
    });
  });

  test("does not treat validation lines, closing references, or cached review gates as constituents", () => {
    const hints = extractConstituentHints(
      {
        body: [
          "Fixes #500",
          "- scope: #501 `npm test` -> failed",
          "#502 - Real queue item",
          "#505 npm test -> failed",
          "- #506 ✅ API update",
          "- #507 ❌ UI update",
          "- #508 ⏳ Worker update",
          "- #509 Docs update ✅",
          "- #510 Release update ❌",
          "- #511 (✅) Mobile update",
          "- #512 [❌] Data update",
          "- #513 Ops update (⏳)",
          "- #514 Build update [✅]",
          "- #515 ✅: Config update",
          "- #516 ❌ - Routing update",
          "- #517 [⏳]: Deploy update",
          "- #518 Release train - ✅",
        ].join("\n"),
      },
      [
        {
          html_url: "https://example.test/org/repo/pull/300#issuecomment-cache",
          body: `${REVIEW_GATE_CACHE_MARKER}\n#503 - cached item`,
        },
        {
          html_url: "https://example.test/org/repo/pull/300#issuecomment-markerless-cache",
          body: [
            "## merge-god review gate status",
            "",
            "| PR | Title | Head |",
            "| --- | --- | --- |",
            "| #504 | markerless cached item | deadbee |",
          ].join("\n"),
        },
      ],
    );

    assert.deepEqual([...hints.keys()], [502, 506, 507, 508, 509, 510, 511, 512, 513, 514, 515, 516, 517, 518]);
    assert.equal(hints.get(506)?.title, "API update");
    assert.equal(hints.get(507)?.title, "UI update");
    assert.equal(hints.get(508)?.title, "Worker update");
    assert.equal(hints.get(509)?.title, "Docs update");
    assert.equal(hints.get(510)?.title, "Release update");
    assert.equal(hints.get(511)?.title, "Mobile update");
    assert.equal(hints.get(512)?.title, "Data update");
    assert.equal(hints.get(513)?.title, "Ops update");
    assert.equal(hints.get(514)?.title, "Build update");
    assert.equal(hints.get(515)?.title, "Config update");
    assert.equal(hints.get(516)?.title, "Routing update");
    assert.equal(hints.get(517)?.title, "Deploy update");
    assert.equal(hints.get(518)?.title, "Release train");
    assert.deepEqual(hints.get(502)?.title, "Real queue item");
  });

  test("ignores malformed markdown link refs with non-positive or mismatched URL numbers", () => {
    const hints = extractConstituentHints(
      {
        body: [
          "| PR | Title |",
          "| --- | --- |",
          "| [#238](https://example.test/org/repo/pull/0) | zero URL table row |",
          "| [#239](https://example.test/org/repo/pull/240) | mismatched table row |",
          "| [!241](https://gitlab.example.test/org/repo/-/merge_requests/242) | mismatched MR table row |",
          "| [Pull request 244](https://example.test/org/repo/pull/245) | mismatched long-form table row |",
          "| [Merge request 246](https://gitlab.example.test/org/repo/-/merge_requests/247) | mismatched long-form MR table row |",
          "| [API row](https://example.test/org/repo/pull/243) | valid descriptive table row |",
          "- [#0](https://example.test/org/repo/pull/230) zero label",
          "- [#231](https://example.test/org/repo/pull/0) zero URL",
          "- [#232](https://example.test/org/repo/pull/233) mismatched GitHub link",
          "- [!234](https://gitlab.example.test/org/repo/-/merge_requests/235) mismatched GitLab link",
          "- [Pull request 248](https://example.test/org/repo/pull/249) mismatched long-form GitHub link",
          "- [Merge request 250](https://gitlab.example.test/org/repo/-/merge_requests/251) mismatched long-form GitLab link",
          "- [#236](https://example.test/org/repo/pull/236) valid GitHub link",
          "- [!237](https://gitlab.example.test/org/repo/-/merge_requests/237) valid GitLab link",
          "- [Pull request 252](https://example.test/org/repo/pull/252) valid long-form GitHub link",
          "- [Merge request 253](https://gitlab.example.test/org/repo/-/merge_requests/253) valid long-form GitLab link",
        ].join("\n"),
      },
      [],
    );

    assert.deepEqual([...hints.keys()], [243, 236, 237, 252, 253]);
    assert.deepEqual(hints.get(243), {
      number: 243,
      title: "valid descriptive table row",
      url: "https://example.test/org/repo/pull/243",
      head_sha: null,
      evidence_refs: ["pr:#243", "github:pr-body"],
    });
    assert.deepEqual(hints.get(236), {
      number: 236,
      title: "valid GitHub link",
      url: "https://example.test/org/repo/pull/236",
      head_sha: null,
      evidence_refs: ["pr:#236", "github:pr-body"],
    });
    assert.deepEqual(hints.get(237), {
      number: 237,
      title: "valid GitLab link",
      url: "https://gitlab.example.test/org/repo/-/merge_requests/237",
      head_sha: null,
      evidence_refs: ["pr:#237", "github:pr-body"],
    });
  });

  test("does not treat non-constituent status tables as constituent hints", () => {
    const hints = extractConstituentHints(
      {
        body: [
          "| Command | Status | Detail |",
          "| --- | --- | --- |",
          "| `npm run test` | Fail | `unit-node`, `unit-jsdom`, and storybook lanes failed. |",
          "",
          "| Area | Observed failures |",
          "| --- | --- |",
          "| `unit-jsdom` chat/settings/design-system tests | 5 files failed, 99 passed; 16 failed tests, 1146 passed, 8 skipped. |",
          "",
          "| Area | Commit | Evidence |",
          "| --- | --- | --- |",
          "| Agent completion budget | [`0fa6461`](https://github.example.test/example-org/example-agent/commit/0fa6461) in [agent PR #92](https://github.example.test/example-org/example-agent/pull/92) | Runtime budget change. |",
        ].join("\n"),
      },
      [],
    );

    assert.deepEqual([...hints.keys()], []);
  });

  test("does not use merge commit table cells as constituent titles", () => {
    const hints = extractConstituentHints(
      {
        body: [
          "| Merge commit | PR | Purpose | Notes |",
          "| --- | --- | --- | --- |",
          "| [`740e4fc9`](https://github.example.test/org/repo/commit/740e4fc91b7612ecdbbe75fd207d952f8ad4757f) | #191 | Connector/settings refresh. | Merged cleanly. |",
          "| [`ca4bee0e`](https://github.example.test/org/repo/commit/ca4bee0ef5c558e41877694cdc90e3f69848ba54) | #192 | Carbon card-step rendering. | Resolved fixture cleanup conflicts. |",
        ].join("\n"),
      },
      [],
    );

    assert.deepEqual([...hints.keys()], [191, 192]);
    assert.equal(hints.get(191)?.title, "Connector/settings refresh.");
    assert.equal(hints.get(192)?.title, "Carbon card-step rendering.");
  });

  test("uses cached comment body and URL aliases for constituent hints", () => {
    const hints = extractConstituentHints(
      {},
      [
        {
          bodyText: "- #610 API alias head abcdef1234567890",
          htmlUrl: "https://example.test/pull/700#issuecomment-alias",
        },
        {
          text: "- #611 UI alias",
          webUrl: "https://example.test/pull/700#issuecomment-web",
        },
      ],
    );

    assert.deepEqual([...hints.keys()], [610, 611]);
    assert.deepEqual(hints.get(610), {
      number: 610,
      title: "API alias",
      url: null,
      head_sha: "abcdef1234567890",
      evidence_refs: ["pr:#610", "https://example.test/pull/700#issuecomment-alias"],
    });
    assert.deepEqual(hints.get(611), {
      number: 611,
      title: "UI alias",
      url: null,
      head_sha: null,
      evidence_refs: ["pr:#611", "https://example.test/pull/700#issuecomment-web"],
    });
  });

  test("normalizes direct edge-shaped PR body and comment hints", () => {
    const hints = extractConstituentHints(
      {
        cursor: "pr-body",
        node: {
          bodyText: "- #620 Body edge head: abcdef1",
        },
      },
      [
        {
          cursor: "comment-edge",
          node: {
            bodyText: "- #621 Comment edge",
            htmlUrl: "https://example.test/pull/700#issuecomment-edge",
          },
        },
      ],
    );

    assert.deepEqual([...hints.keys()], [620, 621]);
    assert.deepEqual(hints.get(620), {
      number: 620,
      title: "Body edge",
      url: null,
      head_sha: "abcdef1",
      evidence_refs: ["pr:#620", "github:pr-body"],
    });
    assert.deepEqual(hints.get(621), {
      number: 621,
      title: "Comment edge",
      url: null,
      head_sha: null,
      evidence_refs: ["pr:#621", "https://example.test/pull/700#issuecomment-edge"],
    });
  });

  test("cleans sentence punctuation after raw constituent URLs", () => {
    const hints = extractConstituentHints(
      {},
      [
        {
          html_url: "https://example.test/pull/700#issuecomment-period",
          body: "https://example.test/pull/612. Period task",
        },
        {
          html_url: "https://example.test/pull/700#issuecomment-semicolon",
          body: "https://gitlab.example.test/org/repo/-/merge_requests/613; Semicolon task",
        },
      ],
    );

    assert.equal(hints.get(612)?.title, "Period task");
    assert.equal(hints.get(613)?.title, "Semicolon task");
    assert.equal(hints.get(612)?.url, "https://example.test/pull/612");
    assert.equal(hints.get(613)?.url, "https://gitlab.example.test/org/repo/-/merge_requests/613");
  });

  test("does not treat incidental prose PR links as constituent hints", () => {
    const hints = extractConstituentHints(
      {
        body: [
          "See https://example.test/org/repo/pull/700 for prior discussion.",
          "Related context: [prior work](https://example.test/org/repo/pull/701).",
          "- https://example.test/org/repo/pull/702 Real constituent",
          "- [Linked constituent](https://example.test/org/repo/pull/703)",
          "PR: [Prefixed constituent](https://example.test/org/repo/pull/704)",
          "<https://gitlab.example.test/org/repo/-/merge_requests/705> Angle-wrapped constituent",
          "Constituent: [Named constituent](https://example.test/org/repo/pull/707)",
          "Source PR: https://example.test/org/repo/pull/708 Source branch",
          "Queue MR: [Queue merge request](https://gitlab.example.test/org/repo/-/merge_requests/709)",
          "Constituents: [API item](https://example.test/org/repo/pull/710), [UI item](https://example.test/org/repo/pull/711), and [Worker item](https://example.test/org/repo/pull/712)",
          "Sources: https://example.test/org/repo/pull/713; https://gitlab.example.test/org/repo/-/merge_requests/714",
          "Sources: <https://example.test/org/repo/pull/715>, and <https://gitlab.example.test/org/repo/-/merge_requests/716>",
        ].join("\n"),
      },
      [
        {
          html_url: "https://example.test/pull/800#issuecomment-related-link",
          body: "For context see https://example.test/org/repo/pull/706 before landing.",
        },
      ],
    );

    assert.deepEqual([...hints.keys()], [702, 703, 704, 705, 707, 708, 709, 710, 711, 712, 713, 714, 715, 716]);
    assert.equal(hints.get(702)?.title, "Real constituent");
    assert.equal(hints.get(703)?.title, "Linked constituent");
    assert.equal(hints.get(704)?.title, "Prefixed constituent");
    assert.equal(hints.get(705)?.title, "Angle-wrapped constituent");
    assert.equal(hints.get(707)?.title, "Named constituent");
    assert.equal(hints.get(708)?.title, "Source branch");
    assert.equal(hints.get(709)?.title, "Queue merge request");
    assert.equal(hints.get(710)?.title, "API item");
    assert.equal(hints.get(711)?.title, "UI item");
    assert.equal(hints.get(712)?.title, "Worker item");
    assert.equal(hints.get(713)?.title, null);
    assert.equal(hints.get(714)?.title, null);
    assert.equal(hints.get(715)?.title, null);
    assert.equal(hints.get(716)?.title, null);
  });

  test("ignores malformed comment records while preserving body hints", () => {
    const hints = extractConstituentHints(
      { body: "#601 - Body item" },
      [null, "not a comment", 42],
    );

    assert.deepEqual([...hints.keys()], [601]);
    assert.equal(hints.get(601)?.title, "Body item");
  });

  test("orders constituent evidence refs with direct PR ref last and without duplicates", () => {
    assert.deepEqual(
      orderedConstituentEvidenceRefs(
        42,
        ["pr:#42", " github:body ", "github:body"],
        ["queue:validation", "pr:#42"],
      ),
      ["github:body", "queue:validation", "pr:#42"],
    );
  });
});
