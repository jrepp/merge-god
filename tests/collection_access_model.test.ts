import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  collectionItems,
  firstPresentRecordCollection,
  firstPresentRecordCollectionBy,
  recordCollectionItems,
  recordShapeItem,
} from "../collection_access_model";

describe("collection access model", () => {
  test("normalizes direct records and direct edge records", () => {
    assert.deepEqual(recordShapeItem({ id: "plain" }), { id: "plain" });
    assert.deepEqual(
      recordShapeItem({ __typename: "PullRequestEdge", cursor: "pr-1", node: { id: "edge" } }),
      { id: "edge" },
    );
    assert.equal(recordShapeItem({ node: {} }), null);
    assert.equal(recordShapeItem({}), null);
    assert.equal(recordShapeItem(null), null);
  });

  test("normalizes plain arrays, direct edge arrays, and connection objects", () => {
    assert.deepEqual(recordCollectionItems([{ id: "plain" }]), [{ id: "plain" }]);
    assert.deepEqual(
      recordCollectionItems([
        { __typename: "CommitEdge", cursor: "a", node: { id: "edge" } },
        { cursor: "empty", node: {} },
        { node: null },
      ]),
      [{ id: "edge" }],
    );
    assert.deepEqual(
      recordCollectionItems({
        nodes: [
          null,
          { id: "node" },
        ],
      }),
      [{ id: "node" }],
    );
    assert.deepEqual(
      recordCollectionItems({
        edges: [
          { node: { id: "connection-edge" } },
          { node: {} },
        ],
      }),
      [{ id: "connection-edge" }],
    );
  });

  test("unwraps edge-shaped records inside connection nodes and edges", () => {
    assert.deepEqual(
      recordCollectionItems({
        nodes: [
          { __typename: "CommitEdge", cursor: "a", node: { id: "nested-node-edge" } },
          { cursor: "empty", node: {} },
        ],
      }),
      [{ id: "nested-node-edge" }],
    );
    assert.deepEqual(
      recordCollectionItems({
        edges: [
          { node: { __typename: "CommitEdge", cursor: "b", node: { id: "nested-edge-edge" } } },
          { node: { cursor: "empty", node: {} } },
        ],
      }),
      [{ id: "nested-edge-edge" }],
    );
  });

  test("normalizes scalar and record collections without losing edge node values", () => {
    assert.deepEqual(collectionItems(["a", null, { node: "b" }]), ["a", "b"]);
    assert.deepEqual(collectionItems({ nodes: ["a", { path: "b" }, null] }), ["a", { path: "b" }]);
    assert.deepEqual(collectionItems({ edges: [{ node: "a" }, { node: { path: "b" } }, { node: null }] }), [
      "a",
      { path: "b" },
    ]);
    assert.deepEqual(collectionItems({ nodes: [{ cursor: "a", node: "nested-node" }] }), ["nested-node"]);
    assert.deepEqual(collectionItems({ edges: [{ node: { cursor: "b", node: "nested-edge" } }] }), ["nested-edge"]);
  });

  test("falls back past empty canonical collections to useful aliases", () => {
    assert.deepEqual(
      firstPresentRecordCollection(
        {
          canonical: [null, {}, "placeholder"],
          alias: [{ id: "alias" }],
        },
        ["canonical", "alias"],
      ),
      [{ id: "alias" }],
    );
  });

  test("falls back past present collections that fail a usefulness predicate", () => {
    const hasUsefulValue = (items: Record<string, unknown>[]): boolean =>
      items.some((item) => typeof item["value"] === "string" && item["value"].trim().length > 0);

    assert.deepEqual(
      firstPresentRecordCollectionBy(
        {
          canonical: [{ value: " " }],
          alias: [{ value: "useful" }],
        },
        ["canonical", "alias"],
        hasUsefulValue,
      ),
      [{ value: "useful" }],
    );
    assert.deepEqual(
      firstPresentRecordCollectionBy(
        {
          canonical: [{ value: " " }],
          alias: [{ value: "" }],
        },
        ["canonical", "alias"],
        hasUsefulValue,
      ),
      [{ value: " " }],
    );
  });
});
