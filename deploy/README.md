# Swarm (Dokploy) production deploys

Releases go out through `swarm-release.sh`: migrations run first from the
exact image digest being released, and only then is the stack repointed.
Compose ordering primitives (`depends_on`) are ignored in stack mode, so the
script is the ordering. Read its header comment (`OPERATOR SETUP`) alongside
this file before your first release with it.

## Database: two logins, never one

Web/worker serve application traffic as a **non-owner runtime login**;
migrations run as the **schema-owner login**. Serving as the owner lets the
application `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` / `DROP POLICY` its
own isolation away, so the release refuses to deploy unless both logins are
present and different — and bootstrap refuses again in production if they
ever collapse into one.

One-time setup, as the database administrator (details and the full
least-privilege posture in `docs/operations/communal-postgres.md`):

```sql
CREATE ROLE openbooks_runtime LOGIN NOSUPERUSER NOBYPASSRLS
  NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<24+ random characters>';
GRANT CONNECT, TEMPORARY ON DATABASE <database> TO openbooks_runtime;
-- Fresh installs only: the migration owner needs database CREATE to create
-- schemas (existing installs already have them).
GRANT CREATE ON DATABASE <database> TO <owner>;
-- The runtime verification needs the governed read role assumable by the
-- runtime login, and the migration owner inheriting the runtime login (so
-- its SECURITY DEFINER query-context helper can read runtime temp tables).
-- Create openbooks_read once per cluster if it is absent.
GRANT openbooks_read TO openbooks_runtime WITH INHERIT FALSE, SET TRUE;
GRANT openbooks_runtime TO <owner> WITH INHERIT TRUE;
-- Tenant context plumbing: harmless when the default PUBLIC grant is
-- intact, required when the host has tightened pg_catalog.
GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO openbooks_runtime;
```

Division of labour: the operator pre-creates the logins and the grants
above; bootstrap (constrained mode, inside the release) then grants the
runtime login table/sequence privileges on every object including ones the
release itself creates, sets default privileges for future objects, revokes
function execute, proves the login owns nothing, and RLS-proves it — all
before the digest swap. The operator never grants on tables directly.

Preflight before the first release with the new login (connect as
`openbooks_runtime`; all three must hold on a cluster that already has
data):

```sql
select current_user; -- openbooks_runtime
select has_function_privilege('pg_catalog.set_config(text,text,boolean)', 'EXECUTE'); -- true
select count(*) from orgs; -- 0: FORCE RLS denies cross-tenant reads without a tenant context
```

Then, in the Dokploy stack env:

- `OPENBOOKS_DB_URL` = the **runtime** login URL (web/worker serve with this).
- `OPENBOOKS_MIGRATION_DB_URL` = the **schema-owner** login URL (migrations
  only; never served, never given to web/worker).

The first release with both wired runs the migration chain as the owner,
grants the runtime login application privileges on every table (including
tables the release itself creates), proves it owns nothing, and RLS-proves
it — all before the digest swap. A failure aborts the release with the
previous version still serving.

## Object storage: dedicated app identity

Give the stack a dedicated object-storage user scoped to the app bucket for
`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` — never the store's root/admin
credentials (Compose provisions this as `MINIO_APP_USER` via minio-init;
see the HA README for the equivalent `mc admin user add` + bucket-scoped
policy + `mc admin policy set` sequence).

## Worker grace period

The worker drains queues on SIGTERM before its connections close
(`engine/src/worker/index.ts`). Size the ceiling to the longest job window
and mirror it on the worker service in the Dokploy compose file (Compose
uses `stop_grace_period: 5m` for the same reason):

```yaml
services:
  worker:
    stop_grace_period: 5m
```

Without it the orchestrator SIGKILLs mid-drain and in-flight jobs re-run
after restart.
