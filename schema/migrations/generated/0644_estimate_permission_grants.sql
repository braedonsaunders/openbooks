-- OpenBooks forward migration 0644_estimate_permission_grants.
--
-- Estimates have their own permissions, separate from the receivables book:
-- estimates.read sees quotes, estimates.create authors and edits them, and
-- estimates.issue decides them (quotes issue rather than approve). Existing
-- holders keep what they could already do: roles, per-user overrides and
-- API key scopes that granted accounts-receivable reading or creating also
-- receive the matching estimates keys. Deny overrides are carried the same
-- way, so no access widens.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

UPDATE app_roles SET permissions = permissions || '["estimates.read"]'::jsonb, updated_at = now()
 WHERE (permissions ? 'ar.read' OR permissions ? 'ar.*')
   AND NOT (permissions ? 'estimates.read' OR permissions ? '*');

UPDATE app_roles SET permissions = permissions || '["estimates.create"]'::jsonb, updated_at = now()
 WHERE (permissions ? 'ar.create' OR permissions ? 'ar.*')
   AND NOT (permissions ? 'estimates.create' OR permissions ? '*');

UPDATE app_roles SET permissions = permissions || '["estimates.issue"]'::jsonb, updated_at = now()
 WHERE (permissions ? 'ar.create' OR permissions ? 'ar.*')
   AND NOT (permissions ? 'estimates.issue' OR permissions ? '*');

INSERT INTO user_permission_overrides (org_id, user_id, permission, effect)
SELECT DISTINCT o.org_id, o.user_id, m.new_key, o.effect
  FROM user_permission_overrides o
  JOIN (VALUES ('ar.read', 'estimates.read'),
               ('ar.create', 'estimates.create'),
               ('ar.create', 'estimates.issue'),
               ('ar.*', 'estimates.read'),
               ('ar.*', 'estimates.create'),
               ('ar.*', 'estimates.issue')) AS m(old_key, new_key)
    ON m.old_key = o.permission
-- An explicit override a user already holds for the new key keeps deciding it.
ON CONFLICT (user_id, permission) DO NOTHING;

UPDATE api_keys SET scopes = scopes || '["estimates.read"]'::jsonb
 WHERE (scopes ? 'ar.read' OR scopes ? 'ar.*') AND NOT (scopes ? 'estimates.read' OR scopes ? '*');

UPDATE api_keys SET scopes = scopes || '["estimates.create", "estimates.issue"]'::jsonb
 WHERE (scopes ? 'ar.create' OR scopes ? 'ar.*')
   AND NOT (scopes ? 'estimates.create' OR scopes ? 'estimates.issue' OR scopes ? '*');
