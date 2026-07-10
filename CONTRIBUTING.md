# Contributing

This guide defines the repository workflow for human contributors and agents.

## Development Workflow

1. Create a branch for the change.
2. Keep edits focused on the requested behavior or documentation.
3. Run the narrowest relevant validation before committing.
4. Commit with a conventional commit message.
5. Open a pull request with a matching conventional title and a clear validation summary.

## Commits

Use Conventional Commits for every commit:

```text
<type>(<scope>): <description>
```

The scope is optional. Use lowercase for the type and scope. Keep the description imperative, concise, and under 72 characters when practical.

Accepted types:

- `feat`: user-visible feature
- `fix`: bug fix
- `docs`: documentation-only change
- `test`: test-only change
- `refactor`: behavior-preserving code change
- `perf`: performance improvement
- `build`: build, dependency, or packaging change
- `ci`: CI configuration change
- `chore`: maintenance change that does not fit another type

Examples:

```text
docs: normalize documentation publishing structure
fix(github): handle missing PR labels
test(sync): cover failed context persistence
```

Avoid vague subjects such as `update stuff`, `fix`, or `misc changes`.

## Pull Requests

Use a conventional title that matches the primary commit or the net effect of the PR:

```text
docs: normalize documentation publishing structure
```

The PR description should include:

- What changed.
- Why it changed.
- Validation performed.
- Known follow-up work or intentionally excluded files.

Draft PRs are appropriate while validation, review, or scope confirmation is still pending.

## Validation

Run checks that match the changed surface:

- App: `npm run ci`
- Typecheck only: `npm run typecheck`
- Tests only: `npm test`
- Public docs markdown: `npm run markdownlint`
- Site: `cd site && npm run build`
- Design docs: `docuchango validate --verbose`

If a relevant check cannot be run, mention that in the PR description with the reason.
