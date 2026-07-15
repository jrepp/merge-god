import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  parseRepositoryIdentity,
  repositoryIdentityMatches,
} from "../repository_identity_model";

describe("repository identity", () => {
  test("parses browser, clone, enterprise shorthand, and owner/repo forms", () => {
    assert.deepEqual(parseRepositoryIdentity("https://github.ibm.com/meridian/devtools/pulls"), {
      host: "github.ibm.com",
      name_with_owner: "meridian/devtools",
    });
    assert.deepEqual(parseRepositoryIdentity("git@github.ibm.com:meridian/devtools.git"), {
      host: "github.ibm.com",
      name_with_owner: "meridian/devtools",
    });
    assert.deepEqual(parseRepositoryIdentity("github.ibm.com/meridian/devtools"), {
      host: "github.ibm.com",
      name_with_owner: "meridian/devtools",
    });
    assert.deepEqual(parseRepositoryIdentity("meridian/devtools"), {
      host: null,
      name_with_owner: "meridian/devtools",
    });
  });

  test("matches owner/repo case-insensitively and enforces a supplied host", () => {
    const actual = parseRepositoryIdentity("https://github.ibm.com/meridian/devtools")!;
    assert.equal(repositoryIdentityMatches(actual, parseRepositoryIdentity("MERIDIAN/DEVTOOLS")!), true);
    assert.equal(
      repositoryIdentityMatches(actual, parseRepositoryIdentity("github.com/meridian/devtools")!),
      false,
    );
  });
});
