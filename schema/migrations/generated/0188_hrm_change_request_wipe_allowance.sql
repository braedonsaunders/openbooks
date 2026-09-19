-- OpenBooks forward migration 0188_hrm_change_request_wipe_allowance.
--
-- 0185's hrm_employment_change_request_no_delete refused DELETE of every
-- submitted request unconditionally. That is the right rule for every
-- production path — submitted history is retained and terminal states speak —
-- but it did not honour the governed amend path that every other retained-
-- history guard in this schema honours (0184's closure and evidence guards,
-- posted documents, journal entries): fixture teardown and sandbox wipe run
-- under `openbooks.amend = on`, and without the allowance an organisation
-- holding one submitted request could never be torn down or wiped. The
-- RESTRICT foreign keys to flow_runs and employment_changes are deferrable, so
-- once the trigger yields, a whole-org teardown transaction completes.
--
-- Same function name, same trigger: only the allowance branch is added, and
-- it is the existing house mechanism, not a new bypass. Production requests
-- never set openbooks.amend.

CREATE OR REPLACE FUNCTION public.hrm_employment_change_request_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  -- Governed amend path (fixture teardown, sandbox wipe, org purge). Without
  -- it a submitted request pins its organisation forever.
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;
  IF OLD.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'HRM change request % was submitted and is retained as history — terminal rows (approved, rejected, applied) cannot be withdrawn; file a new request for a revised proposal instead of deleting it.', OLD.id;
  END IF;
  RETURN OLD;
END;
$func$;
