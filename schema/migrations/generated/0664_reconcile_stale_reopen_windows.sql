-- OpenBooks forward migration 0664_reconcile_stale_reopen_windows.
--
-- Reopen windows approved before re-closing consumed them can still read
-- approved and unexpired although every module they cover is already closed.
-- With no user path to end them they block new reopens until expiry. This
-- reconciliation ends exactly those spent windows, marking them reclosed
-- and recording one audit row each. Windows still guarding open modules are
-- untouched, and a rerun matches nothing.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

WITH ended AS (
  UPDATE public.close_reopen_requests AS r
     SET status = 'reclosed',
         reclosed_at = now(),
         updated_at = now(),
         updated_by = NULL
   WHERE r.status = 'approved'
     AND r.expires_at > now()
     AND jsonb_array_length(r.modules) > 0
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(r.modules) AS m(module)
        WHERE COALESCE((
          SELECT l.state
            FROM public.period_locks AS l
           WHERE l.org_id = r.org_id
             AND l.period_id = r.period_id
             AND l.book_id = r.book_id
             AND l.module = m.module
             AND (l.subsidiary_id IS NOT DISTINCT FROM r.subsidiary_id OR l.subsidiary_id IS NULL)
           ORDER BY (l.subsidiary_id IS NOT NULL) DESC
           LIMIT 1
        ), '') NOT IN ('closed', 'soft_closed')
     )
  RETURNING r.id, r.org_id, r.period_id, r.book_id, r.subsidiary_id, r.modules, r.reason
)
INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
SELECT e.org_id,
       'close_reopen_requests',
       e.id,
       'end',
       jsonb_build_object(
         'before', jsonb_build_object('status', 'approved'),
         'after', jsonb_build_object('status', 'reclosed'),
         'scope', jsonb_build_object(
           'periodId', e.period_id,
           'bookId', e.book_id,
           'subsidiaryId', e.subsidiary_id,
           'modules', e.modules),
         'reason', 'Reconciliation ended this reopen window: every covered module is already closed, so the window no longer guards live work.',
         'requestReason', e.reason
       ),
       NULL
  FROM ended AS e;
