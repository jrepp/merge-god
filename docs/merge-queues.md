---
title: Agent-managed merge queues
description: How merge-god models aggregate queue PRs, lineage, blockers, and validation evidence.
group: Guides
order: 13
---

An agent-managed merge queue is an integration PR that represents several
source PRs merged into one queue branch. It is different from a normal PR:
success depends on the queue head, the constituent PR lineage, the conflict
resolutions between them, and the validation evidence for each affected area.

## Domain model

merge-god records queue-specific context alongside the normal PR context:

| Field | Meaning |
| --- | --- |
| `queue_context.is_queue` | Whether the PR is treated as an aggregate queue PR. |
| `queue_context.constituent_prs` | Source PR numbers, status, and available title, URL, and head SHA hints inferred from the title, body, issue comments, review comments, or merge commits. |
| `queue_context.merge_commits` | Merge commits that brought source PRs or the base branch into the queue, including conflict-file hints when present. |
| `queue_context.validation_evidence` | Commands, outcomes, and available scopes extracted from operator/agent status comments. |
| `merge_blockers` | Draft state, review, CI, conflict, diff, mergeability, or merge-state blockers still preventing landing. |
| `diff_availability` | Whether the full diff was captured, and why not if unavailable. |

This model lets merge-god keep the durable state machine separate from GitHub
comments. Comments can summarize the queue for humans, but merge decisions
should use stored context, trajectory events, and validation artifacts.

## Queue processing expectations

For a queue PR, the agent should:

1. Preserve per-PR lineage when resolving conflicts.
2. Record which conflict files were resolved and why a side was kept.
3. Validate the queue head with commands that cover the changed areas.
4. Record scoped validation evidence when a command covers one constituent PR
   or one package path rather than the whole queue.
5. Record skipped or blocked gates with concrete reasons.
6. Stop at human gates such as required review, missing credentials, or product
   judgment.

The first supported slice is queue-aware context gathering. merge-god now
detects queue-like PRs, records blockers, and preserves full paginated PR
metadata even when the forge refuses to return an oversized diff. The review
gate status comment also projects constituent status, merge commits, historical
merge-commit conflict-file hints, active merge-tree conflict files, validation
evidence, diff availability, and CI check details from the same stored context.
If active conflict detection reports conflicts but cannot enumerate files or a
conflict count, the model and cache report the count as unavailable rather than
claiming there are `0` conflicted files. A shared pure conflict model normalizes
merge blocker, review-gate, evidence-comment counts, and active conflict summary
details: if an explicit conflict count is lower than the enumerated file list,
the model uses the listed file count so the cache does not understate known
conflict evidence. Listed conflict files are counted after trimming file names,
dropping empty values, and deduplicating. GitHub review decisions are normalized
by a shared pure helper before blocker and gate classification, so
whitespace-padded forge payloads do not become unknown states. Review-gate status
aliases are normalized by a pure gate model before comments render them, keeping
gate projection independent of the comment renderer. Merge-state strings are
also normalized by a pure helper before blocker classification, with
`mergeable: false` used as a fallback only when GitHub reports a clean or absent
merge-state status.
Failed and pending CI checks include names and details URLs when the forge
provides them, including cached `details_url`, `detailsUrl`, `target_url`,
`targetUrl`, `html_url`, and `url` aliases. Checks that
cannot be classified as passed, failed, pending, or skipped are preserved as
`unknown` instead of being treated as passing. CI check names, states,
conclusions, and detail URLs are trimmed before classification and rendering;
blank names render as `unknown`, and blank detail URLs are omitted from evidence
refs. CI blockers use concrete failed, pending, or unknown check detail URLs as
evidence refs when they are available; if cached counts prove additional
non-passing checks without per-check URLs, the blocker keeps
`github:statusCheckRollup` as a fallback audit ref. CI evidence-comment details
are built by the pure CI status model before the comment renderer escapes the
final table cell. Cached numeric CI counts are treated as non-negative integers before
blockers, gates, or comments use them, so malformed negative counts do not
produce negative evidence summaries or false passing states. Merge blockers,
review-gate rows, and evidence comments all consume the same pure CI state helper
for failed, pending, unknown, passing, and missing rollups. Cached detail arrays
such as `failed_checks`, `pending_checks`, and `unknown_checks` also set minimum
counts so a zero count cannot hide listed non-passing checks. Cached raw
`statusCheckRollup` / `status_checks` payloads are also used when a stored CI
summary only reports zero checks, so a placeholder summary cannot hide raw
failed or pending checks from blockers, gates, prompts, or evidence comments.
Status-check rollups may be arrays, direct edge arrays, `nodes` connections, or
`edges[].node` connections at the gatherer and replay boundaries.
Blank canonical status-check rows do not mask later useful rollup aliases with a
check name, status, conclusion, or details URL.
The comment also includes a bounded evidence-reference summary for quick
inspection, but those refs remain a cache projection rather than the source of
truth. Full multi-PR queue execution and automatic final merge are separate
follow-up work.

