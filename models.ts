/**
 * Data models for branch and PR tracking.
 *
 * Re-exports the canonical, forge-neutral models from the dedicated
 * @merge-god/github-sync library. merge-god no longer maintains its own copy;
 * the library is the single source of truth for PullRequest / Branch / CICheck /
 * RepositoryState and the query helpers around them.
 */

export * from "@merge-god/github-sync";
