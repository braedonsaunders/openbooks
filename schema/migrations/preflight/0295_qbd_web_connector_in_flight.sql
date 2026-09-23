-- OpenBooks upgrade preflight for 0295_qbd_web_connector_in_flight.
--
-- Read-only mirror of the migration's in-flight precheck: a retried
-- sendRequestXML that claimed a second request on one ticket stores
-- responses under the wrong request. Zero rows means ready for 0295.
SELECT '0295.ticket_multi_sent' AS code,
       'refuse' AS severity,
       format('ticket %s holds %s sent requests', session_id, n) AS subject,
       format('qbd_requests has %s rows with status sent on session %s. Only one request may be in flight per ticket',
              n, session_id) AS detail,
       'Re-queue every sent request but the latest per ticket (status ''queued'', session_id NULL, sent_at NULL) before applying 0295. Nothing is auto-deleted.' AS remedy
  FROM (SELECT session_id, count(*) AS n
          FROM public.qbd_requests
         WHERE status = 'sent' AND session_id IS NOT NULL
         GROUP BY session_id
        HAVING count(*) > 1) dups
 ORDER BY session_id
 LIMIT 20;