When queue membership is declared in the PR body, issue comments, or review
comments rather than the title or merge commits, merge-god records the strategy
as `manual`. It also recognizes merge-batch titles such as
`Merge PRs #201 and #202`, `Merge pull requests #201 through #204`,
`Merge MRs !201-!204`, `Merge requests !201 through !204`, or
`Merge train MRs !201 to !204` as queue titles. Bounded title ranges such as
`Merge queue: PRs #201-#204`, `Merge queue: PRs 201-204`,
`Merge PRs 201 through 204`, `Pull requests queue #201-#204`, or
`MR train !201-!204` are expanded into the individual constituent PRs. Long
comma-separated queue titles such as `RC1 Merge queue: PRs 178, 179, 180, ...`
are also modeled without dropping later constituents from the rendered queue
summary. Very broad ranges are not expanded, but their explicit endpoints are
still retained as title evidence. Manual membership hints
are extracted only from visible authoritative body, issue-comment, and
review-comment text; copied logs, HTML comments, HTML `<details>` or `<pre>`
blocks, Markdown blockquotes, fenced code blocks, and fully struck-through lines
are ignored. Manual hints may be simple list items such as `- #201 API work` or
`- MR !202 Release work`, or Markdown table rows under a constituent-shaped
header such as `PR`, `MR`, `Pull request`, or `Constituent PR`. Unrelated
status, failure-summary, and evidence tables do not define constituents, even
when a row contains numeric counts or links to other repository PRs. Constituent
tables may include optional title and head SHA cells. Only title-like columns
such as `Title`, `Name`, `Summary`, `Subject`, `Purpose`, or `Description`
supply constituent titles; `Merge commit`, `Commit`, `Evidence`, `Notes`, or
rationale cells are retained as provenance but do not become titles. Markdown
links whose labels are descriptive, such as `[API work](https://.../pull/201)`,
use the label as a title fallback; when a table row has a separate title cell,
that explicit title wins over the link label. Long-form labels such as
`Pull Request #203` or `Merge Request !204` are normalized the same way as
short `PR #203` and `MR !204` hints.
For comment-sourced evidence, blank `html_url` values are ignored so a later
non-blank `url` can still be used as the provenance ref.
Self-referenced validation provenance recognizes GitHub `/pull/` and `/pulls/`
URLs as well as GitLab `/-/merge_requests/` URLs, so validation captured from
constituent PR or MR discussion can still contribute membership evidence across
supported forge URL shapes. Repo-qualified shorthand such as
`meridian/web#201` or `group/subgroup/repo!202` is also normalized when it
appears in constituent hints or validation scopes.

Generic product words such as `queue`, `batch`, or `stack` are not enough by
themselves to classify a normal PR as an aggregate queue. Those words only allow
manual constituent hints in the body or comments to be considered. A PR is
classified as a queue when it has explicit queue title evidence, multiple
constituent PRs, or merge commits that show aggregate lineage. A singular title
such as `Merge PR #201` is not treated as a queue by itself; the title must
carry aggregate evidence such as `Merge PRs #201 and #202` or another queue
signal. When title, body, comments, or merge commits already declare queue
membership, unrelated PR-scoped validation evidence is retained in
`queue_context.validation_evidence` for auditability but does not add new
constituent PRs or blockers. Validation scoped to the queue PR itself is
normalized as queue-wide validation so the aggregate PR is not counted as one of
its own constituents. If an explicit queue title declares an aggregate queue but
does not list constituent PRs, scoped PR validation evidence can seed the
constituent list, including a one-constituent queue, so operator-written
validation-only queue summaries still produce auditable per-PR state. When declared constituents already exist,
additional scoped validation can add a constituent only when its evidence ref
proves the same PR through a PR/MR URL or a durable ref such as `pr:#201`,
`pull_request:201`, or `merge_request:!202`; mismatched refs are retained as
audit evidence but do not define membership.

