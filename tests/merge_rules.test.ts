import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getMergeRules } from "../pr-loop";

describe("merge rules", () => {
  test("loads the canonical root-level commandments file", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-god-merge-rules-"));
    writeFileSync(
      join(dir, "commandments.yaml"),
      [
        "version: 1",
        "rules:",
        "  - Run as many applicable gates as possible.",
        "remediation:",
        "  threshold: bounded",
        "workflow_ir:",
        "  - docs-cms/rfcs/rfc-001-workflow-ir-extraction.md#wf.merge-god.pr-merge-gate",
      ].join("\n"),
    );

    const rules = getMergeRules(dir);

    assert.match(rules, /Source: `commandments.yaml`/);
    assert.match(rules, /Run as many applicable gates as possible/);
    assert.match(rules, /threshold: bounded/);
    assert.match(rules, /wf\.merge-god\.pr-merge-gate/);
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
    writeFileSync(join(dir, ".merge-rules.yaml"), "version: 1\nrules:\n  - Legacy rule.\n");
    writeFileSync(join(dir, "commandments.yaml"), "version: 1\nrules:\n  - Canonical rule.\n");

    const rules = getMergeRules(dir);

    assert.match(rules, /Source: `commandments.yaml`/);
    assert.match(rules, /Canonical rule/);
    assert.doesNotMatch(rules, /Legacy rule/);
    assert.doesNotMatch(rules, /Alias rule/);
  });
});
