-- OpenBooks upgrade preflight for 0421_pick_lists_and_shipments.
--
-- 0421 introduces the document kinds pick_list and shipment and the document
-- link types reserves and ships. An existing row already using any of them
-- would be reinterpreted by the new fulfilment rules, so each is named here
-- first. Zero rows means ready.
SELECT '0421.document_kind_in_use' AS code,
       'refuse' AS severity,
       'organization ' || d.org_id::text AS subject,
       count(*)::text || ' document(s) already use kind ' || d.kind AS detail,
       'Change these documents to their intended kind, or void and re-enter them, then upgrade.' AS remedy
  FROM public.documents d
 WHERE d.kind IN ('pick_list', 'shipment')
 GROUP BY d.org_id, d.kind
UNION ALL
SELECT '0421.link_type_in_use' AS code,
       'refuse' AS severity,
       'organization ' || l.org_id::text AS subject,
       count(*)::text || ' document link(s) already use type ' || l.link_type AS detail,
       'Relabel these document links with their intended type, then upgrade.' AS remedy
  FROM public.document_links l
 WHERE l.link_type IN ('reserves', 'ships')
 GROUP BY l.org_id, l.link_type;
