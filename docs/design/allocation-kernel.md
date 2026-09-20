# Allocation Kernel — design and build plan

Status: SHIPPED on main 2026-09-16 (fleet coordinator thread `thr_t8dcvesuvd`; 14 shards, migrations
0160–0164). Section 6 is the historical build plan; the code under `engine/src/allocations/` and
`web/app/(app)/admin/setup/allocations/` is the source of truth where they differ.
Schema contract: `schema/src/allocations.ts` + migration `0160_allocation_kernel.sql`.
Type contract: `engine/src/allocations/types.ts`.

## 1. Why one kernel

Three requests arrived as three features:

1. **Allocation schedules** (period-end sweeps of pooled cost to targets on a driver).
2. **Distribution keys at transaction entry** (a bill/expense/journal line explodes across
   accounts and dimensions by a saved split, automatically for lines that match a rule —
   e.g. "every line coded to the Overhead department").
3. **GL plug-in at posting** (tenant-authored extra GL lines added to a transaction's own
   journal entry, standard lines locked, custom lines shown separately, book-aware).

They are the same primitive bound at different moments: *take an amount from a source
coordinate (account × dimensions) and distribute it to target coordinates on a basis*.
The kernel has ONE rule model, ONE driver registry, ONE apportionment engine, ONE lineage
table, and three **modes** that decide when a rule fires:

| mode     | fires                                | produces                                          |
| -------- | ------------------------------------ | ------------------------------------------------- |
| `entry`  | when a document line is saved        | materialized child `document_lines` (a group)     |
| `post`   | inside `postDocument`, same entry    | extra `journal_lines` stamped with a contributor  |
| `period` | on demand / scheduled / close action | an `allocation_runs` row + an `origin='allocation'` journal entry |

Everything else in the app that allocates today stays where it is (rev-rec, depreciation,
leases, CAM, landed cost, payroll labor distribution). The overhead net-zero-pair writer
(`engine/src/projects/overhead-apply.ts`) is the one existing mechanism that becomes a system-owned
`post` rule (slice 4), because it *is* a post-mode net-zero-pair allocation with one driver.

Design constraints (AGENTS.md): financial-institution grade; balanced, deterministic,
idempotent; immutable posted history (corrections by reversal); effective-dated config;
bigint money (`engine/src/money/money.ts`), never floats; enforcement at the service/API boundary;
reuse-first (Setup registry, report engine, RecordListView, Drawer, SplitLinesEditor,
ModuleView specs); vendor-neutral copy; every gate on the Features switchboard.

## 2. Data model (migration 0160)

All tables are org-scoped with the standard `org_isolation` RLS policy and FORCE RLS.
Tenant-anchored foreign keys are composite `(org_id, x) → (org_id, id)` where the parent
exposes that key (accounts, departments, locations, projects, subsidiaries,
accounting_periods, journal_entries, documents, document_lines); `classes`,
`accounting_books`, `journal_lines`, `report_definitions` use single-column FKs.

### `allocation_rules` — the rule head (identity, mode, ordering)
`id, org_id, key (slug, unique per org), name, description, mode ('entry'|'post'|'period'),
sort_order int, is_active, is_system bool (engine-owned rules such as the overhead pair;
not deletable, limited editing), current_version_id (published version pointer), custom,
audit`.

### `allocation_rule_versions` — immutable once published, effective-dated
One row per version. `status`: `draft` (editable) → `published` (frozen, `definition_hash`
set) → `retired`. `unique (org_id, rule_id, version_no)`. Published versions of one rule
must not overlap in `[effective_from, effective_to]` (enforced in `validateRuleVersion`,
slice A1, plus an exclusion check on publish).

Columns and their meaning:

