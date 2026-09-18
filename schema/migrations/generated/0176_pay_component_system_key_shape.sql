-- OpenBooks forward migration 0176_pay_component_system_key_shape.
--
-- WHY THIS CONSTRAINT IS DELIBERATELY PERMISSIVE. Country packs DECLARE the
-- statutory components they need (engine/src/payroll/packs.ts types the slot
-- as `systemKey: string`, and the seeder inserts whatever the pack declares),
-- so the database must never enumerate which statutory keys may exist: every
-- new pack with a levy we have not met — today Québec's Health Services Fund
-- ('hsf') — would otherwise die deep in a fixture with 'new row for relation
-- pay_components violates check constraint pay_components_system_key', which
-- no pack author can act on. The pack registry is the authority on MEMBERSHIP
-- (an unknown key is inert: nothing computes it, nothing remits it, and the
-- run resolves statutory slots with an explicit lookup that fails closed on
-- a missing component). What the database owns is SHAPE: a system key is a
-- stable machine identifier, so it must look like one. That is what this
-- CHECK enforces, and it is the only thing it enforces.
--
-- The shape admits every key the old enumeration admitted (base_pay through
-- eht — all lowercase snake_case, the longest 20 characters) plus any future
-- pack-declared key in the same vocabulary, and it rejects the typo class:
-- uppercase ('CPP'), spaces ('income tax'), punctuation ('cpp!'), empties,
-- leading digits ('2cpp'), and non-ASCII. A pack author who mistypes a key
-- still gets a constraint violation at seed time; a pack author who declares
-- a legitimate new levy sails through.
--
-- HISTORY. Every row in this table has always carried the old enumeration
-- (it shipped in the 0001 baseline), so every non-null system_key on every
-- install is one of the 23 known keys, all of which satisfy the new shape:
-- the replacement validates cleanly with no backfill and no data change.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.pay_components DROP CONSTRAINT IF EXISTS pay_components_system_key;
ALTER TABLE public.pay_components ADD CONSTRAINT pay_components_system_key
  CHECK (system_key IS NULL OR system_key ~ '^[a-z][a-z0-9_]{0,63}$');
