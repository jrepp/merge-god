import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  remediationModeLabelNames,
  remediationModeAllowsMutation,
  repositoryRemediationModeFromPolicy,
  resolveRemediationPolicy,
} from "../remediation_policy_model";

describe("remediation policy model", () => {
  test("publishes the complete visible PR label vocabulary", () => {
    assert.deepEqual(remediationModeLabelNames(), [
      "remediation:observe-only",
      "remediation:validate-only",
      "remediation:mechanical-fixes",
      "remediation:bounded-fixes",
      "remediation:maintainer-approved",
    ]);
  });

  test("uses the repository default when no PR label is present", () => {
    const decision = resolveRemediationPolicy({ repository_mode: "bounded-fixes" });

    assert.equal(decision.requested_source, "repository-default");
    assert.equal(decision.effective_mode, "bounded-fixes");
    assert.equal(decision.blocked, false);
    assert.equal(decision.budget.mutating_allowed, true);
  });

  test("treats a PR label as an explicit autonomy cap", () => {
    const decision = resolveRemediationPolicy({
      labels: ["for-review", "remediation:validate-only"],
      repository_mode: "bounded-fixes",
    });

    assert.equal(decision.requested_source, "pr-label");
    assert.equal(decision.requested_mode, "validate-only");
    assert.equal(decision.effective_mode, "validate-only");
    assert.equal(decision.budget.mutating_allowed, false);
  });

  test("never lets a label exceed the repository maximum", () => {
    const decision = resolveRemediationPolicy({
      labels: ["remediation:bounded-fixes"],
      repository_mode: "mechanical-fixes",
    });

    assert.equal(decision.effective_mode, "mechanical-fixes");
    assert.equal(decision.downgraded, true);
    assert.match(decision.reasons.join(" "), /reduced/);
  });

  test("applies risk and global ceilings from most to least restrictive", () => {
    const decision = resolveRemediationPolicy({
      labels: ["remediation:bounded-fixes"],
      repository_mode: "bounded-fixes",
      risk_ceiling: "validate-only",
      global_ceiling: "mechanical-fixes",
    });

    assert.equal(decision.effective_mode, "validate-only");
    assert.equal(decision.budget.max_fix_attempts, 0);
  });

  test("fails closed when multiple threshold labels are present", () => {
    const decision = resolveRemediationPolicy({
      labels: ["remediation:mechanical-fixes", "remediation:bounded-fixes"],
      repository_mode: "bounded-fixes",
    });

    assert.equal(decision.blocked, true);
    assert.equal(decision.effective_mode, "observe-only");
    assert.match(decision.reasons[0]!, /Conflicting remediation labels/);
  });

  test("requires verified provenance for maintainer-approved remediation", () => {
    const unverified = resolveRemediationPolicy({
      labels: ["remediation:maintainer-approved"],
      repository_mode: "maintainer-approved",
    });
    const verified = resolveRemediationPolicy({
      labels: ["remediation:maintainer-approved"],
      repository_mode: "maintainer-approved",
      maintainer_approval_verified: true,
    });

    assert.equal(unverified.blocked, true);
    assert.equal(unverified.effective_mode, "bounded-fixes");
    assert.equal(verified.blocked, false);
    assert.equal(verified.effective_mode, "maintainer-approved");
  });

  test("parses mode and compatibility threshold fields from policy text", () => {
    assert.equal(repositoryRemediationModeFromPolicy("remediation:\n  mode: mechanical-fixes\n"), "mechanical-fixes");
    assert.equal(repositoryRemediationModeFromPolicy([
      "Source: `commandments.yaml`",
      "",
      "```yaml",
      "remediation:",
      "  threshold: bounded",
      "```",
    ].join("\n")), "bounded-fixes");
    assert.equal(repositoryRemediationModeFromPolicy("not: [valid"), null);
  });

  test("derives mutation permission from normalized legacy and current modes", () => {
    assert.equal(remediationModeAllowsMutation("observe"), false);
    assert.equal(remediationModeAllowsMutation("validate-only"), false);
    assert.equal(remediationModeAllowsMutation("mechanical"), true);
    assert.equal(remediationModeAllowsMutation("bounded-fixes"), true);
    assert.equal(remediationModeAllowsMutation("unknown"), false);
  });
});
