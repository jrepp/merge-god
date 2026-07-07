import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeMarkdownTableCell } from "../markdown_table_model";

describe("markdown table model", () => {
  test("escapes markdown table, HTML, code, and mention-sensitive characters", () => {
    assert.equal(
      sanitizeMarkdownTableCell("team @ops | `<script>&</script>`", 200),
      "team &#64;ops \\| &#96;&lt;script&gt;&amp;&lt;/script&gt;&#96;",
    );
  });

  test("normalizes control characters and whitespace before rendering", () => {
    assert.equal(
      sanitizeMarkdownTableCell("  failed\n\tbecause\u0000checks   timed out  ", 200),
      "failed because checks timed out",
    );
  });

  test("renders nullish and non-string values explicitly", () => {
    assert.equal(sanitizeMarkdownTableCell(null, 20), "");
    assert.equal(sanitizeMarkdownTableCell(undefined, 20), "");
    assert.equal(sanitizeMarkdownTableCell(42, 20), "42");
    assert.equal(sanitizeMarkdownTableCell(false, 20), "false");
  });

  test("truncates after escaping so rendered table cells stay bounded", () => {
    assert.equal(sanitizeMarkdownTableCell("@team-alpha", 8), "&#64;...");
    assert.equal(sanitizeMarkdownTableCell("abc|def", 5), "ab...");
  });
});
