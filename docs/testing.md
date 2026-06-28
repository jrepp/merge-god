---
title: Testing
description: Run, write, and understand the merge-god test suite.
group: Project
order: 21
---

## Run the tests

```bash
# full suite (what CI runs): tsc --noEmit + node --test
npm run ci

# typecheck only
npm run typecheck     # = npx tsc --noEmit

# tests only
npm test              # = node --import tsx --test tests/*.test.ts

# a single file
node --import tsx --test tests/stores.test.ts

# a single test (name filter)
node --import tsx --test tests/state_tracker.test.ts --test-name-pattern="state tracker"

# verbose
node --import tsx --test tests/*.test.ts
```

Or via the CLI: `npx tsx merge-god.ts test`.

## What lives in `tests/`

| Area | Files |
| --- | --- |
| Stores | `stores.test.ts` |
| Agent flow / integration | `agent_flow.test.ts` |
| Imports / smoke | `imports.test.ts`, `fixes.test.ts`, `test_all.ts` |
| Process validation | `validate_process_flow.ts` |

Tests use the built-in Node.js test runner (`node:test`) and are executed
through `tsx` so they can import the `.ts` sources directly.

## Writing a test

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { SyncStore } from "@merge-god/github-sync";

test("save and load PR context", async (t) => {
  // Arrange
  const db = new SyncStore(t.mock.tmpdir + "/test.db");
  await db.initialize();

  // Act
  await db.savePrContext(/* ... */);
  const result = await db.getPrContext(/* ... */);

  // Assert
  assert.ok(result);
});
```

Node's built-in `node:test` provides test grouping, mocking, and async
support out of the box (no extra test framework or plugins needed).

## Agent testing

For end-to-end agent runs and evaluation, see [agent-testing.md](./agent-testing.md) — it covers the database-caching and
agent-evaluation workflow in depth.
