# Backup, restore, and recovery drills

OpenBooks has two different recovery scopes. Treating them as interchangeable
can produce an incomplete recovery.

| Scope | Captures | Does not capture |
| --- | --- | --- |
| Organization archive | One organization's PostgreSQL rows, durable MFA factors and OIDC identities for its home users, in one repeatable-read snapshot, plus a SHA-256 manifest and schema fingerprint | S3/MinIO object bytes, deployment secrets, shared/global rows, Redis state, live sessions/challenges/lockout state, cross-tenant access grants, or the surrounding database |
| Deployment recovery | PostgreSQL, object storage, required secrets/configuration, and release identity | Nothing unless the operator includes every component and proves the restore |

An organization archive is useful for tenant-level recovery and portability. A
provider-native PostgreSQL backup plus object-storage protection remains the
primary disaster-recovery mechanism. Define an RPO and RTO, use off-host and
versioned/immutable copies where supported, and run the drill below on a
schedule. A backup that has not been restored is unverified.

## Organization archive

### Create the archive and record integrity evidence

Run against the source deployment with an absolute output path on encrypted,
operator-controlled storage:

```bash
cd engine
npx tsx src/backup-local-cli.ts \
  --org=00000000-0000-4000-8000-000000000000 \
  --out=/secure/openbooks/acme-backup.json.gz
```

The command writes the gzip archive and an adjacent
`.manifest.json`, both mode `0600`. It refuses to overwrite either file. The
manifest records the SHA-256, organization, table count, and row count. Keep the
archive and manifest together, but copy them to a failure domain separate from
the OpenBooks host. The adjacent manifest detects corruption only if its hash is
retained through a separately trusted channel (for example immutable backup
catalog metadata or a signed evidence log); an attacker who can replace both
files can replace the unsigned hash too.

The admin UI follows the same rule for stored backups: select **Archive** and
**Manifest** for the same completed row. It shows the full SHA-256 and the
archive response also carries `Content-Digest` and `X-OpenBooks-SHA256` headers.
The former one-response **Download now** stream is disabled because a hash known
only after streaming cannot provide a precomputed integrity sidecar; it is not a
supported restore input.

The archive can contain financial records, password hashes, personal data, and
encrypted provider configuration and MFA seeds. Apply the same access,
retention, residency, and incident-response rules as the live database.

The exporter checks every ordinary foreign key from an included row to another
archived table. If a row points outside the organization, export stops before
writing a valid footer. This deliberately rejects, for example, a sandbox whose
`orgs.sandbox_of` points at its production org and a production change set whose
`sandbox_org_id` points at a separate sandbox. Use full-deployment recovery (or
first reconcile/remove that relationship); a one-org archive is not a hidden
multi-org bundle.

`user_org_access` is intentionally excluded. An incoming grant can point to a
home login identity owned by another tenant, so copying it would either leak the
other tenant's identity or produce a broken foreign key. Review and re-create
approved cross-tenant grants after restore. Durable `auth_mfa_factors` and
issuer/subject-scoped `auth_oidc_identities` for users whose home org is being
archived are included. Incomplete MFA enrollment rows (`enabled_at is null`)
are short-lived session-bound state and are excluded. Enabled factors carry
versioned, per-code salted recovery hashes that do not depend on the rotatable
`SESSION_SECRET`; restore rejects an unknown hash format. `auth_sessions`, `auth_login_challenges`,
`auth_login_state`, and `auth_login_events` are not: restore must not revive a
bearer credential, a half-finished login, stale lockout state, or a partial
security ledger.

### What format v3 proves

Before any restore write, OpenBooks:

- hashes the compressed bytes and compares the result with the manifest;
- decrypts a format-level AEAD canary before database access, proving the
  configured `OPENBOOKS_DATA_KEY` is the source key even when the tenant has no
  MFA factors or other encrypted rows;
- validates every row envelope and rejects rows crossing the organization boundary;
- reconciles every per-table count and the total against the archive footer;
- compares the archive's deterministic table/column, constraint, and tracked-migration fingerprint with the target; and
- spools numeric JSON verbatim, avoiding JavaScript-number precision loss.