Merge commit lineage recognizes standard GitHub merge subjects such as
`Merge pull request #201 from owner/branch` and GitLab-style merge request
subjects or trailers such as `Merge MR !201`, `Merge request !202`,
`Merge merge request !203`, or `See merge request org/repo!204` on a merge-shaped
commit. Azure-style completed merge subjects such as `Merged PR 205` or
`Merged merge request !206` are also recognized when the PR/MR number appears at
the start of the subject. When the title already has queue context, squash-style
GitHub or GitLab subjects such as `Add API bridge support (#201)` or
`Refresh UI shell (!202)` are also treated as constituent PR lineage. Without
queue context, parenthesized numbers in commit subjects are ignored so ordinary
issue references do not create a false queue model. Queue-head base-branch merge
subjects such as
`Merge origin/main into ...`, `Merge branch 'main' into ...`, or
`Merge remote-tracking branch 'origin/main' into ...` are retained as merge
commit evidence without assigning them to a constituent PR. Remote-qualified
base merges such as `Merge branch 'main' of github.example.test:org/repo into ...`
are treated the same way. The model prefers the paginated commit list from
gathered PR context, but falls back to PR-detail commit nodes when the paginated
list is unavailable. Visible comment or review-comment tables with PR/MR and
`Merge commit` / `Commit` / `SHA` columns are used as a second fallback before
PR-detail commits, so operator-authored queue comments such as
`| PR | Merge commit | Notes |` can still mark constituents as
`merged_into_queue` and render merge-commit evidence. Queue-targeted prose such
as `merging #189 and #194 into this queue branch` also marks those constituents
as merged and keeps the comment URL as provenance, while ordinary queue-head
references or non-queue merge notes do not change constituent status. Both
`nodes` and GraphQL-style `edges[].node` commit collections are accepted. When paginated
context commits and comment merge-commit tables are unavailable, cached PR
detail commit aliases such as `commitNodes`, `commit_nodes`, `commitEdges`, and
`commit_edges` can provide the same fallback lineage. Blank canonical
PR-detail commit rows do not mask later detail commit aliases with a usable
message, identifier, or conflict-file evidence, and PR-detail commit rows with
only durable evidence refs are retained when those refs can supply commit and
PR/MR lineage. Normalized commit shapes such as `message`,
`commit_message`, `commitMessage`, `full_message`, `fullMessage`,
`messageHeadline`, `message_headline`, `headline`, `subject`, `title`,
`messageBody`, `message_body`, `body`, `sha`, `oid`, and `id` are accepted. Commit
identifier fields are trimmed before evidence refs are created; blank IDs are
treated as missing and later non-blank `oid` or `id` fields may be used instead.
Blank commit message fields are also treated as missing so normalized
headline / body fallbacks can still provide lineage. Cached
queue evidence comments apply the same commit identifier fallback when rendering
merge-commit summaries and evidence refs, so stored rows with `oid`, `id`, or
nested commit identifiers do not degrade to `unknown` when `sha` is absent.
When a merge-commit row has a merge subject but lacks raw identifier fields, an
explicit `commit:<id>` evidence ref can also supply the modeled merge commit
identifier. If the subject does not name the constituent PR, explicit numeric
fields such as `prNumber`, `pullNumber`, or `mergeRequestIid`, PR/MR URLs, or
durable refs such as `pr:#201` and `merge-request:!202` can supply the modeled
constituent number for that merge-commit row.
GitLab merge-request trailers are recognized when cached payloads split the
merge subject and body across headline/body aliases.
Cached constituent, merge-commit, comment, validation, blocker, and lineage
records can also use `links` or `_links` maps with `html`, `web`, `self`,
`pullRequest`, `pull_requests`, `mergeRequest`, `merge_requests`, `browser`, or
`api` entries whose values are strings, objects, or arrays of strings/objects
with `href`, `url`, `html_url`, `web_url`, `permalink`, or `uri` fields. These
link-map URLs are used as fallback evidence refs and, when they are pull-request
or merge-request URLs, can provide cached PR/MR numbers.
Cached merge-commit conflict-file hints accept `conflict_files`,
`conflictFiles`, `conflicting_files`, `conflictingFiles`, `conflict_file`,
`conflictFile`, `conflicting_file`, and `conflictingFile` aliases before
deduping and rendering the queue conflict-file summary.
Cached constituent rows accept `head_sha`, `headSha`, `head_oid`, `headOid`, and
nested `head` / `headCommit` identifiers as head-commit hints. They also accept
`name`, `summary`, `subject`, or `label` as title aliases, and `state`,
`queueStatus`, `validationStatus`, or `conclusion` as status aliases. Evidence
reference summaries accept singular `evidence_ref` / `evidenceRef`,
`comment_ref` / `commentRef`, and `source_ref` / `sourceRef` fields or array
`evidence_refs` / `evidenceRefs`, `comment_refs` / `commentRefs`, and
`source_refs` / `sourceRefs` on cached queue rows. URL-style fallback refs also
accept `target_url` / `targetUrl` and `details_url` / `detailsUrl`, matching
common status-check adapter payloads outside the dedicated CI model. Cached constituent and
merge-commit rows also accept numeric PR/MR aliases such as `prNumber`,
`pullNumber`, `mergeRequestNumber`, `mrNumber`, and `mrIid` when rendering
constituent and merge-commit summaries;
non-numeric string values still render as `unknown` or are omitted rather than
being coerced. Cached constituent, merge-commit, and validation rows that only
contain explicit provenance refs are still retained as meaningful rows, so audit
links are not replaced by later aliases just because display fields are absent.
Cached queue contexts also accept `isQueue`, `constituentPrs`,
`mergeCommits`, `validationEvidence`, and `unresolvedBlockers` aliases at the
queue-context boundary. Serialized queue booleans such as `isQueue: "true"` or
`is_queue: "yes"` are normalized before deciding whether to render merge-queue
evidence; recognized false values still suppress queue rendering and queue-only
evidence refs. Non-decisive canonical queue-context records with only blank or
malformed queue fields do not mask later useful queue-context aliases. If a
cached queue context omits the boolean flag, a recognized queue strategy or
populated queue collections still render the merge-queue evidence section. CamelCase
strategy or status tokens such as `mergeCommits`, `commit history`, or
`mergedIntoQueue` normalize to the same display labels as their canonical
snake_case forms. Cached strategy fields can also use `queueStrategy`,
`mergeStrategy`, or `strategyLabel`; blank canonical strategy values do not mask
non-empty aliases.
When an adapter stores queue fields directly on the PR context rather than under
`queue_context`, the same queue aliases are synthesized into a durable
queue-context projection before evidence comments or evidence refs read them.
Top-level cached PR context fields accept `ciStatus`, `diffAvailability`,
`mergeConflicts`, `mergeBlockers`, `blockers`, and `queueContext` aliases when
building the non-authoritative review-gate evidence summary, classifying modeled
blockers, projecting review-gate status rows, and rendering agent prompts. Empty
canonical top-level records do not mask non-empty alias records. Blank canonical
`merge_blockers` rows do not mask useful `mergeBlockers` aliases, while explicit
unknown blocker rows remain non-passing evidence. Nested cached CI fields such as
`totalChecks`, `totalCount`, `failedCount`, `pendingCount`, `unknownCount`,
`passedCount`, `skippedCount`, `failedChecks`, `pendingChecks`, and
`unknownChecks` also count toward CI blockers and evidence rows. Zero-valued
canonical count placeholders do not understate non-zero aliases or detail
arrays. Nested cached conflict fields such as
`hasConflicts`, `conflictCount`, `conflict_files`, `conflictFiles`,
`conflictingFiles`, `conflictingFile`, `conflictFile`, and `evidenceRefs` are
normalized before conflict blockers, gate rows, evidence rows, and evidence-ref
selection are rendered. Plural conflict-file aliases may be direct arrays,
scalar `nodes`, record `nodes`, or `edges` collections. Zero-valued
canonical conflict count placeholders do not understate non-zero aliases or
listed files. Serialized active conflict flags such as `hasConflicts: "true"`
or `has_conflicts: "yes"` are normalized before deciding whether conflict
evidence is active, and unrecognized canonical conflict flags do not mask a
later decisive top-level `mergeConflicts` record. Cached diff availability rows
accept `isAvailable`, `diffAvailable`, `captured`, `hasDiff`, `provider`,
`byteSize`, `bytes`,
`diffSize`, `errorMessage`, `message`, and reason/detail aliases before diff
blockers and evidence rows are rendered. Diff availability blocker and evidence
refs accept the shared evidence-ref URL aliases and link maps; if an unavailable
diff has no explicit ref, `gh:pr-diff` is used as the fallback audit ref. Blank
or unrecognized canonical availability tokens do not mask useful availability
aliases, including later top-level `diffAvailability` records, and zero-valued
canonical size placeholders do not understate non-zero size aliases. Cached
replay logs keep this modeled diff status separately from the raw `has_diff`
text flag, so an unavailable diff with a concrete reason is not reported as
merely absent context.

