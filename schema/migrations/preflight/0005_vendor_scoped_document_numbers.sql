-- OpenBooks upgrade preflight for 0005_vendor_scoped_document_numbers.
--
-- Read-only check that no two documents already share a slot of either
-- replacement unique index: (org, kind, vendor party, number) for vendor
-- bills and credits with a party, (org, kind, number) for every other row.
-- The replaced organization-wide index implies both, so an install whose
-- index is valid returns zero rows. Zero rows means ready.
SELECT '0005.duplicate_document_number' AS code,
       'refuse' AS severity,
       format('org %s %s number %s%s', d.org_id, d.kind, d.document_number,
              CASE WHEN d.scoped THEN format(' for party %s', d.party_id) ELSE '' END) AS subject,
       format('%s documents share this number: %s', d.n, d.ids) AS detail,
       'These documents already violate documents_org_kind_number, the index this migration replaces; have the database owner reconcile the duplicated numbers and rebuild that index, then retry the upgrade.' AS remedy
  FROM (
    SELECT org_id, kind, document_number, party_id, scoped,
           count(*) AS n,
           string_agg(id::text, ', ' ORDER BY id) AS ids
      FROM (
        SELECT id, org_id, kind, document_number,
               (kind IN ('vendor_bill', 'vendor_credit') AND party_id IS NOT NULL) AS scoped,
               CASE WHEN kind IN ('vendor_bill', 'vendor_credit') AND party_id IS NOT NULL
                    THEN party_id END AS party_id
          FROM public.documents
      ) slots
     GROUP BY org_id, kind, document_number, party_id, scoped
    HAVING count(*) > 1
  ) d
 ORDER BY d.org_id, d.kind, d.document_number
 LIMIT 20;
