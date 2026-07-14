import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  practitionerActivityLabel,
  practitionerGateCallToAction,
  practitionerNextActionLabel,
  practitionerPhaseLabel,
  practitionerRunCallToAction,
  practitionerRunStatusLabel,
  practitionerWorkflowLabel,
} from "../practitioner_language_model";

describe("practitioner language model", () => {
  test("translates internal workflow terms into practitioner language", () => {
    assert.equal(practitionerWorkflowLabel("embark_cohort"), "Merge group");
    assert.equal(practitionerRunStatusLabel("blocked"), "Action required");
    assert.equal(practitionerPhaseLabel("embark_replanning"), "Choosing a safe next approach");
    assert.equal(practitionerNextActionLabel("operator_handoff"), "Maintainer decision needed");
    assert.equal(practitionerActivityLabel("merge_gate"), "Check whether the PRs can merge");
  });

  test("turns merge failure evidence into a specific CTA", () => {
    assert.equal(
      practitionerRunCallToAction([
        {
          number: 204,
          status: "blocked",
          next_action: "replan",
          blockers: [{ summary: "The startup script has overlapping changes." }],
        },
      ]),
      "PR #204: The startup script has overlapping changes. Decide the intended result, update the PR, and rerun the merge group.",
    );
  });

  test("uses direct remediation language for blocked review gates", () => {
    assert.equal(
      practitionerGateCallToAction([
        { rule: "merge-conflicts", status: "blocked", explanation: "Conflict in scripts/start-dev." },
      ]),
      "Resolve the listed merge conflict on the PR branch, push the update, and rerun Merge God.",
    );
    assert.equal(
      practitionerGateCallToAction([
        { rule: "design", status: "blocked", explanation: "Needs redesign." },
      ]),
      "Decide the intended behavior, update the PR to match that decision, and rerun Merge God.",
    );
  });

  test("does not use canned explainer headings", () => {
    const output = [
      practitionerRunCallToAction([{ number: 203, status: "ready", next_action: "await_replan" }]),
      practitionerGateCallToAction([
        { rule: "ci-status", status: "blocked", explanation: "Tests failed." },
      ]),
    ].join("\n");

    assert.doesNotMatch(output, /why it matters|what this means/i);
  });
});