PR-detail and discussion signals that do not have dedicated review-gate rows are
synthesized through the shared PR merge-blocker model before gate rows, live
evidence comments, PR prompts, and agent replay context are rendered. That
includes draft state, blocking labels, manual gate comments, merge-state
blockers, and unavailable diff blockers. CI, review-decision, and
active-conflict signals stay in their dedicated gate and evidence rows even when
a gathered context has also persisted them in `merge_blockers`, so the cache
stays evidence-rich without duplicating the same failure in multiple sections.
Agent prompts and cached agent replay context use the same top-level blocker
projection: supplemental blockers remain in the merge blocker section, while
conflicts, CI, and review decision continue through their dedicated prompt
sections and task fields. Cached CI-unknown blocker rows are also treated as
dedicated CI blockers when they use `ci_unknown` or carry the shared
`github:statusCheckRollup` evidence ref, and common cached summaries such as
`CI checks could not be classified` or `Status checks could not be normalized`
are recognized as dedicated CI evidence. Details-aware evidence comments,
review-gate projection, PR prompts, and agent replay context also infer missing
queue context from the same pure merge PR model before rendering, while an
explicit cached non-queue context continues to suppress queue evidence.

Cached blocker rows accept `type`,
`category`, `rule`,
or `name` for kind, `state`, `result`, `outcome`, or `conclusion` for status,
and `message`, `description`, `detail`, or `reason` for summary before modeled
blocker gates and evidence comments are rendered. Dedicated blocker filtering
normalizes kind values for case, spaces, and hyphens before rendering or
classifying cached CI, review, and conflict rows. Duplicate modeled blockers are
deduped by their display identity with normalized kind spelling and collapsed
summary whitespace, but their durable evidence refs are merged so a cached
blocker row without refs cannot hide refs synthesized from PR details, labels,
or comments.
Flat `blockers` are treated as top-level modeled blockers unless the same PR
context object has a true queue flag, a recognized queue strategy, or other
flattened queue-context payload.
Cached PR context collections also accept `issueComments` /
`issue_comments`, `reviewComments`, `commitNodes` / `commit_nodes`,
`commitEdges` / `commit_edges`, `changedFiles` / `changed_files`, and
`fileNodes` / `file_nodes` / `fileEdges` / `file_edges` aliases
for queue inference and agent replay.
These collections may be plain record arrays, direct GraphQL edge arrays such as
`{ node: ... }` with optional edge metadata, `nodes` connection objects, or
GraphQL-style `edges[].node` connection objects. Empty canonical arrays do not
mask non-empty alias arrays, so cached review comments can still provide
validation evidence and cached commit nodes or commit edges can still provide
merge-commit lineage. Cached comment records accept body aliases such as
`bodyText`, `body_text`, `text`, `content`, `description`, and `message`, plus
URL aliases such as `htmlUrl`, `webUrl`, `web_url`, `permalink`, and `uri`, plus
`links` / `_links` maps, for constituent hint and validation evidence refs.
If a constituent-hint comment has no durable URL, source ref, or explicit
evidence ref, the extracted hint uses `github:pr-comment` as a stable fallback
evidence reference.
Blank canonical comment rows do not mask later useful comment aliases, blank
canonical commit rows do not mask later commit aliases with a usable message or
identifier or conflict-file evidence, and blank canonical file rows do not mask
later changed-file aliases with a usable path. Empty or null direct entries,
empty direct records, and primitive direct placeholders are ignored before
deciding whether a cached collection has usable data. Empty or null connection
nodes are ignored too.
Blank canonical `merge_blockers` rows also do not mask useful flat `blockers`
rows outside queue-scoped payloads, and blank flat `blockers` rows are not
added to synthesized unresolved queue blockers when queue blocker aliases
already carry useful blocker records.
Replay validation uses the same alias groups, so a primitive placeholder in one
collection field does not reject a cache row when a later alias carries a valid
array or connection object.
Stored `queue_context` collections follow the same collection-shape rules for
`constituentPrs`, `mergeCommits`, `validationEvidence`, and
`unresolvedBlockers`, so replayed queue evidence can render from cached GraphQL
connection objects or direct edge arrays such as `{ node: ... }` with optional
edge metadata without degrading to empty queue summaries. Blank canonical queue
collection rows do not mask later useful queue aliases with constituent IDs or
status, merge-commit identifiers or messages, validation command / status /
scope fields, or unresolved-blocker details.
Stored constituent rows accept numeric string IDs, GitLab-style `iid` /
`merge_request_iid` aliases, and PR/MR URL fields such as `web_url` or
`html_url` when rendering constituent numbers. If a constituent row has an ID
but no explicit or URL-shaped provenance ref, evidence comments synthesize a
stable `pr:#<number>` ref for that row. Stored merge-commit rows accept PR/MR
number aliases such as `prNumber`, `pullNumber`, `mergeRequestNumber`,
`mrNumber`, `merge_request_iid`, and `mr_iid`.
Cached PR detail records may use either GitHub GraphQL-style names or normalized
forge names. `number` / `pr_number` / `prNumber` / `mrNumber` / `mrIid`,
`title` / `name`,
`body` / `description`, `commits` / `commitNodes` / `commit_nodes`,
`reviewDecision` / `review_decision`,
`mergeStateStatus` / `merge_state_status`, `isDraft` / `is_draft` / `draft`,
and `baseRefName` / `base_branch` are normalized before queue inference,
blocker classification, review-gate status projection, and queue-head
base-branch merge evidence modeling. String numeric PR numbers are accepted for
the aggregate PR so self-scoped validation can still be normalized to
queue-wide evidence during cache replay. Blank canonical review-decision and
merge-state text does not mask non-empty aliases. Unknown or unrecognized
canonical review-decision and merge-state placeholders do not mask later
decisive aliases such as `review_decision: "changes requested"` or
`merge_state_status: "dirty"`.
Serialized booleans such as `isDraft: "true"` and `mergeable: "false"` are
normalized before draft and mergeability blockers are modeled. Unrecognized
canonical boolean placeholders do not mask later decisive aliases such as
`is_draft: "yes"` or `is_mergeable: "not-mergeable"`.
When PR context is synced into the replay database, the compact active-PR
snapshot is also projected through a pure snapshot model. GraphQL label objects,
empty label `nodes` or `edges` connections,
cached CI aliases, conflict aliases, review-decision aliases, draft and
mergeability booleans, timestamps, branch aliases, and normalized
`conflicting_files` are persisted in the same shape that live processing expects.
Queue merge-commit conflict files may be direct arrays, scalar `nodes`, record
`nodes`, or `edges` collections, and evidence comments summarize them through
the shared conflict-file accessor instead of assuming a single adapter shape.
Cached merge-commit rows that only contain conflict-file aliases are retained so
conflict evidence is not dropped before the evidence comment renderer sees it.
Modeled merge commits preserve those conflict-file aliases and any explicit
commit evidence refs before adding synthesized `commit:<sha>` refs.
Explicit evidence refs follow the same collection boundary: scalar refs, ref
records, `nodes`, and `edges` are normalized before the review-gate comment
prioritizes and caps the rendered refs.
When cached PR context is replayed through the standalone agent runner, the
context-loaded log summary and trajectory work-item metadata use the same alias
boundary. Cached comment, review-comment, conflict, CI, label, URL, base-branch,
head-branch, and head-SHA aliases are normalized by pure access/projection
helpers before the runner performs database writes or calls the agent.
The agent-facing `PRContext` is projected through the same boundary, so replayed
camelCase cached fields such as `issueComments`, `reviewComments`,
`changedFiles`, `commitNodes`, `mergeConflicts`, `ciStatus`, `mergeBlockers`,
and `queueContext` are visible to task planning instead of being dropped by the
runner. Claude task prompts render a pure merge-gate summary from that projected
context, including deduped top-level blockers and queue-only unresolved blockers
after the same blocker identity normalization.
Cached queue contexts accept node and edge collection aliases such as
`constituentNodes`, `constituentEdges`, `mergeCommitNodes`,
`mergeCommitEdges`, `validationNodes`, `validationEdges`,
`unresolvedBlockerNodes`, and `unresolvedBlockerEdges`, plus their snake_case
forms, before evidence comments render queue constituents, merge commits,
validation rows, and unresolved blockers.
Current PR labels can also block landing when they explicitly describe a hold,
for example `do-not-merge`, `blocked-by-dependency`, `needs approval`,
`waiting-on-security`, `human gate`, `needs-rebase`, `merge conflicts`,
`ci failing`, or `failing tests`. These labels are modeled as `external_gate`
blockers with stable `github:label:...` evidence refs.
Processing labels such as `for-review` and `for-landing`, merge-god state labels
such as `merge:blocked`, and ordinary review labels such as `needs review` do
not create merge blockers by themselves.
Visible authoritative comments can also create manual merge blockers. Explicit
hold lines such as `Do not merge: release approval is required`,
`Human gate: product approval is required`, `External gate: release owner
approval required`, `merge-god: blocked - security signoff pending`, or
`Remaining RC1 decision: HOLD, not approve. Blocking items are ...` are modeled
as `external_gate` blockers. Later explicit release lines such as
`merge-god: ready`, `merge-god: cleared`, `Manual gate cleared`,
`Final RC1 decision: PASS`, or `ready to merge` clear earlier active
manual-gate blockers according to comment timestamp order. Ordinary validation
or scenario lines that only contain `PASS` do not clear manual gates unless the
line is explicitly a release or RC decision. Generated merge-god review-gate
cache comments, quoted text, copied code/log blocks, hidden HTML blocks, and
struck-through stale lines are ignored as manual gate sources.
Manual-gate blocker summaries preserve the full normalized reason in
`merge_blockers`; evidence comments may abbreviate the rendered table cell, but
the model does not truncate the source reason before storage or prompting.
Manual-gate status lines are also ignored by queue-validation parsing unless a
separate row contains a supported command such as `npm`, `pnpm`, `make`, `just`,
or another recognized validation runner. This keeps human release holds from
appearing twice as both `external_gate` blockers and failed queue validation.

