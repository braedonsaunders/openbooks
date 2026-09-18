-- OpenBooks forward migration 0172_tax_return_form_notice_key.
--
-- F-w4-001: the generic tax prepare panel branched on the literal `CA_GST34`
-- form code to show a Canada filing notice, because the return-pack type had
-- no notice channel and tax_return_forms had nowhere to carry one. The pack
-- type now declares an optional `tax`-namespace catalog key (noticeKey), and
-- this column is where provisioning persists it onto the tenant-owned form
-- row the UI reads. The panel renders whatever the selected form declares —
-- NULL means no notice, which is also what every pre-0172 row carries, so
-- existing installs behave exactly as today until the pack is reinstalled
-- (install and reset-to-library-defaults both write the declared key).
--
-- WHY NO BACKFILL. Migration 0147 healed stale GST34 box math because wrong
-- numbers were being filed; a missing informational notice files nothing
-- wrong. Writing the CA pack's key into every existing CA_GST34 row here
-- would duplicate the pack declaration in immutable history and stamp tenant
-- rows the tenant never asked to reset. Absence degrades to today's
-- behavior (no notice) until the next reinstall, which is honest.
--
-- WHY NO CHECK CONSTRAINT. The key lives in the app's message catalogs and
-- a catalog-coverage test (web/lib/messages-catalog.test.ts) already fails
-- the build on an undeclared or untranslated key; a storage CHECK on key
-- shape would only reject future legitimate keys.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.tax_return_forms
  ADD COLUMN IF NOT EXISTS notice_key text;

COMMENT ON COLUMN public.tax_return_forms.notice_key IS
  'Pack-declared filing-notice catalog key (0172, F-w4-001): a tax-namespace message key the generic prepare panel renders for this form, e.g. submission.gst34Notice. NULL = the form declares no notice. Written by pack provisioning on install and reset; never a country branch in UI code';
