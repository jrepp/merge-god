import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFollowUpPrBody,
  defaultFollowUpBranch,
  followUpBaseBranch,
  linkedPrNumber,
  normalizeFollowUpPrInput,
  slugify,
} from "../follow_up_pr_model";

describe("follow-up PR model", () => {
  test("normalizes follow-up PR request aliases and evidence arrays", () => {
    assert.deepEqual(
      normalizeFollowUpPrInput({
        title: "  Repair flaky queue validation  ",
        body: "  Details stay operator-authored.  ",
        headBranch: "  fix/queue-validation  ",
        baseRefName: "  release/2026.07  ",
        linkedPrNumber: "205",
        commitMessage: "  fix: repair queue validation  ",
        draft: true,
        labels: [" follow-up ", "", "ci", "ci"],
        signal_refs: [" ci:build ", "", " ci:build ", "review:1"],
        grounding_refs: [" docs/merge-queues.md ", ""],
        validation_refs: [" npm test ", "npm test"],
      }),
      {
        title: "Repair flaky queue validation",
        body: "  Details stay operator-authored.  ",
        branch: "fix/queue-validation",
        base: "release/2026.07",
        linked_pr_number: 205,
        commit_message: "fix: repair queue validation",
        draft: true,
        labels: ["follow-up", "ci"],
        signal_refs: ["ci:build", "review:1"],
        grounding_refs: ["docs/merge-queues.md"],
        validation_refs: ["npm test"],
      },
    );
  });

  test("requires title, signal refs, and grounding refs", () => {
    assert.throws(
      () => normalizeFollowUpPrInput({ title: "", signal_refs: ["ci"], grounding_refs: ["docs"] }),
      /title is required/,
    );
    assert.throws(
      () => normalizeFollowUpPrInput({ title: "x", signal_refs: [], grounding_refs: ["docs"] }),
      /signal_refs is required/,
    );
    assert.throws(
      () => normalizeFollowUpPrInput({ title: "x", signal_refs: ["ci"], grounding_refs: [] }),
      /grounding_refs is required/,
    );
  });

  test("derives branch, base, linked PR, and body from work item context", () => {
    const input = normalizeFollowUpPrInput({
      title: "Fix API Drift",
      signal_refs: ["ci:api"],
      grounding_refs: ["AGENTS.md"],
    });
    const work = {
      kind: "pr",
      pr_number: 207,
      baseRefName: "develop",
    };

    assert.equal(defaultFollowUpBranch(input.title, work), "merge-god/pr-207-fix-api-drift");
    assert.equal(followUpBaseBranch(input, work), "develop");
    assert.equal(linkedPrNumber(work), 207);
    assert.equal(
      buildFollowUpPrBody(input, work),
      [
        "Opened by merge-god from PR #207.",
        "",
        "## merge-god remediation evidence",
        "",
        "Linked PR: #207",
        "",
        "Signal:",
        "- ci:api",
        "",
        "Project grounding:",
        "- AGENTS.md",
      ].join("\n"),
    );
  });

  test("slugifies empty and punctuation-only titles predictably", () => {
    assert.equal(slugify("Fix API Drift!"), "fix-api-drift");
    assert.equal(defaultFollowUpBranch("!!!", { issue_number: 42 }), "merge-god/issue-42-follow-up");
    assert.equal(followUpBaseBranch({ title: "x", signal_refs: ["s"], grounding_refs: ["g"] }, null), "main");
  });
});