Scoped validation evidence can mark individual constituents as `validated` or
`blocked` while leaving unrelated constituents queued. Failed or blocked scoped
validation is also promoted into `queue_context.unresolved_blockers`, so the
review-gate projection cannot pass while a constituent, package/path scope, or
queue-wide validation command has known failed queue evidence. Scoped validation
with an unknown outcome marks a PR-scoped constituent as `unknown` and creates an
unknown unresolved blocker for PR, package/path, or queue-wide scopes, so an
attempted but inconclusive check is not treated as unvalidated queue backlog.
If a validation comment has no durable comment URL, source ref, or explicit
evidence ref, the extracted validation row uses `github:pr-comment` as a stable
fallback evidence reference instead of dropping blocker provenance completely.

For repeated validation of the same scope and command, the latest timestamped
evidence wins. Untimestamped evidence is treated as older than timestamped
evidence, then stable source order is used as a fallback. The identity
comparison normalizes PR scopes such as `#001` and `#1`, markdown
PR links such as `[#201](...)`, raw PR URLs such as
`https://github.example.test/org/repo/pull/201`, and harmless command
differences such as `scope: #201 npm   run   test` versus `npm run test`.
Markdown links whose text is descriptive rather than numeric, such as
`[API validation](https://github.example.test/org/repo/pull/201)` or
`[MR validation](https://gitlab.example.test/org/repo/-/merge_requests/202)`,
are normalized from the linked URL.
Non-positive PR-like scopes such as `#0` are treated as queue-wide evidence
rather than valid constituent PR evidence. When
comments carry timestamps, issue comments and review comments are ordered
chronologically before latest-wins evidence is selected, with `editedAt`,
`lastEditedAt`, and updated timestamp aliases preferred over submitted,
published, or creation timestamp aliases. Blank or malformed timestamp fields
are ignored so a later parseable submitted, published, or creation timestamp can
still order the evidence. If timestamps are unavailable, the gathered order is
preserved. Raw
`queue_context.validation_evidence` still preserves the full history, while
constituent status, unresolved blockers, and the review-gate comment use the
active/latest evidence set from a shared pure validation partition. Later
comprehensive queue-wide pass evidence, such as a full deterministic validation
suite, can retire older queue-wide failed or blocked validation rows while
leaving PR-scoped and package/path-scoped blockers active until those scopes are
explicitly superseded. If active
scoped evidence is mixed, failed or blocked outcomes win first, then unknown
outcomes, and only fully passing PR-scoped evidence marks a constituent as
`validated`. The same validation severity helper orders evidence refs in the
review-gate comment, and a shared blocker model ranks/deduplicates unresolved
blockers, so blocker modeling and comment rendering do not drift. Agent prompts
also render deduped queue-only unresolved blockers after removing blockers
already shown in the top-level merge-blocker section, so cached queue replay
does not hide the reason a queue is blocked or repeat the same gate twice.

