-- OpenBooks forward migration 0295_qbd_web_connector_in_flight.
--
-- A Web Connector retry of sendRequestXML before submitting its first
-- response claimed a SECOND queued request on the same ticket, leaving two
-- 'sent' rows in flight; the next receiveResponseXML then stored response A
-- under request B (and B under A), and a "complete" capture fed the wrong
-- source families into the migration engine. The engine now re-sends the
-- outstanding request instead of claiming a new one and correlates every
-- response to its request by the qbXML requestID it stamps on send.
--
-- Storage arbitrates the residual race between two concurrent claims, which
-- application checks cannot see under READ COMMITTED: at most one 'sent'
-- request may name a ticket. The engine serializes claims per ticket behind
-- an advisory lock and retries the loser into the resend path; this index
-- is the backstop that makes the loser fail instead of double-claiming.
--
-- No existing row is expected to violate the index (every writer paths
-- through nextWebConnectorRequest, which claims one row per send); the
-- pre-check below refuses by name, listing the offending tickets, rather
-- than letting the index fail with a bare unique violation. Nothing is
-- auto-deleted: re-queue every sent request but the latest per ticket
-- (status 'queued', session_id NULL, sent_at NULL) and re-apply.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

DO $precheck$
DECLARE
  violation_count integer;
  offending text;
BEGIN
  SELECT count(*) INTO violation_count FROM (
    SELECT session_id
      FROM public.qbd_requests
     WHERE status = 'sent' AND session_id IS NOT NULL
     GROUP BY session_id
    HAVING count(*) > 1
  ) dups;
  IF violation_count > 0 THEN
    SELECT string_agg(entry, E'\n') INTO offending FROM (
      SELECT format('ticket %s holds %s sent requests', session_id, n) AS entry
        FROM (
          SELECT session_id, count(*) AS n
            FROM public.qbd_requests
           WHERE status = 'sent' AND session_id IS NOT NULL
           GROUP BY session_id
          HAVING count(*) > 1
           ORDER BY session_id
           LIMIT 5
        ) first_dups
    ) listed;
    RAISE EXCEPTION E'qbd_requests holds % Web Connector ticket(s) with more than one in-flight sent request; re-queue every sent request but the latest per ticket (status ''queued'', session_id NULL, sent_at NULL) before applying 0295. First tickets:\n%', violation_count, offending;
  END IF;
END;
$precheck$;

-- Partial: only in-flight rows name a ticket, so queued, complete, failed
-- and cancelled history is unaffected. Concurrent second claims for one
-- ticket serialize here; the loser retries into the resend path (see
-- engine/src/qbd/bridge.ts).
CREATE UNIQUE INDEX IF NOT EXISTS qbd_requests_one_sent_per_session
  ON public.qbd_requests (session_id)
  WHERE status = 'sent';
