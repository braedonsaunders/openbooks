-- OpenBooks forward migration 0031_api_key_explicit_scopes.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction).
--
-- Audit finding: api_keys.scopes shipped with DEFAULT '[]' and the API-key
-- resolver treated an empty scope array as "inherit the owner's full
-- effective permission set". A missing or empty scopes field — in the admin
-- UI, the POST/PATCH API, or any direct write — therefore minted a
-- full-financial-access credential in silence, contradicting the scoped-token
-- contract (every key carries an explicit subset of the permission
-- catalogue). An omitted selection must be a rejected request, never a
-- powerful key.
--
-- This migration preserves existing intent safely by freezing each legacy
-- empty scope set into an EXPLICIT snapshot of the permission catalogue as it
-- exists at migration time: those keys demonstrably meant "the owner's whole
-- effective set", so they keep exactly that ceiling — but as recorded
-- permissions that never grow on their own. Future catalogue additions do NOT
-- propagate to snapshotted keys; a key that should cover new permissions is
-- re-granted deliberately through the audited PATCH contract. The owner
-- intersection still applies on every request, so no snapshotted key can ever
-- exceed its owner.
--
-- After the backfill, storage itself rejects the empty shape for every
-- writer — API, import, and direct SQL alike: a CHECK requires a non-empty
-- JSON array and the '[]' default is dropped, so a scope set must be stated
-- explicitly. There is deliberately no wildcard, sentinel, or inherit marker:
-- explicitly selecting catalogue permissions is the only grant contract.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Snapshot of the current permission catalogue (engine/src/permissions.ts,
-- PERMISSION_CATALOGUE, at the time 0031 shipped). Frozen here on purpose:
-- the migration's meaning must never shift when the catalogue evolves.
DO $api_key_explicit_scopes_backfill$
BEGIN
  UPDATE public.api_keys
     SET scopes = '[
  "gl.read",
  "gl.manage",
  "gl.post",
  "periods.manage",
  "close.read",
  "close.run",
  "close.approve",
  "close.reopen",
  "ap.read",
  "ap.create",
  "ap.approve",
  "ap.post",
  "ap.pay",
  "ar.read",
  "ar.create",
  "ar.approve",
  "ar.post",
  "ar.pay",
  "crm.accounts.read",
  "crm.accounts.create",
  "crm.accounts.manage",
  "crm.accounts.assign",
  "crm.activities.read",
  "crm.activities.manage",
  "crm.opportunities.read",
  "crm.opportunities.manage",
  "crm.opportunities.close",
  "crm.forecasts.read",
  "crm.forecasts.manage",
  "crm.forecasts.override",
  "crm.setup.manage",
  "reports.read",
  "reports.create",
  "reports.schedule",
  "budgets.read",
  "budgets.manage",
  "budgets.approve",
  "insights.read",
  "insights.create",
  "insights.publish",
  "items.read",
  "items.manage",
  "items.post",
  "items.reverse",
  "projects.read",
  "projects.manage",
  "compliance.read",
  "compliance.manage",
  "compliance.verify",
  "compliance.waive",
  "compliance.file",
  "assets.read",
  "assets.manage",
  "time.read",
  "time.manage",
  "time.approve",
  "time.reopen",
  "payroll.read",
  "payroll.manage",
  "payroll.run",
  "records.read",
  "records.create",
  "records.manage_types",
  "assistant.use",
  "assistant.write",
  "sql.execute",
  "sync.run",
  "data.export",
  "data.import",
  "scripts.manage",
  "scripts.execute",
  "flows.manage",
  "flows.approve",
  "apps.use",
  "apps.manage",
  "documents.read",
  "documents.manage",
  "parties.read",
  "parties.manage",
  "banking.read",
  "banking.reconcile",
  "expenses.create",
  "expenses.read",
  "admin.custom_fields.manage",
  "admin.users.manage",
  "admin.roles.manage",
  "admin.nav.manage",
  "admin.customization.manage",
  "admin.setup.manage",
  "admin.audit.read",
  "admin.ai.manage",
  "admin.sandboxes.manage",
  "admin.backups.manage",
  "api.keys.manage"
]'::jsonb
   WHERE scopes = '[]'::jsonb;

  IF FOUND THEN
    RAISE NOTICE 'api_key_explicit_scopes: legacy empty scope sets frozen as the explicit catalogue snapshot';
  END IF;
END
$api_key_explicit_scopes_backfill$;

-- The '[]' default would insert straight into CHECK violation for every
-- future writer that omits scopes; dropping it makes the explicit statement
-- of scopes mandatory at write time.
ALTER TABLE public.api_keys
  ALTER COLUMN scopes DROP DEFAULT;

-- Storage owns the invariant: a scope set is a non-empty JSON array. Every
-- other malformed shape (objects, scalars, arrays of non-strings) stays
-- representable at the storage layer but fails closed at the resolver, which
-- grants only exact catalogue keys.
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_scopes_non_empty
  CHECK (jsonb_typeof(scopes) = 'array' AND jsonb_array_length(scopes) > 0)
  NOT VALID;

ALTER TABLE public.api_keys
  VALIDATE CONSTRAINT api_keys_scopes_non_empty;

COMMENT ON CONSTRAINT api_keys_scopes_non_empty ON public.api_keys IS
  'openbooks:api_keys_scopes_non_empty:v1 - a key grants only the catalogue permissions stated explicitly in scopes; empty scope sets are unrepresentable and never inherit the owner''s permissions';

COMMENT ON COLUMN public.api_keys.scopes IS
  'Explicit subset of the permission catalogue this key grants (intersected with the owner''s effective permissions at request time). Never empty: legacy empty sets were frozen to the catalogue snapshot by migration 0031, and storage rejects new ones.';
