-- Retain activity records and links while standardizing their native source identity.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

WITH candidates AS (
 SELECT id,org_id,custom AS before_custom,
        jsonb_set(custom,'{netsuite,recordType}',to_jsonb(
          CASE custom->'netsuite'->>'recordType'
            WHEN 'recentActivityNote' THEN 'note'
            ELSE lower(custom->'netsuite'->>'recordType') END)) AS after_custom
 FROM crm_activities
 WHERE custom->'netsuite'->>'recordType' IN ('recentActivityNote','phoneCall','calendarEvent')
), changed AS (
 UPDATE crm_activities a SET custom=c.after_custom,updated_at=now()
 FROM candidates c WHERE a.org_id=c.org_id AND a.id=c.id
 RETURNING a.id,a.org_id
)
INSERT INTO audit_log(org_id,table_name,row_id,action,changes)
SELECT c.org_id,'crm_activities',c.id,'update',jsonb_build_object(
 'before',jsonb_build_object('custom',c.before_custom),
 'after',jsonb_build_object('custom',c.after_custom),
 'reason','Standardize native source activity identities while preserving records and links')
FROM candidates c JOIN changed a ON a.org_id=c.org_id AND a.id=c.id;
