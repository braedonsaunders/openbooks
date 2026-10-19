-- A governed equity action awaiting its Flow decision can be withdrawn by its
-- requester. Withdrawal is a third terminal outcome beside applied and
-- rejected: nothing applies, the requester is recorded as the one who closed
-- the request, and the stated reason is kept. The existing decision guard
-- already admits exactly one move out of pending approval, so only the status
-- and decision checks widen; every existing row satisfies the new checks.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.equity_action_requests DROP CONSTRAINT equity_action_requests_status;
ALTER TABLE public.equity_action_requests ADD CONSTRAINT equity_action_requests_status
  CHECK (status IN ('pending_approval', 'applied', 'rejected', 'withdrawn'));

ALTER TABLE public.equity_action_requests DROP CONSTRAINT equity_action_requests_decision;
ALTER TABLE public.equity_action_requests ADD CONSTRAINT equity_action_requests_decision CHECK (
  (status = 'pending_approval' AND decided_by IS NULL AND decided_at IS NULL AND applied_at IS NULL AND result IS NULL AND NOT released_without_approval)
  OR (status = 'applied' AND applied_at IS NOT NULL AND result IS NOT NULL
      AND ((released_without_approval AND decided_by IS NULL AND decided_at IS NULL)
        OR (NOT released_without_approval AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_by <> requested_by)))
  OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_by <> requested_by
      AND length(btrim(decision_comment)) BETWEEN 1 AND 2000 AND applied_at IS NULL AND NOT released_without_approval)
  OR (status = 'withdrawn' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_by = requested_by
      AND length(btrim(decision_comment)) BETWEEN 1 AND 2000 AND applied_at IS NULL AND result IS NULL AND NOT released_without_approval));

SELECT public.openbooks_refresh_query_catalog();