Validation evidence is extracted from issue comments and review comments when a
line contains a scoped PR reference or `scope:` hint, an outcome such as
`passed`, `failed`, or `blocked`, and either a backticked command or a command
before an arrow/colon. Status-first summaries are also supported, for example
`failed: #201 npm test`, `passed - PR #202 pnpm test --filter api`,
or `action required: https://.../pull/204 npm run manual`. Status-target
phrasing such as `passed for PR #201: npm test`,
`failed for pull request #202 - pnpm test`, `blocked for MR !203: npm run e2e`,
`failed for [API validation](https://.../pull/204): npm run api`, or
`failed for packages/api: npm run lint` is normalized the same way. Status-target
and target-status phrasing such as `PR #207 passed: npm test` or
`packages/api failed: npm run lint` are both normalized. Phrasing that names
multiple PRs, such as `failed for PR #205 and PR #206: npm run shared` or
`PR #208 and PR #209 failed: npm run shared`, is retained as queue-wide evidence
rather than being attributed to the first PR. Canceled validation is treated as
`unknown`, while timeouts are treated as failed
validation evidence. GitHub-style conclusion tokens such as `TIMED_OUT`,
`STARTUP_FAILURE`, `ACTION_REQUIRED`, `IN_PROGRESS`, `NEUTRAL`, `ERROR`, and
`EXPIRED` are normalized to the same failed or unknown validation states as
their prose equivalents. Supported scope forms include `#201`, `PR #201`, raw
PR URLs, markdown PR links such as `[#201](...)` or `[PR #201](...)`,
`scope: #201`, `scope: PR #201`, `scope: pull request #201`,
`scope: [#201](...)`, `scope: https://.../pull/201`,
`scope: https://.../pulls/201`,
`scope: https://.../-/merge_requests/201`, `MR !201`,
`scope: packages/api`, `scope: packages/@scope/name`, and
`scope=apps/mobile`. Scope values may also be wrapped in code spans, such as
``scope: `#201` `npm test` -> failed`` or
``scope: `packages/api` `pnpm test --filter api` -> passed``. Human separators
after PR scopes are normalized, so task-list rows such as
`- [x] PR #201: npm test`, `- PR #201: [x] npm test`, or
`- [ ] #202 - pnpm test --filter api` are treated as validation evidence rather
than constituent titles. Descriptive PR prefixes such as
`constituent #221`, `source PR #223`, `queue PR #224`, or `pull #225` are also
normalized as scoped validation. Inline or trailing status decorations such as
`- #203 ✅ npm run smoke`, `- #204 pnpm lint (failed)`, or
`- #205 npm test — passed` are normalized to the underlying command. `+` bullet
rows and ordered Markdown lists such as `1. #201 npm test -> passed` are
normalized the same way. Compact field summaries such as
`Scope: #206; Command: npm test; Result: passed`,
`MR: !207; Check: pnpm test; Status: passed`, or
`Merge Request: !208; Command: npm run smoke; Result: failed` are also accepted.
Those field summaries may use semicolons, commas, or pipe separators such as
`Pull Request: #209 | Command: npm run smoke | Result: failed`.
Row-level
scope prefixes or scope fields that mention multiple PRs, such as
`PR #201 and PR #202 npm test -> failed`, `PRs #201-#203 npm test -> failed`,
`PRs 201-203 npm test -> failed`, or `!204-206 npm run gitlab-range -> failed`,
are treated as queue-wide validation rather than being attributed to the first
PR reference. PR references inside the command text do not change an explicit
single-PR scope. Visible section headings can also provide fallback scope for
following validation rows,
for example `### PR #201`,
`#### Validation for pull request #202`, `### packages/api`, or
`**Pull request: #204**`. Path-like fallback headings must be a single-token
path or package name; prose headings such as `### Safari /chat validation`
reset to queue-wide instead of becoming synthetic scopes. Explicit row scopes
still win over the section fallback, queue-wide headings such as
`### Queue-wide` reset the fallback scope, ordinary Markdown headings reset any
previous fallback scope, and ambiguous headings that mention multiple PRs are
treated as queue-wide rather than being attributed to the first PR reference.
Fenced code blocks, HTML comments, inline or multi-line HTML `<details>` or
`<pre>` blocks, Markdown blockquotes, and fully struck-through rows are ignored
so pasted logs, command output, quoted stale status comments, hidden cache
metadata, or manually crossed-out old evidence do not become authoritative queue
validation evidence by accident. Fully struck-through table rows may wrap the
whole row or every meaningful table cell in `~~`. merge-god's own review-gate
cache comments are also ignored as validation and constituent-membership sources
when they carry the cache marker or the generated `merge-god review gate status`
heading, because they are explicitly non-authoritative and may be stale.
Queue-wide evidence may omit a scope, use a blank table scope cell, or use an
explicit queue-wide alias such as `scope: queue`, `scope: queue-wide`,
`scope: all`, or `scope: global`.

