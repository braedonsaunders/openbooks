-- OpenBooks forward migration 0658_profile_changed_kind_restore.
--
-- Restores 'profile_changed' to the employment_changes kind vocabulary so
-- profile change applications validate. Adds no other kinds; data is
-- untouched.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE employment_changes DROP CONSTRAINT employment_changes_kind;
ALTER TABLE employment_changes ADD CONSTRAINT employment_changes_kind CHECK (change_kind IN ('created', 'status_changed', 'assignment_issued', 'assignment_superseded', 'corrected', 'terminated', 'rehired_reference', 'bank_details_changed', 'profile_changed'));
