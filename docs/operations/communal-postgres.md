# Shared / host-managed PostgreSQL

Set `OPENBOOKS_PRECREATED_ROLES=1` on the one-shot bootstrap process when the
database host provisions roles. OpenBooks verifies the supplied roles instead
of creating roles, changing their attributes/passwords, or granting role
memberships. It still applies every migration, maintains application-object
grants and default privileges, verifies forced RLS and governed queries, and
seeds the organization and administrator. A refusal exits nonzero; do not start
web or workers unless bootstrap succeeds.

This supports PostgreSQL 16+ with a database per OpenBooks installation on a
shared cluster. The migration login needs ownership/DDL rights inside that
database, but neither login needs `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`,
`CREATEDB`, replication, or privileged file/server roles. A host that supplies
only one login must provision a second login before using this mode.

## Provider provisioning

The host runs the following once, using its provisioning administrator. Replace
the example database, owner, and application names with installation-specific
names, and supply distinct random passwords of at least 24 characters. Do not
put real passwords in shell history. Run `CREATE DATABASE` outside a transaction.

```sql
CREATE ROLE tenant_books_owner LOGIN INHERIT NOSUPERUSER NOBYPASSRLS
  NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'replace-with-owner-password';
CREATE ROLE tenant_books_app LOGIN INHERIT NOSUPERUSER NOBYPASSRLS
  NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'replace-with-runtime-password';

-- Cluster-wide: create once, or verify the existing role has this posture.
CREATE ROLE openbooks_read NOLOGIN NOSUPERUSER NOBYPASSRLS
  NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT openbooks_read TO tenant_books_app WITH INHERIT FALSE, SET TRUE;
GRANT tenant_books_app TO tenant_books_owner WITH INHERIT TRUE, SET TRUE;

CREATE DATABASE tenant_books OWNER tenant_books_owner;
REVOKE ALL ON DATABASE tenant_books FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE tenant_books TO tenant_books_app;
```

Connect the provisioning administrator to `tenant_books`, then run:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO tenant_books_owner;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
-- Optional search acceleration; ordinary substring search works without it.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
```

The runtime login also needs `EXECUTE` on
`pg_catalog.set_config(text,text,boolean)`, which PostgreSQL grants through
`PUBLIC` by default. If the host has revoked it, the host must grant it to
`tenant_books_app` in this database. Bootstrap verifies this prerequisite and
does not attempt to administer PostgreSQL catalog-function privileges in this
mode.

The owner inherits the runtime role so its `SECURITY DEFINER` query-context
helper can read the runtime-owned temporary context table. This is one-way:
**never grant the owner role to the runtime role**. The runtime login must not
own application objects, inherit their owners, or have database/schema CREATE
rights. `openbooks_read` must have no login, no memberships in other roles, and
no access to base tables or writes. Migrations grant it SELECT on the governed
`openbooks_query` views and execution of the query-context helper.

PostgreSQL roles are cluster-wide. The current query-role name is fixed as
`openbooks_read`; do not grant it CONNECT to installation databases or ownership
of application objects. The host must revoke PUBLIC database access and ensure
each installation's logins cannot connect to other installation databases,
including through inherited grants or host authentication rules. Apply this
isolation to every hosted database; merely having different database names is
not isolation. No schema-per-installation mode is provided.

## Bootstrap and runtime configuration

The bootstrap process receives:

```dotenv
OPENBOOKS_BOOTSTRAP=1
OPENBOOKS_PRECREATED_ROLES=1
OPENBOOKS_MIGRATION_DB_URL=postgres://tenant_books_owner:OWNER_PASSWORD@db:5432/tenant_books
OPENBOOKS_RUNTIME_DB_URL=postgres://tenant_books_app:RUNTIME_PASSWORD@db:5432/tenant_books
OPENBOOKS_DB_URL=postgres://tenant_books_app:RUNTIME_PASSWORD@db:5432/tenant_books
ORG_NAME=My Company
ORG_COUNTRY=US
ORG_CURRENCY=USD
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=REPLACE_WITH_RANDOM_ADMIN_PASSWORD
```

Use your organization's actual country/currency, supply the normal encryption
and application configuration from `.env.example`, and URL-encode credentials.
Both database URLs must use the same host, port, and database. Run
`node scripts/bootstrap.mjs` in the production image, or
`npx tsx scripts/bootstrap.ts` from a source checkout. The stock Compose stack
provisions its own PostgreSQL; for an external host, configure a bootstrap job
and web/worker services with these external URLs instead. On Kubernetes, add
`OPENBOOKS_PRECREATED_ROLES=1` to the bootstrap Job environment.

Web and workers receive only `OPENBOOKS_DB_URL` with the runtime login, plus
their normal application configuration. Do not supply the migration credential
or `OPENBOOKS_BOOTSTRAP=1` to runtime processes. The provider owns password
rotation; update the corresponding deployment secret after rotating it.

## Upgrades and troubleshooting

Use the same one-shot bootstrap on every upgrade. It retains migration digests,
the deployment advisory lock, default grants for future tables/sequences, and
idempotent seeding. Existing application objects must be owned by the migration
role (or a role it inherits); ask the host to reconcile ownership before an
upgrade rather than granting administrative privileges to the application.

Preflight names missing extensions, unsafe roles, missing ownership, and
unusable read-role memberships before migration work. In particular,
`INHERIT TRUE` does not imply `SET TRUE`: the host must permit the runtime and
migration logins to `SET ROLE openbooks_read`. Post-migration verification checks
effective object permissions, and the runtime connection must demonstrate both
unscoped RLS denial and a working governed-query context.

`OPENBOOKS_PRECREATED_ROLES` accepts only `0` or `1`; unset/`0` keeps the existing
automatic role provisioning. Do not combine this mode with
`OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION` (legacy migration-only operation)
or `OPENBOOKS_TEST_OWNERSHIP_TRANSFER` (test provisioning). Switching back to
automatic provisioning requires a provisioning administrator; disabling the
flag does not grant the migration login additional privileges. Neither mode
deletes application data or rewrites published migrations.

Thanks to Adam at StackBlaze for proposing and helping shape this installation
path in [PR #29](https://github.com/braedonsaunders/openbooks/pull/29).
