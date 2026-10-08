# Repository Engineering Standards

## Working priorities and verification

- Spend at least **95% of agent working time** implementing product code, diagnosing and fixing defects, or configuring and operating the application and business workflows. CI, build/test execution, orchestration, monitoring and auxiliary administration are capped at **5%**. Defect diagnosis and fixes belong in the 95%.
- Batch coherent changes into **one agreed source tree and one coordinated verification pass**. Independent per-feature, per-thread or per-worktree builds, tests, typechecks, browser QA and CI are prohibited on every machine. Use focused checks for changed behavior and its callers; run broad suites in the background at substantial milestones or release requirements, not after every small commit.
- Continue productive work while checks run. Unrelated known failures do not block scoped business work. Report unrun or incomplete checks accurately; every passing result identifies its actual source SHA and partition. Reused evidence retains its original identity.
- Keep shared applications, source synchronization, tunnels and databases running. Stop only jobs you own, through normal controls. Preserve others' uncommitted and unpushed work; never reset shared refs or overwrite unrelated changes. Pass these policies to workers and successors.

## Financial-institution-grade ERP

Every product, data-model, architecture, API, UI and security decision must preserve financial integrity, auditability, deterministic behavior and long-term operability.

- Enforce organization and legal-entity isolation, permissions and feature dependencies in services and APIs, not only the UI.
- Keep accounting balanced, deterministic and idempotent. Posted history is immutable; correct it through governed reversals or adjusting entries.
- Audit material configuration and transactions with actor, timestamp, before/after state and an appropriate reason.
- Define lifecycle transitions, approvals, segregation of duties and concurrency controls explicitly.
- Effective-date financial policies so changes cannot reinterpret historical transactions. Maintain one authoritative source for each policy; avoid overlapping configuration and company-specific hardcoding.
- Use exact decimal/currency arithmetic, never floating-point financial calculations. Missing required configuration must refuse explicitly, not silently become zero or a fallback.
- Preserve tenant data through backward-compatible migrations and controlled, recoverable rollout procedures.

## Architecture and code ownership

| Location | Responsibility |
| --- | --- |
| `engine/src/<module>/` | Domain services and invariants; modules and dependencies declared in `engine/src/modules.json` |
| `web/app/`, `web/components/`, `web/lib/` | Pages, API boundaries, shared UI and application composition |
| `schema/src/`, `schema/migrations/` | Database definitions and versioned migrations |
| `packages/` | Shared capabilities such as reports, PDF output and email templates |
| `docs/design/engine-modules.md` | Engine dependency and module-boundary rules |

- No files at `engine/src` root. Import only declared modules; unused dependencies and module cycles are prohibited. Extract internals within their module and place shared types/constants in a lower dependency layer.
- Reuse native commands and domain services across UI, API, imports and jobs; do not duplicate financial logic or bypass their authorization and lifecycle controls.
- Use typed request schemas and native identifier/date/decimal helpers. Validate references against the actual subject, organization, legal entity, jurisdiction and effective date.

## Writes, refusals and tests

- Check affected rows. A required write matching zero rows is a failure; success must be observable through the native read/resolution path. Use `ON CONFLICT DO NOTHING` only for an explicitly documented benign conflict.
- Propagate domain refusals to the operator with an actionable, supported remedy. Check response status before parsing error bodies; preserve the original cause rather than replacing it with an unrelated error.
- Fail closed when resource identity or required configuration is unknown. Comments and remedies must describe mechanisms that actually exist.
- Test meaningful invariants, realistic refusals, isolation, replay, rollback and concurrency where relevant. Mock external boundaries, not pure validation or domain logic. A selected test file registering zero tests is a failure.
- When changing algorithms or refusal conditions, review properties of the old behavior beyond the import graph. When consolidating implementations, preserve the behavioral coverage of both.

## Shared database migrations

