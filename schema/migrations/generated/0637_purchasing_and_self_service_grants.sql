-- Purchase orders and goods receipts have their own permissions, and own-time
-- and own-leave requests are self-service grants. Existing holders keep what
-- they could already do: roles, per-user overrides and API key scopes that
-- granted accounts-payable reading or creating also receive the matching
-- purchasing keys. Deny overrides are carried the same way, so no access
-- widens. Built-in roles gain own-leave requests, and the hourly built-in
-- roles gain self-scoped time entry. The built-in Accountant gains
-- reconciliation read access for its monthly review.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

UPDATE app_roles SET permissions = permissions || '["purchase_orders.read"]'::jsonb, updated_at = now()
 WHERE (permissions ? 'ap.read' OR permissions ? 'ap.*')
   AND NOT (permissions ? 'purchase_orders.read' OR permissions ? '*');

UPDATE app_roles SET permissions = permissions || '["purchase_orders.create"]'::jsonb, updated_at = now()
 WHERE (permissions ? 'ap.create' OR permissions ? 'ap.*')
   AND NOT (permissions ? 'purchase_orders.create' OR permissions ? '*');

UPDATE app_roles SET permissions = permissions || '["goods_receipts.create"]'::jsonb, updated_at = now()
 WHERE (permissions ? 'ap.create' OR permissions ? 'ap.*')
   AND NOT (permissions ? 'goods_receipts.create' OR permissions ? '*');

INSERT INTO user_permission_overrides (org_id, user_id, permission, effect)
SELECT DISTINCT o.org_id, o.user_id, m.new_key, o.effect
  FROM user_permission_overrides o
  JOIN (VALUES ('ap.read', 'purchase_orders.read'),
               ('ap.create', 'purchase_orders.create'),
               ('ap.create', 'goods_receipts.create'),
               ('ap.*', 'purchase_orders.read'),
               ('ap.*', 'purchase_orders.create'),
               ('ap.*', 'goods_receipts.create')) AS m(old_key, new_key)
    ON m.old_key = o.permission
-- An explicit override a user already holds for the new key keeps deciding it.
ON CONFLICT (user_id, permission) DO NOTHING;

UPDATE api_keys SET scopes = scopes || '["purchase_orders.read"]'::jsonb
 WHERE (scopes ? 'ap.read' OR scopes ? 'ap.*') AND NOT (scopes ? 'purchase_orders.read' OR scopes ? '*');

UPDATE api_keys SET scopes = scopes || '["purchase_orders.create", "goods_receipts.create"]'::jsonb
 WHERE (scopes ? 'ap.create' OR scopes ? 'ap.*')
   AND NOT (scopes ? 'purchase_orders.create' OR scopes ? 'goods_receipts.create' OR scopes ? '*');

UPDATE app_roles SET permissions = permissions || '["hrm.leave.request"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key <> 'admin' AND NOT (permissions ? 'hrm.leave.request' OR permissions ? '*');

UPDATE app_roles SET permissions = permissions || '["time.self"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key IN ('admin', 'production', 'sales_manager', 'sales_rep')
   AND NOT (permissions ? 'time.self' OR permissions ? '*');

-- The built-in Accountant reviews bank and card reconciliations as part of
-- the monthly books review; reconciling stays with the controller.
UPDATE app_roles SET permissions = permissions || '["banking.read"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'accountant'
   AND NOT (permissions ? 'banking.read' OR permissions ? 'banking.*' OR permissions ? '*');