Simple Markdown tables are also supported when they include recognizable command
and status/result columns. Header order may vary, for example
`Command | Scope | Result`, `Result | Scope | Command`, or
`Constituent | Validation | Conclusion`. `PR`, `Pull request`, `MR`, and
`Merge request` headers are treated as scope columns. A blank scope cell is treated as
queue-wide validation evidence, even when the table appears under a PR-scoped
section heading. Tables without a scope column may inherit the current visible
section scope. Command cells may contain shell pipes inside backtick code spans
or escaped table pipes such as `\|`. Task-list checks
(`[x]`) and common status glyphs such as pass/fail/blocked icons are recognized
when they include a command. When a line uses `->`, `=>`, or a trailing colon
result marker,
merge-god reads the outcome from that result segment so command names such as
`npm run failure-report` do not get misclassified as failed.
Inline backtick/code spans are accepted as validation commands only when they
look like a known runner command (`npm`, `go`, `npx`, `just`, and similar).
This keeps commit-audit rows such as `` `9cfaa913` | fix(chat): ... failed``
and diagnostic notes such as `` `safari_browser doctor` still unavailable``
from becoming validation evidence just because the prose contains a status word.
Narrative validation tables from real queue updates are also accepted when they
have a status/result column plus a descriptive `Area`, `Flow`, `Scenario`,
`Gate`, or `Evidence` column, for example `Flow | Evidence | Result`. In those
rows the descriptive column becomes the validation label, and package/path or
PR/MR columns still provide scopes. `Blocker`, `HOLD`, and `HELD` result text
is treated as blocking validation evidence, so release-decision tables do not
disappear just because they are not shell-command tables.
Named summary lines that explicitly describe validation, checks, tests, suites,
Storybook, E2E, lint, typecheck, build, regression, or gate results can also
produce labeled evidence, for example
`Full RC1 deterministic suite passed from agent: run ...`.
When deciding which validation evidence is active, shell command evidence keeps
its exact normalized command identity. Narrative labels use a looser label
identity that ignores trailing words such as `prompt`, `workflow`, `flow`,
`scenario`, `suite`, `gate`, `final`, `rename`, or `proposed-property`, so a later
real-world update like `Create LPAR workflow: PASS` can supersede an earlier
`Create LPAR final gate: Blocker` without requiring renderer-specific logic.
The real-world shorthand `Fresh live edit run` is treated as edit-LPAR workflow
evidence for the same purpose. Comprehensive queue-wide pass labels such as
`Full RC1 deterministic suite` are also recognized as replacement evidence for
older queue-wide broad rows like `npm run test`, `npm run test:storybook`, or
setup/focused pass rows when the comprehensive pass appears later in comment
order. Scoped PR, package, and path validation remains active until that scope is
explicitly superseded. Later queue-wide validations after the comprehensive pass
also remain active, so the bounded review-gate comment shows the current
aggregate proof plus any follow-up checks instead of leading with stale setup or
focused-check passes.
When stale evidence exists, the review-gate comment's validation count shows the
active rows and total rows, for example `7 active / 47 total`, instead of showing
only the raw historical row count.
Very long validation commands are abbreviated per row before the final Markdown
cell is capped, so one path-heavy command does not hide the other active checks.

