# Release migration baseline cutover

A release cut folds every migration into one verified baseline and retires the
replaced SQL. Fresh installations apply the baseline and then the forward
migrations above it, which are numbered again from `0001`. Existing
installations never replay the retired migrations: they complete the previous
release, then adopt the new baseline identity after verification.

`schema/migrations/baseline.json` is the release record. It names the
baseline file and its digest, the digest of its catalog evidence, the previous
release an installation upgrades from (`upgradeFromRelease`), that release's
exact migration ledger (`upgradeFrom`) and every retired migration identity the
baseline covers (`covered`). A forward migration may not reuse a covered
identity.

## Prepare the candidate

Land the release's migration changes before preparation. Preparation may run
while unrelated development continues; its candidate records the commit and
refuses migration inputs that change during the run.

Use the release-pinned PostgreSQL test container. Supply its loopback
administrator URL in `OPENBOOKS_BASELINE_ADMIN_URL`, naming the `postgres`
maintenance database. Remote hosts and tenant database URLs are refused.

```sh
node --import tsx scripts/prepare-migration-baseline.mts --output /absolute/path/to/new-candidate
```

Preparation creates three disposable databases. It installs the tree through
the native bootstrap as a schema-only restore target, so the baseline
reproduces exactly what a fresh deployment receives, including prerequisite
order and every reviewed execution rule, and it refuses unless that
installation's ledger equals the tree's release plan. It then captures the
catalog of `public`, `openbooks_query` and the private `tenant_retirement`
authority: table and view definitions, columns, constraints and their
validation state, index validity, functions, triggers, policies, enum values,
sequence definitions, PUBLIC/read privileges, system-function privileges and
system registry contents. SQL bodies and error messages are compared without
collapsing whitespace. PostgreSQL deparses constraints in its canonical pretty
form so redundant parentheses do not masquerade as changed conditions.

The candidate is the canonical dump of those schemas, the reviewed system seeds
and the system-function privilege changes derived against PostgreSQL's initial
privileges. It is installed into the second database, and into the third with
`pg_trgm` unavailable, and both catalogs must equal the installation's. All
three databases are removed.

The ISO currency registry, module query registry, document-close registry,
scheduling board types, marketplace-nexus rules and platform-settings singleton
are preserved. Installation settings, tenant data and migration ledger evidence
never enter the baseline. Any other nonempty table refuses preparation until
its seed has been reviewed. Required `btree_gist` and `pgcrypto` extensions
accompany the dump; `pg_trgm` retains the established optional-extension
policy.

## Activate on the final tree

On the final committed tree, activate the verified candidate and name the
previous release:

```sh
node scripts/activate-migration-baseline.mjs /absolute/path/to/new-candidate alpha35 --upgrade-from v0.1.0-alpha.34.3
```

Activation refuses uncommitted migration changes, a candidate prepared on a
commit this tree does not descend from, and any migration change since that
commit. It verifies that the named release ships no migration the candidate
does not cover and that the candidate's upgrade ledger is exactly that
release's plan. It writes `baselines/<name>.sql`, its catalog evidence and the
manifest, then retires the replaced inputs: the covered SQL, the previous
baseline and its evidence, their preflight decisions, remedies no remaining
preflight references, and prerequisite declarations for covered migrations.

Commit these changes with the release. Run the release checks, a fresh
installation and the upgrade rehearsal against that exact commit before
tagging. The baseline is immutable after publication; later schema changes use
forward migrations.

The baseline is applied with the maintenance login, because it creates the
private retirement authority and system-function privileges. Bootstrap then
hands every business object to the restricted business owner, the host's
provisioned database owner on host-managed installations, before any forward
migration runs as that owner.

## Upgrade an existing installation

An installation older than `upgradeFromRelease` first upgrades to that release
with that release's image and bootstrap, which applies its remaining
migrations, preflights and application-side upgrade steps. This release's
bootstrap refuses any database that has neither an empty schema nor the adopted
baseline identity; it never executes baseline SQL over tenant data.

Before cutover, retain the previous release image. Take a full backup or
storage snapshot and prove restoration into an isolated database. Rehearse the
adoption on that restored copy.

Set `OPENBOOKS_BASELINE_TARGET_URL` explicitly to the maintenance login for the
named database. The adoption tool does not read application `.env`
credentials.

```sh
node --import tsx scripts/adopt-migration-baseline.mts --database openbooks --check
```

The check requires a superuser or BYPASSRLS maintenance login so no system
registry is hidden. It refuses unless the database records every migration of
the previous release at its published digest: schema equivalence alone cannot
prove that the previous release's data transformations ran. It then verifies
every catalog section and reviewed registry against the release evidence and
preserves existing installation settings.

For the production cutover, stop application and worker services and other
database clients, take the final backup and rerun the check. Adopt only after
the check passes:

```sh
node --import tsx scripts/adopt-migration-baseline.mts --database openbooks --apply \
  --actor 'operator identity' --reason 'verified release schema adoption' \
  --backup 'reference to the verified pre-cutover backup'
```

Adoption shares the deployment bootstrap lock and refuses other client
sessions. It appends the baseline ledger identity and an adoption audit in one
transaction. The audit records the database, login, operator, timestamp,
reason, backup reference, catalog digest and complete previous ledger.
Historical ledger rows and tenant data remain unchanged. The tool does not
execute baseline SQL or correct mismatched schemas; reconcile an installation
whose catalog differs with its database owner before adopting. A second
adoption of the same verified identity makes no writes.

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

When adoption runs as a database administrator, ensure the installation audit is
included in subsequent backups: grant the dedicated backup login USAGE on
`openbooks_migrations` and SELECT on its audit tables. Keep CREATE, INSERT,
UPDATE and DELETE restricted to the maintenance owner.

### Restore verification with unqualified validation functions

Some validators call other functions without a schema qualifier. `pg_restore`
clears the session search path, so a direct restoration can refuse valid bank
matching rules even though the same validators accept them in the
application. Do not bypass the checks or change tenant rows to complete a
restore.

On an isolated restoration target, restore pre-data first. Capture the original
function definitions and settings. Temporarily set `search_path=public,pg_catalog`
on application functions that have no explicit search path, restore data and
post-data, then restore those original function settings before any application
connects. Preserve existing explicit search paths, especially security-definer
functions. Verify the restored catalog and financial fingerprints against the
source snapshot. Keep the restoration target isolated until verification passes.
