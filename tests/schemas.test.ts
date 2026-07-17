import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseOperatorConfig } from "../schemas/config";
import {
  childActivityBodySchema,
  CoordinationBodyError,
  parseCoordinationBody,
  trajectoryEventBodySchema,
} from "../schemas/coordination";

describe("boundary schemas", () => {
  test("validates operator config while retaining extension fields", () => {
    const config = parseOperatorConfig({
      repos: [{ path: "/repo", enabled: true, custom_forge: "gitea" }],
      dashboard: { refresh_seconds: 5 },
    });
    assert.equal(config.repos[0]?.path, "/repo");
    assert.equal(config.repos[0]?.custom_forge, "gitea");
    assert.deepEqual(config.dashboard, { refresh_seconds: 5 });
    assert.throws(() => parseOperatorConfig({ repos: [{ path: 42 }] }), /Invalid operator config/);
  });

  test("applies coordination defaults and rejects missing required fields", () => {
    const event = parseCoordinationBody(trajectoryEventBodySchema, { event_type: "agent.started" });
    assert.equal(event.actor, "pi-agent");
    assert.deepEqual(event.payload, {});
    assert.deepEqual(event.refs, {});

    const activity = parseCoordinationBody(childActivityBodySchema, {
      type: "implementation",
      summary: "Apply the patch",
      model_tier: "standard",
      model_reason: "bounded change",
    });
    assert.equal(activity.prompt_runtime_ref, null);
    assert.deepEqual(activity.evidence_refs, []);
    assert.throws(
      () => parseCoordinationBody(trajectoryEventBodySchema, {}),
      CoordinationBodyError,
    );
  });
});