Format-v1 archives predate the schema fingerprint. They are refused by default.
`--allow-legacy-v1` is an exceptional override, not a compatibility promise;
use it only after independently proving the source and target migration catalogs
are identical.

Format-v2 archives have a schema fingerprint but predate the data-key canary.
They are also refused by default. The exceptional
`--allow-legacy-v2-without-key-check` override is only for an operator who has
independently proven that `OPENBOOKS_DATA_KEY` is the source key; an archive
with no decryptable ciphertext cannot prove that fact itself.

### Restore into an isolated empty target

1. Stop web and worker processes. Select the exact source OpenBooks release or
   image, not a newer release.
2. Create a new empty PostgreSQL database. Do not point the restore at the live
   database.
3. Bootstrap only the source schema and shared currency registry:

   ```bash
   OPENBOOKS_BOOTSTRAP=1 \
   OPENBOOKS_RESTORE_TARGET=1 \
   OPENBOOKS_MIGRATION_DB_URL=postgres://schema_owner:REDACTED@db/openbooks_restore \
   OPENBOOKS_RUNTIME_DB_URL=postgres://openbooks_app:REDACTED@db/openbooks_restore \
   OPENBOOKS_DB_PASSWORD=REDACTED \
   NODE_ENV=production \
   npx tsx scripts/bootstrap.ts
   ```

   Restore-target bootstrap refuses a database that already contains an
   organization. It does not seed an organization or administrator.
4. Run the offline restore using the controlled schema-owner connection:

   ```bash
   OPENBOOKS_RESTORE_DB_URL=postgres://schema_owner:REDACTED@db/openbooks_restore \
   OPENBOOKS_DATA_KEY=SOURCE_32_BYTE_KEY_FROM_SECRET_MANAGER \
   SESSION_SECRET=SOURCE_SESSION_SECRET_FROM_SECRET_MANAGER \
   NODE_ENV=production \
   npx tsx engine/src/backup-restore-cli.ts \
     --in=/secure/openbooks/acme-backup.json.gz \
     --manifest=/secure/openbooks/acme-backup.json.gz.manifest.json \
     --org=00000000-0000-4000-8000-000000000000 \
     --confirm-empty-target=00000000-0000-4000-8000-000000000000 \
     --report=/secure/openbooks/acme-restore-report.json
   ```

The CLI never falls back to `OPENBOOKS_DB_URL`; the dedicated restore URL is
required. It also requires a destructive acknowledgement that repeats the
organization UUID exactly and verifies zero
organizations inside the same transaction. Historical transition triggers are
disabled transactionally while rows are loaded because replaying final-state
history through creation-time triggers is not semantically valid. Foreign keys
remain enforced. Before commit, the restore re-enables triggers, forces deferred
constraints immediate, checks tenant references, checks balanced posted journal
entries, and verifies the organization root. Failure rolls back data and trigger
state together. Because an organization archive does not replay Redis queue
state—and a stored backup snapshots its own ledger row while it is running—the
restore marks archived `queued` or `running` backup runs failed with an explicit
recovery reason. This prevents phantom work from blocking future backups.

The restore also authenticates every restored MFA ciphertext inside the
uncommitted transaction; plaintext is never printed or returned. A missing or
wrong source key is rejected by the archive-level canary before database access,
so MFA, connection, bank, payment, provider, and TIN ciphertext cannot silently
be restored under a different key.

Organization email-provider credentials are a distinct legacy case: they are
AES-GCM sealed under a key derived from `SESSION_SECRET`. If the archived
organization has one, restore authenticates it inside the same uncommitted
transaction and fails unless the source `SESSION_SECRET` is present. Preserve
both source keys for recovery; session invalidation after a full deployment
restore does not authorize discarding the old secret before encrypted email
configuration has been re-sealed or explicitly reset.

