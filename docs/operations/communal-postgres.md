# Communal / hosted Postgres (proposal)

## The Issue

OpenBooks creates PostgreSQL roles such as `openbooks_read` during bootstrap
and uses `SET ROLE openbooks_read`. These operations require privileges
unavailable to tenant logins on shared PostgreSQL.

A dedicated PostgreSQL instance works, but it does not scale efficiently.
Granting tenants `CREATEROLE` is also not acceptable.

## How Other Apps Work

Applications such as n8n, Twenty, Outline, and Listmonk use a single
constrained login for migrations and runtime without creating roles during
startup.

## Proposed Change

Please add a pre-created roles mode where:

1. The platform creates `openbooks_read` and grants it to the tenant login.
2. Bootstrap skips privileged `CREATE ROLE` and `ALTER ROLE` operations but
   still completes migrations and seeding.
3. Migration and runtime can use the same constrained login.
4. Installation fails clearly if the required role or grant is missing.
5. Existing bootstrap behavior remains unchanged when this mode is disabled.

```bash
OPENBOOKS_PRECREATED_ROLES=1
OPENBOOKS_MIGRATION_DB_URL=postgres://tenant:…@host/db
OPENBOOKS_DB_URL=postgres://tenant:…@host/db
OPENBOOKS_RUNTIME_DB_URL=postgres://tenant:…@host/db
```
