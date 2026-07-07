import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { recordLinkUrlCandidates } from "../link_url_model";

describe("link URL model", () => {
  test("extracts URL candidates from cached links and _links maps", () => {
    assert.deepEqual(
      recordLinkUrlCandidates({
        links: {
          html: { href: "links:html" },
          web: "links:web",
          self: { url: "links:self" },
          pullRequest: { html_url: "links:pull-request" },
        },
        _links: {
          merge_request: { webUrl: "links:merge-request" },
          browser: { permalink: "links:browser" },
          api: { uri: "links:api" },
          web_url: "links:web-url",
        },
      }),
      [
        "links:html",
        "links:web",
        "links:self",
        "links:pull-request",
        "links:merge-request",
        "links:browser",
        "links:api",
        "links:web-url",
      ],
    );
  });

  test("flattens array-shaped cached link values", () => {
    assert.deepEqual(
      recordLinkUrlCandidates({
        links: [
          { href: "links:array-href" },
          { html_url: "links:array-html" },
          "links:array-string",
        ],
        _links: {
          html: [
            { href: "links:html-array-href" },
            "links:html-array-string",
          ],
          pull_requests: [{ url: "links:pull-requests-array" }],
          mergeRequests: [{ webUrl: "links:merge-requests-array" }],
        },
      }),
      [
        "links:array-href",
        "links:array-html",
        "links:array-string",
        "links:html-array-href",
        "links:html-array-string",
        "links:pull-requests-array",
        "links:merge-requests-array",
      ],
    );
  });
});