`--reset-mfa` is an explicit factor-revocation option, not a data-key bypass.
The source key remains mandatory; the report records factors removed and OIDC
identities remain issuer-scoped and intact. Keep the target off the public
network, notify affected users, reset credentials according to the incident
response policy, require supervised MFA re-enrollment, and verify the IdP
issuer/client configuration before admitting normal traffic. If the source data
key is irretrievably unavailable, this organization archive cannot safely make
the encrypted fields usable; recover the key or execute a separately reviewed
credential-reset/migration incident procedure.

   The report is written only after commit and is created mode `0600` without
overwriting existing evidence.

For a scheduled/stored backup, download its authenticated UI manifest and pass
it as `--manifest`. A controlled operator can alternatively pass the full
SHA-256 recorded in its completed `backup_runs` ledger entry as
`--sha256=<64-lowercase-hex>`. Exactly one evidence source is required. Do not
copy a hash from an unauthenticated location next to a suspect archive.

### Object storage is a separate required recovery set

Organization archives contain file metadata and storage keys, not the bytes in
S3 or MinIO. Before starting the restored application, recover the corresponding
bucket/version snapshot using the storage provider's supported procedure. Keep
the original `OPENBOOKS_DATA_KEY`; changing it makes encrypted provider
configuration unreadable. Restore or intentionally rotate other credentials,
then verify every external integration before enabling it.

If object storage cannot be recovered, the database restore may succeed while
attachments and generated artifacts remain missing. Do not call that a complete
recovery.

## Full deployment disaster recovery

For production, prefer managed PostgreSQL continuous backup/PITR and
cross-failure-domain S3 versioning or replication. Retain:

- a restorable PostgreSQL base backup and WAL/PITR history;
- the complete object-storage bucket and versions required by retention policy;
- the exact application image digest and infrastructure versions;
- `.env`/secret-manager values, especially `OPENBOOKS_DATA_KEY` and the source
  `SESSION_SECRET` needed by encrypted organization email configuration;
- TLS, DNS, email, identity-provider, network-policy, and monitoring configuration; and
- the tested recovery runbook and prior drill reports.

For a small Compose installation, an offline `pg_dump --format=custom` taken
while web and worker are stopped is a portable database copy. Volume snapshots
are acceptable only when the PostgreSQL and object-store procedures explicitly
support them and their point-in-time consistency is understood. Never copy a
live PostgreSQL data directory as ordinary files.

Restore a deployment backup into new infrastructure. Verify checksums before
opening it, recover PostgreSQL and object storage, apply the original data key
and source `SESSION_SECRET`, and, before exposing web traffic, invalidate point-in-time active authentication
state:

```sql
begin;
delete from auth_sessions;
delete from auth_login_challenges;
delete from auth_login_state;
commit;
```

Historical `auth_login_events` remain security evidence and do not grant
access. Start the original image version, verify OIDC issuer/client settings,
exercise MFA with test users, and run application health plus accounting checks.
Upgrade only after that baseline recovery passes.

## Required drill evidence

Record at least:

- source release and immutable image digest;
- backup identifiers, timestamps, SHA-256 values, and storage versions;
- target isolation evidence;
- measured backup age, RPO, restore duration, and RTO;
- restored table/row counts and the CLI restore report;
- PostgreSQL constraint and posted-ledger validation results;
- attachment sampling across object-storage prefixes;
- MFA ciphertext/decryption or approved reset evidence, OIDC issuer mapping,
  proof that no session/challenge was revived, re-created cross-tenant grants,
  authorization, worker, report, and representative posting checks; and
- the operator, reviewer, exceptions, and follow-up actions.

CI runs the opt-in database-backed restore drill in
`engine/src/backup-restore.integration.test.ts`. It creates an organization,
exports it, removes it, restores it, validates constraints, accounting counts,
durable MFA/OIDC recovery, transient-auth exclusion, and the explicit MFA-reset
path. A separate case proves sandbox and change-set cross-org foreign keys are
rejected. This is product evidence, not a substitute for restoring each
deployment's real backup topology.
