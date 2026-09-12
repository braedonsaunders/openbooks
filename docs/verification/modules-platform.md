# Modules platform completion review

Reviewed the implementation delivered by thread `thr_6sntacy3a4` at `480d2cfee` against its Phases 1–4 program brief. Follow-up branch: `bb/modules-completion-audit`; primary implementation commit: `9d0c98503`. This audit does not merge into main or deploy to production.

## Completed integration and corrections

- Connected navigation, settings, and permission contributions to the atomic engine installer and their actual readers. Removed unused alternate projector implementations. Page overrides retain personal → organization → installed module → built-in precedence.
- Connected the existing approval worklist to module activation in the same transaction. Signed approval binds the exact manifest, grant, tenant, and prior version. Self-approval, stale proposals, unauthorized direct activation, and revoked requester/approver authority are refused. Failed projection leaves the approval available for retry.
- Rollback appends a restoring version, preserves history, and requests signed approval when capabilities are involved. Exact approved reinstalls converge without widening grants.
- Completed the shared admin drawer with authoring, diff, install, approval, audit evidence, rollback, publication, and sandbox rehearsal controls. Rehearsal validates its linked sandbox, uses the real route preview, and promotes through approval controls.
- Connected module listings to the existing app library endpoint and cards. Capability-bearing installs return pending approval. Publication is audited and checked against current actor authority; snapshots and publisher ownership are preserved.
- Kept app absorption separate from native module ownership. An app cannot overwrite a native module with the same key, and native lifecycle operations cannot silently disable only an app's mirror.
- Added declaration-backed module settings to the existing Setup registry, list, and drawer, plus assistant reads and exports. Typed changes require a reason, preserve effective-dated history, and reject stale editors. Module defaults do not overwrite tenant values. Feature switches remain on Company Settings → Features.
- Made custom module permissions grantable through the existing role editor and enforced deactivation at authorization reads while preserving stored role grants. Historical permission ownership prevents another module inheriting those grants.
- Added forward migration `0136_module_active_version_owner.sql`: the active version must belong to that exact module and organization. Existing migrations were not rewritten.
- Fixed two build blockers exposed by full verification: the login page exported a non-page helper, and forms-core lacked explicit Node test types under TypeScript 6.
- Corrected shared settings field accessibility, the pending-approval label, and translation gaps exposed by the route sweep. Browser fixtures support an explicit local HTTPS certificate exception while production cookies remain secure.

## Supported contract

Installable contribution kinds are `page`, `nav`, `setting`, and `permission`. Other vocabulary kinds remain structurally described and are refused at install, as specified by this program. A page contribution customizes an existing application route and its loader; it does not create a new route handler.

## Verification

- `npm run test:unit`: **3,348 passed**, no failures or skips. The subsequently added module API boundary file also passes all four tests.
- Combined module database suite: **73 passed**, no failures or skips, including immutable rollback, approval races and revocation, projections, rehearsal, marketplace, settings, app absorption, and active-version ownership.
- App installation/invocation audit and page-layout authoring regressions: **25 passed**, no failures or skips.
- Contribution/role authorization verification additionally passed the existing role route cases and custom permission availability tests. Financial worklist gate regressions passed all 14 database cases.
- `npm run typecheck --workspaces --if-present` and `npm run typecheck:e2e`: passed.
- `npm run lint`: passed with **zero errors and 660 existing warnings**, within the repository cap. Explicit-any guard: 329, within its cap. Container security, product neutrality, credential redirect, repository artifact, and history hygiene checks passed.
- `npm -w web run build`: passed. The production browser server used the restricted `openbooks_app` database role; startup verified that it cannot bypass tenant RLS, and health returned HTTP 200.
- Fresh isolated database bootstrap applied **108 migrations**, including the final bytes of migration 0136, and verified the restricted runtime role.
- After browser-driven label corrections, the message catalog, view translation, and module API boundary checks passed **17 tests**, and the production build passed again.

Production HTTPS browser verification passed **10/10 tests**, with no skips:

- Discovered and visited **154 application routes**, checking HTTP errors, thrown browser errors, error boundaries, and empty content. Dynamic routes without seeded identifiers are outside this sweep; record/query-specific branches require their own fixtures.
- Installed, upgraded, rendered, and rolled back a page module through the shared drawer.
- Requested and independently signed module approval through the existing worklist, then edited its setting to exactly `Weekly` through shared Setup.
- Staged a sandbox rehearsal, rendered the actual route with `layoutPreview=1`, promoted it, and discarded the rehearsal while preserving the production module.
- Passed five existing page-layout browser regressions, including restore, author-only preview, and refusal of invalid layouts.

The committed browser fixtures are `e2e/modules.spec.ts`, `e2e/module-approvals.spec.ts`, and `e2e/module-rehearsal.spec.ts`. The approval fixture needs `E2E_APPROVER_EMAIL`/`E2E_APPROVER_PASSWORD`; rehearsal needs an existing ready sandbox named by `E2E_SANDBOX_NAME`. All were supplied for this run. Local HTTPS used an ephemeral certificate with the test-only `E2E_IGNORE_HTTPS_ERRORS=1`; production authentication protections remained enabled.

After replacing the sandbox picker with the house `Select`, the final production build passed and all **three module browser workflows passed again**. Final test typecheck and changed-file lint passed. Screenshots were visually checked for the shared drawer, the exact saved setting, and the actual sandbox page.

All temporary browser/server processes were closed. The four audit databases and dedicated fresh-bootstrap template were disposed after verification; existing user services and databases were preserved.

## Operational rollout

Apply the forward migrations before running the new application build. Disabling a module preserves its configuration, versions, projections, and audit evidence. Use controlled module rollback for version correction. The added foreign key can remain in place when rolling the application back; it does not require destructive database rollback. A database containing invalid cross-module active pointers fails migration validation and must be corrected explicitly before rollout.

Migration allocation was coordinated with the concurrent inventory audit: this branch owns 0136, and that audit reserved 0137. The earlier module migrations 0107–0111 remain unchanged on their original program branch.
