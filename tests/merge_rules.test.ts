import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { getMergeRules } from "../pr-loop";

describe("merge rules", () => {
  test("loads the repository policy with pinned Workflow-IR refs", () => {
    const rules = getMergeRules(resolve("."));

    assert.match(rules, /Source: `commandments.yaml`/);
    assert.match(rules, /mode: bounded-fixes/);
    assert.match(rules, /git\+https:\/\/github\.com\/jrepp\/merge-god\.git@4fd39b7d4592eec5bf3e1b969b3246f863779a41/);
    assert.match(rules, /wf\.merge-god\.pr-merge-gate/);
  });

  test("loads the canonical root-level commandments file", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-god-merge-rules-"));
    writeFileSync(
      join(dir, "commandments.yaml"),
      [
        "version: 1",
        "rules:",
        "  - Run as many applicable gates as possible.",
        "remediation:",
        "  mode: bounded-fixes",
        "workflow_ir:",
        "  - docs/workflow-ir/review-workflows/underlying-remediation-pr.workflow-ir.md",
        "  - git+https://github.com/acme/workflow-policies.git@3f4b1f7e2d6c9a8b0e1d2c3a4f5b6c7d8e9f0123//review/pre-landing.workflow-ir.md#wf.acme.pre-landing",
      ].join("\n"),
    );

    const rules = getMergeRules(dir);

    assert.match(rules, /Source: `commandments.yaml`/);
    assert.match(rules, /Run as many applicable gates as possible/);
    assert.match(rules, /mode: bounded-fixes/);
    assert.match(rules, /underlying-remediation-pr\.workflow-ir/);
    assert.match(rules, /remote Git refs pinned to immutable commit hashes/);
    assert.match(rules, /git\+https:\/\/github\.com\/acme\/workflow-policies\.git@3f4b1f7e2d6c9a8b0e1d2c3a4f5b6c7d8e9f0123\/\/review\/pre-landing\.workflow-ir\.md#wf\.acme\.pre-landing/);
  });

  test("accepts the legacy hidden merge-rules alias", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-god-merge-rules-"));
    writeFileSync(join(dir, ".merge-rules.yaml"), "version: 1\nrules:\n  - Keep the merge gate honest.\n");

    const rules = getMergeRules(dir);

    assert.match(rules, /Source: `\.merge-rules\.yaml`/);
    assert.match(rules, /Keep the merge gate honest/);
  });

  test("accepts the optional hidden commandments alias", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-god-merge-rules-"));
    writeFileSync(join(dir, ".commandments.yaml"), "version: 1\nrules:\n  - Keep the merge gate honest.\n");

    const rules = getMergeRules(dir);

    assert.match(rules, /Source: `.commandments.yaml`/);
    assert.match(rules, /Keep the merge gate honest/);
  });

  test("prefers the canonical file over aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-god-merge-rules-"));
    writeFileSync(join(dir, ".commandments.yaml"), "version: 1\nrules:\n  - Alias rule.\n");
    writeFileSync(join(dir, ".merge-rules.yaml"), "version: 1\nrules:\n  - Legacy hidden rule.\n");
    writeFileSync(join(dir, "merge-rules.yaml"), "version: 1\nrules:\n  - Legacy public rule.\n");
    writeFileSync(join(dir, "commandments.yaml"), "version: 1\nrules:\n  - Public canonical rule.\n");

    const rules = getMergeRules(dir);

    assert.match(rules, /Source: `commandments.yaml`/);
    assert.match(rules, /Public canonical rule/);
    assert.doesNotMatch(rules, /Legacy public rule/);
    assert.doesNotMatch(rules, /Legacy hidden rule/);
    assert.doesNotMatch(rules, /Alias rule/);
  });
});