- Apply shared/deployed database changes only through the authorized native bootstrap/migration runner, which records published filename and digest. Never execute migration SQL or ad-hoc schema DDL directly against these databases.
- Published migration bytes are immutable. Reserve forward changes through the existing allocation mechanism; retain verified backup and relevant before/after preservation evidence.
- If objects exist without matching ledger entries, stop and preserve them and tenant data. Compare all affected columns, constraints, indexes, functions and triggers with published SQL before proposing reconciliation. Obtain the database owner's approval; never fabricate ledger entries or drop/recreate objects to force progress.

## Professional product code

- Code, comments, test titles, migrations and documentation must read as public SaaS engineering. Comments explain product guarantees and reasons, not incident stories or development history.
- Keep internal tracking IDs, agent/thread identities and work-process terminology out of the product tree. Internal audits, triage and verification reports belong outside the repository.
- Migration comments describe only the schema change and rationale. Prefer concise durable standards over anecdotes and repeated explanations.

## Feature gates and configuration

- **Company Settings → Features** is the single authoritative organization-level switchboard. Module settings may show effective status and link to it, but must not persist another gate.
- Projects is the parent gate for all project capabilities, including costing, billing, project types, progress billing, retainage, labor pricing/reporting and Field Tickets. Enforce parent/child dependencies in navigation, pages, APIs, services, jobs and configuration writes. Disabling features preserves data and audit history.
- Configurable policies belong in the Setup registry with editable UI and explicit scope/effective dates, not hardcoded business-specific behavior.

## Reuse-first: shared product machinery

Before building a surface, identify its existing exemplar and use the same composition. Extend shared components when needed; do not fork lists, reports, drawers or settings screens.

| Need | Native machinery / exemplar |
| --- | --- |
| Reports and tabular analysis | `report_definitions` + `packages/reports`; `ReportFilterBar`, `ReportPaper`/`PaperView`, `ExportMenu`, `SaveViewButton`; `web/app/(app)/reports/pnl/page.tsx` |
| Lists | `RecordListView` for documents; `PagedTable` + list source registry for other records |
| Module landing | Module-home cockpit and group tabs in `web/components/module-home/`; Purchasing exemplar |
| Record detail | `UrlDrawer` / `Drawer`; native party and document drawers |
| Settings | `web/lib/setup/registry.ts`, `/admin/setup`, `SetupEntitySection` |
| API boundaries | `defineRoute` in `web/lib/api/route.ts`; native permission, feature and typed-body contracts |
| Organization context | `engine/src/platform/db.ts` context/transaction helpers; native authorization in `web/lib/authz-core.ts` and `web/lib/authz-context.ts` |
| Printable output | `web/lib/pdf-templates/` + `packages/pdf`; invoice PDF composition |
| Outbound email | `packages/emails` + `engine/src/delivery/email-config.ts` |
| Menus and prompts | `ContextMenu` / `useContextMenu`, `promptDialog` |
| People and companies | Native `parties` model and role views; no parallel roster |
| Financial arithmetic | Bigint helpers in `engine/src/money/money.ts` |
| Decimal refusals | `web/lib/payroll-decimal-refusal.ts`: `decimalNullRefusal`, `decimalNullCause`, `suppliedValue`; no second classifier or separator coercion |

- Analytical tables are first-class reports in the Reports hub with native filters and period selection. Module pages link to them.
- Match house chrome: `PageHeader`, group tabs, `ListPageLayout` / `DetailPageLayout`, one primary New action.
- Show **one independent concept per active body**. Peer concepts use tabs that replace the body. Related children use a selected-parent drawer or master–detail view, visibly scoped to that parent; never stack independent tables.
- Async records use **one drawer shell** through loading, success, refusal and retry. Use `web/components/async-url-drawer.tsx` for host-owned shells or `web/components/list-drawer-host.tsx` for record-owned shells; `web/app/(app)/admin/audit/AuditEventHost.tsx` is the host exemplar.
- Review populated and empty compositions at relevant desktop sizes, including nested components. Preserve URL navigation, permissions, drafts, create/save/reopen flows, focus and scroll lock.
