# Communal / hosted Postgres (proposal)

## How other apps work on shared Postgres

On hosts with logical (shared-server) databases, the app gets one tenant LOGIN
that owns its database and **does not** have `CREATEROLE`. Apps like n8n,
Twenty, Outline, Listmonk migrate and run as that single role:

```text
postgres://$(tenant):$(password)@$(host)/$(database)
```

No second roles. No `CREATE ROLE` at boot. That is the normal contract.

## Why OpenBooks fails today

OpenBooks bootstrap always creates cluster roles (`openbooks_read`, and usually
a separate runtime LOGIN) and the SQL console uses `SET ROLE openbooks_read`.
A tenant LOGIN cannot do that, so install fails on shared Postgres. Giving
every install a dedicated Postgres cluster works but does not scale for hosts
with limited volumes.

We will not grant tenants `CREATEROLE` (cluster-global; breaks isolation).

## Ask

A production mode where the platform pre-creates `openbooks_read` and grants
it to the tenant role, and bootstrap **skips** `CREATE ROLE` / privileged
`ALTER ROLE` — still running full migrate + seed. Migration and runtime may
use the same constrained LOGIN (like other apps). Fail loudly if the role or
grant is missing. Dedicated bootstrap stays the default when the flag is off.

```bash
OPENBOOKS_PRECREATED_ROLES=1   # name flexible
OPENBOOKS_MIGRATION_DB_URL=postgres://tenant:…@host/db
OPENBOOKS_DB_URL=…             # same
OPENBOOKS_RUNTIME_DB_URL=…     # same
```

```sql
CREATE ROLE openbooks_read NOLOGIN;          -- once per shared cluster
GRANT openbooks_read TO "<tenant_login>";  -- per OpenBooks tenant
```

## Acceptance

- Precreated role + grant → full bootstrap without `CREATEROLE`
- Missing role/grant → clear error
- Health, login, and governed SQL (`SET ROLE openbooks_read`) still work
- Privileged path unchanged when the flag is off
