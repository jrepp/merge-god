import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { extractManualMergeGateBlockers } from "../manual_gate_model";
import { REVIEW_GATE_CACHE_MARKER } from "../review_gate_cache";

describe("manual gate model", () => {
  test("extracts active manual merge gates from authoritative visible comments", () => {
    const blockers = extractManualMergeGateBlockers([
      {
        html_url: "https://example.test/pull/203#issuecomment-hold",
        created_at: "2026-07-01T10:00:00.000Z",
        body: "Do not merge: release manager approval is required",
      },
      {
        html_url: "https://example.test/pull/203#issuecomment-ready",
        created_at: "2026-07-01T10:05:00.000Z",
        body: "merge-god: ready to merge",
      },
      {
        html_url: "https://example.test/pull/203#issuecomment-human",
        created_at: "2026-07-01T10:10:00.000Z",
        body: "Human gate: product owner signoff is required",
      },
      {
        url: "https://example.test/pull/203#discussion_r_security",
        submitted_at: "2026-07-01T10:11:00.000Z",
        body: "- merge-god: blocked - security signoff pending",
      },
    ]);

    assert.deepEqual(blockers, [
      {
        kind: "external_gate",
        status: "blocked",
        summary: "Manual merge gate is blocked: product owner signoff is required.",
        evidence_refs: ["https://example.test/pull/203#issuecomment-human"],
      },
      {
        kind: "external_gate",
        status: "blocked",
        summary: "Manual merge gate is blocked: security signoff pending.",
        evidence_refs: ["https://example.test/pull/203#discussion_r_security"],
      },
    ]);
  });

  test("ignores cache comments, hidden text, validation rows, and cleared gates", () => {
    const blockers = extractManualMergeGateBlockers([
      {
        html_url: "https://example.test/pull/203#issuecomment-cache",
        body: `${REVIEW_GATE_CACHE_MARKER}\nDo not merge: generated cache text`,
      },
      {
        html_url: "https://example.test/pull/203#issuecomment-hidden",
        body: [
          "> Do not merge: quoted stale hold",
          "```",
          "Do not merge: copied log",
          "```",
          "~~Do not merge: stale struck hold~~",
          "- blocked for PR #201: npm test",
          "Manual gate: release train window is closed",
          "Manual gate cleared",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(blockers, []);
  });

  test("uses stable input order when timestamps are absent", () => {
    const blockers = extractManualMergeGateBlockers([
      {
        html_url: "https://example.test/pull/203#issuecomment-first",
        body: "External gate: release owner approval required.",
      },
      {
        html_url: "https://example.test/pull/203#issuecomment-second",
        body: "merge-god: cleared",
      },
      {
        html_url: "https://example.test/pull/203#issuecomment-third",
        body: "merge hold - rollout operator approval required",
      },
    ]);

    assert.deepEqual(blockers, [
      {
        kind: "external_gate",
        status: "blocked",
        summary: "Manual merge gate is blocked: rollout operator approval required.",
        evidence_refs: ["https://example.test/pull/203#issuecomment-third"],
      },
    ]);
  });

  test("extracts release decision hold lines from real queue updates", () => {
    const blockers = extractManualMergeGateBlockers([
      {
        html_url: "https://example.test/pull/183#issuecomment-rc1-hold",
        body: [
          "RC1 validation update for the current integration head.",
          "Remaining RC1 decision: HOLD, not approve. Blocking items are the Safari fresh `/chat` catastrophic panel and incomplete Safari ISOF route evidence.",
        ].join("\n"),
      },
    ]);

    assert.deepEqual(blockers, [
      {
        kind: "external_gate",
        status: "blocked",
        summary: "Manual merge gate is blocked: Blocking items are the Safari fresh `/chat` catastrophic panel and incomplete Safari ISOF route evidence.",
        evidence_refs: ["https://example.test/pull/183#issuecomment-rc1-hold"],
      },
    ]);
  });

  test("preserves full long release decision reasons in the domain model", () => {
    const reason = [
      "Blocking items are the Safari fresh `/chat` catastrophic panel",
      "incomplete Safari ISOF route evidence",
      "previously recorded live `workflow-exec-route.spec.ts` failures clustered around screenshot drift",
      "HIL parameter collection",
      "and delayed fabric takeover rendering after the route migration fix set",
    ].join(", ");
    const blockers = extractManualMergeGateBlockers([
      {
        html_url: "https://example.test/pull/183#issuecomment-rc1-long-hold",
        body: `Remaining RC1 decision: HOLD, not approve. ${reason}`,
      },
    ]);

    assert.deepEqual(blockers, [
      {
        kind: "external_gate",
        status: "blocked",
        summary: `Manual merge gate is blocked: ${reason}.`,
        evidence_refs: ["https://example.test/pull/183#issuecomment-rc1-long-hold"],
      },
    ]);
    assert.ok(blockers[0]!.summary.includes("delayed fabric takeover rendering"));
  });

  test("clears release decision hold lines with later explicit pass decisions", () => {
    const blockers = extractManualMergeGateBlockers([
      {
        html_url: "https://example.test/pull/183#issuecomment-rc1-hold",
        created_at: "2026-07-01T22:00:00.000Z",
        body: [
          "Scenario 2 datacenter redirect: PASS.",
          "Remaining RC1 decision: HOLD, not approve. Blocking items are Safari coverage gaps.",
        ].join("\n"),
      },
      {
        html_url: "https://example.test/pull/183#issuecomment-rc1-pass",
        created_at: "2026-07-01T23:00:00.000Z",
        body: "Final RC1 decision: PASS. Ready for merge.",
      },
    ]);

    assert.deepEqual(blockers, []);
  });

  test("preserves explicit comment and source refs on manual gate blockers", () => {
    const blockers = extractManualMergeGateBlockers([
      {
        commentRef: " gate:comment-ref ",
        html_url: "https://example.test/pull/203#issuecomment-fallback",
        body: "Do not merge: release approval is pending",
      },
      {
        source_ref: "gate:source-ref",
        url: "https://example.test/pull/203#discussion_r_fallback",
        body: "External gate: deployment owner approval is pending",
      },
    ]);

    assert.deepEqual(blockers, [
      {
        kind: "external_gate",
        status: "blocked",
        summary: "Manual merge gate is blocked: release approval is pending.",
        evidence_refs: ["gate:comment-ref"],
      },
      {
        kind: "external_gate",
        status: "blocked",
        summary: "Manual merge gate is blocked: deployment owner approval is pending.",
        evidence_refs: ["gate:source-ref"],
      },
    ]);
  });

  test("normalizes direct edge-shaped comments before ordering and parsing gates", () => {
    const blockers = extractManualMergeGateBlockers([
      {
        cursor: "first",
        node: {
          htmlUrl: "https://example.test/pull/203#issuecomment-edge-hold",
          createdAt: "2026-07-01T10:00:00.000Z",
          bodyText: "Do not merge: release train is paused",
        },
      },
      {
        cursor: "second",
        node: {
          htmlUrl: "https://example.test/pull/203#issuecomment-edge-ready",
          createdAt: "2026-07-01T10:05:00.000Z",
          bodyText: "merge-god: clear",
        },
      },
      {
        cursor: "third",
        node: {
          htmlUrl: "https://example.test/pull/203#issuecomment-edge-human",
          createdAt: "2026-07-01T10:10:00.000Z",
          bodyText: "External gate: rollout owner approval required",
        },
      },
    ]);

    assert.deepEqual(blockers, [
      {
        kind: "external_gate",
        status: "blocked",
        summary: "Manual merge gate is blocked: rollout owner approval required.",
        evidence_refs: ["https://example.test/pull/203#issuecomment-edge-human"],
      },
    ]);
  });
});