- **Books**: `book_scope` `'primary'|'all_posting'|'books'`, `book_ids jsonb uuid[]`.
- **Applicability** (which lines the rule considers; `entry` and `post` modes; also the
  *source filter* for `period` mode):
  - `document_kinds jsonb` (text[] or null = any document kind),
  - `account_scope jsonb` = `{ kind:'any' } | { kind:'accounts', accountIds } |
    { kind:'account_group', dimension, groupKey }` (account groups are the pool primitive —
    `engine/src/records/account-groups.ts`),
  - `dimension_filters jsonb` = `{ departmentIds?, locationIds?, classIds?, projectIds?,
    subsidiaryIds?, partyIds?, itemIds?, extraDims?: Record<segmentKey, valueIds[]>,
    requireUntagged?: ('department'|'location'|'class'|'project')[] }`.
    A filter matches when EVERY present key matches (AND); an absent key matches anything.
    `requireUntagged` matches lines with NO value in that dimension (the classic "sweep the
    untagged pool" source).
  - `apply_policy` `'automatic'|'suggest'|'manual'` (entry mode). `automatic` explodes the
    line on save; `suggest` shows a chip in the line grid offering the split; `manual` only
    appears in the line's distribution picker.
- **Source measure** (period mode): `source_measure` `'period_activity'|'period_end_balance'|
  'ytd_activity'`. Source amounts always EXCLUDE journal lines that this same rule produced
  (lineage lookup), which is what makes re-runs idempotent.
- **Basis**: `basis_kind` `'fixed_percent'|'driver'|'stepped'`, `driver_id` (FK
  allocation_drivers, required when `driver`), `driver_as_of` `'period'|'document_date'|
  'prior_period'`, `basis_config jsonb` (stepped tiers; reserved knobs).
- **Targets**: `target_kind` `'explicit'|'dynamic'`. Explicit = rows in
  `allocation_rule_targets`. Dynamic = `dynamic_target jsonb` `{ dimension:'department'|
  'location'|'class'|'project'|'subsidiary'|'extra:<key>', include?: ids[], exclude?: ids[],
  minWeight?: '0' , targetAccountId?: uuid|null }` — the target set is "every active value
  of that dimension with driver weight > minWeight", resolved at run time.
- **Impact**: `impact` `'reclass'|'net_zero_pair'|'report_only'`.
  - `reclass`: CR the source coordinate (same account, same dims) and DR each target
    coordinate (target account or the same account, target dims). Moves the cost.
  - `net_zero_pair`: DR each target coordinate; CR the same account at the source
    coordinate. Nets to zero at account level; adds dimensional attribution (the overhead
    doctrine: statistical allocations never change company P&L).
  - `report_only`: no GL; lineage rows only (statistical). Reports read lineage.
  - `offset_account_id` optionally replaces "same account" for the credit side of
    `reclass` (a contra/clearing account).
- **Residual**: `residual_policy` `'largest_share'|'first_target'|'last_target'|
  'explicit_target'`, `residual_target_id`. Apportionment never loses or invents a cent
  (AUDIT-CONTROLS A2); the residual is deterministic.
- **Solve** (period mode waterfalls): `solve_method` `'sequential'|'simultaneous'`. v1 ships
  `sequential` (step-down by `allocation_rules.sort_order`); `simultaneous` (reciprocal,
  fixpoint) is slice 4.
- **Scheduling** (period mode): `run_policy` `'manual'|'auto_preview'|'auto_post'`,
  `run_offset_days int` after period end, `approval_flow_id` (Flows). `auto_post` with a
  configured flow posts only after the flow approves.
- **Presentation**: `memo_template text` (mustache-style `{{rule.name}} {{period.name}}
  {{target.label}}`), `line_description_template`.
- `published_at/by`, `retired_at/by`, `definition_hash` (sha256 of the canonical JSON of
  the version + its targets; stamped on every run and lineage row).

### `allocation_rule_targets` — explicit targets of a version
`id, org_id, version_id, sequence, target_account_id (null = same account), department_id,
location_id, class_id, project_id, subsidiary_id (null = same), extra_dims jsonb,
fixed_percent numeric(19,4) (fixed basis; percents of a version sum to ≤ 100 with at most
one `is_remainder`), weight numeric(19,4) (manual weights for `driver`-less weighting),
is_remainder bool, label text, custom, audit`.

### `allocation_drivers` — the driver registry
`id, org_id, key (unique per org), name, description, unit, dimension ('department'|
'location'|'class'|'project'|'subsidiary'|'extra:<key>'), source_kind, config jsonb,
is_active, custom, audit`. `source_kind`:

| source_kind             | config                                                        | evaluated from |
| ----------------------- | ------------------------------------------------------------- | -------------- |
| `statistical_journal`   | `{ unit, accountIds? }`                                       | `journal_lines.quantity` grouped by the dimension, in period |
| `gl_activity`           | `{ accountScope }` (same shape as rule account_scope)         | signed activity per dimension value in period |
| `gl_balance`            | `{ accountScope }`                                            | period-end balance per dimension value |
| `native_measure`        | `{ measure: 'headcount'|'labor_hours'|'billed_hours'|'labor_cost'|'revenue'|'direct_cost'|'rentable_area' }` | payroll, time entries, GL, property units (the True Cost base vocabulary) |
| `manual`                | `{}`                                                          | `allocation_driver_values` effective on the as-of date |
| `report_definition`     | `{ reportDefinitionId, dimensionColumn, valueColumn, params? }` | the report engine (`packages/reports` run) with the period injected |

`report_definition` drivers run under the identity of the actor triggering the run
(scheduled runs use the version's `published_by`), so the report engine's permission
checks stay authoritative.

### `allocation_driver_values` — manual driver values and evaluated snapshots
`id, org_id, driver_id, dimension_value_id, effective_from, effective_to, value
numeric(19,4), note, audit`; `unique (org_id, driver_id, dimension_value_id, effective_from)`.

### `allocation_runs` — one row per computed/posted period-mode run
`id, org_id, rule_id, version_id, definition_hash, period_id, book_id, subsidiary_id
(null = all), status ('previewed'|'pending_approval'|'posted'|'reversed'|'failed'|
'superseded'), trigger_kind ('manual'|'scheduled'|'close_automation'|'rerun'),
source_total, allocated_total, residual (money), journal_entry_id, reversal_entry_id,
reverses_run_id, superseded_by_run_id, computation jsonb (the full explain payload:
sources, driver vector, per-target weight/share/amount/residual), fingerprint text (sha256
of computation for re-run comparison), error text, flow_run_id, requested_by, started_at,
completed_at, audit`. Partial unique index: at most one `posted` run per
`(org_id, rule_id, period_id, book_id, coalesce(subsidiary_id))`.

### `allocation_lineage` — every allocated line traces to its source and driver
`id, org_id, mode, rule_id, version_id, definition_hash, run_id (period), document_id
(entry/post), journal_entry_id, journal_line_id, source_journal_line_id,
source_document_line_id, target_document_line_id, driver_id, driver_value, driver_total,
share numeric(19,10), residual money, created_at`. Indexes on `(org_id, journal_entry_id)`,
`(org_id, run_id)`, `(org_id, rule_id, created_at)`, `(org_id, document_id)`.

### Columns added to existing tables
- `document_lines.distribution_group_id uuid`, `distribution_rule_id`,
  `distribution_version_id`, `distribution_locked bool default false`. Children of one
  explode share a group id; `distribution_locked` means the user hand-edited the children,
  so a later amount change does not re-explode.
- `journal_lines.contributor_kind text` (null = kernel; `'rule'|'script'|'app'|
  'intercompany'`) and `contributor_ref uuid` (rule version id / script id / app id).
- `scheduler_outbox.kind` gains `'allocation_run'`.
- `close_automation_rules.action` gains `'run_allocation'` (TS enum; no DB check exists).
- `user_scripts.trigger_point` gains `'custom_gl_lines'` (TS enum; no DB check exists).

The dormant `allocation_rules/allocation_rule_targets/allocation_runs` tables from
`planning.ts` are replaced in place by 0160 (the migration refuses to run if any of them
holds rows; none does anywhere).

## 3. Engine (`engine/src/allocations/`)

- `types.ts` — the shared contract (rule/version/target/driver shapes, `Coordinate`,
  `DriverVector`, `ApportionResult`, `ContributedLine`, `MatchResult`). Frozen by the
  coordinator; extend only additively.
- `apportion.ts` (A1) — pure: `apportion(total, weights, residualPolicy)` exact bigint
  money via `money.ts`; `fixedPercentWeights(targets)`, `steppedWeights`. Never a float.
- `validate.ts` (A1) — `validateRuleVersion(version, targets)` (percents, remainder, driver
  presence, overlap of effective windows, dynamic target sanity, impact/offset coherence,
  mode-specific requirements) and `definitionHash(version, targets)`.
- `match.ts` (A4, committed FIRST) — pure `matchLine(rule, line: LineCoordinate) → boolean`
  and `selectRule(candidates, line) → RuleVersionRef | null` (most specific wins: count of
  matched predicates, then `sort_order`, then key). `post` (A5) and `entry` (A4) use it.
- `drivers.ts` (A2) — `resolveDriverVector({ orgId, driver, asOf: { periodId } |
  { date }, dimension, filter, actor }) → DriverVector` (Map<dimensionValueId, numeric
  string>) with one resolver per `source_kind`. Report-backed drivers call the report
  engine. Native measures reuse the True Cost data helpers where they are db-free, else
  re-query.
- `period-run.ts` (A3) — `previewAllocationRun`, `postAllocationRun`,
  `reverseAllocationRun`, `rerunAllocationRun`, `listRuns`. Source read uses the GL
  summary helpers (`web/lib/gl-summary.ts` patterns are web-side; engine reads
  `journal_lines` directly, excluding this rule's own lineage). Journal written through
  `postProjectGlEntryWithinTransaction` (extend `GlLine` with departmentId, locationId,
  classId, subsidiaryId, extraDims, contributorKind, contributorRef — additive). Origin
  `allocation`. Period/book/closed-module checks exactly as depreciation does. Reversal
  mirrors stored lines (never recomputes). Runs and lineage in ONE transaction.
- `entry.ts` (A4) — `explodeDocumentLine(line, ruleVersion, driverVector) →
  childLines[]` and `planEntryDistributions(doc, lines, rulesInEffect, drivers)`; wired into
  `web/lib/documents.ts applyDocumentEdit` (before totals + tax) and the generic writers.
  Children are REAL lines: the entered line is replaced by N children sharing
  `distribution_group_id` (amount apportioned; quantity apportioned proportionally when the
  line is quantity-based; item, description, tax code, party, billing flags inherited;
  target dims/account overridden). Re-exploding: when the group's sum changes and
  `distribution_locked=false`, children are regenerated from the group's total and the
  first child's inherited fields. "Un-split" collapses the group into one line at the
  first child's coordinates.
- `post.ts` (A5) — `contributePostingAllocations(db, doc, kernelLines, deps) →
  ContributedLine[]` called in `engine/src/ledger/posting.ts` right after kernel lines are built
  and BEFORE `applySubsidiaries`. Rules in effect on the posting date, `post` mode,
  book_scope covering the primary book, matched per kernel line via `match.ts`. Each
  contributor's line set must balance per subsidiary on its own
  (`assertContributorBalance`). Lines carry `contributorKind/contributorRef`; lineage
  rows are written in the same posting transaction. Secondary-book targets
  (`book_scope='books'` with non-primary `posts_gl` books) produce a SEPARATE
  `journal_entries` row in that book, `origin='allocation'`, `source_document_id=doc.id`,
  in the same transaction. Void/reversal mirrors contributed lines through the existing
  reversal cloning (`reversal-journal-lines.ts`) — verify with a test.
- `scripting.ts` (A6) — new trigger `custom_gl_lines`: `main(ctx)` receives
  `{ trigger, document, lines, kernelLines (frozen), org, user }` and returns
  `{ lines: [{ accountId|accountCode, amount, departmentId?, projectId?, locationId?,
  classId?, subsidiaryId?, memo?, bookCode? }] }`. The host validates (max 200 lines, must
  balance per subsidiary, no kernel mutation, `gl.post` re-resolved live, feature gate
  `allocationsAtPosting` + `scripts`), stamps `contributor_kind='script'`,
  `contributor_ref=script.id`. Runs after rule contributions, inside the posting
  transaction, deterministic (no clock, no random: the sandbox already has none).
- `scheduling.ts` (A10) — scheduler outbox kind `allocation_run`: at period end +
  `run_offset_days`, for each active period-mode published version with
  `run_policy != 'manual'`, enqueue `(rule, period, book)`; `auto_preview` computes a run in
  `previewed`; `auto_post` posts (or opens the approval flow). Idempotent per occurrence
  key `alloc:<rule>:<period>:<book>`. Close automation action `run_allocation`
  (`config: { ruleIds: uuid[] | 'all', post: boolean }`).

## 4. Web

- **Setup workspace** `/admin/setup/allocations` (ModuleView spec, exemplar
  `web/app/(app)/admin/setup/overhead/`): tabs **Rules**, **Drivers**, **Runs**. Registered
  in `web/lib/setup/registry.ts` (`groupKey: 'accounting'`, custom page, gated by
  `allocations`). Rule drawer (A7): mode, applicability (account scope: accounts or account
  group; dimension filters incl. "untagged"), basis, targets (reuse
  `web/components/allocations/SplitLinesEditor.tsx`, extended with `weight` and the
  target-account-optional case), impact, residual, books, schedule, versions timeline with
  Publish/Retire, Preview (period mode) and Test-against-a-line (entry/post mode). Drivers
  tab (A8): driver list + drawer per source_kind + manual values grid (effective-dated).
  Runs tab (A8): list (RecordListView/PagedTable), preview table (source rows, driver vector,
  targets with weight/share/amount/residual), Post / Reverse / Re-run actions with reason
  prompts (`promptDialog`), lineage drill.
- **Line grid** (A9): a distribution affordance on every account/expense line in
  `web/components/line-grid.tsx` / `document-drawer.tsx`: chip showing the applied rule,
  "Split…" action opening a dialog (SplitLinesEditor) that creates/edits the group, group
  rendering (children indented under a synthetic group header showing the total), "Un-split",
  `suggest` chips. Rule defaults resolve server-side (`GET
  /api/allocations/entry-candidates?documentKind&accountId&dims…`). Import/API: a line may
  carry `distributionKey` (rule key) in `web/lib/api/writers.ts` and data-io adapters.
- **GL impact drawer** (A5): `web/components/journal-entry-link.tsx` groups lines by
  contributor (Standard / Rule: name / Script: name), standard lines rendered locked.
- **API** (`web/app/api/allocations/…`): rules CRUD + versions (publish/retire) + targets,
  drivers CRUD + values, runs (preview/post/reverse/rerun/list), entry-candidates,
  explain (`GET /api/allocations/lineage?journalEntryId|documentId|runId`). Every route
  gated by feature + permission; subsidiary scope respected; revision tokens on updates.
- **Reports** (A10): report entities `allocation_runs`, `allocation_lineage` in
  `packages/reports/src/entities.ts`; built-in "Allocation summary" and "Allocation
  lineage" reports; Runs tab links to them (no bespoke analytics screens).
- **Features** (A10): `allocations` (accounting, default OFF, navModules none; setup rail
  entry gated), `allocationsAtEntry` and `allocationsAtPosting` with `parentKey:
  'allocations'`; turn-off impact counts (open previewed runs, active rules); never blocked.
- **Permissions** (A10): `allocations.read`, `allocations.manage`, `allocations.run`,
  `allocations.approve` in `engine/src/organization/permissions.ts` + built-in roles + `seed-roles.ts`
  rerun note. Posting a run additionally requires `gl.post`.
- **i18n**: `web/messages/en/allocations.json` (+ fallbacks file per the i18n gotchas
  memory); labels via keys, never literals.
- **Docs** (A12): `web/lib/docs/articles/allocations.ts` registered in `web/lib/docs/index.ts`.
- **Trust corpus** (A12): conformance cases `alloc-no-lost-cent`, `alloc-reversal-restores`,
  `alloc-rerun-idempotent`, `alloc-contributor-balance`, `alloc-entry-group-sum`.

## 5. Invariants (tests must pin each)

1. Σ(children amounts) == entered amount; Σ(target amounts) == source amount; residual is
   placed per policy and recorded in lineage.
2. A posted run is immutable; corrections are `reverse` (mirror) or `rerun` (reverse + new
   run); at most one posted run per (rule, period, book, subsidiary).
3. Re-running the same rule over the same period with unchanged inputs yields the same
   fingerprint and posts nothing new.
4. Contributed lines balance per subsidiary per contributor; kernel lines are never
   mutated; `assertFinalKernelBalance` still holds for the union.
5. `net_zero_pair` impact never changes any account's total balance; `reclass` never
   changes the trial balance total; `report_only` writes no journal lines.
6. Feature off ⇒ no rule fires anywhere (entry, post, period, scheduler) and data is kept.
7. Published versions are frozen (DB trigger or service guard) and effective windows of one
   rule do not overlap.
8. Period/book/closed-module checks are the same as depreciation; a closed period refuses
   post and reverse.
9. Cross-org references in any allocation table are refused (composite FKs + service check).

## 6. Fleet shards

| shard | owner area | key files | depends on |
| ----- | ---------- | --------- | ---------- |
| A1 engine-core | apportion, validate, definitionHash, rule/version service (CRUD, publish, retire, overlap guard) | `engine/src/allocations/{apportion,validate,rules}.ts` | schema (landed) |
| A2 drivers | driver registry resolvers + manual values service | `engine/src/allocations/drivers.ts` | schema |
| A3 period-run | preview/post/reverse/rerun + lineage + GlLine extension | `engine/src/allocations/period-run.ts`, `engine/src/projects/recognition.ts` (additive) | A1 apportion, A2 (inject a `DriverResolver`; start with fixed_percent) |
| A4 entry-mode | `match.ts` (first commit), `entry.ts`, `applyDocumentEdit` wiring, generic writers `distributionKey` | `engine/src/allocations/{match,entry}.ts`, `web/lib/documents.ts`, `web/lib/api/writers.ts` | A1 apportion |
| A5 post-mode | posting seam, contributor stamping, secondary-book entries, void mirroring, GL impact drawer grouping | `engine/src/allocations/post.ts`, `engine/src/ledger/posting.ts`, `web/components/journal-entry-link.tsx` | A4 match |
| A6 script-trigger | `custom_gl_lines` trigger in the QuickJS runtime, ScriptDrawer template, scripting docs | `engine/src/scripting/scripting.ts`, `web/app/(app)/admin/scripts/*`, `web/lib/docs/articles/scripting.ts` | A5 seam (stub until landed) |
| A7 setup-ui-rules | Rules tab + Rule drawer + versions + rules/targets API routes + setup registry entry | `web/app/(app)/admin/setup/allocations/*`, `web/app/api/allocations/rules/*`, `web/lib/setup/registry.ts` (one small commit) | A1 service |
| A8 setup-ui-drivers-runs | Drivers tab + drawer + values grid, Runs tab + preview/post/reverse UI + lineage drill + API routes | `web/app/(app)/admin/setup/allocations/{drivers,runs}*`, `web/app/api/allocations/{drivers,runs,lineage}/*` | A2, A3 |
| A9 line-grid | entry-mode UI in line grid/document drawer, split dialog, group rendering, suggest chips, entry-candidates API, data-io | `web/components/line-grid.tsx`, `web/components/document-drawer.tsx`, `web/app/api/allocations/entry-candidates/route.ts`, `web/lib/data-io/*` | A4 |
| A10 platform | Features + permissions + roles, report entities + built-ins, scheduler outbox kind + runner, close automation action, governed catalog migration 0161 | `engine/src/organization/feature-registry.ts`, `web/lib/features.ts`, `engine/src/organization/permissions.ts`, `packages/reports/src/*`, `engine/src/scheduling/outbox.ts`, `engine/src/close*.ts`, `schema/migrations/generated/0161_*.sql` | schema |
| A11 overhead-fold (wave 2) | overhead net-zero pair → system-owned post rule, backfill parity test | `engine/src/projects/overhead-apply.ts` | A5 |
| A12 docs-trust (wave 2) | in-app docs article, trust corpus cases, i18n fallbacks for other locales | `web/lib/docs/*`, `corpus/*` | A3, A4, A5 |
| A13 assistant (wave 2, after the assistant fleet releases its files) | `preview_allocation`, `explain_allocation`, `list_allocation_rules` tools + MCP | `web/lib/assistant/*`, `web/lib/mcp/*` | A3, A8 |

Ordinals: 0160 kernel (coordinator), 0161 governed catalog + views (A10), 0162–0169 reserved
for the fleet (request from the coordinator).
