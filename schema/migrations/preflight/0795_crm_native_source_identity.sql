WITH identities AS (
 SELECT org_id,custom->'netsuite'->>'id' AS source_id,
 CASE custom->'netsuite'->>'recordType' WHEN 'recentActivityNote' THEN 'note'
 ELSE lower(custom->'netsuite'->>'recordType') END AS record_type
 FROM crm_activities
 WHERE custom->'netsuite'->>'recordType' IN ('recentActivityNote','note','phoneCall','phonecall','calendarEvent','calendarevent')
)
SELECT '0795.duplicate_source_activity' AS code,'refuse' AS severity,
 org_id::text || ':' || record_type || ':' || source_id AS subject,
 'Multiple CRM activities identify the same source record.' AS detail,
 'Reconcile duplicate activity records and their links before upgrading.' AS remedy
FROM identities GROUP BY org_id,source_id,record_type HAVING count(*)>1;
