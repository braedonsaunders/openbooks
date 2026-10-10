# Migration assistant

The migration workspace (`/migrate/assistant`, deep-linkable threads at
`/migrate/[id]`) is the optional helper beside the guided cutover at
`/migrate`: a migration-scoped assistant conversation beside the measured
migration plan. It composes existing machinery; it owns no second
migration, import or journal path. The guided cutover drives the same
native commands, so the move completes with no assistant involved.

## Components

| Concern | Owner |
| --- | --- |
| Plan record (path, source, connection, cutover date, clearing account, notes, go-live) | `orgs.settings.migrationPlan`, written only by `web/lib/migration/plan.ts` with a row lock and an audit entry |
| Journey and cutover checks | `web/lib/migration/journey-model.ts` (pure derivation) over facts loaded by `journey.ts` |
| Connector runs and mirror control | `web/lib/sync/connection-run.ts`, `connection-update.ts`, shared with the Migration & Sync routes |
| File staging and import | durable data transfers; `select-resource` re-targets a staged file before validation |
| Templates | `/api/data/templates/{resource}`, generated from the resource's live fields |
| Opening trial balance | `web/lib/migration/opening-balances.ts` → `createManualJournal` (draft) |
| Conversation | `AssistantApp` with a workspace configuration; chat `mode: "migration"`, conversation scope `migration` |
| Method | `MIGRATION_PLAYBOOK`, shared by the chat workspace and the `migrate-into-openbooks` MCP skill |

## Paths

- **mirror** — connector history plus a scheduled mirror; the previous system
  remains the system of record, so there is no go-live.
- **cutover** — connector migration, verified runs, a final verified run
  through the cutover date, the mirror stopped, then go-live.
- **spreadsheet** — master data and open items by import, the opening trial
  balance by draft journal, subledgers tied, then go-live.
- **fresh** — foundation and cutover date, then go-live.

## Controls

- Every mutation the assistant proposes is a signed review card executed
  through the application catalog's idempotent wrapper and the native
  command; refusals keep their message and remedy.
- Credentials are entered only in the connection drawer; the assistant links
  to it with `?connect=<source>`.
- The opening journal never plugs a difference. An out-of-balance file is
  refused with the exact difference unless the operator names a balancing
  account. Amounts are exact decimals; formatted values refuse.
- For spreadsheet migrations, open documents post against the opening
  clearing account and the trial balance's control lines are re-pointed to
  it, so the clearing account nets to zero and the control balances are
  rebuilt by documents.
- Go-live is recorded once, inside the plan's row lock, with the measured
  checks. Every required check must pass; an unmeasured required check
  refuses like a failure. A recorded go-live freezes the path and cutover
  date.
- Opening balances require an unrestricted setup administrator. Their journal
  date must be the day before the recorded cutover, and subsequent adjustments
  after go-live use the native journal workflow.

| Check | Required on |
| --- | --- |
| Foundation complete, cutover date set | cutover, spreadsheet, fresh |
| Latest source run verified, captured through the cutover, mirror stopped | cutover |
| Opening journal posted, clearing account zero (when configured) | spreadsheet |
| Receivables and payables tie to open documents | spreadsheet (advisory on cutover) |
| Pre-cutover periods locked | advisory |

## NetSuite employee photos and scoped refresh

NetSuite migration and mirroring read employee photo references independently
of employee update watermarks. Files are fetched through the authenticated
connector and attached only after the employee's stable source identity and
organization account resolve uniquely. Missing source photos preserve the
destination. Download failures retain their actual cause in run statistics.

Connector ownership records the account connection, employee and file
identities, content digest and destination file. Same-content replay retains
the file URL and audit history. Manual uploads, removals and cabinet edits
take precedence over synchronization. Each changed source photo creates a new
retained attachment. Images above 5 MB are prepared as bounded display images;
their originals remain private employee attachments. Source images above
25 MB refuse explicitly; display conversion also refuses more than 40 million
decoded pixels.

The native employee-photo CLI supports read-only preparation by default and
explicit execution with organization, connection and actor IDs. Its permission
contract requires sync.run, parties.read, parties.manage and unrestricted
subsidiary access. Native readback checks both display and retained source bytes.

A scoped employee refresh uses the same NetSuite projection and master-data
loader as mirroring. It requires exact source IDs and verified subsidiary,
department and supervisor mappings. It preserves the source's active status
and service dates, and never creates canonical employment history or infers
an employer. Omitted employees remain unchanged; a partial inventory is never
treated as a complete source snapshot. Preparation and execution preserve
actor, source-run and before/after audit evidence.
