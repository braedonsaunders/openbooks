-- OpenBooks forward migration 0384_asset_category_unconfigured_accounts.
-- A first-use "Uncategorised" category must be representable as explicitly
-- unconfigured instead of carrying arbitrary fallback accounts: drafts keep
-- their required category reference while in-service and posting paths refuse
-- until real fixed-asset, contra-asset, and expense roles are assigned.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.asset_categories
  ALTER COLUMN asset_account_id DROP NOT NULL,
  ALTER COLUMN accumulated_depreciation_account_id DROP NOT NULL,
  ALTER COLUMN depreciation_expense_account_id DROP NOT NULL;

ALTER TABLE public.asset_categories
  ADD CONSTRAINT asset_categories_configured_or_unconfigured
  CHECK (
    (asset_account_id IS NULL
      AND accumulated_depreciation_account_id IS NULL
      AND depreciation_expense_account_id IS NULL)
    OR (asset_account_id IS NOT NULL
      AND accumulated_depreciation_account_id IS NOT NULL
      AND depreciation_expense_account_id IS NOT NULL)
  );

COMMENT ON COLUMN public.asset_categories.asset_account_id IS
  'Gross-asset posting account; NULL only when the category is explicitly unconfigured (all three role accounts NULL). Drafts may reference an unconfigured category; in-service and posting transitions refuse until roles are assigned.';

COMMENT ON COLUMN public.asset_categories.accumulated_depreciation_account_id IS
  'Accumulated-depreciation contra posting account; NULL only when the category is explicitly unconfigured (all three role accounts NULL). Drafts may reference an unconfigured category; in-service and posting transitions refuse until roles are assigned.';

COMMENT ON COLUMN public.asset_categories.depreciation_expense_account_id IS
  'Depreciation-expense posting account; NULL only when the category is explicitly unconfigured (all three role accounts NULL). Drafts may reference an unconfigured category; in-service and posting transitions refuse until roles are assigned.';
