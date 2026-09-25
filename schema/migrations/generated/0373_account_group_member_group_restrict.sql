-- OpenBooks forward migration 0373_account_group_member_group_restrict.
-- Keep historical pins; refuse removal of a group while membership rows reference it.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.account_group_members
  ADD CONSTRAINT account_group_members_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES public.account_groups(id)
  ON DELETE RESTRICT NOT VALID;
