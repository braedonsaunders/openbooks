-- OpenBooks forward migration 0649_cash_sales_deposit_grants.
--
-- Till drops have their own permission, separate from authoring and posting
-- cash sales: cash_sales.deposit records a bank drop from a posted cash
-- sale. Existing holders keep what they could already do: roles, per-user
-- overrides and API key scopes that granted cash-sale posting also receive
-- the deposit key. Posting already moves till money, so no access widens;
-- create-only sales roles stay excluded. Deny overrides are carried the
-- same way. An explicit override or scope a holder already carries for the
-- new key keeps deciding it.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

UPDATE app_roles SET permissions = permissions || '["cash_sales.deposit"]'::jsonb, updated_at = now()
 WHERE (permissions ? 'cash_sales.post' OR permissions ? 'cash_sales.*')
   AND NOT (permissions ? 'cash_sales.deposit' OR permissions ? '*');

INSERT INTO user_permission_overrides (org_id, user_id, permission, effect)
SELECT DISTINCT o.org_id, o.user_id, m.new_key, o.effect
  FROM user_permission_overrides o
  JOIN (VALUES ('cash_sales.post', 'cash_sales.deposit'),
               ('cash_sales.*', 'cash_sales.deposit')) AS m(old_key, new_key)
    ON m.old_key = o.permission
-- An explicit override a user already holds for the new key keeps deciding it.
ON CONFLICT (user_id, permission) DO NOTHING;

UPDATE api_keys SET scopes = scopes || '["cash_sales.deposit"]'::jsonb
 WHERE (scopes ? 'cash_sales.post' OR scopes ? 'cash_sales.*')
   AND NOT (scopes ? 'cash_sales.deposit' OR scopes ? '*');
