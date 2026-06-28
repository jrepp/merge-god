---
title: Prompt example
description: A complete, real example of the prompt merge-god generates and passes to the agent.
group: Reference
order: 20
---

This is an example of the comprehensive prompt that merge-god gathers and publishes to the coordination API for pi (via the `merge-god` extension) to process.

---

## PR #123: Add user authentication feature

**Author**: johndoe
**Branch**: feature/user-auth → main
**URL**: <https://github.com/org/repo/pull/123>

## PR Description

This PR implements user authentication using JWT tokens. It includes:

- Login endpoint with email/password
- Token generation and validation
- Protected route middleware
- User session management

## PR Statistics

- **Files changed**: 8
- **Additions**: +342
- **Deletions**: -15

## ⚠️ Merge Conflicts Detected

This PR has merge conflicts with main. You MUST resolve these conflicts:

- `src/server.ts`
- `src/middleware/auth.ts`

## CI/CD Status

- **Total checks**: 4
- **Passed**: ✅ 1
- **Failed**: ❌ 2
- **Pending**: ⏳ 1
- **Skipped**: ⏭️ 0

### Failed Checks (MUST FIX)

- **test / unit-tests**: FAILURE
  - Details: <https://github.com/org/repo/runs/12345>
- **lint / eslint**: FAILURE
  - Details: <https://github.com/org/repo/runs/12346>

## Review Status

⚠️ **CHANGES_REQUESTED**

## Code Review Comments (MUST ADDRESS)

These are inline code review comments that require your attention:

### Review Comment 1

**File**: `src/middleware/auth.ts` (line 42)
**Author**: janedoe

The token expiration should be configurable rather than hardcoded. Consider adding this to environment variables.

### Review Comment 2

**File**: `src/routes/login.ts` (line 28)
**Author**: janedoe

Missing rate limiting on the login endpoint. This could be vulnerable to brute force attacks. Please add rate limiting middleware.

### Review Comment 3

**File**: `src/middleware/auth.ts` (line 15)
**Author**: bobsmith

Should we add logging here for failed authentication attempts? Would be useful for security auditing.

## Discussion Comments

### Comment 1

**Author**: janedoe

Overall this looks good! Just a few security concerns to address before we can merge. Also please resolve the merge conflicts with main - there were some updates to the server setup.

### Comment 2

**Author**: johndoe

Thanks for the review! I'll address the rate limiting and config issues today.

## Changed Files

- ✨ `src/middleware/auth.ts` (+85/-0)
- ✨ `src/routes/login.ts` (+62/-0)
- ✨ `src/routes/logout.ts` (+28/-0)
- 📝 `src/server.ts` (+45/-10)
- 📝 `src/types/user.ts` (+18/-2)
- 📝 `package.json` (+3/-1)
- 📝 `package-lock.json` (+95/-2)
- ✨ `tests/auth.test.ts` (+106/-0)

## Commit History

- `a1b2c3d` Add logout endpoint
- `e4f5g6h` Implement JWT token validation
- `i7j8k9l` Add login endpoint with JWT generation
- `m0n1o2p` Add auth middleware for protected routes
- `q3r4s5t` Add user types and interfaces
- `u6v7w8x` Initial auth setup and dependencies

---

## Your Mission

Get this PR merged successfully by completing ALL of the following:

1. **RESOLVE MERGE CONFLICTS** - This is CRITICAL and must be done first
2. Checkout the PR branch: `feature/user-auth`
3. Sync with `main` (fetch and merge/rebase)
4. Address ALL 3 code review comments with appropriate changes
5. Fix ALL 2 failing CI checks
6. Run tests and checks locally to verify everything passes
7. Push changes back to `feature/user-auth`
8. Verify CI passes on GitHub after pushing

## Project Guidelines

Follow these PR and contribution guidelines:

```markdown
# Contributing Guidelines

## Code Style
- Use TypeScript strict mode
- Follow ESLint configuration
- 100% test coverage for new features
- Meaningful commit messages following conventional commits

## Security
- Never commit secrets or credentials
- Always validate user input
- Use parameterized queries for database operations
- Implement rate limiting on authentication endpoints

## Pull Requests
- Keep PRs focused and under 500 lines when possible
- Include tests for all new functionality
- Update documentation as needed
- Respond to all review comments before requesting re-review
```

## Critical Rules

- ❌ **NO assistant branding** in commits, comments, or code
- ✅ Write clear, professional commit messages matching project style
- ✅ Make focused, minimal changes addressing specific issues only
- ✅ Test thoroughly before pushing
- ✅ Respond to review comments on GitHub when appropriate
- ✅ If blocked, clearly document the issue and what's needed

## Execution

Work autonomously through all tasks. Report progress and any blockers.