The review-gate cache comment includes a bounded evidence-reference row. It is
ordered to keep decisive categories visible under the cap: failed CI details,
one evidence ref per modeled blocker, active merge-tree conflict refs, active
validation evidence, one evidence ref per queue blocker, then pending or
unknown CI details, followed by constituent status provenance, remaining blocker
refs, lower-priority lineage, and superseded validation refs. Status provenance
uses concrete browser or API comment, discussion, and forge note URLs that prove
rendered constituent statuses, including URL aliases on records that also carry
explicit lineage refs such as `pr:#...`; for equal-status merged constituents, higher
PR/MR numbers are preferred so recent merge-forward evidence survives the compact
row. Live PR processing builds this evidence summary from PR details plus PR
context, so supplemental modeled blockers use the same refs as the gate row. The
selection policy is implemented as a pure evidence-reference model so comment
rendering cannot drift from queue-gate domain rules. The rendered row abbreviates long refs and may show fewer than ten
refs when needed to keep the omitted-ref marker, such as `N more`, visible
under the Markdown cell cap. That marker counts every ref not displayed after
abbreviation and fitting. Queue blockers that
duplicate already-rendered top-level blockers are
hidden from both the queue blocker summary and the capped evidence-ref row.
If the already-rendered top-level blocker has no durable ref, the evidence-ref
row may backfill from the hidden duplicate queue blocker; if the top-level
blocker already has a ref, hidden duplicate queue refs stay hidden so they
cannot crowd out active validation evidence.
When conflict detection provides explicit evidence refs, merge conflict blockers
and the active conflict summary preserve those refs instead of fabricating only
the default `git:merge-tree` ref.
Evidence refs are trimmed before dedupe, and blank or whitespace-only refs are
ignored. If active conflict detection only provides blank explicit refs, the
cache falls back to `git:merge-tree`.
Within constituent lineage refs, real source refs from PR bodies, comments, or
validation evidence are ordered before synthetic `pr:#...` membership refs so
the rendered cache keeps actionable provenance visible when the list is capped.
Synthetic membership refs are emitted only when a constituent has no concrete
non-status lineage ref.
If stored constituent records are malformed or missing a positive PR number, the
cache renders the constituent number as `unknown` rather than fabricating `#0`.
Cached constituent title and head-SHA hints are trimmed before rendering; blank
hints are omitted instead of producing empty-looking status suffixes. Long
constituent titles are abbreviated before the status row is fitted, and the
omitted-constituent marker is computed after fitting so the cache does not hide
how many queue members were left out.
Malformed merge commit `pr_number` values are omitted from the merge-commit
summary instead of being rendered as synthetic PR labels.
Whitespace-only cached merge commit SHAs render as `unknown` rather than blank
commit labels, and they do not produce `commit:` evidence refs.
If stored queue strategy is missing, blank, or malformed, the cache renders the
strategy as `unknown` rather than leaving the evidence heading blank.
Queue-context summary rows use shared pure summary helpers for constituent
labels, merge commit labels, conflict-file lists, strategy defaults, and bounded
validation evidence so the cache can keep non-passing active validation visible
without duplicating queue domain policy in the comment renderer. When a
constituent status row is capped, blocked, unknown, validated, and merged
constituents are rendered before routine queued constituents so important queue
state does not disappear behind the row limit.
If stored blocker records are missing a kind, status, or summary, the cache
renders explicit `unknown` or `No summary.` defaults instead of blank table
cells. The same pure blocker model ranks, dedupes, caps, and formats modeled
blockers and unresolved blocker summaries for evidence comments; duplicate
top-level and queue blockers are compared after the same normalization. Cached
blocker and lineage rows accept singular
`evidence_ref` / `evidenceRef`, `comment_ref` / `commentRef`, and
`source_ref` / `sourceRef` fields or array `evidence_refs` / `evidenceRefs`,
`comment_refs` / `commentRefs`, and `source_refs` / `sourceRefs`
provenance fields, with `evidence_url`, `evidenceUrl`, `source_url`,
`sourceUrl`, `html_url`, `htmlUrl`, `web_url`, `webUrl`, `permalink`, `uri`,
and `url` as URL-shaped fallback refs. `links` / `_links` URL maps are used as
fallback refs after those direct fields.
Cached validation evidence rows accept the same singular comment/source ref
aliases and URL-shaped fallback refs, and structured cached rows can use `cmd`,
`check`, `validation`, or `test` for commands; `result`, `outcome`, `state`,
`conclusion` for status; and `area`, `package`, `path`,
`pullRequest`, `mergeRequest`, `mrNumber`, `mrIid`, `pullRequestIid`, `merge_request_iid`, or
constituent aliases for scope. PR/MR-specific scope aliases must resolve to a
positive PR/MR number; malformed PR/MR alias values are not treated as package
or path scopes.
If stored validation evidence is missing a usable command, active-evidence
selection and the cache render the command as `unknown` rather than producing a
blank validation entry.
Cached validation rows that only retain the original raw comment text can still
recover explicit `->` / `=>` / colon result statuses and descriptive linked PR
or MR scopes instead of rendering stale link text or result suffixes as part of
the command. Status-first cached rows such as `failed: [API](.../pull/201)
npm test` are recovered the same way when the remaining text is a recognizable
validation command.
Rendered table cells are escaped and capped after escaping so long commands,
URLs, package names such as `@scope/name`, pipes, backticks, and HTML-like text
cannot break the cache table or trigger mentions.

Non-clean GitHub merge states such as `DIRTY`, `BEHIND`, `UNSTABLE`, and
`UNKNOWN` are preserved as blocker evidence instead of being collapsed into a
generic failure.

## Large diffs

Some forges refuse to render very large PR diffs. When `gh pr diff` fails,
merge-god records `diff_availability.available = false` and keeps processing
with paginated commits/files/comments. The agent must then use local git history,
targeted file inspection, and changed-file metadata instead of assuming the
prompt contains the complete diff.
If stored diff availability records are partial, the cache uses explicit
fallback text: missing unavailable-diff reasons render as `Diff unavailable.`,
blank sources render as `unknown`, and missing sizes render as
`size unavailable` rather than `0 bytes`. Partial records without an explicit
available/captured alias render as unknown evidence instead of hard blockers;
only normalized false availability creates a `diff_unavailable` merge blocker.

## Labels

Queue PRs still require operator intent. Use `for-landing` for normal queue
cleanup or `for-review` when the queue also needs a quality-review pass. A
future `for-queue` mode may make aggregate queue handling explicit, but unlabeled
PRs remain skipped by design.
