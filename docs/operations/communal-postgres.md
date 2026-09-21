# Communal / hosted Postgres (proposal)

Hosts that offer **logical** (shared-server) Postgres give apps a tenant
LOGIN without `CREATEROLE`. OpenBooks bootstrap still does
`CREATE ROLE openbooks_read` (and usually a second runtime role), so install
fails on those databases.

## Ask

A production mode where the platform pre-creates `openbooks_read` and grants
it to the tenant role, and bootstrap **skips** `CREATE ROLE` / privileged
`ALTER ROLE` — still running full migrate + seed. Migration and runtime may
use the same constrained LOGIN. Fail loudly if the role or grant is missing.
Dedicated bootstrap stays the default when the flag is off.

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

Do not grant tenants `CREATEROLE`.

## Acceptance

- Precreated role + grant → full bootstrap without `CREATEROLE`
- Missing role/grant → clear error
- Health, login, and governed SQL (`SET ROLE openbooks_read`) still work
- Privileged path unchanged when the flag is off
