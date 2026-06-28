import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { detectForge, inferKindFromHost } from "../src/forge/detect";
import { ForgeKind } from "../src/models";

describe("detectForge", () => {
  test("GitHub SSH", () => {
    const id = detectForge("git@github.com:owner/repo.git");
    assert.equal(id.kind, ForgeKind.GITHUB);
    assert.equal(id.owner, "owner");
    assert.equal(id.repo, "repo");
    assert.equal(id.slug, "owner/repo");
    assert.equal(id.host, "github.com");
  });

  test("GitHub HTTPS", () => {
    const id = detectForge("https://github.com/owner/repo");
    assert.equal(id.kind, ForgeKind.GITHUB);
    assert.equal(id.slug, "owner/repo");
  });

  test("strips trailing .git", () => {
    const id = detectForge("https://github.com/owner/repo.git");
    assert.equal(id.repo, "repo");
    assert.equal(id.slug, "owner/repo");
  });

  test("Codeberg routes to CODEBERG kind", () => {
    const id = detectForge("git@codeberg.org:owner/repo.git");
    assert.equal(id.kind, ForgeKind.CODEBERG);
    assert.equal(id.host, "codeberg.org");
  });

  test("GitLab nested groups keep full slug, owner=first, repo=last", () => {
    const id = detectForge("https://gitlab.com/group/sub/project");
    assert.equal(id.kind, ForgeKind.GITLAB);
    assert.equal(id.owner, "group");
    assert.equal(id.repo, "project");
    assert.equal(id.slug, "group/sub/project");
  });

  test("self-hosted Gitea via kind hint", () => {
    const id = detectForge("https://gitea.example.com:3000/org/repo.git", { kind: ForgeKind.GITEA });
    assert.equal(id.kind, ForgeKind.GITEA);
    assert.equal(id.owner, "org");
    assert.equal(id.repo, "repo");
  });

  test("inferKindFromHost heuristics", () => {
    assert.equal(inferKindFromHost("github.com"), ForgeKind.GITHUB);
    assert.equal(inferKindFromHost("codeberg.org"), ForgeKind.CODEBERG);
    assert.equal(inferKindFromHost("gitlab.com"), ForgeKind.GITLAB);
    assert.equal(inferKindFromHost("gitlab.company.internal"), ForgeKind.GITLAB);
    assert.equal(inferKindFromHost("gitea.company.internal"), ForgeKind.GITEA);
  });

  test("throws on unparseable URL", () => {
    assert.throws(() => detectForge("not-a-url-with-no-path"));
  });
});
