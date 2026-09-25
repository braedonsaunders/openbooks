-- OpenBooks forward migration 0401_clone_authority_role_bypass.
--
-- Migration 0376 (ARCH-RLS-ROLE) replaced GUC bypass with role bypass: the
-- application role can no longer assert the legacy bypass GUC, and
-- maintenance work crosses tenants through a dedicated BYPASSRLS login
-- instead. That migration did not update openbooks_clone_authority(), whose
-- fourth conjunct still demands the legacy bypass GUC — a state no
-- compliant session reaches anymore. The authority is therefore dead: the
-- deterministic clone sets openbooks.clone/migration/amend and runs as the
-- bypass role, yet every journal_lines copy of posted history refuses with
-- "lines of a posted journal entry are immutable" (and the reporting-book
-- recognition copy loses its skip in the same way).
--
-- This migration redefines the authority for the role-based world: the three
-- operational flags (clone, migration, amend — still set only by the clone
-- transaction) plus EITHER the privileged bypass predicate
-- (public.app_bypass_rls_active(), gated on privileged roles by 0399) OR a
-- session login carrying BYPASSRLS (superusers imply it). The bare-GUC
-- disjunct is gone, not kept: all four GUCs are unprivileged SETs, so any
-- runtime role could assert them and hold this authority, which gates
-- posted-history INSERTs. The RLS boundary itself stays role-enforced and
-- untouched.
--
-- No data is touched. Branch markers and guard bodies are unchanged (0400
-- restored the clone-authority-insert branches that call this function).
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- True only inside the deterministic clone transaction: openbooks.clone,
-- openbooks.migration and openbooks.amend asserted together with an
-- unscoped maintenance context — either the privileged bypass predicate
-- (0399) or, since 0376, a BYPASSRLS session login. Guards honour it for
-- INSERT of posted history only; it never permits UPDATE, DELETE, or
-- tenant-transaction writes.
CREATE OR REPLACE FUNCTION public.openbooks_clone_authority()
RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_catalog
AS $$
  select coalesce(current_setting('openbooks.clone', true), 'off') = 'on'
     and coalesce(current_setting('openbooks.migration', true), 'off') = 'on'
     and coalesce(current_setting('openbooks.amend', true), 'off') = 'on'
     and (public.app_bypass_rls_active()
          or exists (select 1
                       from pg_catalog.pg_roles
                      where rolname = current_user and rolbypassrls))
$$;

COMMENT ON FUNCTION public.openbooks_clone_authority() IS
  'True only inside the deterministic clone transaction (0316, bypass-predicate acceptance added in 0401): openbooks.clone, openbooks.migration and openbooks.amend asserted together with an unscoped maintenance context (public.app_bypass_rls_active() or a BYPASSRLS login). Guards honour it for INSERT of posted history only; it never permits UPDATE, DELETE, or tenant-transaction writes.';
