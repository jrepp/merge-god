/**
 * Port of tests/test_all.py.
 *
 * Re-imports the ported .test.ts files so that `node --import tsx --test
 * tests/test_all.ts` exercises the full suite through Node's built-in test
 * runner. Referenced by merge-god.ts `test` command.
 *
 * (git_ops / state_tracker tests were removed: those modules were deleted when
 * merge-god swapped onto the @merge-god/github-sync library, whose own test
 * suite under packages/github-sync/tests/ covers GitClient + SyncEngine.)
 */

import "./imports.test";
import "./fixes.test";
import "./stores.test";
import "./agent_flow.test";
