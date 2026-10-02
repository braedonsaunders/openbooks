# Release migration baseline cutover

A release cut replaces historical migration replay for fresh installations with
one verified baseline. Historical SQL remains immutable in `generated/` for
upgrade evidence and migration regression tests. Forward ordinals continue above
the cut; they are not reused or renumbered. The deployment runner uses
`schema/migrations/baseline.json` when present and otherwise follows the existing
chain.

## Prepare and activate the release

Land the release's migration changes before activation. Preparation may run while
development continues, but its candidate records the exact input filenames and
digests and refuses changes made during replay. A candidate containing
uncommitted migration inputs cannot be activated.

Use the existing release-pinned PostgreSQL test container. Supply its loopback
administrator URL in `OPENBOOKS_BASELINE_ADMIN_URL`, naming the `postgres`
maintenance database. Remote hosts and tenant database URLs are refused.

```sh
node --import tsx scripts/prepare-migration-baseline.mts --output /absolute/path/to/new-candidate
```

Preparation creates three disposable databases, replays the original bytes through
the production migration executor, refreshes RLS and governed views, and captures
schema and reviewed system seeds. It installs the candidate into the second
database and compares table and view definitions, columns, constraints and their
validation state, index validity, functions, triggers, policies, enum values,
sequence definitions, PUBLIC/read privileges and system registry contents. SQL
bodies and error messages are compared without collapsing whitespace. PostgreSQL
deparses constraints in its canonical pretty form so redundant parentheses do
not masquerade as changed conditions. Both disposable databases are removed.

The ISO currency registry, module query registry, document-close registry and
platform-settings singleton are preserved. Installation settings and tenant
data are never exported. Any other nonempty table refuses preparation until its
seed has been reviewed. Required `btree_gist` and `pgcrypto` extensions accompany
the dump; `pg_trgm` retains the established optional-extension policy.

On the final committed tree, activate the verified candidate:

```sh
node scripts/activate-migration-baseline.mjs /absolute/path/to/new-candidate alpha29
```

This writes `baselines/alpha29.sql`, its catalog evidence, and the active
manifest. It refuses changed SQL, missing coverage, an uncommitted migration
tree or a candidate prepared on another commit. Commit these artifacts with the
release. Run the normal release checks, fresh installation, and upgrade
rehearsals against that exact commit before tagging. The baseline is immutable
after publication; subsequent changes use forward migrations.

## Reconcile and adopt an existing installation

An old ledger does not prove that the schema matches its digests. Never restamp
an old baseline and never execute the new baseline over existing tenant data.
The release's upgrade check and migration runner refuse an existing database
until it has explicitly adopted the new baseline identity.

Before cutover, retain the old release image and migration inputs. Take a full
backup or storage snapshot and prove restoration into an isolated database.
Rehearse the existing installation's upgrade on that restored copy. Use the
previous migration runner and its preflights to apply missing forward work; if
the stored schema and ledger disagree, reconcile the actual object and data
differences before trusting migration history. Data backfills, credential seals
and other application-side upgrade work must also complete. Schema equivalence
alone cannot prove that historical data transformations ran.

Set `OPENBOOKS_BASELINE_TARGET_URL` explicitly to the maintenance login for the
named database. The adoption tool does not read application `.env` credentials.
It requires a superuser or BYPASSRLS maintenance login, verifies every catalog
section and reviewed registry against the pinned release evidence, and preserves
existing installation settings.

```sh
node --import tsx scripts/adopt-migration-baseline.mts --database openbooks --check
```

For the production cutover, stop application and worker services and other
database clients, take the final backup, apply the rehearsed reconciliation,
and rerun the check. Adopt only after the check passes:

```sh
node --import tsx scripts/adopt-migration-baseline.mts --database openbooks --apply \
  --actor 'operator identity' --reason 'verified release schema reconciliation' \
  --backup 'reference to the verified pre-cutover backup'
```

Adoption shares the deployment bootstrap lock and refuses other client sessions.
It appends the new baseline ledger identity and an adoption audit in one
transaction. The audit records the database, login, operator, timestamp, reason,
backup reference, catalog digest and complete previous ledger. Historical
ledger rows and tenant data remain unchanged. The tool does not execute baseline
SQL or correct mismatched schemas. A second adoption of the same verified
identity makes no writes.

Run the release's read-only bootstrap upgrade check, start the new services,
and verify tenant isolation, posting controls, accounting reconciliations and
representative workflows before reopening writes. During maintenance, rollback
uses the verified pre-cutover restore and previous release. Once new business
writes resume, use a controlled forward correction rather than restoring over
those writes.

Catalog comparison uses UTC and compares columns by name. For registry-generated
query views, physical column order is ignored while the selected column set,
isolation predicate and all security attributes must match. Curated expressions
and function bodies remain exact. A direct read-role schema USAGE grant is
redundant when PUBLIC already has USAGE; catalog equivalence compares that
effective access while still refusing added PUBLIC CREATE privileges.

### Complete a historical upgrade

For an existing database that has not adopted the active release baseline, run
`node --import tsx scripts/bootstrap.ts --historical-migrations --check --json`
with its maintenance connection. Resolve every refusal, take a verified backup,
then run the same command without `--check --json`. This explicit mode applies
only the retained historical migration chain and refuses fresh databases or an
already adopted baseline. It does not adopt the baseline. Follow the catalog
verification and audited adoption steps above before ordinary deployment.

The release rehearsal exercises this path on the oldest and latest supported
releases with populated multi-entity accounting data, then verifies a backup,
adopts the baseline and checks ordinary bootstrap idempotence.

### Restore verification with legacy validation functions

Some historical SQL validators call other functions without a schema qualifier.
`pg_restore` clears the session search path, so a direct restoration can refuse
valid bank matching rules even though the same validators accept them in the
application. Do not bypass the checks or change tenant rows to complete a restore.

On an isolated restoration target, restore pre-data first. Capture the original
function definitions and settings. Temporarily set `search_path=public,pg_catalog`
on application functions that have no explicit search path, restore data and
post-data, then restore those original function settings before any application
connects. Preserve existing explicit search paths, especially security-definer
functions. Verify the restored catalog and financial fingerprints against the
source snapshot. Keep the restoration target isolated until verification passes.

When adoption runs as a database administrator, ensure the installation audit is
included in subsequent backups: grant the dedicated backup login USAGE on
`openbooks_migrations` and SELECT on its audit tables. Keep CREATE, INSERT,
UPDATE and DELETE restricted to the maintenance owner.
