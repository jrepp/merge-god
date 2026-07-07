import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  activeQueueValidationEvidence,
  cleanQueueValidationCommandPrefix,
  extractQueueValidationEvidence,
  isBlockingQueueValidationStatus,
  isInconclusiveQueueValidationStatus,
  isNonPassingQueueValidationStatus,
  normalizeQueueValidationEvidenceItems,
  partitionQueueValidationEvidence,
  prioritizedQueueValidationEvidence,
  queueValidationStatusRank,
  validationEvidenceByPrNumber,
} from "../queue_validation_model";
import { REVIEW_GATE_CACHE_MARKER } from "../review_gate_cache";

describe("queue validation evidence parsing", () => {
  test("extracts checkbox, arrow, review-comment, emoji, and table evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-validation",
        body: [
          "- [x] #201 `npm run test -- foo`",
          "- #202 npm run lint -> failed",
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| #203 | npm run test -- api | ✅ |",
          "| PR #204 | npm run test -- ui | ❌ failed |",
          "| [#210](https://github.example.test/org/repo/pull/210) | npm run linked -- api | failed |",
          "| [PR 211](https://github.example.test/org/repo/pull/211) | npm run linked -- ui | passed |",
          "| scope: packages/api | npm run lint -- api | 🚧 |",
          "| #206 | npm run test -- payments | ⏳ pending |",
          "| Command | Scope | Result |",
          "| --- | --- | --- |",
          "| npm run test -- search | #209 | ✅ passed |",
          "| Result | Scope | Command |",
          "| --- | --- | --- |",
          "| ❌ failed | packages/search | npm run lint -- search |",
          "| ✅ passed |  | npm run queue-wide |",
          "| ⏳ pending | apps/mobile | npm run test -- mobile |",
          "- #203 npm run typecheck:api => ✔",
          "- [ ] #205 `npm run smoke -- waiting`",
          "- #207 `npm run e2e` -> skipped",
          "- #208 npm run canary => inconclusive",
          "- scope: packages/web npm run test -- web -> failed",
          "- scope=apps/mobile: npm run test -- mobile => pending",
        ].join("\n"),
      },
      {
        html_url: "https://example.test/pull/203#discussion_r1",
        body: "- PR #202 `npm run typecheck` => blocked",
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run test -- foo",
        status: "passed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run lint",
        status: "failed",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run test -- api",
        status: "passed",
        scope: "#203",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run test -- ui",
        status: "failed",
        scope: "#204",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run linked -- api",
        status: "failed",
        scope: "#210",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run linked -- ui",
        status: "passed",
        scope: "#211",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run lint -- api",
        status: "blocked",
        scope: "packages/api",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run test -- payments",
        status: "unknown",
        scope: "#206",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run test -- search",
        status: "passed",
        scope: "#209",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run lint -- search",
        status: "failed",
        scope: "packages/search",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run queue-wide",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run test -- mobile",
        status: "unknown",
        scope: "apps/mobile",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run typecheck:api",
        status: "passed",
        scope: "#203",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run smoke -- waiting",
        status: "unknown",
        scope: "#205",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run e2e",
        status: "unknown",
        scope: "#207",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run canary",
        status: "unknown",
        scope: "#208",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run test -- web",
        status: "failed",
        scope: "packages/web",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run test -- mobile",
        status: "unknown",
        scope: "apps/mobile",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run typecheck",
        status: "blocked",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#discussion_r1",
      },
    ]);
  });

  test("groups only PR-scoped evidence by PR number", () => {
    const evidence = extractQueueValidationEvidence([
      {
        body: [
          "- #201 `npm test` -> passed",
          "- scope: packages/api `npm run lint` -> failed",
          "- PR #202 `npm run typecheck` -> blocked",
          "- scope: PR #203 `npm run e2e` -> passed",
          "- scope=PR #204 npm run smoke -> failed",
        ].join("\n"),
      },
    ]);

    const byPr = validationEvidenceByPrNumber(evidence);
    assert.deepEqual([...byPr.keys()], [201, 202, 203, 204]);
    assert.deepEqual(byPr.get(201)?.map((item) => item.command), ["npm test"]);
    assert.deepEqual(byPr.get(202)?.map((item) => item.command), ["npm run typecheck"]);
    assert.deepEqual(byPr.get(203)?.map((item) => item.command), ["npm run e2e"]);
    assert.deepEqual(byPr.get(204)?.map((item) => item.command), ["npm run smoke"]);
  });

  test("extracts repo-qualified PR and MR shorthand validation scopes", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-repo-qualified",
        body: [
          "- meridian/web#217 npm run metro -> failed",
          "- group/subgroup/repo!218 npm run gitlab => passed",
          "- passed for meridian/web#219: npm run status-target",
          "- meridian/web#220 failed: npm run target-status",
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| meridian/web#221 | npm run table | blocked |",
          "- meridian/web#222 and meridian/web#223 npm run shared -> failed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run metro",
        status: "failed",
        scope: "#217",
        evidence_ref: "https://example.test/pull/203#issuecomment-repo-qualified",
      },
      {
        command: "npm run gitlab",
        status: "passed",
        scope: "#218",
        evidence_ref: "https://example.test/pull/203#issuecomment-repo-qualified",
      },
      {
        command: "npm run status-target",
        status: "passed",
        scope: "#219",
        evidence_ref: "https://example.test/pull/203#issuecomment-repo-qualified",
      },
      {
        command: "npm run target-status",
        status: "failed",
        scope: "#220",
        evidence_ref: "https://example.test/pull/203#issuecomment-repo-qualified",
      },
      {
        command: "npm run table",
        status: "blocked",
        scope: "#221",
        evidence_ref: "https://example.test/pull/203#issuecomment-repo-qualified",
      },
      {
        command: "npm run shared",
        status: "failed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-repo-qualified",
      },
    ]);
  });

  test("uses url as evidence ref when html_url is blank", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "   ",
        url: " https://api.example.test/repos/org/repo/issues/comments/42 ",
        body: "- #201 `npm run fallback-ref` -> failed",
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run fallback-ref",
        status: "failed",
        scope: "#201",
        evidence_ref: "https://api.example.test/repos/org/repo/issues/comments/42",
      },
    ]);
  });

  test("uses stable fallback evidence ref when validation comments lack URL aliases", () => {
    const evidence = extractQueueValidationEvidence([
      {
        body: "- #201 `npm run fallback-ref` -> failed",
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run fallback-ref",
        status: "failed",
        scope: "#201",
        evidence_ref: "github:pr-comment",
      },
    ]);
  });

  test("uses cached comment body and URL aliases as validation evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        bodyText: "- #201 `npm run alias-body` -> failed",
        htmlUrl: " https://example.test/pull/203#issuecomment-bodytext ",
      },
      {
        text: "- #202 `npm run text-body` -> passed",
        webUrl: " https://example.test/pull/203#issuecomment-text ",
      },
      {
        body: "- #203 `npm run links-body` -> blocked",
        links: { html: { href: " https://example.test/pull/203#issuecomment-links " } },
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run alias-body",
        status: "failed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-bodytext",
      },
      {
        command: "npm run text-body",
        status: "passed",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-text",
      },
      {
        command: "npm run links-body",
        status: "blocked",
        scope: "#203",
        evidence_ref: "https://example.test/pull/203#issuecomment-links",
      },
    ]);
  });

  test("normalizes non-positive PR scopes as queue-wide evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-invalid-pr-scope",
        body: [
          "- #0 `npm run impossible-pr` -> failed",
          "- scope: https://github.example.test/org/repo/pull/0 npm run impossible-url => passed",
          "| PR | Command | Result |",
          "| --- | --- | --- |",
          "| #0 | npm run impossible-table | failed |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(
      evidence.map((item) => [item.scope, item.command, item.status]),
      [
        [null, "npm run impossible-pr", "failed"],
        [null, "npm run impossible-url", "passed"],
        [null, "npm run impossible-table", "failed"],
      ],
    );
  });

  test("uses markdown-linked PR references as validation scope", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-validation",
        body: [
          "- [#201](https://github.example.test/org/repo/pull/201) `npm test` -> failed",
          "- [PR #202](https://github.example.test/org/repo/pull/202) npm run smoke => passed",
          "- [PR 203](https://github.example.test/org/repo/pull/203) npm run canary => failed",
          "- scope: [#204](https://github.example.test/org/repo/pull/204) npm run linked-scope => passed",
          "- scope=[PR #205](https://github.example.test/org/repo/pull/205): npm run scoped-colon => failed",
          "- [!224](https://gitlab.example.test/org/repo/-/merge_requests/224) npm run gitlab-linked => passed",
          "- scope: [MR !225](https://gitlab.example.test/org/repo/-/merge_requests/225) npm run gitlab-scope => failed",
          "- [API validation](https://github.example.test/org/repo/pull/226) npm run descriptive-link => failed",
          "- scope: [Worker validation](https://api.github.example.test/repos/org/repo/pulls/227) npm run descriptive-scope => passed",
          "- [MR validation](https://gitlab.example.test/org/repo/-/merge_requests/228) npm run descriptive-mr => blocked",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm test",
        status: "failed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run smoke",
        status: "passed",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run canary",
        status: "failed",
        scope: "#203",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run linked-scope",
        status: "passed",
        scope: "#204",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run scoped-colon",
        status: "failed",
        scope: "#205",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run gitlab-linked",
        status: "passed",
        scope: "#224",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run gitlab-scope",
        status: "failed",
        scope: "#225",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run descriptive-link",
        status: "failed",
        scope: "#226",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run descriptive-scope",
        status: "passed",
        scope: "#227",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run descriptive-mr",
        status: "blocked",
        scope: "#228",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
    ]);
  });

  test("treats mismatched markdown-linked validation scopes as queue-wide evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-mismatched-linked-scope",
        body: [
          "- [#230](https://github.example.test/org/repo/pull/231) `npm run mismatched-link` -> failed",
          "- [PR 232](https://github.example.test/org/repo/pull/233) npm run mismatched-pr => passed",
          "- [Pull request 239](https://github.example.test/org/repo/pull/240) npm run mismatched-pull-request => failed",
          "- scope: [!234](https://gitlab.example.test/org/repo/-/merge_requests/235) npm run mismatched-mr => blocked",
          "- scope: [Merge request 241](https://gitlab.example.test/org/repo/-/merge_requests/242) npm run mismatched-merge-request => blocked",
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| [#236](https://github.example.test/org/repo/pull/237) | npm run mismatched-table | failed |",
          "| [Pull request 243](https://github.example.test/org/repo/pull/244) | npm run mismatched-table-longform | failed |",
          "- [API validation](https://github.example.test/org/repo/pull/238) npm run descriptive-link => passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run mismatched-link",
        status: "failed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-mismatched-linked-scope",
      },
      {
        command: "npm run mismatched-pr",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-mismatched-linked-scope",
      },
      {
        command: "npm run mismatched-pull-request",
        status: "failed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-mismatched-linked-scope",
      },
      {
        command: "npm run mismatched-mr",
        status: "blocked",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-mismatched-linked-scope",
      },
      {
        command: "npm run mismatched-merge-request",
        status: "blocked",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-mismatched-linked-scope",
      },
      {
        command: "npm run mismatched-table",
        status: "failed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-mismatched-linked-scope",
      },
      {
        command: "npm run mismatched-table-longform",
        status: "failed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-mismatched-linked-scope",
      },
      {
        command: "npm run descriptive-link",
        status: "passed",
        scope: "#238",
        evidence_ref: "https://example.test/pull/203#issuecomment-mismatched-linked-scope",
      },
    ]);
  });

  test("uses raw PR URLs as validation scope", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-url-scope",
        body: [
          "- https://github.example.test/org/repo/pull/214 `npm run url-smoke` -> failed",
          "- scope: https://github.example.test/org/repo/pull/215 npm run scoped-url => passed",
          "- scope=https://github.example.test/org/repo/pull/216: pnpm test --filter api => blocked",
          "- https://github.example.test/org/repo/pull/218 npm run raw-unquoted => passed",
          "- <https://github.example.test/org/repo/pull/219> npm run autolink => failed",
          "- https://api.github.example.test/repos/org/repo/pulls/221 npm run api-url => failed",
          "- scope: <https://api.github.example.test/repos/org/repo/pulls/222> npm run api-autolink => passed",
          "- https://gitlab.example.test/org/repo/-/merge_requests/224 npm run mr-url => blocked",
          "- scope: <https://gitlab.example.test/org/repo/-/merge_requests/225> npm run mr-autolink => passed",
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| https://github.example.test/org/repo/pull/217 | npm run table-url | success |",
          "| <https://github.example.test/org/repo/pull/220> | npm run table-autolink | failed |",
          "| https://api.github.example.test/repos/org/repo/pulls/223 | npm run table-api-url | failed |",
          "| https://gitlab.example.test/org/repo/-/merge_requests/226 | npm run table-mr-url | failed |",
          "| [API table](https://github.example.test/org/repo/pull/227) | npm run table-markdown-url | passed |",
          "| [MR table](https://gitlab.example.test/org/repo/-/merge_requests/228) | npm run table-mr-markdown-url | blocked |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run url-smoke",
        status: "failed",
        scope: "#214",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run scoped-url",
        status: "passed",
        scope: "#215",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "pnpm test --filter api",
        status: "blocked",
        scope: "#216",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run raw-unquoted",
        status: "passed",
        scope: "#218",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run autolink",
        status: "failed",
        scope: "#219",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run api-url",
        status: "failed",
        scope: "#221",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run api-autolink",
        status: "passed",
        scope: "#222",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run mr-url",
        status: "blocked",
        scope: "#224",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run mr-autolink",
        status: "passed",
        scope: "#225",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run table-url",
        status: "passed",
        scope: "#217",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run table-autolink",
        status: "failed",
        scope: "#220",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run table-api-url",
        status: "failed",
        scope: "#223",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run table-mr-url",
        status: "failed",
        scope: "#226",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run table-markdown-url",
        status: "passed",
        scope: "#227",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
      {
        command: "npm run table-mr-markdown-url",
        status: "blocked",
        scope: "#228",
        evidence_ref: "https://example.test/pull/203#issuecomment-url-scope",
      },
    ]);
  });

  test("uses pull request and merge request table headers as validation scope", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-forge-table",
        body: [
          "| Pull Request | Command | Result |",
          "| --- | --- | --- |",
          "| PR #301 | npm run pull-table | failed |",
          "| #302 | pnpm test --filter pull | passed |",
          "",
          "| Merge Request | Command | Result |",
          "| --- | --- | --- |",
          "| MR !303 | npm run mr-table | blocked |",
          "| !304 | pnpm test --filter mr | passed |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run pull-table",
        status: "failed",
        scope: "#301",
        evidence_ref: "https://example.test/pull/203#issuecomment-forge-table",
      },
      {
        command: "pnpm test --filter pull",
        status: "passed",
        scope: "#302",
        evidence_ref: "https://example.test/pull/203#issuecomment-forge-table",
      },
      {
        command: "npm run mr-table",
        status: "blocked",
        scope: "#303",
        evidence_ref: "https://example.test/pull/203#issuecomment-forge-table",
      },
      {
        command: "pnpm test --filter mr",
        status: "passed",
        scope: "#304",
        evidence_ref: "https://example.test/pull/203#issuecomment-forge-table",
      },
    ]);
  });

  test("extracts unbackticked command-looking checkbox validation", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-checkbox",
        body: [
          "- [x] #201 npm test",
          "- [ ] PR #202 npm run smoke",
          "- [x] [#204](https://github.example.test/org/repo/pull/204) npm run linked",
          "- [ ] [PR 205](https://github.example.test/org/repo/pull/205) pnpm test",
          "- [x] #203 API update",
          "- [x] [#206](https://github.example.test/org/repo/pull/206) API update",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm test",
        status: "passed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-checkbox",
      },
      {
        command: "npm run smoke",
        status: "unknown",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-checkbox",
      },
      {
        command: "npm run linked",
        status: "passed",
        scope: "#204",
        evidence_ref: "https://example.test/pull/203#issuecomment-checkbox",
      },
      {
        command: "pnpm test",
        status: "unknown",
        scope: "#205",
        evidence_ref: "https://example.test/pull/203#issuecomment-checkbox",
      },
    ]);
  });

  test("normalizes PR scope prefixes with human separators before commands", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-separated-scope",
        body: [
          "- [x] PR #201: npm test",
          "- [ ] #202 - pnpm test --filter api",
          "- [x] [#203](https://github.example.test/org/repo/pull/203): yarn lint",
          "- PR #204: npm run smoke -> failed",
          "- #205 - pnpm test --filter web => passed",
          "- PR: #206 npm run colon-scope => passed",
          "- Pull request #207: npm run pull-request-scope -> failed",
          "- pull request: #208 pnpm test --filter docs => passed",
          "- scope: pull request #209 npm run scope-pull-request => passed",
          "- scope=pull request: #210 pnpm test --filter scope-docs => failed",
          "- PR #211: [x] npm run scoped-task",
          "- Pull request #212 - [ ] pnpm test --filter pending-task",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm test",
        status: "passed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
      {
        command: "pnpm test --filter api",
        status: "unknown",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
      {
        command: "yarn lint",
        status: "passed",
        scope: "#203",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
      {
        command: "npm run smoke",
        status: "failed",
        scope: "#204",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
      {
        command: "pnpm test --filter web",
        status: "passed",
        scope: "#205",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
      {
        command: "npm run colon-scope",
        status: "passed",
        scope: "#206",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
      {
        command: "npm run pull-request-scope",
        status: "failed",
        scope: "#207",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
      {
        command: "pnpm test --filter docs",
        status: "passed",
        scope: "#208",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
      {
        command: "npm run scope-pull-request",
        status: "passed",
        scope: "#209",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
      {
        command: "pnpm test --filter scope-docs",
        status: "failed",
        scope: "#210",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
      {
        command: "npm run scoped-task",
        status: "passed",
        scope: "#211",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
      {
        command: "pnpm test --filter pending-task",
        status: "unknown",
        scope: "#212",
        evidence_ref: "https://example.test/pull/203#issuecomment-separated-scope",
      },
    ]);
  });

  test("does not treat plain leading command numbers as PR scope prefixes", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-numeric-command",
        body: [
          "- 123 npm run numbered-command -> passed",
          "- [x] 456 pnpm test --filter numeric -> passed",
          "- #789 npm run scoped-command -> failed",
          "- MR !790 npm run mr-scoped-command -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "123 npm run numbered-command",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-numeric-command",
      },
      {
        command: "456 pnpm test --filter numeric",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-numeric-command",
      },
      {
        command: "npm run scoped-command",
        status: "failed",
        scope: "#789",
        evidence_ref: "https://example.test/pull/203#issuecomment-numeric-command",
      },
      {
        command: "npm run mr-scoped-command",
        status: "passed",
        scope: "#790",
        evidence_ref: "https://example.test/pull/203#issuecomment-numeric-command",
      },
    ]);

    assert.equal(cleanQueueValidationCommandPrefix("123 npm run cached-command"), "123 npm run cached-command");
    assert.equal(cleanQueueValidationCommandPrefix("MR !790 npm run cached-mr-command"), "npm run cached-mr-command");
  });

  test("extracts status-first PR validation evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-status-first",
        body: [
          "- failed: #201 npm test",
          "- passed - PR #202 pnpm test --filter api",
          "- ✅ [#203](https://github.example.test/org/repo/pull/203): yarn lint",
          "- action required: https://github.example.test/org/repo/pull/204 npm run manual",
          "- passed for PR #209: npm run status-for-pr",
          "- failed for pull request #210 - pnpm test --filter status-for-pull",
          "- blocked for MR !211: npm run status-for-mr",
          "- ✅ for [#212](https://github.example.test/org/repo/pull/212): yarn status-for-link",
          "- passed on PR #213: npm run status-on-pr",
          "- failed for [API validation](https://github.example.test/org/repo/pull/214): npm run status-for-markdown",
          "- failed for PR #215 and PR #216: npm run status-for-shared",
          "- failed for packages/api: npm run status-for-path",
          "- passed for queue: npm run status-for-queue",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm test",
        status: "failed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "pnpm test --filter api",
        status: "passed",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "yarn lint",
        status: "passed",
        scope: "#203",
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "npm run manual",
        status: "unknown",
        scope: "#204",
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "npm run status-for-pr",
        status: "passed",
        scope: "#209",
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "pnpm test --filter status-for-pull",
        status: "failed",
        scope: "#210",
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "npm run status-for-mr",
        status: "blocked",
        scope: "#211",
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "yarn status-for-link",
        status: "passed",
        scope: "#212",
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "npm run status-on-pr",
        status: "passed",
        scope: "#213",
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "npm run status-for-markdown",
        status: "failed",
        scope: "#214",
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "npm run status-for-shared",
        status: "failed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "npm run status-for-path",
        status: "failed",
        scope: "packages/api",
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
      {
        command: "npm run status-for-queue",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-status-first",
      },
    ]);
  });

  test("extracts target-status PR validation evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-target-status",
        body: [
          "- PR #217 passed: npm run target-pr",
          "- pull request #218 failed - pnpm test --filter target-pull",
          "- MR !219 blocked: npm run target-mr",
          "- [API validation](https://github.example.test/org/repo/pull/220) failed: npm run target-markdown",
          "- PR #221 and PR #222 failed: npm run target-shared",
          "- packages/api failed: npm run target-path",
          "- queue passed: npm run target-queue",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run target-pr",
        status: "passed",
        scope: "#217",
        evidence_ref: "https://example.test/pull/203#issuecomment-target-status",
      },
      {
        command: "pnpm test --filter target-pull",
        status: "failed",
        scope: "#218",
        evidence_ref: "https://example.test/pull/203#issuecomment-target-status",
      },
      {
        command: "npm run target-mr",
        status: "blocked",
        scope: "#219",
        evidence_ref: "https://example.test/pull/203#issuecomment-target-status",
      },
      {
        command: "npm run target-markdown",
        status: "failed",
        scope: "#220",
        evidence_ref: "https://example.test/pull/203#issuecomment-target-status",
      },
      {
        command: "npm run target-shared",
        status: "failed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-target-status",
      },
      {
        command: "npm run target-path",
        status: "failed",
        scope: "packages/api",
        evidence_ref: "https://example.test/pull/203#issuecomment-target-status",
      },
      {
        command: "npm run target-queue",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-target-status",
      },
    ]);

    assert.equal(cleanQueueValidationCommandPrefix("PR #217 passed: npm run cached-target-pr"), "npm run cached-target-pr");
  });

  test("normalizes inline PR status decorations around commands", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-inline-status",
        body: [
          "- #213 ✅ npm run inline-pass",
          "- #214 ❌ pnpm test --filter api",
          "- #215 npm run trailing-pass ✅",
          "- #216 pnpm lint (failed)",
          "- #217 npm run dash-pass - passed",
          "- #218 pnpm test --filter web — failed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run inline-pass",
        status: "passed",
        scope: "#213",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-status",
      },
      {
        command: "pnpm test --filter api",
        status: "failed",
        scope: "#214",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-status",
      },
      {
        command: "npm run trailing-pass",
        status: "passed",
        scope: "#215",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-status",
      },
      {
        command: "pnpm lint",
        status: "failed",
        scope: "#216",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-status",
      },
      {
        command: "npm run dash-pass",
        status: "passed",
        scope: "#217",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-status",
      },
      {
        command: "pnpm test --filter web",
        status: "failed",
        scope: "#218",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-status",
      },
    ]);
  });

  test("extracts inline field validation summaries with common field separators", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-inline-fields",
        body: [
          "- Scope: #219; Command: npm test; Result: passed",
          "- PR: #220; Check: pnpm test --filter api; Status: failed",
          "- Scope: packages/api; Command: npm run lint; Outcome: blocked",
          "- scope=apps/web; cmd=pnpm test --filter web; conclusion=success",
          "- Scope: #221, Command: npm run test -- --grep \"foo, bar\", Result: failed",
          "- MR: !222; Check: pnpm test --filter gitlab; Status: passed",
          "- Merge Request: !223; Command: npm run mr-smoke; Result: failed",
          "- Package: packages/web, Validation: just ci, State: action_required",
          "- Command: npm run queue; Result: passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm test",
        status: "passed",
        scope: "#219",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-fields",
      },
      {
        command: "pnpm test --filter api",
        status: "failed",
        scope: "#220",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-fields",
      },
      {
        command: "npm run lint",
        status: "blocked",
        scope: "packages/api",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-fields",
      },
      {
        command: "pnpm test --filter web",
        status: "passed",
        scope: "apps/web",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-fields",
      },
      {
        command: "npm run test -- --grep \"foo, bar\"",
        status: "failed",
        scope: "#221",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-fields",
      },
      {
        command: "pnpm test --filter gitlab",
        status: "passed",
        scope: "#222",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-fields",
      },
      {
        command: "npm run mr-smoke",
        status: "failed",
        scope: "#223",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-fields",
      },
      {
        command: "just ci",
        status: "unknown",
        scope: "packages/web",
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-fields",
      },
      {
        command: "npm run queue",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-inline-fields",
      },
    ]);
  });

  test("extracts pipe-separated inline field validation summaries without leaking labels into commands", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-pipe-fields",
        body: [
          "- Pull Request: #301 | Command: npm run pipe-field | Result: failed",
          "- PR: #302 | Check: pnpm test --filter api | Status: passed",
          "- Merge Request: !303 | Command: npm run mr-pipe | Result: blocked",
          "- Scope: packages/api | Command: npm run lint | Result: failed",
          "- Command: npm run queue | Result: passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run pipe-field",
        status: "failed",
        scope: "#301",
        evidence_ref: "https://example.test/pull/203#issuecomment-pipe-fields",
      },
      {
        command: "pnpm test --filter api",
        status: "passed",
        scope: "#302",
        evidence_ref: "https://example.test/pull/203#issuecomment-pipe-fields",
      },
      {
        command: "npm run mr-pipe",
        status: "blocked",
        scope: "#303",
        evidence_ref: "https://example.test/pull/203#issuecomment-pipe-fields",
      },
      {
        command: "npm run lint",
        status: "failed",
        scope: "packages/api",
        evidence_ref: "https://example.test/pull/203#issuecomment-pipe-fields",
      },
      {
        command: "npm run queue",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/203#issuecomment-pipe-fields",
      },
    ]);
  });

  test("normalizes descriptive PR scope prefixes before commands", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-descriptive-scope",
        body: [
          "- constituent #221 npm run constituent-smoke -> passed",
          "- constituent PR #222 pnpm test --filter constituent => failed",
          "- source PR #223 npm run source-smoke -> blocked",
          "- queue PR #224 npm run queue-smoke -> passed",
          "- pull #225 npm test -> failed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run constituent-smoke",
        status: "passed",
        scope: "#221",
        evidence_ref: "https://example.test/pull/203#issuecomment-descriptive-scope",
      },
      {
        command: "pnpm test --filter constituent",
        status: "failed",
        scope: "#222",
        evidence_ref: "https://example.test/pull/203#issuecomment-descriptive-scope",
      },
      {
        command: "npm run source-smoke",
        status: "blocked",
        scope: "#223",
        evidence_ref: "https://example.test/pull/203#issuecomment-descriptive-scope",
      },
      {
        command: "npm run queue-smoke",
        status: "passed",
        scope: "#224",
        evidence_ref: "https://example.test/pull/203#issuecomment-descriptive-scope",
      },
      {
        command: "npm test",
        status: "failed",
        scope: "#225",
        evidence_ref: "https://example.test/pull/203#issuecomment-descriptive-scope",
      },
    ]);
  });

  test("normalizes ordered Markdown list validation evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-ordered-list",
        body: [
          "1. #201 npm test -> passed",
          "2. [x] PR #202 npm run smoke",
          "3. failed: #203 pnpm test --filter api",
          "4) scope: packages/api npm run lint -> blocked",
          "5. #204 `yarn lint` => failed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
      ["#203", "pnpm test --filter api", "failed"],
      ["packages/api", "npm run lint", "blocked"],
      ["#204", "yarn lint", "failed"],
    ]);
  });

  test("normalizes plus-bullet Markdown validation evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-plus-list",
        body: [
          "+ #201 npm test -> passed",
          "+ [x] PR #202 npm run smoke",
          "+ failed: #203 pnpm test --filter api",
          "+ scope: packages/api npm run lint -> blocked",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
      ["#203", "pnpm test --filter api", "failed"],
      ["packages/api", "npm run lint", "blocked"],
    ]);
  });

  test("uses visible PR section headings as fallback validation scope", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-section-scope",
        body: [
          "### PR #201",
          "- npm test -> passed",
          "- npm run lint => failed",
          "",
          "#### Validation for pull request #202",
          "- pnpm test --filter ui -> passed",
          "- #203 npm run explicit -> failed",
          "",
          "**Pull request: #204**",
          "- yarn test => passed",
          "- scope: queue npm run explicit-queue -> passed",
          "### PR #205",
          "| Command | Result |",
          "| npm run table | passed |",
          "### PR #206",
          "| Scope | Command | Result |",
          "|  | npm run blank-scope-table | failed |",
          "### Queue-wide",
          "- npm run queue-smoke -> blocked",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#201", "npm run lint", "failed"],
      ["#202", "pnpm test --filter ui", "passed"],
      ["#203", "npm run explicit", "failed"],
      ["#204", "yarn test", "passed"],
      [null, "npm run explicit-queue", "passed"],
      ["#205", "npm run table", "passed"],
      [null, "npm run blank-scope-table", "failed"],
      [null, "npm run queue-smoke", "blocked"],
    ]);
  });

  test("uses path-like section headings as fallback validation scope", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-path-section-scope",
        body: [
          "### packages/api",
          "- npm run lint -- api -> failed",
          "",
          "#### Validation for apps/mobile",
          "- pnpm test --filter mobile -> passed",
          "",
          "### Scope: packages/@merge-god/ui",
          "- npm run ui-smoke -> blocked",
          "",
          "### General notes",
          "- npm run not-scoped -> failed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["packages/api", "npm run lint -- api", "failed"],
      ["apps/mobile", "pnpm test --filter mobile", "passed"],
      ["packages/@merge-god/ui", "npm run ui-smoke", "blocked"],
      [null, "npm run not-scoped", "failed"],
    ]);
  });

  test("does not treat multi-word route headings as path scopes", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/183#issuecomment-route-heading",
        body: [
          "### Safari `/chat` LPAR workflow validation",
          "| Flow | Evidence | Result |",
          "| --- | --- | --- |",
          "| Create LPAR prompt | Initial prompt did not reach approval. | Blocker |",
          "",
          "### packages/chat",
          "- npm run chat => failed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(
      evidence.map((item) => [item.scope, item.command, item.status]),
      [
        [null, "Create LPAR prompt", "blocked"],
        ["packages/chat", "npm run chat", "failed"],
      ],
    );
  });

  test("treats ambiguous multi-PR section headings as queue-wide fallback scope", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-ambiguous-section-scope",
        body: [
          "### #201 API and #202 UI",
          "- npm run shared -> failed",
          "",
          "#### Validation for PR #203 and PR #204",
          "- pnpm test --filter pair -> blocked",
          "",
          "### Validation for [#205](https://github.example.test/org/repo/pull/205) and [#206](https://github.example.test/org/repo/pull/206)",
          "- npm run linked-pair -> failed",
          "",
          "### Validation for PRs 208-209",
          "- npm run bare-heading-range -> failed",
          "",
          "### PR #207",
          "- npm run exact -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      [null, "npm run shared", "failed"],
      [null, "pnpm test --filter pair", "blocked"],
      [null, "npm run linked-pair", "failed"],
      [null, "npm run bare-heading-range", "failed"],
      ["#207", "npm run exact", "passed"],
    ]);
  });

  test("treats inline multi-PR validation scopes as queue-wide evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-inline-multi-pr-scope",
        body: [
          "- PR #201 and PR #202 npm run shared -> failed",
          "- #203/#204 npm run slash-shared -> blocked",
          "- [#205](https://github.example.test/org/repo/pull/205) and [#206](https://github.example.test/org/repo/pull/206) npm run linked-shared -> failed",
          "- [Pull request 231](https://github.example.test/org/repo/pull/231) and [Pull request 232](https://github.example.test/org/repo/pull/232) npm run longform-linked-shared -> failed",
          "- [Merge request 233](https://gitlab.example.test/org/repo/-/merge_requests/233) + [Merge request 234](https://gitlab.example.test/org/repo/-/merge_requests/234) npm run longform-mr-linked-shared -> blocked",
          "- PRs #207 and #208: pnpm test --filter shared => passed",
          "- scope: #209 and #210 npm run scoped-shared -> failed",
          "- Scope: #211 and #212; Command: npm run field-shared; Result: blocked",
          "- PRs #214-#216 npm run range -> failed",
          "- #217-#218 npm run bare-range -> blocked",
          "- scope: #219 through #220 pnpm test --filter range => passed",
          "- PRs 221-223 npm run bare-plural-range -> failed",
          "- PR #224-225 npm run bare-end-range -> blocked",
          "- !226-228 npm run bare-mr-range -> failed",
          "- scope: !229 through !230 pnpm test --filter mr-range => blocked",
          "- #213 npm run exact -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      [null, "npm run shared", "failed"],
      [null, "npm run slash-shared", "blocked"],
      [null, "npm run linked-shared", "failed"],
      [null, "npm run longform-linked-shared", "failed"],
      [null, "npm run longform-mr-linked-shared", "blocked"],
      [null, "pnpm test --filter shared", "passed"],
      [null, "npm run scoped-shared", "failed"],
      [null, "npm run field-shared", "blocked"],
      [null, "npm run range", "failed"],
      [null, "npm run bare-range", "blocked"],
      [null, "pnpm test --filter range", "passed"],
      [null, "npm run bare-plural-range", "failed"],
      [null, "npm run bare-end-range", "blocked"],
      [null, "npm run bare-mr-range", "failed"],
      [null, "pnpm test --filter mr-range", "blocked"],
      ["#213", "npm run exact", "passed"],
    ]);
  });

  test("keeps single-PR row scope when command text mentions another PR", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-command-pr-ref",
        body: [
          "- #201 npm run release-notes -- --related #202 -> passed",
          "- PR #203 pnpm test -- --grep PR #204 => failed",
          "- scope: #205 npm run docs -- https://github.example.test/org/repo/pull/206 -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm run release-notes -- --related #202", "passed"],
      ["#203", "pnpm test -- --grep PR #204", "failed"],
      ["#205", "npm run docs -- https://github.example.test/org/repo/pull/206", "passed"],
    ]);
  });

  test("extracts HTML code-tag validation commands without leaking markup", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-html-code",
        body: [
          "- #201 <code>npm test</code> -> failed",
          "- [x] #202 <code>pnpm test --filter api</code>",
          "- passed: #203 <code>yarn lint</code>",
          "- scope: <code>PR #204</code> <code>npm run smoke</code> => passed",
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| #205 | <code>npm run table-check</code> | success |",
          "| <code>#206</code> | <code>npm run table-scope</code> | failed |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm test",
        status: "failed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-html-code",
      },
      {
        command: "pnpm test --filter api",
        status: "passed",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-html-code",
      },
      {
        command: "yarn lint",
        status: "passed",
        scope: "#203",
        evidence_ref: "https://example.test/pull/203#issuecomment-html-code",
      },
      {
        command: "npm run smoke",
        status: "passed",
        scope: "#204",
        evidence_ref: "https://example.test/pull/203#issuecomment-html-code",
      },
      {
        command: "npm run table-check",
        status: "passed",
        scope: "#205",
        evidence_ref: "https://example.test/pull/203#issuecomment-html-code",
      },
      {
        command: "npm run table-scope",
        status: "failed",
        scope: "#206",
        evidence_ref: "https://example.test/pull/203#issuecomment-html-code",
      },
    ]);
  });

  test("decodes HTML entities in code-tag scopes and commands", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-html-entities",
        body: [
          "- scope: <code>packages&#47;api</code> <code>npm run test -- --grep &quot;A&amp;B&quot;</code> => passed",
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| <code>PR #201</code> | <code>pnpm test --filter api&lt;unit&gt;</code> | failed |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run test -- --grep \"A&B\"",
        status: "passed",
        scope: "packages/api",
        evidence_ref: "https://example.test/pull/203#issuecomment-html-entities",
      },
      {
        command: "pnpm test --filter api<unit>",
        status: "failed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-html-entities",
      },
    ]);
  });

  test("ignores invalid numeric HTML entities in code-tag scopes and commands", () => {
    assert.doesNotThrow(() => {
      assert.deepEqual(
        extractQueueValidationEvidence([
          {
            html_url: "https://example.test/pull/203#issuecomment-invalid-html-entities",
            body: [
              "- scope: <code>packages/&#x110000;api</code> <code>npm run test &#9999999999;</code> => passed",
              "| Scope | Command | Result |",
              "| --- | --- | --- |",
              "| <code>PR #201</code> | <code>pnpm test &#xFFFFFF;</code> | failed |",
            ].join("\n"),
          },
        ]),
        [
          {
            command: "npm run test",
            status: "passed",
            scope: "packages/api",
            evidence_ref: "https://example.test/pull/203#issuecomment-invalid-html-entities",
          },
          {
            command: "pnpm test",
            status: "failed",
            scope: "#201",
            evidence_ref: "https://example.test/pull/203#issuecomment-invalid-html-entities",
          },
        ],
      );
    });
  });

  test("active evidence keeps only the latest status per scope and command", () => {
    const active = activeQueueValidationEvidence([
      { command: "npm test", status: "unknown", scope: "#1", evidence_ref: "comment:1" },
      { command: "npm lint", status: "failed", scope: "packages/api", evidence_ref: "comment:2" },
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:3" },
      { command: "npm lint", status: "passed", scope: "packages/api", evidence_ref: "comment:4" },
    ]);

    assert.deepEqual(active, [
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:3" },
      { command: "npm lint", status: "passed", scope: "packages/api", evidence_ref: "comment:4" },
    ]);
  });

  test("partitions active and superseded evidence with normalized entries", () => {
    const partition = partitionQueueValidationEvidence([
      { command: "<code>npm test</code>", status: "failed", scope: "PR #1", evidence_ref: "comment:old" },
      { command: "npm   test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      { command: "", status: "manual", scope: "packages/api", evidence_ref: "comment:unknown-old" },
      { command: "   ", status: "passed", scope: "packages/api", evidence_ref: "comment:unknown-new" },
    ] as unknown as Parameters<typeof partitionQueueValidationEvidence>[0]);

    assert.deepEqual(partition.active, [
      {
        index: 1,
        evidence: { command: "npm   test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      },
      {
        index: 3,
        evidence: { command: "unknown", status: "passed", scope: "packages/api", evidence_ref: "comment:unknown-new" },
      },
    ]);
    assert.deepEqual(partition.superseded, [
      {
        index: 0,
        evidence: { command: "npm test", status: "failed", scope: "#1", evidence_ref: "comment:old" },
      },
      {
        index: 2,
        evidence: { command: "unknown", status: "unknown", scope: "packages/api", evidence_ref: "comment:unknown-old" },
      },
    ]);
  });

  test("normalizes cached evidence ref aliases while partitioning validation evidence", () => {
    const partition = partitionQueueValidationEvidence([
      {
        command: "npm test",
        status: "failed",
        scope: "#1",
        evidenceRef: " comment:old ",
        html_url: "comment:old-url",
      },
      {
        command: "npm   test",
        status: "passed",
        scope: "PR #001",
        evidence_refs: [" ", "comment:new", "comment:secondary"],
        url: "comment:new-url",
      },
      {
        command: "npm lint",
        status: "blocked",
        scope: "packages/api",
        sourceUrl: "comment:lint-url",
      },
    ] as unknown as Parameters<typeof partitionQueueValidationEvidence>[0]);

    assert.deepEqual(partition.active, [
      {
        index: 1,
        evidence: { command: "npm   test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      },
      {
        index: 2,
        evidence: { command: "npm lint", status: "blocked", scope: "packages/api", evidence_ref: "comment:lint-url" },
      },
    ]);
    assert.deepEqual(partition.superseded, [
      {
        index: 0,
        evidence: { command: "npm test", status: "failed", scope: "#1", evidence_ref: "comment:old" },
      },
    ]);
  });

  test("uses later comprehensive queue-wide passes to supersede stale queue-wide evidence", () => {
    const partition = partitionQueueValidationEvidence([
      { command: "npm run test", status: "failed", scope: null, evidence_ref: "comment:old-test" },
      { command: "npm run test:storybook", status: "failed", scope: null, evidence_ref: "comment:old-storybook" },
      { command: "npm ci", status: "passed", scope: null, evidence_ref: "comment:old-install" },
      { command: "npm run lint -- api", status: "failed", scope: "packages/api", evidence_ref: "comment:api" },
      { command: "Full RC1 deterministic suite", status: "passed", scope: null, evidence_ref: "comment:full-suite" },
      { command: "npm run build", status: "passed", scope: null, evidence_ref: "comment:later-build" },
    ]);

    assert.deepEqual(
      partition.active.map((entry) => [entry.index, entry.evidence.command, entry.evidence.status, entry.evidence.scope]),
      [
        [3, "npm run lint -- api", "failed", "packages/api"],
        [4, "Full RC1 deterministic suite", "passed", null],
        [5, "npm run build", "passed", null],
      ],
    );
    assert.deepEqual(
      partition.superseded.map((entry) => [entry.index, entry.evidence.command, entry.evidence.status]),
      [
        [0, "npm run test", "failed"],
        [1, "npm run test:storybook", "failed"],
        [2, "npm ci", "passed"],
      ],
    );
  });

  test("does not let comprehensive queue-wide passes supersede later failures", () => {
    const active = activeQueueValidationEvidence([
      { command: "Full RC1 deterministic suite", status: "passed", scope: null, evidence_ref: "comment:full-suite" },
      { command: "npm run test", status: "failed", scope: null, evidence_ref: "comment:later-test" },
    ]);

    assert.deepEqual(
      active.map((entry) => [entry.command, entry.status, entry.evidence_ref]),
      [
        ["Full RC1 deterministic suite", "passed", "comment:full-suite"],
        ["npm run test", "failed", "comment:later-test"],
      ],
    );
  });

  test("ranks validation statuses for blockers and evidence comments", () => {
    assert.equal(queueValidationStatusRank("failed"), 0);
    assert.equal(queueValidationStatusRank("blocked"), 0);
    assert.equal(queueValidationStatusRank("manual"), 1);
    assert.equal(queueValidationStatusRank("unknown"), 1);
    assert.equal(queueValidationStatusRank("passed"), 2);
    assert.equal(isBlockingQueueValidationStatus("blocked"), true);
    assert.equal(isBlockingQueueValidationStatus("failed"), true);
    assert.equal(isBlockingQueueValidationStatus("unknown"), false);
    assert.equal(isInconclusiveQueueValidationStatus("manual"), true);
    assert.equal(isNonPassingQueueValidationStatus("unknown"), true);
    assert.equal(isNonPassingQueueValidationStatus("passed"), false);
  });

  test("prioritizes active validation evidence by non-passing severity and stable index", () => {
    const partition = partitionQueueValidationEvidence([
      { command: "npm run pass-1", status: "passed", scope: "#1", evidence_ref: "comment:1" },
      { command: "npm run unknown", status: "manual", scope: "#2", evidence_ref: "comment:2" },
      { command: "npm run fail", status: "failed", scope: "#3", evidence_ref: "comment:3" },
      { command: "npm run blocked", status: "blocked", scope: "#4", evidence_ref: "comment:4" },
      { command: "npm run pass-2", status: "passed", scope: "#5", evidence_ref: "comment:5" },
    ] as unknown as Parameters<typeof partitionQueueValidationEvidence>[0]);

    const prioritized = prioritizedQueueValidationEvidence(partition.active);

    assert.deepEqual(
      prioritized.map(({ evidence, index }) => [index, evidence.status, evidence.command]),
      [
        [2, "failed", "npm run fail"],
        [3, "blocked", "npm run blocked"],
        [1, "unknown", "npm run unknown"],
        [0, "passed", "npm run pass-1"],
        [4, "passed", "npm run pass-2"],
      ],
    );
    assert.deepEqual(
      partition.active.map(({ evidence }) => evidence.command),
      ["npm run pass-1", "npm run unknown", "npm run fail", "npm run blocked", "npm run pass-2"],
    );
  });

  test("keeps comprehensive queue-wide passes before later ordinary passing evidence", () => {
    const partition = partitionQueueValidationEvidence([
      { command: "npm ci", status: "passed", scope: null, evidence_ref: "comment:old-install" },
      { command: "npm run lint", status: "passed", scope: null, evidence_ref: "comment:old-lint" },
      { command: "Full RC1 deterministic suite", status: "passed", scope: null, evidence_ref: "comment:full-suite" },
      { command: "npm run build", status: "passed", scope: null, evidence_ref: "comment:new-build" },
    ]);

    assert.deepEqual(
      prioritizedQueueValidationEvidence(partition.active).map(({ evidence }) => evidence.command),
      [
        "Full RC1 deterministic suite",
        "npm run build",
      ],
    );
    assert.deepEqual(
      partition.superseded.map(({ evidence }) => evidence.command),
      ["npm ci", "npm run lint"],
    );
  });

  test("active evidence treats cached HTML code-tag commands as the same validation", () => {
    const active = activeQueueValidationEvidence([
      { command: "<code>npm test</code>", status: "failed", scope: "#1", evidence_ref: "comment:old" },
      { command: "npm   test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
    ]);

    assert.deepEqual(active, [
      { command: "npm   test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
    ]);
  });

  test("active evidence treats whitespace-only command differences as the same validation", () => {
    const active = activeQueueValidationEvidence([
      { command: "npm   run   test -- api", status: "failed", scope: "#1", evidence_ref: "comment:1" },
      { command: "npm run test -- api", status: "passed", scope: "#1", evidence_ref: "comment:2" },
    ]);

    assert.deepEqual(active, [
      { command: "npm run test -- api", status: "passed", scope: "#1", evidence_ref: "comment:2" },
    ]);
  });

  test("active evidence renders malformed cached commands as unknown", () => {
    const active = activeQueueValidationEvidence([
      { command: "", status: "failed", scope: "#1", evidence_ref: "comment:blank" },
      { command: 123, status: "blocked", scope: "#1", evidence_ref: "comment:number" },
      { command: "   ", status: "passed", scope: "#2", evidence_ref: "comment:space" },
    ] as unknown as Parameters<typeof activeQueueValidationEvidence>[0]);

    assert.deepEqual(active, [
      { command: "unknown", status: "blocked", scope: "#1", evidence_ref: "comment:number" },
      { command: "unknown", status: "passed", scope: "#2", evidence_ref: "comment:space" },
    ]);
  });

  test("active evidence normalizes cached ordered-list command prefixes", () => {
    const active = activeQueueValidationEvidence([
      { command: "1. #001 npm test", status: "failed", scope: "#1", evidence_ref: "comment:old" },
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      { command: "2) scope: packages/api npm run lint", status: "failed", scope: "packages/api", evidence_ref: "comment:path" },
    ]);

    assert.deepEqual(active, [
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      { command: "npm run lint", status: "failed", scope: "packages/api", evidence_ref: "comment:path" },
    ]);
  });

  test("active evidence normalizes cached scope prefixes in commands", () => {
    const active = activeQueueValidationEvidence([
      {
        command: "scope: [#001](https://github.example.test/org/repo/pull/1) npm test",
        status: "failed",
        scope: "#1",
        evidence_ref: "comment:old",
      },
      { command: "npm   test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      {
        command: "scope=packages/api: npm run lint",
        status: "blocked",
        scope: "packages/api",
        evidence_ref: "comment:path-old",
      },
      {
        command: "scope: pull request #002 npm run smoke",
        status: "failed",
        scope: "#2",
        evidence_ref: "comment:pull-request-old",
      },
    ]);

    assert.deepEqual(active, [
      { command: "npm   test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      { command: "npm run lint", status: "blocked", scope: "packages/api", evidence_ref: "comment:path-old" },
      { command: "npm run smoke", status: "failed", scope: "#2", evidence_ref: "comment:pull-request-old" },
    ]);
  });

  test("active evidence normalizes PR-prefixed numeric scopes", () => {
    const active = activeQueueValidationEvidence([
      { command: "npm test", status: "failed", scope: "PR #001", evidence_ref: "comment:1" },
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:2" },
      { command: "npm lint", status: "blocked", scope: "pr 0002", evidence_ref: "comment:3" },
      { command: "npm lint", status: "passed", scope: "#2", evidence_ref: "comment:4" },
    ]);

    assert.deepEqual(active, [
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:2" },
      { command: "npm lint", status: "passed", scope: "#2", evidence_ref: "comment:4" },
    ]);
  });

  test("active evidence normalizes markdown-linked cached PR scopes", () => {
    const active = activeQueueValidationEvidence([
      {
        command: "npm test",
        status: "failed",
        scope: "[#001](https://github.example.test/org/repo/pull/1)",
        evidence_ref: "comment:old",
      },
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      {
        command: "npm lint",
        status: "blocked",
        scope: "scope: [PR #002](https://github.example.test/org/repo/pull/2)",
        evidence_ref: "comment:lint-old",
      },
      { command: "npm lint", status: "passed", scope: "#2", evidence_ref: "comment:lint-new" },
    ]);

    assert.deepEqual(active, [
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      { command: "npm lint", status: "passed", scope: "#2", evidence_ref: "comment:lint-new" },
    ]);
  });

  test("active evidence treats mismatched cached markdown-linked PR scopes as queue-wide", () => {
    const active = activeQueueValidationEvidence([
      {
        command: "npm test",
        status: "failed",
        scope: "[#1](https://github.example.test/org/repo/pull/2)",
        evidence_ref: "comment:mismatched-scope",
      },
      {
        command: "[#3](https://github.example.test/org/repo/pull/4) npm lint -> blocked",
        status: "blocked",
        scope: "",
        evidence_ref: "comment:mismatched-command",
      },
      {
        command: "npm docs",
        status: "failed",
        scope: "[Pull request 5](https://github.example.test/org/repo/pull/6)",
        evidence_ref: "comment:mismatched-longform-scope",
      },
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:exact" },
    ]);

    assert.deepEqual(active, [
      { command: "npm test", status: "failed", scope: null, evidence_ref: "comment:mismatched-scope" },
      { command: "npm lint", status: "blocked", scope: null, evidence_ref: "comment:mismatched-command" },
      { command: "npm docs", status: "failed", scope: null, evidence_ref: "comment:mismatched-longform-scope" },
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:exact" },
    ]);
  });

  test("active evidence normalizes cached raw PR URL scopes", () => {
    const active = activeQueueValidationEvidence([
      {
        command: "npm test",
        status: "failed",
        scope: "https://github.example.test/org/repo/pull/1",
        evidence_ref: "comment:old",
      },
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      {
        command: "npm lint",
        status: "blocked",
        scope: "scope: https://github.example.test/org/repo/pull/2",
        evidence_ref: "comment:lint-old",
      },
      { command: "npm lint", status: "passed", scope: "#2", evidence_ref: "comment:lint-new" },
      {
        command: "npm smoke",
        status: "failed",
        scope: "https://api.github.example.test/repos/org/repo/pulls/3",
        evidence_ref: "comment:smoke-old",
      },
      { command: "npm smoke", status: "passed", scope: "#3", evidence_ref: "comment:smoke-new" },
      {
        command: "npm e2e",
        status: "failed",
        scope: "https://gitlab.example.test/org/repo/-/merge_requests/4",
        evidence_ref: "comment:e2e-old",
      },
      { command: "npm e2e", status: "passed", scope: "#4", evidence_ref: "comment:e2e-new" },
    ]);

    assert.deepEqual(active, [
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      { command: "npm lint", status: "passed", scope: "#2", evidence_ref: "comment:lint-new" },
      { command: "npm smoke", status: "passed", scope: "#3", evidence_ref: "comment:smoke-new" },
      { command: "npm e2e", status: "passed", scope: "#4", evidence_ref: "comment:e2e-new" },
    ]);
  });

  test("active evidence normalizes queue-wide scope aliases from cached evidence", () => {
    const active = activeQueueValidationEvidence([
      { command: "npm test", status: "failed", scope: "queue", evidence_ref: "comment:old" },
      { command: "npm   test", status: "passed", scope: null, evidence_ref: "comment:new" },
      { command: "npm lint", status: "blocked", scope: "scope: queue-wide", evidence_ref: "comment:lint-old" },
      { command: "npm lint", status: "passed", scope: "global", evidence_ref: "comment:lint-new" },
      { command: "npm smoke", status: "failed", scope: "PR #1 and PR #2", evidence_ref: "comment:smoke-old" },
      { command: "npm smoke", status: "passed", scope: null, evidence_ref: "comment:smoke-new" },
      { command: "PRs #3-#4 npm range", status: "failed", scope: null, evidence_ref: "comment:range-old" },
      { command: "npm range", status: "passed", scope: null, evidence_ref: "comment:range-new" },
      { command: "npm table-range", status: "failed", scope: "PRs 5-6", evidence_ref: "comment:table-range-old" },
      { command: "npm table-range", status: "passed", scope: null, evidence_ref: "comment:table-range-new" },
    ]);

    assert.deepEqual(active, [
      { command: "npm   test", status: "passed", scope: null, evidence_ref: "comment:new" },
      { command: "npm lint", status: "passed", scope: null, evidence_ref: "comment:lint-new" },
      { command: "npm smoke", status: "passed", scope: null, evidence_ref: "comment:smoke-new" },
      { command: "npm range", status: "passed", scope: null, evidence_ref: "comment:range-new" },
      { command: "npm table-range", status: "passed", scope: null, evidence_ref: "comment:table-range-new" },
    ]);
  });

  test("active evidence normalizes cached status aliases", () => {
    const active = activeQueueValidationEvidence([
      { command: "npm test", status: "FAILURE", scope: "#1", evidence_ref: "comment:old" },
      { command: "npm test", status: "SUCCESS", scope: "#1", evidence_ref: "comment:new" },
      { command: "npm lint", status: "TIMED_OUT", scope: "#2", evidence_ref: "comment:timeout" },
      { command: "npm smoke", status: "ACTION_REQUIRED", scope: "#3", evidence_ref: "comment:action" },
      { command: "npm e2e", status: "ERROR", scope: "#4", evidence_ref: "comment:error" },
      { command: "npm perf", status: "EXPIRED", scope: "#5", evidence_ref: "comment:expired" },
    ] as unknown as Parameters<typeof activeQueueValidationEvidence>[0]);

    assert.deepEqual(active, [
      { command: "npm test", status: "passed", scope: "#1", evidence_ref: "comment:new" },
      { command: "npm lint", status: "failed", scope: "#2", evidence_ref: "comment:timeout" },
      { command: "npm smoke", status: "unknown", scope: "#3", evidence_ref: "comment:action" },
      { command: "npm e2e", status: "failed", scope: "#4", evidence_ref: "comment:error" },
      { command: "npm perf", status: "unknown", scope: "#5", evidence_ref: "comment:expired" },
    ]);
  });

  test("normalizes cached validation evidence item fields at the boundary", () => {
    assert.deepEqual(
      normalizeQueueValidationEvidenceItems([
        {
          command: "scope: [#001](https://github.example.test/org/repo/pull/1) <code>npm&nbsp;test</code>",
          status: "SUCCESS",
          scope: "PR #001",
          evidence_ref: " comment:1 ",
        },
        {
          command: "",
          status: "surprise",
          scope: "queue-wide",
          evidence_ref: "   ",
        },
        {
          command: 123,
          status: "ERROR",
          scope: 456,
          evidence_ref: 789,
        },
        {
          command: "Pull Request: #301 | Command: npm run pipe-field | Result: blocked",
          status: "surprise",
          scope: "",
          evidence_ref: " comment:pipe ",
        },
        {
          command: "Scope: packages/api; Command: npm run lint; Result: action_required",
          status: undefined,
          scope: "",
          evidence_ref: "comment:field-scope",
        },
        {
          command: "npm run has-failed-word -- --grep failed",
          status: "",
          scope: "",
          evidence_ref: "",
        },
        {
          cmd: "npm run alias-cmd",
          result: "failed",
          path: "packages/web",
          evidenceRef: " comment:alias-cmd ",
        },
        {
          check: "pnpm test --filter api",
          conclusion: "success",
          pullRequest: "PR #004",
          evidence_ref: "comment:alias-check",
        },
        {
          validation: "npm run gitlab-mr",
          result: "failed",
          merge_request_iid: 206,
          evidence_ref: "comment:gitlab-mr",
        },
        {
          validation: "npm run gitlab-mr-number",
          result: "failed",
          mrNumber: 211,
          evidence_ref: "comment:gitlab-mr-number",
        },
        {
          validation: "npm run gitlab-mr-iid",
          result: "passed",
          mr_iid: "212",
          evidence_ref: "comment:gitlab-mr-iid",
        },
        {
          test: "npm run pr-id",
          outcome: "success",
          pullRequestIid: "207",
          evidence_ref: "comment:pr-id",
        },
        {
          command: "npm run link-ref",
          status: "passed",
          scope: "#208",
          _links: { html: { href: "comment:links-html" } },
        },
        {
          command: "npm run plural-ref",
          status: "failed",
          scope: "#209",
          evidence_refs: [" ", "comment:plural-primary", "comment:plural-secondary"],
          html_url: "comment:plural-url",
        },
        {
          command: "npm run malformed-pr-alias",
          status: "failed",
          pullRequest: "not-a-number",
          evidence_ref: "comment:malformed-pr-alias",
        },
        {
          cursor: "validation-edge",
          node: {
            cmd: "npm run edge",
            conclusion: "success",
            pullRequest: "PR #210",
            evidenceRef: " comment:edge ",
          },
        },
      ]),
      [
        {
          command: "npm test",
          status: "passed",
          scope: "#1",
          evidence_ref: "comment:1",
        },
        {
          command: "unknown",
          status: "unknown",
          scope: null,
          evidence_ref: null,
        },
        {
          command: "unknown",
          status: "failed",
          scope: null,
          evidence_ref: null,
        },
        {
          command: "npm run pipe-field",
          status: "blocked",
          scope: "#301",
          evidence_ref: "comment:pipe",
        },
        {
          command: "npm run lint",
          status: "unknown",
          scope: "packages/api",
          evidence_ref: "comment:field-scope",
        },
        {
          command: "npm run has-failed-word -- --grep failed",
          status: "unknown",
          scope: null,
          evidence_ref: null,
        },
        {
          command: "npm run alias-cmd",
          status: "failed",
          scope: "packages/web",
          evidence_ref: "comment:alias-cmd",
        },
        {
          command: "pnpm test --filter api",
          status: "passed",
          scope: "#4",
          evidence_ref: "comment:alias-check",
        },
        {
          command: "npm run gitlab-mr",
          status: "failed",
          scope: "#206",
          evidence_ref: "comment:gitlab-mr",
        },
        {
          command: "npm run gitlab-mr-number",
          status: "failed",
          scope: "#211",
          evidence_ref: "comment:gitlab-mr-number",
        },
        {
          command: "npm run gitlab-mr-iid",
          status: "passed",
          scope: "#212",
          evidence_ref: "comment:gitlab-mr-iid",
        },
        {
          command: "npm run pr-id",
          status: "passed",
          scope: "#207",
          evidence_ref: "comment:pr-id",
        },
        {
          command: "npm run link-ref",
          status: "passed",
          scope: "#208",
          evidence_ref: "comment:links-html",
        },
        {
          command: "npm run plural-ref",
          status: "failed",
          scope: "#209",
          evidence_ref: "comment:plural-primary",
        },
        {
          command: "npm run malformed-pr-alias",
          status: "failed",
          scope: null,
          evidence_ref: "comment:malformed-pr-alias",
        },
        {
          command: "npm run edge",
          status: "passed",
          scope: "#210",
          evidence_ref: "comment:edge",
        },
      ],
    );
  });

  test("groups PR-prefixed validation scopes by PR number", () => {
    const byPr = validationEvidenceByPrNumber([
      { command: "npm test", status: "passed", scope: "PR #001", evidence_ref: "comment:1" },
      { command: "npm lint", status: "failed", scope: "pr 0002", evidence_ref: "comment:2" },
      { command: "npm run queue", status: "failed", scope: "packages/api", evidence_ref: "comment:3" },
      { command: "npm run external", status: "passed", scope: "scope: PR #0003", evidence_ref: "comment:4" },
    ]);

    assert.deepEqual([...byPr.keys()], [1, 2, 3]);
    assert.deepEqual(byPr.get(1)?.map((item) => item.command), ["npm test"]);
    assert.deepEqual(byPr.get(2)?.map((item) => item.command), ["npm lint"]);
    assert.deepEqual(byPr.get(3)?.map((item) => item.command), ["npm run external"]);
  });

  test("normalizes queue-wide scope aliases to omitted scope", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-validation",
        body: [
          "- scope: queue `npm run test -- queue` -> failed",
          "- scope=queue-wide npm run lint -- queue => blocked",
          "- scope: all npm run smoke -- queue: cancelled",
          "- scope: global `npm run canary` -> passed",
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| whole-queue | npm run e2e | failed |",
          "| `queue_wide` | npm run perf | timed out |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.command, item.status, item.scope]), [
      ["npm run test -- queue", "failed", null],
      ["npm run lint -- queue", "blocked", null],
      ["npm run smoke -- queue", "unknown", null],
      ["npm run canary", "passed", null],
      ["npm run e2e", "failed", null],
      ["npm run perf", "failed", null],
    ]);
  });

  test("preserves package path scopes with scoped npm package names", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-scoped-package",
        body: [
          "- scope: packages/@merge-god/api npm run test -- api -> failed",
          "- scope=packages/@merge-god/ui: pnpm test --filter @merge-god/ui => passed",
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| packages/@merge-god/worker | npm run worker-smoke | action required |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run test -- api",
        status: "failed",
        scope: "packages/@merge-god/api",
        evidence_ref: "https://example.test/pull/203#issuecomment-scoped-package",
      },
      {
        command: "pnpm test --filter @merge-god/ui",
        status: "passed",
        scope: "packages/@merge-god/ui",
        evidence_ref: "https://example.test/pull/203#issuecomment-scoped-package",
      },
      {
        command: "npm run worker-smoke",
        status: "unknown",
        scope: "packages/@merge-god/worker",
        evidence_ref: "https://example.test/pull/203#issuecomment-scoped-package",
      },
    ]);
  });

  test("keeps table command pipes inside code spans and escaped cells", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-validation",
        body: [
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| #201 | `npm run test -- 'api|web'` | passed |",
          "| #202 | npm run grep -- a\\|b | failed |",
          "| #203 | `npm run build | tee log` | blocked |",
          "| #205 | <code>npm run html-build | tee html.log</code> | passed |",
        ].join("\n"),
      },
      {
        html_url: "https://example.test/pull/203#issuecomment-fallback",
        body: [
          "| #204 | `npm run smoke | tee smoke.log` | failed |",
          "| #206 | <code>npm run html-smoke | tee smoke.log</code> | failed |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run test -- 'api|web'",
        status: "passed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run grep -- a|b",
        status: "failed",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run build | tee log",
        status: "blocked",
        scope: "#203",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run html-build | tee html.log",
        status: "passed",
        scope: "#205",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run smoke | tee smoke.log",
        status: "failed",
        scope: "#204",
        evidence_ref: "https://example.test/pull/203#issuecomment-fallback",
      },
      {
        command: "npm run html-smoke | tee smoke.log",
        status: "failed",
        scope: "#206",
        evidence_ref: "https://example.test/pull/203#issuecomment-fallback",
      },
    ]);
  });

  test("extracts headerless table rows whose command names contain status aliases", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-headerless-table",
        body: [
          "| #201 | npm run provider-error | passed |",
          "| #202 | npm run expired-cache | failed |",
          "| #203 | npm run action-required-fixture | neutral |",
          "| passed | #204 | npm run status-first |",
          "| packages/api | failed | npm run path-status-first |",
          "| npm run path-command-first | packages/ui | action required |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run provider-error",
        status: "passed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-headerless-table",
      },
      {
        command: "npm run expired-cache",
        status: "failed",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-headerless-table",
      },
      {
        command: "npm run action-required-fixture",
        status: "unknown",
        scope: "#203",
        evidence_ref: "https://example.test/pull/203#issuecomment-headerless-table",
      },
      {
        command: "npm run status-first",
        status: "passed",
        scope: "#204",
        evidence_ref: "https://example.test/pull/203#issuecomment-headerless-table",
      },
      {
        command: "npm run path-status-first",
        status: "failed",
        scope: "packages/api",
        evidence_ref: "https://example.test/pull/203#issuecomment-headerless-table",
      },
      {
        command: "npm run path-command-first",
        status: "unknown",
        scope: "packages/ui",
        evidence_ref: "https://example.test/pull/203#issuecomment-headerless-table",
      },
    ]);
  });

  test("extracts validation tables with constituent and conclusion headers", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-validation-table",
        body: [
          "| Merge Request | Validation | Conclusion |",
          "| --- | --- | --- |",
          "| !212 | npm run smoke | failure |",
          "| [MR !213](https://gitlab.example.test/org/repo/-/merge_requests/213) | pnpm test --filter api | success |",
          "| !214 API update | npm run api | failed |",
          "| [!215](https://gitlab.example.test/org/repo/-/merge_requests/215) UI update | npm run ui | passed |",
          "| packages/web | yarn test | action required |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run smoke",
        status: "failed",
        scope: "#212",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation-table",
      },
      {
        command: "pnpm test --filter api",
        status: "passed",
        scope: "#213",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation-table",
      },
      {
        command: "npm run api",
        status: "failed",
        scope: "#214",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation-table",
      },
      {
        command: "npm run ui",
        status: "passed",
        scope: "#215",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation-table",
      },
      {
        command: "yarn test",
        status: "unknown",
        scope: "packages/web",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation-table",
      },
    ]);
  });

  test("extracts real-world narrative validation result tables without command columns", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/183#issuecomment-rc1-validation",
        body: [
          "| Flow | Evidence | Result |",
          "| --- | --- | --- |",
          "| Create LPAR workflow | Session `sess-49c0`; reached approval gate with `mutations_used=0`. | PASS |",
          "| Edit LPAR workflow | Session `sess-e8a1`; reached approval gate with `mutations_used=0`. | PASS |",
          "| Safari fresh chat | Carbon shadow DOM contained `Something went wrong`. | HOLD/INCOMPLETE |",
          "",
          "| Package | Evidence | Result |",
          "| --- | --- | --- |",
          "| packages/chat | Focused Storybook timed out. | HOLD |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "Create LPAR workflow",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/183#issuecomment-rc1-validation",
      },
      {
        command: "Edit LPAR workflow",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/183#issuecomment-rc1-validation",
      },
      {
        command: "Safari fresh chat",
        status: "blocked",
        scope: null,
        evidence_ref: "https://example.test/pull/183#issuecomment-rc1-validation",
      },
      {
        command: "Focused Storybook timed out.",
        status: "blocked",
        scope: "packages/chat",
        evidence_ref: "https://example.test/pull/183#issuecomment-rc1-validation",
      },
    ]);
  });

  test("does not treat real-world commit audit code spans as validation commands", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/183#issuecomment-commit-audit",
        body: [
          "## Chat fix commit audit before validation",
          "",
          "| Commit | Subject | Specific chat fix / validation role |",
          "| --- | --- | --- |",
          "| `9cfaa913` | fix(chat): suppress pending live prompt echo | Avoids duplicate pending user prompts while Carbon echoes live input. |",
          "| `aca2c87a` | fix(chat): resolve merge queue integration | Fixes type/test fallout from earlier merge-queue integration. |",
          "| [`d255100e`](https://github.example.test/org/repo/commit/d255100e) | fix(chat): settle fast Carbon sends | Stabilizes fast Carbon send handling in the later stack. |",
          "",
          "Safari note: `safari_browser doctor` still reports the native helper daemon unavailable, so native screenshots/clicks are blocked locally.",
          "",
          "- PASS `npm run lint:strict`",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run lint:strict",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/183#issuecomment-commit-audit",
      },
    ]);
  });

  test("extracts real-world named validation summary lines without using run ids as commands", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/183#issuecomment-rc1-suite",
        body: [
          "RC1 /chat validation update for commit `533ce0be`:",
          "",
          "- Web checks: `npm exec vitest -- run apps/chat/src/lib/targetSelectionLaunch.test.ts`; `npm run typecheck -- --pretty false`.",
          "- Full RC1 deterministic suite passed from agent: run `1b4507932556e9a0`, 12/12 PASS.",
          "- Storybook focused test: `apps-chat-components-chatcomposer--conversation-variant` passed with a11y enabled.",
          "Validation passed locally:",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "Full RC1 deterministic suite",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/183#issuecomment-rc1-suite",
      },
      {
        command: "Storybook focused test",
        status: "passed",
        scope: null,
        evidence_ref: "https://example.test/pull/183#issuecomment-rc1-suite",
      },
    ]);
  });

  test("supersedes real-world narrative labels with prompt and workflow suffixes", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/183#issuecomment-old-rc1",
        body: [
          "| Flow | Evidence | Result |",
          "| --- | --- | --- |",
          "| Create LPAR final gate | Initial prompt did not reach approval. | Blocker |",
          "| Edit-LPAR rename workflow | Rename proposal was not surfaced. | Blocker |",
          "| Edit LPAR proposed-property prompt | Continuation completed without model work. | Blocker |",
          "| Fresh live edit run | Provider returned no choices after table selection. | Blocker |",
        ].join("\n"),
      },
      {
        html_url: "https://example.test/pull/183#issuecomment-new-rc1",
        body: [
          "| Flow | Evidence | Result |",
          "| --- | --- | --- |",
          "| Create LPAR workflow | Later run reached approval. | PASS |",
          "| Edit LPAR workflow | Later run reached approval. | PASS |",
        ].join("\n"),
      },
    ]);

    const active = activeQueueValidationEvidence(evidence);
    const partitioned = partitionQueueValidationEvidence(evidence);

    assert.deepEqual(
      active.map((item) => [item.command, item.status, item.evidence_ref]),
      [
        [
          "Create LPAR workflow",
          "passed",
          "https://example.test/pull/183#issuecomment-new-rc1",
        ],
        [
          "Edit LPAR workflow",
          "passed",
          "https://example.test/pull/183#issuecomment-new-rc1",
        ],
      ],
    );
    assert.deepEqual(
      partitioned.superseded.map((entry) => [entry.evidence.command, entry.evidence.status]),
      [
        ["Create LPAR final gate", "blocked"],
        ["Edit-LPAR rename workflow", "blocked"],
        ["Edit LPAR proposed-property prompt", "blocked"],
        ["Fresh live edit run", "blocked"],
      ],
    );
  });

  test("ignores headered validation table rows without recognizable commands", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-table-prose",
        body: [
          "### PR #216",
          "| Command | Result |",
          "| --- | --- |",
          "| not applicable | passed |",
          "| waiting for reviewer | failed |",
          "| npm run valid-table | passed |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run valid-table",
        status: "passed",
        scope: "#216",
        evidence_ref: "https://example.test/pull/203#issuecomment-table-prose",
      },
    ]);
  });

  test("uses explicit result markers instead of status words inside command names", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-validation",
        body: [
          "- #201 `npm run failure-report` -> passed",
          "- #202 `npm run success-repro` -> failed",
          "- #203 npm run blocked-fixture => passed",
          "- #204 npm run passing-smoke => blocked",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run failure-report",
        status: "passed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run success-repro",
        status: "failed",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run blocked-fixture",
        status: "passed",
        scope: "#203",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run passing-smoke",
        status: "blocked",
        scope: "#204",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
    ]);
  });

  test("extracts canceled and timeout validation outcomes", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-validation",
        body: [
          "- #201 `npm run e2e` -> cancelled",
          "- #202 npm run smoke => canceled",
          "- #203 `npm run load-test` -> timed out",
          "- #204 npm run soak: timeout",
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| #205 | npm run canary | cancelled |",
          "| #206 | npm run perf | timed out |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run e2e",
        status: "unknown",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run smoke",
        status: "unknown",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run load-test",
        status: "failed",
        scope: "#203",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run soak",
        status: "failed",
        scope: "#204",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run canary",
        status: "unknown",
        scope: "#205",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run perf",
        status: "failed",
        scope: "#206",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
    ]);
  });

  test("normalizes GitHub-style validation conclusion tokens", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-github-conclusions",
        body: [
          "- #301 `npm run e2e` -> TIMED_OUT",
          "- #302 npm run smoke => ACTION_REQUIRED",
          "- #303 `npm run canary` -> IN_PROGRESS",
          "- #304 npm run neutral => NEUTRAL",
          "- #305 `npm run bootstrap` -> STARTUP_FAILURE",
          "- #308 npm run provider-error => ERROR",
          "- #309 npm run provider-expired => EXPIRED",
          "- #310 npm run provider-errored => ERRORED",
          "| Scope | Command | Conclusion |",
          "| --- | --- | --- |",
          "| #306 | npm run table-timeout | TIMED_OUT |",
          "| #307 | npm run table-neutral | NEUTRAL |",
          "| #311 | npm run table-error | ERROR |",
          "| #312 | npm run table-expired | EXPIRED |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run e2e",
        status: "failed",
        scope: "#301",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
      {
        command: "npm run smoke",
        status: "unknown",
        scope: "#302",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
      {
        command: "npm run canary",
        status: "unknown",
        scope: "#303",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
      {
        command: "npm run neutral",
        status: "unknown",
        scope: "#304",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
      {
        command: "npm run bootstrap",
        status: "failed",
        scope: "#305",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
      {
        command: "npm run provider-error",
        status: "failed",
        scope: "#308",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
      {
        command: "npm run provider-expired",
        status: "unknown",
        scope: "#309",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
      {
        command: "npm run provider-errored",
        status: "failed",
        scope: "#310",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
      {
        command: "npm run table-timeout",
        status: "failed",
        scope: "#306",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
      {
        command: "npm run table-neutral",
        status: "unknown",
        scope: "#307",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
      {
        command: "npm run table-error",
        status: "failed",
        scope: "#311",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
      {
        command: "npm run table-expired",
        status: "unknown",
        scope: "#312",
        evidence_ref: "https://example.test/pull/203#issuecomment-github-conclusions",
      },
    ]);
  });

  test("preserves unquoted command names that contain colons before colon result markers", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-validation",
        body: [
          "- #201 npm run typecheck:api: passed",
          "- scope: packages/api npm run test:integration: failed",
          "- https://github.example.test/org/repo/pull/202 npm run url-scope: ACTION_REQUIRED",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence, [
      {
        command: "npm run typecheck:api",
        status: "passed",
        scope: "#201",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run test:integration",
        status: "failed",
        scope: "packages/api",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
      {
        command: "npm run url-scope",
        status: "unknown",
        scope: "#202",
        evidence_ref: "https://example.test/pull/203#issuecomment-validation",
      },
    ]);
  });

  test("ignores command-looking lines inside fenced logs", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-fenced-log",
        body: [
          "- #201 `npm test` -> passed",
          "```text",
          "npm run storybook: failed",
          "#202 npm run e2e -> failed",
          "| #203 | npm run smoke | failed |",
          "```",
          "- #204 npm run canary -> blocked",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#204", "npm run canary", "blocked"],
    ]);
  });

  test("ignores command-looking lines inside indented Markdown code logs", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-indented-log",
        body: [
          "- #201 `npm test` -> passed",
          "    #201 npm test -> failed",
          "    scope: packages/api npm run lint -> failed",
          "    npm run queue-smoke: failed",
          "  - #202 npm run smoke -> passed",
          "    - #204 npm run nested -> passed",
          "    | #203 | npm run table-visible | passed |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
      ["#204", "npm run nested", "passed"],
      ["#203", "npm run table-visible", "passed"],
    ]);
  });

  test("ignores quoted stale validation evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-quoted-status",
        body: [
          "- #201 `npm test` -> passed",
          "> #201 `npm test` -> failed",
          "> | #202 | npm run smoke | failed |",
          "- #202 npm run smoke -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
    ]);
  });

  test("ignores fully struck-through stale validation evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-struck-status",
        body: [
          "- #201 `npm test` -> passed",
          "- ~~#201 `npm test` -> failed~~",
          "1. ~~#201 `npm test` -> blocked~~",
          "- [x] ~~#202 npm run smoke~~",
          "2. <del>#202 npm run smoke -> failed</del>",
          "- #202 npm run smoke -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
    ]);
  });

  test("ignores fully struck-through stale table validation rows", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-struck-table",
        body: [
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| #201 | npm test | passed |",
          "| ~~#201~~ | ~~npm test~~ | ~~failed~~ |",
          "| ~~#202~~ | ~~npm run smoke~~ | ~~failed~~ |",
          "| #202 | npm run smoke | passed |",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
    ]);
  });

  test("ignores fully HTML-struck stale validation evidence", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-html-struck",
        body: [
          "- #201 `npm test` -> passed",
          "- <del>#201 `npm test` -> failed</del>",
          "- <s>#202 npm run smoke -> failed</s>",
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| <strike>#203</strike> | <strike>npm run e2e</strike> | <strike>failed</strike> |",
          "- #202 npm run smoke -> passed",
          "- #203 npm run e2e -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
      ["#203", "npm run e2e", "passed"],
    ]);
  });

  test("ignores merge-god review gate cache comments", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-cache",
        body: [
          REVIEW_GATE_CACHE_MARKER,
          "## merge-god review gate status",
          "- #201 `npm test` -> failed",
          "| Scope | Command | Result |",
          "| --- | --- | --- |",
          "| #202 | npm run smoke | failed |",
        ].join("\n"),
      },
      {
        html_url: "https://example.test/pull/203#issuecomment-real-validation",
        body: "- #201 `npm test` -> passed",
      },
      {
        html_url: "https://example.test/pull/203#issuecomment-markerless-cache",
        body: [
          "## merge-god review gate status",
          "",
          "| Rule | Status | Explanation |",
          "| --- | --- | --- |",
          "| modeled-blockers | blocked | stale status |",
          "",
          "- #202 `npm run stale-cache` -> failed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status, item.evidence_ref]), [
      ["#201", "npm test", "passed", "https://example.test/pull/203#issuecomment-real-validation"],
    ]);
  });

  test("ignores manual gate status comments without validation commands", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-manual-gate",
        body: [
          "merge-god: blocked - release owner signoff pending",
          "Human gate: product approval required",
          "Do not merge: waiting on security",
          "External gate: legal signoff pending",
          "- #201 `npm test` -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status, item.evidence_ref]), [
      ["#201", "npm test", "passed", "https://example.test/pull/203#issuecomment-manual-gate"],
    ]);
  });

  test("uses code-spanned scope prefixes without mistaking them for commands", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-coded-scope",
        body: [
          "- scope: `#201` `npm test` -> failed",
          "- scope=`packages/api`: `pnpm test --filter api` => passed",
          "- scope: `queue-wide` `npm run queue` -> blocked",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "failed"],
      ["packages/api", "pnpm test --filter api", "passed"],
      [null, "npm run queue", "blocked"],
    ]);
  });

  test("ignores command-looking lines inside details blocks", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-details-log",
        body: [
          "- #201 `npm test` -> passed",
          "<details>",
          "<summary>Old log</summary>",
          "#201 npm test -> failed",
          "scope: packages/api npm run lint -> failed",
          "| #202 | npm run smoke | failed |",
          "</details>",
          "- #202 npm run smoke -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
    ]);
  });

  test("ignores command-looking lines inside preformatted HTML blocks", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-pre-log",
        body: [
          "- #201 `npm test` -> passed",
          "<pre>",
          "#201 npm test -> failed",
          "scope: packages/api npm run lint -> failed",
          "</pre>",
          "- #202 npm run smoke -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
    ]);
  });

  test("ignores command-looking lines inside inline HTML log blocks", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-inline-log",
        body: [
          "- #201 `npm test` -> passed",
          "<pre>#201 npm test -> failed</pre>",
          "<details><summary>Old log</summary>#202 npm run smoke -> failed</details>",
          "- #202 npm run smoke -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
    ]);
  });

  test("preserves visible validation evidence around inline hidden HTML blocks", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-inline-visible",
        body: [
          "- #201 `npm test` -> passed <details><summary>old</summary>#201 npm test -> failed</details>",
          "<pre>#202 npm run smoke -> failed</pre> - #202 npm run smoke -> passed",
          "- #203 npm run canary -> blocked <details>",
          "#203 npm run canary -> passed",
          "</details> - #204 npm run e2e -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
      ["#203", "npm run canary", "blocked"],
      ["#204", "npm run e2e", "passed"],
    ]);
  });

  test("ignores command-looking lines inside HTML comments", () => {
    const evidence = extractQueueValidationEvidence([
      {
        html_url: "https://example.test/pull/203#issuecomment-hidden-log",
        body: [
          "- #201 `npm test` -> passed <!-- trailing note is hidden -->",
          "<!-- #201 npm test -> failed -->",
          "<!--",
          "#202 npm run smoke -> failed",
          "-->",
          "- #202 npm run smoke -> passed",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(evidence.map((item) => [item.scope, item.command, item.status]), [
      ["#201", "npm test", "passed"],
      ["#202", "npm run smoke", "passed"],
    ]);
  });
});
