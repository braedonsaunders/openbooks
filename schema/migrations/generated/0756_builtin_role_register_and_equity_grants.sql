-- Existing organizations' built-in roles gain the register and equity grants
-- the built-in catalogue gives them, so administrators and the other built-in
-- roles can use Point of Sale and Equity once the features are enabled.
-- Backfill: each built-in role gains each catalogue grant it lacks, unless it
-- already holds the module wildcard or every permission. Custom roles and
-- grants an administrator removed from a custom role are not changed.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

UPDATE public.app_roles SET permissions = permissions || '["pos.sell"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'admin'
   AND NOT (permissions ? 'pos.sell' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.refund"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'admin'
   AND NOT (permissions ? 'pos.refund' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.override"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'admin'
   AND NOT (permissions ? 'pos.override' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.drawer"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'admin'
   AND NOT (permissions ? 'pos.drawer' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.manage"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'admin'
   AND NOT (permissions ? 'pos.manage' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["equity.read"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'admin'
   AND NOT (permissions ? 'equity.read' OR permissions ? 'equity.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["equity.manage"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'admin'
   AND NOT (permissions ? 'equity.manage' OR permissions ? 'equity.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["equity.approve"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'admin'
   AND NOT (permissions ? 'equity.approve' OR permissions ? 'equity.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.sell"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'controller'
   AND NOT (permissions ? 'pos.sell' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.refund"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'controller'
   AND NOT (permissions ? 'pos.refund' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.override"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'controller'
   AND NOT (permissions ? 'pos.override' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.drawer"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'controller'
   AND NOT (permissions ? 'pos.drawer' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.manage"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'controller'
   AND NOT (permissions ? 'pos.manage' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["equity.read"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'controller'
   AND NOT (permissions ? 'equity.read' OR permissions ? 'equity.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["equity.manage"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'controller'
   AND NOT (permissions ? 'equity.manage' OR permissions ? 'equity.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["equity.approve"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'controller'
   AND NOT (permissions ? 'equity.approve' OR permissions ? 'equity.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["equity.read"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'accountant'
   AND NOT (permissions ? 'equity.read' OR permissions ? 'equity.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["equity.manage"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'accountant'
   AND NOT (permissions ? 'equity.manage' OR permissions ? 'equity.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["equity.read"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'approver'
   AND NOT (permissions ? 'equity.read' OR permissions ? 'equity.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["equity.approve"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'approver'
   AND NOT (permissions ? 'equity.approve' OR permissions ? 'equity.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["equity.read"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'viewer'
   AND NOT (permissions ? 'equity.read' OR permissions ? 'equity.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.sell"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'cashier'
   AND NOT (permissions ? 'pos.sell' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.refund"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'cashier'
   AND NOT (permissions ? 'pos.refund' OR permissions ? 'pos.*' OR permissions ? '*');
UPDATE public.app_roles SET permissions = permissions || '["pos.drawer"]'::jsonb, updated_at = now()
 WHERE is_built_in AND key = 'cashier'
   AND NOT (permissions ? 'pos.drawer' OR permissions ? 'pos.*' OR permissions ? '*');
