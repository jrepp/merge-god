import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  commentVisibilityEvents,
  visibleCommentLines,
} from "../comment_visibility_model";

describe("comment visibility model", () => {
  test("keeps only visible authoritative comment lines", () => {
    const lines = visibleCommentLines([
      "- #201 Visible constituent",
      "```",
      "- #202 Fenced stale constituent",
      "```",
      "> - #203 Quoted stale constituent",
      "<!-- - #204 Hidden stale constituent -->",
      "<details>",
      "<summary>Old membership</summary>",
      "- #205 Details stale constituent",
      "</details>",
      "<pre>- #206 Pre stale constituent</pre>",
      "    #213 Indented stale constituent",
      "    #214 npm test -> failed",
      "- ~~#207 Crossed out stale constituent~~",
      "1. ~~#215 Ordered crossed out stale constituent~~",
      "| ~~#208~~ | ~~npm test~~ | ~~failed~~ |",
      "- <del>#210 HTML deleted constituent</del>",
      "2. <del>#216 Ordered HTML deleted constituent</del>",
      "| <s>#211</s> | <s>npm test</s> | <s>failed</s> |",
      "- <strike>#212 HTML struck constituent</strike>",
      "- #209 Visible after hidden blocks",
    ].join("\n"));

    assert.deepEqual(lines, [
      "- #201 Visible constituent",
      "- #209 Visible after hidden blocks",
    ]);
  });

  test("ignores indented Markdown code logs without hiding nested lists or tables", () => {
    const lines = visibleCommentLines([
      "- #201 Visible constituent",
      "    #202 Indented copied constituent",
      "    npm test -> failed",
      "  - #203 Nested visible constituent",
      "    | #204 | npm test | passed |",
      "    - #205 Four-space nested visible constituent",
      "    + #206 Four-space plus-list visible constituent",
      "\t#205 Tab-indented copied constituent",
      "+ #207 Visible after indented log",
    ].join("\n"));

    assert.deepEqual(lines, [
      "- #201 Visible constituent",
      "  - #203 Nested visible constituent",
      "    | #204 | npm test | passed |",
      "    - #205 Four-space nested visible constituent",
      "    + #206 Four-space plus-list visible constituent",
      "+ #207 Visible after indented log",
    ]);
  });

  test("preserves visible text around inline HTML comments", () => {
    const lines = visibleCommentLines([
      "- #201 Visible <!-- hidden note --> constituent",
      "<!-- hidden block starts",
      "- #202 Hidden constituent",
      "--> - #203 Visible after close",
    ].join("\n"));

    assert.deepEqual(lines, [
      "- #201 Visible  constituent",
      " - #203 Visible after close",
    ]);
  });

  test("preserves visible text around inline hidden HTML blocks", () => {
    const lines = visibleCommentLines([
      "- #201 Visible before <details><summary>old</summary>- #202 Hidden</details> and after",
      "<pre>#203 Hidden validation -> failed</pre> - #204 Visible after pre",
      "- #205 Visible before multiline <details>",
      "- #206 Hidden multiline",
      "</details> - #207 Visible after multiline",
    ].join("\n"));

    assert.deepEqual(lines, [
      "- #201 Visible before  and after",
      " - #204 Visible after pre",
      "- #205 Visible before multiline ",
      " - #207 Visible after multiline",
    ]);
  });

  test("emits hidden events so table consumers can reset state", () => {
    const events = commentVisibilityEvents([
      "| Scope | Command | Result |",
      "| --- | --- | --- |",
      "<details><summary>old rows</summary>| #201 | npm test | failed |</details>",
      "| #201 | npm test | passed |",
    ].join("\n"));

    assert.deepEqual(events.map((event) => [event.visible, event.line]), [
      [true, "| Scope | Command | Result |"],
      [true, "| --- | --- | --- |"],
      [false, "<details><summary>old rows</summary>| #201 | npm test | failed |</details>"],
      [true, "| #201 | npm test | passed |"],
    ]);
  });
});
